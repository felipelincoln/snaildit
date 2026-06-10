import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { paths } from './config.js'
import { processMatches } from './reap.js'

// Two instances against the same config dir would clobber each other's leases,
// JSON files, and webhook URL, and one's reclaimOrphans would re-run the other's
// in-flight jobs. The dashboard port bind catches the default case, but PORT=
// slips past it — so guard explicitly. A stale lock (holder dead, or its PID
// reused by some other program) is taken over rather than blocking startup.
export function acquireInstanceLock(): void {
  let holder: number | null = null
  try {
    holder = Number(readFileSync(paths.lock, 'utf8').trim()) || null
  } catch {}
  if (holder !== null && processMatches(holder, 'cli.js')) {
    throw new Error(
      `another github-ai-bot instance is already running (pid ${holder}). ` +
        `Stop it first, or delete ${paths.lock} if you're sure it's gone.`,
    )
  }
  writeFileSync(paths.lock, String(process.pid))
}

export function releaseInstanceLock(): void {
  try {
    // Only remove it if we still own it, never another instance's lock.
    if (Number(readFileSync(paths.lock, 'utf8').trim()) === process.pid) unlinkSync(paths.lock)
  } catch {}
}
