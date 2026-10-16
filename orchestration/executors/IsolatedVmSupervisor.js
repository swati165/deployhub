import { createHash } from 'node:crypto'
import {
  EXECUTION_RESULT_VERSION,
  MAX_ERROR_BYTES,
  MAX_LOG_BYTES,
  MAX_LOG_LINE_BYTES,
  validateExecutionInput,
} from './ExecutionProvider.js'
import { DockerCliRuntime } from './DockerCliRuntime.js'
import { GitSourceFetcher } from './GitSourceFetcher.js'
import { ApplicationBuildError, StaticNodeApplicationBuilder } from './StaticNodeApplicationBuilder.js'

const MAX_TRACKED_EXECUTIONS = 1000
const DIGEST_IMAGE_PATTERN = /^[A-Za-z0-9._:/-]+@sha256:[0-9a-f]{64}$/i
const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i
const RUNTIME_UNAVAILABLE = 'RUNTIME_UNAVAILABLE: isolated Docker runtime is unavailable or not safely configured.'
const CANCELLED = 'Isolated execution was cancelled.'

export class IsolatedRuntimeError extends Error {
  constructor(message, {
    code = 'RUNTIME_UNAVAILABLE',
    retryable = false,
    cleanupRequired = false,
    cleanupFailed = false,
  } = {}) {
    super(message)
    this.name = 'IsolatedRuntimeError'
    this.code = code
    this.retryable = retryable
    this.cleanupRequired = cleanupRequired
    this.cleanupFailed = cleanupFailed
  }
}

export class IsolatedVmSupervisor {
  #enabled
  #image
  #runtime
  #applicationBuilder
  #sourceFetcher
  #executions = new Map()

  constructor({
    enabled = process.env.ISOLATED_EXECUTOR_ENABLED === 'true',
    image = process.env.ISOLATED_EXECUTOR_IMAGE,
    runtime = new DockerCliRuntime(),
    applicationBuilder = new StaticNodeApplicationBuilder({ runtime }),
    sourceFetcher = new GitSourceFetcher(),
    clock = () => new Date(),
  } = {}) {
    if (typeof enabled !== 'boolean') throw new TypeError('Isolated executor enabled setting must be boolean.')
    if (!runtime || typeof runtime.create !== 'function' || typeof runtime.exec !== 'function') {
      throw new TypeError('Isolated Docker runtime adapter is invalid.')
    }
    if (!sourceFetcher || typeof sourceFetcher.fetch !== 'function') {
      throw new TypeError('Isolated source fetcher is invalid.')
    }
    if (!applicationBuilder || typeof applicationBuilder.inspectProject !== 'function'
      || typeof applicationBuilder.validateOutput !== 'function'
      || typeof applicationBuilder.createImage !== 'function') {
      throw new TypeError('Static Node application builder is invalid.')
    }
    if (typeof clock !== 'function') throw new TypeError('Isolated runtime clock is invalid.')
    this.#enabled = enabled
    this.#image = image
    this.#runtime = runtime
    this.#applicationBuilder = applicationBuilder
    this.#sourceFetcher = sourceFetcher
    this.clock = clock
  }

