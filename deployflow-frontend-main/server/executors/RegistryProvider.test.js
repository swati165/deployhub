import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
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

function missingManifestRegistryFetch() {
  return async (input) => {
    const url = new URL(input)
    if (url.pathname.endsWith('/tags/list')) {
      return Response.json({ name: 'team/deployhub', tags: [] })
    }
    const tag = url.pathname.split('/').at(-1)
    return Response.json({
      errors: [{ code: 'MANIFEST_UNKNOWN', message: 'manifest unknown', detail: { Tag: tag } }],
    }, { status: 404 })
  }
}

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
    registryFetch: missingManifestRegistryFetch(),
    run: async (_command, args, options) => {
      calls.push({ args, options })
      if (args.includes('--raw')) return { code: 1, stdout: '', stderr: 'manifest unknown' }
      if (args.includes('image') && args.includes('inspect')) {
        return { code: 0, stdout: `${request.localImage.digest} []\n`, stderr: '' }
      }
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

test('registry API confirmation distinguishes a missing manifest before permitting a push', async (t) => {
  for (const [name, inspectionError] of [
    ['exact missing-reference output', (target) => `ERROR: ${target}: not found`],
    ['explicit manifest unknown', () => 'ERROR: manifest unknown'],
  ]) {
    await t.test(name, async () => {
      const calls = []
      const registryRequests = []
      const tag = createRegistryTag(request)
      const registryFetch = async (input) => {
        const url = new URL(input)
        registryRequests.push(url.pathname)
        if (url.pathname.endsWith('/tags/list')) {
          return Response.json({ name: 'team/deployhub', tags: [] })
        }
        const tag = url.pathname.split('/').at(-1)
        return Response.json({
          errors: [{ code: 'MANIFEST_UNKNOWN', message: 'manifest unknown', detail: { Tag: tag } }],
        }, { status: 404 })
      }
      const provider = new DockerRegistryProvider({
        config: {
          registry: 'registry.example.test',
          repository: 'team/deployhub',
          username: 'trusted-publisher',
          password: 'secret',
          immutableTags: true,
        },
        registryFetch,
        run: async (_command, args) => {
          calls.push(args)
          if (args.includes('--raw')) {
            return { code: 1, stdout: '', stderr: inspectionError(args.at(-1)) }
          }
          if (args.includes('image') && args.includes('inspect')) {
            return { code: 0, stdout: `${request.localImage.digest} []\n`, stderr: '' }
          }
          if (args.includes('push')) {
            return { code: 0, stdout: `digest: ${digest}\n`, stderr: '' }
          }
          return { code: 0, stdout: '', stderr: '' }
        },
      })

      const result = await provider.push(request)
      assert.equal(result.registryDigest, digest)
      assert.deepEqual(registryRequests, [
        '/v2/team/deployhub/tags/list',
        `/v2/team/deployhub/manifests/${tag}`,
      ])
      assert.equal(calls.some((args) => args.includes('push')), true)
    })
  }
})

test('unrelated and ambiguous Buildx inspection errors fail closed without registry probing or push', async (t) => {
  for (const inspectionError of [
    'ERROR: repository not found',
    'ERROR: a not found result is ambiguous',
    'ERROR: another-tag: not found',
  ]) {
    await t.test(inspectionError, async () => {
      const calls = []
      const provider = new DockerRegistryProvider({
        config: {
          registry: 'registry.example.test',
          repository: 'team/deployhub',
          username: 'publisher',
          password: 'secret',
          immutableTags: true,
        },
        registryFetch: async () => {
          throw new Error('unexpected registry probe')
        },
        run: async (_command, args) => {
          calls.push(args)
          if (args.includes('--raw')) return { code: 1, stdout: '', stderr: inspectionError }
          if (args.includes('image') && args.includes('inspect')) {
            return { code: 0, stdout: `${request.localImage.digest} []\n`, stderr: '' }
          }
          return { code: 0, stdout: '', stderr: '' }
        },
      })
      await assert.rejects(provider.push(request), (error) => error.code === 'REGISTRY_PUSH_FAILED')
      assert.equal(calls.some((args) => args.includes('push')), false)
    })
  }
})

test('registry authentication challenge scopes credentials and bearer token to configured registry requests', async () => {
  const fetchCalls = []
  const authRealm = 'https://auth.registry.example.test/token'
  const provider = new DockerRegistryProvider({
    config: {
      registry: 'registry.example.test',
      repository: 'team/deployhub',
      username: 'trusted-publisher',
      password: 'sensitive-password',
      immutableTags: true,
    },
    registryFetch: async (input, options) => {
      const url = new URL(input)
      fetchCalls.push({ url, options })
      if (url.origin === new URL(authRealm).origin) {
        assert.equal(url.searchParams.get('scope'), 'repository:team/deployhub:pull')
        assert.equal(url.searchParams.get('service'), 'registry.example.test')
        assert.equal(options.headers.Authorization, `Basic ${Buffer.from('trusted-publisher:sensitive-password').toString('base64')}`)
        return Response.json({ token: 'scoped-registry-token' })
      }
      if (!options.headers.Authorization) {
        return new Response('', {
          status: 401,
          headers: {
            'www-authenticate': `Bearer realm="${authRealm}",service="registry.example.test",scope="repository:team/deployhub:pull,push"`,
          },
        })
      }
      assert.equal(options.headers.Authorization, 'Bearer scoped-registry-token')
      return url.pathname.endsWith('/tags/list')
        ? Response.json({ name: 'team/deployhub', tags: [] })
        : Response.json({
          errors: [{
            code: 'MANIFEST_UNKNOWN',
            message: 'manifest unknown',
            detail: { Tag: url.pathname.split('/').at(-1) },
          }],
        }, { status: 404 })
    },
    run: async (_command, args) => {
      if (args.includes('--raw')) {
        return { code: 1, stdout: '', stderr: `ERROR: ${args.at(-1)}: not found` }
      }
      if (args.includes('image') && args.includes('inspect')) {
        return { code: 0, stdout: `${request.localImage.digest} []\n`, stderr: '' }
      }
      if (args.includes('push')) return { code: 0, stdout: `digest: ${digest}\n`, stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    },
  })

  const result = await provider.push(request)
  assert.equal(result.registryDigest, digest)
  assert.ok(fetchCalls.every(({ options }) => options.redirect === 'manual'))
  assert.equal(fetchCalls.some(({ url, options }) =>
    url.origin === 'https://registry.example.test'
    && options.headers.Authorization === 'Bearer scoped-registry-token'), true)
  assert.equal(fetchCalls.some(({ url, options }) =>
    url.origin !== 'https://auth.registry.example.test'
    && options.headers.Authorization?.includes('sensitive-password')), false)
})

test('basic authentication challenge sends credentials only to the configured registry origin', async () => {
  const fetchCalls = []
  const provider = new DockerRegistryProvider({
    config: {
      registry: 'registry.example.test',
      repository: 'team/deployhub',
      username: 'trusted-publisher',
      password: 'sensitive-password',
      immutableTags: true,
    },
    registryFetch: async (input, options) => {
      const url = new URL(input)
      fetchCalls.push({ url, options })
      if (!options.headers.Authorization) {
        return new Response('', {
          status: 401,
          headers: { 'www-authenticate': 'Basic realm="registry"' },
        })
      }
      assert.equal(
        options.headers.Authorization,
        `Basic ${Buffer.from('trusted-publisher:sensitive-password').toString('base64')}`,
      )
      return url.pathname.endsWith('/tags/list')
        ? Response.json({ name: 'team/deployhub', tags: [] })
        : Response.json({
          errors: [{
            code: 'MANIFEST_UNKNOWN',
            message: 'manifest unknown',
            detail: { Tag: url.pathname.split('/').at(-1) },
          }],
        }, { status: 404 })
    },
    run: async (_command, args) => {
      if (args.includes('--raw')) {
        return { code: 1, stdout: '', stderr: `ERROR: ${args.at(-1)}: not found` }
      }
      if (args.includes('image') && args.includes('inspect')) {
        return { code: 0, stdout: `${request.localImage.digest} []\n`, stderr: '' }
      }
      if (args.includes('push')) return { code: 0, stdout: `digest: ${digest}\n`, stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    },
  })

  const result = await provider.push(request)
  assert.equal(result.registryDigest, digest)
  assert.ok(fetchCalls.every(({ url, options }) =>
    url.origin === 'https://registry.example.test' && options.redirect === 'manual'))
})

test('registry API failures never permit a push after ambiguous Buildx inspection errors', async (t) => {
  const cases = [
    ['NAME_UNKNOWN repository', async (url) => url.pathname.endsWith('/tags/list')
      ? Response.json({ errors: [{ code: 'NAME_UNKNOWN', message: 'unknown repository' }] }, { status: 404 })
      : Response.json({ errors: [] }, { status: 404 }), 'REGISTRY_PUSH_FAILED'],
    ['unauthorized', async () => Response.json({ errors: [] }, { status: 401 }), 'REGISTRY_AUTHENTICATION_FAILED'],
    ['forbidden', async () => Response.json({ errors: [] }, { status: 403 }), 'REGISTRY_UNAUTHORIZED_REPOSITORY'],
    ['unexpected status', async () => Response.json({ errors: [] }, { status: 500 }), 'REGISTRY_PUSH_FAILED'],
    ['malformed tags JSON', async () => new Response('{', { status: 200 }), 'REGISTRY_PUSH_FAILED'],
    ['transport error', async () => { throw new Error('simulated transport failure') }, 'REGISTRY_PUSH_FAILED'],
    ['malformed manifest error JSON', async (url) => url.pathname.endsWith('/tags/list')
      ? Response.json({ name: 'team/deployhub', tags: [] })
      : new Response('{', { status: 404 }), 'REGISTRY_PUSH_FAILED'],
    ['wrong manifest error code', async (url) => url.pathname.endsWith('/tags/list')
      ? Response.json({ name: 'team/deployhub', tags: [] })
      : Response.json({ errors: [{ code: 'NAME_UNKNOWN' }] }, { status: 404 }), 'REGISTRY_PUSH_FAILED'],
  ]
  for (const [name, registryFetch, expectedCode] of cases) {
    await t.test(name, async () => {
      const calls = []
      const provider = new DockerRegistryProvider({
        config: {
          registry: 'registry.example.test',
          repository: 'team/deployhub',
          username: 'publisher',
          password: 'secret',
          immutableTags: true,
        },
        registryFetch,
        run: async (_command, args) => {
          calls.push(args)
          if (args.includes('--raw')) {
            return { code: 1, stdout: '', stderr: `ERROR: ${args.at(-1)}: not found` }
          }
          if (args.includes('image') && args.includes('inspect')) {
            return { code: 0, stdout: `${request.localImage.digest} []\n`, stderr: '' }
          }
          return { code: 0, stdout: `digest: ${digest}\n`, stderr: '' }
        },
      })
      await assert.rejects(
        provider.push(request),
        (error) => error.code === expectedCode,
      )
      assert.equal(calls.some((args) => args.includes('push')), false)
    })
  }
})

test('fresh repository first push treats a NAME_UNKNOWN tags list identifying the configured repository as absence', async () => {
  const calls = []
  const provider = new DockerRegistryProvider({
    config: {
      registry: 'registry.example.test',
      repository: 'team/deployhub',
      username: 'publisher',
      password: 'secret',
      immutableTags: true,
    },
    registryFetch: async (input) => {
      const url = new URL(input)
      if (url.pathname.endsWith('/tags/list')) {
        return Response.json({
          errors: [{
            code: 'NAME_UNKNOWN',
            message: 'repository name not known to registry',
            detail: { name: 'team/deployhub' },
          }],
        }, { status: 404 })
      }
      return Response.json({
        errors: [{ code: 'MANIFEST_UNKNOWN', message: 'manifest unknown', detail: { Tag: 'ignored' } }],
      }, { status: 404 })
    },
    run: async (_command, args) => {
      calls.push(args)
      if (args.includes('--raw')) {
        return { code: 1, stdout: '', stderr: `ERROR: ${args.at(-1)}: not found` }
      }
      if (args.includes('image') && args.includes('inspect')) {
        return { code: 0, stdout: `${request.localImage.digest} []\n`, stderr: '' }
      }
      return { code: 0, stdout: `digest: ${digest}\n`, stderr: '' }
    },
  })
  const result = await provider.push(request)
  assert.equal(result.registryDigest, digest)
  assert.equal(result.image, `registry.example.test/team/deployhub@${digest}`)
  assert.ok(calls.some((args) => args.includes('push')), 'the first push must reach docker push')
})

test('NAME_UNKNOWN tags list responses that do not identify the configured repository stay fail-closed', async (t) => {
  const cases = [
    ['mismatched repository identity', {
      errors: [{ code: 'NAME_UNKNOWN', message: 'repository name not known to registry', detail: { name: 'other/repository' } }],
    }],
    ['non-string repository identity', { errors: [{ code: 'NAME_UNKNOWN', detail: { name: 123 } }] }],
    ['missing repository identity', { errors: [{ code: 'NAME_UNKNOWN', message: 'repository name not known to registry' }] }],
    ['wrong error code', { errors: [{ code: 'MANIFEST_UNKNOWN', detail: { name: 'team/deployhub' } }] }],
    ['empty errors array', { errors: [] }],
  ]
  for (const [name, body] of cases) {
    await t.test(name, async () => {
      const calls = []
      const provider = new DockerRegistryProvider({
        config: {
          registry: 'registry.example.test',
          repository: 'team/deployhub',
          username: 'publisher',
          password: 'secret',
          immutableTags: true,
        },
        registryFetch: async (input) => {
          const url = new URL(input)
          if (url.pathname.endsWith('/tags/list')) {
            return Response.json(body, { status: 404 })
          }
          return Response.json({ errors: [{ code: 'MANIFEST_UNKNOWN', detail: { Tag: 'ignored' } }] }, { status: 404 })
        },
        run: async (_command, args) => {
          calls.push(args)
          if (args.includes('--raw')) {
            return { code: 1, stdout: '', stderr: `ERROR: ${args.at(-1)}: not found` }
          }
          if (args.includes('image') && args.includes('inspect')) {
            return { code: 0, stdout: `${request.localImage.digest} []\n`, stderr: '' }
          }
          return { code: 0, stdout: `digest: ${digest}\n`, stderr: '' }
        },
      })
      await assert.rejects(
        provider.push(request),
        (error) => error.code === 'REGISTRY_PUSH_FAILED',
      )
      assert.equal(calls.some((args) => args.includes('push')), false, 'a push must never follow an unverified tags list')
    })
  }
})

test('existing immutable tags are reused only when a supported image identity matches locally', async (t) => {
  for (const matches of [true, false]) {
    await t.test(matches ? 'matching config digest' : 'conflicting config digest', async () => {
      const calls = []
      const remoteManifest = JSON.stringify({
        schemaVersion: 2,
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        config: {
          mediaType: 'application/vnd.oci.image.config.v1+json',
          digest: matches ? request.localImage.digest : `sha256:${'f'.repeat(64)}`,
        },
        layers: [],
      })
      const provider = new DockerRegistryProvider({
        config: {
          registry: 'registry.example.test',
          repository: 'team/deployhub',
          username: 'publisher',
          password: 'secret',
          immutableTags: true,
        },
        registryFetch: missingManifestRegistryFetch(),
        run: async (_command, args) => {
          calls.push(args)
          if (args.includes('--raw')) {
            return { code: 0, stdout: remoteManifest, stderr: '' }
          }
          if (args.includes('image') && args.includes('inspect')) {
            return { code: 0, stdout: `${request.localImage.digest}\n`, stderr: '' }
          }
          return { code: 0, stdout: '', stderr: '' }
        },
      })
      if (matches) {
        const result = await provider.push(request)
        assert.equal(
          result.registryDigest,
          `sha256:${createHash('sha256').update(remoteManifest).digest('hex')}`,
        )
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

test('OCI manifest digest can match the local Docker image ID only when RepoDigests attests the same identity', async (t) => {
  const remoteManifest = JSON.stringify({
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    config: {
      mediaType: 'application/vnd.oci.image.config.v1+json',
      digest: `sha256:${'d'.repeat(64)}`,
    },
    layers: [],
  })
  const manifestDigest = `sha256:${createHash('sha256').update(remoteManifest).digest('hex')}`
  const localRequest = {
    ...request,
    localImage: { ...request.localImage, digest: manifestDigest },
  }
  for (const repoDigests of [
    [`deployhub-app@${manifestDigest}`],
    [],
  ]) {
    await t.test(repoDigests.length ? 'matching repo digest' : 'missing repo digest fails closed', async () => {
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
          if (args.includes('--raw')) return { code: 0, stdout: remoteManifest, stderr: '' }
          if (args.includes('image') && args.includes('inspect')) {
            return {
              code: 0,
              stdout: `${manifestDigest} ${JSON.stringify(repoDigests)}\n`,
              stderr: '',
            }
          }
          return { code: 0, stdout: '', stderr: '' }
        },
      })
      if (repoDigests.length) {
        const result = await provider.push(localRequest)
        assert.equal(result.registryDigest, manifestDigest)
      } else {
        await assert.rejects(
          provider.push(localRequest),
          (error) => error.code === 'DUPLICATE_EXECUTION',
        )
      }
      assert.equal(calls.some((args) => args.includes('push')), false)
    })
  }
})

test('existing OCI image indexes fail closed rather than reusing ambiguous manifests', async () => {
  const provider = new DockerRegistryProvider({
    config: {
      registry: 'registry.example.test',
      repository: 'team/deployhub',
      username: 'publisher',
      password: 'secret',
      immutableTags: true,
    },
    run: async (_command, args) => {
      if (args.includes('--raw')) {
        return {
          code: 0,
          stdout: JSON.stringify({
            schemaVersion: 2,
            mediaType: 'application/vnd.oci.image.index.v1+json',
            manifests: [{
              mediaType: 'application/vnd.oci.image.manifest.v1+json',
              digest: request.localImage.digest,
              platform: { os: 'linux', architecture: 'amd64' },
            }],
            config: {
              mediaType: 'application/vnd.oci.image.config.v1+json',
              digest: request.localImage.digest,
            },
            layers: [],
          }),
          stderr: '',
        }
      }
      if (args.includes('image') && args.includes('inspect')) {
        return { code: 0, stdout: `${request.localImage.digest} ["deployhub-app@${request.localImage.digest}"]\n`, stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    },
  })
  await assert.rejects(
    provider.push(request),
    (error) => error.code === 'REGISTRY_DIGEST_UNAVAILABLE',
  )
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
        registryFetch: missingManifestRegistryFetch(),
        run: async (_command, args) => {
          if (matches(args)) {
            return { code: exitCode, stdout: exitCode === 0 ? stderr : '', stderr }
          }
          if (args.includes('--raw')) return { code: 1, stdout: '', stderr: 'manifest unknown' }
          if (args.includes('image') && args.includes('inspect')) {
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
