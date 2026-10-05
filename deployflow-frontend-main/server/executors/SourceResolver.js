import { validateBranch, validateGitHubUrl } from '../validation.js'

export const SOURCE_RESOLUTION_VERSION = 1
export const MAX_GITHUB_RESPONSE_BYTES = 16 * 1024
export const MAX_GITHUB_RESOLUTION_TIMEOUT_MS = 10_000
const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i
const DEFAULT_TIMEOUT_MS = 5_000

export class SourceResolver {
  async resolve() {
    throw new Error('SourceResolver.resolve() is not implemented.')
  }
}

export class GitHubSourceResolver extends SourceResolver {
  #token
  #fetch
  #timeoutMs
  #maxResponseBytes
  #clock

  constructor({
    token = process.env.GITHUB_SOURCE_TOKEN,
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxResponseBytes = MAX_GITHUB_RESPONSE_BYTES,
    clock = () => new Date(),
  } = {}) {
    super()
    if (typeof token !== 'string' || token.length < 1 || token.length > 500
      || /[^\x21-\x7e]/.test(token)) {
      throw new TypeError('GitHub source resolver credentials are missing or invalid.')
    }
    if (typeof fetchImpl !== 'function') throw new TypeError('GitHub source resolver fetch is unavailable.')
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100
      || timeoutMs > MAX_GITHUB_RESOLUTION_TIMEOUT_MS) {
      throw new TypeError('GitHub source resolver timeout is outside the allowed bounds.')
    }
    if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1024
      || maxResponseBytes > MAX_GITHUB_RESPONSE_BYTES) {
      throw new TypeError('GitHub source resolver response limit is outside the allowed bounds.')
    }
    if (typeof clock !== 'function') throw new TypeError('GitHub source resolver clock is invalid.')
    this.#token = token
    this.#fetch = fetchImpl
    this.#timeoutMs = timeoutMs
    this.#maxResponseBytes = maxResponseBytes
    this.#clock = clock
  }

  async resolve(input) {
    validateSourceRequest(input)
    const repositoryUrl = new URL(input.repository)
    const [owner, repositoryWithGit] = repositoryUrl.pathname.split('/').filter(Boolean)
    const repository = repositoryWithGit.replace(/\.git$/i, '')
    const encodedBranch = input.requestedBranch.split('/').map(encodeURIComponent).join('/')
    const endpoint = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/git/ref/heads/${encodedBranch}`
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs)

    try {
      const response = await this.#fetch(endpoint, {
        method: 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.#token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'DeployHub-source-resolver',
        },
        redirect: 'error',
        signal: controller.signal,
      })
      if (!response || response.status !== 200 || !response.body) {
        throw new Error('GitHub source resolution failed.')
      }
      const payload = await readBoundedJson(response.body, this.#maxResponseBytes)
      const commitSha = payload?.object?.type === 'commit' ? payload.object.sha : null
      if (typeof commitSha !== 'string' || !SHA_PATTERN.test(commitSha)) {
        throw new Error('GitHub did not return a pinned commit for the requested branch.')
      }
      const resolvedAt = this.#clock()
      if (!(resolvedAt instanceof Date) || !Number.isFinite(resolvedAt.getTime())) {
        throw new Error('Source resolver returned an invalid timestamp.')
      }
      return {
        schemaVersion: SOURCE_RESOLUTION_VERSION,
        deploymentId: input.deploymentId,
        jobId: input.jobId,
        repository: input.repository,
        requestedBranch: input.requestedBranch,
        commitSha: commitSha.toLowerCase(),
        resolvedAt: resolvedAt.toISOString(),
      }
    } catch {
      throw new Error('Trusted GitHub source resolution failed or returned an invalid commit.')
    } finally {
      clearTimeout(timeout)
    }
  }
}

export class FakeSourceResolver extends SourceResolver {
  #commitSha
  #clock

  constructor({ commitSha = 'a'.repeat(40), clock = () => new Date() } = {}) {
    super()
    this.#commitSha = commitSha
    this.#clock = clock
  }

  async resolve(input) {
    validateSourceRequest(input)
    if (!SHA_PATTERN.test(this.#commitSha)) throw new Error('Fake source resolver SHA is invalid.')
    const resolvedAt = this.#clock()
    if (!(resolvedAt instanceof Date) || !Number.isFinite(resolvedAt.getTime())) {
      throw new Error('Source resolver returned an invalid timestamp.')
    }
    return {
      schemaVersion: SOURCE_RESOLUTION_VERSION,
      deploymentId: input.deploymentId,
      jobId: input.jobId,
      repository: input.repository,
      requestedBranch: input.requestedBranch,
      commitSha: this.#commitSha,
      resolvedAt: resolvedAt.toISOString(),
    }
  }
}

export async function resolveAndPersistSource(resolver, store, input, { leaseGeneration, workerId } = {}) {
  if (!store || typeof store.recordSourceResolution !== 'function'
    || typeof store.getSourceResolution !== 'function') {
    throw new TypeError('Source resolver and execution store are required.')
  }
  if (!Number.isSafeInteger(leaseGeneration) || leaseGeneration < 1) {
    throw new Error('Source resolution lease generation is invalid.')
  }
  if (typeof workerId !== 'string' || workerId.length < 1 || workerId.length > 200) {
    throw new Error('Source resolution worker identity is invalid.')
  }
  validateSourceRequest(input)
  const lease = { leaseGeneration, workerId }
  const persisted = await store.getSourceResolution(input, lease)
  if (persisted) return validatePersistedSource(persisted, input)
  if (!resolver || typeof resolver.resolve !== 'function') {
    throw new Error('Trusted source resolver is not configured.')
  }

  const result = validateSourceResolution(await resolver.resolve(input), input)
  const saved = await store.recordSourceResolution(result, lease)
  if (!saved || typeof saved.commitSha !== 'string'
    || saved.commitSha.toLowerCase() !== result.commitSha.toLowerCase()) {
    throw new Error('Persisted source SHA does not match the resolved commit.')
  }
  const pinned = {
    ...result,
    commitSha: saved.commitSha.toLowerCase(),
    resolvedAt: normalizeTimestamp(saved.resolvedAt),
  }
  return structuredClone(validateSourceResolution(pinned, input))
}

export function validateSourceResolution(result, expected) {
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || Object.keys(result).sort().join(',')
      !== 'commitSha,deploymentId,jobId,repository,requestedBranch,resolvedAt,schemaVersion') {
    throw new Error('Source resolver returned an invalid result.')
  }
  if (result.schemaVersion !== SOURCE_RESOLUTION_VERSION
    || result.deploymentId !== expected.deploymentId
    || result.jobId !== expected.jobId
    || result.repository !== expected.repository
    || result.requestedBranch !== expected.requestedBranch
    || typeof result.commitSha !== 'string' || !SHA_PATTERN.test(result.commitSha)
    || typeof result.resolvedAt !== 'string'
    || !Number.isFinite(Date.parse(result.resolvedAt))
    || new Date(result.resolvedAt).toISOString() !== result.resolvedAt) {
    throw new Error('Source resolver result does not match the requested source.')
  }
  return result
}

export function createConfiguredSourceResolver({
  resolverName = process.env.SOURCE_RESOLVER,
  token = process.env.GITHUB_SOURCE_TOKEN,
  ...options
} = {}) {
  if (resolverName !== 'github' || !token) return null
  return new GitHubSourceResolver({ ...options, token })
}

export function validateSourceRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).sort().join(',') !== 'deploymentId,jobId,repository,requestedBranch'
    || typeof input.deploymentId !== 'string' || typeof input.jobId !== 'string'
    || typeof input.repository !== 'string' || typeof input.requestedBranch !== 'string') {
    throw new Error('Source resolution input is invalid.')
  }
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  if (!uuidPattern.test(input.deploymentId) || !uuidPattern.test(input.jobId)) {
    throw new Error('Source resolution identifiers are invalid.')
  }
  if (validateGitHubUrl(input.repository) !== input.repository) {
    throw new Error('Source resolution repository must use its canonical URL.')
  }
  validateBranch(input.requestedBranch)
  return input
}

function validatePersistedSource(value, expected) {
  if (!value || typeof value.commitSha !== 'string'
    || !SHA_PATTERN.test(value.commitSha)
    || typeof value.resolvedAt !== 'string') {
    throw new Error('Persisted source resolution is unpinned or invalid.')
  }
  return structuredClone(validateSourceResolution({
    schemaVersion: SOURCE_RESOLUTION_VERSION,
    ...expected,
    commitSha: value.commitSha.toLowerCase(),
    resolvedAt: normalizeTimestamp(value.resolvedAt),
  }, expected))
}

function normalizeTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) throw new Error('Persisted source timestamp is invalid.')
  return date.toISOString()
}

async function readBoundedJson(body, maximumBytes) {
  const reader = body.getReader()
  const chunks = []
  let bytesRead = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytesRead += value.byteLength
      if (bytesRead > maximumBytes) {
        await reader.cancel()
        throw new Error('GitHub source response exceeded the allowed size.')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(bytesRead)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
}
