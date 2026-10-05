import { createHash } from 'node:crypto'
import {
  EXECUTION_RESULT_VERSION,
  ExecutionProvider,
  MAX_LOG_LINE_BYTES,
  MAX_ERROR_BYTES,
  MAX_RESULT_BYTES,
  validateExecutionInput,
  validateLeaseContext,
  validateExecutionResult,
  validateProgressEvent,
} from './ExecutionProvider.js'
import { IsolatedVmSupervisor } from './IsolatedVmSupervisor.js'

export const ISOLATED_EXECUTOR_DISABLED_MESSAGE =
  'Isolated VM execution is disabled; no VM was provisioned or repository code executed.'
export const ISOLATED_EXECUTOR_UNAVAILABLE_MESSAGE =
  'Isolated VM execution is enabled but unavailable because no VM supervisor is configured.'
const TERMINAL_STATUSES = new Set([
  'SUCCEEDED',
  'FAILED',
  'RETRYABLE_FAILURE',
  'TIMED_OUT',
  'CANCELLED',
])
const MAX_TRACKED_EXECUTIONS = 1000

export function isolatedExecutorEnabled(value) {
  return value === 'true'
}

export class IsolatedVmExecutionProvider extends ExecutionProvider {
  #enabled
  #supervisor
  #executionStore
  #providerName
  #executions = new Map()
  #idempotency = new Map()

  constructor({
    enabled = isolatedExecutorEnabled(process.env.ISOLATED_EXECUTOR_ENABLED),
    supervisor = new IsolatedVmSupervisor(),
    executionStore = null,
    providerName = 'isolated-vm',
    clock = () => new Date(),
  } = {}) {
    super()
    if (typeof enabled !== 'boolean') throw new TypeError('Isolated executor enabled option must be boolean.')
    if (!supervisor || typeof supervisor.provision !== 'function') {
      throw new TypeError('Isolated VM supervisor is required.')
    }
    if (typeof clock !== 'function') throw new TypeError('Isolated executor clock must be a function.')
    if (executionStore !== null
      && (typeof executionStore.reserveExecution !== 'function'
        || typeof executionStore.updateExecution !== 'function'
        || typeof executionStore.recordProviderExecution !== 'function')) {
      throw new TypeError('Isolated executor store is invalid.')
    }
    if (typeof providerName !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(providerName)) {
      throw new TypeError('Isolated executor provider name is invalid.')
    }
    this.#enabled = enabled
    this.#supervisor = supervisor
    this.#executionStore = executionStore
    this.#providerName = providerName
    this.clock = clock
    this.executionMode = 'NODE_NPM_OFFLINE'
  }

