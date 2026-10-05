import test from 'node:test'
import assert from 'node:assert/strict'
import { CommandOutputLimitError, CommandTimeoutError } from './boundedCommand.js'
import {
  assertDockerIsolation,
  buildDockerCreateArgs,
} from './DockerCliRuntime.js'
import { ApplicationBuildError } from './StaticNodeApplicationBuilder.js'
import { IsolatedVmSupervisor } from './IsolatedVmSupervisor.js'
import { IsolatedVmExecutionProvider } from './IsolatedVmExecutionProvider.js'
import { EXECUTION_INPUT_VERSION } from './ExecutionProvider.js'

const deploymentId = '00000000-0000-4000-8000-000000000001'
const jobId = '00000000-0000-4000-8000-000000000002'
const workerId = '00000000-0000-4000-8000-000000000003'
const executionId = 'ivm_test_execution'
const leaseGeneration = 5
const commitSha = 'c'.repeat(40)
const image = `deployhub-node-builder@sha256:${'a'.repeat(64)}`

function input(overrides = {}) {
  return {
    schemaVersion: EXECUTION_INPUT_VERSION,
    deploymentId,
    jobId,
    leaseGeneration: 5,
    repository: 'https://github.com/example/project.git',
    requestedBranch: 'main',
    commitSha,
    buildMode: 'NODE_NPM_OFFLINE',
    resourcePolicy: {
      cpuMilli: 1250,
      memoryMb: 768,
      diskMb: 512,
      pidLimit: 64,
      timeoutMs: 5000,
      logBytes: 4096,
    },
    networkPolicy: 'NO_NETWORK',
    ...overrides,
  }
}

function correlation(overrides = {}) {
  return {
    deploymentId,
    jobId,
    leaseGeneration: 5,
    executionId,
    ...overrides,
  }
}

function createRuntime({
  behavior = {},
  cleanupFailures = 0,
  output = '',
} = {}) {
  const calls = []
  let cleanupFailureCount = cleanupFailures
  const runtime = {
    calls,
    async create(options) {
      calls.push(['create', options])
      return 'a'.repeat(64)
    },
    async assertIsolation(id, received) {
      calls.push(['assertIsolation', id, received.resourcePolicy])
      return true
    },
    async start(id, policy) {
      calls.push(['start', id, policy])
    },
    async copySource(id, source, policy) {
      calls.push(['copySource', id, source, policy])
    },
    async exec(id, args, options) {
      calls.push(['exec', id, args, options])
      if (behavior[args.at(-1)] instanceof Error) throw behavior[args.at(-1)]
      if (args.includes('rev-parse')) {
        return { code: 0, stdout: `${behavior.actualSha ?? commitSha}\n`, stderr: '' }
      }
      if (args.includes('build') && behavior.buildExitCode) {
        return { code: behavior.buildExitCode, stdout: 'build failed', stderr: '' }
      }
      if (args.includes('ci') && behavior.installExitCode) {
        return { code: behavior.installExitCode, stdout: 'install failed', stderr: '' }
      }
      return { code: 0, stdout: output, stderr: '' }
    },
    async stop(id, policy) {
      calls.push(['stop', id, policy])
    },
    async remove(id, policy) {
      calls.push(['remove', id, policy])
      if (cleanupFailureCount > 0) {
        cleanupFailureCount -= 1
        throw new Error('cleanup failed')
      }
    },
    async listDeployHubContainers() {
      return []
    },
    async inspectLabels() {
      throw new Error('not expected in this test')
    },
  }
  return { calls, runtime }
}

function createFetcher({ fail = false } = {}) {
  const calls = []
  return {
    calls,
    fetch: async (...args) => {
      calls.push(args)
      if (fail) throw new Error('Git is unavailable')
      return {
        directory: 'C:\\temp\\trusted-bare-git',
        async cleanup() {
          calls.push(['cleanup'])
        },
      }
    },
  }
}

function createApplicationBuilder({ behavior = {} } = {}) {
  const calls = []
  return {
    calls,
    async inspectProject(...args) {
      calls.push(['inspectProject', ...args])
      if (behavior.projectError) throw behavior.projectError
    },
    async validateOutput(...args) {
      calls.push(['validateOutput', ...args])
      if (behavior.outputError) throw behavior.outputError
      return { files: 1, bytes: 20 }
    },
    async createImage(options) {
      calls.push(['createImage', options])
      if (behavior.imageError) throw behavior.imageError
      return {
        format: 'OCI_IMAGE',
        reference: options.reference,
        digest: `sha256:${'f'.repeat(64)}`,
      }
    },
  }
}

