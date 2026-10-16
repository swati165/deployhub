import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { runBoundedCommand } from './boundedCommand.js'
import {
  RegistryProvider,
  RegistryProviderError,
  createRegistryTag,
  validRegistryHost,
  validRepository,
  validateRegistryPushRequest,
} from './RegistryProvider.js'

const DIGEST_PATTERN = /sha256:[a-f0-9]{64}/i
const MAX_APPLICATION_IMAGE_ARCHIVE_BYTES = 512 * 1024 * 1024
const MAX_IMAGE_OPERATION_TIMEOUT_MS = 120_000

export class DockerRegistryProvider extends RegistryProvider {
  #config
  #command
  #clock
  #run
  #registryFetch

  constructor({
    config = registryConfigFromEnvironment(),
    command = process.env.DOCKER_EXECUTABLE || 'docker',
    clock = () => new Date(),
    run = runBoundedCommand,
    registryFetch = globalThis.fetch,
  } = {}) {
    super()
    validateRegistryConfig(config)
    this.#config = Object.freeze({ ...config })
    if (typeof command !== 'string' || !command || typeof run !== 'function'
      || typeof clock !== 'function' || typeof registryFetch !== 'function') {
      throw new RegistryProviderError('REGISTRY_CONFIGURATION_INVALID', 'Registry provider configuration is invalid.')
    }
    this.name = 'docker-registry'
    this.registry = this.#config.registry
    this.repository = this.#config.repository
    this.#command = command
    this.#clock = clock
    this.#run = run
    this.#registryFetch = registryFetch
  }

  async push(request, { assertLease, signal } = {}) {
    validateRegistryPushRequest(request)
    await assertLease?.()
    const tag = createRegistryTag(request)
    const target = `${this.#config.registry}/${this.#config.repository}:${tag}`
    const configDirectory = await mkdtemp(path.join(os.tmpdir(), 'deployhub-registry-'))
    await chmod(configDirectory, 0o700)
    try {
      const inspect = await this.#run(this.#command, [
        '--config', configDirectory, 'image', 'inspect', request.localImage.reference,
        '--format', '{{.Id}} {{json .RepoDigests}}',
      ], commandOptions({ signal }))
      if (inspect.code !== 0) {
        throw new RegistryProviderError('LOCAL_IMAGE_NOT_FOUND', 'Local application image was not found.')
      }
      const localImage = parseLocalImageInspection(inspect.stdout)
      if (localImage.id.toLowerCase() !== request.localImage.digest.toLowerCase()) {
        throw new RegistryProviderError('DUPLICATE_EXECUTION', 'Local image identity does not match this execution.')
      }

