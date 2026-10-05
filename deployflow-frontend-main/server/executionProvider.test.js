import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  EXECUTION_INPUT_VERSION,
  EXECUTION_PROGRESS_VERSION,
  EXECUTION_RESULT_VERSION,
  ExecutionProvider,
  MAX_LOG_BYTES,
  MAX_PROGRESS_BYTES,
  MAX_PROGRESS_EVENTS,
  MAX_RESULT_BYTES,
  validateExecutionInput,
  validateExecutionHandle,
  validateExecutionResult,
  validateLeaseContext,
  validateProgressEvent,
} from './executors/ExecutionProvider.js'
import { FakeExecutionProvider, createExecutionProvider } from './executors/FakeExecutionProvider.js'
import { FakeSourceResolver } from './executors/SourceResolver.js'
import { runDeployment } from './deploymentOrchestrator.js'

const deploymentId = '00000000-0000-4000-8000-000000000001'
const jobId = '00000000-0000-4000-8000-000000000002'
const workerId = '00000000-0000-4000-8000-000000000003'
const commitSha = 'a'.repeat(40)
const leaseGeneration = 2

function createInput(overrides = {}) {
  return {
    schemaVersion: EXECUTION_INPUT_VERSION,
    deploymentId,
    jobId,
    leaseGeneration,
    repository: 'https://github.com/example/app.git',
    requestedBranch: 'main',
    commitSha: null,
    buildMode: 'FAKE_ONLY',
    resourcePolicy: {
      cpuMilli: 1000,
      memoryMb: 1024,
      diskMb: 2048,
      pidLimit: 128,
      timeoutMs: 120000,
      logBytes: MAX_LOG_BYTES,
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

function expectedResult(overrides = {}) {
  return {
    deploymentId,
    jobId,
    commitSha: null,
    buildMode: 'FAKE_ONLY',
    ...overrides,
  }
}

async function createStartedExecution(provider, input = createInput()) {
  const started = await provider.start(input, createLease())
  return { ...started, input }
}

function sourceResolutionDependencies() {
  let persisted = null
  return {
    sourceResolver: new FakeSourceResolver({ commitSha }),
    executionStore: {
      async getSourceResolution() {
        return persisted
      },
      async recordSourceResolution(resolution) {
        persisted = {
          commitSha: resolution.commitSha,
          resolvedAt: resolution.resolvedAt,
        }
        return persisted
      },
    },
  }
}

test('ExecutionProvider defines the provider boundary without implementing execution', async () => {
  const provider = new ExecutionProvider()
  await assert.rejects(provider.start(), /not implemented/)
  await assert.rejects(provider.getStatus(), /not implemented/)
  await assert.rejects(provider.collectResult(), /not implemented/)
  await assert.rejects(provider.cancel(), /not implemented/)
  await assert.rejects(provider.cleanup(), /not implemented/)
  await assert.rejects(async () => {
    for await (const _event of provider.streamProgress()) return
  }, /not implemented/)
})

test('execution handles are bounded and only accept known startup states', () => {
  const handle = { executionId: randomUUID(), status: 'ACCEPTED' }
  assert.equal(validateExecutionHandle(handle), handle.executionId)
  for (const invalid of [
    null,
    { executionId: 'x'.repeat(201), status: 'ACCEPTED' },
    { executionId: 'unsafe/id', status: 'ACCEPTED' },
    { executionId: randomUUID(), status: 'COMPLETED' },
    { executionId: randomUUID(), status: 'UNKNOWN' },
    { executionId: randomUUID(), status: 'RUNNING', extra: 'untrusted' },
  ]) {
    assert.throws(() => validateExecutionHandle(invalid))
  }
})

test('execution input validates identity, correlation, source, mode, resource, and network policy', () => {
  const input = createInput()
  assert.equal(validateExecutionInput(input), input)
  assert.equal(validateExecutionInput(createInput({ commitSha })).commitSha, commitSha)

  const invalidInputs = [
    createInput({ deploymentId: 'deployment-1' }),
    createInput({ jobId: 'job-1' }),
    createInput({ leaseGeneration: 0 }),
    createInput({ repository: 'https://github.com.evil.example/owner/repo.git' }),
    createInput({ repository: 'https://github.com/owner/repo.git?token=secret' }),
    createInput({ repository: 'https://github.com/owner/repo' }),
    createInput({ requestedBranch: 'bad branch' }),
    createInput({ requestedBranch: 'feature/../main' }),
    createInput({ commitSha: 'not-a-commit' }),
    createInput({ buildMode: 'SHELL' }),
    createInput({ resourcePolicy: { ...createInput().resourcePolicy, memoryMb: 0 } }),
    createInput({ resourcePolicy: { ...createInput().resourcePolicy, extra: true } }),
    createInput({ networkPolicy: 'UNRESTRICTED' }),
  ]
  for (const input of invalidInputs) assert.throws(() => validateExecutionInput(input))

  assert.throws(() => validateLeaseContext(createLease({ id: randomUUID() }), createInput()), /does not match/)
  assert.throws(() => validateLeaseContext(createLease({ deployment_id: randomUUID() }), createInput()), /does not match/)
  assert.throws(() => validateLeaseContext(createLease({ lease_generation: 1 }), createInput()), /does not match/)
})

test('fake provider accepts, runs, streams bounded progress, and completes successfully', async () => {
  const provider = new FakeExecutionProvider({
    scenario: 'SUCCESS',
    clock: () => new Date('2026-01-02T03:04:05.000Z'),
  })
  const input = createInput({ commitSha })
  const first = await provider.start(input, createLease())
  assert.equal(first.status, 'ACCEPTED')
  assert.deepEqual(await provider.getStatus(first.executionId), {
    executionId: first.executionId,
    status: 'ACCEPTED',
    cleaned: false,
  })

  const reordered = {
    networkPolicy: input.networkPolicy,
    ...input,
  }
  assert.deepEqual(await provider.start(reordered, createLease()), first)
  const events = []
  for await (const event of provider.streamProgress(first.executionId)) events.push(event)
  assert.equal(events.length, 5)
  assert.equal(events[0].stage, 'VALIDATING_REPOSITORY')
  assert.equal(events.at(-1).stage, 'BUILDING_APPLICATION')
  assert.equal(events.every((event) => event.deploymentId === deploymentId
    && event.jobId === jobId
    && event.leaseGeneration === leaseGeneration), true)
  assert.equal((await provider.getStatus(first.executionId)).status, 'RUNNING')

  const result = await provider.collectResult(first.executionId)
  assert.equal(result.outcome, 'SUCCESS')
  assert.equal(result.artifact.format, 'FAKE_BUILD_RESULT')
  assert.equal(result.artifact.digest, null)
  assert.equal(validateExecutionResult(result, expectedResult({ commitSha })).outcome, 'SUCCESS')
  assert.equal((await provider.getStatus(first.executionId)).status, 'SUCCEEDED')
  assert.deepEqual(await provider.collectResult(first.executionId), result)
  assert.deepEqual(await provider.start(input, createLease()), {
    executionId: first.executionId,
    status: 'SUCCEEDED',
  })
})

test('fake provider models deterministic, transient, and timeout terminal results', async (t) => {
  for (const [scenario, status, failureKind] of [
    ['DETERMINISTIC_FAILURE', 'FAILED', 'DETERMINISTIC'],
    ['TRANSIENT_FAILURE', 'RETRYABLE_FAILURE', 'TRANSIENT_INFRASTRUCTURE'],
    ['TIMEOUT', 'TIMED_OUT', 'DETERMINISTIC'],
  ]) {
    await t.test(scenario, async () => {
      const provider = new FakeExecutionProvider({ scenario })
      const { executionId } = await createStartedExecution(provider)
      const events = []
      for await (const event of provider.streamProgress(executionId)) events.push(event)
      const result = await provider.collectResult(executionId)
      assert.equal(result.outcome, 'FAILURE')
      assert.equal(result.failureKind, failureKind)
      assert.equal((await provider.getStatus(executionId)).status, status)
      assert.equal(validateExecutionResult(result, expectedResult()).outcome, 'FAILURE')
      assert.ok(events.length > 0)
    })
  }
})

test('malformed and oversized fake results are rejected as untrusted output', async (t) => {
  await t.test('correlation mismatch', async () => {
    const provider = new FakeExecutionProvider({ scenario: 'MALFORMED_RESULT' })
    const { executionId } = await createStartedExecution(provider)
    const result = await provider.collectResult(executionId)
    assert.throws(() => validateExecutionResult(result, expectedResult()), /identifier/)
  })

  await t.test('result log budget', async () => {
    const provider = new FakeExecutionProvider({ scenario: 'OVERSIZED_RESULT' })
    const { executionId } = await createStartedExecution(provider)
    const result = await provider.collectResult(executionId)
    assert.throws(() => validateExecutionResult(result, expectedResult()), /line exceeds|logs exceed/)
  })

  await t.test('aggregate log bytes are bounded independently of line count', () => {
    const result = {
      schemaVersion: EXECUTION_RESULT_VERSION,
      deploymentId,
      jobId,
      commitSha: null,
      outcome: 'SUCCESS',
      failureKind: null,
      failureCode: null,
      detectedStack: 'Node.js',
      startedAt: '2026-01-02T03:04:05.000Z',
      completedAt: '2026-01-02T03:04:06.000Z',
      logs: Array.from({ length: 17 }, () => ({ level: 'info', message: 'x'.repeat(4096) })),
      error: null,
      artifact: { format: 'FAKE_BUILD_RESULT', reference: `fake://${deploymentId}/unresolved`, digest: null },
    }
    assert.throws(() => validateExecutionResult(result, expectedResult(), { maxLogBytes: MAX_LOG_BYTES }), /logs exceed/)
  })

  await t.test('fake mode cannot claim a real image artifact', async () => {
    const provider = new FakeExecutionProvider()
    const { executionId } = await createStartedExecution(provider)
    const result = await provider.collectResult(executionId)
    result.artifact = { format: 'OCI_IMAGE', reference: 'registry.example/app:latest', digest: `sha256:${'b'.repeat(64)}` }
    assert.throws(() => validateExecutionResult(result, expectedResult()), /cannot return a container image/)
  })
})

test('progress contract checks correlation, allowed stages, ordering, and bounded messages', () => {
  const expected = { executionId: randomUUID(), deploymentId, jobId, leaseGeneration }
  const event = {
    schemaVersion: EXECUTION_PROGRESS_VERSION,
    ...expected,
    stage: 'BUILDING_APPLICATION',
    message: 'Build progress.',
    sequence: 1,
  }
  assert.equal(validateProgressEvent(event, expected, { sequence: 1 }), event)
  for (const invalid of [
    { ...event, deploymentId: randomUUID() },
    { ...event, leaseGeneration: leaseGeneration + 1 },
    { ...event, stage: 'RUNNING' },
    { ...event, message: 'x'.repeat(4097) },
    { ...event, sequence: 2 },
    { ...event, schemaVersion: 2 },
  ]) {
    assert.throws(() => validateProgressEvent(invalid, expected, { sequence: 1 }))
  }
  assert.equal(MAX_PROGRESS_EVENTS, 1000)
  assert.equal(MAX_PROGRESS_BYTES, MAX_LOG_BYTES)
  assert.equal(MAX_RESULT_BYTES, 128 * 1024)
})

test('duplicate start with conflicting input is rejected, and cancel is idempotent', async () => {
  const provider = new FakeExecutionProvider()
  const input = createInput()
  const started = await provider.start(input, createLease())
  await assert.rejects(
    provider.start(createInput({ requestedBranch: 'develop' }), createLease()),
    /does not match its original input/,
  )
  assert.equal(await provider.cancel(started.executionId), true)
  assert.equal(await provider.cancel(started.executionId), true)
  assert.equal((await provider.getStatus(started.executionId)).status, 'CANCELLED')
  const events = []
  for await (const event of provider.streamProgress(started.executionId)) events.push(event)
  assert.deepEqual(events, [])
  await assert.rejects(provider.collectResult(started.executionId), /Cancelled/)
})

test('cleanup is idempotent and reports the configured cleanup failure once', async () => {
  const provider = new FakeExecutionProvider({ scenario: 'CLEANUP_FAILURE' })
  const { executionId } = await createStartedExecution(provider)
  await provider.collectResult(executionId)
  await assert.rejects(provider.cleanup(executionId), /cleanup failure/)
  assert.equal(await provider.cleanup(executionId), true)
  assert.equal(await provider.cleanup(executionId), true)
  assert.equal((await provider.getStatus(executionId)).cleaned, true)
})

test('provider factory refuses every non-fake execution platform', () => {
  assert.ok(createExecutionProvider({ providerName: 'fake' }) instanceof FakeExecutionProvider)
  assert.throws(() => createExecutionProvider({ providerName: 'docker' }), /real repository execution is disabled/)
})

test('orchestrator owns deployment state and rejects fake success before public RUNNING', async () => {
  const row = {
    id: deploymentId,
    status: 'QUEUED',
    stage: 'QUEUED',
    branch: 'main',
    repo_url: 'https://github.com/example/app.git',
  }
  const transitions = []
  const persistedMessages = []
  const pool = {
    async query(statement, values) {
      if (statement.includes('FROM deployments') && statement.includes('JOIN projects')) {
        return { rows: [{ ...row }] }
      }
      if (statement.includes('SELECT status, stage FROM deployments')) {
        return { rows: [{ status: row.status, stage: row.stage }] }
      }
      if (statement.includes('WITH changed AS')) {
        transitions.push(values)
        persistedMessages.push(values[7])
        row.status = values[3]
        row.stage = values[4]
        return { rowCount: 1 }
      }
      if (statement.includes('INSERT INTO deployment_logs')) {
        persistedMessages.push(values[2])
        return { rowCount: 1 }
      }
      throw new Error(`Unexpected test query: ${statement}`)
    },
  }
  const job = { id: jobId, deployment_id: deploymentId, worker_id: workerId, lease_generation: leaseGeneration }
  const lease = { id: jobId, worker_id: workerId, lease_generation: leaseGeneration }
  const fake = new FakeExecutionProvider({ scenario: 'SUCCESS' })
  const provider = {
    start: (...args) => fake.start(...args),
    async *streamProgress(...args) {
      for await (const event of fake.streamProgress(...args)) {
        yield { ...event, message: `\u001b[31msecret=example-token\u001b[0m ${event.message}\u0001` }
      }
    },
    async collectResult(...args) {
      const result = await fake.collectResult(...args)
      result.logs = [{ level: 'info', message: ['pass', 'word=one-time-secret'].join('') }]
      return result
    },
    cleanup: (...args) => fake.cleanup(...args),
  }
  const result = await runDeployment(pool, job, {
    lease,
    provider,
    ...sourceResolutionDependencies(),
  })

  assert.equal(result.outcome, 'failed')
  assert.match(result.error.message, /registry publication and Kubernetes deployment are not enabled/)
  assert.equal(persistedMessages.some((message) => /example-token|one-time-secret/.test(message)
    || [...message].some((character) => [1, 27].includes(character.codePointAt(0)))), false)
  assert.equal(persistedMessages.some((message) => message.includes('secret=[REDACTED]')), true)
  assert.deepEqual(transitions.map((values) => values.slice(3, 5)), [
    ['VALIDATING', 'VALIDATING_REPOSITORY'],
    ['CLONING', 'CLONING_REPOSITORY'],
    ['BUILDING', 'DETECTING_TECHNOLOGY'],
    ['BUILDING', 'INSTALLING_DEPENDENCIES'],
    ['BUILDING', 'BUILDING_APPLICATION'],
    ['FAILED', 'BUILDING_APPLICATION'],
  ])
  assert.equal(row.status, 'FAILED')
  assert.equal(row.stage, 'BUILDING_APPLICATION')
})

test('orchestrator leaves the current public stage intact for transient provider retries', async () => {
  const row = {
    id: deploymentId,
    status: 'QUEUED',
    stage: 'QUEUED',
    branch: 'main',
    repo_url: 'https://github.com/example/app.git',
  }
  const transitions = []
  const pool = {
    async query(statement, values) {
      if (statement.includes('FROM deployments') && statement.includes('JOIN projects')) {
        return { rows: [{ ...row }] }
      }
      if (statement.includes('SELECT status, stage FROM deployments')) {
        return { rows: [{ status: row.status, stage: row.stage }] }
      }
      if (statement.includes('WITH changed AS')) {
        transitions.push(values)
        row.status = values[3]
        row.stage = values[4]
        return { rowCount: 1 }
      }
      if (statement.includes('INSERT INTO deployment_logs')) return { rowCount: 1 }
      throw new Error(`Unexpected test query: ${statement}`)
    },
  }
  const job = { id: jobId, deployment_id: deploymentId, worker_id: workerId, lease_generation: leaseGeneration }
  const lease = { id: jobId, worker_id: workerId, lease_generation: leaseGeneration }
  await assert.rejects(
    runDeployment(pool, job, {
      lease,
      provider: new FakeExecutionProvider({ scenario: 'TRANSIENT_FAILURE' }),
      ...sourceResolutionDependencies(),
    }),
    (error) => error.retryable === true,
  )
  assert.equal(row.status, 'VALIDATING')
  assert.equal(row.stage, 'VALIDATING_REPOSITORY')
  assert.deepEqual(transitions.map((values) => values.slice(3, 5)), [
    ['VALIDATING', 'VALIDATING_REPOSITORY'],
  ])
})
