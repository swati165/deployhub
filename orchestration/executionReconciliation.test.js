import test from 'node:test'
import assert from 'node:assert/strict'
import { reconcileExecutions } from './executionReconciliation.js'
import { FakeSupervisor } from './executors/FakeSupervisor.js'

const deploymentId = '00000000-0000-4000-8000-000000000001'
const jobId = '00000000-0000-4000-8000-000000000002'
const leaseExpiresAt = '2999-01-01T00:00:00.000Z'

class MemoryExecutionStore {
  rows = new Map()

  add(row) {
    this.rows.set(row.executor_execution_id, structuredClone(row))
  }

  async listRecoverableExecutions() {
    return [...this.rows.values()]
      .filter((row) => row.executor_cleanup_state !== 'CLEANED'
        || ['PROVISIONED', 'RUNNING'].includes(row.executor_status))
      .map((row) => structuredClone(row))
  }

  async recordProviderExecution(correlation) {
    const row = this.rows.get(correlation.executionId)
    assert.ok(row)
    assert.equal(row.job_id, correlation.jobId)
    assert.equal(row.deployment_id, correlation.deploymentId)
    assert.equal(Number(row.executor_lease_generation), correlation.leaseGeneration)
    assert.equal(row.execution_provider, correlation.provider)
    row.provider_execution_id = correlation.providerExecutionId
  }

  async updateExecution(update) {
    const row = this.rows.get(update.executionId)
    assert.ok(row)
    assert.equal(row.job_id, update.jobId)
    assert.equal(row.deployment_id, update.deploymentId)
    assert.equal(Number(row.executor_lease_generation), update.leaseGeneration)
    assert.equal(row.execution_provider, update.provider)
    if (update.providerExecutionId) {
      assert.equal(row.provider_execution_id, update.providerExecutionId)
    }
    row.executor_status = update.status
    row.executor_cleanup_state = update.cleanupState
    row.executor_result = update.result ?? null
    row.executor_last_error = update.error ?? null
  }
}

function result(overrides = {}) {
  return {
    schemaVersion: 1,
    deploymentId,
    jobId,
    commitSha: null,
    outcome: 'SUCCESS',
    failureKind: null,
    detectedStack: 'Node.js',
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:01:00.000Z',
    logs: [{ level: 'info', message: 'Synthetic result only.' }],
    error: null,
    artifact: null,
    ...overrides,
  }
}

async function createExecution({
  supervisor = new FakeSupervisor(),
  store = new MemoryExecutionStore(),
  executionId = 'execution-1',
  state = 'RUNNING',
  jobLeaseGeneration = 1,
  executorLeaseGeneration = 1,
  providerExecutionId,
} = {}) {
  const correlation = {
    deploymentId,
    jobId,
    leaseGeneration: executorLeaseGeneration,
    executionId,
  }
  const provisioned = await supervisor.provision({}, correlation)
  await supervisor.start(provisioned, correlation)
  if (providerExecutionId) {
    supervisor.setState(executionId, state)
  } else if (state !== 'RUNNING') {
    supervisor.setState(executionId, state, {
      result: state === 'COMPLETED' ? result() : null,
      error: state === 'FAILED' ? 'Synthetic provider failure.' : null,
    })
  }
  const current = (await supervisor.reconcileAbandonedExecutions())
    .find((record) => record.executionId === executionId)
  store.add({
    job_id: jobId,
    deployment_id: deploymentId,
    job_state: 'RUNNING',
    lease_generation: jobLeaseGeneration,
    lease_expires_at: leaseExpiresAt,
    execution_provider: 'fake',
    executor_execution_id: executionId,
    provider_execution_id: current.providerExecutionId,
    executor_lease_generation: executorLeaseGeneration,
    executor_status: state === 'RUNNING' ? 'RUNNING' : 'PROVISIONED',
    executor_cleanup_state: current.cleanupState,
    executor_result: null,
    executor_last_error: null,
    source_commit_sha: null,
  })
  return { correlation, supervisor, store, snapshot: current }
}

