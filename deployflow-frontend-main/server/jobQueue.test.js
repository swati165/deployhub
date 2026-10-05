import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import jwt from 'jsonwebtoken'
import pg from 'pg'
import { createApp } from './app.js'
import {
  calculateRetryDelay,
  claimNextJob,
  enqueueDeployment,
  listOrphanedActiveDeployments,
  renewJobLease,
  scheduleJobRetry,
} from './jobQueue.js'
import { runMigrations } from './migrate.js'
import { DeploymentExecutionError } from './deploymentOrchestrator.js'
import { runWorker } from './workerRuntime.js'

const { Client, Pool } = pg
const adminUrl = process.env.MIGRATION_TEST_ADMIN_URL
const secret = 'test-secret-with-more-than-32-bytes'

async function withDatabase(callback) {
  const databaseName = `deployhub_jobs_test_${randomUUID().replaceAll('-', '')}`
  const admin = new Client({ connectionString: adminUrl })
  await admin.connect()
  await admin.query(`CREATE DATABASE "${databaseName}"`)
  const databaseUrl = new URL(adminUrl)
  databaseUrl.pathname = `/${databaseName}`
  const pool = new Pool({ connectionString: databaseUrl.toString(), max: 8 })
  try {
    await runMigrations(pool)
    return await callback({ pool, databaseUrl: databaseUrl.toString() })
  } finally {
    await pool.end()
    await admin.query(`DROP DATABASE "${databaseName}"`)
    await admin.end()
  }
}

async function createProject(pool) {
  const user = await pool.query(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'test-hash') RETURNING id, email`,
    [`${randomUUID()}@example.test`],
  )
  const project = await pool.query(
    `INSERT INTO projects (user_id, name, repo_url, branch)
     VALUES ($1, 'Job tests', $2, 'main') RETURNING id`,
    [user.rows[0].id, `https://github.com/example/${randomUUID()}`],
  )
  return { user: user.rows[0], projectId: project.rows[0].id }
}

async function createAttempt(pool, { userId, projectId, status = 'QUEUED' } = {}) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const stage = status === 'RUNNING' ? 'RUNNING' : 'QUEUED'
    const liveUrl = status === 'RUNNING' ? 'https://running.example.test' : null
    const deployment = await client.query(
      `INSERT INTO deployments (project_id, user_id, branch, status, stage, live_url)
       VALUES ($1, $2, 'main', $3, $4, $5) RETURNING id`,
      [projectId, userId, status, stage, liveUrl],
    )
    await client.query(
      `INSERT INTO deployment_logs (deployment_id, level, message)
       VALUES ($1, 'info', 'Deployment queued.')`,
      [deployment.rows[0].id],
    )
    await enqueueDeployment(client, deployment.rows[0].id)
    await client.query('COMMIT')
    return deployment.rows[0].id
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

function serveApp(pool, user) {
  const server = createApp({ pool, tokenSecret: secret }).listen(0, '127.0.0.1')
  return new Promise((resolve) => {
    server.once('listening', () => resolve({
      server,
      url: `http://127.0.0.1:${server.address().port}/api`,
      token: jwt.sign({ sub: user.id, email: user.email }, secret, { expiresIn: '12h' }),
    }))
  })
}

