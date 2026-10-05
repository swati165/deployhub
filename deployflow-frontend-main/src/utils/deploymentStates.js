const legacyStatusMap = Object.freeze({
  queued: 'QUEUED',
  cloning: 'CLONING',
  building: 'BUILDING',
  pushing: 'PUSHING_IMAGE',
  deploying: 'DEPLOYING',
  live: 'RUNNING',
  failed: 'FAILED',
})

const legacyStageMap = Object.freeze({
  queued: 'QUEUED',
  cloning: 'CLONING_REPOSITORY',
  building: 'CREATING_IMAGE',
  pushing: 'PUSHING_IMAGE',
  deploying: 'APPLYING_KUBERNETES_DEPLOYMENT',
  live: 'RUNNING',
})

export const ACTIVE_DEPLOYMENT_STATUSES = Object.freeze([
  'QUEUED',
  'VALIDATING',
  'CLONING',
  'BUILDING',
  'PUSHING_IMAGE',
  'DEPLOYING',
])

export function normalizeDeploymentStatus(status) {
  if (typeof status !== 'string') return status
  return legacyStatusMap[status] ?? status
}

export function normalizeDeploymentStage(stage) {
  if (typeof stage !== 'string') return stage
  return legacyStageMap[stage] ?? stage
}

export function isActiveDeploymentStatus(status) {
  return ACTIVE_DEPLOYMENT_STATUSES.includes(normalizeDeploymentStatus(status))
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
  return normalized.split('_').map((word) => word[0] + word.slice(1).toLowerCase()).join(' ')
}

export function deploymentStatusTone(status) {
  const normalized = normalizeDeploymentStatus(status)
  if (normalized === 'RUNNING') return 'success'
  if (normalized === 'FAILED') return 'failed'
  if (isActiveDeploymentStatus(normalized)) return 'pending'
  return 'neutral'
}

export function deploymentTimelineStep(stage) {
  const normalized = normalizeDeploymentStage(stage)
  if (normalized === 'QUEUED') return 0
  if (normalized === 'VALIDATING_REPOSITORY') return 1
  if (normalized === 'CLONING_REPOSITORY') return 2
  if (['DETECTING_TECHNOLOGY', 'INSTALLING_DEPENDENCIES', 'BUILDING_APPLICATION', 'CREATING_IMAGE'].includes(normalized)) return 3
  if (['AUTHENTICATING_REGISTRY', 'PUSHING_IMAGE'].includes(normalized)) return 4
  if ([
    'APPLYING_KUBERNETES_DEPLOYMENT',
    'CREATING_SERVICE',
    'CREATING_INGRESS',
    'VERIFYING_ROLLOUT',
    'GENERATING_LIVE_URL',
  ].includes(normalized)) return 5
  if (normalized === 'RUNNING') return 6
  return -1
}
