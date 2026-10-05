import test from 'node:test'
import assert from 'node:assert/strict'
import { runDeployment } from './deploymentOrchestrator.js'
import { FakeSourceResolver } from './executors/SourceResolver.js'

const deploymentId = '00000000-0000-4000-8000-000000000001'
const jobId = '00000000-0000-4000-8000-000000000002'
const workerId = '00000000-0000-4000-8000-000000000003'
const leaseGeneration = 3
const commitSha = 'c'.repeat(40)

function createHarness({
  sourceResolver = new FakeSourceResolver({ commitSha }),
  lookup = null,
  persistedSha = commitSha,
  resolverConfigured = true,
} = {}) {
  const deployment = {
    id: deploymentId,
    status: 'QUEUED',
    stage: 'QUEUED',
    branch: 'release/next',
    repo_url: 'https://github.com/example/project.git',
  }
  const calls = []
  const pool = {
    async query(statement, values) {
      if (statement.includes('FROM deployments') && statement.includes('JOIN projects')) {
        return { rows: [{ ...deployment }] }
      }
      if (statement.includes('WITH changed AS')) {
        deployment.status = values[3]
        deployment.stage = values[4]
        calls.push(['transition', deployment.status, deployment.stage])
        return { rowCount: 1 }
      }
      if (statement.includes('SELECT status, stage FROM deployments')) {
        return { rows: [{ status: deployment.status, stage: deployment.stage }] }
      }
      if (statement.includes('INSERT INTO deployment_logs')) return { rowCount: 1 }
      throw new Error(`Unexpected test query: ${statement}`)
    },
  }
  const store = {
    async getSourceResolution(input, lease) {
      calls.push(['get-source', input, lease])
      if (lookup instanceof Error) throw lookup
      return lookup
    },
    async recordSourceResolution(resolution, lease) {
      calls.push(['persist-source', resolution, lease])
      return {
        commitSha: persistedSha,
        resolvedAt: resolution.resolvedAt,
      }
    },
  }
  const provider = {
    async start(input) {
      calls.push(['provider-start', input])
      return { executionId: 'execution-1', status: 'ACCEPTED' }
    },
    async *streamProgress() {},
    async collectResult() {
      return {
        schemaVersion: 1,
        deploymentId,
        jobId,
        commitSha,
        outcome: 'FAILURE',
        failureKind: 'DETERMINISTIC',
        detectedStack: null,
        startedAt: '2026-02-03T04:05:06.000Z',
        completedAt: '2026-02-03T04:05:07.000Z',
        logs: [],
        error: 'Synthetic failure for orchestration test.',
        artifact: null,
      }
    },
    async cleanup() {
      calls.push(['provider-cleanup'])
    },
  }
  const dependencies = {
    lease: {
      id: jobId,
      deployment_id: deploymentId,
      worker_id: workerId,
      lease_generation: leaseGeneration,
    },
    provider,
    sourceResolver: resolverConfigured ? sourceResolver : null,
    executionStore: store,
  }
  const job = {
    id: jobId,
    deployment_id: deploymentId,
    worker_id: workerId,
    lease_generation: leaseGeneration,
  }
  return { calls, dependencies, deployment, job, pool }
}

test('orchestrator persists the trusted commit SHA before passing the same pin to the provider', async () => {
  const harness = createHarness()
  const result = await runDeployment(harness.pool, harness.job, harness.dependencies)
  const persistIndex = harness.calls.findIndex(([name]) => name === 'persist-source')
  const startIndex = harness.calls.findIndex(([name]) => name === 'provider-start')
  const startInput = harness.calls[startIndex][1]

  assert.ok(persistIndex >= 0)
  assert.ok(startIndex > persistIndex)
  assert.equal(startInput.commitSha, commitSha)
  assert.equal(startInput.requestedBranch, 'release/next')
  assert.equal(harness.calls[persistIndex][2].leaseGeneration, leaseGeneration)
  assert.equal(harness.calls[persistIndex][2].workerId, workerId)
  assert.equal(result.outcome, 'failed')
  assert.equal(harness.deployment.status, 'FAILED')
})

test('orchestrator fails closed on a mismatched persisted SHA without starting the provider', async () => {
  const harness = createHarness({ persistedSha: 'd'.repeat(40) })
  const result = await runDeployment(harness.pool, harness.job, harness.dependencies)
  assert.equal(result.outcome, 'failed')
  assert.match(result.error.message, /source resolution failed or could not be pinned/)
  assert.equal(harness.calls.some(([name]) => name === 'provider-start'), false)
  assert.equal(harness.deployment.status, 'FAILED')
})

test('orchestrator fences stale source leases and does not call the resolver or provider', async () => {
  let resolverCalls = 0
  const resolver = {
    async resolve() {
      resolverCalls += 1
      throw new Error('must not resolve')
    },
  }
  const harness = createHarness({
    sourceResolver: resolver,
    lookup: new Error('stale lease generation'),
  })
  const result = await runDeployment(harness.pool, harness.job, harness.dependencies)
  assert.equal(result.outcome, 'failed')
  assert.equal(resolverCalls, 0)
  assert.equal(harness.calls.some(([name]) => name === 'provider-start'), false)
  assert.equal(harness.deployment.status, 'FAILED')
})

test('orchestrator requires an explicitly configured trusted source resolver', async () => {
  const harness = createHarness({ resolverConfigured: false })
  const result = await runDeployment(harness.pool, harness.job, harness.dependencies)
  assert.equal(result.outcome, 'failed')
  assert.match(result.error.message, /source resolution failed or could not be pinned/)
  assert.equal(harness.calls.some(([name]) => name === 'provider-start'), false)
})
