import test from 'node:test'
import assert from 'node:assert/strict'
import { runDeployment } from './deploymentOrchestrator.js'
import { FakeRegistryProvider } from './executors/FakeRegistryProvider.js'
import { RegistryProviderError } from './executors/RegistryProvider.js'

const deploymentId = '00000000-0000-4000-8000-000000000001'
const jobId = '00000000-0000-4000-8000-000000000002'
const workerId = '00000000-0000-4000-8000-000000000003'
const commitSha = 'a'.repeat(40)
const localImage = {
  format: 'OCI_IMAGE',
  reference: 'deployhub-app:0123456789abcdef01234567',
  digest: `sha256:${'b'.repeat(64)}`,
}

function createHarness({ registryProvider = new FakeRegistryProvider(), existing = null } = {}) {
  const deployment = {
    id: deploymentId,
    status: 'QUEUED',
    stage: 'QUEUED',
    branch: 'main',
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
        calls.push(['transition', values[3], values[4]])
        return { rowCount: 1 }
      }
      if (statement.includes('SELECT status, stage FROM deployments')) {
        return { rows: [{ status: deployment.status, stage: deployment.stage }] }
      }
      if (statement.includes('INSERT INTO deployment_logs')) {
        calls.push(['log', values[2]])
        return { rowCount: 1 }
      }
      throw new Error(`Unexpected test query: ${statement}`)
    },
  }
  const pinned = { commitSha, resolvedAt: '2026-10-05T10:00:00.000Z' }
  const store = {
    async getSourceResolution(...args) {
      calls.push(['source-lookup', ...args])
      return pinned
    },
    async recordSourceResolution(resolution) {
      calls.push(['source-persist', resolution])
      return { commitSha: resolution.commitSha, resolvedAt: resolution.resolvedAt }
    },
    async getRegistryImage(request) {
      calls.push(['lookup-registry-image', request])
      return existing
    },
    async recordRegistryImage(request, result, context) {
      calls.push(['persist-registry-image', request, result, context])
      return result
    },
  }
  const provider = {
    executionMode: 'NODE_NPM_OFFLINE',
    async start(input) {
      calls.push(['execution-start', input])
      return { executionId: 'ivm_execution_1', status: 'ACCEPTED' }
    },
    async *streamProgress() {
      const stages = [
        'CLONING_REPOSITORY',
        'DETECTING_TECHNOLOGY',
        'INSTALLING_DEPENDENCIES',
        'BUILDING_APPLICATION',
        'CREATING_IMAGE',
      ]
      for (const [index, stage] of stages.entries()) {
        yield {
          schemaVersion: 1,
          executionId: 'ivm_execution_1',
          deploymentId,
          jobId,
          leaseGeneration: 3,
          stage,
          message: `Completed ${stage}.`,
          sequence: index + 1,
        }
      }
    },
    async collectResult() {
      return {
        schemaVersion: 2,
        deploymentId,
        jobId,
        commitSha,
        outcome: 'SUCCESS',
        failureKind: null,
        detectedStack: 'Node.js static',
        startedAt: '2026-10-05T10:00:00.000Z',
        completedAt: '2026-10-05T10:00:10.000Z',
        logs: [],
        error: null,
        artifact: localImage,
        failureCode: null,
      }
    },
    async cleanup() {
      calls.push(['execution-cleanup'])
    },
  }
  const job = { id: jobId, deployment_id: deploymentId, worker_id: workerId, lease_generation: 3 }
  const lease = { id: jobId, deployment_id: deploymentId, worker_id: workerId, lease_generation: 3 }
  return {
    calls,
    deployment,
    job,
    lease,
    pool,
    provider,
    registryProvider,
    store,
    dependencies: {
      lease,
      provider,
      registryProvider,
      sourceResolver: { async resolve() { return { commitSha } } },
      executionStore: store,
    },
  }
}