  async provision(input, correlation, { signal, assertLease } = {}) {
    validateExecutionInput(input)
    validateCorrelation(input, correlation)
    if (!this.#enabled || !DIGEST_IMAGE_PATTERN.test(this.#image ?? '')) {
      throw new IsolatedRuntimeError(RUNTIME_UNAVAILABLE)
    }
    if (input.buildMode !== 'NODE_NPM_OFFLINE') {
      throw new IsolatedRuntimeError('Unsupported isolated build mode; execution was not started.', {
        code: 'BUILD_MODE_UNSUPPORTED',
      })
    }
    if (!SHA_PATTERN.test(input.commitSha ?? '')) {
      throw new IsolatedRuntimeError('Immutable source SHA is required; execution was not started.', {
        code: 'SOURCE_UNPINNED',
      })
    }
    if (input.networkPolicy !== 'NO_NETWORK') {
      throw new IsolatedRuntimeError('Requested network policy cannot be safely enforced by the local runtime.', {
        code: 'NETWORK_POLICY_UNSUPPORTED',
      })
    }
    if (this.#executions.size >= MAX_TRACKED_EXECUTIONS) {
      throw new IsolatedRuntimeError('Isolated runtime is at its bounded execution limit.')
    }
    const executionId = correlation.executionId
    const prior = this.#executions.get(executionId)
    if (prior) {
      if (!matchesCorrelation(prior, correlation)
        || prior.inputFingerprint !== fingerprintInput(input)) {
        throw new IsolatedRuntimeError('Duplicate isolated runtime request conflicts with its original input.', {
          code: 'EXECUTION_CORRELATION_MISMATCH',
        })
      }
      return executionHandle(prior)
    }

    const record = {
      ...correlation,
      commitSha: input.commitSha,
      repository: input.repository,
      input: structuredClone(input),
      inputFingerprint: fingerprintInput(input),
      state: 'PROVISIONED',
      cleanupState: 'PENDING',
      containerId: null,
      source: null,
      startedAt: this.#timestamp(),
      completedAt: null,
      result: null,
      applicationImage: null,
      progress: [],
      outputBytes: 0,
      output: [],
      controller: new AbortController(),
      externalSignal: signal,
      externalAbort: null,
      assertLease,
      task: null,
      cleaned: false,
      timedOut: false,
      deadlineAt: Date.now() + input.resourcePolicy.timeoutMs,
      deadlineTimer: null,
      cleanupError: null,
    }
    this.#executions.set(executionId, record)
    record.deadlineTimer = setTimeout(() => {
      record.timedOut = true
      record.controller.abort()
      if (record.containerId) {
        void this.#runtime.stop(record.containerId, record.input.resourcePolicy).catch(() => {
          record.cleanupState = 'FAILED'
          record.cleanupError = 'Timed-out isolated runtime could not be stopped.'
        })
      }
    }, input.resourcePolicy.timeoutMs)
    record.deadlineTimer.unref?.()
    try {
      if (signal?.aborted) throw new IsolatedRuntimeError(CANCELLED, { code: 'CANCELLED' })
      record.externalAbort = () => record.controller.abort()
      signal?.addEventListener('abort', record.externalAbort, { once: true })
      await this.#assertCurrentLease(record)
      record.source = await this.#sourceFetcher.fetch(input.repository, input.commitSha, {
        diskLimitBytes: input.resourcePolicy.diskMb * 1024 * 1024,
        timeoutMs: input.resourcePolicy.timeoutMs,
        logBytes: input.resourcePolicy.logBytes,
        signal: record.controller.signal,
      })
      await this.#assertCurrentLease(record)
      const name = `deployhub-${createHash('sha256').update(executionId).digest('hex').slice(0, 32)}`
      const containerId = await this.#runtime.create({
        image: this.#image,
        input,
        correlation,
        name,
      })
      record.containerId = validateContainerId(containerId)
      if (typeof this.#runtime.assertIsolation !== 'function') {
        throw new IsolatedRuntimeError('Docker isolation settings cannot be verified.')
      }
      await this.#runtime.assertIsolation(record.containerId, input)
      record.cleanupRequired = true
      if (record.controller.signal.aborted) {
        throw new IsolatedRuntimeError(
          record.timedOut ? 'Isolated source preparation exceeded its execution timeout.' : CANCELLED,
          { code: record.timedOut ? 'EXECUTION_TIMEOUT' : 'CANCELLED' },
        )
      }
      return executionHandle(record)
    } catch (error) {
      const cleaned = await this.#cleanupAfterFailure(record)
      if (record.timedOut || error?.code === 'COMMAND_TIMEOUT') {
        throw new IsolatedRuntimeError('Isolated source preparation exceeded its execution timeout.', {
          code: 'EXECUTION_TIMEOUT',
          cleanupRequired: !cleaned,
          cleanupFailed: !cleaned,
        })
      }
      if (error?.code === 'STALE_LEASE') {
        throw new IsolatedRuntimeError('Execution lease became stale before runtime start.', {
          code: 'STALE_LEASE',
          cleanupRequired: !cleaned,
          cleanupFailed: !cleaned,
        })
      }
      if (error instanceof IsolatedRuntimeError) {
        if (cleaned) throw error
        throw new IsolatedRuntimeError(error.message, {
          code: error.code,
          retryable: error.retryable,
          cleanupRequired: true,
          cleanupFailed: true,
        })
      }
      throw new IsolatedRuntimeError(RUNTIME_UNAVAILABLE, {
        retryable: true,
        cleanupRequired: !cleaned,
        cleanupFailed: !cleaned,
      })
    }
  }

  async start(execution, correlation) {
    const record = await this.#get(execution, correlation)
    if (record.state === 'RUNNING' || record.state === 'COMPLETED'
      || record.state === 'FAILED' || record.state === 'CANCELLED') return true
    if (!record.containerId) throw new IsolatedRuntimeError(RUNTIME_UNAVAILABLE)
    if (record.controller.signal.aborted) {
      if (record.timedOut) {
        record.state = 'FAILED'
        record.completedAt = this.#timestamp()
        record.result = failureResult(record, 'Isolated build exceeded its execution timeout.', 'DETERMINISTIC')
        throw new IsolatedRuntimeError('Isolated build exceeded its execution timeout.', {
          code: 'EXECUTION_TIMEOUT',
        })
      }
      record.state = 'CANCELLED'
      record.completedAt = this.#timestamp()
      record.result = failureResult(record, CANCELLED, 'DETERMINISTIC')
      throw new IsolatedRuntimeError(CANCELLED, { code: 'CANCELLED' })
    }
    try {
      await this.#runtime.start(record.containerId, record.input.resourcePolicy)
      record.state = 'RUNNING'
      record.startedAt = this.#timestamp()
      return true
    } catch {
      record.state = 'FAILED'
      record.completedAt = this.#timestamp()
      record.result = failureResult(record, RUNTIME_UNAVAILABLE, 'TRANSIENT_INFRASTRUCTURE')
      throw new IsolatedRuntimeError(RUNTIME_UNAVAILABLE, { retryable: true })
    }
  }

  async monitor(execution, correlation) {
    const record = await this.#get(execution, correlation)
    if (!record.task && record.state === 'RUNNING') {
      record.task = this.#runBuild(record)
    }
    if (record.task) await record.task
    return {
      state: record.state,
      result: record.result ? structuredClone(record.result) : null,
      progress: structuredClone(record.progress),
    }
  }

  async terminate(execution, correlation) {
    const record = await this.#get(execution, correlation)
    if (record.state === 'CANCELLED') return true
    record.controller.abort()
    clearTimeout(record.deadlineTimer)
    if (record.containerId) {
      await this.#runtime.stop(record.containerId, record.input.resourcePolicy)
    }
    if (!record.result) {
      record.state = 'CANCELLED'
      record.completedAt = this.#timestamp()
      record.result = failureResult(record, CANCELLED, 'DETERMINISTIC')
    }
    return true
  }

  async cleanup(execution, correlation) {
    const record = await this.#get(execution, correlation)
    if (record.cleaned) return true
    let failure = null
    try {
      if (record.containerId) {
        await this.#runtime.remove(record.containerId, record.input.resourcePolicy)
      }
    } catch {
      failure = new IsolatedRuntimeError('Isolated runtime cleanup failed; reconciliation is required.', {
        code: 'CLEANUP_FAILED',
        retryable: true,
      })
    }
    try {
      await record.source?.cleanup()
      record.source = null
    } catch {
      failure ??= new IsolatedRuntimeError('Isolated source cleanup failed; reconciliation is required.', {
        code: 'CLEANUP_FAILED',
        retryable: true,
      })
    }
    if (failure) {
      record.cleanupState = 'FAILED'
      record.cleanupError = failure.message
      throw failure
    }
    record.cleaned = true
    record.cleanupState = 'CLEANED'
    record.containerId = null
    record.cleanupRequired = false
    record.externalSignal?.removeEventListener('abort', record.externalAbort)
    clearTimeout(record.deadlineTimer)
    return true
  }

  async reconcileAbandonedExecutions({ limit = 100 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new Error('Isolated runtime reconciliation limit is invalid.')
    }
    if (typeof this.#runtime.listDeployHubContainers !== 'function'
      || typeof this.#runtime.inspectLabels !== 'function') {
      throw new IsolatedRuntimeError('Isolated runtime reconciliation is unavailable.')
    }
    const containers = await this.#runtime.listDeployHubContainers({ limit })
    const snapshots = []
    for (const containerId of containers) {
      const metadata = await this.#runtime.inspectLabels(containerId, {
        timeoutMs: 5000,
        logBytes: 16 * 1024,
      })
      const labels = metadata.labels
      const snapshot = {
        cleanupState: 'PENDING',
        deploymentId: labels['deployhub.deployment_id'],
        error: null,
        executionId: labels['deployhub.execution_id'],
        jobId: labels['deployhub.job_id'],
        leaseGeneration: Number(labels['deployhub.lease_generation']),
        providerExecutionId: containerId,
        result: null,
        state: metadata.running ? 'RUNNING' : 'FAILED',
      }
      validateRecoveredSnapshot(snapshot)
      snapshots.push(snapshot)
    }
    return snapshots
  }

  async #runBuild(record) {
    const policy = record.input.resourcePolicy
    const deadline = record.deadlineAt
    const expectedSha = record.commitSha.toLowerCase()
    const commands = [
      {
        stage: 'CLONING_REPOSITORY',
        message: `Preparing source pinned to ${expectedSha}.`,
        args: ['git', '-c', 'core.hooksPath=/dev/null', '--git-dir=/workspace/.git', '--work-tree=/workspace', 'config', 'core.bare', 'false'],
      },
      {
        stage: 'CLONING_REPOSITORY',
        message: 'Checking out the immutable source commit.',
        args: ['git', '-c', 'core.hooksPath=/dev/null', '--git-dir=/workspace/.git', '--work-tree=/workspace', 'checkout', '--detach', expectedSha],
      },
      {
        stage: 'CLONING_REPOSITORY',
        message: 'Verifying the checked-out source SHA.',
        args: ['git', '-c', 'core.hooksPath=/dev/null', '--git-dir=/workspace/.git', '--work-tree=/workspace', 'rev-parse', 'HEAD'],
        verifySha: true,
      },
    ]
    try {
      this.#progress(record, 'VALIDATING_REPOSITORY', 'Source ref is pinned to an immutable commit SHA.')
      await this.#runtime.copySource(record.containerId, record.source.directory, policy)
      for (const command of commands) {
        this.#assertNotCancelled(record)
        await this.#assertCurrentLease(record)
        this.#progress(record, command.stage, command.message)
        const remaining = deadline - Date.now()
        if (remaining <= 0) throw new Error('EXECUTION_TIMEOUT')
        const result = await this.#runtime.exec(record.containerId, command.args, {
          policy,
          timeoutMs: remaining,
          signal: record.controller.signal,
        })
        this.#appendOutput(record, result.stdout)
        this.#appendOutput(record, result.stderr)
        if (result.code !== 0) throw new Error(command.verifySha ? 'SOURCE_SHA_MISMATCH' : 'BUILD_FAILED')
        if (command.verifySha && result.stdout.trim().toLowerCase() !== expectedSha) {
          throw new Error('SOURCE_SHA_MISMATCH')
        }
        if (Date.now() >= deadline) throw new Error('EXECUTION_TIMEOUT')
        await this.#assertCurrentLease(record)
      }
      this.#progress(record, 'DETECTING_TECHNOLOGY', 'Checking supported Node.js static application configuration.')
      let remaining = remainingTime(deadline)
      await this.#applicationBuilder.inspectProject(
        record.containerId,
        policy,
        remaining,
        record.controller.signal,
      )

      this.#assertNotCancelled(record)
      await this.#assertCurrentLease(record)
      this.#progress(record, 'INSTALLING_DEPENDENCIES', 'Installing a dependency-free npm lockfile offline.')
      remaining = remainingTime(deadline)
      const install = await this.#runtime.exec(record.containerId, [
        'npm', 'ci', '--offline', '--ignore-scripts', '--cache', '/opt/deployhub/npm-cache', '--logs-max=0',
      ], { policy, timeoutMs: remaining, signal: record.controller.signal })
      this.#appendOutput(record, install.stdout)
      this.#appendOutput(record, install.stderr)
      if (install.code !== 0) {
        throw new ApplicationBuildError('DEPENDENCY_CACHE_UNAVAILABLE', 'Required npm dependency cache is unavailable.')
      }

      this.#assertNotCancelled(record)
      await this.#assertCurrentLease(record)
      this.#progress(record, 'BUILDING_APPLICATION', 'Running the package build script in the isolated runtime.')
      remaining = remainingTime(deadline)
      const build = await this.#runtime.exec(record.containerId, ['npm', 'run', 'build'], {
        policy, timeoutMs: remaining, signal: record.controller.signal,
      })
      this.#appendOutput(record, build.stdout)
      this.#appendOutput(record, build.stderr)
      if (build.code !== 0) {
        throw new ApplicationBuildError('BUILD_FAILED', 'The isolated npm build failed.')
      }
      this.#assertNotCancelled(record)
      await this.#assertCurrentLease(record)
      remaining = remainingTime(deadline)
      await this.#applicationBuilder.validateOutput(
        record.containerId,
        policy,
        remaining,
        record.controller.signal,
      )

      this.#assertNotCancelled(record)
      await this.#assertCurrentLease(record)
      this.#progress(record, 'CREATING_IMAGE', 'Creating a local OCI image with the trusted static server.')
      await this.#runtime.stop(record.containerId, policy)
      remaining = remainingTime(deadline)
      const imageTag = `deployhub-app:${createHash('sha256').update(record.executionId).digest('hex').slice(0, 24)}`
      record.applicationImage = await this.#applicationBuilder.createImage({
        containerId: record.containerId,
        reference: imageTag,
        labels: {
          'org.opencontainers.image.revision': record.commitSha,
          'io.deployhub.deployment-id': record.deploymentId,
          'io.deployhub.job-id': record.jobId,
          'io.deployhub.lease-generation': String(record.leaseGeneration),
        },
        policy,
        timeoutMs: remaining,
        signal: record.controller.signal,
      })
      await this.#assertCurrentLease(record)
      record.state = 'COMPLETED'
      record.completedAt = this.#timestamp()
      record.result = {
        schemaVersion: EXECUTION_RESULT_VERSION,
        deploymentId: record.deploymentId,
        jobId: record.jobId,
        commitSha: record.commitSha,
        outcome: 'SUCCESS',
        failureKind: null,
        detectedStack: 'Node.js static',
        startedAt: record.startedAt,
        completedAt: record.completedAt,
        logs: boundedLogs(record.output, 'info'),
        error: null,
        artifact: record.applicationImage,
        failureCode: null,
      }
    } catch (error) {
      if (record.state === 'CANCELLED' || record.controller.signal.aborted) {
        record.state = 'CANCELLED'
        record.result ??= failureResult(record, CANCELLED, 'DETERMINISTIC', 'CANCELLED')
      } else if (error?.code === 'STALE_LEASE') {
        record.state = 'CANCELLED'
        record.result = failureResult(
          record,
          'Execution was stopped because its worker lease is stale.',
          'DETERMINISTIC',
          'STALE_LEASE',
        )
      } else if (record.timedOut || error?.code === 'COMMAND_TIMEOUT' || error?.message === 'EXECUTION_TIMEOUT') {
        record.state = 'FAILED'
        record.result = failureResult(record, 'Isolated build exceeded its execution timeout.', 'DETERMINISTIC', 'BUILD_TIMEOUT')
      } else if (error?.code === 'OUTPUT_LIMIT') {
        record.state = 'FAILED'
        record.result = failureResult(record, 'Isolated build exceeded its output limit.', 'DETERMINISTIC', 'OUTPUT_LIMIT_EXCEEDED')
      } else if (error?.message === 'SOURCE_SHA_MISMATCH') {
        record.state = 'FAILED'
        record.result = failureResult(
          record,
          'Checked-out source SHA did not match the persisted commit.',
          'DETERMINISTIC',
          'SOURCE_SHA_MISMATCH',
        )
      } else {
        record.state = 'FAILED'
        const code = error instanceof ApplicationBuildError
          ? error.code
          : error?.code === 'RUNTIME_UNAVAILABLE' ? 'RUNTIME_UNAVAILABLE' : 'BUILD_FAILED'
        record.result = failureResult(record, sanitizeBuildError(error), 'DETERMINISTIC', code)
      }
      record.completedAt = this.#timestamp()
      if (record.applicationImage) {
        try {
          await this.#runtime.removeApplicationImage(record.applicationImage.reference, policy)
        } catch {
          record.cleanupState = 'FAILED'
          record.cleanupError = 'Failed local application image must be removed during reconciliation.'
        }
        record.applicationImage = null
      }
      clearTimeout(record.deadlineTimer)
      await this.#stopAfterFailure(record)
    }
    return record.result
  }

  async #stopAfterFailure(record) {
    if (!record.containerId) return
    try {
      await this.#runtime.stop(record.containerId, record.input.resourcePolicy)
    } catch {
      record.cleanupState = 'FAILED'
      record.cleanupError = 'Isolated runtime termination failed; reconciliation is required.'
    }
  }

  async #cleanupAfterFailure(record) {
    let failed = false
    try {
      if (record.containerId) await this.#runtime.remove(record.containerId, record.input.resourcePolicy)
    } catch {
      failed = true
      record.cleanupState = 'FAILED'
      record.cleanupError = 'Isolated runtime cleanup failed; reconciliation is required.'
    }
    try {
      await record.source?.cleanup()
      record.source = null
    } catch {
      failed = true
      record.cleanupState = 'FAILED'
      record.cleanupError = 'Isolated source cleanup failed; reconciliation is required.'
    }
    if (!failed) {
      record.cleaned = true
      record.cleanupRequired = false
      record.externalSignal?.removeEventListener('abort', record.externalAbort)
      clearTimeout(record.deadlineTimer)
    }
    return !failed
  }

  #appendOutput(record, value) {
    if (typeof value !== 'string') throw new IsolatedRuntimeError('Runtime output is malformed.')
    const clean = sanitizeOutput(value)
    const bytes = Buffer.byteLength(clean, 'utf8')
    if (record.outputBytes + bytes > Math.min(record.input.resourcePolicy.logBytes, MAX_LOG_BYTES)) {
      const error = new Error('Isolated build exceeded its output limit.')
      error.code = 'OUTPUT_LIMIT'
      throw error
    }
    record.outputBytes += bytes
    if (clean) record.output.push(clean)
  }

  #progress(record, stage, message) {
    if (record.progress.length >= 1000
      || Buffer.byteLength(message, 'utf8') > MAX_LOG_LINE_BYTES) {
      throw new IsolatedRuntimeError('Runtime progress exceeded its allowed bounds.')
    }
    record.progress.push({ stage, message })
  }

  #assertNotCancelled(record) {
    if (record.controller.signal.aborted || record.state === 'CANCELLED') {
      const error = new Error(CANCELLED)
      error.code = 'CANCELLED'
      throw error
    }
  }

  async #assertCurrentLease(record) {
    if (!record.assertLease) return
    try {
      await record.assertLease()
    } catch {
      const error = new Error('Execution lease became stale.')
      error.code = 'STALE_LEASE'
      record.controller.abort()
      if (record.containerId) {
        await this.#runtime.stop(record.containerId, record.input.resourcePolicy)
      }
      throw error
    }
  }

  async #get(execution, correlation) {
    const requestedId = typeof execution === 'string'
      ? execution
      : execution?.executionId
    let record = this.#executions.get(requestedId)
      ?? [...this.#executions.values()].find((item) =>
        item.containerId === execution?.providerExecutionId)
    if (!record && typeof execution?.providerExecutionId === 'string'
      && typeof this.#runtime.inspectLabels === 'function') {
      const containerId = validateContainerId(execution.providerExecutionId)
      const metadata = await this.#runtime.inspectLabels(containerId, {
        timeoutMs: 5000,
        logBytes: 16 * 1024,
      })
      const labels = metadata.labels
      const recovered = {
        deploymentId: labels['deployhub.deployment_id'],
        jobId: labels['deployhub.job_id'],
        leaseGeneration: Number(labels['deployhub.lease_generation']),
        executionId: labels['deployhub.execution_id'],
        providerExecutionId: containerId,
        commitSha: labels['deployhub.commit_sha'],
        containerId,
        state: metadata.running ? 'RUNNING' : 'FAILED',
        cleanupState: 'PENDING',
        input: {
          resourcePolicy: { timeoutMs: 5000, logBytes: 16 * 1024 },
        },
        startedAt: this.#timestamp(),
        completedAt: null,
        result: null,
        progress: [],
        outputBytes: 0,
        output: [],
        controller: new AbortController(),
        task: null,
        cleaned: false,
        source: null,
      }
      validateRecoveredSnapshot({
        deploymentId: recovered.deploymentId,
        jobId: recovered.jobId,
        leaseGeneration: recovered.leaseGeneration,
        executionId: recovered.executionId,
        providerExecutionId: recovered.providerExecutionId,
      })
      this.#executions.set(recovered.executionId, recovered)
      record = recovered
    }
    if (!record || !matchesCorrelation(record, correlation)) {
      throw new IsolatedRuntimeError('Isolated runtime correlation is stale or invalid.', {
        code: 'EXECUTION_CORRELATION_MISMATCH',
      })
    }
    return record
  }

  #timestamp() {
    const date = this.clock()
    if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
      throw new Error('Isolated runtime clock is invalid.')
    }
    return date.toISOString()
  }
}