function createSupervisor({
  enabled = true,
  imageName = image,
  behavior,
  cleanupFailures = 0,
  output,
  fetcher,
  applicationBehavior,
} = {}) {
  const { runtime, calls } = createRuntime({ behavior, cleanupFailures, output })
  const sourceFetcher = fetcher ?? createFetcher()
  const applicationBuilder = createApplicationBuilder({ behavior: applicationBehavior })
  const supervisor = new IsolatedVmSupervisor({
    enabled,
    image: imageName,
    runtime,
    applicationBuilder,
    sourceFetcher,
    clock: () => new Date('2026-02-03T04:05:06.000Z'),
  })
  return { calls, runtime, sourceFetcher, applicationBuilder, supervisor }
}

async function provisionAndStart(supervisor, executionInput = input()) {
  const execution = await supervisor.provision(executionInput, correlation())
  await supervisor.start(execution, correlation())
  return execution
}

test('runtime unavailable fails closed when disabled, image is unpinned, Docker, or Git is unavailable', async (t) => {
  for (const config of [
    { enabled: false },
    { imageName: 'latest' },
    { fetcher: createFetcher({ fail: true }) },
  ]) {
    await t.test(JSON.stringify(config), async () => {
      const { supervisor, calls } = createSupervisor(config)
      await assert.rejects(supervisor.provision(input(), correlation()), /RUNTIME_UNAVAILABLE|Git source acquisition failed/)
      assert.equal(calls.some(([method]) => method === 'create'), false)
    })
  }
})

test('successful isolated runtime checks out and verifies only the persisted immutable SHA', async () => {
  const { supervisor, calls, sourceFetcher } = createSupervisor()
  const execution = await provisionAndStart(supervisor)
  const snapshot = await supervisor.monitor(execution, correlation())

  assert.equal(snapshot.state, 'COMPLETED')
  assert.equal(snapshot.result.outcome, 'SUCCESS')
  assert.equal(snapshot.result.commitSha, commitSha)
  assert.equal(snapshot.result.artifact.format, 'OCI_IMAGE')
  assert.match(snapshot.result.artifact.digest, /^sha256:/)
  assert.deepEqual(sourceFetcher.calls[0].slice(0, 2), [
    'https://github.com/example/project.git',
    commitSha,
  ])
  assert.equal(sourceFetcher.calls[0].includes('main'), false)
  const commands = calls.filter(([method]) => method === 'exec').map(([, , args]) => args)
  assert.ok(commands.some((args) => args.includes('checkout') && args.includes(commitSha)))
  assert.ok(commands.some((args) => args.includes('rev-parse')))
  assert.ok(commands.some((args) => args.includes('ci') && args.includes('--offline')
    && args.includes('--ignore-scripts') && args.includes('/opt/deployhub/npm-cache')))
  assert.ok(commands.some((args) => args.includes('run') && args.includes('build')))
  assert.ok(calls.some(([method]) => method === 'stop'))
  assert.equal(calls.filter(([method]) => method === 'remove').length, 0)
})

test('build failure, timeout, cancellation, SHA mismatch, and output excess stop the runtime', async (t) => {
  const scenarios = [
    ['build failure', { behavior: { buildExitCode: 1 } }, /build failed/i],
    ['timeout', { behavior: { build: new CommandTimeoutError() } }, /timeout/i],
    ['output limit', { output: 'x'.repeat(5000) }, /output limit/i],
    ['SHA mismatch', { behavior: { actualSha: 'd'.repeat(40) } }, /source SHA/i],
  ]
  for (const [name, config, error] of scenarios) {
    await t.test(name, async () => {
      const { supervisor, calls } = createSupervisor(config)
      const execution = await provisionAndStart(supervisor)
      const snapshot = await supervisor.monitor(execution, correlation())
      assert.equal(snapshot.state, 'FAILED')
      assert.match(snapshot.result.error, error)
      assert.ok(calls.some(([method]) => method === 'stop'))
      assert.equal(await supervisor.cleanup(execution, correlation()), true)
      assert.ok(calls.some(([method]) => method === 'remove'))
    })
  }

  await t.test('cancellation terminates the active container and remains repeatable', async () => {
    const { supervisor, calls } = createSupervisor()
    const execution = await provisionAndStart(supervisor)
    await supervisor.terminate(execution, correlation())
    await supervisor.terminate(execution, correlation())
    const snapshot = await supervisor.monitor(execution, correlation())
    assert.equal(snapshot.state, 'CANCELLED')
    assert.equal(snapshot.result.outcome, 'FAILURE')
    assert.equal(calls.filter(([method]) => method === 'stop').length, 1)
    assert.equal(await supervisor.cleanup(execution, correlation()), true)
    assert.equal(calls.filter(([method]) => method === 'remove').length, 1)
  })
})

