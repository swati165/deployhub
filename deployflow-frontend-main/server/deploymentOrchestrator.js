import { failCurrentDeployment, transitionDeployment } from './deploymentStates.js'
import { validateGitHubUrl } from './validation.js'
import {
  EXECUTION_INPUT_VERSION,
  ExecutionProviderError,
  MAX_PROGRESS_BYTES,
  MAX_PROGRESS_EVENTS,
  validateExecutionHandle,
  validateExecutionResult,
  validateProgressEvent,
} from './executors/ExecutionProvider.js'
import { createExecutionProvider } from './executors/FakeExecutionProvider.js'
import { createIsolatedVmExecutionProvider } from './executors/IsolatedVmExecutionProvider.js'
import { PostgresExecutionStore } from './executorExecutionStore.js'
import {
  createConfiguredSourceResolver,
  resolveAndPersistSource,
} from './executors/SourceResolver.js'
import { IsolatedVmSupervisor } from './executors/IsolatedVmSupervisor.js'
import { DockerCliRuntime } from './executors/DockerCliRuntime.js'
import { reconcileExecutions } from './executionReconciliation.js'
import {
  RegistryProviderError,
  validateRegistryPushRequest,
  validateRegistryPushResult,
} from './executors/RegistryProvider.js'
import { DockerRegistryProvider, registryConfigFromEnvironment } from './executors/DockerRegistryProvider.js'
import { DockerRegistryArtifactProvider } from './executors/DockerRegistryArtifactProvider.js'

const RESOURCE_POLICY = Object.freeze({
  cpuMilli: 1000,
  memoryMb: 1024,
  diskMb: 2048,
  pidLimit: 128,
  timeoutMs: 120000,
  logBytes: 64 * 1024,
})
const STATUS_BY_STAGE = Object.freeze({
  VALIDATING_REPOSITORY: 'VALIDATING',
  CLONING_REPOSITORY: 'CLONING',
  DETECTING_TECHNOLOGY: 'BUILDING',
  INSTALLING_DEPENDENCIES: 'BUILDING',
  BUILDING_APPLICATION: 'BUILDING',
  CREATING_IMAGE: 'BUILDING',
  AUTHENTICATING_REGISTRY: 'PUSHING_IMAGE',
  PUSHING_IMAGE: 'PUSHING_IMAGE',
  APPLYING_KUBERNETES_DEPLOYMENT: 'DEPLOYING',
  CREATING_SERVICE: 'DEPLOYING',
  CREATING_INGRESS: 'DEPLOYING',
  VERIFYING_ROLLOUT: 'DEPLOYING',
  GENERATING_LIVE_URL: 'DEPLOYING',
})
export class DeploymentExecutionError extends Error {
  constructor(message, { retryable = false, failureCode = null } = {}) {
    super(message)
    this.name = 'DeploymentExecutionError'
    this.retryable = retryable
    this.failureCode = failureCode
  }
}

