import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DockerCliRuntime } from './DockerCliRuntime.js'
import { DockerRegistryArtifactProvider } from './DockerRegistryArtifactProvider.js'
import { DockerRegistryProvider } from './DockerRegistryProvider.js'
import { createRegistryTag } from './RegistryProvider.js'
import { runBoundedCommand } from './boundedCommand.js'

const enabled = process.env.RUN_LOCAL_REGISTRY_INTEGRATION === 'true'
const composeFile = fileURLToPath(new URL('../../docker/compose.local-registry.yaml', import.meta.url))
const registryHost = 'localhost:5051'
const registryRepository = 'deployhub/validation'
const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v1+prettyjws',
].join(', ')

test('publishes a generated image to a disposable local registry and reuses its digest', {
  skip: enabled ? false : 'set RUN_LOCAL_REGISTRY_INTEGRATION=true to run disposable Docker validation',
}, async (t) => {
  const docker = process.env.DOCKER_EXECUTABLE || 'docker'
  const projectName = `dh-registry-test-${process.pid}-${randomUUID().slice(0, 8)}`
  const composeArgs = [
    'compose',
    '--file', composeFile,
    '--project-name', projectName,
    '--profile', 'local-validation',
  ]
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'deployhub-registry-test-'))
  const builtReferences = []
  const registryReferences = new Set()
  let composeMayHaveStarted = false

  t.after(async () => {
    const runtime = new DockerCliRuntime({ command: docker })
    const cleanupErrors = []
    for (const reference of registryReferences) {
      try {
        const removed = await runBoundedCommand(docker, [
          'image', 'rm', reference,
        ], { timeoutMs: 10_000, maxOutputBytes: 4096 })
        if (removed.code !== 0) cleanupErrors.push(new Error(removed.stderr))
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    for (const reference of builtReferences) {
      try {
        await runtime.removeApplicationImage(reference, { timeoutMs: 10_000, logBytes: 4096 })
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    if (composeMayHaveStarted) {
      try {
        const stopped = await runBoundedCommand(docker, [
          ...composeArgs, 'down', '--remove-orphans',
        ], { timeoutMs: 60_000, maxOutputBytes: 64 * 1024 })
        if (stopped.code !== 0) cleanupErrors.push(new Error(stopped.stderr))
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    await rm(temporaryDirectory, { recursive: true, force: true })
    console.error('[local-registry cleanup]', JSON.stringify({
      registryImageReferencesRemoved: registryReferences.size,
      generatedApplicationImagesRemoved: builtReferences.length,
      registryContainerRemoved: composeMayHaveStarted,
      temporaryDirectoryRemoved: true,
      errors: cleanupErrors.length,
    }))
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'Local registry validation cleanup failed.')
    }
  })

  composeMayHaveStarted = true
  const started = await runBoundedCommand(docker, [
    ...composeArgs,
    'up', '--detach', '--no-build', '--pull', 'never', 'local-registry',
  ], { timeoutMs: 60_000, maxOutputBytes: 64 * 1024 })
  assert.equal(started.code, 0, `Could not start the preloaded local registry image: ${started.stderr}`)
  await waitForLocalRegistry()

  const runtime = new DockerCliRuntime({ command: docker })
  let pushCommands = 0
  let activeAttempt = null
  const attemptDiagnostics = []
  const provider = new DockerRegistryProvider({
    command: docker,
    config: {
      registry: registryHost,
      repository: registryRepository,
      username: 'local-validation-only',
      password: `ephemeral-${randomUUID()}`,
      immutableTags: true,
    },
    run: async (command, args, options) => {
      const relevant = args.includes('--raw')
        || args.includes('push')
      const result = await runBoundedCommand(command, args, options)
      if (activeAttempt && relevant) {
        if (args.includes('push')) {
          pushCommands += 1
          activeAttempt.pushCommands.push(sanitizeDockerCommand(command, args))
        } else {
          activeAttempt.manifestInspection = summarizeDockerManifestInspection(
            command,
            args,
            result,
            request.localImage.digest,
          )
          activeAttempt.localRepoDigests = activeAttempt.localRepoDigests ?? []
          activeAttempt.manifestInspection.localRepoDigestAttestsManifest =
            activeAttempt.localRepoDigests.includes(
              `deployhub-app@${activeAttempt.manifestInspection.remoteManifestDigest}`,
            )
          activeAttempt.providerConfigDigestComparison = {
            remoteConfigDigest: activeAttempt.manifestInspection.remoteConfigDigest,
            expectedLocalImageId: request.localImage.digest,
            comparisonPerformed: activeAttempt.manifestInspection.result === 'manifest-found'
              && typeof activeAttempt.manifestInspection.remoteConfigDigest === 'string',
            configDigestMatches: activeAttempt.manifestInspection.configDigestMatchesLocalImageId,
            manifestDigestMatches: activeAttempt.manifestInspection.remoteManifestDigest
              === request.localImage.digest.toLowerCase(),
            localRepoDigestAttestsManifest: activeAttempt.manifestInspection.localRepoDigestAttestsManifest,
          }
        }
      } else if (activeAttempt && args.includes('image') && args.includes('inspect')
        && args.includes(request.localImage.reference)) {
        activeAttempt.localInspectIdentity = summarizeLocalImageInspection(result.stdout)
        activeAttempt.localRepoDigests = activeAttempt.localInspectIdentity.repoDigests
      }
      return result
    },
  })
  const artifactProvider = new DockerRegistryArtifactProvider({ runtime, provider })
  const deploymentId = randomUUID()
  const jobId = randomUUID()
  const executionId = `local-registry-${randomUUID()}`
  const commitSha = randomUUID().replaceAll('-', '').padEnd(40, '0').slice(0, 40)
  const firstImage = await buildFixtureImage(runtime, temporaryDirectory, 'first')
  builtReferences.push(firstImage.reference)
  const request = {
    deploymentId,
    jobId,
    executionId,
    leaseGeneration: 1,
    commitSha,
    localImage: { format: 'OCI_IMAGE', ...firstImage },
  }

  const firstResult = await publishWithDiagnostics({
    artifactProvider,
    request,
    attemptDiagnostics,
    getPushCount: () => pushCommands,
    setActiveAttempt(value) { activeAttempt = value },
  })

  assert.equal(firstResult.deploymentId, deploymentId)
  assert.equal(firstResult.jobId, jobId)
  assert.equal(firstResult.executionId, executionId)
  assert.equal(firstResult.leaseGeneration, request.leaseGeneration)
  assert.equal(firstResult.commitSha, commitSha)
  assert.equal(firstResult.localImageReference, firstImage.reference)
  assert.equal(firstResult.localImageDigest, firstImage.digest)
  assert.equal(firstResult.registry, registryHost)
  assert.equal(firstResult.repository, registryRepository)
  assert.match(firstResult.tag, /^dh-[a-f0-9]{64}$/)
  registryReferences.add(`${firstResult.registry}/${firstResult.repository}:${firstResult.tag}`)
  assert.match(firstResult.registryDigest, /^sha256:[a-f0-9]{64}$/)
  assert.equal(firstResult.image, `${registryHost}/${registryRepository}@${firstResult.registryDigest}`)
  const firstRemoteManifest = await readRegistryDigest(firstResult, firstImage.reference)
  assert.equal(firstRemoteManifest.digest, firstResult.registryDigest)
  assert.equal(pushCommands, 1)

  const repeatedResult = await publishWithDiagnostics({
    artifactProvider,
    request,
    attemptDiagnostics,
    getPushCount: () => pushCommands,
    remoteManifestBefore: firstRemoteManifest,
    setActiveAttempt(value) { activeAttempt = value },
  })
  assert.equal(repeatedResult.registryDigest, firstResult.registryDigest)
  assert.equal(repeatedResult.image, firstResult.image)
  assert.equal(pushCommands, 1, 'an identical execution should reuse the existing remote manifest')

  const conflictingImage = await buildFixtureImage(runtime, temporaryDirectory, 'conflict')
  builtReferences.push(conflictingImage.reference)
  await assert.rejects(
    publishWithDiagnostics({
      artifactProvider,
      request: { ...request, localImage: { format: 'OCI_IMAGE', ...conflictingImage } },
      attemptDiagnostics,
      getPushCount: () => pushCommands,
      remoteManifestBefore: firstRemoteManifest,
      setActiveAttempt(value) { activeAttempt = value },
    }),
    (error) => error.code === 'DUPLICATE_EXECUTION',
  )
  assert.equal(pushCommands, 1, 'a conflicting immutable identity must not overwrite the existing tag')
  assert.equal(
    (await readRegistryDigest(firstResult, firstImage.reference)).digest,
    firstResult.registryDigest,
  )
})

async function buildFixtureImage(runtime, parentDirectory, variant) {
  const reference = `deployhub-app:${randomUUID().replaceAll('-', '').slice(0, 24)}`
  const contextDirectory = path.join(parentDirectory, variant)
  await mkdir(contextDirectory)
  await writeFile(path.join(contextDirectory, 'Dockerfile'), 'FROM scratch\nCOPY payload /payload\n')
  await writeFile(path.join(contextDirectory, 'payload'), `DeployHub local validation ${variant}\n`)
  const built = await runtime.buildApplicationImage({
    contextDirectory,
    reference,
    policy: { logBytes: 64 * 1024, timeoutMs: 60_000 },
    timeoutMs: 60_000,
  })
  assert.match(built.imageId, /^sha256:[a-f0-9]{64}$/)
  return { reference, digest: built.imageId }
}

async function waitForLocalRegistry() {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://${registryHost}/v2/`, {
        signal: AbortSignal.timeout(2_000),
      })
      if (response.ok) return
    } catch {
      // Retry only the fixed loopback endpoint while the disposable service starts.
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('The disposable local registry did not become ready on localhost:5051.')
}

