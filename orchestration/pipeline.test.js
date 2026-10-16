import test from 'node:test'
import assert from 'node:assert/strict'
import { runDeployment } from './pipeline.js'

test('orchestrator validates then fails safely without executing repository code', async () => {
  const row = {
    id: '00000000-0000-4000-8000-000000000001',
    status: 'QUEUED',
    stage: 'QUEUED',
    branch: 'main',
    repo_url: 'https://github.com/example/app.git',
  }
  const transitions = []
  const pool = {
    async query(statement, values) {
      if (statement.includes('FROM deployments') && statement.includes('JOIN projects')) {
        return { rows: [{ ...row }] }
      }
      if (statement.includes('SELECT status, stage FROM deployments')) {
        return { rows: [{ status: row.status, stage: row.stage }] }
      }
      if (statement.includes('WITH changed AS')) {
        transitions.push(values)
        row.status = values[3]
        row.stage = values[4]
        return { rowCount: 1 }
      }
      throw new Error(`Unexpected test query: ${statement}`)
    },
  }

  const result = await runDeployment(pool, {
    deployment_id: row.id,
    id: 'job-id',
    worker_id: 'worker-1',
    lease_generation: 1,
  }, {
    lease: { id: 'job-id', worker_id: 'worker-1', lease_generation: 1 },
  })

  assert.equal(result.outcome, 'failed')
  assert.match(result.error.message, /disabled until a separately approved isolated build executor/)
  assert.deepEqual(transitions.map((values) => values.slice(3, 5)), [
    ['VALIDATING', 'VALIDATING_REPOSITORY'],
    ['FAILED', 'VALIDATING_REPOSITORY'],
  ])
  assert.equal(row.status, 'FAILED')
  assert.equal(row.stage, 'VALIDATING_REPOSITORY')
})
