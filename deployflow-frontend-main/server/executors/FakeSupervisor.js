const SUPERVISOR_STATES = new Set([
  'PROVISIONED',
  'STARTED',
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'CLEANUP_PENDING',
  'ABANDONED',
  'CLEANED',
])
const MAX_EXECUTIONS = 1000

export class FakeSupervisor {
  #executions = new Map()
  #cleanupFailures

  constructor({ cleanupFailures = 0 } = {}) {
    if (!Number.isSafeInteger(cleanupFailures) || cleanupFailures < 0) {
      throw new TypeError('Fake supervisor cleanup failure count is invalid.')
    }
    this.#cleanupFailures = cleanupFailures
  }

  async provision(input, correlation) {
    validateCorrelation(correlation)
    const existing = this.#executions.get(correlation.executionId)
    if (existing) {
      if (!sameCorrelation(existing, correlation)) throw new Error('Fake supervisor execution ID correlation conflict.')
      return publicExecution(existing)
    }
    if (this.#executions.size >= MAX_EXECUTIONS) throw new Error('Fake supervisor execution limit reached.')
    const record = {
      ...correlation,
      providerExecutionId: `fake_${correlation.executionId}`,
      state: 'PROVISIONED',
      cleanupState: 'PENDING',
      inputFingerprint: JSON.stringify(input),
      result: null,
      error: null,
    }
    this.#executions.set(record.executionId, record)
    return publicExecution(record)
  }

  async start(execution, correlation) {
    const record = this.#get(execution, correlation)
    if (record.state === 'PROVISIONED' || record.state === 'STARTED') record.state = 'RUNNING'
    return publicExecution(record)
  }

  async monitor(execution, correlation) {
    const record = this.#get(execution, correlation)
    return snapshot(record)
  }

  async terminate(execution, correlation) {
    const record = this.#get(execution, correlation)
    if (!['COMPLETED', 'FAILED', 'CLEANED'].includes(record.state)) {
      record.state = 'CANCELLED'
    }
    return true
  }

  async cleanup(execution, correlation) {
    const record = this.#get(execution, correlation)
    if (record.cleanupState === 'CLEANED') return true
    if (this.#cleanupFailures > 0) {
      this.#cleanupFailures -= 1
      record.cleanupState = 'FAILED'
      record.state = 'CLEANUP_PENDING'
      throw new Error('Synthetic cleanup failure.')
    }
    record.cleanupState = 'CLEANED'
    record.state = 'CLEANED'
    return true
  }

  async reconcileAbandonedExecutions() {
    return [...this.#executions.values()].map(snapshot)
  }

  setState(executionId, state, { result = null, error = null } = {}) {
    if (!SUPERVISOR_STATES.has(state)) throw new Error('Fake supervisor state is invalid.')
    const record = this.#executions.get(executionId)
    if (!record) throw new Error('Fake supervisor execution was not found.')
    record.state = state
    record.result = result === null ? null : structuredClone(result)
    record.error = typeof error === 'string' ? error.slice(0, 1000) : null
    if (state === 'CLEANED') record.cleanupState = 'CLEANED'
    if (state === 'CLEANUP_PENDING') record.cleanupState = 'FAILED'
  }

  addOrphan(correlation, { state = 'ABANDONED' } = {}) {
    validateCorrelation(correlation)
    if (!SUPERVISOR_STATES.has(state) || this.#executions.has(correlation.executionId)) {
      throw new Error('Fake supervisor orphan is invalid.')
    }
    this.#executions.set(correlation.executionId, {
      ...correlation,
      providerExecutionId: `fake_${correlation.executionId}`,
      state,
      cleanupState: 'PENDING',
      inputFingerprint: null,
      result: null,
      error: null,
    })
  }

  #get(execution, correlation) {
    validateCorrelation(correlation)
    const record = this.#executions.get(correlation.executionId)
    if (!record || !sameCorrelation(record, correlation)
      || execution?.providerExecutionId !== record.providerExecutionId) {
      throw new Error('Fake supervisor execution correlation does not match.')
    }
    return record
  }
}

function validateCorrelation(correlation) {
  if (!correlation || typeof correlation !== 'object'
    || typeof correlation.deploymentId !== 'string'
    || typeof correlation.jobId !== 'string'
    || !Number.isSafeInteger(correlation.leaseGeneration) || correlation.leaseGeneration < 1
    || typeof correlation.executionId !== 'string' || correlation.executionId.length < 1
    || correlation.executionId.length > 200) {
    throw new Error('Fake supervisor correlation is invalid.')
  }
}

function sameCorrelation(left, right) {
  return left.deploymentId === right.deploymentId
    && left.jobId === right.jobId
    && left.leaseGeneration === right.leaseGeneration
    && left.executionId === right.executionId
}

function publicExecution(record) {
  return {
    deploymentId: record.deploymentId,
    executionId: record.executionId,
    jobId: record.jobId,
    leaseGeneration: record.leaseGeneration,
    providerExecutionId: record.providerExecutionId,
  }
}

function snapshot(record) {
  return {
    ...publicExecution(record),
    state: record.state,
    cleanupState: record.cleanupState,
    result: record.result === null ? null : structuredClone(record.result),
    error: record.error,
  }
}