async function readRegistryDigest(result, localImageReference) {
  const baseUrl = `http://${registryHost}`
  const registryImageReference = `${result.registry}/${result.repository}:${result.tag}`
  const manifestUrl = `${baseUrl}/v2/${result.repository}/manifests/${result.tag}`
  const catalog = await readRegistryJson(`${baseUrl}/v2/_catalog`)
  const tags = await readRegistryJson(`${baseUrl}/v2/${result.repository}/tags/list`)
  const requestOptions = {
    headers: { Accept: MANIFEST_ACCEPT },
    signal: AbortSignal.timeout(5_000),
  }
  const head = await fetch(manifestUrl, { ...requestOptions, method: 'HEAD' })
  const get = await fetch(manifestUrl, { ...requestOptions, method: 'GET' })
  const getBody = Buffer.from(await get.arrayBuffer())
  const manifestSummary = await summarizeRegistryManifest(getBody, get.headers.get('content-type'), baseUrl, result.repository)
  const diagnostic = {
    registryEndpoint: baseUrl,
    repository: result.repository,
    tag: result.tag,
    localImageReference,
    registryImageReference,
    providerReturnedDigest: result.registryDigest,
    providerReturnedImage: result.image,
    manifestUrl,
    requestedAccept: MANIFEST_ACCEPT,
    expectedProviderDigest: result.registryDigest,
    head: {
      status: head.status,
      contentType: head.headers.get('content-type'),
      headers: safeManifestHeaders(head.headers),
    },
    get: {
      status: get.status,
      contentType: get.headers.get('content-type'),
      dockerContentDigest: get.headers.get('docker-content-digest'),
      headers: safeManifestHeaders(get.headers),
      bodySizeBytes: getBody.byteLength,
      manifest: manifestSummary,
      body: safeShortErrorBody(getBody, get.headers.get('content-type')),
    },
    catalogHttpStatus: catalog.status,
    catalogRepositories: catalog.data?.repositories?.filter((entry) => typeof entry === 'string') ?? null,
    tagsHttpStatus: tags.status,
    repositoryTags: tags.data?.tags?.filter((entry) => typeof entry === 'string') ?? null,
  }
  console.error('[local-registry manifest diagnostic]', JSON.stringify(diagnostic))

  assert.equal(head.status, 200, 'the pushed registry manifest should be addressable')
  return {
    digest: head.headers.get('docker-content-digest'),
    manifest: manifestSummary,
  }
}

