import { randomUUID } from 'node:crypto'
import {
  EXECUTION_PROGRESS_VERSION,
  EXECUTION_RESULT_VERSION,
  EXECUTION_SCENARIOS,
  ExecutionProvider,
  validateExecutionInput,
  validateLeaseContext,
} from './ExecutionProvider.js'

const SCENARIO_EVENTS = Object.freeze({
  SUCCESS: [
    ['VALIDATING_REPOSITORY', 'Fake provider accepted the validated repository reference.'],
    ['CLONING_REPOSITORY', 'Fake provider simulated source acquisition; no repository was cloned.'],
    ['DETECTING_TECHNOLOGY', 'Fake provider simulated technology detection.'],
    ['INSTALLING_DEPENDENCIES', 'Fake provider simulated dependency installation; no package scripts ran.'],
    ['BUILDING_APPLICATION', 'Fake provider simulated a successful build; no build command ran.'],
  ],
  DETERMINISTIC_FAILURE: [
    ['VALIDATING_REPOSITORY', 'Fake provider simulated a deterministic execution failure.'],
  ],
  VALIDATION_FAILURE: [
    ['VALIDATING_REPOSITORY', 'Fake provider simulated a deterministic validation failure.'],
  ],
  CLONE_FAILURE: [
    ['VALIDATING_REPOSITORY', 'Fake provider simulated successful input validation.'],
    ['CLONING_REPOSITORY', 'Fake provider simulated a deterministic source acquisition failure; no repository was cloned.'],
  ],
  BUILD_FAILURE: [
    ['VALIDATING_REPOSITORY', 'Fake provider simulated successful input validation.'],
    ['CLONING_REPOSITORY', 'Fake provider simulated source acquisition; no repository was cloned.'],
    ['DETECTING_TECHNOLOGY', 'Fake provider simulated technology detection.'],
    ['INSTALLING_DEPENDENCIES', 'Fake provider simulated dependency installation; no package scripts ran.'],
    ['BUILDING_APPLICATION', 'Fake provider simulated a deterministic build failure; no build command ran.'],
  ],
  TRANSIENT_FAILURE: [
    ['VALIDATING_REPOSITORY', 'Fake provider simulated a transient infrastructure interruption.'],
  ],
  TIMEOUT: [
    ['VALIDATING_REPOSITORY', 'Fake provider simulated an execution timeout.'],
  ],
  MALFORMED_RESULT: [
    ['VALIDATING_REPOSITORY', 'Fake provider simulated a malformed result.'],
  ],
  OVERSIZED_RESULT: [
    ['VALIDATING_REPOSITORY', 'Fake provider simulated an oversized result.'],
  ],
  CLEANUP_FAILURE: [
    ['VALIDATING_REPOSITORY', 'Fake provider simulated successful input validation.'],
    ['CLONING_REPOSITORY', 'Fake provider simulated source acquisition; no repository was cloned.'],
    ['DETECTING_TECHNOLOGY', 'Fake provider simulated technology detection.'],
    ['INSTALLING_DEPENDENCIES', 'Fake provider simulated dependency installation; no package scripts ran.'],
    ['BUILDING_APPLICATION', 'Fake provider simulated a successful build; no build command ran.'],
  ],
})

const FAILURE_MESSAGES = Object.freeze({
  DETERMINISTIC_FAILURE: 'Fake provider simulated a deterministic execution failure.',
  VALIDATION_FAILURE: 'Fake validation scenario failed deterministically.',
  CLONE_FAILURE: 'Fake source acquisition scenario failed deterministically.',
  BUILD_FAILURE: 'Fake build scenario failed deterministically.',
  TRANSIENT_FAILURE: 'Fake provider simulated a transient infrastructure interruption.',
  TIMEOUT: 'Fake provider simulated an execution timeout.',
})

const FAILURE_SCENARIOS = new Set(Object.keys(FAILURE_MESSAGES))
const TERMINAL_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'RETRYABLE_FAILURE', 'TIMED_OUT', 'CANCELLED'])

export class FakeExecutionProvider extends ExecutionProvider {
  #scenario
  #executions = new Map()
  #idempotency = new Map()

  constructor({ scenario = 'SUCCESS', clock = () => new Date() } = {}) {
    super()
    if (!EXECUTION_SCENARIOS.includes(scenario)) throw new Error('Fake execution scenario is not allowed.')
    if (typeof clock !== 'function') throw new TypeError('Fake provider clock must be a function.')
    this.#scenario = scenario
    this.clock = clock
  }

