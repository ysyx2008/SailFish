/**
 * File Watch Sensor - 文件变化感知器
 *
 * 监控指定路径的文件变化，产生 file_change 事件。
 * 使用 Node.js fs.watch（支持递归），轻量无额外依赖。
 */
import * as fs from 'fs'
import * as path from 'path'
import type { Sensor, SensorEvent, EventBus } from './types'
import { createLogger } from '../../utils/logger'

const log = createLogger('FileWatchSensor')

interface FileWatchTarget {
  watchId: string
  paths: string[]
  pattern?: string
  events?: Array<'add' | 'change' | 'unlink'>
}

const DEBOUNCE_MS = 500

export class FileWatchSensor implements Sensor {
  readonly id = 'file_watch'
  readonly name = 'File Watch'

  private _running = false
  private eventBus: EventBus
  private watchers: Map<string, fs.FSWatcher[]> = new Map()
  private targets: Map<string, FileWatchTarget> = new Map()
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map()

  get running(): boolean {
    return this._running
  }

  constructor(eventBus: EventBus) {
    this.eventBus = eventBus
  }

  async start(): Promise<void> {
    if (this._running) return
    this._running = true

    for (const [watchId, target] of this.targets) {
      this.startWatching(watchId, target)
    }

    log.info(`Started with ${this.targets.size} targets`)
  }

  async stop(): Promise<void> {
    if (!this._running) return
    this._running = false

    for (const watcherList of this.watchers.values()) {
      for (const watcher of watcherList) {
        watcher.close()
      }
    }
    this.watchers.clear()

    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer)
    }
    this.debounceTimers.clear()

    log.info('Stopped')
  }

  addTarget(watchId: string, target: Omit<FileWatchTarget, 'watchId'>): void {
    const fullTarget: FileWatchTarget = { ...target, watchId }
    this.targets.set(watchId, fullTarget)

    if (this._running) {
      this.startWatching(watchId, fullTarget)
    }
  }

  removeTarget(watchId: string): void {
    this.targets.delete(watchId)
    this.stopWatching(watchId)
  }

  getTargetCount(): number {
    return this.targets.size
  }

  shouldAutoStart(): boolean {
    return this.targets.size > 0
  }

  private isPathSafe(filePath: string): boolean {
    const resolved = path.resolve(filePath)
    const home = process.env.HOME || process.env.USERPROFILE || ''
    const sensitivePatterns = ['.ssh', '.gnupg', '.aws', '.kube', 'credentials', '.env']
    const lower = resolved.toLowerCase()
    for (const p of sensitivePatterns) {
      if (lower.includes(path.sep + p + path.sep) || lower.endsWith(path.sep + p)) {
        return false
      }
    }
    if (home && !resolved.startsWith(home) && !resolved.startsWith('/tmp') && !resolved.startsWith('/var/log')) {
      const stat = fs.lstatSync(resolved)
      if (stat.isSymbolicLink()) return false
    }
    return true
  }

  private startWatching(watchId: string, target: FileWatchTarget): void {
    this.stopWatching(watchId)
    const watcherList: fs.FSWatcher[] = []

    for (const targetPath of target.paths) {
      try {
        const resolved = path.resolve(targetPath)
        if (!this.isPathSafe(resolved)) {
          log.warn(`Refused to watch sensitive path: ${resolved}`)
          continue
        }
        const stat = fs.statSync(resolved)
        const isDir = stat.isDirectory()

        const watcher = fs.watch(resolved, { recursive: isDir }, (eventType, filename) => {
          if (!filename) return
          if (target.pattern && !this.matchGlob(filename, target.pattern)) return

          const changeType = eventType === 'rename' ? 'add' : 'change'
          if (target.events && !target.events.includes(changeType)) return

          this.emitDebounced(watchId, {
            changeType,
            filePath: isDir ? path.join(resolved, filename) : resolved,
            filename: filename,
            directory: isDir ? resolved : path.dirname(resolved)
          })
        })

        watcher.on('error', (err) => {
          log.error(`Watcher error for ${resolved}:`, err)
        })

        watcherList.push(watcher)
      } catch (err) {
        log.error(`Cannot watch ${targetPath}:`, err)
      }
    }

    if (watcherList.length > 0) {
      this.watchers.set(watchId, watcherList)
    }
  }

  private stopWatching(watchId: string): void {
    const watcherList = this.watchers.get(watchId)
    if (watcherList) {
      for (const watcher of watcherList) {
        watcher.close()
      }
      this.watchers.delete(watchId)
    }

    const timer = this.debounceTimers.get(watchId)
    if (timer) {
      clearTimeout(timer)
      this.debounceTimers.delete(watchId)
    }
  }

  private emitDebounced(watchId: string, payload: Record<string, unknown>): void {
    const key = `${watchId}:${payload.filePath}`
    const existing = this.debounceTimers.get(key)
    if (existing) clearTimeout(existing)

    this.debounceTimers.set(key, setTimeout(() => {
      this.debounceTimers.delete(key)

      const event: SensorEvent = {
        id: `fw-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 6)}`,
        type: 'file_change',
        source: this.id,
        timestamp: Date.now(),
        watchId,
        payload,
        priority: 'normal'
      }

      log.info(`${payload.changeType}: ${payload.filename}`)
      this.eventBus.emit(event)
    }, DEBOUNCE_MS))
  }

  private matchGlob(filename: string, pattern: string): boolean {
    let regex = ''
    for (const ch of pattern) {
      if (ch === '*') regex += '.*'
      else if (ch === '?') regex += '.'
      else regex += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
    try {
      return new RegExp(`^${regex}$`, 'i').test(filename)
    } catch {
      return false
    }
  }
}
