export const MAX_JOB_ATTEMPTS = 3

export const JOB_CONFIG = Object.freeze({
  pollIntervalMs: positiveInteger(process.env.JOB_POLL_INTERVAL_MS, 1000, 'JOB_POLL_INTERVAL_MS'),
  leaseMs: positiveInteger(process.env.JOB_LEASE_MS, 30_000, 'JOB_LEASE_MS'),
  heartbeatMs: positiveInteger(process.env.JOB_HEARTBEAT_INTERVAL_MS, 10_000, 'JOB_HEARTBEAT_INTERVAL_MS'),
  retryBaseMs: positiveInteger(process.env.JOB_RETRY_BASE_MS, 5_000, 'JOB_RETRY_BASE_MS'),
  retryMaxMs: positiveInteger(process.env.JOB_RETRY_MAX_MS, 300_000, 'JOB_RETRY_MAX_MS'),
})

if (JOB_CONFIG.heartbeatMs >= JOB_CONFIG.leaseMs) {
  throw new Error('JOB_HEARTBEAT_INTERVAL_MS must be less than JOB_LEASE_MS.')
}

function positiveInteger(value, fallback, name) {
  if (value === undefined || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer.`)
  return parsed
}

export function calculateRetryDelay(attempt, {
  baseMs = JOB_CONFIG.retryBaseMs,
  maxMs = JOB_CONFIG.retryMaxMs,
  random = Math.random,
} = {}) {
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error('Retry attempt must be a positive integer.')
  if (typeof random !== 'function') throw new TypeError('Retry jitter source must be a function.')
  const exponential = Math.min(maxMs, baseMs * (2 ** (attempt - 1)))
  return Math.round(Math.min(maxMs, exponential * (0.5 + random())))
}

export async function enqueueDeployment(client, deploymentId) {
  await client.query(
    `INSERT INTO deployment_jobs (deployment_id, max_attempts)
     VALUES ($1, $2)`,
    [deploymentId, MAX_JOB_ATTEMPTS],
  )
}

export async function claimNextJob(pool, workerId, { leaseMs = JOB_CONFIG.leaseMs } = {}) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `UPDATE deployment_jobs
       SET state = 'WAITING',
           available_at = NOW(),
           claimed_at = NULL,
           lease_expires_at = NULL,
           worker_id = NULL,
           last_error = 'Worker lease expired; job returned to the queue.',
           updated_at = NOW()
       WHERE state IN ('CLAIMED', 'RUNNING')
         AND lease_expires_at <= NOW()
         AND attempts < max_attempts`,
    )
    await client.query(
      `UPDATE deployment_jobs
       SET state = 'DEAD_LETTER',
           claimed_at = NULL,
           lease_expires_at = NULL,
           worker_id = NULL,
           completed_at = NOW(),
           last_error = 'Worker lease expired after the maximum number of attempts.',
           updated_at = NOW()
       WHERE state IN ('CLAIMED', 'RUNNING')
         AND lease_expires_at <= NOW()
         AND attempts >= max_attempts`,
    )
    const result = await client.query(
      `WITH next_job AS (
         SELECT id
         FROM deployment_jobs
         WHERE state IN ('WAITING', 'RETRY_WAIT')
           AND available_at <= NOW()
         ORDER BY available_at, created_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE deployment_jobs AS jobs
       SET state = 'CLAIMED',
           attempts = jobs.attempts + 1,
           claimed_at = NOW(),
           lease_expires_at = NOW() + ($2::bigint * INTERVAL '1 millisecond'),
           worker_id = $1,
           lease_generation = jobs.lease_generation + 1,
           updated_at = NOW()
       FROM next_job
       WHERE jobs.id = next_job.id
       RETURNING jobs.id, jobs.deployment_id, jobs.attempts, jobs.max_attempts,
         jobs.worker_id, jobs.lease_generation, jobs.lease_expires_at`,
      [workerId, leaseMs],
    )
    await client.query('COMMIT')
    return result.rows[0] ?? null
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function markJobRunning(pool, claim) {
  const result = await pool.query(
    `UPDATE deployment_jobs
     SET state = 'RUNNING',
         started_at = COALESCE(started_at, NOW()),
         updated_at = NOW()
     WHERE id = $1 AND worker_id = $2 AND lease_generation = $3
       AND state = 'CLAIMED' AND lease_expires_at > NOW()
     RETURNING id`,
    [claim.id, claim.worker_id, claim.lease_generation],
  )
  return result.rowCount === 1
}

export async function renewJobLease(pool, claim, { leaseMs = JOB_CONFIG.leaseMs } = {}) {
  const result = await pool.query(
    `UPDATE deployment_jobs
     SET lease_expires_at = NOW() + ($4::bigint * INTERVAL '1 millisecond'),
         updated_at = NOW()
     WHERE id = $1 AND worker_id = $2 AND lease_generation = $3
       AND state IN ('CLAIMED', 'RUNNING') AND lease_expires_at > NOW()
     RETURNING id`,
    [claim.id, claim.worker_id, claim.lease_generation, leaseMs],
  )
  return result.rowCount === 1
}

export async function scheduleJobRetry(pool, claim, error, {
  delayMs,
} = {}) {
  if (typeof error !== 'string' || !error.trim()) throw new Error('Retry requires a sanitized error message.')
  if (!Number.isSafeInteger(delayMs) || delayMs < 0) throw new Error('Retry delay must be a non-negative integer.')
  const result = await pool.query(
    `UPDATE deployment_jobs
     SET state = CASE WHEN attempts >= max_attempts THEN 'DEAD_LETTER' ELSE 'RETRY_WAIT' END,
         available_at = CASE
           WHEN attempts >= max_attempts THEN available_at
           ELSE NOW() + ($4::bigint * INTERVAL '1 millisecond')
         END,
         claimed_at = NULL,
         lease_expires_at = NULL,
         worker_id = NULL,
         completed_at = CASE WHEN attempts >= max_attempts THEN NOW() ELSE NULL END,
         last_error = $5,
         updated_at = NOW()
     WHERE id = $1 AND worker_id = $2 AND lease_generation = $3
       AND state IN ('CLAIMED', 'RUNNING') AND lease_expires_at > NOW()
     RETURNING state`,
    [claim.id, claim.worker_id, claim.lease_generation, delayMs, error.slice(0, 2000)],
  )
  return result.rows[0]?.state ?? null
}

export async function completeJob(pool, claim) {
  const result = await pool.query(
    `UPDATE deployment_jobs
     SET state = 'COMPLETED',
         completed_at = NOW(),
         claimed_at = NULL,
         lease_expires_at = NULL,
         worker_id = NULL,
         last_error = NULL,
         updated_at = NOW()
     WHERE id = $1 AND worker_id = $2 AND lease_generation = $3
       AND state = 'RUNNING' AND lease_expires_at > NOW()
     RETURNING id`,
    [claim.id, claim.worker_id, claim.lease_generation],
  )
  return result.rowCount === 1
}

export async function deadLetterJob(pool, claim, error) {
  const result = await pool.query(
    `UPDATE deployment_jobs
     SET state = 'DEAD_LETTER',
         completed_at = NOW(),
         claimed_at = NULL,
         lease_expires_at = NULL,
         worker_id = NULL,
         last_error = $4,
         updated_at = NOW()
     WHERE id = $1 AND worker_id = $2 AND lease_generation = $3
       AND state IN ('CLAIMED', 'RUNNING') AND lease_expires_at > NOW()
     RETURNING id`,
    [claim.id, claim.worker_id, claim.lease_generation, error.slice(0, 2000)],
  )
  return result.rowCount === 1
}

export async function listUnfinalizedDeadLetters(pool, limit = 50) {
  const result = await pool.query(
    `SELECT jobs.id, jobs.deployment_id, jobs.last_error,
            deployments.status, deployments.stage
     FROM deployment_jobs AS jobs
     JOIN deployments ON deployments.id = jobs.deployment_id
     WHERE jobs.state = 'DEAD_LETTER'
       AND deployments.status NOT IN ('RUNNING', 'FAILED')
     ORDER BY jobs.completed_at, jobs.id
     LIMIT $1`,
    [limit],
  )
  return result.rows
}

export async function listOrphanedActiveDeployments(pool) {
  const result = await pool.query(
    `SELECT deployments.id, deployments.status, deployments.stage
     FROM deployments
     LEFT JOIN deployment_jobs ON deployment_jobs.deployment_id = deployments.id
     WHERE deployments.status IN (
       'QUEUED', 'VALIDATING', 'CLONING', 'BUILDING', 'PUSHING_IMAGE', 'DEPLOYING'
     )
       AND deployment_jobs.id IS NULL
     ORDER BY deployments.created_at, deployments.id`,
  )
  return result.rows
}
