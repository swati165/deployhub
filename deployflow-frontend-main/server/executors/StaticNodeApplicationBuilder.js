import { mkdtemp, mkdir, readdir, lstat, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const NODE_APPLICATION_BASE_IMAGE =
  'docker.io/library/node@sha256:2c752226d477b4a886378baa95b9af252be59301b725fdb0b7e15208131505a8'
export const MAX_STATIC_OUTPUT_BYTES = 64 * 1024 * 1024
const MAX_STATIC_FILES = 10_000
const MAX_STATIC_PATH_BYTES = 1024
const MAX_ARCHIVE_BYTES = 72 * 1024 * 1024
const STATIC_SERVER_PATH = fileURLToPath(new URL('./staticAppServer.mjs', import.meta.url))

const PROJECT_CHECK = String.raw`
const fs = require('node:fs');
const fail = (code) => process.stdout.write(JSON.stringify({ ok: false, code }));
try {
  const pkg = JSON.parse(fs.readFileSync('/workspace/package.json', 'utf8'));
  const lock = JSON.parse(fs.readFileSync('/workspace/package-lock.json', 'utf8'));
  if (!pkg || typeof pkg !== 'object' || !pkg.scripts || typeof pkg.scripts.build !== 'string'
    || pkg.scripts.build.length === 0 || pkg.scripts.build.length > 512
    || !lock || lock.lockfileVersion !== 3 || !lock.packages || !lock.packages['']) {
    fail('UNSUPPORTED_BUILD_CONFIGURATION');
  } else if (pkg.packageManager && !/^npm(?:@\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)?$/.test(pkg.packageManager)) {
    fail('UNSUPPORTED_BUILD_CONFIGURATION');
  } else {
    const dependencyFields = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
    const declaredDependencies = dependencyFields.some((key) =>
      pkg[key] && Object.keys(pkg[key]).length > 0
      || lock.packages[''][key] && Object.keys(lock.packages[''][key]).length > 0);
    const packageEntries = Object.keys(lock.packages).some((key) => key !== '');
    const legacyDependencies = lock.dependencies && Object.keys(lock.dependencies).length > 0;
    if (declaredDependencies || packageEntries || legacyDependencies) fail('DEPENDENCY_CACHE_UNAVAILABLE');
    else process.stdout.write(JSON.stringify({ ok: true }));
  }
} catch {
  fail('UNSUPPORTED_BUILD_CONFIGURATION');
}
`

const OUTPUT_CHECK = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const root = '/workspace/dist';
const maxBytes = 67108864;
const maxFiles = 10000;
let bytes = 0;
let files = 0;
const fail = (code) => process.stdout.write(JSON.stringify({ ok: false, code }));
try {
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error();
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === '.' || entry.name === '..' || entry.name.includes('\\')
        || /[\u0000-\u001f\u007f]/.test(entry.name)) throw new Error();
      const target = path.join(directory, entry.name);
      const info = fs.lstatSync(target);
      if (info.isSymbolicLink()) throw new Error();
      if (info.isDirectory()) visit(target);
      else if (info.isFile()) {
        files += 1;
        bytes += info.size;
        if (files > maxFiles || bytes > maxBytes) {
          const error = new Error();
          error.code = 'OUTPUT_LIMIT_EXCEEDED';
          throw error;
        }
      } else throw new Error();
    }
  };
  visit(root);
  if (!fs.lstatSync(path.join(root, 'index.html')).isFile()) throw new Error();
  process.stdout.write(JSON.stringify({ ok: true, files, bytes }));
} catch (error) {
  fail(error.code === 'OUTPUT_LIMIT_EXCEEDED' ? error.code : 'UNSUPPORTED_BUILD_CONFIGURATION');
}
`

export class ApplicationBuildError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ApplicationBuildError'
    this.code = code
  }
}

export class StaticNodeApplicationBuilder {
  #runtime
  #baseImage

  constructor({ runtime, baseImage = NODE_APPLICATION_BASE_IMAGE } = {}) {
    if (!runtime || typeof runtime.exec !== 'function'
      || typeof runtime.exportApplicationOutput !== 'function'
      || typeof runtime.buildApplicationImage !== 'function') {
      throw new TypeError('Application image runtime is invalid.')
    }
    if (typeof baseImage !== 'string'
      || !/^docker\.io\/library\/node@sha256:[0-9a-f]{64}$/i.test(baseImage)) {
      throw new TypeError('Application image base must be a pinned official Node image digest.')
    }
    this.#runtime = runtime
    this.#baseImage = baseImage
  }

  async inspectProject(containerId, policy, timeoutMs, signal) {
    const result = await this.#runtime.exec(containerId, ['node', '-e', PROJECT_CHECK], {
      policy, timeoutMs, signal,
    })
    if (result.code !== 0) {
      throw new ApplicationBuildError('UNSUPPORTED_BUILD_CONFIGURATION', 'Node static application configuration is invalid.')
    }
    const status = parseGuestStatus(result.stdout)
    if (!status.ok) {
      throw status.code === 'DEPENDENCY_CACHE_UNAVAILABLE'
        ? new ApplicationBuildError(status.code, 'Required npm dependency cache is not included in the isolated runtime image.')
        : new ApplicationBuildError(status.code, 'Only dependency-free npm projects with package-lock v3 and a build script are supported.')
    }
  }

  async validateOutput(containerId, policy, timeoutMs, signal) {
    const result = await this.#runtime.exec(containerId, ['node', '-e', OUTPUT_CHECK], {
      policy, timeoutMs, signal,
    })
    if (result.code !== 0) {
      throw new ApplicationBuildError('UNSUPPORTED_BUILD_CONFIGURATION', 'Build output is not a bounded static site.')
    }
    const status = parseGuestStatus(result.stdout)
    if (!status.ok) {
      const message = status.code === 'OUTPUT_LIMIT_EXCEEDED'
        ? 'Static build output exceeded its size limit.'
        : 'Build must produce a regular-file-only dist directory containing index.html.'
      throw new ApplicationBuildError(status.code, message)
    }
    if (!Number.isSafeInteger(status.files) || status.files < 1 || status.files > MAX_STATIC_FILES
      || !Number.isSafeInteger(status.bytes) || status.bytes < 1 || status.bytes > MAX_STATIC_OUTPUT_BYTES) {
      throw new ApplicationBuildError('OUTPUT_LIMIT_EXCEEDED', 'Static build output exceeded its file or size limit.')
    }
    return { files: status.files, bytes: status.bytes }
  }

  async createImage({
    containerId,
    reference,
    labels,
    policy,
    timeoutMs,
    signal,
  }) {
    const context = await mkdtemp(path.join(os.tmpdir(), 'deployhub-app-image-'))
    try {
      const archive = await this.#runtime.exportApplicationOutput(containerId, { timeoutMs, signal })
      if (!Buffer.isBuffer(archive) || archive.byteLength > MAX_ARCHIVE_BYTES) {
        throw new ApplicationBuildError('OUTPUT_LIMIT_EXCEEDED', 'Static build archive exceeded its size limit.')
      }
      await extractStaticTar(archive, path.join(context, 'dist'))
      const output = path.join(context, 'dist')
      const size = await validateHostOutput(output)
      if (size.bytes > MAX_STATIC_OUTPUT_BYTES || size.files > MAX_STATIC_FILES) {
        throw new ApplicationBuildError('OUTPUT_LIMIT_EXCEEDED', 'Static build output exceeded its file or size limit.')
      }

      await writeFile(path.join(context, 'static-server.mjs'), await readFile(STATIC_SERVER_PATH), { flag: 'wx' })
      const dockerfile = [
        `FROM ${this.#baseImage}`,
        'COPY dist/ /app/dist/',
        'COPY static-server.mjs /opt/deployhub/static-server.mjs',
        'ENV NODE_ENV=production PORT=3000 HOME=/tmp',
        'WORKDIR /app',
        'USER 1000:1000',
        'EXPOSE 3000',
        'CMD ["node", "/opt/deployhub/static-server.mjs"]',
        ...Object.entries(labels).map(([key, value]) => `LABEL ${key}="${value}"`),
        '',
      ].join('\n')
      await writeFile(path.join(context, 'Dockerfile'), dockerfile, { flag: 'wx' })
      const built = await this.#runtime.buildApplicationImage({
        contextDirectory: context,
        reference,
        policy,
        timeoutMs,
        signal,
      })
      validateImageId(built.imageId)
      if (built.config?.User !== '1000:1000'
        || JSON.stringify(built.config?.Cmd) !== JSON.stringify(['node', '/opt/deployhub/static-server.mjs'])
        || built.config?.WorkingDir !== '/app'
        || !Object.keys(built.config?.ExposedPorts ?? {}).includes('3000/tcp')
        || hasCredentialEnvironment(built.config?.Env)) {
        await this.#runtime.removeApplicationImage(reference, policy)
        throw new ApplicationBuildError('IMAGE_BUILD_FAILED', 'Built application image did not match the fixed runtime policy.')
      }
      return {
        format: 'OCI_IMAGE',
        reference,
        digest: built.imageId,
      }
    } finally {
      await rm(context, { recursive: true, force: true })
    }
  }
}

