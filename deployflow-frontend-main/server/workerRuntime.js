import { hostname } from 'node:os'
import { randomUUID } from 'node:crypto'
import {
  calculateRetryDelay,
  claimNextJob,
  completeJob,
  deadLetterJob,
  JOB_CONFIG,
  listOrphanedActiveDeployments,
  listUnfinalizedDeadLetters,
  markJobRunning,
  renewJobLease,
  scheduleJobRetry,
} from './jobQueue.js'
import { failCurrentDeployment } from './deploymentStates.js'
import {
  reconcileConfiguredExecutions,
  runDeployment,
} from './deploymentOrchestrator.js'

function sanitizedError(error) {
  if (error?.name === 'DeploymentExecutionError' && typeof error.message === 'string') {
    return error.message.slice(0, 500)
  }
  return 'Deployment worker encountered an execution error; inspect restricted worker diagnostics.'
}

function sleep(ms, signal) {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

async function finalizeDeadLetters(pool) {
  const rows = await listUnfinalizedDeadLetters(pool)
  for (const job of rows) {
    await failCurrentDeployment(pool, {
      id: job.deployment_id,
      message: job.last_error || 'Deployment job exhausted its automatic attempts.',
    })
  }
}

async function reconcileExecutionsSafely(pool) {
  try {
    await reconcileConfiguredExecutions(pool)
  } catch {
    console.error('Isolated runtime reconciliation failed; stale executions remain subject to cleanup retry.')
  }
}

async function processClaimedJob(pool, claim, {
  config,
  orchestrator,
}) {
  const lease = {
    id: claim.id,
    worker_id: claim.worker_id,
    lease_generation: claim.lease_generation,
  }
  if (!await markJobRunning(pool, claim)) return

  let leaseLost = false
  let heartbeatInFlight = false
  const executionController = new AbortController()
  const heartbeat = setInterval(async () => {
    if (heartbeatInFlight || leaseLost) return
    heartbeatInFlight = true
    try {
      leaseLost = !await renewJobLease(pool, claim, { leaseMs: config.leaseMs })
      if (leaseLost) {
        executionController.abort()
        console.error(`Worker lost lease for deployment job ${claim.id}.`)
      }
    } catch (error) {
      console.error(`Could not renew lease for deployment job ${claim.id}:`, error)
    } finally {
      heartbeatInFlight = false
    }
  }, config.heartbeatMs)
  heartbeat.unref?.()

  try {
    const outcome = await orchestrator(pool, claim, {
      lease,
      signal: executionController.signal,
    })
    if (leaseLost) return
    if (outcome?.outcome === 'completed') {
      const deployment = await pool.query(
        'SELECT status FROM deployments WHERE id = $1',
        [claim.deployment_id],
      )
      if (deployment.rows[0]?.status !== 'RUNNING') {
        throw new Error('Orchestrator reported completion before the Deployment reached RUNNING.')
      }
      if (!await completeJob(pool, claim)) {
        console.error(`Could not complete deployment job ${claim.id}; its lease is no longer current.`)
      }
      return
    }

    const error = outcome?.error instanceof Error
      ? outcome.error
      : new Error('Deployment orchestrator returned a terminal failure.')
    const safeMessage = sanitizedError(error)
    if (error.retryable === true && claim.attempts < claim.max_attempts) {
      const state = await scheduleJobRetry(pool, claim, safeMessage, {
        delayMs: calculateRetryDelay(claim.attempts, {
          baseMs: config.retryBaseMs,
          maxMs: config.retryMaxMs,
        }),
      })
      if (!state) console.error(`Could not schedule retry for deployment job ${claim.id}; its lease is no longer current.`)
      return
    }
    await failCurrentDeployment(pool, {
      id: claim.deployment_id,
      message: safeMessage,
      lease,
    })
    if (!await deadLetterJob(pool, claim, safeMessage)) {
      console.error(`Could not dead-letter deployment job ${claim.id}; its lease is no longer current.`)
    }
  } catch (error) {
    if (leaseLost) return
    const safeMessage = sanitizedError(error)
    if (error?.retryable === true && claim.attempts < claim.max_attempts) {
      const state = await scheduleJobRetry(pool, claim, safeMessage, {
        delayMs: calculateRetryDelay(claim.attempts, {
          baseMs: config.retryBaseMs,
          maxMs: config.retryMaxMs,
        }),
      })
      if (!state) console.error(`Could not schedule retry for deployment job ${claim.id}; its lease is no longer current.`)
      return
    }
    await failCurrentDeployment(pool, {
      id: claim.deployment_id,
      message: safeMessage,
      lease,
    })
    if (!await deadLetterJob(pool, claim, safeMessage)) {
      console.error(`Could not dead-letter deployment job ${claim.id}; its lease is no longer current.`)
    }
  } finally {
    clearInterval(heartbeat)
  }
}

export async function runWorker(pool, {
  workerId = `${hostname()}:${process.pid}:${randomUUID()}`,
  config = JOB_CONFIG,
  orchestrator = runDeployment,
  signal = new AbortController().signal,
} = {}) {
  if (!workerId || typeof workerId !== 'string') throw new Error('Worker identity is required.')
  if (config.heartbeatMs >= config.leaseMs) throw new Error('Worker heartbeat interval must be shorter than its lease.')

  const orphans = await listOrphanedActiveDeployments(pool)
  for (const deployment of orphans) {
    console.error(`Active deployment ${deployment.id} has no durable job (status ${deployment.status}, stage ${deployment.stage}).`)
  }

  await reconcileExecutionsSafely(pool)
  let nextExecutionReconciliation = Date.now() + 15_000
  while (!signal.aborted) {
    if (Date.now() >= nextExecutionReconciliation) {
      await reconcileExecutionsSafely(pool)
      nextExecutionReconciliation = Date.now() + 15_000
    }
    await finalizeDeadLetters(pool)
    if (signal.aborted) break
    const claim = await claimNextJob(pool, workerId, { leaseMs: config.leaseMs })
    if (!claim) {
      await sleep(config.pollIntervalMs, signal)
      continue
    }
    try {
      await processClaimedJob(pool, claim, { config, orchestrator })
    } catch (error) {
      console.error(`Deployment job ${claim.id} failed before orchestration could persist an outcome:`, error)
    }
  }
}