      await assertLease?.()
      const login = await this.#run(this.#command, [
        '--config', configDirectory, 'login', this.#config.registry,
        '--username', this.#config.username, '--password-stdin',
      ], commandOptions({ input: this.#config.password, signal }))
      if (login.code !== 0) {
        throw new RegistryProviderError('REGISTRY_AUTHENTICATION_FAILED', 'Registry authentication failed.')
      }

      await assertLease?.()
      const existing = await this.#run(this.#command, [
        '--config', configDirectory, 'buildx', 'imagetools', 'inspect', '--raw', target,
      ], commandOptions({ signal }))
      let digest
      if (existing.code === 0) {
        let manifest
        try {
          manifest = JSON.parse(existing.stdout)
        } catch {
          throw new RegistryProviderError('REGISTRY_DIGEST_UNAVAILABLE', 'Existing registry image metadata is invalid.')
        }
        if (!isSingleImageManifest(manifest)) {
          throw new RegistryProviderError('REGISTRY_DIGEST_UNAVAILABLE', 'Existing registry image digest is unavailable.')
        }
        const configDigest = manifest.config.digest.toLowerCase()
        const existingDigest = `sha256:${createHash('sha256').update(existing.stdout).digest('hex')}`
        const localManifestDigestMatches = existingDigest === request.localImage.digest.toLowerCase()
          && localImage.repoDigests.includes(`deployhub-app@${existingDigest}`)
        if (configDigest !== request.localImage.digest.toLowerCase() && !localManifestDigestMatches) {
          throw new RegistryProviderError(
            'DUPLICATE_EXECUTION',
            'Deterministic registry tag already identifies a different image.',
          )
        }
        digest = existingDigest.toLowerCase()
      } else {
        if (!isManifestInspectionMiss(existing.stderr, target)) {
          throw classifyPushFailure(existing.stderr)
        }
        const absent = await verifyManifestAbsent({
          registry: this.#config.registry,
          repository: this.#config.repository,
          tag,
          username: this.#config.username,
          password: this.#config.password,
          fetch: this.#registryFetch,
          signal,
        })
        if (!absent) {
          throw new RegistryProviderError(
            'REGISTRY_PUSH_FAILED',
            'Registry manifest inspection failed and absence could not be verified.',
          )
        }
      }

      const tagged = await this.#run(this.#command, [
        '--config', configDirectory, 'tag', request.localImage.reference, target,
      ], commandOptions({ signal }))
      if (tagged.code !== 0) {
        throw new RegistryProviderError('REGISTRY_PUSH_FAILED', 'Local registry image tagging failed.')
      }
      if (!digest) {
        const pushed = await this.#run(this.#command, [
          '--config', configDirectory, 'push', target,
        ], commandOptions({ signal }))
        if (pushed.code !== 0) {
          throw classifyPushFailure(pushed.stderr)
        }
        digest = `${pushed.stdout}\n${pushed.stderr}`.match(DIGEST_PATTERN)?.[0]?.toLowerCase()
      }
      if (!digest) {
        throw new RegistryProviderError('REGISTRY_DIGEST_UNAVAILABLE', 'Registry did not return an immutable image digest.')
      }
      await assertLease?.()
      const pushedAt = this.#clock()
      if (!(pushedAt instanceof Date) || !Number.isFinite(pushedAt.getTime())) {
        throw new RegistryProviderError('REGISTRY_PUSH_FAILED', 'Registry provider returned an invalid timestamp.')
      }
      return {
        schemaVersion: 1,
        provider: this.name,
        deploymentId: request.deploymentId,
        jobId: request.jobId,
        executionId: request.executionId,
        leaseGeneration: request.leaseGeneration,
        commitSha: request.commitSha,
        localImageReference: request.localImage.reference,
        localImageDigest: request.localImage.digest,
        registry: this.#config.registry,
        repository: this.#config.repository,
        tag,
        registryDigest: digest,
        image: `${this.#config.registry}/${this.#config.repository}@${digest}`,
        pushedAt: pushedAt.toISOString(),
      }
    } catch (error) {
      if (error instanceof RegistryProviderError) throw error
      if (error?.code === 'STALE_LEASE_GENERATION') throw error
      if (error?.code === 'COMMAND_TIMEOUT' || error?.code === 'ENOENT') {
        throw new RegistryProviderError('REGISTRY_UNAVAILABLE', 'Configured registry or Docker runtime is unavailable.', { retryable: true })
      }
      throw new RegistryProviderError('REGISTRY_PUSH_FAILED', 'Application image push failed.', { retryable: true })
    } finally {
      await rm(configDirectory, { recursive: true, force: true })
    }
  }

  async pushArtifact(request, artifact, { assertLease, signal } = {}) {
    validateRegistryPushRequest(request)
    validateApplicationImageArtifact(artifact, request)
    await assertLease?.()

    const configDirectory = await mkdtemp(path.join(os.tmpdir(), 'deployhub-image-load-'))
    await chmod(configDirectory, 0o700)
    try {
      const loaded = await this.#run(this.#command, [
        '--config', configDirectory, 'image', 'load',
      ], commandOptions({
        input: artifact.archive,
        signal,
        timeoutMs: MAX_IMAGE_OPERATION_TIMEOUT_MS,
      }))
      if (loaded.code !== 0) {
        throw new RegistryProviderError('LOCAL_IMAGE_NOT_FOUND', 'Exported application image could not be loaded.')
      }

      const inspected = await this.#run(this.#command, [
        '--config', configDirectory, 'image', 'inspect', artifact.digest,
        '--format', '{{.Id}}',
      ], commandOptions({ signal }))
      if (inspected.code !== 0 || inspected.stdout.trim().toLowerCase() !== artifact.digest.toLowerCase()) {
        throw new RegistryProviderError('DUPLICATE_EXECUTION', 'Imported application image does not match its immutable image ID.')
      }

      await assertLease?.()
      const tagged = await this.#run(this.#command, [
        '--config', configDirectory, 'image', 'tag', artifact.digest, artifact.reference,
      ], commandOptions({ signal }))
      if (tagged.code !== 0) {
        throw new RegistryProviderError('REGISTRY_PUSH_FAILED', 'Imported application image could not be tagged for publishing.')
      }
    } catch (error) {
      if (error instanceof RegistryProviderError) throw error
      if (error?.code === 'STALE_LEASE_GENERATION') throw error
      if (error?.code === 'COMMAND_TIMEOUT' || error?.code === 'ENOENT') {
        throw new RegistryProviderError('REGISTRY_UNAVAILABLE', 'Configured Docker runtime is unavailable.', { retryable: true })
      }
      throw new RegistryProviderError('REGISTRY_PUSH_FAILED', 'Exported application image could not be prepared for publishing.', { retryable: true })
    } finally {
      await rm(configDirectory, { recursive: true, force: true })
    }

    return this.push(request, { assertLease, signal })
  }
}