  async start(input, leaseContext, { signal } = {}) {
    validateExecutionInput(input)
    validateLeaseContext(leaseContext, input)
    if (signal !== undefined
      && (!signal || typeof signal.addEventListener !== 'function' || typeof signal.aborted !== 'boolean')) {
      throw new TypeError('Isolated execution cancellation signal is invalid.')
    }

    const correlation = {
      deploymentId: input.deploymentId,
      jobId: input.jobId,
      leaseGeneration: input.leaseGeneration,
    }
    const key = correlationKey(correlation)
    const inputFingerprint = fingerprintInput(input)
    const prior = this.#idempotency.get(key)
    if (prior) {
      if (prior.inputFingerprint !== inputFingerprint) {
        throw new Error('Duplicate isolated execution start does not match its original input.')
      }
      return handle(prior.record)
    }
    if (this.#executions.size >= MAX_TRACKED_EXECUTIONS) {
      throw new Error('Isolated executor has reached its bounded in-memory execution limit.')
    }

    const record = {
      ...correlation,
      commitSha: input.commitSha,
      executionId: providerExecutionId(correlation),
      status: 'ACCEPTED',
      cleaned: false,
      startedAt: this.#timestamp(),
      completedAt: null,
      progress: [],
      result: null,
      supervisorExecution: null,
      providerExecutionId: null,
      buildMode: input.buildMode,
      cancelRequested: signal?.aborted === true,
      signal,
      monitorTask: null,
      monitorComplete: false,
      cleanupRequired: false,
      cleanupFailed: false,
    }
    await this.#executionStore?.reserveExecution({
      ...correlation,
      provider: this.#providerName,
      executionId: record.executionId,
    })
    this.#executions.set(record.executionId, record)
    this.#idempotency.set(key, { inputFingerprint, record })
    if (signal) {
      record.abortHandler = () => {
        record.cancelRequested = true
        void this.cancel(record.executionId).catch(() => {})
      }
      signal.addEventListener('abort', record.abortHandler, { once: true })
    }

    if (!this.#enabled) {
      this.#fail(record, ISOLATED_EXECUTOR_DISABLED_MESSAGE)
      await this.#persist(record, { cleanupState: 'NOT_REQUIRED' })
      return handle(record)
    }

    try {
      const assertLease = input.buildMode === 'NODE_NPM_OFFLINE'
        ? async () => {
          if (typeof this.#executionStore?.getSourceResolution !== 'function') {
            const error = new Error('Active source lease cannot be verified.')
            error.code = 'STALE_LEASE'
            throw error
          }
          const pinned = await this.#executionStore.getSourceResolution({
            deploymentId: input.deploymentId,
            jobId: input.jobId,
            repository: input.repository,
            requestedBranch: input.requestedBranch,
          }, {
            leaseGeneration: input.leaseGeneration,
            workerId: leaseContext.worker_id,
          })
          if (!pinned || typeof pinned.commitSha !== 'string'
            || pinned.commitSha.toLowerCase() !== input.commitSha?.toLowerCase()) {
            const error = new Error('Active source lease no longer matches the persisted SHA.')
            error.code = 'STALE_LEASE'
            throw error
          }
        }
        : undefined
      const provisioned = await this.#supervisor.provision(
        structuredClone(input),
        { ...correlation, executionId: record.executionId },
        { signal, assertLease },
      )
      record.supervisorExecution = validateSupervisorExecution(provisioned, record)
      record.cleanupRequired = true
      record.providerExecutionId = record.supervisorExecution.providerExecutionId
      await this.#executionStore?.recordProviderExecution({
        ...correlation,
        provider: this.#providerName,
        executionId: record.executionId,
        providerExecutionId: record.providerExecutionId,
      })
      await assertLease?.()
      if (record.cancelRequested || signal?.aborted) {
        await this.#supervisor.terminate(
          record.supervisorExecution,
          { ...correlation, executionId: record.executionId },
        )
        record.status = 'CANCELLED'
        record.completedAt = this.#timestamp()
        record.result = createFailureResult(record, 'Isolated VM execution was cancelled.', 'DETERMINISTIC', 'CANCELLED')
        await this.#persist(record, { cleanupState: 'PENDING' })
        return handle(record)
      }
      await this.#supervisor.start(
        record.supervisorExecution,
        { ...correlation, executionId: record.executionId },
      )
      record.status = 'RUNNING'
      await this.#persist(record, { cleanupState: 'PENDING' })
    } catch (error) {
      record.cleanupRequired = error?.cleanupRequired === true
      record.cleanupFailed = error?.cleanupFailed === true
      if (error?.code === 'EXECUTION_TIMEOUT') {
        record.status = 'TIMED_OUT'
        record.completedAt = this.#timestamp()
        record.result = createFailureResult(
          record,
          'Isolated build exceeded its execution timeout.',
          'DETERMINISTIC',
          'BUILD_TIMEOUT',
        )
      } else if (record.cancelRequested || signal?.aborted) {
        record.status = 'CANCELLED'
        record.completedAt = this.#timestamp()
        record.result = createFailureResult(record, 'Isolated VM execution was cancelled.', 'DETERMINISTIC', 'CANCELLED')
      } else {
        const unavailable = error?.message?.startsWith('RUNTIME_UNAVAILABLE')
          ? error.message.slice(0, MAX_ERROR_BYTES)
          : ISOLATED_EXECUTOR_UNAVAILABLE_MESSAGE
        this.#fail(record, unavailable, error?.retryable === true
          ? 'TRANSIENT_INFRASTRUCTURE'
          : 'DETERMINISTIC')
      }
      await this.#persist(record, {
        cleanupState: record.cleanupFailed ? 'FAILED' : 'PENDING',
      })
    }
    return handle(record)
  }

  async getStatus(executionId) {
    const record = this.#get(executionId)
    return {
      executionId: record.executionId,
      deploymentId: record.deploymentId,
      jobId: record.jobId,
      leaseGeneration: record.leaseGeneration,
      status: record.status,
      cleaned: record.cleaned,
    }
  }

  async *streamProgress(executionId, cursor = 0) {
    const record = this.#get(executionId)
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > record.progress.length) {
      throw new Error('Progress cursor is invalid.')
    }
    if (!record.monitorComplete && record.status === 'RUNNING'
      && typeof this.#supervisor.monitor === 'function') {
      await this.#monitor(record)
    }
    for (const event of record.progress) {
      if (event.sequence > cursor) yield structuredClone(event)
    }
  }

  async collectResult(executionId) {
    const record = this.#get(executionId)
    if (!record.result) {
      if (!record.monitorComplete && record.status === 'RUNNING'
        && typeof this.#supervisor.monitor === 'function') {
        await this.#monitor(record)
      }
      if (!record.result) this.#fail(record, ISOLATED_EXECUTOR_UNAVAILABLE_MESSAGE)
    }
    if (Buffer.byteLength(JSON.stringify(record.result), 'utf8') > MAX_RESULT_BYTES) {
      throw new Error('Isolated executor result exceeds the allowed size.')
    }
    return structuredClone(record.result)
  }

  async cancel(executionId) {
    const record = this.#get(executionId)
    if (record.status === 'CANCELLED') return true
    if (TERMINAL_STATUSES.has(record.status)) return false
    await this.#supervisor.terminate(
      record.supervisorExecution ?? { executionId: record.executionId },
      correlationFrom(record),
    )
    record.status = 'CANCELLED'
    record.completedAt = this.#timestamp()
    record.result = createFailureResult(record, 'Isolated VM execution was cancelled.', 'DETERMINISTIC', 'CANCELLED')
    await this.#persist(record, { cleanupState: 'PENDING' })
    return true
  }

  async cleanup(executionId) {
    const record = this.#get(executionId)
    if (record.cleaned) return true
    try {
      if (record.supervisorExecution || record.cleanupRequired) {
        await this.#supervisor.cleanup(
          record.supervisorExecution ?? { executionId: record.executionId },
          correlationFrom(record),
        )
      }
    } catch {
      await this.#persist(record, {
        cleanupState: 'FAILED',
        error: 'Isolated runtime cleanup failed; reconciliation is required.',
      })
      throw new Error('Isolated runtime cleanup failed; reconciliation is required.')
    }
    record.cleaned = true
    record.cleanupRequired = false
    record.cleanupFailed = false
    await this.#persist(record, { cleanupState: 'CLEANED' })
    record.signal?.removeEventListener('abort', record.abortHandler)
    return true
  }

  async #monitor(record) {
    if (record.monitorTask) return record.monitorTask
    record.monitorTask = (async () => {
      try {
        const snapshot = await this.#supervisor.monitor(
          record.supervisorExecution,
          correlationFrom(record),
        )
        if (!snapshot || !['COMPLETED', 'FAILED', 'CANCELLED', 'RUNNING'].includes(snapshot.state)
          || !Array.isArray(snapshot.progress) || snapshot.progress.length > 1000) {
          throw new Error('Isolated supervisor returned an invalid execution status.')
        }
        if (snapshot.result !== null) {
          const validated = validateExecutionResult(snapshot.result, {
            deploymentId: record.deploymentId,
            jobId: record.jobId,
            commitSha: record.commitSha,
            buildMode: record.buildMode,
          })
          record.result = structuredClone(validated)
          record.status = validated.outcome === 'SUCCESS'
            ? 'SUCCEEDED'
            : validated.failureKind === 'TRANSIENT_INFRASTRUCTURE' ? 'RETRYABLE_FAILURE' : 'FAILED'
          record.completedAt = validated.completedAt
        }
        record.monitorComplete = snapshot.state !== 'RUNNING' || snapshot.result !== null
        for (const [index, progress] of snapshot.progress.entries()) {
          const event = {
            schemaVersion: 1,
            executionId: record.executionId,
            deploymentId: record.deploymentId,
            jobId: record.jobId,
            leaseGeneration: record.leaseGeneration,
            stage: progress.stage,
            message: progress.message,
            sequence: index + 1,
          }
          validateProgressEvent(event, {
            executionId: record.executionId,
            deploymentId: record.deploymentId,
            jobId: record.jobId,
            leaseGeneration: record.leaseGeneration,
          }, { sequence: index + 1 })
          if (Buffer.byteLength(event.message, 'utf8') > MAX_LOG_LINE_BYTES) {
            throw new Error('Isolated supervisor progress exceeded its size limit.')
          }
          record.progress.push(event)
        }
        if (snapshot.state === 'CANCELLED') {
          record.status = 'CANCELLED'
          record.completedAt ??= this.#timestamp()
          record.result ??= createFailureResult(record, 'Isolated VM execution was cancelled.', 'DETERMINISTIC', 'CANCELLED')
        } else if (snapshot.state === 'FAILED' && !record.result) {
          this.#fail(record, ISOLATED_EXECUTOR_UNAVAILABLE_MESSAGE)
        }
        await this.#persist(record, { cleanupState: 'PENDING' })
      } catch {
        this.#fail(record, ISOLATED_EXECUTOR_UNAVAILABLE_MESSAGE)
        record.monitorComplete = true
        await this.#persist(record, { cleanupState: 'PENDING' })
      }
    })()
    try {
      await record.monitorTask
    } finally {
      record.monitorTask = null
    }
  }

  async #persist(record, { cleanupState, error = record.result?.error ?? null }) {
    if (!this.#executionStore) return
    await this.#executionStore.updateExecution({
      jobId: record.jobId,
      deploymentId: record.deploymentId,
      leaseGeneration: record.leaseGeneration,
      provider: this.#providerName,
      executionId: record.executionId,
      providerExecutionId: record.providerExecutionId,
      status: mapDurableStatus(record.status),
      cleanupState,
      result: record.result,
      error,
    })
  }

  #fail(record, message, failureKind = 'DETERMINISTIC') {
    if (record.result) return
    record.status = 'FAILED'
    record.completedAt = this.#timestamp()
    record.result = createFailureResult(record, message, failureKind)
  }

  #timestamp() {
    const value = this.clock()
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new Error('Isolated executor clock returned an invalid timestamp.')
    }
    return value.toISOString()
  }

  #get(executionId) {
    const record = this.#executions.get(executionId)
    if (!record) throw new Error('Isolated VM execution was not found.')
    return record
  }
}

