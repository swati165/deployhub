import {
  validateSourceRequest,
  validateSourceResolution,
} from './executors/SourceResolver.js'
import { RegistryProviderError, validateRegistryPushResult } from './executors/RegistryProvider.js'

const PROVIDER_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i
const EXECUTION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/
const EXECUTOR_STATUSES = new Set([
  'PROVISIONED',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'RETRYABLE_FAILURE',
  'TIMED_OUT',
  'CANCELLED',
  'ABANDONED',
])
const CLEANUP_STATES = new Set(['NOT_REQUIRED', 'PENDING', 'FAILED', 'CLEANED'])
const MAX_RESULT_BYTES = 128 * 1024
const MAX_ERROR_BYTES = 1000

export class PostgresExecutionStore {
  #pool

  constructor(pool) {
    if (!pool || typeof pool.query !== 'function') throw new TypeError('PostgreSQL pool is required.')
    this.#pool = pool
  }

  async getSourceResolution(request, { leaseGeneration, workerId }) {
    assertGeneration(leaseGeneration)
    assertWorkerId(workerId)
    validateSourceRequest(request)
    const result = await this.#pool.query(
      `SELECT jobs.source_commit_sha, jobs.source_resolved_at
       FROM deployment_jobs jobs
       JOIN deployments d ON d.id = jobs.deployment_id
       JOIN projects p ON p.id = d.project_id
       WHERE jobs.id = $1 AND jobs.deployment_id = $2
         AND jobs.lease_generation = $3 AND jobs.worker_id = $4
         AND jobs.state = 'RUNNING' AND jobs.lease_expires_at > NOW()
         AND d.branch = $5 AND p.repo_url = $6`,
      [
        request.jobId,
        request.deploymentId,
        leaseGeneration,
        workerId,
        request.requestedBranch,
        request.repository,
      ],
    )
    const row = result.rows[0]
    if (!row) throw new Error('Source SHA lookup was rejected because the job lease or source changed.')
    if (row.source_commit_sha === null) return null
    if (row.source_resolved_at === null) throw new Error('Persisted source SHA metadata is incomplete.')
    return {
      commitSha: row.source_commit_sha,
      resolvedAt: row.source_resolved_at,
    }
  }

  async recordSourceResolution(resolution, { leaseGeneration, workerId }) {
    assertGeneration(leaseGeneration)
    assertWorkerId(workerId)
    validateSourceResolution(resolution, resolution)
    const result = await this.#pool.query(
      `UPDATE deployment_jobs
       SET source_commit_sha = COALESCE(source_commit_sha, $4),
           source_resolved_at = COALESCE(source_resolved_at, $5),
           updated_at = NOW()
       WHERE id = $1 AND deployment_id = $2 AND lease_generation = $3 AND worker_id = $8
         AND state = 'RUNNING' AND lease_expires_at > NOW()
         AND (source_commit_sha IS NULL OR lower(source_commit_sha) = lower($4))
         AND EXISTS (
           SELECT 1
           FROM deployments d
           JOIN projects p ON p.id = d.project_id
           WHERE d.id = deployment_jobs.deployment_id
             AND d.branch = $6 AND p.repo_url = $7
         )
       RETURNING source_commit_sha, source_resolved_at`,
      [
        resolution.jobId,
        resolution.deploymentId,
        leaseGeneration,
        resolution.commitSha,
        resolution.resolvedAt,
        resolution.requestedBranch,
        resolution.repository,
        workerId,
      ],
    )
    const row = result.rows[0]
    if (result.rowCount !== 1 || !row) {
      throw new Error('Source SHA resolution was rejected because the job lease or source changed.')
    }
    if (typeof row.source_commit_sha !== 'string'
      || row.source_commit_sha.toLowerCase() !== resolution.commitSha.toLowerCase()
      || row.source_resolved_at === null || row.source_resolved_at === undefined) {
      throw new Error('Persisted source SHA does not match the resolved commit.')
    }
    return {
      commitSha: row.source_commit_sha,
      resolvedAt: row.source_resolved_at,
    }
  }

  async reserveExecution({ jobId, deploymentId, leaseGeneration, provider, executionId }) {
    validateCorrelation({ jobId, deploymentId, leaseGeneration, provider, executionId })
    const result = await this.#pool.query(
      `INSERT INTO deployment_executions (
         id, job_id, deployment_id, lease_generation, provider_name
       )
       SELECT $5, jobs.id, jobs.deployment_id, $3, $4
       FROM deployment_jobs jobs
       WHERE jobs.id = $1 AND jobs.deployment_id = $2
         AND jobs.lease_generation = $3 AND jobs.state = 'RUNNING'
         AND jobs.lease_expires_at > NOW()
       ON CONFLICT (job_id, lease_generation) DO UPDATE
       SET updated_at = NOW()
       WHERE deployment_executions.id = EXCLUDED.id
         AND deployment_executions.provider_name = EXCLUDED.provider_name
       RETURNING id`,
      [jobId, deploymentId, leaseGeneration, provider, executionId],
    )
    assertOneRow(result, 'Execution reservation was rejected because the lease is stale or correlation conflicts.')
  }

  async recordProviderExecution({
    jobId,
    deploymentId,
    leaseGeneration,
    provider,
    executionId,
    providerExecutionId,
  }) {
    validateCorrelation({ jobId, deploymentId, leaseGeneration, provider, executionId })
    if (typeof providerExecutionId !== 'string' || !EXECUTION_ID_PATTERN.test(providerExecutionId)) {
      throw new Error('Provider execution ID is invalid.')
    }
    const result = await this.#pool.query(
      `UPDATE deployment_executions
       SET provider_execution_id = COALESCE(provider_execution_id, $6), updated_at = NOW()
       WHERE id = $5 AND job_id = $1 AND deployment_id = $2
         AND lease_generation = $3 AND provider_name = $4
         AND (provider_execution_id IS NULL OR provider_execution_id = $6)
       RETURNING id`,
      [jobId, deploymentId, leaseGeneration, provider, executionId, providerExecutionId],
    )
    assertOneRow(result, 'Provider execution ID conflicts with the durable execution correlation.')
  }

  async updateExecution({
    jobId,
    deploymentId,
    leaseGeneration,
    provider,
    executionId,
    providerExecutionId = null,
    status,
    cleanupState,
    result: executionResult = null,
    error = null,
  }) {
    validateCorrelation({ jobId, deploymentId, leaseGeneration, provider, executionId })
    if (providerExecutionId !== null
      && (typeof providerExecutionId !== 'string' || !EXECUTION_ID_PATTERN.test(providerExecutionId))) {
      throw new Error('Provider execution ID is invalid.')
    }
    if (!EXECUTOR_STATUSES.has(status)) throw new Error('Executor status is invalid.')
    if (!CLEANUP_STATES.has(cleanupState)) throw new Error('Executor cleanup state is invalid.')
    const serializedResult = serializeResult(executionResult)
    const safeError = sanitizeError(error)
    const updated = await this.#pool.query(
      `UPDATE deployment_executions
       SET status = $6, cleanup_state = $7, result = $8::jsonb, last_error = $9,
           updated_at = NOW()
       WHERE id = $5 AND job_id = $1 AND deployment_id = $2
         AND lease_generation = $3 AND provider_name = $4
         AND ($10::text IS NULL OR provider_execution_id = $10)
       RETURNING id`,
      [
        jobId,
        deploymentId,
        leaseGeneration,
        provider,
        executionId,
        status,
        cleanupState,
        serializedResult,
        safeError,
        providerExecutionId,
      ],
    )
    assertOneRow(updated, 'Executor update was rejected because execution correlation is stale.')
  }

  async getRegistryImage(request, { workerId }) {
    validateRegistryCorrelation(request)
    assertWorkerId(workerId)
    const active = await this.#pool.query(
      `SELECT 1
       FROM deployment_jobs
       WHERE id = $1 AND deployment_id = $2
         AND lease_generation = $3 AND worker_id = $4
         AND state = 'RUNNING' AND lease_expires_at > NOW()`,
      [request.jobId, request.deploymentId, request.leaseGeneration, workerId],
    )
    if (active.rowCount !== 1) {
      throw new RegistryProviderError('STALE_LEASE_GENERATION', 'Registry operation was rejected because the worker lease is stale.')
    }
    const result = await this.#pool.query(
      `SELECT 1 AS "schemaVersion", provider_name AS provider, registry, repository,
              pushed_tag AS tag, local_image_reference AS "localImageReference",
              local_image_digest AS "localImageDigest",
              source_commit_sha AS "commitSha", registry_digest AS "registryDigest",
              immutable_image AS image,
              to_char(pushed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "pushedAt",
              deployment_id AS "deploymentId", job_id AS "jobId",
              execution_id AS "executionId", lease_generation AS "leaseGeneration"
       FROM deployment_registry_images
       WHERE execution_id = $1 AND job_id = $2 AND deployment_id = $3
         AND lease_generation = $4`,
      [request.executionId, request.jobId, request.deploymentId, request.leaseGeneration],
    )
    return result.rows[0] ?? null
  }

  async recordRegistryImage(request, pushResult, { workerId }) {
    validateRegistryCorrelation(request)
    assertWorkerId(workerId)
    const metadata = validateRegistryPushResult(pushResult, request)
    const values = [
      request.executionId,
      request.jobId,
      request.deploymentId,
      request.leaseGeneration,
      metadata.provider,
      metadata.registry,
      metadata.repository,
      metadata.tag,
      metadata.localImageReference,
      metadata.localImageDigest,
      metadata.commitSha,
      metadata.registryDigest,
      metadata.image,
      metadata.pushedAt,
      workerId,
    ]
    let inserted
    try {
      inserted = await this.#pool.query(
        `INSERT INTO deployment_registry_images (
           execution_id, job_id, deployment_id, lease_generation, provider_name,
           registry, repository, pushed_tag, local_image_reference,
           local_image_digest, source_commit_sha, registry_digest,
           immutable_image, pushed_at
         )
         SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
         FROM deployment_executions executions
         JOIN deployment_jobs jobs
           ON jobs.id = executions.job_id AND jobs.deployment_id = executions.deployment_id
         WHERE executions.id = $1 AND executions.job_id = $2
           AND executions.deployment_id = $3 AND executions.lease_generation = $4
           AND jobs.lease_generation = $4 AND jobs.worker_id = $15
           AND jobs.state = 'RUNNING' AND jobs.lease_expires_at > NOW()
           AND lower(jobs.source_commit_sha) = lower($11)
         ON CONFLICT (execution_id) DO NOTHING
         RETURNING execution_id`,
        values,
      )
    } catch (error) {
      if (error?.code === '23505') {
        throw new RegistryProviderError('DUPLICATE_EXECUTION', 'Registry tag is already correlated to another execution.')
      }
      throw error
    }
    if (inserted.rowCount === 1) return metadata

    const prior = await this.getRegistryImage(request, { workerId })
    if (prior && sameRegistryIdentity(prior, metadata)) return prior
    throw new RegistryProviderError(
      'DUPLICATE_EXECUTION',
      'Registry metadata conflicts with an existing execution or source image.',
    )
  }

  async listRecoverableExecutions({ limit = 100 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new Error('Execution reconciliation limit is invalid.')
    }
    const result = await this.#pool.query(
      `SELECT executions.job_id, executions.deployment_id, jobs.state AS job_state,
              jobs.lease_generation, jobs.lease_expires_at,
              executions.provider_name AS execution_provider,
              executions.id AS executor_execution_id,
              executions.provider_execution_id,
              executions.lease_generation AS executor_lease_generation,
              executions.status AS executor_status,
              executions.cleanup_state AS executor_cleanup_state,
              executions.result AS executor_result,
              executions.last_error AS executor_last_error,
              jobs.source_commit_sha
       FROM deployment_executions executions
       JOIN deployment_jobs jobs ON jobs.id = executions.job_id
       WHERE executions.cleanup_state IN ('PENDING', 'FAILED')
          OR executions.status IN ('PROVISIONED', 'RUNNING')
       ORDER BY executions.updated_at, executions.id
       LIMIT $1`,
      [limit],
    )
    return result.rows
  }
}

