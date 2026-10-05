import { runBoundedCommand } from './boundedCommand.js'
import path from 'node:path'

const DOCKER_ID_PATTERN = /^[0-9a-f]{12,64}$/i
const RUNTIME_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'

export class DockerCliRuntime {
  #command

  constructor({ command = process.env.DOCKER_EXECUTABLE || 'docker' } = {}) {
    if (typeof command !== 'string' || !command) throw new TypeError('Docker executable is invalid.')
    this.#command = command
  }

  async create({ image, input, correlation, name }) {
    const args = buildDockerCreateArgs({ image, input, correlation, name })
    const result = await this.#run(args, input.resourcePolicy)
    const id = result.stdout.trim()
    if (result.code !== 0 || !DOCKER_ID_PATTERN.test(id)) {
      throw new Error('Docker did not create a valid isolated runtime.')
    }
    return id
  }

  async assertIsolation(containerId, input) {
    validateContainerId(containerId)
    const result = await this.#run(['inspect', containerId], input.resourcePolicy)
    if (result.code !== 0) throw new Error('Docker isolation settings could not be verified.')
    let inspected
    try {
      inspected = JSON.parse(result.stdout)[0]
    } catch {
      throw new Error('Docker returned malformed isolation metadata.')
    }
    assertDockerIsolation(inspected, input)
    return true
  }

  async start(containerId, policy) {
    validateContainerId(containerId)
    const result = await this.#run(['start', containerId], policy)
    if (result.code !== 0) throw new Error('Docker runtime could not be started.')
    return true
  }

  async copySource(containerId, sourceDirectory, policy) {
    validateContainerId(containerId)
    const result = await this.#run(['cp', sourceDirectory, `${containerId}:/workspace/.git`], policy)
    if (result.code !== 0) throw new Error('Source could not be copied into the isolated workspace.')
    return true
  }

  async exportApplicationOutput(containerId, { timeoutMs, signal } = {}) {
    validateContainerId(containerId)
    const result = await runBoundedCommand(this.#command, [
      'exec', containerId, 'tar', '-C', '/workspace/dist', '-cf', '-', '.',
    ], {
      timeoutMs,
      maxOutputBytes: 72 * 1024 * 1024,
      signal,
      binaryOutput: true,
    })
    if (result.code !== 0 || !Buffer.isBuffer(result.stdout)) {
      throw new Error('Static application output could not be exported from the isolated runtime.')
    }
    return result.stdout
  }

  async buildApplicationImage({ contextDirectory, reference, policy, timeoutMs, signal }) {
    if (typeof contextDirectory !== 'string' || !path.isAbsolute(contextDirectory)
      || typeof reference !== 'string' || !/^deployhub-app:[a-f0-9]{24}$/.test(reference)) {
      throw new Error('Application image build arguments are invalid.')
    }
    const build = await runBoundedCommand(this.#command, [
      'build',
      '--network=none',
      '--pull=false',
      '--quiet',
      '--tag', reference,
      contextDirectory,
    ], {
      timeoutMs,
      maxOutputBytes: policy.logBytes,
      signal,
    })
    if (build.code !== 0) throw new Error('Controlled application image creation failed.')
    const inspected = await this.#run(['image', 'inspect', reference], policy)
    if (inspected.code !== 0) throw new Error('Created application image could not be inspected.')
    let image
    try {
      image = JSON.parse(inspected.stdout)[0]
    } catch {
      throw new Error('Docker returned malformed application image metadata.')
    }
    if (typeof image?.Id !== 'string' || !/^sha256:[0-9a-f]{64}$/i.test(image.Id)) {
      throw new Error('Docker returned an invalid application image ID.')
    }
    return { imageId: image.Id, config: image.Config }
  }

  async removeApplicationImage(reference, policy) {
    if (typeof reference !== 'string' || !/^deployhub-app:[a-f0-9]{24}$/.test(reference)) {
      throw new Error('Application image reference is invalid.')
    }
    const result = await this.#run(['image', 'rm', reference], policy)
    if (result.code !== 0 && !/no such image|not known/i.test(result.stderr)) {
      throw new Error('Application image cleanup failed.')
    }
    return true
  }

  async exec(containerId, args, { policy, timeoutMs, signal } = {}) {
    validateContainerId(containerId)
    if (!Array.isArray(args) || args.some((value) => typeof value !== 'string')) {
      throw new TypeError('Isolated runtime command arguments are invalid.')
    }
    const result = await runBoundedCommand(this.#command, [
      'exec', '--workdir', '/workspace',
      '--env', 'HOME=/tmp',
      '--env', `PATH=${RUNTIME_PATH}`,
      '--env', 'GIT_CONFIG_NOSYSTEM=1',
      '--env', 'GIT_CONFIG_GLOBAL=/dev/null',
      '--env', 'GIT_TERMINAL_PROMPT=0',
      containerId,
      ...args,
    ], {
      timeoutMs,
      maxOutputBytes: policy.logBytes,
      signal,
    })
    return result
  }

  async stop(containerId, policy) {
    validateContainerId(containerId)
    const result = await this.#run(['stop', '--time', '1', containerId], policy)
    if (result.code !== 0 && !/no such container|is not running/i.test(result.stderr)) {
      throw new Error('Docker runtime could not be stopped.')
    }
    return true
  }

  async remove(containerId, policy) {
    validateContainerId(containerId)
    const result = await this.#run(['rm', '--force', containerId], policy)
    if (result.code !== 0 && !/no such container/i.test(result.stderr)) {
      throw new Error('Docker runtime cleanup failed.')
    }
    return true
  }

  async listDeployHubContainers({ limit = 100 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new Error('Docker reconciliation limit is invalid.')
    }
    const result = await runBoundedCommand(this.#command, [
      'ps', '--all', '--quiet',
      '--filter', 'label=deployhub.execution_id',
      '--no-trunc',
    ], { timeoutMs: 5000, maxOutputBytes: limit * 80 })
    if (result.code !== 0) throw new Error('Docker runtime reconciliation failed.')
    const ids = result.stdout.trim().split(/\r?\n/).filter(Boolean)
    if (ids.length > limit || ids.some((id) => !DOCKER_ID_PATTERN.test(id))) {
      throw new Error('Docker returned an invalid reconciliation response.')
    }
    return ids
  }

  async inspectLabels(containerId, policy) {
    validateContainerId(containerId)
    const result = await this.#run(['inspect', containerId], policy)
    if (result.code !== 0) throw new Error('Docker execution metadata is unavailable.')
    let container
    try {
      container = JSON.parse(result.stdout)[0]
    } catch {
      throw new Error('Docker returned malformed execution metadata.')
    }
    return {
      id: containerId,
      labels: container?.Config?.Labels ?? {},
      running: container?.State?.Running === true,
    }
  }

  async #run(args, policy) {
    return runBoundedCommand(this.#command, args, {
      timeoutMs: Math.min(policy?.timeoutMs ?? 5000, 10_000),
      maxOutputBytes: Math.min(policy?.logBytes ?? 16_384, 64 * 1024),
    })
  }
}