test('output cap failures and memory/CPU/PID/workspace limits are enforced', async () => {
  const { supervisor, calls } = createSupervisor({ behavior: { build: new CommandOutputLimitError() } })
  const execution = await provisionAndStart(supervisor)
  const snapshot = await supervisor.monitor(execution, correlation())
  assert.match(snapshot.result.error, /output limit/)
  const create = calls.find(([method]) => method === 'create')[1]
  assert.equal(create.input.resourcePolicy.cpuMilli, 1250)
  assert.equal(create.input.resourcePolicy.memoryMb, 768)
  assert.equal(create.input.resourcePolicy.pidLimit, 64)
  assert.equal(create.input.resourcePolicy.diskMb, 512)
  assert.deepEqual(calls.find(([method]) => method === 'assertIsolation')[2], create.input.resourcePolicy)
})

test('cleanup is idempotent after success and retains cleanup failure for retry', async (t) => {
  await t.test('success', async () => {
    const { supervisor, calls, sourceFetcher } = createSupervisor()
    const execution = await provisionAndStart(supervisor)
    await supervisor.monitor(execution, correlation())
    assert.equal(await supervisor.cleanup(execution, correlation()), true)
    assert.equal(await supervisor.cleanup(execution, correlation()), true)
    assert.equal(calls.filter(([method]) => method === 'remove').length, 1)
    assert.equal(sourceFetcher.calls.filter(([method]) => method === 'cleanup').length, 1)
  })
  await t.test('failure remains explicit and cleanup can be retried', async () => {
    const { supervisor, calls } = createSupervisor({ cleanupFailures: 1 })
    const execution = await provisionAndStart(supervisor)
    await supervisor.monitor(execution, correlation())
    await assert.rejects(supervisor.cleanup(execution, correlation()), /cleanup failed/)
    assert.equal(await supervisor.cleanup(execution, correlation()), true)
    assert.equal(calls.filter(([method]) => method === 'remove').length, 2)
  })
})

