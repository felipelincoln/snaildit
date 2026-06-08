import { paths, readJsonFile, writeJsonFileAtomic } from './config.js'

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

function load(): Automation[] {
  return readJsonFile<Automation[]>(paths.automations, [])
}

function persist(list: Automation[]): void {
  writeJsonFileAtomic(paths.automations, list)
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

  const list = load()
  if (list.some((a) => a.id === id)) throw new DuplicateAutomationError(id)

  const now = new Date().toISOString()
  const automation: Automation = {
    id,
    name,
    enabled: input.enabled ?? true,
    triggers: validateTriggers(input.triggers),
    trigger_repo_id: validateRepoId(input.trigger_repo_id),
    trigger_repo: validateRepo(input.trigger_repo),
    prompt,
    effort: validateEffort(input.effort),
    created_at: now,
    updated_at: now,
  }
  list.push(automation)
  persist(list)
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
  const list = load()
  const index = list.findIndex((a) => a.id === id)
  if (index === -1) return null

  const current = list[index]
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
      default:
        Object.assign(next, { [key]: patch[key] })
    }
  }

  next.updated_at = new Date().toISOString()
  list[index] = next
  persist(list)
  return next
}

export function deleteAutomation(id: string): boolean {
  const list = load()
  const next = list.filter((a) => a.id !== id)
  if (next.length === list.length) return false
  persist(next)
  return true
}
