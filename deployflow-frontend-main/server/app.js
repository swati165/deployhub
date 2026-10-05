import bcrypt from 'bcryptjs'
import cors from 'cors'
import { createHash, randomBytes } from 'node:crypto'
import express from 'express'
import { fileURLToPath } from 'node:url'
import { rateLimit } from 'express-rate-limit'
import helmet from 'helmet'
import jwt from 'jsonwebtoken'
import { normalizeDeploymentStage, normalizeDeploymentStatus } from './deploymentStates.js'
import { enqueueDeployment } from './jobQueue.js'
import { validateBranch, validateGitHubUrl, ValidationError } from './validation.js'

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function publicUser(row) {
  return { id: row.id, email: row.email }
}

function issueToken(user, secret) {
  return jwt.sign({ sub: user.id, email: user.email }, secret, { expiresIn: '12h' })
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next)
}

function requireAuth(pool, secret) {
  return async (req, res, next) => {
    const token = req.get('authorization')?.match(/^Bearer (.+)$/)?.[1]
    if (!token) return res.status(401).json({ error: 'Sign in to continue.' })
    if (token.startsWith('dh_live_')) {
      try {
        const result = await pool.query(
          'SELECT id, user_id FROM api_keys WHERE token_hash = $1 AND revoked_at IS NULL',
          [createHash('sha256').update(token).digest('hex')],
        )
        if (!result.rows[0]) return res.status(401).json({ error: 'Your API key is invalid or has been revoked.' })
        req.auth = { sub: result.rows[0].user_id, kind: 'api_key' }
        await pool.query('UPDATE api_keys SET last_used_at = NOW() WHERE id = $1', [result.rows[0].id])
        return next()
      } catch (error) {
        return next(error)
      }
    }
    try {
      req.auth = jwt.verify(token, secret)
      return next()
    } catch {
      return res.status(401).json({ error: 'Your session has expired. Please sign in again.' })
    }
  }
}

function relativeFields(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    repoUrl: row.repo_url,
    branch: row.branch,
    status: row.status == null ? 'idle' : normalizeDeploymentStatus(row.status),
    stack: row.stack ?? null,
    deploymentsCount: Number(row.deployments_count ?? 0),
    lastDeployed: row.last_deployed ?? null,
    createdAt: row.created_at,
  }
}

function projectSelect() {
  return `
    SELECT p.id, p.name, p.description, p.repo_url, p.branch, p.created_at,
      latest.status, latest.stack, latest.created_at AS last_deployed,
      COUNT(d.id)::int AS deployments_count
    FROM projects p
    LEFT JOIN deployments d ON d.project_id = p.id
    LEFT JOIN LATERAL (
      SELECT status, stack, created_at
      FROM deployments WHERE project_id = p.id
      ORDER BY created_at DESC LIMIT 1
    ) latest ON true`
}

function deploymentFields(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    project: row.project_name,
    branch: row.branch,
    status: normalizeDeploymentStatus(row.status),
    stage: normalizeDeploymentStage(row.stage),
    stack: row.stack,
    image: row.image,
    liveUrl: row.live_url,
    error: row.error,
    author: row.author,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    logs: row.logs,
  }
}

function deploymentSelect() {
  return `
    SELECT d.id, d.project_id, p.name AS project_name, d.branch, d.status, d.stage,
      d.stack, d.image, d.live_url, d.error, u.email AS author,
      d.created_at, d.updated_at
    FROM deployments d
    JOIN projects p ON p.id = d.project_id
    JOIN users u ON u.id = d.user_id`
}

function apiKeyFields(row) {
  return {
    id: row.id,
    name: row.name,
    maskedKey: `${row.token_prefix}••••••••${row.token_last_four}`,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  }
}