test('durable deployment job integration behavior', { skip: !adminUrl }, async (t) => {
  await t.test('API atomically persists deployment, log, and one job and does not expose queue internals', async () => {
    await withDatabase(async ({ pool }) => {
      const { user, projectId } = await createProject(pool)
      const { server, url, token } = await serveApp(pool, user)
      try {
        const response = await fetch(`${url}/projects/${projectId}/deployments`, {
          method: 'POST',
          headers: { authorization: ['Bear', 'er '].join('') + token, 'content-type': 'application/json' },
          body: '{}',
        })
        assert.equal(response.status, 202)
        const body = await response.json()
        assert.deepEqual(Object.keys(body.deployment).sort(), ['id', 'stage', 'status'])
        assert.deepEqual(body.deployment, {
          id: body.deployment.id,
          status: 'QUEUED',
          stage: 'QUEUED',
        })
        const counts = await pool.query(
          `SELECT
             (SELECT COUNT(*)::int FROM deployments WHERE id = $1) AS deployments,
             (SELECT COUNT(*)::int FROM deployment_logs WHERE deployment_id = $1) AS logs,
             (SELECT COUNT(*)::int FROM deployment_jobs WHERE deployment_id = $1) AS jobs`,
          [body.deployment.id],
        )
        assert.deepEqual(counts.rows[0], { deployments: 1, logs: 1, jobs: 1 })

        const second = await fetch(`${url}/projects/${projectId}/deployments`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: '{}',
        })
        assert.equal(second.status, 202)
        const secondBody = await second.json()
        assert.notEqual(secondBody.deployment.id, body.deployment.id)
        assert.equal((await pool.query(
          'SELECT COUNT(*)::int AS count FROM deployment_jobs WHERE deployment_id IN ($1, $2)',
          [body.deployment.id, secondBody.deployment.id],
        )).rows[0].count, 2)
      } finally {
        await new Promise((resolve) => server.close(resolve))
      }
    })
  })

  await t.test('rolls back deployment and initial log when durable job enqueue fails', async () => {
    await withDatabase(async ({ pool }) => {
      const { user, projectId } = await createProject(pool)
      const failingPool = {
        query: pool.query.bind(pool),
        async connect() {
          const client = await pool.connect()
          return {
            query(statement, values) {
              if (statement.includes('INSERT INTO deployment_jobs')) throw new Error('injected enqueue failure')
              return client.query(statement, values)
            },
            release: () => client.release(),
          }
        },
      }
      const { server, url, token } = await serveApp(failingPool, user)
      try {
        const response = await fetch(`${url}/projects/${projectId}/deployments`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: '{}',
        })
        assert.equal(response.status, 500)
        const counts = await pool.query(
          `SELECT
             (SELECT COUNT(*)::int FROM deployments WHERE project_id = $1) AS deployments,
             (SELECT COUNT(*)::int FROM deployment_logs) AS logs,
             (SELECT COUNT(*)::int FROM deployment_jobs) AS jobs`,
          [projectId],
        )
        assert.deepEqual(counts.rows[0], { deployments: 0, logs: 0, jobs: 0 })
      } finally {
        await new Promise((resolve) => server.close(resolve))
      }
    })
  })

  await t.test('job survives API pool restart and remains claimable', async () => {
    await withDatabase(async ({ pool, databaseUrl }) => {
      const { user, projectId } = await createProject(pool)
      const deploymentId = await createAttempt(pool, { userId: user.id, projectId })
      const restartedPool = new Pool({ connectionString: databaseUrl })
      try {
        const claim = await claimNextJob(restartedPool, 'restarted-api-worker')
        assert.equal(claim.deployment_id, deploymentId)
        assert.equal(claim.attempts, 1)
      } finally {
        await restartedPool.end()
      }
    })
  })

  await t.test('two concurrent workers claim different jobs at most once', async () => {
    await withDatabase(async ({ pool }) => {
      const { user, projectId } = await createProject(pool)
      const first = await createAttempt(pool, { userId: user.id, projectId })
      const second = await createAttempt(pool, { userId: user.id, projectId })
      const claims = await Promise.all([
        claimNextJob(pool, 'worker-a'),
        claimNextJob(pool, 'worker-b'),
      ])
      assert.deepEqual(new Set(claims.map((claim) => claim.deployment_id)), new Set([first, second]))
      assert.notEqual(claims[0].id, claims[1].id)
      const extra = await claimNextJob(pool, 'worker-c')
      assert.equal(extra, null)
    })
  })

  await t.test('expired lease is reclaimed with a new fencing generation and stale heartbeat is rejected', async () => {
    await withDatabase(async ({ pool }) => {
      const { user, projectId } = await createProject(pool)
      await createAttempt(pool, { userId: user.id, projectId })
      const first = await claimNextJob(pool, 'worker-before-crash', { leaseMs: 100 })
      await new Promise((resolve) => setTimeout(resolve, 150))
      const second = await claimNextJob(pool, 'worker-after-restart', { leaseMs: 1000 })
      assert.equal(second.id, first.id)
      assert.equal(second.attempts, 2)
      assert.equal(Number(second.lease_generation), Number(first.lease_generation) + 1)
      assert.equal(await renewJobLease(pool, first, { leaseMs: 1000 }), false)
      assert.equal(await renewJobLease(pool, second, { leaseMs: 1000 }), true)
    })
  })

  await t.test('transient failure backs off and reuses the same job without changing deployment lifecycle', async () => {
    await withDatabase(async ({ pool }) => {
      const { user, projectId } = await createProject(pool)
      const deploymentId = await createAttempt(pool, { userId: user.id, projectId })
      const controller = new AbortController()
      await runWorker(pool, {
        workerId: 'retry-worker',
        config: { pollIntervalMs: 5, leaseMs: 1000, heartbeatMs: 100, retryBaseMs: 100, retryMaxMs: 1000 },
        signal: controller.signal,
        orchestrator: async () => {
          controller.abort()
          return { outcome: 'failed', error: Object.assign(new Error('Temporary registry outage'), { retryable: true }) }
        },
      })
      const result = await pool.query(
        `SELECT deployments.status, deployments.stage, jobs.id, jobs.state, jobs.attempts
         FROM deployments JOIN deployment_jobs AS jobs ON jobs.deployment_id = deployments.id
         WHERE deployments.id = $1`,
        [deploymentId],
      )
      assert.equal(result.rows[0].status, 'QUEUED')
      assert.equal(result.rows[0].stage, 'QUEUED')
      assert.equal(result.rows[0].state, 'RETRY_WAIT')
      assert.equal(result.rows[0].attempts, 1)
      assert.ok(result.rows[0].id)
    })
  })

  await t.test('three attempts are bounded and exhausted work is dead-lettered', async () => {
    await withDatabase(async ({ pool }) => {
      const { user, projectId } = await createProject(pool)
      const deploymentId = await createAttempt(pool, { userId: user.id, projectId })
      let finalClaim
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const claim = await claimNextJob(pool, `retry-${attempt}`, { leaseMs: 1000 })
        assert.equal(claim.attempts, attempt)
        finalClaim = claim
        const state = await scheduleJobRetry(pool, claim, 'Temporary registry outage', { delayMs: 0 })
        assert.equal(state, attempt === 3 ? 'DEAD_LETTER' : 'RETRY_WAIT')
      }
      assert.equal(calculateRetryDelay(1, { baseMs: 100, maxMs: 1000, random: () => 0 }), 50)
      assert.equal(calculateRetryDelay(2, { baseMs: 100, maxMs: 1000, random: () => 0.5 }), 200)
      const result = await pool.query(
        `SELECT deployments.status, deployments.stage, jobs.state, jobs.attempts, jobs.completed_at
         FROM deployments JOIN deployment_jobs AS jobs ON jobs.deployment_id = deployments.id
         WHERE deployments.id = $1`,
        [deploymentId],
      )
      assert.equal(result.rows[0].state, 'DEAD_LETTER')
      assert.equal(result.rows[0].attempts, 3)
      assert.ok(result.rows[0].completed_at)
      assert.equal(result.rows[0].status, 'QUEUED')
      assert.equal(result.rows[0].stage, 'QUEUED')
      assert.ok(finalClaim)
    })
  })

  await t.test('deterministic failure dead-letters the job and preserves terminal deployment state', async () => {
    await withDatabase(async ({ pool }) => {
      const { user, projectId } = await createProject(pool)
      const deploymentId = await createAttempt(pool, { userId: user.id, projectId })
      const controller = new AbortController()
      await runWorker(pool, {
        workerId: 'terminal-worker',
        config: { pollIntervalMs: 5, leaseMs: 1000, heartbeatMs: 100, retryBaseMs: 100, retryMaxMs: 1000 },
        signal: controller.signal,
        orchestrator: async () => {
          controller.abort()
          return { outcome: 'failed', error: new DeploymentExecutionError('Unsupported repository configuration') }
        },
      })
      const result = await pool.query(
        `SELECT deployments.status, deployments.stage, deployments.error, jobs.state, jobs.attempts
         FROM deployments JOIN deployment_jobs AS jobs ON jobs.deployment_id = deployments.id
         WHERE deployments.id = $1`,
        [deploymentId],
      )
      assert.equal(result.rows[0].status, 'FAILED')
      assert.equal(result.rows[0].stage, 'QUEUED')
      assert.match(result.rows[0].error, /Unsupported repository configuration/)
      assert.equal(result.rows[0].state, 'DEAD_LETTER')
      assert.equal(result.rows[0].attempts, 1)
    })
  })

  await t.test('running deployment is not reopened and worker shutdown stops claiming cleanly', async () => {
    await withDatabase(async ({ pool }) => {
      const { user, projectId } = await createProject(pool)
      const deploymentId = await createAttempt(pool, { userId: user.id, projectId, status: 'RUNNING' })
      const controller = new AbortController()
      await runWorker(pool, {
        workerId: 'terminal-state-worker',
        config: { pollIntervalMs: 5, leaseMs: 1000, heartbeatMs: 100, retryBaseMs: 100, retryMaxMs: 1000 },
        signal: controller.signal,
        orchestrator: async (workerPool) => {
          const state = await workerPool.query('SELECT status, stage FROM deployments WHERE id = $1', [deploymentId])
          assert.deepEqual(state.rows[0], { status: 'RUNNING', stage: 'RUNNING' })
          controller.abort()
          return { outcome: 'completed' }
        },
      })
      const result = await pool.query(
        `SELECT deployments.status, deployments.stage, jobs.state
         FROM deployments JOIN deployment_jobs AS jobs ON jobs.deployment_id = deployments.id
         WHERE deployments.id = $1`,
        [deploymentId],
      )
      assert.deepEqual(result.rows[0], { status: 'RUNNING', stage: 'RUNNING', state: 'COMPLETED' })

      const shutdown = new AbortController()
      const idleWorker = runWorker(pool, {
        workerId: 'idle-worker',
        config: { pollIntervalMs: 5, leaseMs: 1000, heartbeatMs: 100, retryBaseMs: 100, retryMaxMs: 1000 },
        signal: shutdown.signal,
      })
      shutdown.abort()
      await idleWorker
    })
  })

  await t.test('active deployments without a job are reported as integrity anomalies', async () => {
    await withDatabase(async ({ pool }) => {
      const { user, projectId } = await createProject(pool)
      const deployment = await pool.query(
        `INSERT INTO deployments (project_id, user_id, branch, status, stage)
         VALUES ($1, $2, 'main', 'QUEUED', 'QUEUED') RETURNING id`,
        [projectId, user.id],
      )
      const orphans = await listOrphanedActiveDeployments(pool)
      assert.deepEqual(orphans, [{
        id: deployment.rows[0].id,
        status: 'QUEUED',
        stage: 'QUEUED',
      }])
      const stillQueued = await pool.query('SELECT status FROM deployments WHERE id = $1', [deployment.rows[0].id])
      assert.equal(stillQueued.rows[0].status, 'QUEUED')
    })
  })
})