export function registryConfigFromEnvironment(environment = process.env) {
  const enabled = environment.REGISTRY_PUSH_ENABLED === 'true'
  const provider = environment.REGISTRY_PROVIDER ?? 'disabled'
  if (!enabled || provider === 'disabled') {
    throw new RegistryProviderError('REGISTRY_NOT_CONFIGURED', 'Registry publishing is disabled or not configured.')
  }
  if (provider !== 'docker') {
    throw new RegistryProviderError('REGISTRY_CONFIGURATION_INVALID', 'Configured registry provider is unsupported.')
  }
  const registry = environment.REGISTRY_HOST
  const repository = environment.REGISTRY_REPOSITORY
  if (!validRegistryHost(registry) || !validRepository(repository)) {
    throw new RegistryProviderError('REGISTRY_CONFIGURATION_INVALID', 'Trusted registry destination is invalid.')
  }
  if (environment.REGISTRY_TAGS_IMMUTABLE !== 'true') {
    throw new RegistryProviderError(
      'REGISTRY_CONFIGURATION_INVALID',
      'Configured registry must enforce immutable tags before publishing is enabled.',
    )
  }
  if (typeof environment.REGISTRY_USERNAME !== 'string' || environment.REGISTRY_USERNAME.length < 1
    || typeof environment.REGISTRY_PASSWORD !== 'string' || environment.REGISTRY_PASSWORD.length < 1) {
    throw new RegistryProviderError('REGISTRY_CREDENTIALS_UNAVAILABLE', 'Trusted registry credentials are unavailable.')
  }
  return {
    registry: registry.toLowerCase(),
    repository: repository.toLowerCase(),
    username: environment.REGISTRY_USERNAME,
    password: environment.REGISTRY_PASSWORD,
    immutableTags: true,
  }
}

function validateRegistryConfig(config) {
  if (!config || typeof config !== 'object'
    || !validRegistryHost(config.registry) || !validRepository(config.repository)) {
    throw new RegistryProviderError('REGISTRY_CONFIGURATION_INVALID', 'Trusted registry destination is invalid.')
  }
  if (typeof config.username !== 'string' || !config.username
    || typeof config.password !== 'string' || !config.password) {
    throw new RegistryProviderError('REGISTRY_CREDENTIALS_UNAVAILABLE', 'Trusted registry credentials are unavailable.')
  }
  if (config.immutableTags !== true) {
    throw new RegistryProviderError('REGISTRY_CONFIGURATION_INVALID', 'Configured registry must enforce immutable tags.')
  }
}