function validateRegistryCorrelation(request) {
  if (!request || typeof request !== 'object'
    || typeof request.executionId !== 'string' || !EXECUTION_ID_PATTERN.test(request.executionId)
    || typeof request.jobId !== 'string' || !/^[0-9a-f-]{36}$/i.test(request.jobId)
    || typeof request.deploymentId !== 'string' || !/^[0-9a-f-]{36}$/i.test(request.deploymentId)
    || !Number.isSafeInteger(request.leaseGeneration) || request.leaseGeneration < 1) {
    throw new RegistryProviderError('REGISTRY_CONFIGURATION_INVALID', 'Registry execution correlation is invalid.')
  }
}

function sameRegistryIdentity(existing, metadata) {
  return existing.provider === metadata.provider
    && existing.registry === metadata.registry
    && existing.repository === metadata.repository
    && existing.tag === metadata.tag
    && existing.localImageReference === metadata.localImageReference
    && existing.localImageDigest?.toLowerCase() === metadata.localImageDigest.toLowerCase()
    && existing.commitSha?.toLowerCase() === metadata.commitSha.toLowerCase()
    && existing.registryDigest?.toLowerCase() === metadata.registryDigest.toLowerCase()
    && existing.image === metadata.image
    && new Date(existing.pushedAt).toISOString() === metadata.pushedAt
    && existing.deploymentId === metadata.deploymentId
    && existing.jobId === metadata.jobId
    && existing.executionId === metadata.executionId
    && Number(existing.leaseGeneration) === metadata.leaseGeneration
}

