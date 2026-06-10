import { spawn } from 'node:child_process'

export interface SpawnOptions {
  cwd: string
  env: Record<string, string>
  stdin: string
  signal: AbortSignal
  // Called with the child PID the moment it spawns, so the caller can record it
  // durably and reap a survivor if the bot crashes mid-run.
  onSpawn?: (pid: number) => void
}

export interface SpawnResult {
  exitCode: number | null
  stderr: string
}

const MAX_STDERR = 4000
const MAX_LINE = 8 * 1024 * 1024

export function spawnJsonl(
  command: string,
  args: string[],
  opts: SpawnOptions,
  fold: (event: unknown) => void,
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      signal: opts.signal,
      killSignal: 'SIGKILL',
    })
    if (child.pid !== undefined) opts.onSpawn?.(child.pid)
    let stdout = ''
    let stderr = ''
    const onLine = (line: string): void => {
      const trimmed = line.trim()
      if (!trimmed) return
      let event: unknown
      try {
        event = JSON.parse(trimmed)
      } catch {
        return
      }
      fold(event)
    }
    child.stdin.on('error', () => {})
    child.stdin.end(opts.stdin)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      let nl = stdout.indexOf('\n')
      while (nl >= 0) {
        onLine(stdout.slice(0, nl))
        stdout = stdout.slice(nl + 1)
        nl = stdout.indexOf('\n')
      }
      // A runaway process writing without newlines must not grow memory
      // forever; the dropped line's tail fails JSON.parse and is ignored.
      if (stdout.length > MAX_LINE) stdout = ''
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-MAX_STDERR)
    })
    let settled = false
    const settle = (exitCode: number | null): void => {
      if (settled) return
      settled = true
      onLine(stdout)
      resolve({ exitCode, stderr })
    }
    child.on('error', (err) => {
      // On abort Node SIGKILLs the child and emits 'error' at once. Don't
      // resolve yet: wait for the real 'exit' so the caller's workdir cleanup
      // never runs while the direct child is still alive.
      if (opts.signal.aborted) return
      if (!settled) {
        settled = true
        reject(err)
      }
    })
    child.on('exit', (code) => {
      // Direct child is gone. A normal run still prefers 'close' so all stdout
      // is flushed first; on abort we settle here, so a grandchild that
      // inherited the stdout pipe can't defer the result (and the rm) forever.
      if (opts.signal.aborted) settle(code)
    })
    child.on('close', (code) => settle(code))
  })
}
