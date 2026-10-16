import test from 'node:test'
import assert from 'node:assert/strict'
import {
  FakeSourceResolver,
  GitHubSourceResolver,
  MAX_GITHUB_RESPONSE_BYTES,
  SourceResolver,
  createConfiguredSourceResolver,
  resolveAndPersistSource,
  validateSourceResolution,
} from './executors/SourceResolver.js'

const input = {
  deploymentId: '00000000-0000-4000-8000-000000000001',
  jobId: '00000000-0000-4000-8000-000000000002',
  repository: 'https://github.com/example/project.git',
  requestedBranch: 'release/next',
}

test('source resolver interface fails closed until a resolver is implemented', async () => {
  await assert.rejects(new SourceResolver().resolve(input), /not implemented/)
})

test('fake source resolver returns a correlated immutable SHA without network or git operations', async () => {
  const resolver = new FakeSourceResolver({
    commitSha: 'b'.repeat(40),
    clock: () => new Date('2026-01-02T03:04:05.000Z'),
  })
  const result = await resolver.resolve(input)
  assert.deepEqual(result, {
    schemaVersion: 1,
    ...input,
    commitSha: 'b'.repeat(40),
    resolvedAt: '2026-01-02T03:04:05.000Z',
  })
  assert.equal(validateSourceResolution(result, input), result)
  assert.equal(input.requestedBranch, 'release/next')
})

test('trusted source resolution persists the validated SHA independently of requested branch intent', async () => {
  const calls = []
  const persisted = { value: null }
  const store = {
    async getSourceResolution() {
      return persisted.value
    },
    async recordSourceResolution(result, lease) {
      calls.push({ result, lease })
      persisted.value = { commitSha: result.commitSha, resolvedAt: result.resolvedAt }
      return persisted.value
    },
  }
  const resolved = await resolveAndPersistSource(
    new FakeSourceResolver({ commitSha: 'e'.repeat(64) }),
    store,
    input,
    { leaseGeneration: 5, workerId: 'worker-1' },
  )
  assert.equal(resolved.commitSha, 'e'.repeat(64))
  assert.equal(resolved.requestedBranch, 'release/next')
  assert.equal(calls[0].lease.leaseGeneration, 5)
  assert.equal(calls[0].lease.workerId, 'worker-1')
  assert.equal(calls[0].result.commitSha, resolved.commitSha)
})

test('GitHub resolver requests only the validated branch ref and returns an immutable commit SHA', async () => {
  const calls = []
  const resolver = new GitHubSourceResolver({
    token: 'github_pat_test-token',
    fetchImpl: async (url, options) => {
      calls.push({ url, options })
      return new Response(JSON.stringify({
        object: { type: 'commit', sha: 'F'.repeat(40) },
      }), { status: 200 })
    },
    clock: () => new Date('2026-02-03T04:05:06.000Z'),
  })

  const resolved = await resolver.resolve(input)
  assert.equal(calls[0].url, 'https://api.github.com/repos/example/project/git/ref/heads/release/next')
  assert.equal(calls[0].options.headers.Authorization, 'Bearer github_pat_test-token')
  assert.equal(calls[0].options.redirect, 'error')
  assert.equal(calls[0].options.signal.aborted, false)
  assert.equal(resolved.commitSha, 'f'.repeat(40))
  assert.equal(resolved.repository, input.repository)
  assert.equal(resolved.requestedBranch, input.requestedBranch)
})

test('GitHub source resolution fails closed on API errors and non-commit refs', async (t) => {
  for (const response of [
    new Response('Not found', { status: 404 }),
    new Response(JSON.stringify({ object: { type: 'tag', sha: 'a'.repeat(40) } }), { status: 200 }),
    new Response(JSON.stringify({ object: { type: 'commit', sha: 'invalid' } }), { status: 200 }),
  ]) {
    await t.test(`status ${response.status} / invalid ref`, async () => {
      const resolver = new GitHubSourceResolver({
        token: 'github_pat_test-token',
        fetchImpl: async () => response,
      })
      await assert.rejects(resolver.resolve(input), /Trusted GitHub source resolution failed/)
    })
  }
})

