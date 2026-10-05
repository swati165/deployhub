import { chmod, mkdtemp, rm } from 'node:fs/promises'
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

export class DockerRegistryProvider extends RegistryProvider {
  #config
  #command
  #clock
  #run

  constructor({
    config = registryConfigFromEnvironment(),
    command = process.env.DOCKER_EXECUTABLE || 'docker',
    clock = () => new Date(),
    run = runBoundedCommand,
  } = {}) {
    super()
    validateRegistryConfig(config)
    this.#config = Object.freeze({ ...config })
    if (typeof command !== 'string' || !command || typeof run !== 'function' || typeof clock !== 'function') {
      throw new RegistryProviderError('REGISTRY_CONFIGURATION_INVALID', 'Registry provider configuration is invalid.')
    }
    this.name = 'docker-registry'
    this.registry = this.#config.registry
    this.repository = this.#config.repository
    this.#command = command
    this.#clock = clock
    this.#run = run
  }

  async push(request, { assertLease } = {}) {
    validateRegistryPushRequest(request)
    await assertLease?.()
    const tag = createRegistryTag(request)
    const target = `${this.#config.registry}/${this.#config.repository}:${tag}`
    const configDirectory = await mkdtemp(path.join(os.tmpdir(), 'deployhub-registry-'))
    await chmod(configDirectory, 0o700)
    try {
      const inspect = await this.#run(this.#command, [
        '--config', configDirectory, 'image', 'inspect', request.localImage.reference,
        '--format', '{{.Id}}',
      ], commandOptions())
      if (inspect.code !== 0) {
        throw new RegistryProviderError('LOCAL_IMAGE_NOT_FOUND', 'Local application image was not found.')
      }
      if (inspect.stdout.trim().toLowerCase() !== request.localImage.digest.toLowerCase()) {
        throw new RegistryProviderError('DUPLICATE_EXECUTION', 'Local image identity does not match this execution.')
      }

      await assertLease?.()
      const login = await this.#run(this.#command, [
        '--config', configDirectory, 'login', this.#config.registry,
        '--username', this.#config.username, '--password-stdin',
      ], commandOptions({ input: this.#config.password }))
      if (login.code !== 0) {
        throw new RegistryProviderError('REGISTRY_AUTHENTICATION_FAILED', 'Registry authentication failed.')
      }

      await assertLease?.()
      const existing = await this.#run(this.#command, [
        '--config', configDirectory, 'manifest', 'inspect', '--verbose', target,
      ], commandOptions())
      let digest
      if (existing.code === 0) {
        let manifest
        try {
          manifest = JSON.parse(existing.stdout)
        } catch {
          throw new RegistryProviderError('REGISTRY_DIGEST_UNAVAILABLE', 'Existing registry image metadata is invalid.')
        }
        const configDigest = manifest?.SchemaV2Manifest?.config?.digest
        const existingDigest = manifest?.Descriptor?.digest
        if (typeof configDigest !== 'string' || !DIGEST_PATTERN.test(configDigest)
          || typeof existingDigest !== 'string' || !DIGEST_PATTERN.test(existingDigest)) {
          throw new RegistryProviderError('REGISTRY_DIGEST_UNAVAILABLE', 'Existing registry image digest is unavailable.')
        }
        if (configDigest.toLowerCase() !== request.localImage.digest.toLowerCase()) {
          throw new RegistryProviderError(
            'DUPLICATE_EXECUTION',
            'Deterministic registry tag already identifies a different image.',
          )
        }
        digest = existingDigest.toLowerCase()
      } else if (!/manifest unknown|no such manifest|not found/i.test(existing.stderr)) {
        throw classifyPushFailure(existing.stderr)
      }

      const tagged = await this.#run(this.#command, [
        '--config', configDirectory, 'tag', request.localImage.reference, target,
      ], commandOptions())
      if (tagged.code !== 0) {
        throw new RegistryProviderError('REGISTRY_PUSH_FAILED', 'Local registry image tagging failed.')
      }
      if (!digest) {
        const pushed = await this.#run(this.#command, [
          '--config', configDirectory, 'push', target,
        ], commandOptions())
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

function commandOptions({ input } = {}) {
  const allowed = ['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']
  const env = Object.fromEntries(allowed
    .filter((key) => typeof process.env[key] === 'string')
    .map((key) => [key, process.env[key]]))
  env.PATH ??= '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
  return {
    env,
    input,
    timeoutMs: 120_000,
    maxOutputBytes: 64 * 1024,
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