async function publishWithDiagnostics({
  artifactProvider,
  request,
  attemptDiagnostics,
  getPushCount,
  remoteManifestBefore = null,
  setActiveAttempt,
}) {
  const remoteConfigDigests = remoteManifestBefore
    ? getManifestConfigDigests(remoteManifestBefore.manifest)
    : []
  const attempt = {
    number: attemptDiagnostics.length + 1,
    localImageId: request.localImage.digest,
    localImageReference: request.localImage.reference,
    repository: artifactProvider.repository,
    tag: createRegistryTag(request),
    registryImageReference: null,
    providerResultDigest: null,
    providerResultImage: null,
    providerDecision: 'pending',
    manifestInspection: null,
    localInspectIdentity: null,
    localRepoDigests: [],
    remoteManifestBefore: remoteManifestBefore
      ? {
        digest: remoteManifestBefore.digest,
        manifestDigestMatchesLocalImageId: remoteManifestBefore.digest?.toLowerCase()
          === request.localImage.digest.toLowerCase(),
        mediaType: remoteManifestBefore.manifest.mediaType,
        configDigests: remoteConfigDigests,
        configDigestMatchesLocalImageId: remoteConfigDigests.includes(request.localImage.digest.toLowerCase()),
      }
      : null,
    providerConfigDigestComparison: {
      remoteConfigDigest: null,
      expectedLocalImageId: request.localImage.digest,
      performed: false,
    },
    pushCommands: [],
    pushCountBefore: getPushCount(),
    pushCountAfter: null,
  }
  setActiveAttempt(attempt)
  let result
  try {
    result = await artifactProvider.push(request)
    attempt.tag = result.tag
    attempt.registryImageReference = `${result.registry}/${result.repository}:${result.tag}`
    attempt.providerResultDigest = result.registryDigest
    attempt.providerResultImage = result.image
    return result
  } finally {
    attempt.pushCountAfter = getPushCount()
    attempt.providerDecision = decideReuseOrPush(attempt.manifestInspection, request.localImage.digest)
    attemptDiagnostics.push(attempt)
    setActiveAttempt(null)
    console.error('[local-registry publish attempt]', JSON.stringify(attempt))
  }
}

