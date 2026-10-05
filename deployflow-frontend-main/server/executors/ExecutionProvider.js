import { DEPLOYMENT_STAGES } from '../deploymentStates.js'
import { validateBranch, validateGitHubUrl } from '../validation.js'

export const EXECUTION_INPUT_VERSION = 1
export const EXECUTION_RESULT_VERSION = 2
export const EXECUTION_PROGRESS_VERSION = 1

export const EXECUTION_SCENARIOS = Object.freeze([
  'SUCCESS',
  'DETERMINISTIC_FAILURE',
  'VALIDATION_FAILURE',
  'CLONE_FAILURE',
  'BUILD_FAILURE',
  'TRANSIENT_FAILURE',
  'TIMEOUT',
  'MALFORMED_RESULT',
  'OVERSIZED_RESULT',
  'CLEANUP_FAILURE',
])

export const MAX_LOG_BYTES = 64 * 1024
export const MAX_ERROR_BYTES = 1000
export const MAX_LOG_LINE_BYTES = 4096
export const MAX_PROGRESS_EVENTS = 1000
export const MAX_PROGRESS_BYTES = 64 * 1024
export const MAX_RESULT_BYTES = 128 * 1024

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const COMMIT_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i
const EXECUTOR_STAGES = new Set(DEPLOYMENT_STAGES.filter((stage) => stage !== 'QUEUED' && stage !== 'RUNNING'))
const EXECUTION_STATUSES = new Set([
  'ACCEPTED',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'RETRYABLE_FAILURE',
  'TIMED_OUT',
  'CANCELLED',
])
const BUILD_MODES = new Set(['FAKE_ONLY', 'NODE_NPM_OFFLINE'])
const NETWORK_POLICIES = new Set(['NO_NETWORK', 'EGRESS_PROXY'])
const ARTIFACT_FORMATS = new Set(['FAKE_BUILD_RESULT', 'OCI_IMAGE'])
const INPUT_KEYS = new Set([
  'schemaVersion',
  'deploymentId',
  'jobId',
  'leaseGeneration',
  'repository',
  'requestedBranch',
  'commitSha',
  'buildMode',
  'resourcePolicy',
  'networkPolicy',
])
const POLICY_KEYS = new Set(['cpuMilli', 'memoryMb', 'diskMb', 'pidLimit', 'timeoutMs', 'logBytes'])
const RESULT_KEYS = new Set([
  'schemaVersion',
  'deploymentId',
  'jobId',
  'commitSha',
  'outcome',
  'failureKind',
  'detectedStack',
  'startedAt',
  'completedAt',
  'logs',
  'error',
  'artifact',
  'failureCode',
])
const RESULT_KEYS_V1 = new Set([...RESULT_KEYS].filter((key) => key !== 'failureCode'))
const FAILURE_CODES = new Set([
  'BUILD_FAILED',
  'BUILD_TIMEOUT',
  'CANCELLED',
  'DEPENDENCY_CACHE_UNAVAILABLE',
  'EXECUTION_FAILED',
  'IMAGE_BUILD_FAILED',
  'OUTPUT_LIMIT_EXCEEDED',
  'RUNTIME_UNAVAILABLE',
  'SOURCE_SHA_MISMATCH',
  'STALE_LEASE',
  'UNSUPPORTED_BUILD_CONFIGURATION',
])
const LOG_KEYS = new Set(['level', 'message'])
const ARTIFACT_KEYS = new Set(['format', 'reference', 'digest'])
const PROGRESS_KEYS = new Set([
  'schemaVersion',
  'executionId',
  'deploymentId',
  'jobId',
  'leaseGeneration',
  'stage',
  'message',
  'sequence',
])
const UUID_ERROR = 'Execution contract contains an invalid identifier.'

export class ExecutionProviderError extends Error {
  constructor(message, { retryable = false } = {}) {
    super(message)
    this.name = 'ExecutionProviderError'
    this.retryable = retryable
  }
}

export class ExecutionProvider {
  async start() {
    throw new Error('ExecutionProvider.start() is not implemented.')
  }

  async getStatus() {
    throw new Error('ExecutionProvider.getStatus() is not implemented.')
  }

  streamProgress() {
    throw new Error('ExecutionProvider.streamProgress() is not implemented.')
  }

  async collectResult() {
    throw new Error('ExecutionProvider.collectResult() is not implemented.')
  }

  async cancel() {
    throw new Error('ExecutionProvider.cancel() is not implemented.')
  }

  async cleanup() {
    throw new Error('ExecutionProvider.cleanup() is not implemented.')
  }
}

