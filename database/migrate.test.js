import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { assertSchemaVersion, MigrationError, runMigrations } from './migrate.js'

const { Client, Pool } = pg
const adminUrl = process.env.MIGRATION_TEST_ADMIN_URL
const baselinePath = new URL('./migrations/0001_baseline.sql', import.meta.url)
const stateBackfillPath = new URL('./migrations/0003_deployment_state_backfill.sql', import.meta.url)
const lockKey = '72623859790382856'

async function withDatabase(callback) {
  const databaseName = `deployhub_migration_test_${randomUUID().replaceAll('-', '')}`
  const admin = new Client({ connectionString: adminUrl })
  await admin.connect()
  await admin.query(`CREATE DATABASE "${databaseName}"`)
  const databaseUrl = new URL(adminUrl)
  databaseUrl.pathname = `/${databaseName}`
  const pool = new Pool({ connectionString: databaseUrl.toString(), max: 4 })

  try {
    await callback({ pool, databaseUrl: databaseUrl.toString() })
  } finally {
    await pool.end()
    await admin.query(`DROP DATABASE "${databaseName}"`)
    await admin.end()
  }
}

async function withMigrationDirectory(callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'deployhub-migrations-test-'))
  await copyFile(fileURLToPath(baselinePath), path.join(directory, '0001_baseline.sql'))
  try {
    return await callback(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('migration infrastructure works with disposable PostgreSQL databases', { skip: !adminUrl }, async (t) => {
  await t.test('fresh database applies baseline and records history', async () => {
    await withDatabase(async ({ pool }) => {
      await assert.rejects(
        assertSchemaVersion(pool, '0001'),
        (error) => error instanceof MigrationError && /not initialized/.test(error.message),
      )
      const result = await withMigrationDirectory((directory) =>
        runMigrations(pool, { migrationsDirectory: directory }),
      )
      assert.deepEqual(result.applied.map(({ version }) => version), ['0001'])
      assert.equal(result.currentVersion, '0001')
      await assertSchemaVersion(pool, '0001')
      await assert.rejects(
        assertSchemaVersion(pool, '0004'),
        (error) => error instanceof MigrationError && /missing required migration 0004/.test(error.message),
      )

      const history = await pool.query(
        'SELECT version, name, checksum, applied_at, execution_ms FROM schema_migrations',
      )
      const baseline = await readFile(baselinePath)
      assert.equal(history.rows.length, 1)
      assert.equal(history.rows[0].version, '0001')
      assert.equal(history.rows[0].name, 'baseline')
      assert.equal(
        history.rows[0].checksum,
        createHash('sha256').update(baseline).digest('hex'),
      )
      assert.ok(history.rows[0].applied_at)
      assert.ok(Number(history.rows[0].execution_ms) >= 0)

      const lockClient = await pool.connect()
      try {
        const lock = await lockClient.query(
          'SELECT pg_try_advisory_lock($1::bigint) AS acquired',
          [lockKey],
        )
        assert.equal(lock.rows[0].acquired, true, 'runner must release its advisory lock')
        await lockClient.query('SELECT pg_advisory_unlock($1::bigint)', [lockKey])
      } finally {
        lockClient.release()
      }
    })
  })

  await t.test('fresh database applies the complete migration sequence with zero deployment rows', async () => {
    await withDatabase(async ({ pool }) => {
      const result = await runMigrations(pool)
      assert.deepEqual(result.applied.map(({ version }) => version), ['0001', '0002', '0003', '0004', '0005', '0006', '0007'])
      await assertSchemaVersion(pool, '0007')
      const jobTable = await pool.query(`SELECT to_regclass('public.deployment_jobs') IS NOT NULL AS exists`)
      assert.equal(jobTable.rows[0].exists, true)
      const appliedHistory = await pool.query(
        'SELECT version, name, checksum FROM schema_migrations ORDER BY version',
      )
      for (const row of appliedHistory.rows) {
        const migration = await readFile(new URL(`./migrations/${row.version}_${row.name}.sql`, import.meta.url))
        assert.equal(row.checksum, createHash('sha256').update(migration).digest('hex'))
      }
      assert.deepEqual((await runMigrations(pool)).applied, [])
      const count = await pool.query('SELECT COUNT(*)::int AS count FROM deployments')
      assert.equal(count.rows[0].count, 0)
    })
  })

  await t.test('executor migration preserves requested branch and constrains durable correlation fields', async () => {
    await withDatabase(async ({ pool }) => {
      await runMigrations(pool)
      const user = await pool.query(
        'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
        [`executor-${randomUUID()}@example.test`, 'hash'],
      )
      const project = await pool.query(
        'INSERT INTO projects (user_id, name, repo_url) VALUES ($1, $2, $3) RETURNING id',
        [user.rows[0].id, 'Executor migration', 'https://github.com/example/executor-migration'],
      )
      const deployment = await pool.query(
        `INSERT INTO deployments (project_id, user_id, status, stage, branch)
         VALUES ($1, $2, 'QUEUED', 'QUEUED', 'release/next') RETURNING id`,
        [project.rows[0].id, user.rows[0].id],
      )
      const job = await pool.query(
        'INSERT INTO deployment_jobs (deployment_id) VALUES ($1) RETURNING *',
        [deployment.rows[0].id],
      )
      assert.equal(job.rows[0].source_commit_sha, null)
      assert.equal(job.rows[0].source_resolved_at, null)

      const sha = 'c'.repeat(40)
      await pool.query(
        `UPDATE deployment_jobs
         SET source_commit_sha = $2, source_resolved_at = NOW(), lease_generation = 1
         WHERE id = $1`,
        [job.rows[0].id, sha],
      )
      await pool.query(
        `INSERT INTO deployment_executions (
           id, job_id, deployment_id, lease_generation, provider_name,
           provider_execution_id, status, cleanup_state
         ) VALUES ('exec-test-1', $1, $2, 1, 'fake', 'provider-test-1', 'RUNNING', 'PENDING')`,
        [job.rows[0].id, deployment.rows[0].id],
      )
      const persisted = await pool.query(
        `SELECT deployments.branch, deployment_jobs.source_commit_sha,
                deployment_jobs.source_resolved_at, deployment_executions.status,
                deployment_executions.cleanup_state, deployment_executions.provider_execution_id
         FROM deployment_jobs
         JOIN deployments ON deployments.id = deployment_jobs.deployment_id
         JOIN deployment_executions ON deployment_executions.job_id = deployment_jobs.id
         WHERE deployment_jobs.id = $1`,
        [job.rows[0].id],
      )
      assert.deepEqual(persisted.rows[0], {
        branch: 'release/next',
        source_commit_sha: sha,
        source_resolved_at: persisted.rows[0].source_resolved_at,
        status: 'RUNNING',
        cleanup_state: 'PENDING',
        provider_execution_id: 'provider-test-1',
      })
      assert.ok(persisted.rows[0].source_resolved_at)
      await assert.rejects(
        pool.query('UPDATE deployment_jobs SET source_commit_sha = $2 WHERE id = $1', [job.rows[0].id, 'invalid']),
        (error) => error.code === '23514',
      )
      await assert.rejects(
        pool.query('UPDATE deployment_jobs SET source_resolved_at = NULL WHERE id = $1', [job.rows[0].id]),
        (error) => error.code === '23514',
      )
      await assert.rejects(
        pool.query(
          `INSERT INTO deployment_executions (
             id, job_id, deployment_id, lease_generation, provider_name, provider_execution_id
           ) VALUES ('exec-test-2', $1, $2, 2, 'fake', 'provider-test-1')`,
          [job.rows[0].id, deployment.rows[0].id],
        ),
        (error) => error.code === '23505',
      )
      const history = await pool.query('SELECT version FROM schema_migrations ORDER BY version')
      assert.equal(history.rows.at(-1).version, '0007')
    })
  })

  await t.test('existing adopted baseline with zero deployments upgrades through 0007', async () => {
    await withDatabase(async ({ pool }) => {
      await pool.query(await readFile(baselinePath, 'utf8'))
      const result = await runMigrations(pool)
      assert.deepEqual(result.applied.map(({ version }) => version), ['0002', '0003', '0004', '0005', '0006', '0007'])
      await assertSchemaVersion(pool, '0007')
      const count = await pool.query('SELECT COUNT(*)::int AS count FROM deployments')
      assert.equal(count.rows[0].count, 0)
    })
  })

  await t.test('applies deployment-state migrations while preserving every deployment field and log', async () => {
    await withDatabase(async ({ pool }) => {
      await withMigrationDirectory((directory) => runMigrations(pool, { migrationsDirectory: directory }))
      const user = await pool.query(
        `INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id`,
        ['state-migration@example.test', 'hash'],
      )
      const project = await pool.query(
        `INSERT INTO projects (user_id, name, repo_url) VALUES ($1, $2, $3) RETURNING id`,
        [user.rows[0].id, 'Migration test', 'https://github.com/example/migration-test'],
      )
      const oldTimestamp = '2020-01-02T03:04:05.000Z'
      const rows = [
        ['queued', 'queued', null],
        ['cloning', 'cloning', null],
        ['building', 'building', null],
        ['pushing', 'pushing', null],
        ['deploying', 'deploying', null],
        ['live', 'live', 'https://migration-test.example.test'],
        ['failed', 'queued', null],
        ['failed', 'cloning', null],
        ['failed', 'building', null],
        ['failed', 'pushing', null],
        ['failed', 'deploying', null],
      ]
      const expectedStatus = {
        queued: 'QUEUED',
        cloning: 'CLONING',
        building: 'BUILDING',
        pushing: 'PUSHING_IMAGE',
        deploying: 'DEPLOYING',
        live: 'RUNNING',
        failed: 'FAILED',
      }
      const expectedStage = {
        queued: 'QUEUED',
        cloning: 'CLONING_REPOSITORY',
        building: 'CREATING_IMAGE',
        pushing: 'PUSHING_IMAGE',
        deploying: 'APPLYING_KUBERNETES_DEPLOYMENT',
        live: 'RUNNING',
      }
      const inserted = []
      for (const [status, stage, liveUrl] of rows) {
        const insertedDeployment = await pool.query(
          `INSERT INTO deployments (
             project_id, user_id, status, stage, branch, stack, image, live_url, error, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, 'main', 'Node.js', 'registry.example.test/app:latest', $5,
             'preserve this error field', $6, $6) RETURNING id`,
          [project.rows[0].id, user.rows[0].id, status, stage, liveUrl, oldTimestamp],
        )
        const id = insertedDeployment.rows[0].id
        inserted.push({ id, status, stage, liveUrl })
        await pool.query(
          `INSERT INTO deployment_logs (deployment_id, level, message, created_at)
           VALUES ($1, 'info', 'preserve this log', $2)`,
          [id, oldTimestamp],
        )
      }

      const applied = await runMigrations(pool)
      assert.deepEqual(applied.applied.map(({ version }) => version), ['0002', '0003', '0004', '0005', '0006', '0007'])
      await assertSchemaVersion(pool, '0007')
      const result = await pool.query(
        `SELECT id, status, stage, branch, stack, image, live_url, error, created_at, updated_at
         FROM deployments ORDER BY created_at, id`,
      )
      const migratedById = new Map(result.rows.map((row) => [row.id, row]))
      for (const original of inserted) {
        const row = migratedById.get(original.id)
        assert.ok(row)
        assert.equal(row.status, expectedStatus[original.status])
        assert.equal(row.stage, expectedStage[original.stage])
        assert.equal(row.branch, 'main')
        assert.equal(row.stack, 'Node.js')
        assert.equal(row.image, 'registry.example.test/app:latest')
        assert.equal(row.live_url, original.liveUrl)
        assert.equal(row.error, 'preserve this error field')
        assert.equal(new Date(row.created_at).toISOString(), oldTimestamp)
        assert.equal(new Date(row.updated_at).toISOString(), oldTimestamp)
      }
      const logs = await pool.query(
        `SELECT COUNT(*)::int AS count, COUNT(DISTINCT deployment_id)::int AS deployments,
                MIN(message) AS message
         FROM deployment_logs`,
      )
      assert.deepEqual(logs.rows[0], { count: rows.length, deployments: rows.length, message: 'preserve this log' })
      for (const [status, stage, liveUrl] of [
        ['INVALID', 'QUEUED', null],
        ['QUEUED', 'CLONING_REPOSITORY', null],
        ['BUILDING', 'UNKNOWN_STAGE', null],
        ['RUNNING', 'RUNNING', null],
        ['FAILED', 'RUNNING', null],
        ['FAILED', 'CREATING_IMAGE', 'https://failed.example.test'],
      ]) {
        await assert.rejects(
          pool.query(
            `INSERT INTO deployments (project_id, user_id, status, stage, branch, live_url)
             VALUES ($1, $2, $3, $4, 'main', $5)`,
            [project.rows[0].id, user.rows[0].id, status, stage, liveUrl],
          ),
          (error) => error.code === '23514',
          `final contract must reject ${status}/${stage}`,
        )
      }

      const history = await pool.query('SELECT version, checksum FROM schema_migrations ORDER BY version')
      assert.deepEqual(history.rows.map(({ version }) => version), ['0001', '0002', '0003', '0004', '0005', '0006', '0007'])
      assert.ok(history.rows.every(({ checksum }) => /^[a-f0-9]{64}$/.test(checksum)))
      assert.deepEqual((await runMigrations(pool)).applied, [], 'runner reruns must not reapply any migration')

      const backfill = await readFile(stateBackfillPath, 'utf8')
      await pool.query(backfill)
      const afterRepeat = await pool.query('SELECT COUNT(*)::int AS count FROM deployments')
      assert.equal(afterRepeat.rows[0].count, rows.length, 'backfill rerun is a no-op after legacy values are gone')
    })
  })

  await t.test('backfill fails closed and rolls back for unknown stages and inconsistent legacy pairs', async (t) => {
    for (const [scenario, status, stage, liveUrl] of [
      ['unknown stage', 'queued', 'UNKNOWN_STAGE', null],
      ['mismatched status and stage', 'queued', 'building', null],
      ['failed with live URL', 'failed', 'building', 'https://unexpected.example.test'],
      ['failed with legacy live stage', 'failed', 'live', null],
      ['live without URL', 'live', 'live', null],
      ['NULL status', null, 'queued', null],
      ['NULL stage', 'queued', null, null],
    ]) {
      await t.test(scenario, async () => {
        await withDatabase(async ({ pool }) => {
          await withMigrationDirectory((directory) => runMigrations(pool, { migrationsDirectory: directory }))
          if (status === null) await pool.query('ALTER TABLE deployments ALTER COLUMN status DROP NOT NULL')
          if (stage === null) await pool.query('ALTER TABLE deployments ALTER COLUMN stage DROP NOT NULL')
          const user = await pool.query(
            `INSERT INTO users (email, password_hash) VALUES ($1, 'hash') RETURNING id`,
            [`${scenario.replaceAll(' ', '-')}-${randomUUID()}@example.test`],
          )
          const project = await pool.query(
            `INSERT INTO projects (user_id, name, repo_url) VALUES ($1, 'test', $2) RETURNING id`,
            [user.rows[0].id, `https://github.com/example/${randomUUID()}`],
          )
          await pool.query(
            `INSERT INTO deployments (project_id, user_id, status, stage, branch, live_url)
             VALUES ($1, $2, $3, $4, 'main', $5)`,
            [project.rows[0].id, user.rows[0].id, status, stage, liveUrl],
          )
          const migrations = await runMigrations(pool).catch((error) => error)
          assert.match(migrations.message, /0003_deployment_state_backfill\.sql failed/)
          assert.match(migrations.cause?.message || migrations.message, /manual review|required|inconsistent|unmapped/i)
          const row = await pool.query('SELECT status, stage FROM deployments')
          assert.deepEqual(row.rows[0], { status, stage }, 'failed backfill must leave deployment data unchanged')
          const history = await pool.query('SELECT version FROM schema_migrations ORDER BY version')
          assert.deepEqual(history.rows.map(({ version }) => version), ['0001', '0002'])
        })
      })
    }
  })

  await t.test('unknown status prevents expansion and migration stops before later versions', async () => {
    await withDatabase(async ({ pool }) => {
      await withMigrationDirectory((directory) => runMigrations(pool, { migrationsDirectory: directory }))
      await pool.query('ALTER TABLE deployments DROP CONSTRAINT deployments_status_check')
      const user = await pool.query(
        `INSERT INTO users (email, password_hash) VALUES ('unknown-status@example.test', 'hash') RETURNING id`,
      )
      const project = await pool.query(
        `INSERT INTO projects (user_id, name, repo_url) VALUES ($1, 'test', 'https://github.com/example/unknown') RETURNING id`,
        [user.rows[0].id],
      )
      await pool.query(
        `INSERT INTO deployments (project_id, user_id, status, stage, branch)
         VALUES ($1, $2, 'UNKNOWN_STATUS', 'queued', 'main')`,
        [project.rows[0].id, user.rows[0].id],
      )
      await assert.rejects(runMigrations(pool), /0002_deployment_status_expand\.sql failed/)
      const status = await pool.query('SELECT status FROM deployments')
      const history = await pool.query('SELECT version FROM schema_migrations ORDER BY version')
      assert.equal(status.rows[0].status, 'UNKNOWN_STATUS')
      assert.deepEqual(history.rows.map(({ version }) => version), ['0001'])
    })
  })

  await t.test('adopts an existing exact baseline without re-running it', async () => {
    await withDatabase(async ({ pool }) => {
      const baseline = await readFile(baselinePath, 'utf8')
      await pool.query(baseline)
      await pool.query(
        `INSERT INTO users (email, password_hash) VALUES ($1, $2)`,
        ['preserved@example.test', 'hash'],
      )

      const result = await withMigrationDirectory((directory) =>
        runMigrations(pool, { migrationsDirectory: directory }),
      )
      assert.deepEqual(result.applied, [])
      const users = await pool.query('SELECT email FROM users')
      const history = await pool.query('SELECT version FROM schema_migrations')
      assert.deepEqual(users.rows, [{ email: 'preserved@example.test' }])
      assert.deepEqual(history.rows, [{ version: '0001' }])
    })
  })

  await t.test('rerunning migrations is a no-op', async () => {
    await withDatabase(async ({ pool }) => {
      const results = await withMigrationDirectory(async (directory) => {
        const first = await runMigrations(pool, { migrationsDirectory: directory })
        const second = await runMigrations(pool, { migrationsDirectory: directory })
        return { first, second }
      })
      const { first, second } = results
      assert.equal(first.applied.length, 1)
      assert.deepEqual(second.applied, [])
      assert.equal(second.currentVersion, '0001')
      const count = await pool.query('SELECT COUNT(*)::int AS count FROM schema_migrations')
      assert.equal(count.rows[0].count, 1)
    })
  })

  await t.test('checksum mismatch fails before changing database state', async () => {
    await withDatabase(async ({ pool }) => {
      await withMigrationDirectory(async (directory) => {
        await runMigrations(pool, { migrationsDirectory: directory })
        await writeFile(path.join(directory, '0001_baseline.sql'), `${await readFile(path.join(directory, '0001_baseline.sql'), 'utf8')}\n-- edited after apply\n`)

        await assert.rejects(
          runMigrations(pool, { migrationsDirectory: directory }),
          (error) => error instanceof MigrationError && /drift detected/.test(error.message),
        )
        const history = await pool.query('SELECT COUNT(*)::int AS count FROM schema_migrations')
        assert.equal(history.rows[0].count, 1)
        const tables = await pool.query(
          `SELECT to_regclass('public.users') IS NOT NULL AS users_exists,
                  to_regclass('public.deployments') IS NOT NULL AS deployments_exists`,
        )
        assert.deepEqual(tables.rows[0], { users_exists: true, deployments_exists: true })
      })
    })
  })

  await t.test('failed migration rolls back its work and stops later migrations', async () => {
    await withDatabase(async ({ pool }) => {
      await withMigrationDirectory(async (directory) => {
        await writeFile(
          path.join(directory, '0002_broken.sql'),
          'CREATE TABLE should_rollback (id integer); SELECT 1 / 0;',
        )
        await writeFile(path.join(directory, '0003_never_run.sql'), 'CREATE TABLE should_not_run (id integer);')

        await assert.rejects(
          runMigrations(pool, { migrationsDirectory: directory }),
          (error) => error instanceof MigrationError && /0002_broken.sql failed/.test(error.message),
        )
        const result = await pool.query(
          `SELECT to_regclass('public.should_rollback') AS rolled_back,
                  to_regclass('public.should_not_run') AS later_table,
                  (SELECT COUNT(*)::int FROM schema_migrations) AS history_count`,
        )
        assert.deepEqual(result.rows[0], { rolled_back: null, later_table: null, history_count: 1 })
      })
    })
  })

  await t.test('concurrent migration runners serialize and apply each version once', async () => {
    await withDatabase(async ({ databaseUrl }) => {
      await withMigrationDirectory(async (directory) => {
        await writeFile(
          path.join(directory, '0002_slow.sql'),
          'CREATE TABLE concurrent_migration_result (id integer); SELECT pg_sleep(0.25);',
        )
        const firstPool = new Pool({ connectionString: databaseUrl, max: 1 })
        const secondPool = new Pool({ connectionString: databaseUrl, max: 1 })
        try {
          const results = await Promise.all([
            runMigrations(firstPool, { migrationsDirectory: directory }),
            runMigrations(secondPool, { migrationsDirectory: directory }),
          ])
          assert.equal(results.reduce((count, result) => count + result.applied.length, 0), 2)
          const history = await firstPool.query('SELECT version FROM schema_migrations ORDER BY version')
          assert.deepEqual(history.rows.map(({ version }) => version), ['0001', '0002'])
        } finally {
          await firstPool.end()
          await secondPool.end()
        }
      })
    })
  })

  await t.test('runner waits for the advisory lock and proceeds after release', async () => {
    await withDatabase(async ({ pool }) => {
      await withMigrationDirectory(async (directory) => {
        const holder = await pool.connect()
        try {
          await holder.query('SELECT pg_advisory_lock($1::bigint)', [lockKey])
          let finished = false
          const pending = runMigrations(pool, {
            migrationsDirectory: directory,
            lockTimeoutMs: 5_000,
          }).finally(() => {
            finished = true
          })
          await new Promise((resolve) => setTimeout(resolve, 250))
          assert.equal(finished, false, 'runner must wait while another session holds the lock')
          await holder.query('SELECT pg_advisory_unlock($1::bigint)', [lockKey])
          await pending
          assert.equal(finished, true)
        } finally {
          holder.release()
        }
      })
    })
  })
})
