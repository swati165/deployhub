import 'dotenv/config'
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('./migrations/', import.meta.url))
const BASELINE_VERSION = '0001'
const ADVISORY_LOCK_KEY = '72623859790382856'
const LOCK_TIMEOUT_MS = 30_000
const LOCK_RETRY_MS = 100
const MIGRATION_TABLE = 'public.schema_migrations'
const MIGRATION_TABLE_DDL = `
  CREATE TABLE public.schema_migrations (
    version TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    checksum CHAR(64) NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    execution_ms BIGINT NOT NULL CHECK (execution_ms >= 0)
  )
`

const BASELINE_SIGNATURE_SHA256 = '56dd36dc7b76ec1cefa42981e98b6da036780509ef6ffab08d96e282f0c45f50'
const BASELINE_SIGNATURE_QUERY = `
  SELECT jsonb_build_object(
    'relations', (
      SELECT jsonb_agg(relname ORDER BY relname)
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
    ),
    'columns', (
      SELECT jsonb_agg(
        jsonb_build_array(
          c.relname, a.attnum, a.attname, format_type(a.atttypid, a.atttypmod),
          a.attnotnull, COALESCE(pg_get_expr(d.adbin, d.adrelid), '')
        ) ORDER BY c.relname, a.attnum
      )
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid
      LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND a.attnum > 0 AND NOT a.attisdropped
    ),
    'constraints', (
      SELECT jsonb_agg(
        jsonb_build_array(c.relname, con.conname, con.contype, pg_get_constraintdef(con.oid))
        ORDER BY c.relname, con.conname
      )
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
    ),
    'indexes', (
      SELECT jsonb_agg(
        jsonb_build_array(tablename, indexname, indexdef)
        ORDER BY tablename, indexname
      )
      FROM pg_indexes
      WHERE schemaname = 'public'
    )
  ) AS signature
`

export class MigrationError extends Error {
  constructor(message, options) {
    super(message, options)
    this.name = 'MigrationError'
  }
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex')
}

async function discoverMigrations(directory) {
  const filenames = (await readdir(directory)).filter((filename) => filename.endsWith('.sql')).sort()
  const migrations = []
  const seenVersions = new Set()

  for (const filename of filenames) {
    const match = /^(\d{4,})_([a-z0-9][a-z0-9_-]*)\.sql$/.exec(filename)
    if (!match) throw new MigrationError(`Invalid migration filename: ${filename}`)
    const [, version, name] = match
    if (seenVersions.has(version)) throw new MigrationError(`Duplicate migration version: ${version}`)
    seenVersions.add(version)
    const content = await readFile(path.join(directory, filename))
    if (!content.length || !content.toString('utf8').trim()) {
      throw new MigrationError(`Migration ${filename} is empty.`)
    }
    migrations.push({ version, name, filename, content, checksum: sha256(content) })
  }

  if (!migrations.length || migrations[0].version !== BASELINE_VERSION) {
    throw new MigrationError(`The first migration must be ${BASELINE_VERSION}_baseline.sql.`)
  }

  for (let index = 1; index < migrations.length; index += 1) {
    if (migrations[index - 1].version >= migrations[index].version) {
      throw new MigrationError('Migration versions must be unique and lexically ordered.')
    }
  }
  return migrations
}

async function acquireAdvisoryLock(client, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await client.query('SELECT pg_try_advisory_lock($1::bigint) AS acquired', [ADVISORY_LOCK_KEY])
    if (result.rows[0].acquired) return
    await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS))
  }
  throw new MigrationError(`Timed out waiting ${timeoutMs}ms for the database migration lock.`)
}

async function releaseAdvisoryLock(client) {
  const result = await client.query('SELECT pg_advisory_unlock($1::bigint) AS released', [ADVISORY_LOCK_KEY])
  if (!result.rows[0].released) throw new MigrationError('The database migration lock was not held by this connection.')
}

