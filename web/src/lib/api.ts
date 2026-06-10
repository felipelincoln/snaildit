export type DomainId = 'app' | 'repos' | 'engine'

export interface State {
  onboarded: boolean
  step: DomainId | 'done'
  domains: Record<DomainId, { done: boolean }>
  appSlug: string | null
  engine: string | null
}

export interface Manifest {
  postUrl: string
  manifest: Record<string, unknown>
}

export interface BotProfile {
  slug: string
  name: string
  avatar: string
  url: string
}

export interface EngineMeta {
  id: string
  label: string
  recommended: boolean
  auth: {
    mode: 'login-command' | 'paste-token'
    command: string | null
    placeholder: string | null
    tokenEnvVar: string | null
  }
  warning: { text: string; url: string } | null
  models: string[]
  efforts: string[]
  configured: boolean
}

export interface Repo {
  id: number
  full_name: string
}

export interface Trigger {
  event: string
  actions: string[]
}

export interface Automation {
  id: string
  name: string
  enabled: boolean
  triggers: Trigger[]
  trigger_repo_id: number
  trigger_repo: string
  prompt: string
  effort?: string
  created_at: string
  updated_at: string
}

export interface NewAutomation {
  id: string
  name: string
  prompt: string
  trigger_repo_id: number
  trigger_repo: string
  triggers: Trigger[]
  effort?: string
}

export const EVENT_ACTIONS: Record<string, string[]> = {
  issues: [
    'opened',
    'edited',
    'closed',
    'reopened',
    'assigned',
    'unassigned',
    'labeled',
    'unlabeled',
    'milestoned',
    'demilestoned',
    'pinned',
    'unpinned',
    'locked',
    'unlocked',
    'transferred',
    'deleted',
  ],
  issue_comment: ['created', 'edited', 'deleted'],
  pull_request: [
    'opened',
    'edited',
    'closed',
    'reopened',
    'synchronize',
    'ready_for_review',
    'converted_to_draft',
    'assigned',
    'unassigned',
    'review_requested',
    'review_request_removed',
    'labeled',
    'unlabeled',
    'locked',
    'unlocked',
    'auto_merge_enabled',
    'auto_merge_disabled',
    'enqueued',
    'dequeued',
    'milestoned',
    'demilestoned',
  ],
  pull_request_review: ['submitted', 'edited', 'dismissed'],
  pull_request_review_comment: ['created', 'edited', 'deleted'],
  pull_request_review_thread: ['resolved', 'unresolved'],
}
export const EVENT_TYPES = Object.keys(EVENT_ACTIONS)

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init)
  const data = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new Error(data.error ?? `${res.status} ${res.statusText}`)
  return data
}

function getJson<T>(path: string): Promise<T> {
  return request<T>(path)
}

function sendJson<T>(method: string, path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

export function getState(): Promise<State> {
  return getJson<State>('/api/state')
}

export function getBot(): Promise<{ bot: BotProfile | null }> {
  return getJson<{ bot: BotProfile | null }>('/api/bot')
}

export function getManifest(isPublic: boolean): Promise<Manifest> {
  return getJson<Manifest>(`/api/setup/app/manifest?public=${isPublic}`)
}

export function getRepos(): Promise<{ repos: Repo[] }> {
  return getJson<{ repos: Repo[] }>('/api/repos')
}

export interface Run {
  id: number
  automation_id: string
  name: string | null
  repository_id: number
  number: number
  repo_full_name: string | null
  type: 'issue' | 'pull_request' | null
  status: 'running' | 'ok' | 'failed'
  action: string | null
  event: string | null
  effort: string | null
  result: string | null
  session_id: string | null
  tokens: number | null
  url: string | null
  resume_command: string | null
  started_at: string
  finished_at: string | null
}

export interface DayActivity {
  day: string
  count: number
  ok: number
  failed: number
  tokens: number
}

export interface Queued {
  automation_id: string
  name: string | null
  repository_id: number
  number: number
  repo_full_name: string | null
  last_event_at: string
}

export function getRuns(limit = 20): Promise<{ runs: Run[]; queued: Queued[] }> {
  return getJson<{ runs: Run[]; queued: Queued[] }>(`/api/runs?limit=${limit}`)
}

export function getActivity(): Promise<{ days: DayActivity[] }> {
  return getJson<{ days: DayActivity[] }>('/api/activity')
}

export function getEngines(): Promise<{ engines: EngineMeta[] }> {
  return getJson<{ engines: EngineMeta[] }>('/api/engines')
}

export function setEngine(id: string): Promise<{ ok: boolean }> {
  return sendJson<{ ok: boolean }>('POST', '/api/setup/engine', { engine: id })
}

export function recheckEngine(): Promise<{ configured: boolean }> {
  return sendJson<{ configured: boolean }>('POST', '/api/setup/recheck', {})
}

export function getAutomations(): Promise<{ automations: Automation[] }> {
  return getJson<{ automations: Automation[] }>('/api/automations')
}

export function createAutomation(input: NewAutomation): Promise<Automation> {
  return sendJson<Automation>('POST', '/api/automations', input)
}

export type AutomationUpdate = Partial<{
  name: string
  prompt: string
  trigger_repo_id: number
  trigger_repo: string
  triggers: Trigger[]
  effort: string
  enabled: boolean
}>

export function updateAutomation(id: string, patch: AutomationUpdate): Promise<Automation> {
  return sendJson<Automation>('PATCH', `/api/automations/${encodeURIComponent(id)}`, patch)
}

export function deleteAutomation(id: string): Promise<{ ok: boolean }> {
  return sendJson<{ ok: boolean }>('DELETE', `/api/automations/${encodeURIComponent(id)}`)
}
