import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runBoundedCommand } from './boundedCommand.js'

const MAX_GIT_OUTPUT_BYTES = 64 * 1024
const MAX_GIT_TIMEOUT_MS = 60_000

export class GitSourceFetcher {
  #gitCommand

  constructor({ gitCommand = process.env.GIT_EXECUTABLE || 'git' } = {}) {
    if (typeof gitCommand !== 'string' || !gitCommand) throw new TypeError('Git executable is invalid.')
    this.#gitCommand = gitCommand
  }

  async fetch(repository, commitSha, {
    diskLimitBytes,
    timeoutMs,
    logBytes,
    signal,
  } = {}) {
    if (typeof repository !== 'string' || typeof commitSha !== 'string'
      || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(commitSha)
      || !Number.isSafeInteger(diskLimitBytes) || diskLimitBytes < 1
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1
      || !Number.isSafeInteger(logBytes) || logBytes < 1) {
      throw new Error('Immutable Git source request is invalid.')
    }
    const directory = await mkdtemp(path.join(tmpdir(), 'deployhub-source-'))
    const configFile = path.join(directory, 'gitconfig')
    const hooksDirectory = path.join(directory, 'hooks-disabled')
    await writeFile(configFile, '', { flag: 'wx' })
    await mkdir(hooksDirectory)
    const env = isolatedGitEnvironment(directory, configFile)
    const commandTimeoutMs = Math.min(timeoutMs, MAX_GIT_TIMEOUT_MS)
    try {
      await this.#run(['init', '--bare', directory], {
        env, timeoutMs: commandTimeoutMs, maxOutputBytes: Math.min(logBytes, MAX_GIT_OUTPUT_BYTES), signal,
      })
      const fetchArgs = [
        '-C', directory,
        '-c', `core.hooksPath=${hooksDirectory}`,
        '-c', 'protocol.allow=never',
        '-c', 'protocol.https.allow=always',
        '-c', 'http.followRedirects=false',
        'fetch', '--depth=1', '--no-tags', '--', repository, commitSha,
      ]
      await this.#run(fetchArgs, {
        env, timeoutMs: commandTimeoutMs, maxOutputBytes: Math.min(logBytes, MAX_GIT_OUTPUT_BYTES), signal,
      }, { directory, diskLimitBytes })
      await this.#run([
        '-C', directory, '-c', `core.hooksPath=${hooksDirectory}`,
        'cat-file', '-e', `${commitSha}^{commit}`,
      ], {
        env, timeoutMs: commandTimeoutMs, maxOutputBytes: Math.min(logBytes, MAX_GIT_OUTPUT_BYTES), signal,
      }, { directory, diskLimitBytes })
      return {
        directory,
        async cleanup() {
          await rm(directory, { recursive: true, force: true })
        },
      }
    } catch (error) {
      await rm(directory, { recursive: true, force: true })
      throw error
    }
  }

  async #run(args, options, diskGuard = null) {
    if (diskGuard) {
      const controller = new AbortController()
      let diskExceeded = false
      const forwardAbort = () => controller.abort()
      options.signal?.addEventListener('abort', forwardAbort, { once: true })
      const timer = setInterval(async () => {
        try {
          if (await directoryBytes(diskGuard.directory, diskGuard.diskLimitBytes) > diskGuard.diskLimitBytes) {
            diskExceeded = true
            controller.abort()
          }
        } catch {
          controller.abort()
        }
      }, 50)
      timer.unref?.()
      try {
        const result = await runBoundedCommand(this.#gitCommand, args, {
          ...options,
          signal: controller.signal,
        })
        if (result.code !== 0) throw new Error('Git source acquisition failed.')
        if (await directoryBytes(diskGuard.directory, diskGuard.diskLimitBytes) > diskGuard.diskLimitBytes) {
          throw new Error('Git source exceeded the allowed workspace size.')
        }
        return result
      } catch {
        if (diskExceeded) throw new Error('Git source exceeded the allowed workspace size.')
        throw new Error('Git source acquisition failed or was cancelled.')
      } finally {
        clearInterval(timer)
        options.signal?.removeEventListener('abort', forwardAbort)
      }
    }
    const result = await runBoundedCommand(this.#gitCommand, args, options)
    if (result.code !== 0) throw new Error('Git source acquisition failed.')
    return result
  }
}

function isolatedGitEnvironment(directory, configFile) {
  const env = {
    PATH: process.env.PATH ?? '',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: configFile,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GIT_OPTIONAL_LOCKS: '0',
    HOME: directory,
    USERPROFILE: directory,
    TMP: directory,
    TEMP: directory,
  }
  for (const key of ['SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT']) {
    if (process.env[key]) env[key] = process.env[key]
  }
  return env
}

async function directoryBytes(directory, limit) {
  const pending = [directory]
  let size = 0
  while (pending.length) {
    const current = pending.pop()
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const resolved = path.join(current, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) pending.push(resolved)
      else if (entry.isFile()) {
        size += (await stat(resolved)).size
        if (size > limit) return size
      }
    }
  }
  return size
}
