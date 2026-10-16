import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  ApplicationBuildError,
  NODE_APPLICATION_BASE_IMAGE,
  StaticNodeApplicationBuilder,
  extractStaticTar,
  validateHostOutput,
} from './StaticNodeApplicationBuilder.js'

function tarFixture() {
  const content = Buffer.from('<h1>fixture</h1>')
  const header = Buffer.alloc(512)
  header.write('index.html', 0, 100, 'utf8')
  header.write('0000644\0', 100, 8, 'ascii')
  header.write('0001000\0', 108, 8, 'ascii')
  header.write('0001000\0', 116, 8, 'ascii')
  header.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii')
  header.write('00000000000\0', 136, 12, 'ascii')
  header.fill(32, 148, 156)
  header[156] = '0'.charCodeAt(0)
  header.write('ustar\0', 257, 6, 'ascii')
  header.write('00', 263, 2, 'ascii')
  const checksum = header.reduce((sum, value) => sum + value, 0)
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
  const data = Buffer.alloc(Math.ceil(content.length / 512) * 512)
  content.copy(data)
  return Buffer.concat([header, data, Buffer.alloc(1024)])
}

function fakeRuntime({ guestResult = { ok: true }, imageConfig } = {}) {
  const calls = []
  return {
    calls,
    async exec(_container, args) {
      calls.push(['exec', args])
      return { code: 0, stdout: JSON.stringify(guestResult), stderr: '' }
    },
    async exportApplicationOutput(_container) {
      calls.push(['exportApplicationOutput'])
      return tarFixture()
    },
    async buildApplicationImage(options) {
      calls.push(['buildApplicationImage', options])
      const dockerfile = await readFile(path.join(options.contextDirectory, 'Dockerfile'), 'utf8')
      calls.push(['dockerfile', dockerfile])
      return {
        imageId: `sha256:${'a'.repeat(64)}`,
        config: imageConfig ?? {
          User: '1000:1000',
          Cmd: ['node', '/opt/deployhub/static-server.mjs'],
          WorkingDir: '/app',
          ExposedPorts: { '3000/tcp': {} },
          Env: ['NODE_VERSION=22.23.3', 'NODE_ENV=production', 'PORT=3000'],
        },
      }
    },
    async removeApplicationImage(reference) {
      calls.push(['removeApplicationImage', reference])
    },
  }
}

test('supports only dependency-free npm lockfile v3 projects with a build script', async () => {
  const runtime = fakeRuntime()
  const builder = new StaticNodeApplicationBuilder({ runtime })
  await builder.inspectProject('container-id', {}, 1000)
  assert.equal(runtime.calls[0][0], 'exec')
  assert.match(runtime.calls[0][1].at(-1), /DEPENDENCY_CACHE_UNAVAILABLE/)
  assert.match(runtime.calls[0][1].at(-1), /UNSUPPORTED_BUILD_CONFIGURATION/)
})

test('dependency cache failures and unsupported projects have distinct structured errors', async (t) => {
  for (const code of ['DEPENDENCY_CACHE_UNAVAILABLE', 'UNSUPPORTED_BUILD_CONFIGURATION']) {
    await t.test(code, async () => {
      const builder = new StaticNodeApplicationBuilder({
        runtime: fakeRuntime({ guestResult: { ok: false, code } }),
      })
      await assert.rejects(
        builder.inspectProject('container-id', {}, 1000),
        (error) => error instanceof ApplicationBuildError && error.code === code,
      )
    })
  }
})

test('creates an app image using only the pinned base, validated dist assets, and trusted static command', async () => {
  const runtime = fakeRuntime()
  const builder = new StaticNodeApplicationBuilder({ runtime })
  const artifact = await builder.createImage({
    containerId: 'a'.repeat(64),
    reference: 'deployhub-app:0123456789abcdef01234567',
    labels: {
      'org.opencontainers.image.revision': 'c'.repeat(40),
      'io.deployhub.deployment-id': '00000000-0000-4000-8000-000000000001',
      'io.deployhub.job-id': '00000000-0000-4000-8000-000000000002',
      'io.deployhub.lease-generation': '4',
    },
    policy: {},
    timeoutMs: 1000,
  })
  assert.deepEqual(artifact, {
    format: 'OCI_IMAGE',
    reference: 'deployhub-app:0123456789abcdef01234567',
    digest: `sha256:${'a'.repeat(64)}`,
  })
  const dockerfile = runtime.calls.find(([method]) => method === 'dockerfile')[1]
  assert.match(dockerfile, new RegExp(`^FROM ${NODE_APPLICATION_BASE_IMAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm'))
  assert.match(dockerfile, /COPY dist\/ \/app\/dist\//)
  assert.match(dockerfile, /USER 1000:1000/)
  assert.match(dockerfile, /CMD \["node", "\/opt\/deployhub\/static-server\.mjs"\]/)
  assert.doesNotMatch(dockerfile, /\bRUN\b/)
})

test('rejects symlinked static output and removes images with unsafe runtime configuration', async (t) => {
  await t.test('symlink output', async () => {
    const filesystem = {
      async readdir() {
        return [{ name: 'outside', isDirectory: () => false, isFile: () => false }]
      },
      async lstat(target) {
        return {
          isDirectory: () => target === 'dist',
          isSymbolicLink: () => target === path.join('dist', 'outside'),
          isFile: () => target === 'dist' ? false : false,
        }
      },
    }
    await assert.rejects(validateHostOutput('dist', filesystem), /symbolic links/)
  })

  test('validates archive paths, entry types, and checksums before extracting assets', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'static-tar-test-'))
    try {
      const output = path.join(root, 'dist')
      assert.deepEqual(await extractStaticTar(tarFixture(), output), { files: 1, bytes: 16 })
      assert.equal(await readFile(path.join(output, 'index.html'), 'utf8'), '<h1>fixture</h1>')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  await t.test('image config', async () => {
    const runtime = fakeRuntime({
      imageConfig: {
        User: '0:0',
        Cmd: ['sh', '-c', 'untrusted'],
        WorkingDir: '/',
        ExposedPorts: {},
        Env: ['JWT_SECRET=leaked'],
      },
    })
    const builder = new StaticNodeApplicationBuilder({ runtime })
    await assert.rejects(builder.createImage({
      containerId: 'a'.repeat(64),
      reference: 'deployhub-app:0123456789abcdef01234567',
      labels: {},
      policy: {},
      timeoutMs: 1000,
    }), /did not match the fixed runtime policy/)
    assert.ok(runtime.calls.some(([method]) => method === 'removeApplicationImage'))
  })
})