export async function extractStaticTar(archive, destination) {
  if (!Buffer.isBuffer(archive) || archive.length > MAX_ARCHIVE_BYTES || archive.length < 1024
    || archive.length % 512 !== 0) {
    throw new ApplicationBuildError('UNSUPPORTED_BUILD_CONFIGURATION', 'Static output archive is malformed.')
  }
  await mkdir(destination, { recursive: false })
  let offset = 0
  let bytes = 0
  let files = 0
  let sawEnd = false
  const seen = new Set()
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512)
    offset += 512
    if (header.every((value) => value === 0)) {
      if (offset + 512 > archive.length
        || !archive.subarray(offset).every((value) => value === 0)) {
        throw new ApplicationBuildError('UNSUPPORTED_BUILD_CONFIGURATION', 'Static output archive has an invalid end marker.')
      }
      sawEnd = true
      break
    }
    validateTarChecksum(header)
    const name = tarString(header, 0, 100)
    const prefix = tarString(header, 345, 155)
    const rawPath = prefix ? `${prefix}/${name}` : name
    const entryPath = normalizeArchivePath(rawPath)
    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156])
    const size = parseTarOctal(header, 124, 12)
    if (!entryPath) {
      if (type !== '5' || size !== 0) {
        throw new ApplicationBuildError('UNSUPPORTED_BUILD_CONFIGURATION', 'Static output archive contains an invalid root entry.')
      }
    } else if (!['0', '5'].includes(type)) {
      throw new ApplicationBuildError('UNSUPPORTED_BUILD_CONFIGURATION', 'Static output archive contains links or special files.')
    }
    if (type === '5' && size !== 0) {
      throw new ApplicationBuildError('UNSUPPORTED_BUILD_CONFIGURATION', 'Static output archive contains an invalid directory entry.')
    }
    const paddedSize = Math.ceil(size / 512) * 512
    if (offset + paddedSize > archive.length) {
      throw new ApplicationBuildError('UNSUPPORTED_BUILD_CONFIGURATION', 'Static output archive is truncated.')
    }
    if (entryPath) {
      const target = path.resolve(destination, entryPath)
      if (target !== destination && !target.startsWith(`${destination}${path.sep}`)) {
        throw new ApplicationBuildError('UNSUPPORTED_BUILD_CONFIGURATION', 'Static output archive path escapes its destination.')
      }
      if (seen.has(entryPath)) {
        throw new ApplicationBuildError('UNSUPPORTED_BUILD_CONFIGURATION', 'Static output archive contains duplicate paths.')
      }
      seen.add(entryPath)
      if (type === '5') {
        await mkdir(target, { recursive: true })
      } else {
        files += 1
        bytes += size
        if (files > MAX_STATIC_FILES || bytes > MAX_STATIC_OUTPUT_BYTES) {
          throw new ApplicationBuildError('OUTPUT_LIMIT_EXCEEDED', 'Static build output exceeded its file or size limit.')
        }
        await mkdir(path.dirname(target), { recursive: true })
        await writeFile(target, archive.subarray(offset, offset + size), { flag: 'wx', mode: 0o644 })
      }
    }
    offset += paddedSize
  }
  if (!sawEnd) {
    throw new ApplicationBuildError('UNSUPPORTED_BUILD_CONFIGURATION', 'Static output archive is missing its end marker.')
  }
  const index = await lstat(path.join(destination, 'index.html')).catch(() => null)
  if (!index?.isFile() || index.isSymbolicLink() || files < 1) {
    throw new ApplicationBuildError('UNSUPPORTED_BUILD_CONFIGURATION', 'Build must produce dist/index.html.')
  }
  return { files, bytes }
}

