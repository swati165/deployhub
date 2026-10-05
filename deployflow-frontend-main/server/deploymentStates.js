export const DEPLOYMENT_STATUSES = Object.freeze([
  'QUEUED',
  'VALIDATING',
  'CLONING',
  'BUILDING',
  'PUSHING_IMAGE',
  'DEPLOYING',
  'RUNNING',
  'FAILED',
])

export const DEPLOYMENT_STAGES = Object.freeze([
  'QUEUED',
  'VALIDATING_REPOSITORY',
  'CLONING_REPOSITORY',
  'DETECTING_TECHNOLOGY',
  'INSTALLING_DEPENDENCIES',
  'BUILDING_APPLICATION',
  'CREATING_IMAGE',
  'AUTHENTICATING_REGISTRY',
  'PUSHING_IMAGE',
  'APPLYING_KUBERNETES_DEPLOYMENT',
  'CREATING_SERVICE',
  'CREATING_INGRESS',
  'VERIFYING_ROLLOUT',
  'GENERATING_LIVE_URL',
  'RUNNING',
])

export const DEPLOYMENT_TIMELINE_STAGES = DEPLOYMENT_STAGES

export const ACTIVE_DEPLOYMENT_STATUSES = Object.freeze([
  'QUEUED',
  'VALIDATING',
  'CLONING',
  'BUILDING',
  'PUSHING_IMAGE',
  'DEPLOYING',
])

const LEGACY_STATUS_MAP = Object.freeze({
  queued: 'QUEUED',
  cloning: 'CLONING',
  building: 'BUILDING',
  pushing: 'PUSHING_IMAGE',
  deploying: 'DEPLOYING',
  live: 'RUNNING',
  failed: 'FAILED',
})

const LEGACY_STAGE_MAP = Object.freeze({
  queued: 'QUEUED',
  cloning: 'CLONING_REPOSITORY',
  building: 'CREATING_IMAGE',
  pushing: 'PUSHING_IMAGE',
  deploying: 'APPLYING_KUBERNETES_DEPLOYMENT',
  live: 'RUNNING',
})

const STAGES_BY_STATUS = Object.freeze({
  QUEUED: ['QUEUED'],
  VALIDATING: ['VALIDATING_REPOSITORY'],
  CLONING: ['CLONING_REPOSITORY'],
  BUILDING: ['DETECTING_TECHNOLOGY', 'INSTALLING_DEPENDENCIES', 'BUILDING_APPLICATION', 'CREATING_IMAGE'],
  PUSHING_IMAGE: ['AUTHENTICATING_REGISTRY', 'PUSHING_IMAGE'],
  DEPLOYING: [
    'APPLYING_KUBERNETES_DEPLOYMENT',
    'CREATING_SERVICE',
    'CREATING_INGRESS',
    'VERIFYING_ROLLOUT',
    'GENERATING_LIVE_URL',
  ],
  RUNNING: ['RUNNING'],
  FAILED: DEPLOYMENT_STAGES.filter((stage) => stage !== 'RUNNING'),
})

const NEXT_STATUS = Object.freeze({
  QUEUED: 'VALIDATING',
  VALIDATING: 'CLONING',
  CLONING: 'BUILDING',
  BUILDING: 'PUSHING_IMAGE',
  PUSHING_IMAGE: 'DEPLOYING',
  DEPLOYING: 'RUNNING',
})

export function normalizeDeploymentStatus(status) {
  if (typeof status !== 'string') return status
  return LEGACY_STATUS_MAP[status] ?? status
}

export function normalizeDeploymentStage(stage) {
  if (typeof stage !== 'string') return stage
  return LEGACY_STAGE_MAP[stage] ?? stage
}

export function isActiveDeploymentStatus(status) {
  return ACTIVE_DEPLOYMENT_STATUSES.includes(normalizeDeploymentStatus(status))
}

export function isTerminalDeploymentStatus(status) {
  const normalized = normalizeDeploymentStatus(status)
  return normalized === 'RUNNING' || normalized === 'FAILED'
}

export function deploymentStatusLabel(status) {
  const normalized = normalizeDeploymentStatus(status)
  const labels = {
    QUEUED: 'Queued',
    VALIDATING: 'Validating',
    CLONING: 'Cloning',
    BUILDING: 'Building',
    PUSHING_IMAGE: 'Pushing image',
    DEPLOYING: 'Deploying',
    RUNNING: 'Running',
    FAILED: 'Failed',
  }
  return labels[normalized] ?? (typeof status === 'string' ? status : 'Unknown')
}

