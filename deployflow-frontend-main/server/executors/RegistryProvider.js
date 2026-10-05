import { createHash } from 'node:crypto'

export const REGISTRY_PROVIDER_API_VERSION = 1
export const REGISTRY_RESULT_VERSION = 1
export const REGISTRY_FAILURE_CODES = Object.freeze([
  'REGISTRY_NOT_CONFIGURED',
  'REGISTRY_CREDENTIALS_UNAVAILABLE',
  'REGISTRY_AUTHENTICATION_FAILED',
  'REGISTRY_UNAUTHORIZED_REPOSITORY',
  'REGISTRY_UNAVAILABLE',
  'LOCAL_IMAGE_NOT_FOUND',
  'REGISTRY_PUSH_FAILED',
  'REGISTRY_DIGEST_UNAVAILABLE',
  'REGISTRY_CONFIGURATION_INVALID',
  'STALE_LEASE_GENERATION',
  'DUPLICATE_EXECUTION',
])

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i
const DIGEST = /^sha256:[0-9a-f]{64}$/i
const PROVIDER = /^[a-z0-9][a-z0-9._-]{0,63}$/i

export class RegistryProviderError extends Error {
  constructor(code, message, { retryable = false } = {}) {
    if (!REGISTRY_FAILURE_CODES.includes(code)) throw new TypeError('Registry failure code is invalid.')
    super(message)
    this.name = 'RegistryProviderError'
    this.code = code
    this.retryable = retryable
  }
}

export class RegistryProvider {
  constructor() {
    if (new.target === RegistryProvider) throw new TypeError('RegistryProvider is an interface.')
    this.apiVersion = REGISTRY_PROVIDER_API_VERSION
  }

  async push() {
    throw new Error('RegistryProvider.push() is not implemented.')
  }
}

export function validateRegistryPushRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || Object.keys(request).sort().join(',') !== [
      'commitSha',
      'deploymentId',
      'executionId',
      'jobId',
      'leaseGeneration',
      'localImage',
    ].sort().join(',')) {
    throw new RegistryProviderError('REGISTRY_CONFIGURATION_INVALID', 'Registry push request is invalid.')
  }
  if (!UUID.test(request.deploymentId) || !UUID.test(request.jobId)
    || typeof request.executionId !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(request.executionId)
    || !Number.isSafeInteger(request.leaseGeneration) || request.leaseGeneration < 1
    || typeof request.commitSha !== 'string' || !SHA.test(request.commitSha)) {
    throw new RegistryProviderError('REGISTRY_CONFIGURATION_INVALID', 'Registry push correlation is invalid.')
  }
  const image = request.localImage
  if (!image || typeof image !== 'object' || Array.isArray(image)
    || Object.keys(image).sort().join(',') !== 'digest,format,reference'
    || image.format !== 'OCI_IMAGE'
    || typeof image.reference !== 'string'
    || !/^deployhub-app:[a-f0-9]{24}$/i.test(image.reference)
    || typeof image.digest !== 'string' || !DIGEST.test(image.digest)) {
    throw new RegistryProviderError('LOCAL_IMAGE_NOT_FOUND', 'A valid local application image is required.')
  }
  return request
}

export function validateRegistryPushResult(result, expected, destination = null) {
  const keys = [
    'schemaVersion',
    'provider',
    'deploymentId',
    'jobId',
    'executionId',
    'leaseGeneration',
    'commitSha',
    'localImageReference',
    'localImageDigest',
    'registry',
    'repository',
    'tag',
    'registryDigest',
    'image',
    'pushedAt',
  ]
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || Object.keys(result).sort().join(',') !== keys.sort().join(',')) {
    throw new RegistryProviderError('REGISTRY_PUSH_FAILED', 'Registry provider returned invalid metadata.')
  }
  if (result.schemaVersion !== REGISTRY_RESULT_VERSION
    || !PROVIDER.test(result.provider)
    || result.deploymentId !== expected.deploymentId
    || result.jobId !== expected.jobId
    || result.executionId !== expected.executionId
    || result.leaseGeneration !== expected.leaseGeneration
    || result.commitSha?.toLowerCase() !== expected.commitSha?.toLowerCase()
    || result.localImageReference !== expected.localImage.reference
    || result.localImageDigest?.toLowerCase() !== expected.localImage.digest?.toLowerCase()
    || !validRegistryHost(result.registry)
    || !validRepository(result.repository)
    || (destination && (result.registry !== destination.registry
      || result.repository !== destination.repository
      || result.provider !== destination.provider))
    || !/^dh-[a-f0-9]{64}$/.test(result.tag)
    || !DIGEST.test(result.registryDigest)
    || result.image !== `${result.registry}/${result.repository}@${result.registryDigest}`
    || !validTimestamp(result.pushedAt)) {
    throw new RegistryProviderError('REGISTRY_PUSH_FAILED', 'Registry provider metadata did not match the execution.')
  }
  return result
}

export function createRegistryTag({ deploymentId, executionId, commitSha }) {
  if (!UUID.test(deploymentId) || typeof executionId !== 'string'
    || !/^[A-Za-z0-9._:-]{1,200}$/.test(executionId)
    || typeof commitSha !== 'string' || !SHA.test(commitSha)) {
    throw new RegistryProviderError('REGISTRY_CONFIGURATION_INVALID', 'Registry tag correlation is invalid.')
  }
  const hash = createHash('sha256')
    .update(`${deploymentId}\n${executionId}\n${commitSha.toLowerCase()}`)
    .digest('hex')
  return `dh-${hash}`
}

export function validRegistryHost(value) {
  return typeof value === 'string' && value.length <= 253
    && /^(?=.{1,253}$)(?:localhost|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*)(?::[0-9]{1,5})?$/i.test(value)
}

export function validRepository(value) {
  return typeof value === 'string' && value.length <= 255
    && /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/i.test(value)
}

function validTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return false
  return Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value
}
