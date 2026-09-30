import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import jwt from 'jsonwebtoken'
import { createApp } from './app.js'

test('registration hashes passwords, login issues a session, and /me verifies it', async (context) => {
  const users = new Map()
  const pool = {
    async query(statement, values) {
      const sql = statement.replace(/\s+/g, ' ').trim().toLowerCase()
      if (sql.startsWith('insert into users')) {
        const user = { id: randomUUID(), email: values[0], password_hash: values[1] }
        users.set(user.email, user)
        return { rows: [{ id: user.id, email: user.email }] }
      }
      if (sql.startsWith('select id, email, password_hash from users')) {
        const user = users.get(values[0])
        return { rows: user ? [user] : [] }
      }
      if (sql.startsWith('select id, email from users')) {
        const user = [...users.values()].find((row) => row.id === values[0])
        return { rows: user ? [{ id: user.id, email: user.email }] : [] }
      }
      throw new Error(`Unexpected test query: ${sql}`)
    },
  }
  const server = createApp({ pool, tokenSecret: 'test-secret-with-more-than-32-bytes', frontendOrigin: 'http://localhost:5173' })
    .listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  context.after(() => new Promise((resolve) => server.close(resolve)))
  const baseUrl = `http://127.0.0.1:${server.address().port}/api`

  const registration = await fetch(`${baseUrl}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'Deployer@example.com', password: 'a-long-password-123' }),
  })
  assert.equal(registration.status, 201)
  const { user, token } = await registration.json()
  assert.equal(user.email, 'deployer@example.com')
  assert.ok(token)
  assert.notEqual(users.get(user.email).password_hash, 'a-long-password-123')

  const login = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: user.email, password: 'a-long-password-123' }),
  })
  assert.equal(login.status, 200)

  const profile = await fetch(`${baseUrl}/auth/me`, { headers: { authorization: `Bearer ${token}` } })
  assert.deepEqual(await profile.json(), { user })

  const rejected = await fetch(`${baseUrl}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'null',
  })
  assert.equal(rejected.status, 400)
})

