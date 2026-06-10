import { setTimeout as sleep } from 'node:timers/promises'
import { backfillDeliveries } from './backfill.js'
import { ensureCloudflared } from './cloudflared.js'
import { loadConfig } from './config.js'
import { codexRuntime } from './runtime.codex.js'
import { getAppWebhookUrl, patchAppWebhook } from './github.js'
import { log } from './log.js'
import { startWorkerPool, stopWorkerPool } from './pool.js'
import { type Tunnel, killTunnels, reapOrphanTunnel, startTunnel } from './tunnel.js'
import { type WebhookServer, startWebhookServer } from './webhook.js'

type WebhookStatus = 'off' | 'starting' | 'live' | 'retrying' | 'failed'

let server: WebhookServer | null = null
let tunnel: Tunnel | null = null
let currentSecret: string | null = null
let epoch = 0
let stopped = false
let status: WebhookStatus = 'off'
let publicUrl: string | null = null
let detail: string | null = null

// Errors that retrying can never fix; everything else is treated as transient.
const PERMANENT_SETUP_RE = /unsupported platform|checksum mismatch/i

async function reconnect(myEpoch: number, secret: string, localUrl: string): Promise<void> {
  for (let attempt = 0; epoch === myEpoch && !stopped; attempt++) {
    status = attempt === 0 ? 'starting' : 'retrying'
    tunnel?.close()
    tunnel = null
    try {
      const bin = await ensureCloudflared()
      const next = await startTunnel(bin, localUrl)
      if (epoch !== myEpoch || stopped) {
        next.close()
        return
      }
      const hookUrl = `${next.url}/webhook`
      try {
        await patchAppWebhook(hookUrl, secret)
      } catch (err) {
        next.close()
        throw err
      }
      if (epoch !== myEpoch || stopped) {
        next.close()
        return
      }
      tunnel = next
      publicUrl = hookUrl
      status = 'live'
      detail = null
      log('webhook', `live at ${publicUrl}`)
      void next.exited.then(() => {
        if (stopped || epoch !== myEpoch || tunnel !== next) return
        log('tunnel', 'exited — reconnecting')
        void reconnect(myEpoch, secret, localUrl)
      })
      // A PATCH from a torn-down epoch can land at GitHub after ours; verify
      // and re-assert so the App never points at a dead tunnel while 'live'.
      try {
        const remote = await getAppWebhookUrl()
        if (epoch === myEpoch && !stopped && remote !== null && remote !== hookUrl) {
          await patchAppWebhook(hookUrl, secret)
          log('webhook', `hook config was stale — re-patched to ${hookUrl}`)
        }
      } catch {}
      return
    } catch (err) {
      detail = (err as Error).message
      log('webhook', `setup failed: ${detail}`)
      if (PERMANENT_SETUP_RE.test(detail)) {
        if (epoch === myEpoch && !stopped) {
          status = 'failed'
          log('tunnel', `unavailable: ${detail}`)
        }
        return
      }
      if (epoch === myEpoch && !stopped) {
        status = 'retrying'
        // Transient trouble must never strand unattended ingestion: ramp up
        // exponentially, then keep retrying every 60s indefinitely.
        await sleep(Math.min(2000 * 2 ** attempt, 60_000))
      }
    }
  }
}

async function teardown(): Promise<void> {
  epoch++
  status = 'off'
  publicUrl = null
  detail = null
  tunnel = null
  killTunnels()
  await server?.close()
  server = null
}

async function ensureLiveOnce(force: boolean): Promise<void> {
  if (stopped) return
  const config = loadConfig()
  if (!config.github) return
  const secret = config.github.webhookSecret
  if (!force && server && secret === currentSecret && status !== 'failed') return
  await teardown()
  const myEpoch = epoch
  currentSecret = secret
  status = 'starting'
  server = await startWebhookServer(secret)
  void reconnect(myEpoch, secret, `http://127.0.0.1:${server.port}`)
}

let ensureChain: Promise<void> = Promise.resolve()

function ensureLive(force = false): Promise<void> {
  ensureChain = ensureChain.then(
    () => ensureLiveOnce(force),
    () => ensureLiveOnce(force),
  )
  return ensureChain
}

export async function startIngestion(): Promise<() => Promise<void>> {
  stopped = false
  // Reap a cloudflared orphaned by a previous crash before minting a new tunnel.
  reapOrphanTunnel()
  await ensureLive()
  startWorkerPool(codexRuntime())
  // Recover deliveries missed while the bot was down — runs in the background so
  // it never blocks startup, and the live path is already capturing new events.
  void backfillDeliveries().catch((err) => log('backfill', `failed: ${(err as Error).message}`))
  return async () => {
    stopped = true
    await ensureChain.catch(() => {})
    await stopWorkerPool()
    await teardown()
  }
}

// Fire-and-forget entry points must observe the chain's rejection, or a
// listen failure becomes an unhandled rejection with status stuck 'starting'.
function ensureLiveObserved(force: boolean): void {
  ensureLive(force).catch((err) => {
    status = 'failed'
    detail = (err as Error).message
    log('webhook', `setup failed: ${detail}`)
  })
}

export function notifyAppConfigured(): void {
  ensureLiveObserved(false)
}
