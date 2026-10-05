import test from 'node:test'
import assert from 'node:assert/strict'
import { DockerCliRuntime } from './DockerCliRuntime.js'

const reference = 'deployhub-app:0123456789abcdef01234567'
const digest = `sha256:${'a'.repeat(64)}`

function createRuntime({ inspect = digest, archive = Buffer.from('image archive') } = {}) {
  const calls = []
  const runtime = new DockerCliRuntime({
    run: async (command, args, options) => {
      calls.push({ command, args, options })
      if (args[1] === 'inspect') {
        return { code: 0, stdout: `${inspect}\n`, stderr: '', outputBytes: inspect.length + 1 }
      }
      return { code: 0, stdout: archive, stderr: '', outputBytes: archive.length }
    },
  })
  return { runtime, calls }
}

test('exports only the locally verified application image by immutable ID with bounded output', async () => {
  const { runtime, calls } = createRuntime()
  const signal = new AbortController().signal
  const result = await runtime.exportApplicationImage({ reference, digest, timeoutMs: 30_000, signal })

  assert.deepEqual(result, {
    format: 'DOCKER_IMAGE_ARCHIVE',
    reference,
    digest,
    archive: Buffer.from('image archive'),
  })
  assert.deepEqual(calls.map(({ args }) => args), [
    ['image', 'inspect', reference, '--format', '{{.Id}}'],
    ['image', 'save', digest],
  ])
  assert.equal(calls[1].options.binaryOutput, true)
  assert.equal(calls[1].options.timeoutMs, 30_000)
  assert.equal(calls[1].options.maxOutputBytes, 512 * 1024 * 1024)
  assert.equal(calls[1].options.signal, signal)
})

test('refuses to export an image when its local identity does not match', async () => {
  const { runtime, calls } = createRuntime({ inspect: `sha256:${'b'.repeat(64)}` })
  await assert.rejects(
    runtime.exportApplicationImage({ reference, digest }),
    /does not match the expected immutable image ID/,
  )
  assert.equal(calls.some(({ args }) => args[1] === 'save'), false)
})

test('rejects failed or empty archive exports', async (t) => {
  await t.test('command failure', async () => {
    const runtime = new DockerCliRuntime({
      run: async (_command, args) => args[1] === 'inspect'
        ? { code: 0, stdout: `${digest}\n` }
        : { code: 1, stdout: Buffer.alloc(0) },
    })
    await assert.rejects(
      runtime.exportApplicationImage({ reference, digest }),
      /archive export failed or exceeded its size limit/,
    )
  })
  await t.test('empty archive', async () => {
    const { runtime } = createRuntime({ archive: Buffer.alloc(0) })
    await assert.rejects(
      runtime.exportApplicationImage({ reference, digest }),
      /archive export failed or exceeded its size limit/,
    )
  })
})

test('rejects invalid references, digests, and export timeouts', async (t) => {
  const { runtime, calls } = createRuntime()
  for (const input of [
    { reference: 'customer-image:latest', digest },
    { reference, digest: 'mutable-tag' },
    { reference, digest, timeoutMs: 120_001 },
  ]) {
    await t.test(JSON.stringify(input), async () => {
      await assert.rejects(
        runtime.exportApplicationImage(input),
        /export arguments are invalid/,
      )
    })
  }
  assert.equal(calls.length, 0)
})