test('settings persist profile and notifications and API keys authenticate without exposing stored secrets', async (context) => {
  const userId = randomUUID()
  const secret = 'test-secret-with-more-than-32-bytes'
  const profiles = new Map([[userId, { fullName: 'Deploy User', email: 'deploy@example.com' }]])
  const notifications = new Map([[userId, {
    deploySuccess: true,
    deployFailed: true,
    podCrash: true,
    weeklyReport: false,
  }]])
  const apiKeys = new Map()
  const pool = {
    async query(statement, values = []) {
      const sql = statement.replace(/\s+/g, ' ').trim().toLowerCase()
      if (sql.startsWith('select id, email from users')) {
        return { rows: [{ id: userId, email: profiles.get(userId).email }] }
      }
      if (sql.startsWith('select full_name, email from users')) {
        return { rows: [{ full_name: profiles.get(values[0]).fullName, email: profiles.get(values[0]).email }] }
      }
      if (sql.startsWith('update users set full_name')) {
        profiles.set(values[0], { fullName: values[1], email: values[2] })
        return { rows: [{ full_name: values[1], email: values[2] }] }
      }
      if (sql.startsWith('select notification_preferences from users')) {
        return { rows: [{ notification_preferences: notifications.get(values[0]) }] }
      }
      if (sql.startsWith('update users set notification_preferences')) {
        const updated = { ...notifications.get(values[0]), ...JSON.parse(values[1]) }
        notifications.set(values[0], updated)
        return { rows: [{ notification_preferences: updated }] }
      }
      if (sql.startsWith('insert into api_keys')) {
        const row = {
          id: randomUUID(),
          name: values[1],
          token_hash: values[2],
          token_prefix: values[3],
          token_last_four: values[4],
          created_at: new Date().toISOString(),
          last_used_at: null,
          revoked_at: null,
        }
        apiKeys.set(row.id, row)
        return { rows: [row] }
      }
      if (sql.startsWith('select id, name, token_prefix, token_last_four, created_at, last_used_at from api_keys')) {
        return { rows: [...apiKeys.values()].filter((row) => row.revoked_at === null) }
      }
      if (sql.startsWith('update api_keys set revoked_at')) {
        const row = apiKeys.get(values[0])
        if (row && values[1] === userId) row.revoked_at = new Date().toISOString()
        return { rows: row && values[1] === userId ? [row] : [] }
      }
      if (sql.startsWith('select id, user_id from api_keys where token_hash')) {
        const row = [...apiKeys.values()].find((key) => key.token_hash === values[0] && key.revoked_at === null)
        return { rows: row ? [{ id: row.id, user_id: userId }] : [] }
      }
      if (sql.startsWith('update api_keys set last_used_at')) return { rows: [] }
      throw new Error(`Unexpected test query: ${sql}`)
    },
  }
  const server = createApp({ pool, tokenSecret: secret }).listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  context.after(() => new Promise((resolve) => server.close(resolve)))
  const baseUrl = `http://127.0.0.1:${server.address().port}/api`
  const token = jwt.sign({ sub: userId, email: 'deploy@example.com' }, secret, { expiresIn: '12h' })
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }

  const profileUpdate = await fetch(`${baseUrl}/settings/profile`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ fullName: 'Updated User', email: 'updated@example.com' }),
  })

  test('serves the React app for client routes without swallowing unknown API routes', async (context) => {
    const clientDirectory = await mkdtemp(path.join(os.tmpdir(), 'deployhub-client-test-'))
    await writeFile(path.join(clientDirectory, 'index.html'), '<html>DeployHub</html>')
    context.after(() => rm(clientDirectory, { recursive: true, force: true }))

    const server = createApp({
      pool: { async query() { return { rows: [] } } },
      tokenSecret: 'test-secret-with-more-than-32-bytes',
      clientDirectory,
    }).listen(0, '127.0.0.1')
    await new Promise((resolve) => server.once('listening', resolve))
    context.after(() => new Promise((resolve) => server.close(resolve)))
    const baseUrl = `http://127.0.0.1:${server.address().port}`

    const page = await fetch(`${baseUrl}/projects`)
    assert.equal(page.status, 200)
    assert.match(await page.text(), /DeployHub/)

    const missingApiRoute = await fetch(`${baseUrl}/api/does-not-exist`)
    assert.equal(missingApiRoute.status, 404)
    assert.deepEqual(await missingApiRoute.json(), { error: 'Route not found.' })
  })
  assert.equal(profileUpdate.status, 200)
  assert.deepEqual((await profileUpdate.json()).profile, {
    fullName: 'Updated User',
    email: 'updated@example.com',
  })

  const preferenceUpdate = await fetch(`${baseUrl}/settings/notifications`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ preferences: { weeklyReport: true } }),
  })
  assert.equal(preferenceUpdate.status, 200)
  assert.deepEqual((await preferenceUpdate.json()).preferences, {
    deploySuccess: true,
    deployFailed: true,
    podCrash: true,
    weeklyReport: true,
  })

  const keyResponse = await fetch(`${baseUrl}/settings/api-keys`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'Build pipeline' }),
  })
  assert.equal(keyResponse.status, 201)
  const { apiKey } = await keyResponse.json()
  assert.match(apiKey.key, /^dh_live_[A-Za-z0-9_-]+$/)
  assert.ok([...apiKeys.values()].every((row) => row.token_hash !== apiKey.key))

  const keyProfile = await fetch(`${baseUrl}/auth/me`, {
    headers: { authorization: `Bearer ${apiKey.key}` },
  })
  assert.equal(keyProfile.status, 200)
  assert.equal((await keyProfile.json()).user.id, userId)

  const keyList = await fetch(`${baseUrl}/settings/api-keys`, { headers })
  const listedKeys = (await keyList.json()).apiKeys
  assert.equal(listedKeys.length, 1)
  assert.equal(listedKeys[0].name, 'Build pipeline')
  assert.equal(listedKeys[0].maskedKey.endsWith(apiKey.key.slice(-4)), true)

  const keyDelete = await fetch(`${baseUrl}/settings/api-keys/${apiKey.id}`, {
    method: 'DELETE',
    headers,
  })
  assert.equal(keyDelete.status, 204)
  const revokedKeyProfile = await fetch(`${baseUrl}/auth/me`, {
    headers: { authorization: `Bearer ${apiKey.key}` },
  })
  assert.equal(revokedKeyProfile.status, 401)
})