test('unsupported network policy, unpinned SHA, stale correlation, and duplicate execution are safe', async (t) => {
  await t.test('network access is rejected before fetching source', async () => {
    const { supervisor, sourceFetcher } = createSupervisor()
    await assert.rejects(
      supervisor.provision(input({ networkPolicy: 'EGRESS_PROXY' }), correlation()),
      /network policy cannot be safely enforced/,
    )
    assert.equal(sourceFetcher.calls.length, 0)
  })

  test('unsupported Node configuration and missing npm cache produce structured failures before image creation', async (t) => {
    for (const [code, message] of [
      ['UNSUPPORTED_BUILD_CONFIGURATION', 'Only dependency-free npm projects'],
      ['DEPENDENCY_CACHE_UNAVAILABLE', 'Required npm dependency cache'],
    ]) {
      await t.test(code, async () => {
        const { supervisor, applicationBuilder, calls } = createSupervisor({
          applicationBehavior: {
            projectError: new ApplicationBuildError(code, message),
          },
        })
        const execution = await provisionAndStart(supervisor)
        const result = await supervisor.monitor(execution, correlation())
        assert.equal(result.state, 'FAILED')
        assert.equal(result.result.failureCode, code)
        assert.match(result.result.error, new RegExp(message))
        assert.equal(applicationBuilder.calls.some(([method]) => method === 'createImage'), false)
        assert.equal(calls.some(([method, , args]) => method === 'exec'
          && Array.isArray(args) && args.includes('npm')), false)
      })
    }
  })
  await t.test('unresolved source SHA is rejected', async () => {
    const { supervisor, sourceFetcher } = createSupervisor()
    await assert.rejects(supervisor.provision(input({ commitSha: null }), correlation()), /Immutable source SHA/)
    assert.equal(sourceFetcher.calls.length, 0)
  })
  await t.test('stale lease generation is fenced', async () => {
    const { supervisor, calls } = createSupervisor()
    const execution = await provisionAndStart(supervisor)
    await assert.rejects(
      supervisor.terminate(execution, correlation({ leaseGeneration: leaseGeneration + 1 })),
      /correlation is stale/,
    )
    assert.equal(calls.some(([method]) => method === 'stop'), false)
  })
  await t.test('lease guard is checked before source fetch', async () => {
    const fetcher = createFetcher()
    const { supervisor, calls } = createSupervisor({ fetcher })
    await assert.rejects(supervisor.provision(input(), correlation(), {
      async assertLease() {
        const error = new Error('stale')
        error.code = 'STALE_LEASE'
        throw error
      },
    }), /lease became stale/)
    assert.equal(fetcher.calls.length, 0)
    assert.equal(calls.some(([method]) => method === 'create'), false)
  })
  await t.test('duplicate execution is idempotent, conflicting SHA rejected', async () => {
    const { supervisor, calls, sourceFetcher } = createSupervisor()
    const first = await supervisor.provision(input(), correlation())
    const duplicate = await supervisor.provision(input(), correlation())
    assert.deepEqual(duplicate, first)
    assert.equal(calls.filter(([method]) => method === 'create').length, 1)
    assert.equal(sourceFetcher.calls.length, 1)
    await assert.rejects(
      supervisor.provision(input({ commitSha: 'd'.repeat(40) }), correlation()),
      /conflicts with its original input/,
    )
  })
})

test('configured provider reaches the real supervisor without exposing Deployment-state access', async () => {
  const { supervisor, calls } = createSupervisor()
  const storeCalls = []
  const executionStore = {
    async reserveExecution(value) { storeCalls.push(['reserve', value]) },
    async recordProviderExecution(value) { storeCalls.push(['provider-id', value]) },
    async getSourceResolution() { return { commitSha } },
    async updateExecution(value) { storeCalls.push(['update', value]) },
  }
  const provider = new IsolatedVmExecutionProvider({
    enabled: true,
    supervisor,
    executionStore,
  })
  const started = await provider.start(input(), {
    id: jobId,
    deployment_id: deploymentId,
    worker_id: workerId,
    lease_generation: 5,
  })
  assert.equal(started.status, 'RUNNING')
  const progress = []
  for await (const event of provider.streamProgress(started.executionId)) progress.push(event)
  const result = await provider.collectResult(started.executionId)
  assert.equal(result.outcome, 'SUCCESS')
  assert.equal(result.commitSha, commitSha)
  assert.ok(progress.some(({ stage }) => stage === 'BUILDING_APPLICATION'))
  assert.equal(storeCalls[0][1].leaseGeneration, 5)
  assert.equal(storeCalls.at(-1)[1].status, 'SUCCEEDED')
  assert.equal(calls.some(([method]) => method === 'create'), true)
  await provider.cleanup(started.executionId)
})

test('provider rejects a stale persisted source lease before starting the runtime', async () => {
  const { supervisor, calls } = createSupervisor()
  let sourceLookups = 0
  const provider = new IsolatedVmExecutionProvider({
    enabled: true,
    supervisor,
    executionStore: {
      async reserveExecution() {},
      async recordProviderExecution() {},
      async updateExecution() {},
      async getSourceResolution() {
        sourceLookups += 1
        if (sourceLookups === 1) return { commitSha }
        return null
      },
    },
  })
  const started = await provider.start(input(), {
    id: jobId,
    deployment_id: deploymentId,
    worker_id: workerId,
    lease_generation: leaseGeneration,
  })
  assert.equal(started.status, 'FAILED')
  assert.equal(sourceLookups, 2)
  assert.equal(calls.some(([method]) => method === 'start'), false)
  await provider.cleanup(started.executionId)
})

