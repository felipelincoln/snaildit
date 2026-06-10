import { paths, readJsonFile, writeJsonFileAtomic } from './config.js'
import { log } from './log.js'

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
  enabled?: boolean
}

export class DuplicateAutomationError extends Error {
  readonly id: string
  constructor(id: string) {
    super(`an automation with id "${id}" already exists`)
    this.name = 'DuplicateAutomationError'
    this.id = id
  }
}

const EVENT_RE = /^[a-z][a-z_]*$/
const ACTION_RE = /^[a-z][a-z_]*$/
const EFFORT_RE = /^[a-z][a-z_]*$/
const REPO_PART_RE = /^[A-Za-z0-9._-]+$/

export function validateText(value: string | null | undefined, field: string): string {
  const text = (value ?? '').trim()
  if (!text) throw new Error(`automation ${field} must not be blank`)
  return text
}

export function validateRepo(repo: string | null | undefined): string {
  const value = (repo ?? '').trim()
  const [owner, name, ...rest] = value.split('/')
  if (!owner || !name || rest.length > 0 || !REPO_PART_RE.test(owner) || !REPO_PART_RE.test(name)) {
    throw new Error('trigger_repo must be in "owner/repo" form')
  }
  return value
}

export function validateRepoId(id: number | null | undefined): number {
  if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
    throw new Error('trigger_repo_id must be a positive integer')
  }
  return id
}

export function validateEvent(event: string | null | undefined): string {
  const value = (event ?? '').trim()
  if (!value) throw new Error('trigger event must be set')
  if (!EVENT_RE.test(value)) throw new Error(`invalid trigger event: "${value}"`)
  return value
}

export function validateActions(actions: string[] | null | undefined): string[] {
  const list = actions ?? []
  if (list.length === 0) throw new Error('automation must have at least one trigger action')
  for (const action of list) {
    if (!ACTION_RE.test(action)) throw new Error(`invalid trigger action: "${action}"`)
  }
  return list
}

export function validateTriggers(triggers: Trigger[] | null | undefined): Trigger[] {
  const list = triggers ?? []
  if (list.length === 0) throw new Error('automation must have at least one trigger')
  // Merge duplicate events so a single delivery never matches the same automation twice.
  const byEvent = new Map<string, Set<string>>()
  for (const t of list) {
    const event = validateEvent(t?.event)
    const set = byEvent.get(event) ?? new Set<string>()
    for (const action of validateActions(t?.actions)) set.add(action)
    byEvent.set(event, set)
  }
  return [...byEvent].map(([event, actions]) => ({ event, actions: [...actions] }))
}

export function validateEffort(effort: string | null | undefined): string | undefined {
  const value = (effort ?? '').trim()
  if (!value) return undefined
  if (!EFFORT_RE.test(value)) throw new Error(`invalid effort: "${value}"`)
  return value
}

function isAutomationShape(value: unknown): value is Automation {
  if (value === null || typeof value !== 'object') return false
  const a = value as Record<string, unknown>
  return (
    typeof a.id === 'string' &&
    typeof a.trigger_repo_id === 'number' &&
    Array.isArray(a.triggers) &&
    a.triggers.length > 0 &&
    a.triggers.every(
      (t) =>
        t !== null &&
        typeof t === 'object' &&
        typeof (t as Trigger).event === 'string' &&
        Array.isArray((t as Trigger).actions),
    )
  )
}

function loadRaw(): unknown[] {
  const raw = readJsonFile<unknown>(paths.automations, [])
  if (!Array.isArray(raw)) {
    log('automations', 'automations.json is not an array — ignoring')
    return []
  }
  return raw
}

function load(): Automation[] {
  const raw = loadRaw()
  const valid = raw.filter(isAutomationShape)
  const dropped = raw.length - valid.length
  if (dropped > 0) log('automations', `ignored ${dropped} invalid/legacy automation entr${dropped === 1 ? 'y' : 'ies'}`)
  return valid
}

// Mutations operate on the raw array and touch only the targeted entry, so
// entries this version doesn't recognize (future schema, hand edits) survive
// saves instead of being silently destroyed by the shape filter above.
function persist(list: unknown[]): void {
  writeJsonFileAtomic(paths.automations, list)
}

function entryId(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return null
  const id = (value as Record<string, unknown>).id
  return typeof id === 'string' ? id : null
}

export function listAutomations(): Automation[] {
  return load()
}

export function getAutomation(id: string): Automation | null {
  return load().find((a) => a.id === id) ?? null
}

export function createAutomation(input: NewAutomation): Automation {
  const id = validateText(input.id, 'id')
  const name = validateText(input.name, 'name')
  const prompt = validateText(input.prompt, 'prompt')

  const raw = loadRaw()
  if (raw.some((e) => entryId(e) === id)) throw new DuplicateAutomationError(id)

  const now = new Date().toISOString()
  const automation: Automation = {
    id,
    name,
    enabled: input.enabled === undefined ? true : input.enabled === true,
    triggers: validateTriggers(input.triggers),
    trigger_repo_id: validateRepoId(input.trigger_repo_id),
    trigger_repo: validateRepo(input.trigger_repo),
    prompt,
    effort: validateEffort(input.effort),
    created_at: now,
    updated_at: now,
  }
  raw.push(automation)
  persist(raw)
  return automation
}

const EDITABLE = [
  'name',
  'enabled',
  'triggers',
  'trigger_repo_id',
  'trigger_repo',
  'prompt',
  'effort',
] as const satisfies readonly (keyof Automation)[]

type EditableField = (typeof EDITABLE)[number]
export type AutomationPatch = Partial<Pick<Automation, EditableField>>

export function updateAutomation(id: string, patch: AutomationPatch): Automation | null {
  const raw = loadRaw()
  const index = raw.findIndex((e) => isAutomationShape(e) && e.id === id)
  if (index === -1) return null

  const current = raw[index] as Automation
  const next: Automation = { ...current }

  for (const key of EDITABLE) {
    if (!(key in patch)) continue
    switch (key) {
      case 'name':
        next.name = validateText(patch.name, 'name')
        break
      case 'prompt':
        next.prompt = validateText(patch.prompt, 'prompt')
        break
      case 'triggers':
        next.triggers = validateTriggers(patch.triggers)
        break
      case 'trigger_repo_id':
        next.trigger_repo_id = validateRepoId(patch.trigger_repo_id)
        break
      case 'trigger_repo':
        next.trigger_repo = validateRepo(patch.trigger_repo)
        break
      case 'effort':
        next.effort = validateEffort(patch.effort)
        break
      case 'enabled':
        next.enabled = patch.enabled === true
        break
      default:
        Object.assign(next, { [key]: patch[key] })
    }
  }

  next.updated_at = new Date().toISOString()
  raw[index] = next
  persist(raw)
  return next
}

export function deleteAutomation(id: string): boolean {
  const raw = loadRaw()
  const next = raw.filter((e) => !(isAutomationShape(e) && e.id === id))
  if (next.length === raw.length) return false
  persist(next)
  return true
}
