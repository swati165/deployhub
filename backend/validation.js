export class ValidationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ValidationError'
    this.status = 400
  }
}

export function validateGitHubUrl(value) {
  if (typeof value !== 'string' || value.length > 300) {
    throw new ValidationError('Enter a public GitHub repository URL.')
  }

  let url
  try {
    url = new URL(value)
  } catch {
    throw new ValidationError('Enter a valid public GitHub repository URL.')
  }

  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'github.com' ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new ValidationError('Only public repositories hosted on https://github.com are supported.')
  }

  const parts = url.pathname.replace(/\/+$/, '').split('/').filter(Boolean)
  if (parts.length !== 2 || !/^[A-Za-z0-9-]+$/.test(parts[0])) {
    throw new ValidationError('Use a GitHub URL in the form https://github.com/owner/repository.')
  }

  const repository = parts[1].replace(/\.git$/i, '')
  if (!/^[A-Za-z0-9._-]+$/.test(repository) || repository === '.' || repository === '..') {
    throw new ValidationError('The GitHub repository URL is invalid.')
  }

  return `https://github.com/${parts[0]}/${repository}.git`
}

export function validateBranch(value = 'main') {
  if (
    typeof value !== 'string' ||
    value.length > 120 ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) ||
    value.includes('..') ||
    value.endsWith('/') ||
    value.endsWith('.')
  ) {
    throw new ValidationError('Branch must contain only letters, numbers, dots, underscores, slashes, or hyphens.')
  }
  return value
}

export function detectStack(files) {
  if (files.includes('Dockerfile')) return 'Docker'
  if (files.includes('package.json')) return 'Node.js'
  if (files.includes('pyproject.toml') || files.includes('requirements.txt')) return 'Python'
  if (files.includes('go.mod')) return 'Go'
  return 'Unknown'
}

export function buildKubernetesManifests({ deploymentId, image, host, namespace, tlsSecret, healthPath = '/' }) {
  const safeId = deploymentId.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '')
  const appName = `deployhub-${safeId}`
  const labels = { app: appName }

  return [
    {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: appName, namespace, labels },
      spec: {
        replicas: 1,
        selector: { matchLabels: labels },
        template: {
          metadata: { labels },
          spec: {
            containers: [{
              name: 'app',
              image,
              imagePullPolicy: 'Always',
              ports: [{ name: 'http', containerPort: 3000 }],
              readinessProbe: {
                httpGet: { path: healthPath, port: 'http' },
                initialDelaySeconds: 5,
                periodSeconds: 5,
                timeoutSeconds: 2,
                failureThreshold: 12,
              },
              resources: {
                requests: { cpu: '100m', memory: '128Mi' },
                limits: { cpu: '500m', memory: '512Mi' },
              },
            }],
          },
        },
      },
    },
    {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: appName, namespace, labels },
      spec: {
        type: 'ClusterIP',
        selector: labels,
        ports: [{ name: 'http', port: 80, targetPort: 'http' }],
      },
    },
    {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'Ingress',
      metadata: { name: appName, namespace, labels },
      spec: {
        tls: [{ hosts: [host], secretName: tlsSecret }],
        rules: [{
          host,
          http: {
            paths: [{
              path: '/',
              pathType: 'Prefix',
              backend: { service: { name: appName, port: { number: 80 } } },
            }],
          },
        }],
      },
    },
  ]
}