function parseGuestStatus(value) {
  let status
  try {
    status = JSON.parse(value)
  } catch {
    throw new ApplicationBuildError('UNSUPPORTED_BUILD_CONFIGURATION', 'Isolated project validation returned malformed data.')
  }
  if (!status || typeof status !== 'object' || typeof status.ok !== 'boolean') {
    throw new ApplicationBuildError('UNSUPPORTED_BUILD_CONFIGURATION', 'Isolated project validation returned malformed data.')
  }
  if (!status.ok && !['UNSUPPORTED_BUILD_CONFIGURATION', 'DEPENDENCY_CACHE_UNAVAILABLE', 'OUTPUT_LIMIT_EXCEEDED'].includes(status.code)) {
    throw new ApplicationBuildError('UNSUPPORTED_BUILD_CONFIGURATION', 'Isolated project validation returned an unknown status.')
  }
  return status
}

export async function validateHostOutput(root, filesystem = { readdir, lstat }) {
  let bytes = 0
  let files = 0
  const visit = async (directory) => {
    for (const entry of await filesystem.readdir(directory, { withFileTypes: true })) {
      if (entry.name === '.' || entry.name === '..' || entry.name.includes('\\')
        || hasControlCharacters(entry.name)) {
        throw new ApplicationBuildError('UNSUPPORTED_BUILD_CONFIGURATION', 'Static output contains an unsafe path.')
      }
      const target = path.join(directory, entry.name)
      const info = await filesystem.lstat(target)
      if (info.isSymbolicLink()) {
        throw new ApplicationBuildError('UNSUPPORTED_BUILD_CONFIGURATION', 'Static output cannot contain symbolic links.')
      }
      if (info.isDirectory()) await visit(target)
      else if (info.isFile()) {
        files += 1
        bytes += info.size
        if (files > MAX_STATIC_FILES || bytes > MAX_STATIC_OUTPUT_BYTES) {
          throw new ApplicationBuildError('OUTPUT_LIMIT_EXCEEDED', 'Static build output exceeded its file or size limit.')
        }
      } else {
        throw new ApplicationBuildError('UNSUPPORTED_BUILD_CONFIGURATION', 'Static output may contain only regular files and directories.')
      }
    }
  }
  let rootInfo
  try {
    rootInfo = await filesystem.lstat(root)
  } catch {
    throw new ApplicationBuildError('UNSUPPORTED_BUILD_CONFIGURATION', 'Build did not produce the required dist directory.')
  }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new ApplicationBuildError('UNSUPPORTED_BUILD_CONFIGURATION', 'Build output dist path must be a regular directory.')
  }
  await visit(root)
  const index = await filesystem.lstat(path.join(root, 'index.html')).catch(() => null)
  if (!index?.isFile() || index.isSymbolicLink() || files < 1) {
    throw new ApplicationBuildError('UNSUPPORTED_BUILD_CONFIGURATION', 'Build must produce dist/index.html.')
  }
  return { bytes, files }
}

