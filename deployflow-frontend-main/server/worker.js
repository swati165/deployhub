import 'dotenv/config'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { assertSchemaVersion } from './migrate.js'
import { pool } from './db.js'
import { runWorker } from './workerRuntime.js'

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url

if (isMain) {
  const controller = new AbortController()
  let stopping = false
  const stop = (signal) => {
    if (stopping) return
    stopping = true
    console.log(`Deployment worker received ${signal}; stopping new claims and draining current work.`)
    controller.abort()
  }
  process.on('SIGINT', () => stop('SIGINT'))
  process.on('SIGTERM', () => stop('SIGTERM'))

  try {
    await assertSchemaVersion(pool, '0006')
    await runWorker(pool, { signal: controller.signal })
  } catch (error) {
    console.error('Deployment worker stopped unexpectedly:', error)
    process.exitCode = 1
  } finally {
    await pool.end()
  }
}