test('reconciliation finds and cleans Docker executions left by a worker crash', async () => {
  const metadata = {
    labels: {
      'deployhub.deployment_id': deploymentId,
      'deployhub.execution_id': executionId,
      'deployhub.job_id': jobId,
      'deployhub.lease_generation': String(leaseGeneration),
      'deployhub.commit_sha': commitSha,
    },
    running: true,
  }
  const { supervisor, calls, runtime } = createSupervisor()
  runtime.listDeployHubContainers = async () => ['b'.repeat(64)]
  runtime.inspectLabels = async () => metadata
  const [snapshot] = await supervisor.reconcileAbandonedExecutions()
  assert.equal(snapshot.state, 'RUNNING')
  assert.equal(snapshot.executionId, executionId)
  const recoveredCorrelation = {
    deploymentId,
    jobId,
    leaseGeneration,
    executionId,
  }
  await supervisor.terminate({ providerExecutionId: 'b'.repeat(64) }, recoveredCorrelation)
  await supervisor.cleanup({ providerExecutionId: 'b'.repeat(64) }, recoveredCorrelation)
  assert.equal(calls.some(([method]) => method === 'stop'), true)
  assert.equal(calls.some(([method]) => method === 'remove'), true)
})

test('Docker request and inspect policy prohibit privileged mode, host mounts, networking and credential leakage', () => {
  const executionInput = input()
  const args = buildDockerCreateArgs({
    image,
    input: executionInput,
    correlation: correlation(),
    name: 'deployhub-test',
  })
  assert.ok(args.includes('--network') && args[args.indexOf('--network') + 1] === 'none')
  assert.ok(args.includes('--read-only'))
  assert.ok(args.includes('--cap-drop') && args[args.indexOf('--cap-drop') + 1] === 'ALL')
  assert.ok(args.includes('--pids-limit') && args[args.indexOf('--pids-limit') + 1] === '64')
  assert.ok(args.includes('--memory') && args[args.indexOf('--memory') + 1] === '768m')
  assert.ok(args.includes('--cpus') && args[args.indexOf('--cpus') + 1] === '1.250')
  assert.equal(args.some((arg) => /docker\.sock|DATABASE_URL|JWT_SECRET|GITHUB_SOURCE_TOKEN|REGISTRY_(?:USERNAME|PASSWORD|TOKEN)|AWS_/i.test(arg)), false)
  assert.equal(args.includes('--privileged'), false)
  assert.equal(args.includes('--volume'), false)
  assert.equal(args.includes('--mount'), false)

  const safeInspect = {
    HostConfig: {
      Privileged: false,
      NetworkMode: 'none',
      Binds: [],
      VolumesFrom: [],
      Mounts: [],
      PortBindings: {},
      ReadonlyRootfs: true,
      Memory: 768 * 1024 * 1024,
      MemorySwap: 768 * 1024 * 1024,
      PidsLimit: 64,
      NanoCpus: 1_250_000_000,
      StorageOpt: { size: '512m' },
      Tmpfs: { '/workspace': 'rw,size=512m,mode=1777' },
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
    },
    Config: { User: '1000:1000', Env: ['PATH=/usr/bin', 'HOME=/tmp'] },
  }
  assert.equal(assertDockerIsolation(safeInspect, executionInput), true)
  for (const changed of [
    { ...safeInspect, HostConfig: { ...safeInspect.HostConfig, Privileged: true } },
    { ...safeInspect, HostConfig: { ...safeInspect.HostConfig, NetworkMode: 'bridge' } },
    { ...safeInspect, HostConfig: { ...safeInspect.HostConfig, Binds: ['/var/run/docker.sock:/var/run/docker.sock'] } },
    { ...safeInspect, HostConfig: { ...safeInspect.HostConfig, PidsLimit: 0 } },
    { ...safeInspect, Config: { ...safeInspect.Config, Env: ['DATABASE_URL=leaked'] } },
    { ...safeInspect, Config: { ...safeInspect.Config, Env: ['REGISTRY_USERNAME=leaked'] } },
    { ...safeInspect, Config: { ...safeInspect.Config, Env: ['REGISTRY_PASSWORD=leaked'] } },
  ]) {
    assert.throws(() => assertDockerIsolation(changed, executionInput), /does not enforce/)
  }
})
