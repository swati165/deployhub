import test from 'node:test'
import assert from 'node:assert/strict'
import { access } from 'node:fs/promises'
import {
  DockerRegistryProvider,
  registryConfigFromEnvironment,
} from './DockerRegistryProvider.js'
import { FakeRegistryProvider } from './FakeRegistryProvider.js'
import {
  RegistryProviderError,
  createRegistryTag,
  validateRegistryPushResult,
} from './RegistryProvider.js'

const request = Object.freeze({
  deploymentId: '00000000-0000-4000-8000-000000000001',
  jobId: '00000000-0000-4000-8000-000000000002',
  executionId: 'ivm_execution_1',
  leaseGeneration: 4,
  commitSha: 'a'.repeat(40),
  localImage: {
    format: 'OCI_IMAGE',
    reference: 'deployhub-app:0123456789abcdef01234567',
    digest: `sha256:${'b'.repeat(64)}`,
  },
})

const digest = `sha256:${'c'.repeat(64)}`

test('fake registry push returns immutable digest metadata correlated to deployment, execution, source, and local image', async () => {
  const provider = new FakeRegistryProvider()
  const result = await provider.push(request)
  assert.equal(result.provider, 'fake-registry')
  assert.equal(result.deploymentId, request.deploymentId)
  assert.equal(result.executionId, request.executionId)
  assert.equal(result.commitSha, request.commitSha)
  assert.equal(result.localImageDigest, request.localImage.digest)
  assert.equal(result.tag, createRegistryTag(request))
  assert.match(result.image, /@sha256:[a-f0-9]{64}$/)
  assert.equal(validateRegistryPushResult(result, request), result)
})

test('deterministic tags are collision-resistant and stable for the same execution', () => {
  const tag = createRegistryTag(request)
  assert.equal(tag, createRegistryTag(request))
  assert.match(tag, /^dh-[a-f0-9]{64}$/)
  assert.notEqual(tag, createRegistryTag({ ...request, executionId: 'other-execution' }))
  assert.notEqual(tag, createRegistryTag({ ...request, deploymentId: '00000000-0000-4000-8000-000000000003' }))
})

test('configuration and missing trusted credentials fail closed with structured codes', () => {
  assert.throws(
    () => registryConfigFromEnvironment({ REGISTRY_PUSH_ENABLED: 'false', REGISTRY_PROVIDER: 'disabled' }),
    (error) => error.code === 'REGISTRY_NOT_CONFIGURED',
  )
  assert.throws(
    () => registryConfigFromEnvironment({
      REGISTRY_PUSH_ENABLED: 'true',
      REGISTRY_PROVIDER: 'docker',
      REGISTRY_HOST: 'registry.example.test',
      REGISTRY_REPOSITORY: 'team/app',
      REGISTRY_TAGS_IMMUTABLE: 'true',
      REGISTRY_USERNAME: 'publisher',
      REGISTRY_PASSWORD: '',
    }),
    (error) => error.code === 'REGISTRY_CREDENTIALS_UNAVAILABLE',
  )
  assert.throws(
    () => registryConfigFromEnvironment({
      REGISTRY_PUSH_ENABLED: 'true',
      REGISTRY_PROVIDER: 'docker',
      REGISTRY_HOST: 'https://attacker.example.test',
      REGISTRY_REPOSITORY: 'team/app',
      REGISTRY_TAGS_IMMUTABLE: 'true',
      REGISTRY_USERNAME: 'publisher',
      REGISTRY_PASSWORD: 'secret',
    }),
    (error) => error.code === 'REGISTRY_CONFIGURATION_INVALID',
  )
})