export async function runDeployment(pool, job, {
  lease,
  provider,
  registryProvider,
  sourceResolver,
  executionStore,
  signal,
} = {}) {
  const result = await pool.query(
    `SELECT deployments.id, deployments.status, deployments.stage, deployments.branch,
            projects.repo_url
     FROM deployments
     JOIN projects ON projects.id = deployments.project_id
     WHERE deployments.id = $1`,
    [job.deployment_id],
  )
  const deployment = result.rows[0]
  if (!deployment) throw new DeploymentExecutionError('Deployment record was not found.')
  if (deployment.status === 'RUNNING') return { outcome: 'completed' }
  if (deployment.status === 'FAILED') return { outcome: 'failed' }

  let activeProvider = provider ?? createConfiguredExecutionProvider(pool)
  let activeExecutionStore = executionStore ?? new PostgresExecutionStore(pool)
  let executionId
  let executionError
  let providerResult
  let repository
  try {
    if (deployment.status === 'QUEUED' && deployment.stage === 'QUEUED') {
      await transitionDeployment(pool, {
        id: deployment.id,
        fromStatus: 'QUEUED',
        fromStage: 'QUEUED',
        toStatus: 'VALIDATING',
        toStage: 'VALIDATING_REPOSITORY',
        message: 'Validating repository and deployment prerequisites.',
        lease,
      })
      deployment.status = 'VALIDATING'
      deployment.stage = 'VALIDATING_REPOSITORY'
    }

    repository = validateGitHubUrl(deployment.repo_url)
    const executionDisabledMessage = 'Repository execution is disabled until a separately approved isolated build executor is configured.'
    if (!activeProvider) {
      await failCurrentDeployment(pool, { id: deployment.id, message: executionDisabledMessage, lease })
      return { outcome: 'failed', error: new DeploymentExecutionError(executionDisabledMessage) }
    }

    if (!lease || lease.id !== job.id || !Number.isSafeInteger(Number(lease.lease_generation))
      || Number(lease.lease_generation) < 1
      || Number(lease.lease_generation) !== Number(job.lease_generation)
      || lease.worker_id !== job.worker_id) {
      throw new ExecutionProviderError('Execution lease does not match the active deployment job.')
    }
    if (activeProvider.executionMode === 'NODE_NPM_OFFLINE'
      && process.env.ISOLATED_EXECUTOR_ENABLED !== 'true') {
      throw new ExecutionProviderError('Isolated repository execution is disabled; no source was fetched.')
    }
    const activeSourceResolver = sourceResolver === undefined
      ? createConfiguredSourceResolver()
      : sourceResolver
    let source
    try {
      source = await resolveAndPersistSource(
        activeSourceResolver,
        activeExecutionStore,
        {
          deploymentId: deployment.id,
          jobId: job.id,
          repository,
          requestedBranch: deployment.branch,
        },
        {
          leaseGeneration: Number(lease.lease_generation),
          workerId: lease.worker_id,
        },
      )
    } catch {
      throw new ExecutionProviderError(
        'Trusted source resolution failed or could not be pinned; execution was not started.',
      )
    }
    const input = {
      schemaVersion: EXECUTION_INPUT_VERSION,
      deploymentId: deployment.id,
      jobId: job.id,
      leaseGeneration: Number(lease.lease_generation),
      repository,
      requestedBranch: deployment.branch,
      commitSha: source.commitSha,
      buildMode: activeProvider.executionMode ?? 'FAKE_ONLY',
      resourcePolicy: { ...RESOURCE_POLICY },
      networkPolicy: 'NO_NETWORK',
    }
    const started = await activeProvider.start(
      input,
      { ...lease, deployment_id: deployment.id },
      { signal },
    )
    executionId = validateExecutionHandle(started)

    const expected = {
      executionId,
      deploymentId: deployment.id,
      jobId: job.id,
      leaseGeneration: input.leaseGeneration,
    }
    let cursor = 0
    let progressBytes = 0
    for await (const event of activeProvider.streamProgress(executionId, cursor)) {
      if (cursor >= MAX_PROGRESS_EVENTS) {
        throw new ExecutionProviderError('Execution provider exceeded the allowed progress event count.')
      }
      validateProgressEvent(event, expected, { sequence: cursor + 1 })
      progressBytes += Buffer.byteLength(event.message, 'utf8')
      if (progressBytes > MAX_PROGRESS_BYTES || progressBytes > input.resourcePolicy.logBytes) {
        throw new ExecutionProviderError('Execution provider exceeded the allowed progress size.')
      }
      await persistProgress(pool, deployment.id, event, lease)
      cursor = event.sequence
    }

    providerResult = validateExecutionResult(await activeProvider.collectResult(executionId), {
      deploymentId: deployment.id,
      jobId: job.id,
      commitSha: input.commitSha,
      buildMode: input.buildMode,
    }, { maxLogBytes: input.resourcePolicy.logBytes })
    for (const log of providerResult.logs) {
      await appendFencedLog(pool, deployment.id, log.level, safeLogMessage(log.message), lease)
    }
  } catch (error) {
    executionError = error instanceof Error
      ? error
      : new ExecutionProviderError('Execution provider failed unexpectedly.')
  } finally {
    if (executionId) {
      try {
        await activeProvider.cleanup(executionId)
      } catch {
        executionError = new ExecutionProviderError('Execution provider cleanup failed.')
      }
    }
  }

  if (executionError) {
    if (executionError.retryable === true) throw executionError
    const safeMessage = executionError instanceof ExecutionProviderError
      ? executionError.message
      : 'Execution provider returned an invalid or unavailable result.'
    await failCurrentDeployment(pool, { id: deployment.id, message: safeMessage, lease })
    return { outcome: 'failed', error: new DeploymentExecutionError(safeMessage) }
  }

  if (providerResult.outcome === 'FAILURE') {
    if (providerResult.failureKind === 'TRANSIENT_INFRASTRUCTURE') {
      throw new DeploymentExecutionError('Execution provider reported a transient infrastructure failure.', { retryable: true })
    }
    const message = 'Execution provider reported a deterministic failure.'
    await failCurrentDeployment(pool, { id: deployment.id, message, lease })
    return { outcome: 'failed', error: new DeploymentExecutionError(message) }
  }

  if (providerResult.artifact?.format === 'OCI_IMAGE') {
    let registryResult
    try {
      const activeRegistryProvider = registryProvider ?? createConfiguredRegistryProvider()
      const request = validateRegistryPushRequest({
        deploymentId: deployment.id,
        jobId: job.id,
        executionId,
        leaseGeneration: Number(lease.lease_generation),
        commitSha: providerResult.commitSha,
        localImage: providerResult.artifact,
      })
      const assertCurrentLease = async () => {
        try {
          const pinned = await activeExecutionStore.getSourceResolution({
            deploymentId: deployment.id,
            jobId: job.id,
            repository,
            requestedBranch: deployment.branch,
          }, {
            leaseGeneration: Number(lease.lease_generation),
            workerId: lease.worker_id,
          })
          if (!pinned || pinned.commitSha.toLowerCase() !== providerResult.commitSha.toLowerCase()) {
            throw new Error('Stale or mismatched source pin.')
          }
        } catch {
          throw new RegistryProviderError(
            'STALE_LEASE_GENERATION',
            'Registry operation was rejected because the worker lease or source pin is stale.',
          )
        }
      }
      await assertCurrentLease()
      await persistProgress(pool, deployment.id, {
        stage: 'AUTHENTICATING_REGISTRY',
        message: 'Authenticating the trusted registry publisher.',
      }, lease)
      if (typeof activeExecutionStore.getRegistryImage !== 'function'
        || typeof activeExecutionStore.recordRegistryImage !== 'function') {
        throw new RegistryProviderError(
          'REGISTRY_CONFIGURATION_INVALID',
          'Durable registry metadata storage is unavailable; deployment was not completed.',
        )
      }
      const prior = await activeExecutionStore.getRegistryImage(request, { workerId: lease.worker_id })
      if (prior) {
        registryResult = validateRegistryPushResult(prior, request, {
          registry: activeRegistryProvider.registry,
          repository: activeRegistryProvider.repository,
          provider: activeRegistryProvider.name,
        })
      } else {
        registryResult = validateRegistryPushResult(
          await activeRegistryProvider.push(request, { assertLease: assertCurrentLease, signal }),
          request,
          {
            registry: activeRegistryProvider.registry,
            repository: activeRegistryProvider.repository,
            provider: activeRegistryProvider.name,
          },
        )
        await assertCurrentLease()
        registryResult = await activeExecutionStore.recordRegistryImage(request, registryResult, {
          workerId: lease.worker_id,
        })
      }
      await appendFencedLog(
        pool,
        deployment.id,
        'info',
        `Published image by immutable digest ${registryResult.registryDigest}.`,
        lease,
      )
    } catch (error) {
      if (error instanceof RegistryProviderError && error.retryable) {
        throw new DeploymentExecutionError(error.message, {
          retryable: true,
          failureCode: error.code,
        })
      }
      const failure = error instanceof RegistryProviderError
        ? error
        : new RegistryProviderError('REGISTRY_PUSH_FAILED', 'Registry image publication failed.')
      await failCurrentDeployment(pool, { id: deployment.id, message: failure.message, lease })
      return {
        outcome: 'failed',
        error: new DeploymentExecutionError(failure.message, { failureCode: failure.code }),
      }
    }
    const message = `Image ${registryResult.image} was published by immutable digest; Kubernetes deployment remains disabled, so no live deployment was created.`
    await failCurrentDeployment(pool, { id: deployment.id, message, lease })
    return { outcome: 'failed', error: new DeploymentExecutionError(message) }
  }

  const message = providerResult.detectedStack?.startsWith('Node.js')
    ? 'The isolated application image was created locally, but registry publishing is not configured; no live deployment was created.'
    : 'Fake execution provider completed its synthetic build; image creation, registry publishing, and Kubernetes deployment remain disabled.'
  await failCurrentDeployment(pool, { id: deployment.id, message, lease })
  return { outcome: 'failed', error: new DeploymentExecutionError(message) }
}

