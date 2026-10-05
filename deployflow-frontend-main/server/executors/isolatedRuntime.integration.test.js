import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { DockerCliRuntime } from './DockerCliRuntime.js'
import {
  CommandOutputLimitError,
  CommandTimeoutError,
  runBoundedCommand,
} from './boundedCommand.js'
import { StaticNodeApplicationBuilder } from './StaticNodeApplicationBuilder.js'

const image = process.env.ISOLATED_EXECUTOR_IMAGE
const enabled = process.env.RUN_ISOLATED_RUNTIME_INTEGRATION === 'true' && Boolean(image)

test('Docker integration enforces the isolated runtime configuration without customer code', {
  skip: !enabled && 'Set RUN_ISOLATED_RUNTIME_INTEGRATION=true and ISOLATED_EXECUTOR_IMAGE to a preloaded digest-pinned image.',
}, async () => {
  const runtime = new DockerCliRuntime()
  const id = randomUUID()
  const input = {
    commitSha: 'a'.repeat(40),
    resourcePolicy: {
      cpuMilli: 250,
      memoryMb: 256,
      diskMb: 128,
      pidLimit: 32,
      timeoutMs: 10_000,
      logBytes: 16_384,
    },
  }
  const correlation = {
    executionId: `integration-${id}`,
    deploymentId: '00000000-0000-4000-8000-000000000001',
    jobId: '00000000-0000-4000-8000-000000000002',
    leaseGeneration: 1,
  }
  let containerId
  let applicationImage
  let applicationContainer
  try {
    containerId = await runtime.create({
      image,
      input,
      correlation,
      name: `deployhub-it-${id.slice(0, 12)}`,
    })
    await runtime.assertIsolation(containerId, input)
    await runtime.start(containerId, input.resourcePolicy)
    const running = await runtime.inspectLabels(containerId, input.resourcePolicy)
    assert.equal(running.running, true)

    const identity = await runtime.exec(containerId, [
      '/bin/sh', '-c',
      'test "$(id -u)" = 1000 && test -r /opt/deployhub/npm-cache && test -w /opt/deployhub/npm-cache && node --version && npm --version && git --version && /bin/sleep 1',
    ], { policy: input.resourcePolicy, timeoutMs: 5000 })
    assert.equal(identity.code, 0)
    assert.match(identity.stdout, /v22\./)

    const dependencyFreeInstall = await runtime.exec(containerId, [
      '/bin/sh', '-c',
      `printf '%s\\n' '{"name":"runtime-smoke","version":"1.0.0","private":true}' > package.json && printf '%s\\n' '{"name":"runtime-smoke","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"runtime-smoke","version":"1.0.0"}}}' > package-lock.json && npm ci --offline --ignore-scripts --cache /opt/deployhub/npm-cache --logs-max=0`,
    ], { policy: input.resourcePolicy, timeoutMs: 20_000 })
    assert.equal(dependencyFreeInstall.code, 0)

    const syntheticBuildOutput = await runtime.exec(containerId, [
      '/bin/sh', '-c', `mkdir -p /workspace/dist && printf '%s' '<h1>Isolated image smoke test</h1>' > /workspace/dist/index.html`,
    ], { policy: input.resourcePolicy, timeoutMs: 5000 })
    assert.equal(syntheticBuildOutput.code, 0)
    const applicationBuilder = new StaticNodeApplicationBuilder({ runtime })
    const outputStatus = await applicationBuilder.validateOutput(
      containerId, input.resourcePolicy, 5000,
    )
    assert.equal(outputStatus.files, 1)

    await assert.rejects(runtime.exec(containerId, [
      '/bin/sh', '-c', "printf '%32768s' x",
    ], { policy: input.resourcePolicy, timeoutMs: 5000 }), CommandOutputLimitError)
    await assert.rejects(runtime.exec(containerId, [
      '/bin/sh', '-c', '/bin/sleep 30',
    ], { policy: input.resourcePolicy, timeoutMs: 500 }), CommandTimeoutError)

    applicationImage = await applicationBuilder.createImage({
      containerId,
      reference: `deployhub-app:${id.replaceAll('-', '').slice(0, 24)}`,
      labels: {
        'org.opencontainers.image.revision': input.commitSha,
        'io.deployhub.deployment-id': correlation.deploymentId,
        'io.deployhub.job-id': correlation.jobId,
        'io.deployhub.lease-generation': '1',
      },
      policy: input.resourcePolicy,
      timeoutMs: 20_000,
    })
    assert.match(applicationImage.digest, /^sha256:[0-9a-f]{64}$/i)
    await runtime.stop(containerId, input.resourcePolicy)
    const stopped = await runtime.inspectLabels(containerId, input.resourcePolicy)
    assert.equal(stopped.running, false)

    applicationContainer = `deployhub-app-it-${id.slice(0, 12)}`
    const createApp = await runBoundedCommand(process.env.DOCKER_EXECUTABLE || 'docker', [
      'create',
      '--name', applicationContainer,
      '--network', 'none',
      '--cpus', '0.250',
      '--memory', '256m',
      '--memory-swap', '256m',
      '--pids-limit', '32',
      '--read-only',
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '--user', '1000:1000',
      '--tmpfs', '/tmp:rw,size=64m,noexec,nosuid,nodev,mode=1777',
      '--env', 'HOME=/tmp',
      '--env', 'PORT=3000',
      applicationImage.reference,
    ], { timeoutMs: 10_000, maxOutputBytes: 8192 })
    assert.equal(createApp.code, 0)
    const appContainerId = createApp.stdout.trim()
    try {
      const startApp = await runBoundedCommand(process.env.DOCKER_EXECUTABLE || 'docker', [
        'start', appContainerId,
      ], { timeoutMs: 10_000, maxOutputBytes: 8192 })
      assert.equal(startApp.code, 0)
      const requestApp = await runBoundedCommand(process.env.DOCKER_EXECUTABLE || 'docker', [
        'exec', '--workdir', '/app', appContainerId, 'node', '-e',
        "const end=Date.now()+5000; async function check(){try{const r=await fetch('http://127.0.0.1:3000/'); const body=await r.text(); if(r.ok && body.includes('Isolated image smoke test')) process.exit(0); process.stdout.write('status='+r.status+' body='+body)}catch(e){process.stdout.write('fetch='+e.message)} if(Date.now()<end)setTimeout(check,100);else process.exit(1)} check()",
      ], { timeoutMs: 8000, maxOutputBytes: input.resourcePolicy.logBytes })
      if (requestApp.code !== 0) {
        const logs = await runBoundedCommand(process.env.DOCKER_EXECUTABLE || 'docker', [
          'logs', appContainerId,
        ], { timeoutMs: 5000, maxOutputBytes: input.resourcePolicy.logBytes })
        const files = await runBoundedCommand(process.env.DOCKER_EXECUTABLE || 'docker', [
          'exec', appContainerId, 'node', '-e',
          "const fs=require('node:fs'); try { process.stdout.write(fs.readdirSync('/app/dist').join(',')+' '+fs.readFileSync('/app/dist/index.html','utf8')) } catch(e) { process.stdout.write(e.message) }",
        ], { timeoutMs: 5000, maxOutputBytes: input.resourcePolicy.logBytes })
        assert.fail(`Application image HTTP smoke test failed: ${requestApp.stderr}${requestApp.stdout}${files.stderr}${files.stdout}${logs.stderr}${logs.stdout}`)
      }
    } finally {
      await runBoundedCommand(process.env.DOCKER_EXECUTABLE || 'docker', [
        'rm', '--force', appContainerId,
      ], { timeoutMs: 10_000, maxOutputBytes: 8192 })
    }
  } finally {
    if (containerId) await runtime.remove(containerId, input.resourcePolicy)
    if (applicationImage) await runtime.removeApplicationImage(applicationImage.reference, input.resourcePolicy)
  }
  await assert.rejects(runtime.inspectLabels(containerId, input.resourcePolicy))
})