test('Docker registry provider uses trusted scoped config and passes its credential only on stdin', async () => {
  const calls = []
  const secret = 'registry-password-must-not-leak'
  const provider = new DockerRegistryProvider({
    config: {
      registry: 'registry.example.test',
      repository: 'team/deployhub',
      username: 'trusted-publisher',
      password: secret,
      immutableTags: true,
    },
    run: async (_command, args, options) => {
      calls.push({ args, options })
      if (args.includes('manifest')) return { code: 1, stdout: '', stderr: 'manifest unknown' }
      if (args.includes('inspect')) return { code: 0, stdout: `${request.localImage.digest}\n`, stderr: '' }
      if (args.includes('push')) return { code: 0, stdout: `digest: ${digest}\n`, stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    },
    clock: () => new Date('2026-10-05T10:01:02.000Z'),
  })
  const result = await provider.push(request)
  const login = calls.find(({ args }) => args.includes('login'))
  assert.equal(login.options.input, secret)
  assert.equal(login.args.includes(secret), false)
  assert.equal(JSON.stringify(login.options.env).includes(secret), false)
  assert.equal(login.options.env.DATABASE_URL, undefined)
  assert.equal(login.options.env.JWT_SECRET, undefined)
  assert.equal(login.options.env.GITHUB_SOURCE_TOKEN, undefined)
  assert.equal(result.registryDigest, digest)
  assert.equal(result.image, `registry.example.test/team/deployhub@${digest}`)
  assert.equal(result.pushedAt, '2026-10-05T10:01:02.000Z')
  for (const { args } of calls) {
    assert.equal(args.includes(secret), false)
  }
  const configPath = calls[0].args[1]
  await assert.rejects(access(configPath), { code: 'ENOENT' })
})

test('existing immutable tags are reused only when their config digest matches the local image', async (t) => {
  for (const matches of [true, false]) {
    await t.test(matches ? 'matching tag' : 'conflicting tag', async () => {
      const calls = []
      const provider = new DockerRegistryProvider({
        config: {
          registry: 'registry.example.test',
          repository: 'team/deployhub',
          username: 'publisher',
          password: 'secret',
          immutableTags: true,
        },
        run: async (_command, args) => {
          calls.push(args)
          if (args.includes('inspect') && !args.includes('manifest')) {
            return { code: 0, stdout: `${request.localImage.digest}\n`, stderr: '' }
          }
          if (args.includes('manifest')) {
            return {
              code: 0,
              stdout: JSON.stringify({
                Descriptor: { digest },
                SchemaV2Manifest: { config: { digest: matches ? request.localImage.digest : `sha256:${'f'.repeat(64)}` } },
              }),
              stderr: '',
            }
          }
          return { code: 0, stdout: '', stderr: '' }
        },
      })
      if (matches) {
        const result = await provider.push(request)
        assert.equal(result.registryDigest, digest)
      } else {
        await assert.rejects(
          provider.push(request),
          (error) => error.code === 'DUPLICATE_EXECUTION',
        )
      }
      assert.equal(calls.some((args) => args.includes('push')), false)
    })
  }
})

test('Docker registry provider reports structured auth, repository, outage, missing-image, and digest failures without leaking output', async (t) => {
  const cases = [
    ['auth', (args) => args.includes('login'), 1, 'secret=must-not-leak', 'REGISTRY_AUTHENTICATION_FAILED'],
    ['repository', (args) => args.includes('push'), 1, 'denied: unauthorized token=must-not-leak', 'REGISTRY_UNAUTHORIZED_REPOSITORY'],
    ['unavailable', (args) => args.includes('push'), 1, 'no such host', 'REGISTRY_UNAVAILABLE'],
    ['image missing', (args) => args.includes('inspect'), 1, 'No such image', 'LOCAL_IMAGE_NOT_FOUND'],
    ['digest missing', (args) => args.includes('push'), 0, 'successfully pushed', 'REGISTRY_DIGEST_UNAVAILABLE'],
  ]
  for (const [name, matches, exitCode, stderr, code] of cases) {
    await t.test(name, async () => {
      const provider = new DockerRegistryProvider({
        config: {
          registry: 'registry.example.test',
          repository: 'team/deployhub',
          username: 'publisher',
          password: 'secret',
          immutableTags: true,
        },
        run: async (_command, args) => {
          if (matches(args)) {
            return { code: exitCode, stdout: exitCode === 0 ? stderr : '', stderr }
          }
          if (args.includes('manifest')) return { code: 1, stdout: '', stderr: 'manifest unknown' }
          if (args.includes('inspect')) {
            return { code: 0, stdout: `${request.localImage.digest}\n`, stderr: '' }
          }
          return { code: 0, stdout: '', stderr: '' }
        },
      })
      await assert.rejects(provider.push(request), (error) => {
        assert.ok(error instanceof RegistryProviderError)
        assert.equal(error.code, code)
        assert.doesNotMatch(error.message, /secret|token|must-not-leak/i)
        return true
      })
    })
  }
})

test('fake registry makes duplicate execution and stale-lease failures deterministic', async (t) => {
  await t.test('stale generation', async () => {
    const provider = new FakeRegistryProvider()
    await assert.rejects(
      provider.push(request, {
        async assertLease() {
          throw new RegistryProviderError('STALE_LEASE_GENERATION', 'stale lease')
        },
      }),
      (error) => error.code === 'STALE_LEASE_GENERATION',
    )
  })
  await t.test('duplicate execution', async () => {
    const provider = new FakeRegistryProvider({ scenario: 'DUPLICATE_EXECUTION' })
    await assert.rejects(provider.push(request), (error) => error.code === 'DUPLICATE_EXECUTION')
  })
})

test('registry provider output rejects mutable or mismatched deployment image identity', async () => {
  const result = await new FakeRegistryProvider().push(request)
  assert.throws(
    () => validateRegistryPushResult({ ...result, image: `${result.registry}/${result.repository}:${result.tag}` }, request),
    (error) => error.code === 'REGISTRY_PUSH_FAILED',
  )
  assert.throws(
    () => validateRegistryPushResult({ ...result, localImageDigest: digest }, request),
    (error) => error.code === 'REGISTRY_PUSH_FAILED',
  )
})
