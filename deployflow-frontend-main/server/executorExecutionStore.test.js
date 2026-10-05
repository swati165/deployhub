import test from 'node:test'
import assert from 'node:assert/strict'
import { PostgresExecutionStore } from './executorExecutionStore.js'

const deploymentId = '00000000-0000-4000-8000-000000000001'
const jobId = '00000000-0000-4000-8000-000000000002'
const executionId = 'ivm_00000000000000000000000000000000'
const localImage = {
  format: 'OCI_IMAGE',
  reference: 'deployhub-app:0123456789abcdef01234567',
  digest: `sha256:${'b'.repeat(64)}`,
}

function registryRequest() {
  return {
    deploymentId,
    jobId,
    executionId,
    leaseGeneration: 7,
    commitSha: 'd'.repeat(40),
    localImage,
  }
}

function registryResult() {
  const registryDigest = `sha256:${'c'.repeat(64)}`
  return {
    schemaVersion: 1,
    provider: 'fake-registry',
    deploymentId,
    jobId,
    executionId,
    leaseGeneration: 7,
    commitSha: 'd'.repeat(40),
    localImageReference: localImage.reference,
    localImageDigest: localImage.digest,
    registry: 'registry.example.test',
    repository: 'deployhub/apps',
    tag: `dh-${'a'.repeat(64)}`,
    registryDigest,
    image: `registry.example.test/deployhub/apps@${registryDigest}`,
    pushedAt: '2026-10-05T10:00:00.000Z',
  }
}

function fakePool({ rowCount = 1, rows = [] } = {}) {
  const calls = []
  return {
    calls,
    async query(text, values) {
      calls.push({ text, values })
      return { rowCount, rows }
    },
  }
}

function sourceResolution() {
  return {
    schemaVersion: 1,
    deploymentId,
    jobId,
    repository: 'https://github.com/example/project.git',
    requestedBranch: 'release/next',
    commitSha: 'd'.repeat(40),
    resolvedAt: '2026-02-03T04:05:06.000Z',
  }
}

test('source SHA persistence is fenced, parameterized, and retains repository and branch correlation', async () => {
  const pool = fakePool({
    rows: [{
      source_commit_sha: 'd'.repeat(40),
      source_resolved_at: new Date('2026-02-03T04:05:06.000Z'),
    }],
  })
  const store = new PostgresExecutionStore(pool)
  const persisted = await store.recordSourceResolution(sourceResolution(), {
    leaseGeneration: 7,
    workerId: 'worker-7',
  })
  const [{ text, values }] = pool.calls
  assert.match(text, /UPDATE deployment_jobs/)
  assert.match(text, /worker_id = \$8/)
  assert.match(text, /state = 'RUNNING'/)
  assert.match(text, /d\.branch = \$6 AND p\.repo_url = \$7/)
  assert.match(text, /RETURNING source_commit_sha, source_resolved_at/)
  assert.deepEqual(values, [
    jobId,
    deploymentId,
    7,
    'd'.repeat(40),
    '2026-02-03T04:05:06.000Z',
    'release/next',
    'https://github.com/example/project.git',
    'worker-7',
  ])
  assert.equal(persisted.commitSha, 'd'.repeat(40))
  assert.equal(persisted.resolvedAt.toISOString(), '2026-02-03T04:05:06.000Z')
  assert.doesNotMatch(text, /UPDATE deployments/)
})

test('source SHA reads are fenced by active worker lease and match the requested source', async () => {
  const pool = fakePool({
    rows: [{
      source_commit_sha: 'd'.repeat(40),
      source_resolved_at: new Date('2026-02-03T04:05:06.000Z'),
    }],
  })
  const store = new PostgresExecutionStore(pool)
  const result = await store.getSourceResolution({
    deploymentId,
    jobId,
    repository: 'https://github.com/example/project.git',
    requestedBranch: 'release/next',
  }, { leaseGeneration: 7, workerId: 'worker-7' })
  const [{ text, values }] = pool.calls
  assert.match(text, /jobs\.lease_generation = \$3 AND jobs\.worker_id = \$4/)
  assert.match(text, /jobs\.state = 'RUNNING' AND jobs\.lease_expires_at > NOW\(\)/)
  assert.match(text, /d\.branch = \$5 AND p\.repo_url = \$6/)
  assert.deepEqual(values, [
    jobId,
    deploymentId,
    7,
    'worker-7',
    'release/next',
    'https://github.com/example/project.git',
  ])
  assert.deepEqual(result, {
    commitSha: 'd'.repeat(40),
    resolvedAt: new Date('2026-02-03T04:05:06.000Z'),
  })
})