function validateCorrelation(input, correlation) {
  if (!correlation || correlation.deploymentId !== input.deploymentId
    || correlation.jobId !== input.jobId
    || correlation.leaseGeneration !== input.leaseGeneration
    || typeof correlation.executionId !== 'string'
    || !/^[A-Za-z0-9._:-]{1,200}$/.test(correlation.executionId)) {
    throw new IsolatedRuntimeError('Isolated runtime correlation is invalid.', {
      code: 'EXECUTION_CORRELATION_MISMATCH',
    })
  }
}

function matchesCorrelation(record, correlation) {
  return Boolean(correlation)
    && record.deploymentId === correlation.deploymentId
    && record.jobId === correlation.jobId
    && record.leaseGeneration === correlation.leaseGeneration
    && record.executionId === correlation.executionId
}

function fingerprintInput(input) {
  return JSON.stringify({
    schemaVersion: input.schemaVersion,
    deploymentId: input.deploymentId,
    jobId: input.jobId,
    leaseGeneration: input.leaseGeneration,
    repository: input.repository,
    requestedBranch: input.requestedBranch,
    commitSha: input.commitSha,
    buildMode: input.buildMode,
    resourcePolicy: {
      cpuMilli: input.resourcePolicy.cpuMilli,
      memoryMb: input.resourcePolicy.memoryMb,
      diskMb: input.resourcePolicy.diskMb,
      pidLimit: input.resourcePolicy.pidLimit,
      timeoutMs: input.resourcePolicy.timeoutMs,
      logBytes: input.resourcePolicy.logBytes,
    },
    networkPolicy: input.networkPolicy,
  })
}