function sanitizeDockerCommand(command, args) {
  const safeArgs = [...args]
  const configIndex = safeArgs.indexOf('--config')
  if (configIndex >= 0 && configIndex + 1 < safeArgs.length) {
    safeArgs[configIndex + 1] = '<temporary-docker-config>'
  }
  return [path.basename(command), ...safeArgs]
}

function summarizeDockerManifestInspection(command, args, result, expectedLocalImageId) {
  let manifest = null
  if (result.code === 0) {
    try {
      manifest = JSON.parse(result.stdout)
    } catch {
      // Keep malformed tool output out of diagnostic logs.
    }
  }
  const configDigest = manifest?.config?.digest ?? null
  const manifestDigest = result.code === 0
    ? `sha256:${createHash('sha256').update(result.stdout).digest('hex')}`
    : null
  return {
    command: sanitizeDockerCommand(command, args),
    exitCode: result.code,
    result: result.code === 0 ? 'manifest-found' : classifyManifestInspectFailure(result.stderr),
    manifestMediaType: manifest?.mediaType ?? null,
    isImageIndex: Array.isArray(manifest?.manifests),
    remoteManifestDigest: manifestDigest,
    remoteConfigDigest: configDigest,
    commandFailureCategory: result.code === 0 ? null : safeDockerFailureCategory(result.stderr),
    expectedLocalImageId,
    configDigestMatchesLocalImageId: typeof configDigest === 'string'
      && configDigest.toLowerCase() === expectedLocalImageId.toLowerCase(),
  }
}

