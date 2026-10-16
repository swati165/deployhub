import { validateExecutionResult } from './executors/ExecutionProvider.js'

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
const MAX_EXECUTIONS_PER_PASS = 500

export async function reconcileExecutions(store, supervisor, { limit = 100, now = new Date() } = {}) {
  if (!store || typeof store.listRecoverableExecutions !== 'function'
    || typeof store.updateExecution !== 'function') {
    throw new TypeError('Execution reconciliation store is invalid.')
  }
  if (!supervisor || typeof supervisor.reconcileAbandonedExecutions !== 'function'
    || typeof supervisor.cleanup !== 'function' || typeof supervisor.terminate !== 'function') {
    throw new TypeError('Execution reconciliation supervisor is invalid.')
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_EXECUTIONS_PER_PASS) {
    throw new Error('Execution reconciliation limit is invalid.')
  }
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error('Execution reconciliation clock is invalid.')
  }

  const rows = await store.listRecoverableExecutions({ limit })
  const snapshots = await supervisor.reconcileAbandonedExecutions()
  if (!Array.isArray(snapshots) || snapshots.length > MAX_EXECUTIONS_PER_PASS) {
    throw new Error('Supervisor reconciliation response is invalid or too large.')
  }
  const validated = snapshots.map(validateSnapshot)
  const rowsByExecution = new Map(rows.map((row) => [row.executor_execution_id, row]))
  const duplicateIds = findDuplicateProviderIds(validated, rowsByExecution)
  const seen = new Set()
  const outcomes = []

  for (const snapshot of validated) {
    const row = rowsByExecution.get(snapshot.executionId)
    if (row && correlationMatches(row, snapshot)) {
      seen.add(snapshot.executionId)
      if (duplicateIds.has(`${row.execution_provider}:${snapshot.providerExecutionId}`)) {
        outcomes.push({ executionId: snapshot.executionId, outcome: 'DUPLICATE_PROVIDER_EXECUTION_ID' })
        continue
      }
    }
    if (!row || !correlationMatches(row, snapshot)
      || (row.provider_execution_id && row.provider_execution_id !== snapshot.providerExecutionId)) {
      if (snapshot.state === 'CLEANED' || snapshot.cleanupState === 'CLEANED') {
        outcomes.push({ executionId: snapshot.executionId, outcome: 'ALREADY_CLEANED' })
        continue
      }
      const cleaned = await cleanupOrphan(supervisor, snapshot)
      outcomes.push({
        executionId: snapshot.executionId,
        outcome: cleaned ? 'ORPHAN_CLEANED' : 'ORPHAN_CLEANUP_FAILED',
      })
      continue
    }

    let status = row.executor_status
    let result = null
    let error = snapshot.error
    let cleanupState = snapshot.cleanupState === 'CLEANED' ? 'CLEANED' : 'PENDING'
    let current = snapshot
    const stale = Number(row.lease_generation) !== snapshot.leaseGeneration
      || row.job_state !== 'RUNNING'
      || !row.lease_expires_at
      || new Date(row.lease_expires_at).getTime() <= now.getTime()

    try {
      if ((stale || current.state === 'ABANDONED') && !isTerminalState(current.state)) {
        await supervisor.terminate(executionRef(current), correlation(current))
        status = stale ? 'CANCELLED' : 'ABANDONED'
        error = stale
          ? 'Execution was stopped because its worker lease is stale.'
          : 'Abandoned execution was stopped during reconciliation.'
        current = { ...current, state: 'CANCELLED' }
      } else if (current.state === 'PROVISIONED' || current.state === 'STARTED') {
        await supervisor.start(executionRef(current), correlation(current))
        current = validateSnapshot(await supervisor.monitor(executionRef(current), correlation(current)))
        status = mapState(current.state)
      } else if (current.state === 'COMPLETED') {
        result = validateAndSanitizeResult(current.result, row)
        status = result.outcome === 'SUCCESS'
          ? 'SUCCEEDED'
          : result.failureKind === 'TRANSIENT_INFRASTRUCTURE' ? 'RETRYABLE_FAILURE' : 'FAILED'
        error = result.error
      } else if (current.state === 'CLEANED' || current.state === 'CLEANUP_PENDING') {
        status = row.executor_status
      } else {
        status = mapState(current.state) ?? status
      }
    } catch (caught) {
      status = 'FAILED'
      result = null
      error = safeError(caught)
      current = { ...current, state: 'FAILED' }
    }

    const shouldCleanup = stale || isTerminalState(current.state)
    if (shouldCleanup && current.state !== 'CLEANED') {
      try {
        await supervisor.cleanup(executionRef(current), correlation(current))
        cleanupState = 'CLEANED'
      } catch (caught) {
        cleanupState = 'FAILED'
        error = safeError(caught)
      }
    } else if (current.state === 'CLEANED') {
      cleanupState = 'CLEANED'
    }

    if (typeof store.recordProviderExecution === 'function' && !row.provider_execution_id) {
      await store.recordProviderExecution({
        jobId: row.job_id,
        deploymentId: row.deployment_id,
        leaseGeneration: Number(row.executor_lease_generation),
        provider: row.execution_provider,
        executionId: row.executor_execution_id,
        providerExecutionId: snapshot.providerExecutionId,
      })
      row.provider_execution_id = snapshot.providerExecutionId
    }
    await store.updateExecution({
      jobId: row.job_id,
      deploymentId: row.deployment_id,
      leaseGeneration: Number(row.executor_lease_generation),
      provider: row.execution_provider,
      executionId: row.executor_execution_id,
      providerExecutionId: row.provider_execution_id ?? snapshot.providerExecutionId,
      status,
      cleanupState,
      result,
      error,
    })
    outcomes.push({
      executionId: snapshot.executionId,
      outcome: cleanupState === 'FAILED' ? 'CLEANUP_PENDING' : status,
    })
  }

  for (const row of rows) {
    if (seen.has(row.executor_execution_id)) continue
    await store.updateExecution({
      jobId: row.job_id,
      deploymentId: row.deployment_id,
      leaseGeneration: Number(row.executor_lease_generation),
      provider: row.execution_provider,
      executionId: row.executor_execution_id,
      providerExecutionId: row.provider_execution_id ?? null,
      status: 'ABANDONED',
      cleanupState: 'FAILED',
      error: 'Persisted execution was not found by the supervisor; manual cleanup may be required.',
    })
    outcomes.push({ executionId: row.executor_execution_id, outcome: 'ABANDONED' })
  }
  return outcomes
}

