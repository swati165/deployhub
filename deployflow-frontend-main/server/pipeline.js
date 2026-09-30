import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildKubernetesManifests, detectStack, validateGitHubUrl } from './validation.js'

const MAX_ACTIVE_DEPLOYMENTS = 2
const MAX_QUEUED_DEPLOYMENTS = 20
const deploymentQueue = []
let activeDeployments = 0

export function enqueueDeployment(pool, deployment) {
  if (activeDeployments + deploymentQueue.length >= MAX_ACTIVE_DEPLOYMENTS + MAX_QUEUED_DEPLOYMENTS) {
    return false
  }
  deploymentQueue.push({ pool, deployment })
  drainDeploymentQueue()
  return true
}

function drainDeploymentQueue() {
  while (activeDeployments < MAX_ACTIVE_DEPLOYMENTS && deploymentQueue.length) {
    const job = deploymentQueue.shift()
    activeDeployments += 1
    runDeployment(job.pool, job.deployment)
      .catch(async (error) => {
        console.error(`Deployment ${job.deployment.id} worker failed:`, error)
        const message = 'Deployment worker failed unexpectedly; check the API worker logs.'
        try {
          await job.pool.query(
            `UPDATE deployments SET status = 'failed', error = $2, updated_at = NOW() WHERE id = $1`,
            [job.deployment.id, message],
          )
          await log(job.pool, job.deployment.id, 'error', message)
        } catch (persistenceError) {
          console.error(`Could not record failure for deployment ${job.deployment.id}:`, persistenceError)
        }
      })
      .finally(() => {
        activeDeployments -= 1
        drainDeploymentQueue()
      })
  }
}

function run(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      shell: false,
      stdio: ['pipe', 'ignore', 'ignore'],
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: os.devNull,
        GIT_ALLOW_PROTOCOL: 'https',
        GIT_TERMINAL_PROMPT: '0',
        GIT_LFS_SKIP_SMUDGE: '1',
      },
    })
    const timeout = setTimeout(() => child.kill('SIGKILL'), options.timeout ?? 120_000)
    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('close', (code, signal) => {
      clearTimeout(timeout)
      if (code === 0) resolve()
      else reject(new Error(`${file} exited with ${signal || `code ${code}`}`))
    })
    if (options.input) child.stdin.end(options.input)
    else child.stdin.end()
  })
}

function requiredConfiguration() {
  const missing = []
  if (process.env.DEPLOYMENT_EXECUTOR !== 'isolated-docker') missing.push('DEPLOYMENT_EXECUTOR=isolated-docker')
  if (process.env.BUILD_RUNNER_ISOLATED !== 'true') missing.push('BUILD_RUNNER_ISOLATED=true')
  if (!process.env.DOCKER_REGISTRY) missing.push('DOCKER_REGISTRY')
  if (!process.env.KUBE_NAMESPACE) missing.push('KUBE_NAMESPACE')
  if (!process.env.DEPLOYMENT_DOMAIN) missing.push('DEPLOYMENT_DOMAIN')
  if (!process.env.KUBE_TLS_SECRET) missing.push('KUBE_TLS_SECRET')
  if (!process.env.KUBECONFIG) missing.push('KUBECONFIG')
  if (missing.length) {
    throw new Error(`Deployment prerequisites are missing: ${missing.join(', ')}. See README.md before enabling repository builds.`)
  }
}

function validateDeploymentConfiguration() {
  const registry = process.env.DOCKER_REGISTRY
  const namespace = process.env.KUBE_NAMESPACE
  const domain = process.env.DEPLOYMENT_DOMAIN
  const tlsSecret = process.env.KUBE_TLS_SECRET
  const healthPath = process.env.DEPLOYMENT_HEALTH_PATH || '/'
  if (registry.length > 255 || !/^[a-zA-Z0-9.-]+(?::[0-9]{1,5})?(?:\/[a-zA-Z0-9._-]+)*$/.test(registry) || registry.split('/').some((part) => part === '.' || part === '..')) {
    throw new Error('DOCKER_REGISTRY must be a registry hostname and optional path, without a URL scheme.')
  }
  if (namespace.length > 63 || !/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(namespace)) {
    throw new Error('KUBE_NAMESPACE must be a valid Kubernetes namespace.')
  }
  if (!/^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(?:\.(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?))*$/.test(domain)) {
    throw new Error('DEPLOYMENT_DOMAIN must be a valid DNS domain, without a URL scheme.')
  }
  if (tlsSecret.length > 63 || !/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(tlsSecret)) {
    throw new Error('KUBE_TLS_SECRET must be a valid Kubernetes Secret name.')
  }
  if (!/^\/[A-Za-z0-9._~/-]*$/.test(healthPath)) {
    throw new Error('DEPLOYMENT_HEALTH_PATH must be a simple absolute HTTP path.')
  }
  return { registry: registry.replace(/\/+$/, ''), namespace, domain, tlsSecret, healthPath }
}

async function log(pool, id, level, message) {
  await pool.query(
    'INSERT INTO deployment_logs (deployment_id, level, message) VALUES ($1, $2, $3)',
    [id, level, message],
  )
}

async function setStage(pool, id, stage) {
  await pool.query(
    'UPDATE deployments SET status = $2, stage = $2, updated_at = NOW() WHERE id = $1',
    [id, stage],
  )
  await log(pool, id, 'info', `${stage[0].toUpperCase()}${stage.slice(1)} started.`)
}

async function writeManifest(pool, id, filePath, content) {
  await writeFile(filePath, content)
  await log(pool, id, 'info', 'Generated a container definition for the Node.js project.')
}

