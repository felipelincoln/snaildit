import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

process.env.SNAILDIT_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'gab-test-extract-'))
const { extract } = await import('../dist/extract.js')
const { verifySignature } = await import('../dist/webhook.js')

const repo = { id: 42, full_name: 'o/r' }

test('extract: a plain issues event', () => {
  const e = extract('issues', { action: 'opened', repository: repo, issue: { number: 7 } })
  assert.deepEqual(e, {
    repository_id: 42,
    repo: 'o/r',
    number: 7,
    type: 'issue',
    event_type: 'issues',
    action: 'opened',
    url: null,
  })
})

test('extract: an issue_comment on a PR is a pull_request, and the comment url wins over the issue url', () => {
  const e = extract('issue_comment', {
    action: 'created',
    repository: repo,
    issue: { number: 7, pull_request: { url: 'x' }, html_url: 'https://gh/i' },
    comment: { html_url: 'https://gh/c' },
  })
  assert.equal(e.type, 'pull_request')
  assert.equal(e.url, 'https://gh/c', 'actionUrl prefers comment over issue')
})

test('extract: pull_request number falls back to payload.number', () => {
  assert.equal(extract('pull_request', { action: 'opened', repository: repo, pull_request: { number: 9 } }).number, 9)
  assert.equal(extract('pull_request_review', { action: 'submitted', repository: repo, number: 11 }).number, 11)
})

test('extract: unsupported event or missing required fields -> null', () => {
  assert.equal(extract('push', { repository: repo }), null)
  assert.equal(extract('issues', { action: 'opened', repository: repo }), null) // no issue number
  assert.equal(extract('issues', { repository: repo, issue: { number: 1 } }), null) // no action
  assert.equal(extract('issues', { action: 'opened', issue: { number: 1 } }), null) // no repository
})

test('verifySignature: accepts a correct HMAC, rejects everything else', () => {
  const secret = 's3cret'
  const body = Buffer.from('{"hello":"world"}')
  const good = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
  assert.equal(verifySignature(secret, body, good), true)
  assert.equal(verifySignature(secret, body, undefined), false, 'missing header')
  assert.equal(verifySignature('wrong-secret', body, good), false, 'wrong secret')
  assert.equal(verifySignature(secret, body, 'sha256=deadbeef'), false, 'length mismatch')
  assert.equal(
    verifySignature(secret, body, good.replace(/.$/, good.endsWith('0') ? '1' : '0')),
    false,
    'same length, wrong digest',
  )
})
