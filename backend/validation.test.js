import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildKubernetesManifests,
  detectStack,
  validateBranch,
  validateGitHubUrl,
} from './validation.js'

test('accepts canonical public GitHub repository URLs and normalizes .git', () => {
  assert.equal(
    validateGitHubUrl('https://github.com/acme/service'),
    'https://github.com/acme/service.git',
  )
  assert.equal(
    validateGitHubUrl('https://github.com/acme/service.git/'),
    'https://github.com/acme/service.git',
  )
})

test('rejects URLs that could target credentials, non-GitHub hosts, or extra paths', () => {
  for (const value of [
    'http://github.com/acme/service',
    'https://github.com.evil.test/acme/service',
    'https://user:secret@github.com/acme/service',
    'https://github.com/acme/service/tree/main',
    'https://github.com/acme/service?redirect=https://localhost',
  ]) {
    assert.throws(() => validateGitHubUrl(value))
  }
})

test('validates branches before passing them to git', () => {
  assert.equal(validateBranch('release/1.2.0'), 'release/1.2.0')
  for (const branch of ['--upload-pack=evil', 'main..evil', '../main', 'bad branch', '-main']) {
    assert.throws(() => validateBranch(branch))
  }
})

test('detects common stacks from repository files', () => {
  assert.equal(detectStack(['package.json']), 'Node.js')
  assert.equal(detectStack(['go.mod']), 'Go')
  assert.equal(detectStack(['Dockerfile']), 'Docker')
  assert.equal(detectStack(['README.md']), 'Unknown')
})

test('builds bounded Kubernetes Deployment, Service, and Ingress resources', () => {
  const resources = buildKubernetesManifests({
    deploymentId: '1234-abcd',
    image: 'registry.example/deployhub/1234-abcd:latest',
    host: '1234-abcd.apps.example.com',
    namespace: 'deployhub',
    tlsSecret: 'deployhub-tls',
    healthPath: '/health',
  })
  assert.deepEqual(resources.map((resource) => resource.kind), ['Deployment', 'Service', 'Ingress'])
  assert.equal(resources[0].spec.replicas, 1)
  assert.equal(resources[0].spec.template.spec.containers[0].resources.limits.memory, '512Mi')
  assert.equal(resources[2].spec.rules[0].host, '1234-abcd.apps.example.com')
  assert.equal(resources[2].spec.tls[0].secretName, 'deployhub-tls')
  assert.equal(resources[0].spec.template.spec.containers[0].readinessProbe.httpGet.path, '/health')
})
