import { spawn } from 'node:child_process'

export class CommandTimeoutError extends Error {
  constructor(message = 'Runtime command timed out.') {
    super(message)
    this.name = 'CommandTimeoutError'
    this.code = 'COMMAND_TIMEOUT'
  }
}

export class CommandOutputLimitError extends Error {
  constructor(message = 'Runtime command exceeded its output limit.') {
    super(message)
    this.name = 'CommandOutputLimitError'
    this.code = 'OUTPUT_LIMIT'
  }
}

export async function runBoundedCommand(command, args, {
  cwd,
  env = process.env,
  timeoutMs,
  maxOutputBytes,
  signal,
  input,
  binaryOutput = false,
} = {}) {
  if (typeof command !== 'string' || !Array.isArray(args)
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1
    || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 0
    || typeof binaryOutput !== 'boolean') {
    throw new TypeError('Bounded command options are invalid.')
  }
  if (signal?.aborted) throw new Error('Runtime command was cancelled.')

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    })
    const stdout = []
    const stderr = []
    let outputBytes = 0
    let settled = false
    let timeoutError = null

    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      child.stdout.removeAllListeners()
      child.stderr.removeAllListeners()
      child.removeAllListeners()
    }
    const finish = (error, result) => {
      if (settled) return
      settled = true
      cleanup()
      if (error) reject(error)
      else resolve(result)
    }
    const kill = (error) => {
      timeoutError = error
      child.kill('SIGKILL')
    }
    const collect = (target) => (chunk) => {
      outputBytes += chunk.length
      if (outputBytes > maxOutputBytes) {
        kill(new CommandOutputLimitError())
        return
      }
      target.push(chunk)
    }
    const onAbort = () => kill(new Error('Runtime command was cancelled.'))
    const timer = setTimeout(() => kill(new CommandTimeoutError()), timeoutMs)
    timer.unref?.()

    child.stdout.on('data', collect(stdout))
    child.stderr.on('data', collect(stderr))
    child.once('error', (error) => finish(timeoutError ?? error))
    child.once('close', (code, childSignal) => {
      if (timeoutError) {
        finish(timeoutError)
        return
      }
      finish(null, {
        code,
        signal: childSignal,
        stdout: binaryOutput ? Buffer.concat(stdout) : Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        outputBytes,
      })
    })
    signal?.addEventListener('abort', onAbort, { once: true })
    if (input !== undefined) {
      child.stdin.on('error', () => {})
      child.stdin.end(input)
    }
  })
}
