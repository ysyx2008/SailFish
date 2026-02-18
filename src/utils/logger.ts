export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent'

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
}

let _level: LogLevel = 'warn'

export function setLogLevel(level: LogLevel): void {
  _level = level
}

export function getLogLevel(): LogLevel {
  return _level
}

export interface Logger {
  debug: (...args: unknown[]) => void
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
}

export function createLogger(tag: string): Logger {
  const prefix = `[${tag}]`
  return {
    debug(...args: unknown[]) {
      if (LEVEL_PRIORITY[_level] <= LEVEL_PRIORITY.debug) {
        console.debug(prefix, ...args)
      }
    },
    info(...args: unknown[]) {
      if (LEVEL_PRIORITY[_level] <= LEVEL_PRIORITY.info) {
        console.log(prefix, ...args)
      }
    },
    warn(...args: unknown[]) {
      if (LEVEL_PRIORITY[_level] <= LEVEL_PRIORITY.warn) {
        console.warn(prefix, ...args)
      }
    },
    error(...args: unknown[]) {
      if (LEVEL_PRIORITY[_level] <= LEVEL_PRIORITY.error) {
        console.error(prefix, ...args)
      }
    },
  }
}