export function deploymentStageLabel(stage) {
  const normalized = normalizeDeploymentStage(stage)
  if (typeof normalized !== 'string') return 'Unknown stage'
  return normalized
    .split('_')
    .map((part) => part.charAt(0) + part.slice(1).toLowerCase())
    .join(' ')
}

export function deploymentStatusTone(status) {
  const normalized = normalizeDeploymentStatus(status)
  if (normalized === 'RUNNING') return 'success'
  if (normalized === 'FAILED') return 'failed'
  if (ACTIVE_DEPLOYMENT_STATUSES.includes(normalized)) return 'pending'
  return 'neutral'
}

export function canTransitionDeployment(fromStatus, fromStage, toStatus, toStage) {
  if (!DEPLOYMENT_STATUSES.includes(fromStatus) || !DEPLOYMENT_STATUSES.includes(toStatus)) return false
  if (!STAGES_BY_STATUS[toStatus]?.includes(toStage)) return false
  if (fromStatus === 'RUNNING' || fromStatus === 'FAILED') return false
  if (toStatus === 'FAILED') return STAGES_BY_STATUS.FAILED.includes(fromStage) && toStage === fromStage
  if (toStatus === fromStatus) {
    const stages = STAGES_BY_STATUS[fromStatus]
    return stages.indexOf(toStage) > stages.indexOf(fromStage)
  }
  return NEXT_STATUS[fromStatus] === toStatus && toStage === STAGES_BY_STATUS[toStatus][0]
}

export async function transitionDeployment(pool, {
  id,
  fromStatus,
  fromStage,
  toStatus,
  toStage,
  level = 'info',
  message,
  liveUrl = null,
  lease = null,
}) {
  if (!canTransitionDeployment(fromStatus, fromStage, toStatus, toStage)) {
    throw new Error(`Invalid deployment transition: ${fromStatus}/${fromStage} -> ${toStatus}/${toStage}.`)
  }
  if (typeof message !== 'string' || !message.trim()) {
    throw new Error('Deployment transition requires a log message.')
  }

  const result = await pool.query(
    `WITH changed AS (
       UPDATE deployments
       SET status = $4,
           stage = $5,
           live_url = CASE
             WHEN $4 = 'RUNNING' THEN $6
             WHEN $4 = 'FAILED' THEN NULL
             ELSE live_url
           END,
           error = CASE
             WHEN $4 IN ('RUNNING', 'FAILED') THEN CASE WHEN $4 = 'FAILED' THEN $8 ELSE NULL END
             ELSE error
           END,
           updated_at = NOW()
       WHERE id = $1 AND status = $2 AND stage = $3
         AND (
           $9::uuid IS NULL
           OR EXISTS (
             SELECT 1 FROM deployment_jobs
             WHERE id = $9 AND deployment_id = deployments.id
               AND worker_id = $10 AND lease_generation = $11
               AND state = 'RUNNING' AND lease_expires_at > NOW()
           )
         )
       RETURNING id
     )
     INSERT INTO deployment_logs (deployment_id, level, message)
     SELECT id, $7, $8 FROM changed
     RETURNING deployment_id`,
    [
      id,
      fromStatus,
      fromStage,
      toStatus,
      toStage,
      liveUrl,
      level,
      message,
      lease?.id ?? null,
      lease?.worker_id ?? null,
      lease?.lease_generation ?? null,
    ],
  )
  if (result.rowCount !== 1) {
    throw new Error(`Deployment ${id} changed concurrently or no longer matches ${fromStatus}/${fromStage}.`)
  }
}

export async function failDeployment(pool, { id, status, stage, message, lease = null }) {
  return transitionDeployment(pool, {
    id,
    fromStatus: status,
    fromStage: stage,
    toStatus: 'FAILED',
    toStage: stage,
    level: 'error',
    message,
    lease,
  })
}

export async function failCurrentDeployment(pool, { id, message, lease = null }) {
  const result = await pool.query('SELECT status, stage FROM deployments WHERE id = $1', [id])
  const row = result.rows[0]
  if (!row || !ACTIVE_DEPLOYMENT_STATUSES.includes(row.status)) return false
  await failDeployment(pool, {
    id,
    status: row.status,
    stage: row.stage,
    message,
    lease,
  })
  return true
}
