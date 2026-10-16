import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = '/app/dist'
const mimeTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.webp', 'image/webp'],
])

const server = createServer(async (request, response) => {
  if (!['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end()
    return
  }
  let pathname
  try {
    pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname)
  } catch {
    response.writeHead(400).end()
    return
  }
  const filePath = path.resolve(root, `.${pathname}`)
  if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
    response.writeHead(404).end()
    return
  }
  let target = filePath
  try {
    if ((await stat(target)).isDirectory()) target = path.join(target, 'index.html')
  } catch {
    target = path.join(root, 'index.html')
  }
  try {
    const info = await stat(target)
    if (!info.isFile()) throw new Error('Not a file')
    response.writeHead(200, {
      'Content-Length': info.size,
      'Content-Type': mimeTypes.get(path.extname(target).toLowerCase()) ?? 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
    })
    if (request.method === 'HEAD') response.end()
    else createReadStream(target).pipe(response)
  } catch {
    response.writeHead(404).end()
  }
})

const port = Number(process.env.PORT ?? 3000)
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
  throw new Error('Static application port is invalid.')
}
server.listen(port, '0.0.0.0')

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => server.close(() => process.exit(0)))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.stdout.write(`Static application server listening on ${port}\n`)
}
