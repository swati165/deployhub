import test from 'node:test'
import assert from 'node:assert/strict'
import {
  EXECUTION_INPUT_VERSION,
  validateExecutionResult,
} from './executors/ExecutionProvider.js'
import {
  ISOLATED_EXECUTOR_DISABLED_MESSAGE,
  ISOLATED_EXECUTOR_UNAVAILABLE_MESSAGE,
  IsolatedVmExecutionProvider,
  isolatedExecutorEnabled,
} from './executors/IsolatedVmExecutionProvider.js'
import { IsolatedVmSupervisor } from './executors/IsolatedVmSupervisor.js'

const deploymentId = '00000000-0000-4000-8000-000000000001'
const jobId = '00000000-0000-4000-8000-000000000002'
const workerId = '00000000-0000-4000-8000-000000000003'
const leaseGeneration = 4

function createInput(overrides = {}) {
  return {
    schemaVersion: EXECUTION_INPUT_VERSION,
    deploymentId,
    jobId,
    leaseGeneration,
    repository: 'https://github.com/example/project.git',
    requestedBranch: 'main',
    commitSha: null,
    buildMode: 'FAKE_ONLY',
    resourcePolicy: {
      cpuMilli: 1000,
      memoryMb: 1024,
      diskMb: 2048,
      pidLimit: 128,
      timeoutMs: 120000,
      logBytes: 64 * 1024,
    },
    networkPolicy: 'NO_NETWORK',
    ...overrides,
  }
}

function createLease(overrides = {}) {
  return {
    id: jobId,
    deployment_id: deploymentId,
    worker_id: workerId,
    lease_generation: leaseGeneration,
    ...overrides,
  }
}

function createTestSupervisor() {
  const calls = []
  return {
    calls,
    supervisor: {
      async provision(input, correlation) {
        calls.push(['provision', input, correlation])
        return {
          deploymentId: correlation.deploymentId,
          executionId: correlation.executionId,
          jobId: correlation.jobId,
          leaseGeneration: correlation.leaseGeneration,
          providerExecutionId: 'vm-supervisor-test-id',
        }
      },
      async start(received, correlation) {
        calls.push(['start', received, correlation])
      },
      async monitor(received, correlation) {
        calls.push(['monitor', received, correlation])
        return { status: 'RUNNING', progress: [] }
      },
      async terminate(received, correlation) {
        calls.push(['terminate', received, correlation])
      },
      async cleanup(received, correlation) {
        calls.push(['cleanup', received, correlation])
      },
      async reconcileAbandonedExecutions() {
        calls.push(['reconcileAbandonedExecutions'])
        return []
      },
    },
  }
}

test('isolated executor gate defaults to disabled and requires the exact true value', async () => {
  assert.equal(isolatedExecutorEnabled(undefined), false)
  assert.equal(isolatedExecutorEnabled('false'), false)
  assert.equal(isolatedExecutorEnabled('TRUE'), false)
  assert.equal(isolatedExecutorEnabled('true'), true)

  const previous = process.env.ISOLATED_EXECUTOR_ENABLED
  delete process.env.ISOLATED_EXECUTOR_ENABLED
  try {
    const calls = []
    const provider = new IsolatedVmExecutionProvider({
      supervisor: { async provision(...args) { calls.push(args) } },
    })
    const started = await provider.start(createInput(), createLease())
    assert.equal(started.status, 'FAILED')
    assert.equal(calls.length, 0)
  } finally {
    if (previous === undefined) delete process.env.ISOLATED_EXECUTOR_ENABLED
    else process.env.ISOLATED_EXECUTOR_ENABLED = previous
  }
})

test('disabled provider does not provision and returns a bounded correlated failure result', async () => {
  const calls = []
  const provider = new IsolatedVmExecutionProvider({
    enabled: false,
    supervisor: {
      async provision(...args) {
        calls.push(args)
        throw new Error('Must not be called when disabled.')
      },
    },
  })
  const started = await provider.start(createInput(), createLease())
  assert.equal(started.status, 'FAILED')
  assert.equal(calls.length, 0)

  const status = await provider.getStatus(started.executionId)
  assert.deepEqual(status, {
    executionId: started.executionId,
    deploymentId,
    jobId,
    leaseGeneration,
    status: 'FAILED',
    cleaned: false,
  })
  const result = await provider.collectResult(started.executionId)
  assert.equal(result.error, ISOLATED_EXECUTOR_DISABLED_MESSAGE)
  assert.equal(result.outcome, 'FAILURE')
  assert.equal(result.artifact, null)
  assert.equal(validateExecutionResult(result, {
    deploymentId,
    jobId,
    commitSha: null,
    buildMode: 'FAKE_ONLY',
  }), result)
  const progress = []
  for await (const event of provider.streamProgress(started.executionId)) progress.push(event)
  assert.deepEqual(progress, [])
  assert.equal(await provider.cleanup(started.executionId), true)
  assert.equal(await provider.cleanup(started.executionId), true)
})

