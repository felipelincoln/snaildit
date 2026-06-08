import { renameSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import type { Trigger } from './automations.js'
import { ensureConfigDir, paths } from './config.js'
import type { Extracted } from './extract.js'
import { log } from './log.js'
import { matchAutomations } from './match.js'

let db: DatabaseSync | null = null

function init(handle: DatabaseSync): void {
  handle.exec('PRAGMA busy_timeout = 5000')
  handle.exec('PRAGMA journal_mode = WAL')
  handle.exec(`
    CREATE TABLE IF NOT EXISTS deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      delivery_id TEXT NOT NULL UNIQUE,
      repository_id INTEGER NOT NULL,
      repo_full_name TEXT NOT NULL,
      number INTEGER NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('issue', 'pull_request')),
      event_type TEXT NOT NULL,
      action TEXT NOT NULL,
      url TEXT,
      received_at TEXT NOT NULL
    )
  `)
  handle.exec('CREATE INDEX IF NOT EXISTS idx_deliveries_received ON deliveries (received_at)')
  handle.exec('CREATE INDEX IF NOT EXISTS idx_deliveries_work_item ON deliveries (repository_id, number, received_at)')
  handle.exec(`
    CREATE TABLE IF NOT EXISTS work_items (
      repository_id INTEGER NOT NULL,
      number INTEGER NOT NULL,
      repo_full_name TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('issue', 'pull_request')),
      last_event_at TEXT NOT NULL,
      PRIMARY KEY (repository_id, number)
    )
  `)
  handle.exec('CREATE INDEX IF NOT EXISTS idx_work_items_last_event ON work_items (last_event_at)')
  handle.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      automation_id TEXT NOT NULL,
      repository_id INTEGER NOT NULL,
      number INTEGER NOT NULL,
      repo_full_name TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('issue', 'pull_request')),
      status TEXT NOT NULL CHECK (status IN ('queued', 'leased', 'done', 'failed')),
      dirty INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,
      lease_until TEXT,
      lease_token TEXT,
      session_id TEXT,
      last_error TEXT,
      last_event_at TEXT NOT NULL,
      PRIMARY KEY (automation_id, repository_id, number)
    )
  `)
  handle.exec('CREATE INDEX IF NOT EXISTS idx_jobs_leasable ON jobs (status, last_event_at)')
  handle.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      automation_id TEXT NOT NULL,
      repository_id INTEGER NOT NULL,
      number INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('running', 'ok', 'failed')),
      action TEXT,
      effort TEXT,
      result TEXT,
      session_id TEXT,
      tokens INTEGER,
      started_at TEXT NOT NULL,
      finished_at TEXT
    )
  `)
  handle.exec('CREATE INDEX IF NOT EXISTS idx_runs_work_item ON runs (automation_id, repository_id, number, id)')
}

function enqueueJobs(handle: DatabaseSync, e: Extracted, receivedAt: string): number {
  const matches = matchAutomations(e)
  if (matches.length === 0) return 0
  const stmt = handle.prepare(
    `INSERT INTO jobs
       (automation_id, repository_id, number, repo_full_name, type, status, dirty, attempts, last_event_at)
     VALUES (?, ?, ?, ?, ?, 'queued', 0, 0, ?)
     ON CONFLICT (automation_id, repository_id, number) DO UPDATE SET
       status         = CASE WHEN jobs.status = 'leased' THEN 'leased' ELSE 'queued' END,
       dirty          = CASE WHEN jobs.status = 'leased' THEN 1 ELSE jobs.dirty END,
       attempts       = CASE WHEN jobs.status = 'leased' THEN jobs.attempts ELSE 0 END,
       last_error     = CASE WHEN jobs.status = 'leased' THEN jobs.last_error ELSE NULL END,
       repo_full_name = excluded.repo_full_name,
       type           = excluded.type,
       last_event_at  = MAX(jobs.last_event_at, excluded.last_event_at)`,
  )
  for (const a of matches) {
    stmt.run(a.id, e.repository_id, e.number, e.repo, e.type, receivedAt)
  }
  return matches.length
}

const SQLITE_CORRUPT = 11
const SQLITE_NOTADB = 26

function isCorruption(err: unknown): boolean {
  const e = err as { errcode?: number; message?: string }
  if (e.errcode === SQLITE_CORRUPT || e.errcode === SQLITE_NOTADB) return true
  const msg = (e.message ?? '').toLowerCase()
  return msg.includes('malformed') || msg.includes('not a database') || msg.includes('file is encrypted')
}

function quarantine(): void {
  const stamp = `${Date.now()}-${process.pid}`
  let renamed = false
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      renameSync(`${paths.db}${suffix}`, `${paths.db}${suffix}.corrupt-${stamp}`)
      if (suffix === '') renamed = true
    } catch {}
  }
  if (renamed) log('storage', `corrupt database reset: ${paths.db} (renamed to .corrupt-${stamp})`)
  else log('storage', `corrupt database reset failed: could not rename ${paths.db}`)
}

export function openDb(): DatabaseSync {
  if (db) return db
  ensureConfigDir()
  let handle = new DatabaseSync(paths.db)
  try {
    init(handle)
  } catch (err) {
    try {
      handle.close()
    } catch {}
    if (!isCorruption(err)) {
      log('storage', `database init failed: ${(err as Error).message}`)
      throw err
    }
    quarantine()
    handle = new DatabaseSync(paths.db)
    init(handle)
  }
  db = handle
  return handle
}

export interface MatchingDelivery {
  event_type: string
  action: string
  received_at: string
}

export function matchingDeliveries(repositoryId: number, number: number, triggers: Trigger[]): MatchingDelivery[] {
  if (triggers.length === 0) return []
  const rows = openDb()
    .prepare(
      `SELECT event_type, action, received_at FROM deliveries
        WHERE repository_id = ? AND number = ?
        ORDER BY received_at DESC`,
    )
    .all(repositoryId, number) as unknown as MatchingDelivery[]
  return rows.filter((d) => triggers.some((t) => t.event === d.event_type && t.actions.includes(d.action)))
}

export function ingestDelivery(deliveryId: string, e: Extracted, receivedAt: string): boolean {
  const handle = openDb()
  handle.exec('BEGIN IMMEDIATE')
  try {
    const result = handle
      .prepare(
        `INSERT OR IGNORE INTO deliveries
          (delivery_id, repository_id, repo_full_name, number, type, event_type, action, url, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(deliveryId, e.repository_id, e.repo, e.number, e.type, e.event_type, e.action, e.url, receivedAt)
    const inserted = Number(result.changes) > 0
    if (inserted) {
      handle
        .prepare(
          `INSERT INTO work_items (repository_id, number, repo_full_name, type, last_event_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (repository_id, number) DO UPDATE SET
             repo_full_name = excluded.repo_full_name,
             type = excluded.type,
             last_event_at = excluded.last_event_at
           WHERE excluded.last_event_at >= work_items.last_event_at`,
        )
        .run(e.repository_id, e.number, e.repo, e.type, receivedAt)
      enqueueJobs(handle, e, receivedAt)
    }
    handle.exec('COMMIT')
    return inserted
  } catch (err) {
    try {
      handle.exec('ROLLBACK')
    } catch {}
    throw err
  }
}
