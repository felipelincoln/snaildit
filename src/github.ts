import { Octokit } from '@octokit/core'
import { createAppAuth } from '@octokit/auth-app'
import { retry } from '@octokit/plugin-retry'
import { throttling } from '@octokit/plugin-throttling'
import { paginateRest } from '@octokit/plugin-paginate-rest'
import { loadConfig, readPem, saveConfig, writePem } from './config.js'

const USER_AGENT = 'snaildit'
const GH_API = 'https://api.github.com'
const REQUEST_TIMEOUT_MS = 10_000

const App = Octokit.plugin(retry, throttling, paginateRest)
const Paginate = Octokit.plugin(paginateRest)

type AppOctokit = InstanceType<typeof App>

let cached: AppOctokit | undefined

export function appOctokit(): AppOctokit {
  if (cached) return cached
  const appId = loadConfig().github?.appId
  const privateKey = readPem()
  if (!appId) throw new Error('github app not configured: missing appId in config.json')
  if (privateKey === null) {
    const err = new Error('github app private key missing') as NodeJS.ErrnoException
    err.code = 'ENOENT'
    throw err
  }
  cached = new App({
    authStrategy: createAppAuth,
    auth: { appId, privateKey },
    userAgent: USER_AGENT,
    throttle: {
      onRateLimit: (retryAfter) => retryAfter <= 60,
      onSecondaryRateLimit: (retryAfter) => retryAfter <= 60,
    },
  })
  return cached
}

let healthCache: { dead: boolean; at: number } | null = null
const HEALTH_TTL_MS = 30_000

export async function appAuthDead(): Promise<boolean> {
  if (healthCache && Date.now() - healthCache.at < HEALTH_TTL_MS) return healthCache.dead
  let dead = false
  try {
    await appOctokit().request('GET /app', { request: { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) } })
  } catch (e) {
    const err = e as { status?: number; code?: string }
    dead = err.code === 'ENOENT' || err.code === 'EACCES' || err.status === 401 || err.status === 404
  }
  healthCache = { dead, at: Date.now() }
  return dead
}

export interface AppProfile {
  slug: string
  name: string
  avatar: string
  url: string
}

let profileCache: AppProfile | null = null

