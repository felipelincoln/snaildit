import type { Automation } from './automations.js'
import { getAutomation } from './automations.js'
import { loadConfig } from './config.js'
import { matchingDeliveries } from './deliveries.js'
import type { RunContext, Runtime } from './runtime.js'
import {
  type LeasedJob,
  ack,
  dropJob,
  fail,
  finishRun,
  lastSuccessfulRunStartedAt,
  leaseNext,
  reclaimOrphans,
  startRun,
} from './jobs.js'
import { log } from './log.js'

const DEFAULT_CONCURRENCY = 4
const ENGINE_TIMEOUT_MS = 30 * 60_000
const LEASE_MS = ENGINE_TIMEOUT_MS + 5 * 60_000
const SWEEP_MS = 10_000

function concurrency(): number {
  const n = loadConfig().workers
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : DEFAULT_CONCURRENCY
}

let running = false
let poolEpoch = 0
let stopper: AbortController | null = null
let sweepTimer: ReturnType<typeof setInterval> | null = null
let loops: Promise<void>[] = []
let wakePending = false
let waiters: Array<() => void> = []

function waitForWake(): Promise<void> {
  if (wakePending) {
    wakePending = false
    return Promise.resolve()
  }
  return new Promise<void>((resolve) => {
    waiters.push(resolve)
  })
}

export function wakeWorkers(): void {
  if (!running) return
  if (waiters.length === 0) {
    wakePending = true
    return
  }
  const current = waiters
  waiters = []
  for (const resolve of current) resolve()
}

function runContext(job: LeasedJob, automation: Automation): RunContext {
  const url = `https://github.com/${job.repo_full_name}/${job.type === 'pull_request' ? 'pull' : 'issues'}/${job.number}`
  const base = { repository_id: job.repository_id, repo: job.repo_full_name, number: job.number, type: job.type, url }
  const matching = matchingDeliveries(job.repository_id, job.number, automation.triggers)
  if (matching.length === 0) return { ...base, action: null, updates: [] }
  const since = lastSuccessfulRunStartedAt(automation.id, job.repository_id, job.number)
  const windowed = since ? matching.filter((d) => d.received_at > since) : matching
  const source = windowed.length > 0 ? windowed : [matching[0]]
  const seen = new Set<string>()
  const updates: string[] = []
  for (const d of source) {
    const key = `${d.event_type}.${d.action}`
    if (!seen.has(key)) {
      seen.add(key)
      updates.push(key)
    }
  }
  return { ...base, action: matching[0].action, updates }
}

async function workerLoop(engine: Runtime): Promise<void> {
  while (running) {
    const myEpoch = poolEpoch
    if (engine.ready && !engine.ready()) {
      await waitForWake()
      continue
    }
    let job: LeasedJob | null
    try {
      job = leaseNext(LEASE_MS)
    } catch (err) {
      log('pool', `lease error: ${(err as Error).message}`)
      await waitForWake()
      continue
    }
    if (!job) {
      await waitForWake()
      continue
    }
    const automation = getAutomation(job.automation_id)
    if (!automation?.enabled) {
      dropJob(job, 'automation gone or disabled')
      continue
    }
    const ctx = runContext(job, automation)
    if (ctx.updates.length === 0) {
      dropJob(job, 'trigger changed; no stored delivery matches anymore')
      log('pool', `dropped ${job.automation_id} ${job.repo_full_name}#${job.number} (trigger no longer matches)`)
      continue
    }
    const runId = startRun(job, ctx.action, automation.effort ?? null)
    const signal = AbortSignal.any([stopper!.signal, AbortSignal.timeout(ENGINE_TIMEOUT_MS)])
    let ok = false
    let result: string | null = null
    let tokens: number | null = null
    let sessionId: string | null = null
    try {
      const res = await engine.run(automation, ctx, signal)
      ok = res.ok
      result = res.result
      tokens = res.tokens ?? null
      sessionId = res.sessionId ?? null
    } catch (err) {
      result = (err as Error).message
    }
    if (!running || poolEpoch !== myEpoch) {
      finishRun(runId, 'failed', 'interrupted')
      break
    }
    finishRun(runId, ok ? 'ok' : 'failed', result, tokens, sessionId)
    if (ok) ack(job)
    else fail(job, result)
    log('pool', `${ok ? 'ran' : 'failed'} ${job.automation_id} ${job.repo_full_name}#${job.number}`)
  }
}

export function startWorkerPool(engine: Runtime): void {
  if (running) return
  running = true
  poolEpoch++
  stopper = new AbortController()
  wakePending = false
  waiters = []
  const reclaimed = reclaimOrphans()
  if (reclaimed.jobs > 0) log('pool', `reclaimed ${reclaimed.jobs} orphaned job(s) on start`)
  const n = concurrency()
  const myEpoch = poolEpoch
  loops = Array.from({ length: n }, () => workerLoop(engine))
  sweepTimer = setInterval(() => {
    if (running && poolEpoch === myEpoch) wakeWorkers()
  }, SWEEP_MS)
  sweepTimer.unref()
  log('pool', `started with ${n} workers`)
}

export async function stopWorkerPool(): Promise<void> {
  if (!running) return
  running = false
  poolEpoch++
  if (sweepTimer) {
    clearInterval(sweepTimer)
    sweepTimer = null
  }
  stopper?.abort()
  const current = waiters
  waiters = []
  for (const resolve of current) resolve()
  await Promise.all(loops)
  loops = []
  stopper = null
}
