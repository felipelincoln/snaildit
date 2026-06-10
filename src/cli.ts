#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { ensureConfigDir } from './config.js'
import { startIngestion } from './live.js'
import { acquireInstanceLock, releaseInstanceLock } from './lock.js'
import { log } from './log.js'
import { startServer } from './server.js'

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  const child = spawn(cmd, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' })
  child.on('error', () => {})
  child.unref()
}

// Backstop: a missed .catch anywhere must degrade to a log line, not let
// Node's default policy kill the daemon (webhook listener and all).
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
  log('process', `unhandled rejection: ${msg}`)
})

const command = process.argv[2]
if (command === 'start') {
  try {
    ensureConfigDir()
    acquireInstanceLock()
    const url = await startServer()
    log('server', `running at ${url}`)
    openBrowser(url)
    const stopIngestion = await startIngestion()
    const shutdown = () => {
      void stopIngestion().finally(() => {
        releaseInstanceLock()
        process.exit(0)
      })
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
  } catch (err) {
    process.stderr.write(`failed to start: ${(err as Error).message}\n`)
    process.exit(1)
  }
} else {
  process.stderr.write('usage: github-ai-bot start\n')
  process.exit(1)
}
