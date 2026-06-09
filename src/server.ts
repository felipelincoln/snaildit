import { readFile } from 'node:fs/promises'
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http'
import { dirname, extname, isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { handleApi } from './api.js'
import { log } from './log.js'

const WEB = join(dirname(fileURLToPath(import.meta.url)), 'web')

const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

function hostAllowed(req: IncomingMessage): boolean {
  const host = req.headers.host
  if (!host) return false
  try {
    return ALLOWED_HOSTS.has(new URL(`http://${host}`).hostname)
  } catch {
    return false
  }
}

// CSRF / same-origin guard for state-changing API calls — independent of the Host
// allowlist. A page you visit must not be able to drive the local control plane.
function crossSiteMutation(req: IncomingMessage, url: URL): boolean {
  const method = req.method ?? 'GET'
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return false
  if (!url.pathname.startsWith('/api/')) return false
  // Modern browsers tag the request's relation to our origin.
  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return true
  // Fallback: a cross-origin browser request carries an Origin header.
  const origin = req.headers.origin
  if (typeof origin === 'string') {
    try {
      if (!ALLOWED_HOSTS.has(new URL(origin).hostname)) return true
    } catch {
      return true
    }
  }
  // Close the simple-form (text/plain) bypass: bodied mutations must be JSON.
  if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
    const ct = String(req.headers['content-type'] ?? '').toLowerCase()
    if (!ct.includes('application/json')) return true
  }
  return false
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
}

async function send(res: ServerResponse, reqUrl: string): Promise<void> {
  let pathname: string
  try {
    pathname = decodeURIComponent(new URL(reqUrl, 'http://localhost').pathname)
  } catch {
    res.writeHead(400)
    res.end()
    return
  }
  const file = join(WEB, pathname === '/' || !extname(pathname) ? '/index.html' : pathname)
  const rel = relative(WEB, file)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    res.writeHead(403)
    res.end()
    return
  }
  try {
    const body = await readFile(file)
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    if (extname(pathname)) {
      res.writeHead(404)
      res.end()
      return
    }
    const html = await readFile(join(WEB, 'index.html'))
    res.writeHead(200, { 'content-type': TYPES['.html'] })
    res.end(html)
  }
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    if (!hostAllowed(req)) {
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'forbidden host' }))
      return
    }
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (crossSiteMutation(req, url)) {
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'cross-site request blocked' }))
      return
    }
    if (await handleApi(req, res, url)) return
    await send(res, req.url ?? '/')
  } catch (err) {
    log('server', `request error: ${(err as Error).message}`)
    if (res.writableEnded) return
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: 'internal error' }))
  }
}

export async function startServer(): Promise<string> {
  const port = Number(process.env.PORT ?? 3000)
  const host = process.env.HOST ?? '127.0.0.1'
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `refusing to bind the unauthenticated dashboard to non-loopback HOST "${host}" — it would expose repo-write control to your network. ` +
        'Keep the default loopback bind and reach it remotely via an SSH tunnel or an authenticated reverse proxy.',
    )
  }
  const server = createServer((req, res) => void handle(req, res))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolve()
    })
  })
  return `http://${host === '::1' ? '[::1]' : host}:${port}`
}