function executionHandle(record) {
  return {
    deploymentId: record.deploymentId,
    executionId: record.executionId,
    jobId: record.jobId,
    leaseGeneration: record.leaseGeneration,
    providerExecutionId: record.containerId ?? `docker_${record.executionId}`,
  }
}

function validateContainerId(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{12,64}$/i.test(value)) {
    throw new IsolatedRuntimeError('Docker runtime returned an invalid container ID.')
  }
  return value
}

function failureResult(record, message, failureKind, failureCode = 'EXECUTION_FAILED') {
  const safeError = message.slice(0, MAX_ERROR_BYTES)
  return {
    schemaVersion: EXECUTION_RESULT_VERSION,
    deploymentId: record.deploymentId,
    jobId: record.jobId,
    commitSha: record.commitSha,
    outcome: 'FAILURE',
    failureKind,
    detectedStack: null,
    startedAt: record.startedAt,
    completedAt: record.completedAt ?? record.startedAt,
    logs: boundedLogs([...record.output, safeError], 'error'),
    error: safeError,
    artifact: null,
    failureCode,
  }
}

function remainingTime(deadline) {
  const value = deadline - Date.now()
  if (value <= 0) {
    const error = new Error('Execution timeout reached.')
    error.code = 'EXECUTION_TIMEOUT'
    throw error
  }
  return value
}