test('reconciles a crash after execution reservation and resumes a provisioned execution', async () => {
  const supervisor = new FakeSupervisor()
  const store = new MemoryExecutionStore()
  const correlation = { deploymentId, jobId, leaseGeneration: 1, executionId: 'reserved-only' }
  const provisioned = await supervisor.provision({}, correlation)
  store.add({
    job_id: jobId,
    deployment_id: deploymentId,
    job_state: 'RUNNING',
    lease_generation: 1,
    lease_expires_at: leaseExpiresAt,
    execution_provider: 'fake',
    executor_execution_id: correlation.executionId,
    provider_execution_id: null,
    executor_lease_generation: 1,
    executor_status: 'PROVISIONED',
    executor_cleanup_state: 'PENDING',
    executor_result: null,
    executor_last_error: null,
    source_commit_sha: null,
  })

  const outcomes = await reconcileExecutions(store, supervisor)
  assert.deepEqual(outcomes, [{ executionId: correlation.executionId, outcome: 'RUNNING' }])
  const saved = store.rows.get(correlation.executionId)
  assert.equal(saved.executor_status, 'RUNNING')
  assert.equal(saved.provider_execution_id, provisioned.providerExecutionId)
  assert.equal(saved.executor_cleanup_state, 'PENDING')
  assert.equal((await supervisor.reconcileAbandonedExecutions())[0].state, 'RUNNING')
})

test('recovers a running execution after worker restart without cleaning active work', async () => {
  const { supervisor, store } = await createExecution()
  const outcomes = await reconcileExecutions(store, supervisor)
  assert.deepEqual(outcomes, [{ executionId: 'execution-1', outcome: 'RUNNING' }])
  assert.equal(store.rows.get('execution-1').executor_cleanup_state, 'PENDING')
  assert.equal((await supervisor.reconcileAbandonedExecutions())[0].state, 'RUNNING')
})

test('persists completion while worker is unavailable without changing deployment state', async () => {
  const { supervisor, store } = await createExecution({ state: 'COMPLETED' })
  const outcomes = await reconcileExecutions(store, supervisor)
  const saved = store.rows.get('execution-1')
  assert.deepEqual(outcomes, [{ executionId: 'execution-1', outcome: 'SUCCEEDED' }])
  assert.equal(saved.executor_status, 'SUCCEEDED')
  assert.equal(saved.executor_cleanup_state, 'CLEANED')
  assert.equal(saved.executor_result.outcome, 'SUCCESS')
  assert.equal(Object.hasOwn(saved, 'deployment_status'), false)
  assert.equal((await supervisor.reconcileAbandonedExecutions())[0].state, 'CLEANED')
})

test('cleanup failure remains recoverable and a later reconciliation succeeds idempotently', async () => {
  const supervisor = new FakeSupervisor({ cleanupFailures: 1 })
  const { store } = await createExecution({ supervisor, state: 'COMPLETED' })
  const first = await reconcileExecutions(store, supervisor)
  assert.deepEqual(first, [{ executionId: 'execution-1', outcome: 'CLEANUP_PENDING' }])
  assert.equal(store.rows.get('execution-1').executor_cleanup_state, 'FAILED')
  assert.equal(store.rows.get('execution-1').executor_status, 'SUCCEEDED')

  const second = await reconcileExecutions(store, supervisor)
  assert.deepEqual(second, [{ executionId: 'execution-1', outcome: 'SUCCEEDED' }])
  assert.equal(store.rows.get('execution-1').executor_cleanup_state, 'CLEANED')
  assert.equal(store.rows.get('execution-1').executor_status, 'SUCCEEDED')
  assert.deepEqual(await reconcileExecutions(store, supervisor), [
    { executionId: 'execution-1', outcome: 'ALREADY_CLEANED' },
  ])
})

test('stale lease generation is fenced by termination and cleanup', async () => {
  const { supervisor, store } = await createExecution({ jobLeaseGeneration: 2 })
  const outcomes = await reconcileExecutions(store, supervisor)
  assert.deepEqual(outcomes, [{ executionId: 'execution-1', outcome: 'CANCELLED' }])
  assert.equal(store.rows.get('execution-1').executor_status, 'CANCELLED')
  assert.equal(store.rows.get('execution-1').executor_cleanup_state, 'CLEANED')
  assert.equal((await supervisor.reconcileAbandonedExecutions())[0].state, 'CLEANED')
})