export function validateExecutionInput(input) {
  assertObject(input, 'Execution input must be an object.')
  assertExactKeys(input, INPUT_KEYS, 'Execution input contains unsupported fields.')
  if (input.schemaVersion !== EXECUTION_INPUT_VERSION) throw new Error('Unsupported execution input schema version.')
  assertUuid(input.deploymentId)
  assertUuid(input.jobId)
  if (!Number.isSafeInteger(input.leaseGeneration) || input.leaseGeneration < 1) {
    throw new Error('Execution input lease generation is invalid.')
  }
  if (typeof input.repository !== 'string' || input.repository.length > 512) {
    throw new Error('Execution input repository is invalid.')
  }
  let normalizedRepository
  try {
    normalizedRepository = validateGitHubUrl(input.repository)
  } catch {
    throw new Error('Execution input repository is invalid.')
  }
  if (normalizedRepository !== input.repository) {
    throw new Error('Execution input repository must use its canonical URL.')
  }
  if (typeof input.requestedBranch !== 'string') {
    throw new Error('Execution input branch is invalid.')
  }
  try {
    validateBranch(input.requestedBranch)
  } catch {
    throw new Error('Execution input branch is invalid.')
  }
  if (input.commitSha !== null
    && (typeof input.commitSha !== 'string' || !COMMIT_SHA_PATTERN.test(input.commitSha))) {
    throw new Error('Execution input commit SHA is invalid.')
  }
  if (!BUILD_MODES.has(input.buildMode)) throw new Error('Execution input build mode is not allowed.')
  assertExactKeys(input.resourcePolicy, POLICY_KEYS, 'Execution resource policy contains unsupported fields.')
  const { cpuMilli, memoryMb, diskMb, pidLimit, timeoutMs, logBytes } = input.resourcePolicy
  if (!boundedInteger(cpuMilli, 100, 4000)
    || !boundedInteger(memoryMb, 128, 8192)
    || !boundedInteger(diskMb, 128, 32768)
    || !boundedInteger(pidLimit, 16, 1024)
    || !boundedInteger(timeoutMs, 1000, 1800000)
    || !boundedInteger(logBytes, 1024, MAX_LOG_BYTES)) {
    throw new Error('Execution resource policy is outside the allowed bounds.')
  }
  if (!NETWORK_POLICIES.has(input.networkPolicy)) throw new Error('Execution network policy is not allowed.')
  return input
}

export function validateLeaseContext(leaseContext, input) {
  assertObject(leaseContext, 'Execution lease context is required.')
  if (leaseContext.id !== input.jobId
    || leaseContext.deployment_id !== input.deploymentId
    || Number(leaseContext.lease_generation) !== input.leaseGeneration
    || typeof leaseContext.worker_id !== 'string'
    || leaseContext.worker_id.length < 1
    || leaseContext.worker_id.length > 200) {
    throw new Error('Execution lease context does not match the input.')
  }
  return leaseContext
}

export function validateExecutionHandle(handle) {
  assertObject(handle, 'Execution provider returned an invalid execution handle.')
  assertExactKeys(handle, new Set(['executionId', 'status']), 'Execution provider returned an invalid execution handle.')
  if (typeof handle.executionId !== 'string'
    || !/^[A-Za-z0-9._:-]{1,200}$/.test(handle.executionId)
    || !EXECUTION_STATUSES.has(handle.status)) {
    throw new Error('Execution provider returned an invalid execution handle.')
  }
  return handle.executionId
}

