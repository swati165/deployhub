import 'dotenv/config'
import { createApp } from './app.js'
import { migrate, pool } from './db.js'

const port = Number(process.env.PORT || 5000)
const tokenSecret = process.env.JWT_SECRET
if (!tokenSecret || Buffer.byteLength(tokenSecret, 'utf8') < 32) {
  throw new Error('JWT_SECRET must be at least 32 bytes. Generate one with: node -e "console.log(require(\'node:crypto\').randomBytes(32).toString(\'hex\'))"')
}

await migrate()
const interruptedDeployments = await pool.query(
  `UPDATE deployments SET status = 'failed', error = 'Server restarted before deployment completed.',
   updated_at = NOW() WHERE status IN ('queued', 'cloning', 'building', 'pushing', 'deploying')
   RETURNING id`,
)
for (const deployment of interruptedDeployments.rows) {
  await pool.query(
    'INSERT INTO deployment_logs (deployment_id, level, message) VALUES ($1, $2, $3)',
    [deployment.id, 'error', 'Server restarted before deployment completed.'],
  )
}
const app = createApp({
  pool,
  tokenSecret,
  frontendOrigin: process.env.FRONTEND_ORIGIN || 'http://localhost:5173',
})
const server = app.listen(port, () => {
  console.log(`DeployHub API listening on http://localhost:${port}`)
})

async function shutdown() {
  server.close(async () => {
    await pool.end()
    process.exit(0)
  })
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
