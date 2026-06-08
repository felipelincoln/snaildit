import { type Automation, listAutomations } from './automations.js'
import type { Extracted } from './extract.js'

export function matchAutomations(e: Extracted): Automation[] {
  return listAutomations().filter(
    (a) =>
      a.enabled &&
      a.trigger_repo_id === e.repository_id &&
      a.triggers.some((t) => t.event === e.event_type && t.actions.includes(e.action)),
  )
}
