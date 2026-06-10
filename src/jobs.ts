import { randomUUID } from 'node:crypto'
import { openDb } from './deliveries.js'

export const MAX_ATTEMPTS = 2

export interface LeasedJob {
  automation_id: string
  repository_id: number
  number: number
  repo_full_name: string
  type: 'issue' | 'pull_request'
  attempts: number
  lease_token: string
}

function nowIso(): string {
  return new Date().toISOString()
}

export function reclaimOrphans(): { jobs: number; runs: number } {
  const handle = openDb()
  handle.exec('BEGIN IMMEDIATE')
  try {
    const jobs = handle
      .prepare(
        `UPDATE jobs SET status = 'queued', lease_until = NULL, lease_token = NULL, last_error = 'interrupted (restart)' WHERE status = 'leased'`,
      )
      .run()
    const runs = handle
      .prepare(
        `UPDATE runs SET status = 'failed', result = 'interrupted (restart)', finished_at = ? WHERE status = 'running'`,
      )
      .run(nowIso())
    handle.exec('COMMIT')
    return { jobs: Number(jobs.changes), runs: Number(runs.changes) }
  } catch (err) {
    try {
      handle.exec('ROLLBACK')
    } catch {}
    throw err
  }
}

export function leaseNext(leaseMs: number): LeasedJob | null {
  const handle = openDb()
  handle.exec('BEGIN IMMEDIATE')
  try {
    const row = handle
      .prepare(
        `SELECT automation_id, repository_id, number, repo_full_name, type, attempts FROM jobs
          WHERE status = 'queued' OR (status = 'leased' AND lease_until < ?)
          ORDER BY last_event_at ASC LIMIT 1`,
      )
      .get(nowIso()) as (Omit<LeasedJob, 'attempts'> & { attempts: number }) | undefined
    if (!row) {
      handle.exec('COMMIT')
      return null
    }
    const leaseUntil = new Date(Date.now() + leaseMs).toISOString()
    const leaseToken = randomUUID()
    handle
      .prepare(
        `UPDATE jobs SET status = 'leased', lease_until = ?, lease_token = ?, attempts = attempts + 1, dirty = 0
          WHERE automation_id = ? AND repository_id = ? AND number = ?`,
      )
      .run(leaseUntil, leaseToken, row.automation_id, row.repository_id, row.number)
    handle.exec('COMMIT')
    return { ...row, attempts: row.attempts + 1, lease_token: leaseToken }
  } catch (err) {
    try {
      handle.exec('ROLLBACK')
    } catch {}
    throw err
  }
}

export function ack(job: LeasedJob): void {
  const handle = openDb()
  handle.exec('BEGIN IMMEDIATE')
  try {
    const row = handle
      .prepare(
        `SELECT dirty FROM jobs WHERE automation_id = ? AND repository_id = ? AND number = ? AND status = 'leased' AND lease_token = ?`,
      )
      .get(job.automation_id, job.repository_id, job.number, job.lease_token) as { dirty: number } | undefined
    if (row) {
      const next = row.dirty ? 'queued' : 'done'
      handle
        .prepare(
          `UPDATE jobs SET status = ?, dirty = 0, attempts = 0, lease_until = NULL, lease_token = NULL, last_error = NULL
            WHERE automation_id = ? AND repository_id = ? AND number = ?`,
        )
        .run(next, job.automation_id, job.repository_id, job.number)
    }
    handle.exec('COMMIT')
  } catch (err) {
    try {
      handle.exec('ROLLBACK')
    } catch {}
    throw err
  }
}

export function fail(job: LeasedJob, reason: string | null): void {
  const handle = openDb()
  handle.exec('BEGIN IMMEDIATE')
  try {
    const row = handle
      .prepare(
        `SELECT attempts, dirty FROM jobs WHERE automation_id = ? AND repository_id = ? AND number = ? AND status = 'leased' AND lease_token = ?`,
      )
      .get(job.automation_id, job.repository_id, job.number, job.lease_token) as
      | { attempts: number; dirty: number }
      | undefined
    if (row) {
      const requeue = row.dirty === 1 || row.attempts < MAX_ATTEMPTS
      const next = requeue ? 'queued' : 'failed'
      const attempts = row.dirty === 1 ? 0 : row.attempts
      handle
        .prepare(
          `UPDATE jobs SET status = ?, dirty = 0, attempts = ?, lease_until = NULL, lease_token = NULL, last_error = ?
            WHERE automation_id = ? AND repository_id = ? AND number = ?`,
        )
        .run(next, attempts, reason, job.automation_id, job.repository_id, job.number)
    }
    handle.exec('COMMIT')
  } catch (err) {
    try {
      handle.exec('ROLLBACK')
    } catch {}
    throw err
  }
}