function createConfiguredExecutionProvider(pool) {
  if (process.env.EXECUTION_PROVIDER === 'fake') {
    return createExecutionProvider({ providerName: 'fake' })
  }
  if (process.env.EXECUTION_PROVIDER === 'isolated-vm') {
    const provider = createIsolatedVmExecutionProvider({
      executionStore: new PostgresExecutionStore(pool),
    })
    provider.executionMode = 'NODE_NPM_OFFLINE'
    return provider
  }
  return null
}

function createConfiguredRegistryProvider() {
  try {
    return new DockerRegistryArtifactProvider({
      runtime: new DockerCliRuntime(),
      provider: new DockerRegistryProvider({ config: registryConfigFromEnvironment() }),
    })
  } catch (error) {
    if (!(error instanceof RegistryProviderError)) throw error
    return {
      name: 'disabled-registry',
      apiVersion: 1,
      async push() {
        throw error
      },
    }
  }
}

export async function reconcileConfiguredExecutions(pool) {
  if (process.env.EXECUTION_PROVIDER !== 'isolated-vm'
    || process.env.ISOLATED_EXECUTOR_ENABLED !== 'true') {
    return []
  }
  const store = new PostgresExecutionStore(pool)
  const supervisor = new IsolatedVmSupervisor({ enabled: true })
  return reconcileExecutions(store, supervisor)
}

