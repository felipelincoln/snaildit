import type { Automation } from './automations.js'

export interface RunContext {
  repository_id: number
  repo: string
  number: number
  type: 'issue' | 'pull_request'
  url: string
  action: string | null
  event: string | null
  updates: string[]
}

export interface RunResult {
  ok: boolean
  result: string | null
  tokens?: number | null
  // string: persist as the resumable session; null: clear a session the
  // engine found dead; undefined: leave the stored session untouched.
  sessionId?: string | null
}

export interface Runtime {
  ready?(): boolean
  run(automation: Automation, ctx: RunContext, signal: AbortSignal): Promise<RunResult>
}
