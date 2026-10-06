import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DockerCliRuntime } from './DockerCliRuntime.js'
import { DockerRegistryArtifactProvider } from './DockerRegistryArtifactProvider.js'
import { DockerRegistryProvider } from './DockerRegistryProvider.js'
import { runBoundedCommand } from './boundedCommand.js'

const enabled = process.env.RUN_LOCAL_REGISTRY_INTEGRATION === 'true'
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const composeFile = path.join(repositoryRoot, 'compose.local-registry.yaml')
const registryHost = 'localhost:5050'
const registryRepository = 'deployhub/validation'

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
  let composeMayHaveStarted = false

  t.after(async () => {
    const runtime = new DockerCliRuntime({ command: docker })
    const cleanupErrors = []
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
      if (args.includes('push')) pushCommands += 1
      return runBoundedCommand(command, args, options)
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

  const firstResult = await artifactProvider.push(request)

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
  assert.match(firstResult.registryDigest, /^sha256:[a-f0-9]{64}$/)
  assert.equal(firstResult.image, `${registryHost}/${registryRepository}@${firstResult.registryDigest}`)
  assert.equal(await readRegistryDigest(firstResult.tag), firstResult.registryDigest)
  assert.equal(pushCommands, 1)

  const repeatedResult = await artifactProvider.push(request)
  assert.equal(repeatedResult.registryDigest, firstResult.registryDigest)
  assert.equal(repeatedResult.image, firstResult.image)
  assert.equal(pushCommands, 1, 'an identical execution should reuse the existing remote manifest')

  const conflictingImage = await buildFixtureImage(runtime, temporaryDirectory, 'conflict')
  builtReferences.push(conflictingImage.reference)
  await assert.rejects(
    artifactProvider.push({
      ...request,
      localImage: { format: 'OCI_IMAGE', ...conflictingImage },
    }),
    (error) => error.code === 'DUPLICATE_EXECUTION',
  )
  assert.equal(pushCommands, 1, 'a conflicting immutable identity must not overwrite the existing tag')
  assert.equal(await readRegistryDigest(firstResult.tag), firstResult.registryDigest)
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
  throw new Error('The disposable local registry did not become ready on localhost:5050.')
}

async function readRegistryDigest(tag) {
  const response = await fetch(
    `http://${registryHost}/v2/${registryRepository}/manifests/${tag}`,
    {
      method: 'HEAD',
      headers: {
        Accept: [
          'application/vnd.docker.distribution.manifest.v2+json',
          'application/vnd.oci.image.manifest.v1+json',
        ].join(', '),
      },
      signal: AbortSignal.timeout(5_000),
    },
  )
  assert.equal(response.status, 200, 'the pushed registry manifest should be addressable')
  return response.headers.get('docker-content-digest')
}
