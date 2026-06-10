import { execFileSync } from 'node:child_process'

// Best-effort identity check: true only if the live PID's command contains
// `needle`, so a PID reused since a crash can't make us kill an innocent one.
function commandMatches(pid: number, needle: string): boolean {
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 2000 })
    return out.toLowerCase().includes(needle)
  } catch {
    return false
  }
}

// True when `pid` is a live process whose command identifies it as `needle`.
// pid <= 0 is refused, or process.kill would address a whole process group.
export function processMatches(pid: number, needle: string): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
  } catch {
    return false // not alive
  }
  return commandMatches(pid, needle)
}

// SIGKILLs a process left running after a crash, but only when it is still alive
// AND its command identifies it as the program we expect — so PID reuse can't
// make us kill something innocent. Returns true only if we actually killed one.
export function reapOrphan(pid: number, needle: string): boolean {
  if (!processMatches(pid, needle)) return false
  try {
    process.kill(pid, 'SIGKILL')
    return true
  } catch {
    return false
  }
}
