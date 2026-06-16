import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { log } from './log.js'

const CONFIG_DIR =
  process.env.SNAILDIT_CONFIG_DIR ??
  join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'snaildit')

export const paths = {
  dir: CONFIG_DIR,
  config: join(CONFIG_DIR, 'config.json'),
  automations: join(CONFIG_DIR, 'automations.json'),
  pem: join(CONFIG_DIR, 'private-key.pem'),
  db: join(CONFIG_DIR, 'snaildit.db'),
  tunnelPid: join(CONFIG_DIR, 'cloudflared.pid'),
  lock: join(CONFIG_DIR, 'instance.lock'),
} as const

export interface GithubApp {
  appId: string
  slug: string
  webhookSecret: string
}

export interface Config {
  onboardedAt?: string
  engine?: string
  workers?: number
  github?: GithubApp
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
}

export function ensureConfigDir(): void {
  ensureDir(CONFIG_DIR)
}

function quarantineCorrupt(file: string): void {
  try {
    const stamp = `${Date.now()}-${process.pid}`
    renameSync(file, `${file}.corrupt-${stamp}`)
    log('storage', `corrupt file reset: ${file} (renamed to ${file}.corrupt-${stamp})`)
  } catch {}
}

export function readJsonFile<T>(file: string, fallback: T): T {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return fallback
  }
  try {
    return JSON.parse(raw) as T
  } catch {
    quarantineCorrupt(file)
    return fallback
  }
}

function writeFileAtomic(file: string, data: string, mode: number): void {
  ensureDir(dirname(file))
  const tmp = `${file}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, data, { mode })
    chmodSync(tmp, mode)
    renameSync(tmp, file)
  } catch (err) {
    try {
      unlinkSync(tmp)
    } catch {}
    throw err
  }
}

export function writeJsonFileAtomic(file: string, value: unknown, mode = 0o600): void {
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`, mode)
}

const configWarned = new Set<string>()

function warnConfigOnce(key: string, msg: string): void {
  if (configWarned.has(key)) return
  configWarned.add(key)
  log('config', msg)
}

export function loadConfig(): Config {
  const raw = readJsonFile<unknown>(paths.config, {})
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    warnConfigOnce('root', 'config.json is not an object — ignoring it')
    return {}
  }
  // Drop malformed known fields so a hand-edited file can't crash consumers
  // (a non-object `github` would feed undefined into createHmac on the first
  // delivery). Unknown keys pass through so saves never destroy them.
  const config = raw as Config
  if (config.onboardedAt !== undefined && typeof config.onboardedAt !== 'string') {
    warnConfigOnce('onboardedAt', 'config.json "onboardedAt" is not a string — ignoring it')
    config.onboardedAt = undefined
  }
  if (config.engine !== undefined && typeof config.engine !== 'string') {
    warnConfigOnce('engine', 'config.json "engine" is not a string — ignoring it')
    config.engine = undefined
  }
  if (config.workers !== undefined && typeof config.workers !== 'number') {
    warnConfigOnce('workers', 'config.json "workers" is not a number — ignoring it')
    config.workers = undefined
  }
  if (config.github !== undefined) {
    const g = config.github as unknown
    const valid =
      g !== null &&
      typeof g === 'object' &&
      !Array.isArray(g) &&
      typeof (g as GithubApp).appId === 'string' &&
      typeof (g as GithubApp).slug === 'string' &&
      typeof (g as GithubApp).webhookSecret === 'string'
    if (!valid) {
      warnConfigOnce('github', 'config.json "github" entry is malformed — ignoring it')
      config.github = undefined
    }
  }
  return config
}

export function saveConfig(config: Config): void {
  writeJsonFileAtomic(paths.config, config)
}

export function isOnboarded(config: Config = loadConfig()): boolean {
  return typeof config.onboardedAt === 'string'
}

export function markOnboarded(): Config {
  const config = loadConfig()
  if (config.onboardedAt) return config
  config.onboardedAt = new Date().toISOString()
  saveConfig(config)
  return config
}

export function readPem(): string | null {
  try {
    return readFileSync(paths.pem, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

export function writePem(pem: string): void {
  writeFileAtomic(paths.pem, pem, 0o600)
}
