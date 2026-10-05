import { createHash } from 'node:crypto'
import {
  RegistryProvider,
  RegistryProviderError,
  createRegistryTag,
  validateRegistryPushRequest,
} from './RegistryProvider.js'

export class FakeRegistryProvider extends RegistryProvider {
  #registry
  #repository
  #scenario
  #clock
  calls = []

  constructor({
    registry = 'registry.example.test',
    repository = 'deployhub/apps',
    scenario = 'SUCCESS',
    clock = () => new Date('2026-10-05T10:00:00.000Z'),
  } = {}) {
    super()
    this.name = 'fake-registry'
    this.registry = registry
    this.repository = repository
    this.#registry = registry
    this.#repository = repository
    this.#scenario = scenario
    this.#clock = clock
  }

  async push(request, { assertLease } = {}) {
    validateRegistryPushRequest(request)
    this.calls.push(structuredClone(request))
    await assertLease?.()
    if (this.#scenario !== 'SUCCESS') {
      const failures = {
        AUTHENTICATION_FAILED: ['REGISTRY_AUTHENTICATION_FAILED', 'Registry authentication failed.'],
        UNAUTHORIZED_REPOSITORY: ['REGISTRY_UNAUTHORIZED_REPOSITORY', 'Registry access to the configured repository was denied.'],
        REGISTRY_UNAVAILABLE: ['REGISTRY_UNAVAILABLE', 'Configured registry is unavailable.'],
        LOCAL_IMAGE_NOT_FOUND: ['LOCAL_IMAGE_NOT_FOUND', 'Local application image was not found.'],
        PUSH_FAILED: ['REGISTRY_PUSH_FAILED', 'Application image push failed.'],
        DIGEST_UNAVAILABLE: ['REGISTRY_DIGEST_UNAVAILABLE', 'Registry did not return an immutable image digest.'],
        STALE_LEASE: ['STALE_LEASE_GENERATION', 'Registry push was rejected because the worker lease is stale.'],
        DUPLICATE_EXECUTION: ['DUPLICATE_EXECUTION', 'Registry metadata conflicts with another execution.'],
      }
      const [code, message] = failures[this.#scenario] ?? ['REGISTRY_PUSH_FAILED', 'Application image push failed.']
      throw new RegistryProviderError(code, message, {
        retryable: code === 'REGISTRY_UNAVAILABLE' || code === 'REGISTRY_PUSH_FAILED',
      })
    }
    const tag = createRegistryTag(request)
    const registryDigest = `sha256:${createHash('sha256')
      .update(`${request.localImage.digest}:${request.deploymentId}:${request.executionId}`)
      .digest('hex')}`
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
      registry: this.#registry,
      repository: this.#repository,
      tag,
      registryDigest,
      image: `${this.#registry}/${this.#repository}@${registryDigest}`,
      pushedAt: pushedAt.toISOString(),
    }
  }
}
