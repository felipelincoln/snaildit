import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

process.env.SNAILDIT_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'gab-test-config-'))
const { ensureConfigDir, loadConfig, paths, readJsonFile } = await import('../dist/config.js')
const { createAutomation, getAutomation, listAutomations, updateAutomation } = await import('../dist/automations.js')
ensureConfigDir()

test('loadConfig drops malformed known fields but keeps unknown keys', () => {
  writeFileSync(paths.config, JSON.stringify({ github: 'broken', workers: 'x', engine: 5, custom: 1 }))
  const c = loadConfig()
  assert.equal(c.github, undefined, 'non-object github dropped')
  assert.equal(c.workers, undefined, 'non-number workers dropped')
  assert.equal(c.engine, undefined, 'non-string engine dropped')
  assert.equal(c.custom, 1, 'unknown key preserved')
})

test('loadConfig: a non-object document degrades to {}', () => {
  writeFileSync(paths.config, '[]')
  assert.deepEqual(loadConfig(), {})
})

test('readJsonFile quarantines invalid JSON and returns the fallback', () => {
  const f = join(paths.dir, 'bad.json')
  writeFileSync(f, '{ not json')
  assert.deepEqual(readJsonFile(f, { fallback: true }), { fallback: true })
  assert.ok(
    readdirSync(paths.dir).some((n) => n.startsWith('bad.json.corrupt-')),
    'the corrupt file was quarantined',
  )
})

test('automations persist is non-destructive: unrecognized entries survive a save', () => {
  const legacy = { id: 'legacy', future_field: true }
  const valid = {
    id: 'keep',
    name: 'Keep',
    enabled: true,
    triggers: [{ event: 'issues', actions: ['opened'] }],
    trigger_repo_id: 1,
    trigger_repo: 'o/r',
    prompt: 'x',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  }
  writeFileSync(paths.automations, JSON.stringify([valid, legacy]))
  assert.equal(listAutomations().length, 1, 'only the recognized automation is surfaced')

  updateAutomation('keep', { enabled: false })
  const raw = readJsonFile(paths.automations, [])
  assert.ok(
    raw.some((x) => x.id === 'legacy' && x.future_field === true),
    'the legacy entry survived an unrelated save',
  )
  assert.ok(
    raw.some((x) => x.id === 'keep' && x.enabled === false),
    'the targeted entry was updated',
  )
})

test('updateAutomation: an empty effort clears it, an absent effort key preserves it', () => {
  createAutomation({
    id: 'eff',
    name: 'Eff',
    prompt: 'p',
    trigger_repo_id: 1,
    trigger_repo: 'o/r',
    triggers: [{ event: 'issues', actions: ['opened'] }],
    effort: 'high',
  })
  assert.equal(getAutomation('eff').effort, 'high')
  // The clear-effort UI sends effort='' (not undefined, which would drop the key).
  updateAutomation('eff', { effort: '' })
  assert.equal(getAutomation('eff').effort, undefined, "effort='' clears it")
  // A patch without an effort key must leave it untouched.
  updateAutomation('eff', { name: 'Eff2' })
  assert.equal(getAutomation('eff').effort, undefined)
  updateAutomation('eff', { effort: 'low' })
  updateAutomation('eff', { name: 'Eff3' })
  assert.equal(getAutomation('eff').effort, 'low', 'absent effort key preserves the stored value')
})