function parseLocalImageInspection(output) {
  const match = /^([^\s]+)(?:\s+(\[[^\r\n]*\]|null))?$/.exec(output.trim())
  if (!match || !DIGEST_PATTERN.test(match[1])) {
    throw new RegistryProviderError('LOCAL_IMAGE_NOT_FOUND', 'Local application image metadata is invalid.')
  }
  let repoDigests = []
  if (match[2] && match[2] !== 'null') {
    try {
      const parsed = JSON.parse(match[2])
      if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== 'string')) {
        throw new Error('Invalid repository digest metadata.')
      }
      repoDigests = parsed.map((value) => value.toLowerCase())
    } catch {
      throw new RegistryProviderError('LOCAL_IMAGE_NOT_FOUND', 'Local application image metadata is invalid.')
    }
  }
  return { id: match[1], repoDigests }
}

function isSingleImageManifest(manifest) {
  const supportedMediaTypes = new Set([
    'application/vnd.oci.image.manifest.v1+json',
    'application/vnd.docker.distribution.manifest.v2+json',
  ])
  const supportedConfigMediaTypes = new Set([
    'application/vnd.oci.image.config.v1+json',
    'application/vnd.docker.container.image.v1+json',
  ])
  const supportedLayerMediaTypes = new Set([
    'application/vnd.oci.image.layer.v1.tar',
    'application/vnd.oci.image.layer.v1.tar+gzip',
    'application/vnd.oci.image.layer.v1.tar+zstd',
    'application/vnd.docker.image.rootfs.diff.tar',
    'application/vnd.docker.image.rootfs.diff.tar.gzip',
  ])
  return manifest?.schemaVersion === 2
    && supportedMediaTypes.has(manifest.mediaType)
    && !Object.hasOwn(manifest, 'manifests')
    && supportedConfigMediaTypes.has(manifest.config?.mediaType)
    && typeof manifest.config?.digest === 'string'
    && DIGEST_PATTERN.test(manifest.config.digest)
    && Array.isArray(manifest.layers)
    && manifest.layers.every((layer) => supportedLayerMediaTypes.has(layer?.mediaType)
      && typeof layer.digest === 'string'
      && DIGEST_PATTERN.test(layer.digest))
}

function isManifestInspectionMiss(stderr, target) {
  if (typeof stderr !== 'string') return false
  const message = stderr.trim().replace(/^error:\s*/i, '').toLowerCase()
  const reference = target.toLowerCase()
  return message === `${reference}: not found`
    || message === 'manifest unknown'
    || message === `manifest unknown: ${reference}`
    || message === 'no such manifest'
    || message === `no such manifest: ${reference}`
}

async function verifyManifestAbsent({
  registry,
  repository,
  tag,
  username,
  password,
  fetch,
  signal,
}) {
  const registryUrl = new URL(`${isLoopbackRegistry(registry) ? 'http' : 'https'}://${registry}`)
  const repositoryPath = repository.split('/').map(encodeURIComponent).join('/')
  const tagsUrl = new URL(`/v2/${repositoryPath}/tags/list?n=1`, registryUrl)
  const manifestUrl = new URL(`/v2/${repositoryPath}/manifests/${encodeURIComponent(tag)}`, registryUrl)
  const request = createAuthenticatedRegistryRequest({
    registryUrl,
    repository,
    username,
    password,
    fetch,
    signal,
  })

  const tagsResponse = await request(tagsUrl, 'application/json')
  if (tagsResponse.status === 404
    && tagsListReportsMissingRepository(await readRegistryJson(tagsResponse), repository)) {
    // A fresh registry answers NAME_UNKNOWN with the requested repository identity;
    // that response proves the repository (and therefore the tag) does not exist yet.
    return true
  }
  if (tagsResponse.status !== 200) {
    throw registryApiStatusError(tagsResponse.status)
  }
  const tags = await readRegistryJson(tagsResponse)
  if (tags?.name !== repository
    || !(tags.tags === null || (Array.isArray(tags.tags)
      && tags.tags.every((value) => typeof value === 'string')))) {
    throw new RegistryProviderError(
      'REGISTRY_PUSH_FAILED',
      'Registry repository could not be verified.',
    )
  }

  const manifestResponse = await request(manifestUrl, [
    'application/vnd.oci.image.manifest.v1+json',
    'application/vnd.docker.distribution.manifest.v2+json',
    'application/vnd.oci.image.index.v1+json',
    'application/vnd.docker.distribution.manifest.list.v2+json',
  ].join(', '))
  if (manifestResponse.status !== 404) {
    if (manifestResponse.status === 200) return false
    throw registryApiStatusError(manifestResponse.status)
  }
  const errorDocument = await readRegistryJson(manifestResponse)
  return Array.isArray(errorDocument?.errors)
    && errorDocument.errors.some((error) => error?.code === 'MANIFEST_UNKNOWN'
      && (error.detail?.Tag === undefined || error.detail.Tag === tag))
}