async function persistProgress(pool, deploymentId, event, lease) {
  const targetStatus = STATUS_BY_STAGE[event.stage]
  if (!targetStatus) throw new ExecutionProviderError('Execution provider reported a non-progress stage.')
  const result = await pool.query('SELECT status, stage FROM deployments WHERE id = $1', [deploymentId])
  const current = result.rows[0]
  if (!current) throw new ExecutionProviderError('Deployment was not found while recording progress.')
  const message = safeLogMessage(event.message)
  if (current.status === targetStatus && current.stage === event.stage) {
    await appendFencedLog(pool, deploymentId, 'info', message, lease)
    return
  }
  await transitionDeployment(pool, {
    id: deploymentId,
    fromStatus: current.status,
    fromStage: current.stage,
    toStatus: targetStatus,
    toStage: event.stage,
    message,
    lease,
  })
}

async function appendFencedLog(pool, deploymentId, level, message, lease) {
  const result = await pool.query(
    `INSERT INTO deployment_logs (deployment_id, level, message)
     SELECT $1, $2, $3
     WHERE EXISTS (
       SELECT 1 FROM deployment_jobs
       WHERE id = $4 AND deployment_id = $1
         AND worker_id = $5 AND lease_generation = $6
         AND state = 'RUNNING' AND lease_expires_at > NOW()
     )
     RETURNING deployment_id`,
    [deploymentId, level, message, lease.id, lease.worker_id, lease.lease_generation],
  )
  if (result.rowCount !== 1) {
    throw new ExecutionProviderError('Execution progress was rejected because the worker lease is no longer current.')
  }
}

function safeLogMessage(value) {
  return stripControlCharacters(stripAnsiEscapes(value))
    .replace(/\b(token|password|secret|authorization|api[_-]?key)\s*[:=]\s*\S+/gi, '$1=[REDACTED]')
    .slice(0, 1000)
}

function stripAnsiEscapes(value) {
  const characters = [...value]
  let output = ''
  for (let index = 0; index < characters.length; index += 1) {
    if (characters[index].codePointAt(0) !== 27) {
      output += characters[index]
      continue
    }
    const next = characters[index + 1]
    if (next === '[') {
      index += 2
      while (index < characters.length) {
        const code = characters[index].codePointAt(0)
        if (code >= 0x40 && code <= 0x7e) break
        index += 1
      }
    } else if (next === ']') {
      index += 2
      while (index < characters.length) {
        if (characters[index].codePointAt(0) === 7
          || (characters[index].codePointAt(0) === 27 && characters[index + 1] === '\\')) {
          if (characters[index].codePointAt(0) === 27) index += 1
          break
        }
        index += 1
      }
    }
  }
  return output
}

function stripControlCharacters(value) {
  return [...value]
    .filter((character) => {
      const code = character.codePointAt(0)
      return !((code <= 0x1f && code !== 0x0a && code !== 0x0d) || code === 0x7f)
    })
    .join('')
}
