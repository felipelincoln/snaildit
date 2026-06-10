import { existsSync, mkdirSync, symlinkSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Automation } from './automations.js'
import { loadConfig } from './config.js'
import type { RunContext, RunResult, Runtime } from './runtime.js'
import { CODEX_HOME, CODEX_REPOS_BASE, CODEX_WORK_BASE, codexEngine } from './engines/codex.js'
import { installationToken } from './github.js'
import { getSession } from './jobs.js'
import { log } from './log.js'
import { spawnJsonl } from './run-stream.js'

const CODEX_BIN = process.env.CODEX_BIN ?? 'codex'

const ENV_PASSTHROUGH = [
  'PATH',
  'HOME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'TERM',
  'TMPDIR',
  'TZ',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
]

function repoHome(repositoryId: number): string {
  const home = join(CODEX_REPOS_BASE, String(repositoryId))
  if (!existsSync(home)) {
    mkdirSync(home, { recursive: true, mode: 0o700 })
    try {
      symlinkSync(join(CODEX_HOME, 'auth.json'), join(home, 'auth.json'))
    } catch {}
  }
  return home
}

function spawnEnv(home: string, token: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of ENV_PASSTHROUGH) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  env.CODEX_HOME = home
  env.GH_TOKEN = token
  env.GITHUB_TOKEN = token
  return env
}

function buildPrompt(automation: Automation, ctx: RunContext, appSlug: string | null): string {
  const lines = [`You are acting on ${ctx.url}.`]
  if (appSlug) {
    lines.push(
      `The \`gh\` CLI is already authenticated as your GitHub App "${appSlug}"; use it for any GitHub actions.`,
    )
  }
  if (ctx.updates.length > 0) {
    lines.push('Latest relevant updates:')
    for (const update of ctx.updates) lines.push(`- ${update}`)
  }
  return `${lines.join('\n')}\n\n${automation.prompt}`
}

function buildArgv(automation: Automation, resumeId: string | null): string[] {
  const flags = [
    '--json',
    '--skip-git-repo-check',
    '-c',
    'sandbox_mode="workspace-write"',
    '-c',
    'sandbox_workspace_write.network_access=true',
  ]
  if (automation.effort) flags.push('-c', `model_reasoning_effort="${automation.effort}"`)
  return resumeId ? ['exec', 'resume', resumeId, ...flags, '-'] : ['exec', ...flags]
}

interface CodexEvent {
  type?: string
  thread_id?: string
  item?: { type?: string; text?: string }
  message?: string
  error?: { message?: string }
  usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number }
}

function unwrapError(raw: string | undefined): string | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string }; message?: string }
    return parsed.error?.message ?? parsed.message ?? raw
  } catch {
    return raw
  }
}

function sessionGone(error: string | null): boolean {
  const r = (error ?? '').toLowerCase()
  return (
    r.includes('no rollout found') ||
    ((r.includes('session') || r.includes('thread')) && (r.includes('not found') || r.includes('does not exist')))
  )
}

export function codexRuntime(): Runtime {
  mkdirSync(CODEX_REPOS_BASE, { recursive: true, mode: 0o700 })
  mkdirSync(CODEX_WORK_BASE, { recursive: true, mode: 0o700 })

  return {
    ready: () => codexEngine.isConfigured(),
    async run(automation: Automation, ctx: RunContext, signal: AbortSignal): Promise<RunResult> {
      let token: string
      try {
        token = await installationToken(ctx.repo, ctx.repository_id)
      } catch (err) {
        return { ok: false, result: `bot token mint failed: ${(err as Error).message}` }
      }

      const env = spawnEnv(repoHome(ctx.repository_id), token)
      const prompt = buildPrompt(automation, ctx, loadConfig().github?.slug ?? null)
      const prior = getSession(automation.id, ctx.repository_id, ctx.number)
      const dir = await mkdtemp(join(CODEX_WORK_BASE, 'run-'))
      const st: { result: string | null; error: string | null; sessionId: string | null; tokens: number | null } = {
        result: null,
        error: null,
        sessionId: prior,
        tokens: null,
      }
      const fold = (ev: unknown): void => {
        const e = ev as CodexEvent
        if (e.type === 'thread.started' && e.thread_id) st.sessionId = e.thread_id
        else if (e.type === 'item.completed' && e.item?.type === 'agent_message') st.result = e.item.text ?? st.result
        else if (e.type === 'turn.completed' && e.usage) {
          const u = e.usage
          const fresh = Math.max(0, (u.input_tokens ?? 0) - (u.cached_input_tokens ?? 0)) + (u.output_tokens ?? 0)
          st.tokens = (st.tokens ?? 0) + fresh
        } else if (e.type === 'error' || e.type === 'turn.failed')
          st.error = unwrapError(e.message ?? e.error?.message) ?? st.error
      }

      try {
        let res = await spawnJsonl(
          CODEX_BIN,
          buildArgv(automation, prior),
          { cwd: dir, env, stdin: prompt, signal },
          fold,
        )
        // Only restart fresh when the resume genuinely FAILED. A successful resume
        // whose output merely contains "session/thread not found" (common when
        // reviewing PRs — gh querying review threads, diff content) must NOT re-run,
        // or it would duplicate the GitHub actions the first run already took.
        const resumeFailed = res.exitCode !== 0 || st.error != null
        if (prior && resumeFailed && (sessionGone(st.error) || sessionGone(res.stderr))) {
          log('engine', `codex session ${prior} gone — starting fresh`)
          st.result = null
          st.error = null
          st.sessionId = null
          st.tokens = null
          res = await spawnJsonl(CODEX_BIN, buildArgv(automation, null), { cwd: dir, env, stdin: prompt, signal }, fold)
        }
        const ok = res.exitCode === 0 && st.error == null
        const result = st.result ?? st.error ?? (res.exitCode !== 0 ? res.stderr.slice(-4000) : null)
        // sessionId null (gone session, fresh run emitted no thread.started)
        // tells the pool to clear the stored session so future runs stop
        // re-paying the resume-fail-then-restart cost.
        return { ok, result, tokens: st.tokens, sessionId: st.sessionId }
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
  }
}