function validateCorrelation({ jobId, deploymentId, leaseGeneration, provider, executionId }) {
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  if (typeof jobId !== 'string' || !uuidPattern.test(jobId)
    || typeof deploymentId !== 'string' || !uuidPattern.test(deploymentId)) {
    throw new Error('Executor correlation identifiers are invalid.')
  }
  assertGeneration(leaseGeneration)
  if (typeof provider !== 'string' || !PROVIDER_NAME_PATTERN.test(provider)
    || typeof executionId !== 'string' || !EXECUTION_ID_PATTERN.test(executionId)) {
    throw new Error('Executor provider correlation is invalid.')
  }
}

function assertGeneration(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('Executor lease generation is invalid.')
}

function assertWorkerId(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 200) {
    throw new Error('Executor worker identity is invalid.')
  }
}

function serializeResult(result) {
  if (result === null) return null
  if (typeof result !== 'object' || Array.isArray(result)) throw new Error('Executor result must be an object.')
  const serialized = JSON.stringify(result)
  if (Buffer.byteLength(serialized, 'utf8') > MAX_RESULT_BYTES) {
    throw new Error('Executor result exceeds the allowed size.')
  }
  return serialized
}

function sanitizeError(value) {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') throw new Error('Executor error must be a string.')
  return value
    .replace(/\b(token|password|secret|authorization|api[_-]?key)\s*[:=]\s*\S+/gi, '$1=[REDACTED]')
    .slice(0, MAX_ERROR_BYTES)
}

function assertOneRow(result, message) {
  if (result.rowCount !== 1) throw new Error(message)
}