function validateImageId(value) {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/i.test(value)) {
    throw new ApplicationBuildError('IMAGE_BUILD_FAILED', 'Docker returned an invalid application image ID.')
  }
}

function normalizeArchivePath(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_STATIC_PATH_BYTES
    || value.includes('\\') || hasControlCharacters(value) || value.startsWith('/')) {
    throw new ApplicationBuildError('UNSUPPORTED_BUILD_CONFIGURATION', 'Static output archive contains an unsafe path.')
  }
  const trimmed = value.replace(/^(?:\.\/)+/, '').replace(/\/+$/, '')
  if (trimmed === '' || trimmed === '.') return ''
  const segments = trimmed.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new ApplicationBuildError('UNSUPPORTED_BUILD_CONFIGURATION', 'Static output archive contains an unsafe path.')
  }
  return segments.join(path.sep)
}

function hasControlCharacters(value) {
  return [...value].some((character) => {
    const code = character.codePointAt(0)
    return code <= 0x1f || code === 0x7f
  })
}

function parseTarOctal(header, start, length) {
  const value = tarString(header, start, length).trim()
  if (value === '') return 0
  if (!/^[0-7]+$/.test(value)) {
    throw new ApplicationBuildError('UNSUPPORTED_BUILD_CONFIGURATION', 'Static output archive contains an invalid size.')
  }
  const parsed = Number.parseInt(value, 8)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ApplicationBuildError('UNSUPPORTED_BUILD_CONFIGURATION', 'Static output archive contains an invalid size.')
  }
  return parsed
}

function tarString(header, start, length) {
  const field = header.subarray(start, start + length)
  const end = field.indexOf(0)
  return field.subarray(0, end < 0 ? field.length : end).toString('utf8')
}

function validateTarChecksum(header) {
  const expected = parseTarOctal(header, 148, 8)
  let actual = 0
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 32 : header[index]
  }
  if (actual !== expected) {
    throw new ApplicationBuildError('UNSUPPORTED_BUILD_CONFIGURATION', 'Static output archive checksum is invalid.')
  }
}

function hasCredentialEnvironment(environment) {
  return !Array.isArray(environment) || environment.some((item) =>
    /^(?:DATABASE_URL|JWT_SECRET|GITHUB_SOURCE_TOKEN|REGISTRY_USERNAME|REGISTRY_PASSWORD|REGISTRY_TOKEN|AWS_|CLOUD_|DOCKER_HOST|DOCKER_CONTEXT|.*(?:TOKEN|SECRET|PASSWORD|API_KEY))=/i.test(item))
}
