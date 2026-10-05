import test from 'node:test'
import assert from 'node:assert/strict'
import {
  canTransitionDeployment,
  deploymentStatusLabel,
  failDeployment,
  isActiveDeploymentStatus,
  isTerminalDeploymentStatus,
  normalizeDeploymentStage,
  normalizeDeploymentStatus,
  transitionDeployment,
} from './deploymentStates.js'
import {
  deploymentTimelineStep,
  isActiveDeploymentStatus as isFrontendActiveStatus,
  normalizeDeploymentStatus as normalizeFrontendStatus,
  deploymentStatusTone as frontendStatusTone,
} from '../src/utils/deploymentStates.js'

test('normalizes legacy statuses and stages without treating unknown states as successful', () => {
  assert.equal(normalizeDeploymentStatus('live'), 'RUNNING')
  assert.equal(normalizeDeploymentStatus('pushing'), 'PUSHING_IMAGE')
  assert.equal(normalizeDeploymentStage('building'), 'CREATING_IMAGE')
  assert.equal(deploymentStatusLabel('RUNNING'), 'Running')
  assert.equal(deploymentStatusLabel('unexpected'), 'unexpected')
  assert.equal(isActiveDeploymentStatus('VALIDATING'), true)
  assert.equal(isActiveDeploymentStatus('unexpected'), false)
  assert.equal(isTerminalDeploymentStatus('live'), true)
  assert.equal(isTerminalDeploymentStatus('FAILED'), true)
  assert.equal(isTerminalDeploymentStatus('unexpected'), false)
})

test('frontend compatibility handles legacy, approved, terminal, and unknown values safely', () => {
  assert.equal(normalizeFrontendStatus('live'), 'RUNNING')
  assert.equal(normalizeFrontendStatus('PUSHING_IMAGE'), 'PUSHING_IMAGE')
  assert.equal(isFrontendActiveStatus('VALIDATING'), true)
  assert.equal(isFrontendActiveStatus('RUNNING'), false)
  assert.equal(isFrontendActiveStatus('FAILED'), false)
  assert.equal(isFrontendActiveStatus('unexpected'), false)
  assert.equal(deploymentTimelineStep('BUILDING_APPLICATION'), 3)
  assert.equal(deploymentTimelineStep('unrecognized'), -1)
  assert.equal(frontendStatusTone('unexpected'), 'neutral')
  assert.equal(frontendStatusTone('RUNNING'), 'success')
})

test('allows only approved forward transitions and activity-stage-preserving failures', () => {
  assert.equal(canTransitionDeployment('QUEUED', 'QUEUED', 'VALIDATING', 'VALIDATING_REPOSITORY'), true)
  assert.equal(canTransitionDeployment('BUILDING', 'DETECTING_TECHNOLOGY', 'BUILDING', 'CREATING_IMAGE'), true)
  assert.equal(canTransitionDeployment('BUILDING', 'DETECTING_TECHNOLOGY', 'DEPLOYING', 'APPLYING_KUBERNETES_DEPLOYMENT'), false)
  assert.equal(canTransitionDeployment('RUNNING', 'RUNNING', 'FAILED', 'RUNNING'), false)
  assert.equal(canTransitionDeployment('BUILDING', 'CREATING_IMAGE', 'FAILED', 'CREATING_IMAGE'), true)
  assert.equal(canTransitionDeployment('BUILDING', 'CREATING_IMAGE', 'FAILED', 'BUILDING_APPLICATION'), false)
})

test('persists each transition and its log atomically with guarded state matching', async () => {
  const calls = []
  const pool = {
    async query(statement, values) {
      calls.push({ statement, values })
      return { rowCount: 1 }
    },
  }
  await transitionDeployment(pool, {
    id: 'deployment-id',
    fromStatus: 'QUEUED',
    fromStage: 'QUEUED',
    toStatus: 'VALIDATING',
    toStage: 'VALIDATING_REPOSITORY',
    message: 'Validation started.',
  })
  assert.equal(calls.length, 1)
  assert.match(calls[0].statement, /WITH changed AS/)
  assert.match(calls[0].statement, /WHERE id = \$1 AND status = \$2 AND stage = \$3/)
  assert.deepEqual(calls[0].values.slice(0, 8), [
    'deployment-id', 'QUEUED', 'QUEUED', 'VALIDATING',
    'VALIDATING_REPOSITORY', null, 'info', 'Validation started.',
  ])
  assert.deepEqual(calls[0].values.slice(8), [null, null, null])

  await failDeployment(pool, {
    id: 'deployment-id',
    status: 'VALIDATING',
    stage: 'VALIDATING_REPOSITORY',
    message: 'Validation failed.',
  })
  assert.equal(calls[1].values[3], 'FAILED')
  assert.equal(calls[1].values[4], 'VALIDATING_REPOSITORY')
  assert.equal(calls[1].values[6], 'error')
})

test('rejects missing transition logs and concurrent state changes', async () => {
  await assert.rejects(
    transitionDeployment({ query: async () => ({ rowCount: 0 }) }, {
      id: 'deployment-id',
      fromStatus: 'QUEUED',
      fromStage: 'QUEUED',
      toStatus: 'VALIDATING',
      toStage: 'VALIDATING_REPOSITORY',
      message: 'Validation started.',
    }),
    /changed concurrently/,
  )
  await assert.rejects(
    transitionDeployment({ query: async () => ({ rowCount: 1 }) }, {
      id: 'deployment-id',
      fromStatus: 'QUEUED',
      fromStage: 'QUEUED',
      toStatus: 'VALIDATING',
      toStage: 'VALIDATING_REPOSITORY',
      message: '',
    }),
    /requires a log message/,
  )
})
