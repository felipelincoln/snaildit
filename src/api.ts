import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { isOnboarded, loadConfig, markOnboarded, saveConfig } from './config.js'
import { CODEX_REPOS_BASE } from './engines/codex.js'
import { ENGINES, engineMetas, isEngineId } from './engines/index.js'
import {
  appAuthDead,
  appProfile,
  buildManifest,
  exchangeManifestCode,
  installationCount,
  installationRepos,
  writeAppCredentials,
} from './github.js'
import { dailyRunCounts, deleteJobsFor, listQueuedJobs, listRecentRuns } from './jobs.js'
import { notifyAppConfigured } from './live.js'
import { log } from './log.js'
import {
  type Automation,
  type AutomationPatch,
  DuplicateAutomationError,
  type NewAutomation,
  createAutomation,
  deleteAutomation,
  getAutomation,
  listAutomations,
  updateAutomation,
} from './automations.js'

export type DomainId = 'app' | 'repos' | 'engine'

const ORDER: DomainId[] = ['app', 'repos', 'engine']

interface State {
  onboarded: boolean
  step: DomainId | 'done'
  domains: Record<DomainId, { done: boolean }>
  appSlug: string | null
  engine: string | null
}

let lastDone: Record<DomainId, boolean> | null = null

async function logDomainChanges(
  domains: Record<DomainId, { done: boolean }>,
  info: { appSlug: string | null; engine: string | null },
): Promise<void> {
  const now: Record<DomainId, boolean> = {
    app: domains.app.done,
    repos: domains.repos.done,
    engine: domains.engine.done,
  }
  if (lastDone) {
    if (now.app !== lastDone.app)
      log('github', now.app ? `app connected: ${info.appSlug ?? 'unknown'}` : 'app disconnected')
    if (now.repos !== lastDone.repos) {
      if (now.repos) {
        let count = 0
        try {
          count = (await installationRepos()).length
        } catch {}
        log('github', `repositories connected: ${count}`)
      } else {
        log('github', 'repositories disconnected')
      }
    }
    if (now.engine !== lastDone.engine)
      log('engine', now.engine ? `connected: ${info.engine ?? 'unknown'}` : 'disconnected')
  }
  lastDone = now
}

async function computeState(): Promise<State> {
  const config = loadConfig()
  const appDone = config.github != null && !(await appAuthDead())
  const repoCount = appDone ? await installationCount() : 0
  // null = GitHub unreachable; don't regress to "no repos", keep the last known state.
  const reposDone = repoCount === null ? (lastDone?.repos ?? false) : repoCount > 0
  const engine = isEngineId(config.engine) ? ENGINES[config.engine] : null
  const engineDone = engine?.isConfigured() ?? false
  const domains: Record<DomainId, { done: boolean }> = {
    app: { done: appDone },
    repos: { done: reposDone },
    engine: { done: engineDone },
  }
  await logDomainChanges(domains, {
    appSlug: config.github?.slug ?? null,
    engine: isEngineId(config.engine) ? config.engine : null,
  })
  const coreDone = appDone && reposDone && engineDone
  if (coreDone && !isOnboarded(config)) markOnboarded()
  const step = ORDER.find((id) => !domains[id].done) ?? 'done'
  return {
    onboarded: isOnboarded(config) || coreDone,
    step,
    domains,
    appSlug: config.github?.slug ?? null,
    engine: isEngineId(config.engine) ? config.engine : null,
  }
}

let stateInFlight: Promise<State> | null = null

function currentState(): Promise<State> {
  if (!stateInFlight) {
    stateInFlight = computeState().finally(() => {
      stateInFlight = null
    })
  }
  return stateInFlight
}

class HttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function html(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' })
  res.end(body)
}

async function readJsonBody<T>(req: IncomingMessage, cap = 1_000_000): Promise<T> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > cap) throw new HttpError(413, 'request body too large')
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  return (raw ? JSON.parse(raw) : {}) as T
}

const MAX_AVATAR_BYTES = 2_000_000

// The avatar URL comes from GitHub's own API, but pin the destination anyway
// so this fetch-and-pipe proxy can never be walked off-host.
function avatarAllowed(url: string): boolean {
  if (!url) return false
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && u.hostname.endsWith('.githubusercontent.com')
  } catch {
    return false
  }
}