export async function runDeployment(pool, deployment) {
  let workspace
  try {
    requiredConfiguration()
    const { registry, namespace, domain, tlsSecret, healthPath } = validateDeploymentConfiguration()
    const repositoryUrl = validateGitHubUrl(deployment.repo_url)
    workspace = await mkdtemp(path.join(os.tmpdir(), 'deployhub-'))
    const sourcePath = path.join(workspace, 'source')
    const image = `${registry}/deployhub/${deployment.id}:latest`
    const host = `${deployment.id}.${domain}`
    const steps = [
      ['docker', ['info']],
      ['kubectl', ['version', '--client=true']],
    ]
    for (const [command, args] of steps) {
      try {
        await run(command, args, { timeout: 15_000 })
      } catch {
        throw new Error(`Required deployment tool or configuration is unavailable: ${command}.`)
      }
    }

    await setStage(pool, deployment.id, 'cloning')
    try {
      await run('git', [
        'clone', '--depth', '1', '--single-branch', '--branch', deployment.branch,
        '--', repositoryUrl, sourcePath,
      ], { timeout: 120_000 })
    } catch {
      throw new Error('Could not clone the selected public GitHub repository and branch.')
    }
    await log(pool, deployment.id, 'success', 'Repository cloned.')

    const files = await readdir(sourcePath)
    const stack = detectStack(files)
    await pool.query('UPDATE deployments SET stack = $2 WHERE id = $1', [deployment.id, stack])
    await log(pool, deployment.id, 'info', `Detected stack: ${stack}.`)

    if (!files.includes('Dockerfile')) {
      if (stack !== 'Node.js') {
        throw new Error(`No Dockerfile found. Automatic container builds currently support Node.js repositories only (detected ${stack}).`)
      }
      const packageFile = JSON.parse(await readFile(path.join(sourcePath, 'package.json'), 'utf8'))
      if (!packageFile.scripts?.start) {
        throw new Error('Add a "start" script to package.json or provide a Dockerfile before deploying.')
      }
      const dockerfile = [
        'FROM node:22-alpine',
        'ENV NODE_ENV=production',
        'WORKDIR /app',
        'COPY package*.json ./',
        'RUN npm ci --include=dev',
        'COPY . .',
        'RUN npm run build --if-present',
        'EXPOSE 3000',
        'USER node',
        'CMD ["npm", "start"]',
        '',
      ].join('\n')
      await writeManifest(pool, deployment.id, path.join(sourcePath, 'Dockerfile'), dockerfile)
    }

    const dockerignorePath = path.join(sourcePath, '.dockerignore')
    let dockerignore = ''
    try {
      dockerignore = await readFile(dockerignorePath, 'utf8')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    const ignoredPaths = ['.git', 'node_modules', '.env', '.env.*']
    const additions = ignoredPaths.filter((entry) => !dockerignore.split(/\r?\n/).includes(entry))
    if (additions.length) {
      await writeFile(dockerignorePath, `${dockerignore.trimEnd()}${dockerignore ? '\n' : ''}${additions.join('\n')}\n`)
    }

    await setStage(pool, deployment.id, 'building')
    try {
      await run('docker', ['build', '--pull', '--no-cache', '--tag', image, '.'], {
        cwd: sourcePath,
        timeout: 10 * 60_000,
      })
    } catch {
      throw new Error('Container build failed. Check the repository Dockerfile or Node.js build script.')
    }
    await pool.query('UPDATE deployments SET image = $2 WHERE id = $1', [deployment.id, image])
    await log(pool, deployment.id, 'success', 'Container image built.')

    await setStage(pool, deployment.id, 'pushing')
    try {
      await run('docker', ['push', image], { timeout: 5 * 60_000 })
    } catch {
      throw new Error('Container image push failed. Check Docker registry authentication and permissions.')
    }
    await log(pool, deployment.id, 'success', 'Container image pushed to the configured registry.')

    await setStage(pool, deployment.id, 'deploying')
    const manifests = buildKubernetesManifests({
      deploymentId: deployment.id,
      image,
      host,
      namespace,
      tlsSecret,
      healthPath,
    })
    try {
      await run('kubectl', ['apply', '--namespace', namespace, '-f', '-'], {
        timeout: 60_000,
        input: `${manifests.map((manifest) => JSON.stringify(manifest)).join('\n---\n')}\n`,
      })
    } catch {
      throw new Error('Kubernetes apply failed. Check cluster access, namespace, and ingress controller configuration.')
    }
    try {
      await run('kubectl', [
        'rollout', 'status', `deployment/deployhub-${deployment.id}`,
        '--namespace', namespace,
        '--timeout=180s',
      ], { timeout: 190_000 })
    } catch {
      throw new Error('Kubernetes deployment did not become ready before the rollout timeout.')
    }

    const liveUrl = `https://${host}`
    await pool.query(
      `UPDATE deployments SET status = 'live', stage = 'live', live_url = $2,
       error = NULL, updated_at = NOW() WHERE id = $1`,
      [deployment.id, liveUrl],
    )
    await log(pool, deployment.id, 'success', `Kubernetes resources applied. Live URL: ${liveUrl}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Deployment failed unexpectedly.'
    await pool.query(
      `UPDATE deployments SET status = 'failed', error = $2, updated_at = NOW() WHERE id = $1`,
      [deployment.id, message],
    )
    await log(pool, deployment.id, 'error', message)
  } finally {
    if (workspace) await rm(workspace, { recursive: true, force: true })
  }
}