async function migrationHistoryExists(client) {
  const result = await client.query(`SELECT to_regclass('${MIGRATION_TABLE}') IS NOT NULL AS exists`)
  return result.rows[0].exists
}

async function readHistory(client) {
  try {
    return (await client.query(
      `SELECT version, name, checksum, applied_at, execution_ms
       FROM ${MIGRATION_TABLE} ORDER BY version`,
    )).rows
  } catch (error) {
    throw new MigrationError('Migration history table is unreadable or has an incompatible structure.', { cause: error })
  }
}

function validateHistory(migrations, history) {
  if (!history.length) {
    throw new MigrationError('Migration history exists but is empty; refusing to guess whether the baseline was applied.')
  }
  const filesByVersion = new Map(migrations.map((migration) => [migration.version, migration]))
  const historyByVersion = new Map(history.map((row) => [row.version, row]))
  for (const row of history) {
    const migration = filesByVersion.get(row.version)
    if (!migration) throw new MigrationError(`Applied migration ${row.version} is missing from disk.`)
    if (row.checksum !== migration.checksum) {
      throw new MigrationError(`Migration drift detected for ${migration.filename}; applied checksum does not match file contents.`)
    }
    if (row.name !== migration.name) {
      throw new MigrationError(`Migration history name mismatch for ${migration.filename}.`)
    }
  }
  for (let index = 0; index < history.length; index += 1) {
    if (history[index].version !== migrations[index]?.version) {
      throw new MigrationError(`Migration history has a version gap before ${history[index].version}.`)
    }
  }
  if (history[0]?.version !== BASELINE_VERSION) {
    throw new MigrationError(`Migration history must begin with baseline ${BASELINE_VERSION}.`)
  }
  return historyByVersion
}

async function assertNoApplicationSchema(client) {
  const result = await client.query(`
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
    ORDER BY c.relname
  `)
  if (result.rows.length) {
    throw new MigrationError(
      `Database has public schema objects but no migration history; refusing to run baseline over existing schema: ${result.rows.map((row) => row.relname).join(', ')}.`,
    )
  }
}

async function verifyExistingBaseline(client) {
  const result = await client.query(BASELINE_SIGNATURE_QUERY)
  const signature = Buffer.from(JSON.stringify(result.rows[0].signature))
  const actualChecksum = sha256(signature)
  if (actualChecksum !== BASELINE_SIGNATURE_SHA256) {
    throw new MigrationError(
      `Existing database schema does not match the expected current baseline (catalog fingerprint ${actualChecksum}). No schema changes were made.`,
    )
  }
}

async function createHistoryAndRecord(client, migration, executionMs) {
  await client.query(MIGRATION_TABLE_DDL)
  await client.query(
    `INSERT INTO ${MIGRATION_TABLE} (version, name, checksum, execution_ms)
     VALUES ($1, $2, $3, $4)`,
    [migration.version, migration.name, migration.checksum, executionMs],
  )
}

async function applyMigration(client, migration, { createHistory = false } = {}) {
  const startedAt = process.hrtime.bigint()
  await client.query('BEGIN')
  try {
    await client.query(migration.content.toString('utf8'))
    const executionMs = Number((process.hrtime.bigint() - startedAt) / 1_000_000n)
    if (createHistory) {
      await createHistoryAndRecord(client, migration, executionMs)
    } else {
      await client.query(
        `INSERT INTO ${MIGRATION_TABLE} (version, name, checksum, execution_ms)
         VALUES ($1, $2, $3, $4)`,
        [migration.version, migration.name, migration.checksum, executionMs],
      )
    }
    await client.query('COMMIT')
    return executionMs
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch (rollbackError) {
      throw new MigrationError(`Migration ${migration.filename} failed and rollback also failed.`, {
        cause: new AggregateError([error, rollbackError]),
      })
    }
    throw new MigrationError(`Migration ${migration.filename} failed; its transaction was rolled back.`, { cause: error })
  }
}

