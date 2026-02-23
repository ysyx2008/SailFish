import * as path from 'path'
import * as fs from 'fs'
import log from 'electron-log/main'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent'

const LOG_LEVEL_MAP: Record<LogLevel, import('electron-log').LogLevel | false> = {
  debug: 'debug',
  info: 'info',
  warn: 'warn',
  error: 'error',
  silent: false,
}

let _level: LogLevel = 'warn'
let _logDir: string | null = null
let _initialized = false

const LOG_RETENTION_DAYS = 30

export interface Logger {
  debug: (...args: unknown[]) => void
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
}

function getDateString(): string {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function resolveLogDir(): string {
  try {
    const { app } = require('electron')
    if (process.platform === 'darwin') {
      return path.join(app.getPath('home'), 'Library', 'Logs', app.getName())
    }
    return path.join(app.getPath('userData'), 'logs')
  } catch {
    return path.join(require('os').homedir(), '.sailfish', 'logs')
  }
}

function cleanOldLogs(logDir: string): void {
  try {
    const files = fs.readdirSync(logDir)
    const cutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000
    for (const file of files) {
      if (!file.endsWith('.log')) continue
      const match = file.match(/^(\d{4}-\d{2}-\d{2})\.log$/)
      if (!match) continue
      const fileTime = new Date(match[1]).getTime()
      if (isNaN(fileTime) || fileTime < cutoff) {
        fs.unlinkSync(path.join(logDir, file))
      }
    }
  } catch {
    // best effort
  }
}

export function initLogging(level?: LogLevel): void {
  if (_initialized) return
  _initialized = true

  _logDir = resolveLogDir()
  if (!fs.existsSync(_logDir)) {
    fs.mkdirSync(_logDir, { recursive: true })
  }

  const logDir = _logDir
  log.transports.file.resolvePathFn = () => {
    return path.join(logDir, `${getDateString()}.log`)
  }
  log.transports.file.maxSize = 0
  log.transports.file.format = '[{h}:{i}:{s}.{ms}] [{level}]{scope} {text}'

  if (level) {
    setLogLevel(level)
  } else {
    applyLogLevel()
  }

  const appVersion = (() => {
    try { return require('electron').app.getVersion() } catch { return 'unknown' }
  })()
  log.info(`========== App Started | v${appVersion} | ${new Date().toISOString()} ==========`)

  setImmediate(() => cleanOldLogs(logDir))
}

function applyLogLevel(): void {
  const mapped = LOG_LEVEL_MAP[_level]
  log.transports.file.level = mapped === false ? false : mapped
  log.transports.console.level = mapped === false ? false : mapped
}

export function setLogLevel(level: LogLevel): void {
  _level = level
  if (_initialized) {
    applyLogLevel()
  }
}

export function getLogLevel(): LogLevel {
  return _level
}

export function getLogDir(): string | null {
  return _logDir
}

export function createLogger(tag: string): Logger {
  if (_initialized) {
    return log.scope(tag)
  }
  const prefix = `[${tag}]`
  return {
    debug(...args: unknown[]) { console.debug(prefix, ...args) },
    info(...args: unknown[]) { console.log(prefix, ...args) },
    warn(...args: unknown[]) { console.warn(prefix, ...args) },
    error(...args: unknown[]) { console.error(prefix, ...args) },
  }
}
