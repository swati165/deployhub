import 'dotenv/config'
import { createApp } from './app.js'
import { assertSchemaVersion } from './migrate.js'
import { pool } from './db.js'

const port = Number(process.env.PORT || 5000)
const tokenSecret = process.env.JWT_SECRET
if (!tokenSecret || Buffer.byteLength(tokenSecret, 'utf8') < 32) {
  throw new Error('JWT_SECRET must be at least 32 bytes. Generate one with: node -e "console.log(require(\'node:crypto\').randomBytes(32).toString(\'hex\'))"')
}

await assertSchemaVersion(pool, '0006')
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