test('GitHub source resolver enforces timeout and a bounded response body', async (t) => {
  await t.test('timeout aborts the GitHub request', async () => {
    let aborted = false
    const resolver = new GitHubSourceResolver({
      token: 'github_pat_test-token',
      timeoutMs: 100,
      fetchImpl: (_url, { signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          aborted = true
          reject(new Error('aborted'))
        }, { once: true })
      }),
    })
    await assert.rejects(resolver.resolve(input), /Trusted GitHub source resolution failed/)
    assert.equal(aborted, true)
  })

  await t.test('oversized responses are rejected before JSON parsing', async () => {
    const resolver = new GitHubSourceResolver({
      token: 'github_pat_test-token',
      maxResponseBytes: 1024,
      fetchImpl: async () => new Response(JSON.stringify({
        object: { type: 'commit', sha: 'a'.repeat(40) },
        padding: 'x'.repeat(2048),
      }), { status: 200 }),
    })
    await assert.rejects(resolver.resolve(input), /Trusted GitHub source resolution failed/)
    assert.equal(MAX_GITHUB_RESPONSE_BYTES, 16 * 1024)
  })
})

test('source resolver configuration and credentials are required, and secrets are not included in failures', async () => {
  assert.equal(createConfiguredSourceResolver({ resolverName: 'disabled', token: 'token' }), null)
  assert.equal(createConfiguredSourceResolver({ resolverName: 'github', token: '' }), null)
  assert.throws(() => new GitHubSourceResolver({ token: '' }), /credentials are missing/)
  const resolver = new GitHubSourceResolver({
    token: 'github_pat_never-leak-this',
    fetchImpl: async () => new Response('private body', { status: 500 }),
  })
  await assert.rejects(resolver.resolve(input), (error) => {
    assert.doesNotMatch(error.message, /never-leak-this|private body/)
    return true
  })
})

test('persisted source pins are reused, while mismatches and stale leases fail before execution', async (t) => {
  const pinned = { commitSha: 'e'.repeat(40), resolvedAt: '2026-02-03T04:05:06.000Z' }
  await t.test('reuses the exact persisted SHA without resolving the branch again', async () => {
    let resolveCalls = 0
    const result = await resolveAndPersistSource({
      async resolve() { resolveCalls += 1; throw new Error('must not resolve again') },
    }, {
      async getSourceResolution() { return pinned },
      async recordSourceResolution() { throw new Error('must not rewrite source') },
    }, input, { leaseGeneration: 2, workerId: 'worker-2' })
    assert.equal(result.commitSha, pinned.commitSha)
    assert.equal(resolveCalls, 0)
  })

  await t.test('rejects a persisted SHA that differs from the resolved SHA', async () => {
    const store = {
      async getSourceResolution() { return null },
      async recordSourceResolution() { return { ...pinned, commitSha: 'f'.repeat(40) } },
    }
    await assert.rejects(resolveAndPersistSource(
      new FakeSourceResolver({ commitSha: 'e'.repeat(40) }),
      store,
      input,
      { leaseGeneration: 2, workerId: 'worker-2' },
    ), /does not match/)
  })

  await t.test('stale lease is rejected before resolver access', async () => {
    let resolveCalls = 0
    await assert.rejects(resolveAndPersistSource({
      async resolve() { resolveCalls += 1; return null },
    }, {
      async getSourceResolution() { throw new Error('stale lease generation') },
      async recordSourceResolution() { throw new Error('must not persist') },
    }, input, { leaseGeneration: 2, workerId: 'worker-2' }), /stale lease/)
    assert.equal(resolveCalls, 0)
  })

  await t.test('null SHA is rejected as unpinned', async () => {
    await assert.rejects(resolveAndPersistSource({
      async resolve() {
        return {
          schemaVersion: 1,
          ...input,
          commitSha: null,
          resolvedAt: '2026-02-03T04:05:06.000Z',
        }
      },
    }, {
      async getSourceResolution() { return null },
      async recordSourceResolution() { throw new Error('must not persist') },
    }, input, { leaseGeneration: 2, workerId: 'worker-2' }), /does not match/)
  })
})

test('source resolution rejects malformed SHA, repository, branch, and mismatched correlation', async () => {
  await assert.rejects(
    new FakeSourceResolver({ commitSha: 'not-a-sha' }).resolve(input),
    /SHA is invalid/,
  )
  await assert.rejects(
    new FakeSourceResolver().resolve({ ...input, repository: 'https://example.test/owner/repo' }),
  )
  await assert.rejects(
    new FakeSourceResolver().resolve({ ...input, requestedBranch: '../unsafe' }),
  )
  const result = await new FakeSourceResolver().resolve(input)
  assert.throws(
    () => validateSourceResolution(result, { ...input, requestedBranch: 'main' }),
    /does not match/,
  )
})