test('disabled results retain the optional commit SHA from the versioned input', async () => {
  const commitSha = 'c'.repeat(40)
  const provider = new IsolatedVmExecutionProvider({ enabled: false })
  const started = await provider.start(createInput({ commitSha }), createLease())
  const result = await provider.collectResult(started.executionId)
  assert.equal(result.commitSha, commitSha)
  validateExecutionResult(result, {
    deploymentId,
    jobId,
    commitSha,
    buildMode: 'FAKE_ONLY',
  })
})

test('repeated starts are idempotent by deployment, job, and lease generation', async () => {
  const { supervisor, calls } = createTestSupervisor()
  const provider = new IsolatedVmExecutionProvider({ enabled: true, supervisor })
  const input = createInput()
  const first = await provider.start(input, createLease())
  const duplicate = await provider.start({ ...input }, createLease())

  assert.deepEqual(duplicate, first)
  assert.equal(first.status, 'RUNNING')
  assert.equal(calls.filter(([method]) => method === 'provision').length, 1)
  assert.equal(calls.filter(([method]) => method === 'start').length, 1)
  assert.equal(calls[0][2].deploymentId, deploymentId)
  assert.equal(calls[0][2].jobId, jobId)
  assert.equal(calls[0][2].leaseGeneration, leaseGeneration)
  assert.equal(calls[0][2].executionId, first.executionId)

  await assert.rejects(
    provider.start(createInput({ requestedBranch: 'develop' }), createLease()),
    /does not match its original input/,
  )
})

test('isolated provider persists execution correlation and cleanup without owning Deployment state', async () => {
  const calls = []
  const { supervisor } = createTestSupervisor()
  const executionStore = {
    async reserveExecution(value) { calls.push(['reserve', value]) },
    async recordProviderExecution(value) { calls.push(['provider-id', value]) },
    async updateExecution(value) { calls.push(['update', value]) },
  }
  const provider = new IsolatedVmExecutionProvider({
    enabled: true,
    supervisor,
    executionStore,
  })
  const started = await provider.start(createInput(), createLease())
  await provider.cleanup(started.executionId)
  assert.deepEqual(calls.map(([method]) => method), ['reserve', 'provider-id', 'update', 'update'])
  assert.equal(calls[0][1].deploymentId, deploymentId)
  assert.equal(calls[0][1].jobId, jobId)
  assert.equal(calls[0][1].leaseGeneration, leaseGeneration)
  assert.equal(calls[1][1].providerExecutionId, 'vm-supervisor-test-id')
  assert.equal(calls[2][1].status, 'RUNNING')
  assert.equal(calls[3][1].cleanupState, 'CLEANED')
  assert.equal(calls.some(([, value]) => Object.hasOwn(value, 'deploymentStatus')), false)
})

test('enabled provider fails closed when the supervisor is only a stub', async () => {
  const provider = new IsolatedVmExecutionProvider({ enabled: true })
  const started = await provider.start(createInput(), createLease())
  assert.equal(started.status, 'FAILED')
  assert.match((await provider.collectResult(started.executionId)).error, /RUNTIME_UNAVAILABLE/)
})

test('cancellation and cleanup are repeatable and correlated to the provider execution', async () => {
  const { supervisor, calls } = createTestSupervisor()
  const provider = new IsolatedVmExecutionProvider({ enabled: true, supervisor })
  const started = await provider.start(createInput(), createLease())

  assert.equal(await provider.cancel(started.executionId), true)
  assert.equal(await provider.cancel(started.executionId), true)
  assert.equal((await provider.getStatus(started.executionId)).status, 'CANCELLED')
  assert.equal(await provider.cleanup(started.executionId), true)
  assert.equal(await provider.cleanup(started.executionId), true)
  assert.equal(calls.filter(([method]) => method === 'terminate').length, 1)
  assert.equal(calls.filter(([method]) => method === 'cleanup').length, 1)
  const termination = calls.find(([method]) => method === 'terminate')
  assert.equal(termination[2].deploymentId, deploymentId)
  assert.equal(termination[2].jobId, jobId)
  assert.equal(termination[2].leaseGeneration, leaseGeneration)
  assert.equal(termination[2].executionId, started.executionId)
})

test('provider and supervisor have no database access and provider failures cannot mutate deployment state', async () => {
  let queryCount = 0
  const trustedDatabase = { async query() { queryCount += 1 } }
  const provider = new IsolatedVmExecutionProvider({
    enabled: true,
    supervisor: {
      async provision() { throw new Error('supervisor unavailable') },
    },
  })
  const started = await provider.start(createInput(), createLease())
  const result = await provider.collectResult(started.executionId)

  assert.equal(started.status, 'FAILED')
  assert.equal(result.error, ISOLATED_EXECUTOR_UNAVAILABLE_MESSAGE)
  assert.equal(queryCount, 0)
  assert.equal(Object.hasOwn(provider, 'pool'), false)
  assert.equal(Object.hasOwn(trustedDatabase, 'deploymentStatus'), false)
})

test('supervisor refuses to provision when the runtime gate is disabled', async () => {
  const supervisor = new IsolatedVmSupervisor()
  await assert.rejects(
    supervisor.provision(createInput(), {
      deploymentId,
      jobId,
      leaseGeneration,
      executionId: 'execution-disabled',
    }),
    /RUNTIME_UNAVAILABLE/,
  )
})