export async function appProfile(): Promise<AppProfile> {
  if (profileCache) return profileCache
  const { data: app } = await appOctokit().request('GET /app', {
    request: { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
  })
  const slug = app?.slug ?? ''
  let avatar = ''
  try {
    const r = await fetch(`${GH_API}/users/${encodeURIComponent(`${slug}[bot]`)}`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (r.ok) avatar = ((await r.json()) as { avatar_url?: string }).avatar_url ?? ''
  } catch {}
  const profile: AppProfile = {
    slug,
    name: app?.name || slug,
    avatar,
    url: app?.html_url || `https://github.com/apps/${slug}`,
  }
  if (slug && avatar) profileCache = profile
  return profile
}

let reposCache: { count: number; at: number } | null = null

export async function installationCount(): Promise<number | null> {
  if (reposCache && Date.now() - reposCache.at < HEALTH_TTL_MS) return reposCache.count
  try {
    const { data } = await appOctokit().request('GET /app/installations', {
      request: { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
    })
    reposCache = data.length > 0 ? { count: data.length, at: Date.now() } : null
    return data.length
  } catch {
    // Transient/unreachable: fall back to the last known count, or null if we
    // never determined one — null lets the caller tell "GitHub unreachable"
    // apart from a genuine zero instead of falsely reporting "no repos".
    return reposCache?.count ?? null
  }
}

export interface InstallationRepo {
  id: number
  full_name: string
}

export async function installationRepos(): Promise<InstallationRepo[]> {
  const octokit = appOctokit()
  const { data: insts } = await octokit.request('GET /app/installations', {
    request: { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
  })
  const repos: InstallationRepo[] = []
  for (const inst of insts) {
    const { token } = (await octokit.auth({
      type: 'installation',
      installationId: inst.id,
    })) as { token: string }
    const list = await new Paginate({ auth: token, userAgent: USER_AGENT }).paginate('GET /installation/repositories', {
      per_page: 100,
    })
    repos.push(...list.map((r) => ({ id: r.id, full_name: r.full_name })))
  }
  return repos
}

const installationIdCache = new Map<string, number>()

export async function installationToken(repoFullName: string, repositoryId: number): Promise<string> {
  const [owner, repo] = repoFullName.split('/')
  const app = appOctokit()
  const lookup = async (): Promise<number> => {
    const { data: inst } = await app.request('GET /repos/{owner}/{repo}/installation', {
      owner,
      repo,
      request: { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
    })
    installationIdCache.set(repoFullName, inst.id)
    return inst.id
  }
  const mint = async (id: number): Promise<string> => {
    const { token } = (await app.auth({
      type: 'installation',
      installationId: id,
      repositoryIds: [repositoryId],
    })) as { token: string }
    return token
  }
  const cached = installationIdCache.get(repoFullName)
  try {
    return await mint(cached ?? (await lookup()))
  } catch (err) {
    if (cached === undefined) throw err
    installationIdCache.delete(repoFullName)
    return await mint(await lookup())
  }
}

export async function getAppWebhookUrl(): Promise<string | null> {
  const { token } = (await appOctokit().auth({ type: 'app' })) as { token: string }
  const res = await fetch(`${GH_API}/app/hook/config`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': USER_AGENT,
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!res.ok) return null
  return ((await res.json()) as { url?: string }).url ?? null
}

export async function patchAppWebhook(url: string, secret: string): Promise<void> {
  const { token } = (await appOctokit().auth({ type: 'app' })) as { token: string }
  const res = await fetch(`${GH_API}/app/hook/config`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({ url, secret, content_type: 'json', insecure_ssl: '0' }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`PATCH /app/hook/config → ${res.status} ${await res.text()}`)
}

export interface HookDelivery {
  id: number
  guid: string
  delivered_at: string
  event: string
}

function nextCursor(link: string | undefined): string | undefined {
  if (!link) return undefined
  for (const part of link.split(',')) {
    const m = part.match(/<([^>]+)>;\s*rel="next"/)
    if (m) {
      try {
        return new URL(m[1]).searchParams.get('cursor') ?? undefined
      } catch {
        return undefined
      }
    }
  }
  return undefined
}

// Lists App webhook deliveries newer than `since` (ISO). Deliveries come back
// newest-first; we page until one predates the cutoff, then stop. `guid` is the
// X-GitHub-Delivery value the webhook path dedups on; `id` fetches the payload.
export async function listDeliveriesSince(since: string): Promise<HookDelivery[]> {
  const app = appOctokit()
  const out: HookDelivery[] = []
  let cursor: string | undefined
  for (let page = 0; page < 50; page++) {
    const res = await app.request('GET /app/hook/deliveries', {
      per_page: 100,
      ...(cursor ? { cursor } : {}),
      request: { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
    })
    const batch = res.data as Array<{ id: number; guid: string; delivered_at: string; event: string }>
    if (batch.length === 0) break
    let crossed = false
    for (const d of batch) {
      if (d.delivered_at < since) {
        crossed = true
        break
      }
      out.push({ id: d.id, guid: d.guid, delivered_at: d.delivered_at, event: d.event })
    }
    if (crossed) break
    cursor = nextCursor(res.headers.link)
    if (!cursor) break
  }
  return out
}

// Fetches one delivery's stored request body so it can be re-ingested directly,
// without depending on the tunnel being live (unlike a redelivery attempt).
export async function getDeliveryPayload(id: number): Promise<Record<string, unknown> | null> {
  const res = await appOctokit().request('GET /app/hook/deliveries/{delivery_id}', {
    delivery_id: id,
    request: { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
  })
  let payload = (res.data as { request?: { payload?: unknown } }).request?.payload
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload)
    } catch {
      return null
    }
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null
  return payload as Record<string, unknown>
}

export interface AppManifest {
  name: string
  url: string
  hook_attributes: { url: string; active: boolean }
  redirect_url: string
  public: boolean
  default_permissions: Record<string, string>
  default_events: string[]
}

export function buildManifest(name: string, redirectUrl: string, isPublic: boolean): AppManifest {
  return {
    name,
    url: 'https://github.com/felipelincoln/snaildit',
    hook_attributes: { url: 'https://github.com/felipelincoln/snaildit', active: true },
    redirect_url: redirectUrl,
    public: isPublic,
    default_permissions: {
      pull_requests: 'write',
      issues: 'write',
      contents: 'write',
      workflows: 'write',
      metadata: 'read',
    },
    default_events: [
      'pull_request',
      'pull_request_review',
      'pull_request_review_comment',
      'pull_request_review_thread',
      'issues',
      'issue_comment',
    ],
  }
}

export interface ManifestConversion {
  id: number
  slug: string
  pem: string
  webhook_secret: string
}

export async function exchangeManifestCode(code: string): Promise<ManifestConversion> {
  const res = await fetch(`${GH_API}/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: 'POST',
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`manifest conversion -> ${res.status} ${await res.text()}`)
  return (await res.json()) as ManifestConversion
}

export function writeAppCredentials(conversion: ManifestConversion): void {
  writePem(conversion.pem)
  saveConfig({
    ...loadConfig(),
    github: {
      appId: String(conversion.id),
      slug: conversion.slug,
      webhookSecret: conversion.webhook_secret,
    },
  })
  resetGitHubCaches()
}

export function resetGitHubCaches(): void {
  cached = undefined
  profileCache = null
  healthCache = null
  reposCache = null
  installationIdCache.clear()
}
