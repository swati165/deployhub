import {
  RegistryProvider,
  RegistryProviderError,
  validateRegistryPushRequest,
} from './RegistryProvider.js'

export class DockerRegistryArtifactProvider extends RegistryProvider {
  #runtime
  #provider

  constructor({ runtime, provider } = {}) {
    super()
    if (!runtime || typeof runtime.exportApplicationImage !== 'function'
      || !provider || typeof provider.pushArtifact !== 'function'
      || typeof provider.name !== 'string'
      || typeof provider.registry !== 'string'
      || typeof provider.repository !== 'string') {
      throw new TypeError('Docker registry artifact handoff dependencies are invalid.')
    }
    this.#runtime = runtime
    this.#provider = provider
    this.name = provider.name
    this.registry = provider.registry
    this.repository = provider.repository
  }

  async push(request, { assertLease, signal } = {}) {
    validateRegistryPushRequest(request)
    await assertLease?.()
    let artifact
    try {
      artifact = await this.#runtime.exportApplicationImage({
        reference: request.localImage.reference,
        digest: request.localImage.digest,
        signal,
      })
    } catch {
      throw new RegistryProviderError(
        'LOCAL_IMAGE_NOT_FOUND',
        'The correlated local application image could not be exported.',
      )
    }
    await assertLease?.()
    return this.#provider.pushArtifact(request, artifact, { assertLease, signal })
  }
}