let pending: { state: string; name: string } | null = null

function manifestPayload(req: IncomingMessage, isPublic: boolean) {
  if (!pending)
    pending = { state: randomBytes(16).toString('hex'), name: `gh-ai-bot-${randomBytes(3).toString('hex')}` }
  const host = req.headers.host ?? 'localhost'
  return {
    postUrl: `https://github.com/settings/apps/new?state=${pending.state}`,
    manifest: buildManifest(pending.name, `http://${host}/api/setup/app/callback`, isPublic),
  }
}

function callbackPage(title: string, message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:1.5rem;background:#fff;color:#1a1c1f;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;line-height:1.5;-webkit-font-smoothing:antialiased}
main{width:100%;max-width:24rem;text-align:center}
.logo{width:3rem;height:3rem;margin:0 auto 1rem;display:block;border-radius:.625rem}
h1{margin:0 0 .5rem;font-size:1.125rem;font-weight:400;letter-spacing:-.01em}
p{margin:0;font-size:.875rem;color:#5d5d5d}
@media (prefers-color-scheme:dark){body{background:#181818;color:#ededed}p{color:#a3a3a3}}
</style></head>
<body><main><img class="logo" src="/logo.png" alt=""><h1>${title}</h1><p>${message}</p></main></body></html>`
}

export async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const { pathname } = url
  if (!pathname.startsWith('/api/')) return false
  const method = req.method ?? 'GET'
  try {
    if (pathname === '/api/state' && method === 'GET') {
      json(res, 200, await currentState())
      return true
    }
    if (pathname === '/api/runs' && method === 'GET') {
      const raw = Number(url.searchParams.get('limit'))
      const limit = Number.isInteger(raw) && raw > 0 && raw <= 100 ? raw : 20
      const names = new Map(listAutomations().map((a) => [a.id, a.name]))
      const runs = listRecentRuns(limit).map((r) => ({
        ...r,
        name: names.get(r.automation_id) ?? null,
        url: r.repo_full_name
          ? `https://github.com/${r.repo_full_name}/${r.type === 'pull_request' ? 'pull' : 'issues'}/${r.number}`
          : null,
        resume_command: r.session_id
          ? `CODEX_HOME='${join(CODEX_REPOS_BASE, String(r.repository_id))}' codex resume ${r.session_id} --cd "$PWD"`
          : null,
      }))
      const queued = listQueuedJobs().map((q) => ({ ...q, name: names.get(q.automation_id) ?? null }))
      json(res, 200, { runs, queued })
      return true
    }
    if (pathname === '/api/activity' && method === 'GET') {
      json(res, 200, { days: dailyRunCounts(365) })
      return true
    }
    if (pathname === '/api/bot' && method === 'GET') {
      const config = loadConfig()
      if (!config.github || (await appAuthDead())) {
        json(res, 200, { bot: null })
        return true
      }
      try {
        json(res, 200, { bot: await appProfile() })
      } catch {
        const { slug } = config.github
        json(res, 200, { bot: { slug, name: slug, avatar: '', url: `https://github.com/apps/${slug}` } })
      }
      return true
    }
    if (pathname === '/api/avatar' && method === 'GET') {
      const config = loadConfig()
      if (config.github && !(await appAuthDead())) {
        try {
          const { avatar } = await appProfile()
          if (avatarAllowed(avatar)) {
            const upstream = await fetch(avatar, { signal: AbortSignal.timeout(10_000), redirect: 'error' })
            const type = upstream.headers.get('content-type') ?? ''
            const length = Number(upstream.headers.get('content-length') ?? '0')
            if (upstream.ok && type.startsWith('image/') && length <= MAX_AVATAR_BYTES) {
              const body = Buffer.from(await upstream.arrayBuffer())
              if (body.length <= MAX_AVATAR_BYTES) {
                res.writeHead(200, {
                  'content-type': type,
                  'cache-control': 'no-cache',
                  'x-content-type-options': 'nosniff',
                })
                res.end(body)
                return true
              }
            }
          }
        } catch {}
      }
      res.writeHead(302, { location: '/logo.png', 'cache-control': 'no-cache' })
      res.end()
      return true
    }
    if (pathname === '/api/engines' && method === 'GET') {
      json(res, 200, { engines: engineMetas() })
      return true
    }
    if (pathname === '/api/setup/engine' && method === 'POST') {
      const { engine } = await readJsonBody<{ engine?: string }>(req)
      if (!isEngineId(engine)) throw new HttpError(400, 'unknown engine')
      saveConfig({ ...loadConfig(), engine })
      log('engine', `selected: ${engine}`)
      ENGINES[engine].prepare?.()
      json(res, 200, { ok: true })
      return true
    }
    if (pathname === '/api/setup/recheck' && method === 'POST') {
      const id = loadConfig().engine
      if (!isEngineId(id)) throw new HttpError(400, 'no engine selected')
      ENGINES[id].prepare?.()
      json(res, 200, { configured: ENGINES[id].isConfigured() })
      return true
    }
    if (pathname === '/api/setup/app/manifest' && method === 'GET') {
      json(res, 200, manifestPayload(req, url.searchParams.get('public') === 'true'))
      return true
    }
    if (pathname === '/api/setup/app/callback' && method === 'GET') {
      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')
      if (!pending || !state || state !== pending.state) {
        html(res, 400, callbackPage('Setup link expired', 'Please restart the GitHub App step from the dashboard.'))
        return true
      }
      if (!code) {
        html(
          res,
          400,
          callbackPage('Missing code', 'GitHub did not return a setup code — try again from the dashboard.'),
        )
        return true
      }
      try {
        writeAppCredentials(await exchangeManifestCode(code))
      } catch {
        html(
          res,
          502,
          callbackPage(
            'Could not connect',
            'GitHub rejected the setup — please restart the GitHub App step from the dashboard.',
          ),
        )
        return true
      }
      pending = null
      notifyAppConfigured()
      html(res, 200, callbackPage('Your bot is connected', 'You can close this tab and return to the dashboard.'))
      return true
    }
    if (pathname === '/api/repos' && method === 'GET') {
      json(res, 200, { repos: await installationRepos() })
      return true
    }
    if (pathname === '/api/automations' && method === 'GET') {
      json(res, 200, { automations: listAutomations() })
      return true
    }
    if (pathname === '/api/automations' && method === 'POST') {
      const input = await readJsonBody<NewAutomation>(req)
      let automation: Automation
      try {
        automation = createAutomation(input)
        log('automation', `created: ${automation.id}`)
      } catch (err) {
        if (err instanceof DuplicateAutomationError) throw new HttpError(409, err.message)
        throw new HttpError(400, (err as Error).message)
      }
      json(res, 201, automation)
      return true
    }
    const idMatch = pathname.match(/^\/api\/automations\/([^/]+)$/)
    if (idMatch) {
      const id = decodeURIComponent(idMatch[1])
      if (method === 'GET') {
        const automation = getAutomation(id)
        if (!automation) throw new HttpError(404, 'automation not found')
        json(res, 200, automation)
        return true
      }
      if (method === 'PATCH') {
        const patch = await readJsonBody<AutomationPatch>(req)
        let automation: Automation | null
        try {
          automation = updateAutomation(id, patch)
        } catch (err) {
          throw new HttpError(400, (err as Error).message)
        }
        if (!automation) throw new HttpError(404, 'automation not found')
        log('automation', `updated: ${id}`)
        json(res, 200, automation)
        return true
      }
      if (method === 'DELETE') {
        if (!deleteAutomation(id)) throw new HttpError(404, 'automation not found')
        // Drop queue state too, or a recreated automation with the same id
        // would inherit the old jobs — including a stale Codex session.
        deleteJobsFor(id)
        log('automation', `deleted: ${id}`)
        json(res, 200, { ok: true })
        return true
      }
    }
    json(res, 404, { error: `no route for ${method} ${pathname}` })
    return true
  } catch (err) {
    if (res.headersSent || res.writableEnded) return true
    if (err instanceof HttpError) json(res, err.status, { error: err.message })
    else if (err instanceof SyntaxError) json(res, 400, { error: 'invalid JSON body' })
    else if (err instanceof URIError) json(res, 400, { error: 'invalid request' })
    else throw err
    return true
  }
}
