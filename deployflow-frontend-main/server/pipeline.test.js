import test from 'node:test'
import assert from 'node:assert/strict'
import { runDeployment } from './pipeline.js'

test('records an explicit failed deployment when isolated infrastructure is not configured', async () => {
  const configurationKeys = [
    'DEPLOYMENT_EXECUTOR',
    'BUILD_RUNNER_ISOLATED',
    'DOCKER_REGISTRY',
    'KUBE_NAMESPACE',
    'DEPLOYMENT_DOMAIN',
    'KUBE_TLS_SECRET',
    'DEPLOYMENT_HEALTH_PATH',
    'KUBECONFIG',
  ]
  const previous = new Map(configurationKeys.map((key) => [key, process.env[key]]))
  for (const key of configurationKeys) delete process.env[key]

  const queries = []
  const pool = {
    async query(statement, values) {
      queries.push({ statement, values })
      return { rows: [] }
    },
  }

  try {
    await runDeployment(pool, {
      id: '00000000-0000-4000-8000-000000000001',
      repo_url: 'https://github.com/example/app.git',
      branch: 'main',
    })
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }

  assert.equal(queries.length, 2)
  assert.match(queries[0].statement, /SET status = 'failed'/)
  assert.match(queries[0].values[1], /DEPLOYMENT_EXECUTOR=isolated-docker/)
  assert.match(queries[0].values[1], /KUBECONFIG/)
  assert.equal(queries[1].values[1], 'error')
  assert.match(queries[1].values[2], /Deployment prerequisites are missing/)
})