async function adoptBaseline(client, baseline) {
  await verifyExistingBaseline(client)
  const startedAt = process.hrtime.bigint()
  await client.query('BEGIN')
  try {
    await createHistoryAndRecord(client, baseline, Number((process.hrtime.bigint() - startedAt) / 1_000_000n))
    await client.query('COMMIT')
    return `Adopted existing schema as migration ${baseline.version} without re-running the baseline.`
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch (rollbackError) {
      throw new MigrationError('Baseline adoption failed and rollback also failed.', {
        cause: new AggregateError([error, rollbackError]),
      })
    }
    throw new MigrationError('Baseline adoption failed; its transaction was rolled back.', { cause: error })
  }
}

export async function runMigrations(pool, {
  migrationsDirectory = MIGRATIONS_DIRECTORY,
  lockTimeoutMs = LOCK_TIMEOUT_MS,
} = {}) {
  const migrations = await discoverMigrations(migrationsDirectory)
  const client = await pool.connect()
  let lockAcquired = false
  try {
    await acquireAdvisoryLock(client, lockTimeoutMs)
    lockAcquired = true

    const hasHistory = await migrationHistoryExists(client)
    let historyByVersion
    const applied = []
    if (hasHistory) {
      historyByVersion = validateHistory(migrations, await readHistory(client))
    } else {
      const baselineResult = await client.query(
        `SELECT to_regclass('public.users') IS NOT NULL AS has_users,
                to_regclass('public.projects') IS NOT NULL AS has_projects,
                to_regclass('public.deployments') IS NOT NULL AS has_deployments`,
      )
      const baselineExists = Object.values(baselineResult.rows[0]).some(Boolean)
      if (baselineExists) {
        await adoptBaseline(client, migrations[0])
        historyByVersion = new Map([[BASELINE_VERSION, { version: BASELINE_VERSION }]])
      } else {
        await assertNoApplicationSchema(client)
        const executionMs = await applyMigration(client, migrations[0], { createHistory: true })
        applied.push({ version: migrations[0].version, name: migrations[0].name, executionMs })
        historyByVersion = new Map([[BASELINE_VERSION, { version: BASELINE_VERSION }]])
      }
    }

    for (const migration of migrations) {
      if (historyByVersion.has(migration.version)) continue
      const expectedPrevious = migrations[migrations.indexOf(migration) - 1]?.version
      if (expectedPrevious && !historyByVersion.has(expectedPrevious)) {
        throw new MigrationError(`Cannot apply ${migration.filename} before ${expectedPrevious}.`)
      }
      const executionMs = await applyMigration(client, migration)
      applied.push({ version: migration.version, name: migration.name, executionMs })
      historyByVersion.set(migration.version, { version: migration.version })
    }
    return { applied, currentVersion: migrations.at(-1).version }
  } finally {
    try {
      if (lockAcquired) await releaseAdvisoryLock(client)
    } finally {
      client.release()
    }
  }
}

export async function assertSchemaVersion(pool, requiredVersion = BASELINE_VERSION) {
  let result
  try {
    result = await pool.query(
      `SELECT version FROM ${MIGRATION_TABLE} WHERE version = $1`,
      [requiredVersion],
    )
  } catch (error) {
    if (error.code === '42P01') {
      throw new MigrationError(
        `Database schema is not initialized. Run "node server/migrate.js" before starting the API.`,
        { cause: error },
      )
    }
    throw error
  }
  if (!result.rows.length) {
    throw new MigrationError(
      `Database schema is missing required migration ${requiredVersion}. Run "node server/migrate.js" before starting the API.`,
    )
  }
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
if (isMain) {
  const { pool } = await import('./db.js')
  try {
    const result = await runMigrations(pool)
    for (const migration of result.applied) {
      console.log(`Applied migration ${migration.version}_${migration.name} (${migration.executionMs}ms).`)
    }
    if (!result.applied.length) console.log(`Database schema is up to date at migration ${result.currentVersion}.`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  } finally {
    await pool.end()
  }
}