export function createIsolatedVmExecutionProvider(options) {
  return new IsolatedVmExecutionProvider(options)
}

function createFailureResult(record, message, failureKind, failureCode = 'EXECUTION_FAILED') {
  const error = message.slice(0, MAX_ERROR_BYTES)
  return {
    schemaVersion: EXECUTION_RESULT_VERSION,
    deploymentId: record.deploymentId,
    jobId: record.jobId,
    commitSha: record.commitSha,
    outcome: 'FAILURE',
    failureKind,
    detectedStack: null,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    logs: [{ level: 'error', message: error }],
    error,
    artifact: null,
    failureCode,
  }
}

function correlationFrom(record) {
  return {
    deploymentId: record.deploymentId,
    jobId: record.jobId,
    leaseGeneration: record.leaseGeneration,
    executionId: record.executionId,
  }
}

function correlationKey({ deploymentId, jobId, leaseGeneration }) {
  return `${deploymentId}:${jobId}:${leaseGeneration}`
}

function providerExecutionId(correlation) {
  const identity = correlationKey(correlation)
  return `ivm_${createHash('sha256').update(identity).digest('hex')}`
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

function handle(record) {
  return { executionId: record.executionId, status: record.status }
}

function mapDurableStatus(status) {
  return status === 'ACCEPTED' ? 'PROVISIONED' : status
}

function validateSupervisorExecution(execution, expected) {
  if (!execution || typeof execution !== 'object' || Array.isArray(execution)
    || Object.keys(execution).sort().join(',')
      !== 'deploymentId,executionId,jobId,leaseGeneration,providerExecutionId') {
    throw new Error('Isolated VM supervisor returned an invalid execution correlation.')
  }
  if (execution.deploymentId !== expected.deploymentId
    || execution.executionId !== expected.executionId
    || execution.jobId !== expected.jobId
    || execution.leaseGeneration !== expected.leaseGeneration
    || typeof execution.providerExecutionId !== 'string'
    || execution.providerExecutionId.length < 1
    || execution.providerExecutionId.length > 200) {
    throw new Error('Isolated VM supervisor returned mismatched execution correlation.')
  }
  return structuredClone(execution)
}