export function buildDockerCreateArgs({ image, input, correlation, name }) {
  const policy = input.resourcePolicy
  const memory = `${policy.memoryMb}m`
  const workspaceSize = `${policy.diskMb}m`
  return [
    'create',
    '--name', name,
    '--label', `deployhub.execution_id=${correlation.executionId}`,
    '--label', `deployhub.deployment_id=${correlation.deploymentId}`,
    '--label', `deployhub.job_id=${correlation.jobId}`,
    '--label', `deployhub.lease_generation=${correlation.leaseGeneration}`,
    '--label', `deployhub.commit_sha=${input.commitSha}`,
    '--network', 'none',
    '--cpus', (policy.cpuMilli / 1000).toFixed(3),
    '--memory', memory,
    '--memory-swap', memory,
    '--pids-limit', String(policy.pidLimit),
    '--storage-opt', `size=${workspaceSize}`,
    '--read-only',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--user', '1000:1000',
    '--tmpfs', `/workspace:rw,size=${workspaceSize},mode=1777`,
    '--tmpfs', '/tmp:rw,size=64m,noexec,nosuid,nodev,mode=1777',
    '--env', 'HOME=/tmp',
    '--env', `PATH=${RUNTIME_PATH}`,
    '--workdir', '/workspace',
    '--entrypoint', '/bin/sleep',
    image,
    'infinity',
  ]
}

export function assertDockerIsolation(inspected, input) {
  const host = inspected?.HostConfig
  const security = new Set(host?.SecurityOpt ?? [])
  const caps = new Set(host?.CapDrop ?? [])
  const environment = inspected?.Config?.Env ?? []
  const mounts = inspected?.Mounts ?? []
  const leakedEnvironment = environment.some((item) =>
    /^(?:DATABASE_URL|JWT_SECRET|GITHUB_SOURCE_TOKEN|REGISTRY_USERNAME|REGISTRY_PASSWORD|REGISTRY_TOKEN|AWS_|CLOUD_|DOCKER_HOST|DOCKER_CONTEXT|.*(?:TOKEN|SECRET|PASSWORD|API_KEY))=/i.test(item))
  const workspaceTmpfs = host?.Tmpfs?.['/workspace'] ?? ''
  const workspaceSize = Number(workspaceTmpfs.match(/(?:^|,)size=(\d+)([kmg])(?:,|$)/i)?.[1])
  const unit = workspaceTmpfs.match(/(?:^|,)size=(\d+)([kmg])(?:,|$)/i)?.[2]?.toLowerCase()
  const sizeMultiplier = unit === 'g' ? 1024 : unit === 'k' ? 1 / 1024 : 1
  const workspaceMb = workspaceSize * sizeMultiplier
  const isolated = host?.Privileged === false
    && host?.NetworkMode === 'none'
    && emptyList(host?.Binds)
    && emptyList(host?.VolumesFrom)
    && Array.isArray(mounts)
    && mounts.every((mount) => mount.Type === 'tmpfs'
      && ['/workspace', '/tmp'].includes(mount.Destination))
    && Object.keys(host?.PortBindings ?? {}).length === 0
    && host?.ReadonlyRootfs === true
    && host?.Memory === input.resourcePolicy.memoryMb * 1024 * 1024
    && host?.MemorySwap === input.resourcePolicy.memoryMb * 1024 * 1024
    && host?.PidsLimit === input.resourcePolicy.pidLimit
    && Math.round((host?.NanoCpus ?? 0) / 1_000_000) === input.resourcePolicy.cpuMilli
    && host?.StorageOpt?.size === `${input.resourcePolicy.diskMb}m`
    && Math.abs(workspaceMb - input.resourcePolicy.diskMb) < 1
    && caps.has('ALL')
    && security.has('no-new-privileges')
    && inspected?.Config?.User === '1000:1000'
    && !leakedEnvironment
  if (!isolated) throw new Error('Docker runtime does not enforce the required isolation policy.')
  return true
}

function emptyList(value) {
  return value === null || (Array.isArray(value) && value.length === 0)
}

function validateContainerId(value) {
  if (typeof value !== 'string' || !DOCKER_ID_PATTERN.test(value)) {
    throw new Error('Docker container identity is invalid.')
  }
}