export function createApp({
  pool,
  tokenSecret,
  frontendOrigin = 'http://localhost:5173',
  clientDirectory = process.env.NODE_ENV === 'production'
    ? fileURLToPath(new URL('../dist/', import.meta.url))
    : null,
}) {
  const app = express()
  app.disable('x-powered-by')
  app.use(helmet())
  app.use(cors({ origin: frontendOrigin }))
  app.use(express.json({ limit: '32kb' }))
  app.use((req, _res, next) => {
    if (req.body !== undefined && (!req.body || typeof req.body !== 'object' || Array.isArray(req.body))) {
      return next(new ValidationError('Request body must be a JSON object.'))
    }
    return next()
  })
  app.use('/api', rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: true, legacyHeaders: false }))
  app.use('/api/auth', rateLimit({ windowMs: 15 * 60_000, limit: 30, standardHeaders: true, legacyHeaders: false }))

  const auth = requireAuth(pool, tokenSecret)

  app.get('/api/health', asyncRoute(async (_req, res) => {
    await pool.query('SELECT 1')
    res.json({ status: 'ok' })
  }))

  app.post('/api/auth/register', asyncRoute(async (req, res) => {
    const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : ''
    const password = typeof req.body.password === 'string' ? req.body.password : ''
    if (!emailPattern.test(email) || email.length > 254) throw new ValidationError('Enter a valid email address.')
    if (Buffer.byteLength(password, 'utf8') < 12 || Buffer.byteLength(password, 'utf8') > 72) {
      throw new ValidationError('Password must be between 12 and 72 bytes.')
    }

    const passwordHash = await bcrypt.hash(password, 12)
    let result
    try {
      result = await pool.query(
        'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email',
        [email, passwordHash],
      )
    } catch (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'An account with this email already exists.' })
      throw error
    }
    const user = publicUser(result.rows[0])
    res.status(201).json({ user, token: issueToken(user, tokenSecret) })
  }))

  app.post('/api/auth/login', asyncRoute(async (req, res) => {
    const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : ''
    const password = typeof req.body.password === 'string' ? req.body.password : ''
    if (!email || !password) throw new ValidationError('Email and password are required.')
    const result = await pool.query('SELECT id, email, password_hash FROM users WHERE email = $1', [email])
    const row = result.rows[0]
    if (!row || !(await bcrypt.compare(password, row.password_hash))) {
      return res.status(401).json({ error: 'Email or password is incorrect.' })
    }
    const user = publicUser(row)
    res.json({ user, token: issueToken(user, tokenSecret) })
  }))

  app.get('/api/auth/me', auth, asyncRoute(async (req, res) => {
    const result = await pool.query('SELECT id, email FROM users WHERE id = $1', [req.auth.sub])
    if (!result.rows[0]) return res.status(401).json({ error: 'Account no longer exists.' })
    res.json({ user: publicUser(result.rows[0]) })
  }))

  app.get('/api/settings/profile', auth, asyncRoute(async (req, res) => {
    const result = await pool.query('SELECT full_name, email FROM users WHERE id = $1', [req.auth.sub])
    if (!result.rows[0]) return res.status(401).json({ error: 'Account no longer exists.' })
    res.json({ profile: { fullName: result.rows[0].full_name, email: result.rows[0].email } })
  }))

  app.patch('/api/settings/profile', auth, asyncRoute(async (req, res) => {
    let fullName = null
    let email = null
    if (Object.hasOwn(req.body, 'fullName')) {
      if (typeof req.body.fullName !== 'string' || req.body.fullName.trim().length > 80) {
        throw new ValidationError('Full name must be 80 characters or fewer.')
      }
      fullName = req.body.fullName.trim()
    }
    if (Object.hasOwn(req.body, 'email')) {
      email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : ''
      if (!emailPattern.test(email) || email.length > 254) throw new ValidationError('Enter a valid email address.')
    }
    if (fullName === null && email === null) throw new ValidationError('Provide a full name or email address to update.')

    try {
      const result = await pool.query(
        `UPDATE users SET full_name = COALESCE($2, full_name), email = COALESCE($3, email)
         WHERE id = $1 RETURNING full_name, email`,
        [req.auth.sub, fullName, email],
      )
      if (!result.rows[0]) return res.status(401).json({ error: 'Account no longer exists.' })
      res.json({ profile: { fullName: result.rows[0].full_name, email: result.rows[0].email } })
    } catch (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'An account with this email already exists.' })
      throw error
    }
  }))

  app.get('/api/settings/notifications', auth, asyncRoute(async (req, res) => {
    const result = await pool.query('SELECT notification_preferences FROM users WHERE id = $1', [req.auth.sub])
    if (!result.rows[0]) return res.status(401).json({ error: 'Account no longer exists.' })
    res.json({ preferences: result.rows[0].notification_preferences })
  }))

  app.patch('/api/settings/notifications', auth, asyncRoute(async (req, res) => {
    const preferences = req.body.preferences
    const allowedPreferences = ['deploySuccess', 'deployFailed', 'podCrash', 'weeklyReport']
    if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)) {
      throw new ValidationError('Preferences must be a JSON object.')
    }
    const entries = Object.entries(preferences)
    if (!entries.length || entries.some(([key, value]) => !allowedPreferences.includes(key) || typeof value !== 'boolean')) {
      throw new ValidationError('Provide valid notification preference keys and boolean values.')
    }
    const result = await pool.query(
      `UPDATE users SET notification_preferences = notification_preferences || $2::jsonb
       WHERE id = $1 RETURNING notification_preferences`,
      [req.auth.sub, JSON.stringify(preferences)],
    )
    if (!result.rows[0]) return res.status(401).json({ error: 'Account no longer exists.' })
    res.json({ preferences: result.rows[0].notification_preferences })
  }))

  app.get('/api/settings/api-keys', auth, asyncRoute(async (req, res) => {
    const result = await pool.query(
      `SELECT id, name, token_prefix, token_last_four, created_at, last_used_at
       FROM api_keys WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC`,
      [req.auth.sub],
    )
    res.json({ apiKeys: result.rows.map(apiKeyFields) })
  }))

  app.post('/api/settings/api-keys', auth, asyncRoute(async (req, res) => {
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : ''
    if (!name || name.length > 60) throw new ValidationError('API key name must be 1–60 characters.')
    const key = `dh_live_${randomBytes(32).toString('base64url')}`
    const result = await pool.query(
      `INSERT INTO api_keys (user_id, name, token_hash, token_prefix, token_last_four)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, token_prefix, token_last_four, created_at, last_used_at`,
      [
        req.auth.sub,
        name,
        createHash('sha256').update(key).digest('hex'),
        key.slice(0, 12),
        key.slice(-4),
      ],
    )
    res.status(201).json({ apiKey: { ...apiKeyFields(result.rows[0]), key } })
  }))

  app.delete('/api/settings/api-keys/:id', auth, asyncRoute(async (req, res) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(req.params.id)) {
      return res.status(404).json({ error: 'API key not found.' })
    }
    const result = await pool.query(
      `UPDATE api_keys SET revoked_at = NOW()
       WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id`,
      [req.params.id, req.auth.sub],
    )
    if (!result.rows[0]) return res.status(404).json({ error: 'API key not found.' })
    res.status(204).end()
  }))

  app.get('/api/dashboard', auth, asyncRoute(async (req, res) => {
    const [projects, deployments, recent] = await Promise.all([
      pool.query('SELECT COUNT(*)::int AS count FROM projects WHERE user_id = $1', [req.auth.sub]),
      pool.query(
        `SELECT COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE status IN (
            'queued','cloning','building','pushing','deploying',
            'QUEUED','VALIDATING','CLONING','BUILDING','PUSHING_IMAGE','DEPLOYING'
          ))::int AS active,
          COUNT(*) FILTER (WHERE status IN ('live','RUNNING'))::int AS live,
          COUNT(*) FILTER (WHERE status IN ('failed','FAILED'))::int AS failed
         FROM deployments WHERE user_id = $1`,
        [req.auth.sub],
      ),
      pool.query(
        `${deploymentSelect()} WHERE d.user_id = $1 ORDER BY d.created_at DESC LIMIT 5`,
        [req.auth.sub],
      ),
    ])
    const stats = deployments.rows[0]
    res.json({
      stats: {
        totalProjects: projects.rows[0].count,
        activeDeployments: stats.active,
        successRate: stats.total ? Math.round((stats.live / stats.total) * 1000) / 10 : 0,
        failedDeployments: stats.failed,
      },
      recentDeployments: recent.rows.map(deploymentFields),
    })
  }))

  app.get('/api/projects', auth, asyncRoute(async (req, res) => {
    const result = await pool.query(
      `${projectSelect()} WHERE p.user_id = $1 GROUP BY p.id, latest.status, latest.stack, latest.created_at ORDER BY p.created_at DESC`,
      [req.auth.sub],
    )
    res.json({ projects: result.rows.map(relativeFields) })
  }))

  app.post('/api/projects', auth, asyncRoute(async (req, res) => {
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : ''
    const description = typeof req.body.description === 'string' ? req.body.description.trim() : ''
    const branch = validateBranch(req.body.branch || 'main')
    const repoUrl = validateGitHubUrl(req.body.repoUrl)
    if (!/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,59}$/u.test(name)) {
      throw new ValidationError('Project name must be 1–60 characters and start with a letter or number.')
    }
    if (description.length > 500) throw new ValidationError('Description must be 500 characters or fewer.')

    try {
      const result = await pool.query(
        `INSERT INTO projects (user_id, name, description, repo_url, branch)
         VALUES ($1, $2, $3, $4, $5) RETURNING id, name, description, repo_url, branch, created_at`,
        [req.auth.sub, name, description, repoUrl, branch],
      )
      res.status(201).json({ project: relativeFields(result.rows[0]) })
    } catch (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'This repository is already in your projects.' })
      throw error
    }
  }))

  app.get('/api/projects/:id', auth, asyncRoute(async (req, res) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(req.params.id)) {
      return res.status(404).json({ error: 'Project not found.' })
    }
    const result = await pool.query(
      `${projectSelect()} WHERE p.user_id = $1 AND p.id = $2 GROUP BY p.id, latest.status, latest.stack, latest.created_at`,
      [req.auth.sub, req.params.id],
    )
    if (!result.rows[0]) return res.status(404).json({ error: 'Project not found.' })
    res.json({ project: relativeFields(result.rows[0]) })
  }))

  app.get('/api/projects/:id/deployments', auth, asyncRoute(async (req, res) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(req.params.id)) {
      return res.status(404).json({ error: 'Project not found.' })
    }
    const result = await pool.query(
      `${deploymentSelect()} WHERE d.user_id = $1 AND d.project_id = $2 ORDER BY d.created_at DESC LIMIT 100`,
      [req.auth.sub, req.params.id],
    )
    res.json({ deployments: result.rows.map(deploymentFields) })
  }))

  app.post('/api/projects/:id/deployments', auth, asyncRoute(async (req, res) => {
    const branch = req.body.branch === undefined ? null : validateBranch(req.body.branch)
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(req.params.id)) {
      return res.status(404).json({ error: 'Project not found.' })
    }
    const project = await pool.query(
      'SELECT id, repo_url, branch FROM projects WHERE id = $1 AND user_id = $2',
      [req.params.id, req.auth.sub],
    )
    if (!project.rows[0]) return res.status(404).json({ error: 'Project not found.' })
    const chosenBranch = branch ?? project.rows[0].branch
    const client = await pool.connect()
    let deploymentId
    try {
      await client.query('BEGIN')
      const result = await client.query(
        `INSERT INTO deployments (project_id, user_id, branch, status, stage)
         VALUES ($1, $2, $3, 'QUEUED', 'QUEUED') RETURNING id`,
        [project.rows[0].id, req.auth.sub, chosenBranch],
      )
      deploymentId = result.rows[0].id
      await client.query(
        'INSERT INTO deployment_logs (deployment_id, level, message) VALUES ($1, $2, $3)',
        [deploymentId, 'info', 'Deployment queued.'],
      )
      await enqueueDeployment(client, deploymentId)
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
    res.status(202).json({
      deployment: {
        id: deploymentId,
        status: 'QUEUED',
        stage: 'QUEUED',
      },
    })
  }))

  app.get('/api/deployments', auth, asyncRoute(async (req, res) => {
    const result = await pool.query(
      `${deploymentSelect()} WHERE d.user_id = $1 ORDER BY d.created_at DESC LIMIT 100`,
      [req.auth.sub],
    )
    res.json({ deployments: result.rows.map(deploymentFields) })
  }))

  app.get('/api/deployments/:id', auth, asyncRoute(async (req, res) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(req.params.id)) {
      return res.status(404).json({ error: 'Deployment not found.' })
    }
    const result = await pool.query(
      `${deploymentSelect()} WHERE d.user_id = $1 AND d.id = $2 LIMIT 1`,
      [req.auth.sub, req.params.id],
    )
    if (!result.rows[0]) return res.status(404).json({ error: 'Deployment not found.' })
    const logs = await pool.query(
      'SELECT id, level AS type, message AS text, created_at AS "createdAt" FROM deployment_logs WHERE deployment_id = $1 ORDER BY created_at, id',
      [req.params.id],
    )
    res.json({ deployment: { ...deploymentFields(result.rows[0]), logs: logs.rows } })
  }))

  app.get('/api/logs', auth, asyncRoute(async (req, res) => {
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : null
    const level = typeof req.query.level === 'string' && req.query.level !== 'all' ? req.query.level : null
    if (projectId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(projectId)) {
      throw new ValidationError('Project ID is invalid.')
    }
    if (level && !['info', 'success', 'error'].includes(level)) {
      throw new ValidationError('Log level must be info, success, or error.')
    }
    const result = await pool.query(
      `SELECT l.id, l.level AS type, l.message AS text, l.created_at AS "createdAt",
        p.id AS "projectId", p.name AS project, d.id AS "deploymentId"
       FROM deployment_logs l
       JOIN deployments d ON d.id = l.deployment_id
       JOIN projects p ON p.id = d.project_id
       WHERE d.user_id = $1 AND ($2::uuid IS NULL OR p.id = $2)
         AND ($3::text IS NULL OR l.level = $3)
       ORDER BY l.created_at DESC, l.id DESC LIMIT 200`,
      [req.auth.sub, projectId, level],
    )
    res.json({ logs: result.rows })
  }))

  if (clientDirectory) {
    app.use(express.static(clientDirectory, {
      index: false,
      maxAge: '1y',
      immutable: true,
    }))
    app.get('/{*path}', (req, res, next) => {
      if (req.path.startsWith('/api/')) return next()
      return res.sendFile('index.html', { root: clientDirectory })
    })
  }

  app.use((req, res) => res.status(404).json({ error: 'Route not found.' }))
  app.use((error, _req, res, _next) => {
    if (error instanceof ValidationError) return res.status(error.status).json({ error: error.message })
    if (error?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Request body must be valid JSON.' })
    console.error('API request failed:', error)
    return res.status(500).json({ error: 'An unexpected server error occurred.' })
  })

  return app
}
