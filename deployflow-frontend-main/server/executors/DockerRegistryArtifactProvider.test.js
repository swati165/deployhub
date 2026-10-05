import test from 'node:test'
import assert from 'node:assert/strict'
import { DockerCliRuntime } from './DockerCliRuntime.js'
import { DockerRegistryArtifactProvider } from './DockerRegistryArtifactProvider.js'
import { DockerRegistryProvider, registryConfigFromEnvironment } from './DockerRegistryProvider.js'
import { RegistryProviderError } from './RegistryProvider.js'

const request = {
  deploymentId: '00000000-0000-4000-8000-000000000001',
  jobId: '00000000-0000-4000-8000-000000000002',
  executionId: 'ivm_execution_1',
  leaseGeneration: 3,
  commitSha: 'a'.repeat(40),
  localImage: {
    format: 'OCI_IMAGE',
    reference: 'deployhub-app:0123456789abcdef01234567',
    digest: `sha256:${'b'.repeat(64)}`,
  },
}
const archive = Buffer.from('trusted image archive')
const registryDigest = `sha256:${'c'.repeat(64)}`

function createBoundary({ exported = {}, run = async (_command, args) => {
  if (args.includes('manifest')) return { code: 1, stdout: '', stderr: 'manifest unknown' }
  if (args.includes('inspect')) return { code: 0, stdout: `${request.localImage.digest}\n`, stderr: '' }
  if (args.includes('push')) return { code: 0, stdout: `digest: ${registryDigest}\n`, stderr: '' }
  return { code: 0, stdout: '', stderr: '' }
} } = {}) {
  const calls = []
  const runtime = new DockerCliRuntime({
    run: async (command, args, options) => {
      calls.push({ source: 'runtime', command, args, options })
      if (args.includes('inspect')) {
        return { code: 0, stdout: `${exported.digest ?? request.localImage.digest}\n`, stderr: '' }
      }
      return {
        code: exported.error ? 1 : 0,
        stdout: exported.archive ?? archive,
        stderr: '',
      }
    },
  })
  const provider = new DockerRegistryProvider({
    config: {
      registry: 'registry.example.test',
      repository: 'deployhub/apps',
      username: 'trusted-publisher',
      password: 'must-not-leak',
      immutableTags: true,
    },
    run: async (command, args, options) => {
      calls.push({ source: 'registry', command, args, options })
      return run(command, args, options)
    },
    clock: () => new Date('2026-10-05T10:00:00.000Z'),
  })
  const registryProvider = new DockerRegistryArtifactProvider({
    runtime,
    provider,
  })
  return { calls, registryProvider }
}

test('exports, validates, loads, and publishes a correlated immutable application image', async () => {
  const { calls, registryProvider } = createBoundary()
  let leaseChecks = 0
  const result = await registryProvider.push(request, {
    async assertLease() { leaseChecks += 1 },
  })

  const [inspect, save] = calls.filter(({ source }) => source === 'runtime')
  assert.deepEqual(inspect.args, [
    'image', 'inspect', request.localImage.reference, '--format', '{{.Id}}',
  ])
  assert.deepEqual(save.args, ['image', 'save', request.localImage.digest])
  const load = calls.find(({ source, args }) => source === 'registry' && args.includes('load'))
  assert.equal(load.options.input, archive)
  const tag = calls.find(({ source, args }) => source === 'registry'
    && args.includes('tag') && args.includes(request.localImage.reference))
  assert.ok(tag)
  assert.ok(calls.some(({ source, args }) => source === 'registry' && args.includes('push')))
  assert.ok(leaseChecks >= 4)
  assert.equal(result.commitSha, request.commitSha)
  assert.equal(result.executionId, request.executionId)
  assert.equal(result.localImageDigest, request.localImage.digest)
  assert.equal(result.registryDigest, registryDigest)
  assert.equal(result.image, `registry.example.test/deployhub/apps@${registryDigest}`)
  assert.doesNotMatch(JSON.stringify(calls, (_key, value) =>
    value === 'must-not-leak' ? '[REDACTED]' : value), /must-not-leak/)
})

test('rejects exported image identity mismatch before loading or publishing', async () => {
  const { calls, registryProvider } = createBoundary({
    exported: { digest: `sha256:${'d'.repeat(64)}` },
  })
  await assert.rejects(
    registryProvider.push(request),
    (error) => error instanceof RegistryProviderError && error.code === 'LOCAL_IMAGE_NOT_FOUND',
  )
  assert.equal(calls.some(({ source, args }) => source === 'registry' && args.includes('load')), false)
})

test('rejects non-DeployHub image references before exporting', async () => {
  const { calls, registryProvider } = createBoundary()
  await assert.rejects(
    registryProvider.push({
      ...request,
      localImage: { ...request.localImage, reference: 'customer-image:latest' },
    }),
    (error) => error instanceof RegistryProviderError && error.code === 'LOCAL_IMAGE_NOT_FOUND',
  )
  assert.equal(calls.some(({ source }) => source === 'runtime'), false)
})

test('rejects empty, oversized, and failed image archive exports', async (t) => {
  for (const [name, exported] of [
    ['empty archive', { archive: Buffer.alloc(0) }],
    ['oversized archive', { archive: oversizedBuffer() }],
    ['failed export', { error: true }],
  ]) {
    await t.test(name, async () => {
      const { calls, registryProvider } = createBoundary({ exported })
      await assert.rejects(registryProvider.push(request), RegistryProviderError)
      assert.equal(calls.some(({ source, args }) => source === 'registry' && args.includes('load')), false)
      assert.equal(calls.some(({ source, args }) => source === 'registry' && args.includes('push')), false)
    })
  }
})

test('preserves lease and request-correlation validation, and remains disabled by default', async (t) => {
  await t.test('stale lease before export', async () => {
    const { calls, registryProvider } = createBoundary()
    await assert.rejects(
      registryProvider.push(request, {
        async assertLease() {
          throw new RegistryProviderError('STALE_LEASE_GENERATION', 'stale lease')
        },
      }),
      (error) => error.code === 'STALE_LEASE_GENERATION',
    )
    assert.equal(calls.some(({ source }) => source === 'runtime'), false)
  })
  await t.test('registry stays disabled without explicit configuration', () => {
    assert.throws(
      () => registryConfigFromEnvironment({}),
      (error) => error.code === 'REGISTRY_NOT_CONFIGURED',
    )
  })
})

function oversizedBuffer() {
  const buffer = Buffer.alloc(1)
  Object.defineProperty(buffer, 'byteLength', { value: 512 * 1024 * 1024 + 1 })
  return buffer
}
