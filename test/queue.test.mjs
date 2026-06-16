import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

// config.ts reads the config dir at module load, so set it before importing.
process.env.SNAILDIT_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'gab-test-queue-'))
const { ensureConfigDir, paths } = await import('../dist/config.js')
const { ingestDelivery, openDb } = await import('../dist/deliveries.js')
const { MAX_ATTEMPTS, ack, deleteJobsFor, fail, getSession, leaseNext, reclaimOrphans, setJobPid, setSession } =
  await import('../dist/jobs.js')
ensureConfigDir()

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
async function waitDead(pid, ms = 2000) {
  const t = Date.now()
  while (Date.now() - t < ms) {
    if (!alive(pid)) return true
    await wait(50)
  }
  return !alive(pid)
}

const auto = (id, repoId) => ({
  id,
  name: id,
  enabled: true,
  triggers: [{ event: 'issues', actions: ['opened'] }],
  trigger_repo_id: repoId,
  trigger_repo: 'o/r',
  prompt: 'x',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
})
writeFileSync(paths.automations, JSON.stringify([1, 2, 3, 4, 5, 6].map((n) => auto(`a${n}`, n))))
const ev = (repoId, num) => ({
  repository_id: repoId,
  repo: 'o/r',
  number: num,
  type: 'issue',
  event_type: 'issues',
  action: 'opened',
  url: null,
})
const status = (id) => openDb().prepare('SELECT status FROM jobs WHERE automation_id=?').get(id)?.status
// leaseNext picks the oldest queued job, so each test drains its own to a
// terminal state to keep the next leaseNext unambiguous.
const drain = (id) => {
  const job = leaseNext(60_000)
  assert.equal(job.automation_id, id, `expected to lease ${id}`)
  ack(job)
}

test('ingest matches an automation and queues a job; lease + ack -> done', () => {
  assert.deepEqual(ingestDelivery('d1', ev(1, 1), new Date().toISOString()), { inserted: true, matched: 1 })
  assert.equal(status('a1'), 'queued')
  const job = leaseNext(60_000)
  assert.equal(job.automation_id, 'a1')
  ack(job)
  assert.equal(status('a1'), 'done')
})

test('redeliver (same delivery id) dedups but re-enqueues the done job', () => {
  assert.deepEqual(ingestDelivery('d1', ev(1, 1), new Date().toISOString()), { inserted: false, matched: 1 })
  assert.equal(status('a1'), 'queued')
  drain('a1') // back to a terminal state for the next test
})

test('fail requeues until MAX_ATTEMPTS, then marks the job failed', () => {
  ingestDelivery('d2', ev(2, 2), new Date().toISOString())
  const first = leaseNext(60_000) // attempts -> 1
  assert.equal(first.automation_id, 'a2')
  fail(first, 'boom')
  assert.equal(status('a2'), 'queued', `requeued while attempts (1) < MAX (${MAX_ATTEMPTS})`)
  const second = leaseNext(60_000) // attempts -> 2
  fail(second, 'boom again')
  assert.equal(status('a2'), 'failed', 'no retries left -> failed')
})

test('an event arriving while leased sets dirty, and ack then requeues', () => {
  ingestDelivery('d3', ev(3, 3), new Date().toISOString())
  const job = leaseNext(60_000)
  assert.equal(job.automation_id, 'a3')
  // New event for the same work item while the job is leased -> dirty.
  assert.deepEqual(ingestDelivery('d3b', ev(3, 3), new Date().toISOString()), { inserted: true, matched: 1 })
  assert.equal(status('a3'), 'leased', 'stays leased, not stolen')
  ack(job)
  assert.equal(status('a3'), 'queued', 'dirty ack requeues instead of marking done')
  drain('a3')
})

test('setSession is lease-token guarded; null clears', () => {
  ingestDelivery('d4', ev(4, 4), new Date().toISOString())
  const job = leaseNext(60_000)
  setSession(job, 'sess-1')
  assert.equal(getSession('a4', 4, 4), 'sess-1')
  setSession({ ...job, lease_token: 'wrong' }, 'clobber')
  assert.equal(getSession('a4', 4, 4), 'sess-1', 'stale token cannot clobber')
  setSession(job, null)
  assert.equal(getSession('a4', 4, 4), null, 'null clears the session')
  ack(job)
})

test('reclaimOrphans requeues a leased job; deleteJobsFor removes it', () => {
  ingestDelivery('d5', ev(5, 5), new Date().toISOString())
  leaseNext(60_000)
  assert.equal(status('a5'), 'leased')
  const r = reclaimOrphans()
  assert.equal(r.killed, 0, 'no pid recorded -> nothing to kill')
  assert.equal(status('a5'), 'queued', 'leased job reclaimed to queued')
  assert.equal(deleteJobsFor('a5'), 1)
  assert.equal(status('a5'), undefined, 'job row gone')
})

test('reclaimOrphans reaps a recorded live engine pid before requeuing', async () => {
  ingestDelivery('d6', ev(6, 6), new Date().toISOString())
  const job = leaseNext(60_000)
  assert.equal(job.automation_id, 'a6')
  const fake = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)', 'codex-marker'], { stdio: 'ignore' })
  await wait(150)
  setJobPid(job, fake.pid)
  const r = reclaimOrphans()
  assert.equal(r.killed, 1, 'the recorded live codex pid is reaped')
  assert.ok(await waitDead(fake.pid), 'reaped engine process is dead')
  assert.equal(status('a6'), 'queued', 'job requeued after the survivor was killed')
})