test('provider failure, cancellation, and abandonment remain distinct terminal outcomes', async () => {
  for (const [state, expectedStatus] of [
    ['FAILED', 'FAILED'],
    ['CANCELLED', 'CANCELLED'],
    ['ABANDONED', 'ABANDONED'],
  ]) {
    const { supervisor, store } = await createExecution({ executionId: `terminal-${state}`, state })
    const [outcome] = await reconcileExecutions(store, supervisor)
    assert.equal(outcome.outcome, expectedStatus)
    const saved = store.rows.get(`terminal-${state}`)
    assert.equal(saved.executor_status, expectedStatus)
    assert.equal(saved.executor_cleanup_state, 'CLEANED')
  }
})

test('duplicate provider execution IDs are rejected without updating either execution', async () => {
  const { supervisor, store } = await createExecution({ executionId: 'duplicate-a' })
  await createExecution({ supervisor, store, executionId: 'duplicate-b' })
  const original = supervisor.reconcileAbandonedExecutions.bind(supervisor)
  supervisor.reconcileAbandonedExecutions = async () => {
    const records = await original()
    return records.map((record) => ({ ...record, providerExecutionId: 'same-provider-id' }))
  }
  const outcomes = await reconcileExecutions(store, supervisor)
  assert.equal(outcomes.length, 2)
  assert.ok(outcomes.every(({ outcome }) => outcome === 'DUPLICATE_PROVIDER_EXECUTION_ID'))
  assert.equal(store.rows.get('duplicate-a').executor_status, 'RUNNING')
  assert.equal(store.rows.get('duplicate-b').executor_status, 'RUNNING')
  assert.equal(store.rows.get('duplicate-a').provider_execution_id, 'fake_duplicate-a')
})

test('orphaned supervisor executions are terminated and cleaned without database mutation', async () => {
  const supervisor = new FakeSupervisor()
  const store = new MemoryExecutionStore()
  const orphan = {
    deploymentId,
    jobId,
    leaseGeneration: 3,
    executionId: 'orphaned-execution',
  }
  supervisor.addOrphan(orphan)
  assert.deepEqual(await reconcileExecutions(store, supervisor), [
    { executionId: 'orphaned-execution', outcome: 'ORPHAN_CLEANED' },
  ])
  assert.equal(store.rows.size, 0)
  assert.equal((await supervisor.reconcileAbandonedExecutions())[0].state, 'CLEANED')
})

test('malformed completion result is rejected, sanitized, and cleaned up', async () => {
  const { supervisor, store } = await createExecution({ state: 'COMPLETED' })
  supervisor.setState('execution-1', 'COMPLETED', { result: { outcome: 'SUCCESS' } })
  const outcomes = await reconcileExecutions(store, supervisor)
  assert.deepEqual(outcomes, [{ executionId: 'execution-1', outcome: 'FAILED' }])
  assert.equal(store.rows.get('execution-1').executor_cleanup_state, 'CLEANED')
  assert.match(store.rows.get('execution-1').executor_last_error, /result/i)
})

test('already-cleaned executions and repeated reconciliation are idempotent', async () => {
  const { supervisor, store } = await createExecution({ state: 'COMPLETED' })
  await reconcileExecutions(store, supervisor)
  const snapshot = await supervisor.reconcileAbandonedExecutions()
  assert.equal(snapshot[0].state, 'CLEANED')
  assert.deepEqual(await reconcileExecutions(store, supervisor), [
    { executionId: 'execution-1', outcome: 'ALREADY_CLEANED' },
  ])
  assert.equal(store.rows.get('execution-1').executor_status, 'SUCCEEDED')
})

test('fake supervisor models all documented lifecycle and cleanup states', async () => {
  const supervisor = new FakeSupervisor()
  const states = [
    'PROVISIONED',
    'STARTED',
    'RUNNING',
    'COMPLETED',
    'FAILED',
    'CANCELLED',
    'CLEANUP_PENDING',
    'ABANDONED',
    'CLEANED',
  ]
  for (const [index, state] of states.entries()) {
    const correlation = {
      deploymentId,
      jobId,
      leaseGeneration: index + 1,
      executionId: `state-${index}`,
    }
    await supervisor.provision({}, correlation)
    supervisor.setState(correlation.executionId, state)
  }
  const snapshots = await supervisor.reconcileAbandonedExecutions()
  assert.deepEqual(snapshots.map(({ state }) => state), states)
})