function validateSnapshot(value) {
  const expectedKeys = [
    'cleanupState',
    'deploymentId',
    'error',
    'executionId',
    'jobId',
    'leaseGeneration',
    'providerExecutionId',
    'result',
    'state',
  ]
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== expectedKeys.join(',')) {
    throw new Error('Supervisor returned an invalid execution snapshot.')
  }
  if (typeof value.deploymentId !== 'string' || typeof value.jobId !== 'string'
    || !Number.isSafeInteger(value.leaseGeneration) || value.leaseGeneration < 1
    || typeof value.executionId !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(value.executionId)
    || typeof value.providerExecutionId !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(value.providerExecutionId)
    || !SUPERVISOR_STATES.has(value.state)
    || !['PENDING', 'FAILED', 'CLEANED'].includes(value.cleanupState)
    || (value.error !== null && typeof value.error !== 'string')
    || (value.result !== null && (typeof value.result !== 'object' || Array.isArray(value.result)))) {
    throw new Error('Supervisor returned an invalid execution snapshot.')
  }
  if ((value.error && Buffer.byteLength(value.error, 'utf8') > 1000)
    || (!['COMPLETED', 'CLEANED', 'CLEANUP_PENDING'].includes(value.state) && value.result !== null)) {
    throw new Error('Supervisor returned an oversized error or unexpected result.')
  }
  if (value.result !== null) {
    let resultBytes
    try {
      resultBytes = Buffer.byteLength(JSON.stringify(value.result), 'utf8')
    } catch {
      throw new Error('Supervisor returned an invalid execution result.')
    }
    if (resultBytes > 128 * 1024) throw new Error('Supervisor returned an oversized execution result.')
  }
  return value
}

function correlationMatches(row, snapshot) {
  return row.deployment_id === snapshot.deploymentId
    && row.job_id === snapshot.jobId
    && Number(row.executor_lease_generation) === snapshot.leaseGeneration
    && row.execution_provider
}

function findDuplicateProviderIds(snapshots, rowsByExecution) {
  const counts = new Map()
  for (const snapshot of snapshots) {
    const provider = rowsByExecution.get(snapshot.executionId)?.execution_provider ?? 'unknown'
    const key = `${provider}:${snapshot.providerExecutionId}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return new Set([...counts].filter(([, count]) => count > 1).map(([key]) => key))
}

function validateAndSanitizeResult(result, row) {
  const validated = validateExecutionResult(result, {
    deploymentId: row.deployment_id,
    jobId: row.job_id,
    commitSha: row.source_commit_sha ?? null,
    buildMode: 'FAKE_ONLY',
  })
  return {
    ...validated,
    error: validated.error === null ? null : redact(validated.error),
    logs: validated.logs.map((log) => ({ ...log, message: redact(log.message) })),
  }
}

async function cleanupOrphan(supervisor, snapshot) {
  try {
    if (!isTerminalState(snapshot.state)) {
      await supervisor.terminate(executionRef(snapshot), correlation(snapshot))
    }
    await supervisor.cleanup(executionRef(snapshot), correlation(snapshot))
    return true
  } catch {
    return false
  }
}

function executionRef(snapshot) {
  return { providerExecutionId: snapshot.providerExecutionId }
}

function correlation(snapshot) {
  return {
    deploymentId: snapshot.deploymentId,
    jobId: snapshot.jobId,
    leaseGeneration: snapshot.leaseGeneration,
    executionId: snapshot.executionId,
  }
}

function isTerminalState(state) {
  return ['COMPLETED', 'FAILED', 'CANCELLED', 'CLEANUP_PENDING', 'CLEANED'].includes(state)
}

function mapState(state) {
  return ({
    PROVISIONED: 'PROVISIONED',
    STARTED: 'PROVISIONED',
    RUNNING: 'RUNNING',
    COMPLETED: 'SUCCEEDED',
    FAILED: 'FAILED',
    CANCELLED: 'CANCELLED',
    CLEANUP_PENDING: 'ABANDONED',
    ABANDONED: 'ABANDONED',
    CLEANED: 'CANCELLED',
  })[state]
}

function safeError(error) {
  return redact(error instanceof Error ? error.message : 'Supervisor reconciliation failed.')
}

function redact(message) {
  return message
    .replace(/\b(token|password|secret|authorization|api[_-]?key)\s*[:=]\s*\S+/gi, '$1=[REDACTED]')
    .slice(0, 1000)
}