function createAuthenticatedRegistryRequest({
  registryUrl,
  repository,
  username,
  password,
  fetch,
  signal,
}) {
  let authorization = null
  const request = async (url, accept) => {
    let response = await fetchRegistry(url, { accept, authorization, fetch, signal })
    if (response.status !== 401) return response

    const challenge = response.headers.get('www-authenticate') ?? ''
    await response.body?.cancel()
    if (/\bBearer\b/i.test(challenge)) {
      authorization = await requestBearerToken({
        challenge,
        registryUrl,
        repository,
        username,
        password,
        fetch,
        signal,
      })
    } else if (/\bBasic\b/i.test(challenge) && url.origin === registryUrl.origin) {
      authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
    } else {
      throw new RegistryProviderError(
        'REGISTRY_AUTHENTICATION_FAILED',
        'Registry authentication challenge is unsupported.',
      )
    }

    response = await fetchRegistry(url, { accept, authorization, fetch, signal })
    if (response.status === 401 || response.status === 403) {
      throw registryApiStatusError(response.status)
    }
    return response
  }
  return request
}

async function requestBearerToken({
  challenge,
  registryUrl,
  repository,
  username,
  password,
  fetch,
  signal,
}) {
  const parameters = parseAuthChallengeParameters(challenge, 'Bearer')
  let realm
  try {
    realm = new URL(parameters.realm)
  } catch {
    throw new RegistryProviderError('REGISTRY_AUTHENTICATION_FAILED', 'Registry authentication challenge is invalid.')
  }
  if ((realm.protocol !== 'https:' && realm.origin !== registryUrl.origin)
    || realm.username || realm.password || realm.hash) {
    throw new RegistryProviderError('REGISTRY_AUTHENTICATION_FAILED', 'Registry authentication challenge is unsafe.')
  }

  if (parameters.service) realm.searchParams.set('service', parameters.service)
  realm.searchParams.set('scope', `repository:${repository}:pull`)
  const response = await fetchRegistry(realm, {
    accept: 'application/json',
    authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
    fetch,
    signal,
  })
  if (response.status !== 200) {
    throw registryApiStatusError(response.status)
  }
  const tokenDocument = await readRegistryJson(response)
  const token = tokenDocument?.token ?? tokenDocument?.access_token
  if (typeof token !== 'string' || token.length < 1 || token.length > 16_384
    || /[\r\n]/.test(token)) {
    throw new RegistryProviderError('REGISTRY_AUTHENTICATION_FAILED', 'Registry access token response is invalid.')
  }
  return `Bearer ${token}`
}

function parseAuthChallengeParameters(challenge, scheme) {
  const expression = new RegExp(`(?:^|,\\s*)${scheme}\\s+([^]*?)(?=,\\s*(?:Basic|Bearer)\\s|$)`, 'i')
  const match = expression.exec(challenge)
  if (!match) {
    throw new RegistryProviderError('REGISTRY_AUTHENTICATION_FAILED', 'Registry authentication challenge is invalid.')
  }
  const parameters = {}
  for (const item of match[1].matchAll(/([a-z][a-z0-9_-]*)\s*=\s*(?:"((?:\\.|[^"])*)"|([^,\s]+))/gi)) {
    parameters[item[1].toLowerCase()] = (item[2] ?? item[3]).replace(/\\(.)/g, '$1')
  }
  return parameters
}

async function fetchRegistry(url, { accept, authorization, fetch, signal }) {
  const timeoutSignal = AbortSignal.timeout(MAX_IMAGE_OPERATION_TIMEOUT_MS)
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
  return fetch(url, {
    method: 'GET',
    headers: {
      Accept: accept,
      ...(authorization ? { Authorization: authorization } : {}),
    },
    redirect: 'manual',
    signal: requestSignal,
  })
}

