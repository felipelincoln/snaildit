import { createHmac, timingSafeEqual } from 'node:crypto'
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http'
import { loadConfig } from './config.js'
import { ingestDelivery } from './deliveries.js'
import { extract } from './extract.js'
import { log } from './log.js'
import { wakeWorkers } from './pool.js'

const MAX_BODY = 25 * 1024 * 1024

export function verifySignature(secret: string, body: Buffer, header: string | undefined): boolean {
  if (!header) return false
  const expected = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
  const a = Buffer.from(header)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        req.destroy()
        reject(new Error('payload too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function send(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
  res.end(body)
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}

async function handleWebhook(req: IncomingMessage, res: ServerResponse, secret: string): Promise<void> {
  let body: Buffer
  try {
    body = await readBody(req)
  } catch {
    send(res, 413, 'payload too large\n')
    return
  }
  if (!verifySignature(secret, body, header(req, 'x-hub-signature-256'))) {
    send(res, 401, 'bad signature\n')
    return
  }
  const eventType = header(req, 'x-github-event')
  const deliveryId = header(req, 'x-github-delivery')
  if (!eventType || !deliveryId) {
    send(res, 400, 'missing github headers\n')
    return
  }
  let payload: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      send(res, 400, 'invalid json\n')
      return
    }
    payload = parsed as Record<string, unknown>
  } catch {
    send(res, 400, 'invalid json\n')
    return
  }
  const extracted = extract(eventType, payload)
  if (!extracted) {
    const action = typeof payload.action === 'string' ? `.${payload.action}` : ''
    log('webhook', `${eventType}${action} ignored ${deliveryId}`)
    send(res, 200, 'ignored\n')
    return
  }
  const slug = loadConfig().github?.slug
  const sender = (payload.sender as { login?: unknown } | undefined)?.login
  if (slug && typeof sender === 'string' && sender === `${slug}[bot]`) {
    log(
      'webhook',
      `${extracted.event_type}.${extracted.action} ${extracted.repo}#${extracted.number} self-skipped ${deliveryId}`,
    )
    send(res, 200, 'self\n')
    return
  }
  try {
    const { inserted, matched } = ingestDelivery(deliveryId, extracted, new Date().toISOString())
    log(
      'webhook',
      `${extracted.event_type}.${extracted.action} ${extracted.repo}#${extracted.number} ${inserted ? 'stored' : 'dedup'} matched=${matched} ${deliveryId}`,
    )
    if (matched > 0) wakeWorkers()
    send(res, 200, inserted ? 'ok\n' : 'duplicate\n')
  } catch (err) {
    log('webhook', `ingest error: ${(err as Error).message}`)
    send(res, 500, 'error\n')
  }
}

export interface WebhookServer {
  port: number
  close: () => Promise<void>
}

export function startWebhookServer(secret: string): Promise<WebhookServer> {
  const server = createServer((req, res) => {
    const method = req.method ?? 'GET'
    const url = req.url ?? '/'
    if (method === 'POST' && url === '/webhook') {
      // Top-level catch: a throw outside handleWebhook's inner guards must not
      // become an unhandled rejection — answer 500 and keep serving.
      handleWebhook(req, res, secret).catch((err) => {
        log('webhook', `handler error: ${(err as Error).message}`)
        if (!res.headersSent) send(res, 500, 'error\n')
        else if (!res.writableEnded) res.end()
      })
      return
    }
    if ((method === 'GET' || method === 'HEAD') && url === '/') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('snaildit\n')
      return
    }
    send(res, 404, 'not found\n')
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({
        port,
        close: () => new Promise<void>((done) => server.close(() => done())),
      })
    })
  })
}