export function dropJob(job: LeasedJob, reason: string): void {
  openDb()
    .prepare(
      `UPDATE jobs SET status = 'done', dirty = 0, lease_until = NULL, lease_token = NULL, last_error = ?
        WHERE automation_id = ? AND repository_id = ? AND number = ? AND status = 'leased' AND lease_token = ?`,
    )
    .run(reason, job.automation_id, job.repository_id, job.number, job.lease_token)
}

export function getSession(automationId: string, repositoryId: number, number: number): string | null {
  const row = openDb()
    .prepare('SELECT session_id FROM jobs WHERE automation_id = ? AND repository_id = ? AND number = ?')
    .get(automationId, repositoryId, number) as { session_id: string | null } | undefined
  return row?.session_id ?? null
}

// Lease-token CAS like ack/fail, so a stale worker whose lease was reclaimed
// can't clobber the session recorded by the re-leased run. NULL clears a
// session the engine found dead.
export function setSession(job: LeasedJob, sessionId: string | null): void {
  openDb()
    .prepare(
      `UPDATE jobs SET session_id = ?
        WHERE automation_id = ? AND repository_id = ? AND number = ? AND status = 'leased' AND lease_token = ?`,
    )
    .run(sessionId, job.automation_id, job.repository_id, job.number, job.lease_token)
}

export function deleteJobsFor(automationId: string): number {
  const result = openDb().prepare('DELETE FROM jobs WHERE automation_id = ?').run(automationId)
  return Number(result.changes)
}

export function startRun(job: LeasedJob, action: string | null, event: string | null, effort: string | null): number {
  const result = openDb()
    .prepare(
      `INSERT INTO runs (automation_id, repository_id, number, status, action, event, effort, started_at)
       VALUES (?, ?, ?, 'running', ?, ?, ?, ?)`,
    )
    .run(job.automation_id, job.repository_id, job.number, action, event, effort, nowIso())
  return Number(result.lastInsertRowid)
}

export function finishRun(
  id: number,
  status: 'ok' | 'failed',
  result: string | null,
  tokens: number | null = null,
  sessionId: string | null = null,
): void {
  openDb()
    .prepare(
      `UPDATE runs SET status = ?, result = ?, tokens = ?, session_id = ?, finished_at = ? WHERE id = ? AND status = 'running'`,
    )
    .run(status, result, tokens, sessionId, nowIso(), id)
}

export interface RecentRun {
  id: number
  automation_id: string
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
  started_at: string
  finished_at: string | null
}

export function listRecentRuns(limit: number): RecentRun[] {
  return openDb()
    .prepare(
      `SELECT r.id, r.automation_id, r.repository_id, r.number, w.repo_full_name, w.type,
              r.status, r.action, r.event, r.effort, r.result, r.session_id, r.tokens, r.started_at, r.finished_at
         FROM runs r
         LEFT JOIN work_items w ON w.repository_id = r.repository_id AND w.number = r.number
        ORDER BY r.id DESC
        LIMIT ?`,
    )
    .all(limit) as unknown as RecentRun[]
}

export interface DayActivity {
  day: string
  count: number
  ok: number
  failed: number
  tokens: number
}

export function dailyRunCounts(days: number): DayActivity[] {
  // Compute the cutoff (local midnight `days` ago) in JS and compare raw
  // started_at strings, so the polled query hits idx_runs_started instead of
  // full-scanning runs through date(started_at, 'localtime') on every row.
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - days)
  cutoff.setHours(0, 0, 0, 0)
  return openDb()
    .prepare(
      `SELECT date(started_at, 'localtime') AS day,
              COUNT(*) AS count,
              SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
              COALESCE(SUM(tokens), 0) AS tokens
         FROM runs
        WHERE started_at >= ?
        GROUP BY day
        ORDER BY day`,
    )
    .all(cutoff.toISOString()) as unknown as DayActivity[]
}

export interface QueuedJob {
  automation_id: string
  repository_id: number
  number: number
  repo_full_name: string | null
  last_event_at: string
}

export function listQueuedJobs(): QueuedJob[] {
  return openDb()
    .prepare(
      `SELECT j.automation_id, j.repository_id, j.number, w.repo_full_name, j.last_event_at
         FROM jobs j
         LEFT JOIN work_items w ON w.repository_id = j.repository_id AND w.number = j.number
        WHERE j.status = 'queued'
        ORDER BY j.last_event_at ASC`,
    )
    .all() as unknown as QueuedJob[]
}

export function lastSuccessfulRunStartedAt(automationId: string, repositoryId: number, number: number): string | null {
  const row = openDb()
    .prepare(
      `SELECT MAX(started_at) AS at FROM runs WHERE automation_id = ? AND repository_id = ? AND number = ? AND status = 'ok'`,
    )
    .get(automationId, repositoryId, number) as { at: string | null } | undefined
  return row?.at ?? null
}