function summarizeLocalImageInspection(stdout) {
  const [id = '', repoDigestsJson = '[]'] = stdout.trim().split(/\s+(?=\[|null)/, 2)
  let repoDigests = []
  try {
    const parsed = JSON.parse(repoDigestsJson)
    if (Array.isArray(parsed)) {
      repoDigests = parsed.filter((value) => typeof value === 'string' && /^deployhub-app@sha256:[a-f0-9]{64}$/i.test(value))
    }
  } catch {
    repoDigests = []
  }
  return {
    id: /^sha256:[a-f0-9]{64}$/i.test(id) ? id : null,
    repoDigests,
  }
}

function safeDockerFailureCategory(stderr) {
  const message = typeof stderr === 'string' ? stderr.toLowerCase() : ''
  if (/no such manifest|manifest unknown/.test(message)) return 'remote-manifest-not-found'
  const unsupportedFlag = /unknown flag:\s*(--[a-z-]{1,40})/.exec(message)?.[1]
  if (unsupportedFlag) return `unsupported-docker-cli-flag:${unsupportedFlag}`
  if (/unknown flag|unknown shorthand/.test(message)) return 'unsupported-docker-cli-flag'
  if (/unknown command|is not a docker command/.test(message)) return 'unsupported-docker-cli-command'
  if (/unauthorized|authentication required|denied/.test(message)) return 'registry-authentication-or-authorization-failed'
  if (/connection refused|no such host|i\/o timeout|network is unreachable/.test(message)) return 'registry-connection-failed'
  if (/failed to get credentials|credential.*error/.test(message)) return 'docker-credential-helper-failed'
  return 'unclassified-docker-cli-failure'
}

function classifyManifestInspectFailure(stderr) {
  const message = typeof stderr === 'string' ? stderr.toLowerCase() : ''
  if (/manifest unknown/.test(message)) return 'not-found: manifest unknown'
  if (/no such manifest/.test(message)) return 'not-found: no such manifest'
  if (/not found/.test(message)) return 'not-found: not found'
  if (/unauthorized|denied|authentication required/.test(message)) return 'authorization-failed'
  return 'other-failure'
}

function decideReuseOrPush(manifestInspection, localImageId) {
  if (!manifestInspection) return 'no-manifest-inspection-observed'
  if (manifestInspection.result === 'manifest-found') {
    if (manifestInspection.isImageIndex) return 'fail-closed-ambiguous-image-index'
    if (!manifestInspection.remoteManifestDigest || !manifestInspection.remoteConfigDigest) {
      return 'manifest-metadata-invalid'
    }
    return manifestInspection.remoteConfigDigest.toLowerCase() === localImageId.toLowerCase()
      || (manifestInspection.remoteManifestDigest.toLowerCase() === localImageId.toLowerCase()
        && manifestInspection.localRepoDigestAttestsManifest)
      ? 'reuse-existing-remote-manifest'
      : 'reject-conflicting-identity'
  }
  return manifestInspection.result.startsWith('not-found')
    ? 'push-because-remote-tag-not-found'
    : 'manifest-inspection-failed'
}

async function summarizeRegistryManifest(body, contentType, baseUrl, repository) {
  let manifest
  try {
    manifest = JSON.parse(body.toString('utf8'))
  } catch {
    return { mediaType: contentType, jsonParsed: false }
  }
  const summary = {
    mediaType: manifest.mediaType ?? contentType,
    schemaVersion: Number.isSafeInteger(manifest.schemaVersion) ? manifest.schemaVersion : null,
    configDigest: typeof manifest.config?.digest === 'string' ? manifest.config.digest : null,
    layerDigests: Array.isArray(manifest.layers)
      ? manifest.layers.map(({ digest }) => digest).filter(isSha256Digest)
      : [],
    descriptors: Array.isArray(manifest.manifests)
      ? manifest.manifests.filter(({ digest }) => isSha256Digest(digest)).map(({ digest, mediaType, platform }) => ({
        digest,
        mediaType: typeof mediaType === 'string' ? mediaType : null,
        platform: platform && typeof platform === 'object'
          ? {
            architecture: typeof platform.architecture === 'string' ? platform.architecture : null,
            os: typeof platform.os === 'string' ? platform.os : null,
          }
          : null,
      }))
      : [],
  }

  if (summary.configDigest || summary.layerDigests.length > 0) return summary

  const childManifests = []
  for (const descriptor of summary.descriptors.slice(0, 4)) {
    const response = await fetch(
      `${baseUrl}/v2/${repository}/manifests/${descriptor.digest}`,
      { headers: { Accept: MANIFEST_ACCEPT }, signal: AbortSignal.timeout(5_000) },
    )
    if (!response.ok) {
      childManifests.push({ ...descriptor, status: response.status })
      continue
    }
    const childBytes = Buffer.from(await response.arrayBuffer())
    let child
    try {
      child = JSON.parse(childBytes.toString('utf8'))
    } catch {
      childManifests.push({ ...descriptor, status: response.status, jsonParsed: false })
      continue
    }
    childManifests.push({
      ...descriptor,
      status: response.status,
      mediaType: child.mediaType ?? descriptor.mediaType,
      configDigest: typeof child.config?.digest === 'string' ? child.config.digest : null,
      layerDigests: Array.isArray(child.layers)
        ? child.layers.map(({ digest }) => digest).filter(isSha256Digest)
        : [],
    })
  }
  return { ...summary, childManifests }
}

function isSha256Digest(value) {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/i.test(value)
}

function getManifestConfigDigests(manifest) {
  const digests = [
    manifest.configDigest,
    ...(manifest.childManifests ?? []).map(({ configDigest }) => configDigest),
  ]
  return [...new Set(digests
    .filter(isSha256Digest)
    .map((digest) => digest.toLowerCase()))]
}

function safeManifestHeaders(headers) {
  const relevant = [
    'content-type',
    'docker-content-digest',
    'docker-distribution-api-version',
    'content-length',
    'etag',
    'vary',
  ]
  return Object.fromEntries(relevant
    .map((name) => [name, headers.get(name)])
    .filter(([, value]) => value !== null))
}

function safeShortErrorBody(body, contentType) {
  if (body.byteLength > 1024 || !contentType?.toLowerCase().includes('json')) return null
  try {
    const parsed = JSON.parse(body.toString('utf8'))
    if (!Array.isArray(parsed?.errors)) return null
    return parsed.errors.slice(0, 5).map((error) => ({
      code: typeof error?.code === 'string' && /^[A-Z_]{1,64}$/.test(error.code)
        ? error.code
        : 'UNRECOGNIZED',
      message: typeof error?.message === 'string' && /^[A-Z_ ]{1,128}$/.test(error.message)
        ? error.message
        : undefined,
    }))
  } catch {
    return null
  }
}

async function readRegistryJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) })
  let data = null
  if (response.ok) {
    try {
      data = await response.json()
    } catch {
      data = null
    }
  }
  return { status: response.status, data }
}