function sanitizeBuildError(error) {
  if (error instanceof ApplicationBuildError) return error.message.slice(0, MAX_ERROR_BYTES)
  return 'Isolated Node.js static application build or image creation failed.'
}

function boundedLogs(output, level) {
  let remaining = MAX_LOG_BYTES
  const logs = []
  for (const chunk of output) {
    if (remaining <= 0) break
    let message = ''
    let messageBytes = 0
    for (const character of chunk) {
      const characterBytes = Buffer.byteLength(character, 'utf8')
      if (characterBytes + messageBytes > Math.min(remaining, MAX_LOG_LINE_BYTES)) {
        if (message) {
          logs.push({ level, message })
          remaining -= messageBytes
        }
        message = ''
        messageBytes = 0
        if (characterBytes > remaining || characterBytes > MAX_LOG_LINE_BYTES) break
      }
      message += character
      messageBytes += characterBytes
    }
    if (message) {
      logs.push({ level, message })
      remaining -= messageBytes
    }
  }
  return logs
}

function sanitizeOutput(value) {
  return stripControlCharacters(stripAnsiEscapes(value))
    .replace(/\b(token|password|secret|authorization|api[_-]?key)\s*[:=]\s*\S+/gi, '$1=[REDACTED]')
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

function validateRecoveredSnapshot(snapshot) {
  if (typeof snapshot.deploymentId !== 'string'
    || typeof snapshot.jobId !== 'string'
    || !Number.isSafeInteger(snapshot.leaseGeneration)
    || snapshot.leaseGeneration < 1
    || typeof snapshot.executionId !== 'string'
    || typeof snapshot.providerExecutionId !== 'string') {
    throw new Error('Docker returned invalid execution labels.')
  }
}