async function readRegistryJson(response) {
  const contentLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > 64 * 1024) {
    throw new RegistryProviderError('REGISTRY_PUSH_FAILED', 'Registry response exceeded its size limit.')
  }
  const reader = response.body?.getReader()
  if (!reader) {
    throw new RegistryProviderError('REGISTRY_PUSH_FAILED', 'Registry returned an empty response.')
  }
  const chunks = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > 64 * 1024) {
        await reader.cancel()
        throw new RegistryProviderError('REGISTRY_PUSH_FAILED', 'Registry response exceeded its size limit.')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  try {
    return JSON.parse(Buffer.concat(chunks, total).toString('utf8'))
  } catch {
    throw new RegistryProviderError('REGISTRY_PUSH_FAILED', 'Registry returned malformed response data.')
  }
}

function isLoopbackRegistry(registry) {
  return registry === 'localhost' || registry.startsWith('localhost:')
    || /^127(?:\.\d{1,3}){3}(?::\d{1,5})?$/.test(registry)
}

function registryApiStatusError(status) {
  if (status === 401) {
    return new RegistryProviderError('REGISTRY_AUTHENTICATION_FAILED', 'Registry authentication failed.')
  }
  if (status === 403) {
    return new RegistryProviderError('REGISTRY_UNAUTHORIZED_REPOSITORY', 'Registry access to the configured repository was denied.')
  }
  return new RegistryProviderError('REGISTRY_PUSH_FAILED', 'Registry response did not verify manifest absence.')
}

function tagsListReportsMissingRepository(errorDocument, repository) {
  const errors = errorDocument?.errors
  return Array.isArray(errors)
    && errors.length > 0
    && errors.every((error) => error?.code === 'NAME_UNKNOWN'
      && typeof error.detail?.name === 'string'
      && error.detail.name === repository)
}

function commandOptions({
  input,
  signal,
  timeoutMs = MAX_IMAGE_OPERATION_TIMEOUT_MS,
  maxOutputBytes = 64 * 1024,
} = {}) {
  const allowed = [
    'PATH',
    'SYSTEMROOT',
    'WINDIR',
    'TEMP',
    'TMP',
    'HOME',
    'USERPROFILE',
    'PROGRAMFILES',
    'PROGRAMFILES(X86)',
    'PROGRAMW6432',
  ]
  const env = Object.fromEntries(allowed
    .filter((key) => typeof process.env[key] === 'string')
    .map((key) => [key, process.env[key]]))
  env.PATH ??= '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
  return {
    env,
    input,
    signal,
    timeoutMs,
    maxOutputBytes,
  }
}

function validateApplicationImageArtifact(artifact, request) {
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)
    || Object.keys(artifact).sort().join(',') !== 'archive,digest,format,reference'
    || artifact.format !== 'DOCKER_IMAGE_ARCHIVE'
    || artifact.reference !== request.localImage.reference
    || artifact.digest?.toLowerCase() !== request.localImage.digest.toLowerCase()
    || !Buffer.isBuffer(artifact.archive)
    || artifact.archive.byteLength < 1
    || artifact.archive.byteLength > MAX_APPLICATION_IMAGE_ARCHIVE_BYTES) {
    throw new RegistryProviderError('LOCAL_IMAGE_NOT_FOUND', 'A valid bounded application image archive is required.')
  }
}

function classifyPushFailure(stderr) {
  const detail = typeof stderr === 'string' ? stderr.toLowerCase() : ''
  if (/denied|unauthorized|forbidden|insufficient_scope/.test(detail)) {
    return new RegistryProviderError('REGISTRY_UNAUTHORIZED_REPOSITORY', 'Registry access to the configured repository was denied.')
  }
  if (/connection refused|no such host|i\/o timeout|network is unreachable/.test(detail)) {
    return new RegistryProviderError('REGISTRY_UNAVAILABLE', 'Configured registry is unavailable.', { retryable: true })
  }
  return new RegistryProviderError('REGISTRY_PUSH_FAILED', 'Application image push failed.', { retryable: true })
}