  async start(input, leaseContext) {
    validateExecutionInput(input)
    validateLeaseContext(leaseContext, input)
    const key = `${input.deploymentId}:${input.jobId}:${input.leaseGeneration}`
    const inputFingerprint = fingerprintInput(input)
    const prior = this.#idempotency.get(key)
    if (prior) {
      if (prior.inputFingerprint !== inputFingerprint) {
        throw new Error('Duplicate fake execution start does not match its original input.')
      }
      return { executionId: prior.executionId, status: this.#getExecution(prior.executionId).status }
    }

    const executionId = randomUUID()
    const execution = {
      executionId,
      input: structuredClone(input),
      startedAt: this.#timestamp(),
      status: 'ACCEPTED',
      cancelled: false,
      cleaned: false,
      cleanupFailureReported: false,
      result: null,
      events: SCENARIO_EVENTS[this.#scenario].map(([stage, message], index) => ({
        schemaVersion: EXECUTION_PROGRESS_VERSION,
        executionId,
        deploymentId: input.deploymentId,
        jobId: input.jobId,
        leaseGeneration: input.leaseGeneration,
        stage,
        message,
        sequence: index + 1,
      })),
    }
    this.#executions.set(executionId, execution)
    this.#idempotency.set(key, { executionId, inputFingerprint })
    return { executionId, status: 'ACCEPTED' }
  }

  async getStatus(executionId) {
    const execution = this.#getExecution(executionId)
    return { executionId, status: execution.status, cleaned: execution.cleaned }
  }

  async *streamProgress(executionId, cursor = 0) {
    const execution = this.#getExecution(executionId)
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > execution.events.length) {
      throw new Error('Progress cursor is invalid.')
    }
    if (execution.status === 'ACCEPTED') execution.status = 'RUNNING'
    if (execution.cancelled) return
    for (const event of execution.events) {
      if (event.sequence > cursor) yield structuredClone(event)
    }
  }

  async collectResult(executionId) {
    const execution = this.#getExecution(executionId)
    if (execution.cancelled) throw new Error('Cancelled fake execution has no result.')
    if (execution.result) return structuredClone(execution.result)
    if (execution.status === 'ACCEPTED') execution.status = 'RUNNING'

    const result = {
      schemaVersion: EXECUTION_RESULT_VERSION,
      deploymentId: execution.input.deploymentId,
      jobId: execution.input.jobId,
      commitSha: execution.input.commitSha,
      outcome: 'SUCCESS',
      failureKind: null,
      detectedStack: 'Node.js simulated',
      startedAt: execution.startedAt,
      completedAt: this.#timestamp(),
      logs: [{ level: 'info', message: 'Fake provider emitted a synthetic result; no repository code ran.' }],
      error: null,
      artifact: {
        format: 'FAKE_BUILD_RESULT',
        reference: `fake://${execution.input.deploymentId}/${execution.input.commitSha ?? 'unresolved'}`,
        digest: null,
      },
      failureCode: null,
    }

    if (FAILURE_SCENARIOS.has(this.#scenario)) {
      result.outcome = 'FAILURE'
      result.failureKind = this.#scenario === 'TRANSIENT_FAILURE'
        ? 'TRANSIENT_INFRASTRUCTURE'
        : 'DETERMINISTIC'
      result.error = FAILURE_MESSAGES[this.#scenario]
      result.detectedStack = null
      result.artifact = null
      result.failureCode = this.#scenario === 'TRANSIENT_FAILURE'
        ? 'RUNTIME_UNAVAILABLE'
        : 'EXECUTION_FAILED'
    } else if (this.#scenario === 'MALFORMED_RESULT') {
      result.jobId = randomUUID()
    } else if (this.#scenario === 'OVERSIZED_RESULT') {
      result.logs = [{ level: 'info', message: 'x'.repeat(64 * 1024 + 1) }]
    }

    if (this.#scenario === 'TIMEOUT') execution.status = 'TIMED_OUT'
    else if (result.outcome === 'SUCCESS') execution.status = 'SUCCEEDED'
    else if (result.failureKind === 'TRANSIENT_INFRASTRUCTURE') execution.status = 'RETRYABLE_FAILURE'
    else execution.status = 'FAILED'
    execution.result = structuredClone(result)
    return result
  }

  async cancel(executionId) {
    const execution = this.#getExecution(executionId)
    if (execution.status === 'CANCELLED') return true
    if (TERMINAL_STATUSES.has(execution.status)) return false
    execution.cancelled = true
    execution.status = 'CANCELLED'
    return true
  }

  async cleanup(executionId) {
    const execution = this.#getExecution(executionId)
    if (execution.cleaned) return true
    execution.cleaned = true
    if (this.#scenario === 'CLEANUP_FAILURE' && !execution.cleanupFailureReported) {
      execution.cleanupFailureReported = true
      throw new Error('Fake provider simulated a cleanup failure.')
    }
    return true
  }

  #timestamp() {
    const value = this.clock()
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new Error('Fake provider clock returned an invalid timestamp.')
    }
    return value.toISOString()
  }

  #getExecution(executionId) {
    const execution = this.#executions.get(executionId)
    if (!execution) throw new Error('Fake execution was not found.')
    return execution
  }
}

export function createExecutionProvider({
  providerName = process.env.EXECUTION_PROVIDER || 'fake',
  scenario = process.env.FAKE_EXECUTION_SCENARIO || 'SUCCESS',
} = {}) {
  if (providerName !== 'fake') {
    throw new Error('Only the fake execution provider is available; real repository execution is disabled.')
  }
  return new FakeExecutionProvider({ scenario })
}

function fingerprintInput(input) {
  return JSON.stringify({
    schemaVersion: input.schemaVersion,
    deploymentId: input.deploymentId,
    jobId: input.jobId,
    leaseGeneration: input.leaseGeneration,
    repository: input.repository,
    requestedBranch: input.requestedBranch,
    commitSha: input.commitSha,
    buildMode: input.buildMode,
    resourcePolicy: {
      cpuMilli: input.resourcePolicy.cpuMilli,
      memoryMb: input.resourcePolicy.memoryMb,
      diskMb: input.resourcePolicy.diskMb,
      pidLimit: input.resourcePolicy.pidLimit,
      timeoutMs: input.resourcePolicy.timeoutMs,
      logBytes: input.resourcePolicy.logBytes,
    },
    networkPolicy: input.networkPolicy,
  })
}