test('execution reservation and provider ID persistence are idempotent and generation-correlated', async () => {
  const pool = fakePool()
  const store = new PostgresExecutionStore(pool)
  const correlation = { jobId, deploymentId, leaseGeneration: 7, provider: 'isolated-vm', executionId }
  await store.reserveExecution(correlation)
  await store.recordProviderExecution({ ...correlation, providerExecutionId: 'vm-123' })
  assert.match(pool.calls[0].text, /ON CONFLICT \(job_id, lease_generation\)/)
  assert.match(pool.calls[0].text, /lease_expires_at > NOW\(\)/)
  assert.deepEqual(pool.calls[0].values, [jobId, deploymentId, 7, 'isolated-vm', executionId])
  assert.match(pool.calls[1].text, /provider_execution_id = COALESCE/)
  assert.deepEqual(pool.calls[1].values, [jobId, deploymentId, 7, 'isolated-vm', executionId, 'vm-123'])
})

test('execution result persistence is bounded, sanitized, and updates only execution metadata', async () => {
  const pool = fakePool()
  const store = new PostgresExecutionStore(pool)
  const result = { outcome: 'FAILURE', logs: [{ message: 'safe' }] }
  await store.updateExecution({
    jobId,
    deploymentId,
    leaseGeneration: 7,
    provider: 'isolated-vm',
    executionId,
    providerExecutionId: 'vm-123',
    status: 'FAILED',
    cleanupState: 'CLEANED',
    result,
    error: 'password=supersecret',
  })
  const call = pool.calls[0]
  assert.match(call.text, /UPDATE deployment_executions/)
  assert.doesNotMatch(call.text, /UPDATE deployments/)
  assert.equal(call.values[5], 'FAILED')
  assert.equal(call.values[6], 'CLEANED')
  assert.equal(JSON.parse(call.values[7]).outcome, 'FAILURE')
  assert.equal(call.values[8], 'password=[REDACTED]')
  await assert.rejects(
    store.updateExecution({
      jobId,
      deploymentId,
      leaseGeneration: 7,
      provider: 'isolated-vm',
      executionId,
      status: 'FAILED',
      cleanupState: 'FAILED',
      result: { payload: 'x'.repeat(140 * 1024) },
    }),
    /exceeds the allowed size/,
  )
})

test('stale database writes and invalid executor correlation fail explicitly', async () => {
  const store = new PostgresExecutionStore(fakePool({ rowCount: 0 }))
  await assert.rejects(
    store.reserveExecution({
      jobId,
      deploymentId,
      leaseGeneration: 7,
      provider: 'isolated-vm',
      executionId,
    }),
    /lease is stale or correlation conflicts/,
  )
  await assert.rejects(
    new PostgresExecutionStore(fakePool({ rowCount: 0 })).recordSourceResolution(
      sourceResolution(),
      { leaseGeneration: 7, workerId: 'worker-7' },
    ),
    /lease or source changed/,
  )
  await assert.rejects(
    store.updateExecution({
      jobId,
      deploymentId,
      leaseGeneration: 7,
      provider: 'isolated-vm',
      executionId,
      status: 'UNKNOWN',
      cleanupState: 'PENDING',
    }),
    /status is invalid/,
  )
})

test('recovery query is bounded and reads executor/job correlation without mutating it', async () => {
  const pool = fakePool({ rows: [{ executor_execution_id: executionId }] })
  const store = new PostgresExecutionStore(pool)
  assert.deepEqual(await store.listRecoverableExecutions({ limit: 20 }), [{ executor_execution_id: executionId }])
  assert.match(pool.calls[0].text, /FROM deployment_executions executions/)
  assert.match(pool.calls[0].text, /LIMIT \$1/)
  assert.deepEqual(pool.calls[0].values, [20])
  await assert.rejects(store.listRecoverableExecutions({ limit: 501 }), /limit is invalid/)
})