export function validateExecutionResult(result, expected, { maxLogBytes = MAX_LOG_BYTES } = {}) {
  assertObject(result, 'Execution result must be an object.')
  const versionOne = result.schemaVersion === 1
  if (!versionOne && result.schemaVersion !== EXECUTION_RESULT_VERSION) {
    throw new Error('Unsupported execution result schema version.')
  }
  assertExactKeys(result, versionOne ? RESULT_KEYS_V1 : RESULT_KEYS, 'Execution result contains unsupported fields.')
  if (!Number.isSafeInteger(maxLogBytes) || maxLogBytes < 0 || maxLogBytes > MAX_LOG_BYTES) {
    throw new Error('Execution result log budget is invalid.')
  }
  if (result.deploymentId !== expected.deploymentId || result.jobId !== expected.jobId) {
    throw new Error(UUID_ERROR)
  }
  if (expected.commitSha !== null
    && (typeof expected.commitSha !== 'string' || !COMMIT_SHA_PATTERN.test(expected.commitSha))) {
    throw new Error('Expected execution commit SHA is invalid.')
  }
  if (result.commitSha !== expected.commitSha) throw new Error('Execution result commit SHA does not match the requested commit.')
  if (result.commitSha !== null
    && (typeof result.commitSha !== 'string' || !COMMIT_SHA_PATTERN.test(result.commitSha))) {
    throw new Error('Execution result commit SHA is invalid.')
  }
  if (!['SUCCESS', 'FAILURE'].includes(result.outcome)) throw new Error('Execution result outcome is invalid.')
  if (!['DETERMINISTIC', 'TRANSIENT_INFRASTRUCTURE', null].includes(result.failureKind)) {
    throw new Error('Execution result failure classification is invalid.')
  }
  if (result.outcome === 'SUCCESS' && result.failureKind !== null) {
    throw new Error('Successful execution result cannot include a failure classification.')
  }
  if (result.outcome === 'FAILURE' && result.failureKind === null) {
    throw new Error('Failed execution result requires a failure classification.')
  }
  if (!versionOne) {
    if (result.outcome === 'SUCCESS' && result.failureCode !== null) {
      throw new Error('Successful execution result cannot include a failure code.')
    }
    if (result.outcome === 'FAILURE' && !FAILURE_CODES.has(result.failureCode)) {
      throw new Error('Failed execution result requires a known failure code.')
    }
  }
  if (result.detectedStack !== null
    && (typeof result.detectedStack !== 'string' || result.detectedStack.length > 80
      || !/^[A-Za-z0-9 ._+-]+$/.test(result.detectedStack))) {
    throw new Error('Execution result detected stack is invalid.')
  }
  const startedAt = validTimestamp(result.startedAt)
  const completedAt = validTimestamp(result.completedAt)
  if (completedAt < startedAt) throw new Error('Execution result timestamps are invalid.')
  if (!Array.isArray(result.logs) || result.logs.length > 1000) throw new Error('Execution result logs exceed the allowed count.')
  let logBytes = 0
  for (const log of result.logs) {
    assertObject(log, 'Execution result log entry is invalid.')
    assertExactKeys(log, LOG_KEYS, 'Execution result log entry contains unsupported fields.')
    if (!['info', 'warning', 'error'].includes(log.level) || typeof log.message !== 'string') {
      throw new Error('Execution result log entry is invalid.')
    }
    const bytes = Buffer.byteLength(log.message, 'utf8')
    if (bytes > MAX_LOG_LINE_BYTES) throw new Error('Execution result log line exceeds the allowed size.')
    logBytes += bytes
    if (logBytes > maxLogBytes) throw new Error('Execution result logs exceed the allowed size.')
  }
  if (result.error !== null
    && (typeof result.error !== 'string' || Buffer.byteLength(result.error, 'utf8') > MAX_ERROR_BYTES)) {
    throw new Error('Execution result error exceeds the allowed size.')
  }
  if (result.outcome === 'FAILURE' && !result.error) throw new Error('Failed execution result requires an error message.')
  if (result.outcome === 'SUCCESS' && result.error !== null) throw new Error('Successful execution result cannot include an error.')
  validateArtifact(result.artifact)
  if (result.outcome === 'FAILURE' && result.artifact !== null) {
    throw new Error('Failed execution result cannot include an artifact.')
  }
  if (expected.buildMode === 'FAKE_ONLY' && result.artifact?.format === 'OCI_IMAGE') {
    throw new Error('Fake execution cannot return a container image artifact.')
  }
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_RESULT_BYTES) {
    throw new Error('Execution result exceeds the allowed size.')
  }
  return result
}

export function validateProgressEvent(event, expected, { sequence } = {}) {
  assertObject(event, 'Execution progress event must be an object.')
  assertExactKeys(event, PROGRESS_KEYS, 'Execution progress event contains unsupported fields.')
  if (event.schemaVersion !== EXECUTION_PROGRESS_VERSION) throw new Error('Unsupported execution progress schema version.')
  if (event.executionId !== expected.executionId
    || event.deploymentId !== expected.deploymentId
    || event.jobId !== expected.jobId) {
    throw new Error('Execution progress identifiers do not match the active job.')
  }
  if (event.leaseGeneration !== expected.leaseGeneration) throw new Error('Execution progress lease generation is stale.')
  if (!EXECUTOR_STAGES.has(event.stage)) throw new Error('Execution progress stage is not allowed.')
  if (typeof event.message !== 'string' || Buffer.byteLength(event.message, 'utf8') > MAX_LOG_LINE_BYTES) {
    throw new Error('Execution progress message is invalid or too large.')
  }
  if (!Number.isSafeInteger(event.sequence) || event.sequence < 1
    || (sequence !== undefined && event.sequence !== sequence)) {
    throw new Error('Execution progress sequence is invalid.')
  }
  return event
}

function validateArtifact(artifact) {
  if (artifact === null) return
  assertObject(artifact, 'Execution result artifact is invalid.')
  assertExactKeys(artifact, ARTIFACT_KEYS, 'Execution result artifact contains unsupported fields.')
  if (!ARTIFACT_FORMATS.has(artifact.format)
    || typeof artifact.reference !== 'string'
    || artifact.reference.length < 1
    || artifact.reference.length > 512) {
    throw new Error('Execution result artifact is invalid.')
  }
  if (artifact.format === 'FAKE_BUILD_RESULT') {
    if (!artifact.reference.startsWith('fake://') || artifact.digest !== null) {
      throw new Error('Fake artifact reference is invalid.')
    }
    return
  }
  if (typeof artifact.digest !== 'string' || !/^sha256:[0-9a-f]{64}$/i.test(artifact.digest)) {
    throw new Error('OCI artifact requires an immutable SHA-256 digest.')
  }
}

function assertObject(value, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message)
}

function assertExactKeys(value, allowed, message) {
  assertObject(value, message)
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error(message)
}

function assertUuid(value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw new Error(UUID_ERROR)
}

function validTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) {
    throw new Error('Execution result timestamp is invalid.')
  }
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error('Execution result timestamp is invalid.')
  }
  return parsed
}

function boundedInteger(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum
}