async function runEnabled(harness) {
  const prior = process.env.ISOLATED_EXECUTOR_ENABLED
  process.env.ISOLATED_EXECUTOR_ENABLED = 'true'
  try {
    return await runDeployment(harness.pool, harness.job, harness.dependencies)
  } finally {
    if (prior === undefined) delete process.env.ISOLATED_EXECUTOR_ENABLED
    else process.env.ISOLATED_EXECUTOR_ENABLED = prior
  }
}

test('orchestrator pushes local image and durably stores immutable digest with source/execution correlation', async () => {
  const harness = createHarness()
  const outcome = await runEnabled(harness)
  const saved = harness.calls.find(([type]) => type === 'persist-registry-image')
  assert.ok(saved, JSON.stringify({ outcome: { ...outcome, error: outcome.error?.message }, registryCalls: harness.registryProvider.calls, calls: harness.calls }))
  assert.equal(saved[1].deploymentId, deploymentId)
  assert.equal(saved[1].executionId, 'ivm_execution_1')
  assert.equal(saved[1].commitSha, commitSha)
  assert.equal(saved[1].localImage.digest, localImage.digest)
  assert.match(saved[2].image, /@sha256:[a-f0-9]{64}$/)
  assert.equal(saved[3].workerId, workerId)
  assert.equal(harness.registryProvider.calls.length, 1)
  assert.equal(outcome.outcome, 'failed')
  assert.equal(harness.deployment.status, 'FAILED')
  assert.match(outcome.error.message, /Kubernetes deployment remains disabled/)
  assert.equal(harness.deployment.status === 'RUNNING', false)
})

test('already-persisted push result makes an execution retry idempotent without repushing', async () => {
  const registryProvider = new FakeRegistryProvider()
  const expected = await registryProvider.push({
    deploymentId,
    jobId,
    executionId: 'ivm_execution_1',
    leaseGeneration: 3,
    commitSha,
    localImage,
  })
  registryProvider.calls.length = 0
  const harness = createHarness({ registryProvider, existing: expected })
  const outcome = await runEnabled(harness)
  assert.equal(outcome.outcome, 'failed')
  assert.equal(registryProvider.calls.length, 0)
  assert.equal(harness.calls.some(([type]) => type === 'persist-registry-image'), false)
  assert.ok(harness.calls.some(([type]) => type === 'lookup-registry-image'))
})

test('registry failures keep a structured code and credentials out of logs', async (t) => {
  for (const [code, retryable] of [
    ['REGISTRY_AUTHENTICATION_FAILED', false],
    ['REGISTRY_UNAUTHORIZED_REPOSITORY', false],
    ['REGISTRY_UNAVAILABLE', true],
    ['LOCAL_IMAGE_NOT_FOUND', false],
    ['REGISTRY_PUSH_FAILED', true],
    ['REGISTRY_DIGEST_UNAVAILABLE', false],
    ['REGISTRY_NOT_CONFIGURED', false],
    ['REGISTRY_CREDENTIALS_UNAVAILABLE', false],
    ['REGISTRY_CONFIGURATION_INVALID', false],
    ['STALE_LEASE_GENERATION', false],
    ['DUPLICATE_EXECUTION', false],
  ]) {
    await t.test(code, async () => {
      const provider = {
        name: 'test-failure',
        async push() {
          throw new RegistryProviderError(code, 'Safe registry error; password=[REDACTED]', { retryable })
        },
      }
      const harness = createHarness({ registryProvider: provider })
      if (retryable) {
        await assert.rejects(
          runEnabled(harness),
          (error) => error.failureCode === code && error.retryable,
        )
        assert.equal(harness.deployment.status === 'FAILED', false)
      } else {
        const outcome = await runEnabled(harness)
        assert.equal(outcome.error.failureCode, code)
        assert.equal(outcome.outcome, 'failed')
        assert.equal(harness.deployment.status, 'FAILED')
      }
      assert.equal(harness.calls.some(([type, message]) => type === 'log'
        && /password=.*(?:secret|token)/i.test(message)), false)
    })
  }
})