test('registry image metadata persists digest/source/local image identity under the active lease', async () => {
  const pool = fakePool()
  const store = new PostgresExecutionStore(pool)
  const result = registryResult()
  await store.recordRegistryImage(registryRequest(), result, { workerId: 'worker-7' })
  const [{ text, values }] = pool.calls
  assert.match(text, /INSERT INTO deployment_registry_images/)
  assert.match(text, /FROM deployment_executions executions/)
  assert.match(text, /jobs\.lease_generation = \$4 AND jobs\.worker_id = \$15/)
  assert.match(text, /jobs\.state = 'RUNNING' AND jobs\.lease_expires_at > NOW\(\)/)
  assert.match(text, /lower\(jobs\.source_commit_sha\) = lower\(\$11\)/)
  assert.match(text, /ON CONFLICT \(execution_id\) DO NOTHING/)
  assert.deepEqual(values.slice(0, 14), [
    executionId,
    jobId,
    deploymentId,
    7,
    'fake-registry',
    'registry.example.test',
    'deployhub/apps',
    `dh-${'a'.repeat(64)}`,
    localImage.reference,
    localImage.digest,
    'd'.repeat(40),
    `sha256:${'c'.repeat(64)}`,
    `registry.example.test/deployhub/apps@sha256:${'c'.repeat(64)}`,
    '2026-10-05T10:00:00.000Z',
  ])
  assert.equal(values[14], 'worker-7')
})

test('registry lookup reuses only metadata fenced to the active lease', async () => {
  const row = { ...registryResult(), pushedAt: '2026-10-05T10:00:00.000Z' }
  const pool = {
    calls: [],
    async query(text, values) {
      this.calls.push({ text, values })
      return this.calls.length === 1 ? { rowCount: 1, rows: [{}] } : { rowCount: 1, rows: [row] }
    },
  }
  const store = new PostgresExecutionStore(pool)
  assert.deepEqual(
    await store.getRegistryImage(registryRequest(), { workerId: 'worker-7' }),
    row,
  )
  assert.match(pool.calls[0].text, /lease_expires_at > NOW\(\)/)
  assert.match(pool.calls[1].text, /FROM deployment_registry_images/)
})

test('registry metadata retries are idempotent and conflicting identities are rejected', async (t) => {
  const active = { rowCount: 1, rows: [{}] }
  const prior = {
    ...registryResult(),
    schemaVersion: undefined,
  }
  await t.test('matching existing execution', async () => {
    const pool = {
      count: 0,
      async query() {
        this.count += 1
        if (this.count === 1) return { rowCount: 0, rows: [] }
        if (this.count === 2) return active
        return { rowCount: 1, rows: [prior] }
      },
    }
    const stored = await new PostgresExecutionStore(pool).recordRegistryImage(
      registryRequest(),
      registryResult(),
      { workerId: 'worker-7' },
    )
    assert.equal(stored.registryDigest, prior.registryDigest)
    assert.equal(pool.count, 3)
  })
  await t.test('different digest cannot overwrite', async () => {
    const pool = {
      count: 0,
      async query() {
        this.count += 1
        if (this.count === 1) return { rowCount: 0, rows: [] }
        if (this.count === 2) return active
        return { rowCount: 1, rows: [{ ...prior, registryDigest: `sha256:${'f'.repeat(64)}` }] }
      },
    }
    await assert.rejects(
      new PostgresExecutionStore(pool).recordRegistryImage(
        registryRequest(),
        registryResult(),
        { workerId: 'worker-7' },
      ),
      (error) => error.code === 'DUPLICATE_EXECUTION',
    )
  })
})

test('stale registry lease cannot persist metadata', async () => {
  const store = new PostgresExecutionStore(fakePool({ rowCount: 0 }))
  await assert.rejects(
    store.recordRegistryImage(registryRequest(), registryResult(), { workerId: 'worker-7' }),
    (error) => error.code === 'STALE_LEASE_GENERATION',
  )
})
