/**
 * Watch Store - 持久化存储
 * 使用 electron-store 管理 Watch 定义和执行历史
 *
 * 执行速览分桶：用户关切 `history` 与唤醒 `wakeupHistory` 物理隔离，
 * 各自上限，心跳不得挤占用户关切速览。
 */
import Store from 'electron-store'
import { createLogger } from '../../utils/logger'
import { normalizeWatchDefinition } from '../../utils/normalize'
import { WAKEUP_AGENT_KEY } from '@shared/types'
import type {
  WatchDefinition,
  WatchRunRecord,
  WatchHistoryRecord,
  CreateWatchParams
} from './types'

const log = createLogger('WatchStore')

interface WatchStoreSchema {
  watches: WatchDefinition[]
  /** 用户关切执行速览（不含唤醒） */
  history: WatchHistoryRecord[]
  /**
   * 唤醒执行速览。键缺失表示尚未从旧混写 history 迁移；
   * 迁移后恒为数组（可为空）。
   */
  wakeupHistory?: WatchHistoryRecord[]
  /** 被睡眠打断、等电脑真正恢复后再做的关切 id */
  continueWhenAwake?: string[]
}

const MAX_HISTORY_RECORDS = 500
const MAX_WAKEUP_HISTORY_RECORDS = 500

const defaults: WatchStoreSchema = {
  watches: [],
  history: []
}

export class WatchStore {
  private store: Store<WatchStoreSchema>
  private historyBucketsReady = false

  constructor() {
    this.store = new Store<WatchStoreSchema>({
      name: 'qiyu-terminal-watches',
      defaults
    })
    // 清理已废弃的 sharedState 字段
    if ((this.store as any).has('sharedState')) {
      ;(this.store as any).delete('sharedState')
    }
    this.ensureHistoryBuckets()
  }

  // ==================== Watch CRUD ====================

  getAll(): WatchDefinition[] {
    const raw = this.store.get('watches') || []
    return raw.map(normalizeWatchDefinition)
  }

  get(id: string): WatchDefinition | undefined {
    return this.getAll().find(w => w.id === id)
  }

  create(params: CreateWatchParams): WatchDefinition {
    const now = Date.now()
    const watch: WatchDefinition = {
      id: this.generateId(),
      name: params.name,
      description: params.description,
      enabled: params.enabled ?? true,
      triggers: params.triggers,
      prompt: params.prompt,
      skills: params.skills,
      execution: params.execution,
      output: params.output,
      state: params.state,
      priority: params.priority ?? 'normal',
      createdAt: now,
      updatedAt: now,
      expiresAt: params.expiresAt
    }

    const watches = this.getAll()
    watches.push(watch)
    this.store.set('watches', watches)
    return watch
  }

  /** 使用预设 ID 创建（用于内置关切），幂等 */
  createWithId(watch: WatchDefinition): WatchDefinition | null {
    if (!watch?.id) {
      log.warn('createWithId: watch.id is required')
      return null
    }
    const watches = this.getAll()
    const existing = watches.find(w => w.id === watch.id)
    if (existing) return existing
    watches.push(watch)
    this.store.set('watches', watches)
    return watch
  }

  update(id: string, updates: Partial<Omit<WatchDefinition, 'id' | 'createdAt'>>): WatchDefinition | null {
    const watches = this.getAll()
    const index = watches.findIndex(w => w.id === id)
    if (index === -1) return null

    watches[index] = {
      ...watches[index],
      ...updates,
      updatedAt: Date.now()
    }
    this.store.set('watches', watches)
    return watches[index]
  }

  delete(id: string): boolean {
    const watches = this.getAll()
    const filtered = watches.filter(w => w.id !== id)
    if (filtered.length === watches.length) return false

    this.store.set('watches', filtered)
    return true
  }

  toggle(id: string): WatchDefinition | null {
    const watch = this.get(id)
    if (!watch) return null
    return this.update(id, { enabled: !watch.enabled })
  }

  updateLastRun(id: string, lastRun: WatchRunRecord): void {
    this.update(id, { lastRun })
  }

  updateNextRun(id: string, nextRun: number | undefined): void {
    this.update(id, { nextRun })
  }

  updateState(id: string, state: Record<string, unknown>): void {
    this.update(id, { state })
  }

  listContinueWhenAwake(): string[] {
    const ids = this.store.get('continueWhenAwake')
    if (!Array.isArray(ids)) return []
    return ids.filter((id): id is string => typeof id === 'string' && id.length > 0)
  }

  markContinueWhenAwake(id: string): void {
    const ids = new Set(this.listContinueWhenAwake())
    ids.add(id)
    this.store.set('continueWhenAwake', [...ids])
  }

  clearContinueWhenAwake(id: string): void {
    const ids = this.listContinueWhenAwake()
    if (!ids.includes(id)) return
    this.store.set('continueWhenAwake', ids.filter(existing => existing !== id))
  }

  // ==================== 按触发类型查询 ====================

  getByTriggerType(type: string): WatchDefinition[] {
    return this.getAll().filter(w =>
      w.enabled && w.triggers.some(t => t.type === type)
    )
  }

  getHeartbeatWatches(): WatchDefinition[] {
    return this.getByTriggerType('heartbeat')
  }

  getWebhookWatch(token: string): WatchDefinition | undefined {
    return this.getAll().find(w =>
      w.enabled && w.triggers.some(t => t.type === 'webhook' && t.token === token)
    )
  }

  // ==================== 执行历史（用户关切 / 唤醒分桶） ====================

  /**
   * 读取执行速览。
   * - 无 watchId：用户关切账
   * - watchId === `__wakeup__`：唤醒账
   * - 其它 id：用户关切账内按关切过滤
   */
  getHistory(watchId?: string, limit: number = 50): WatchHistoryRecord[] {
    this.ensureHistoryBuckets()
    let history: WatchHistoryRecord[]
    if (watchId === WAKEUP_AGENT_KEY) {
      history = [...(this.store.get('wakeupHistory') || [])]
    } else {
      history = [...(this.store.get('history') || [])]
      if (watchId) {
        history = history.filter(h => h.watchId === watchId)
      }
    }
    history.sort((a, b) => b.at - a.at)
    return history.slice(0, limit)
  }

  addHistory(record: Omit<WatchHistoryRecord, 'id'>): WatchHistoryRecord {
    this.ensureHistoryBuckets()
    const newRecord: WatchHistoryRecord = {
      ...record,
      id: this.generateId()
    }

    if (record.watchId === WAKEUP_AGENT_KEY) {
      const history = this.store.get('wakeupHistory') || []
      history.push(newRecord)
      this.trimAndSave('wakeupHistory', history, MAX_WAKEUP_HISTORY_RECORDS)
    } else {
      const history = this.store.get('history') || []
      history.push(newRecord)
      this.trimAndSave('history', history, MAX_HISTORY_RECORDS)
    }

    return newRecord
  }

  /**
   * 清除速览。
   * - 无 watchId：清用户关切账（不动唤醒）
   * - watchId === `__wakeup__`：清唤醒账
   * - 其它 id：从用户关切账删除该关切
   */
  clearHistory(watchId?: string): void {
    this.ensureHistoryBuckets()
    if (watchId === WAKEUP_AGENT_KEY) {
      this.store.set('wakeupHistory', [])
      return
    }
    if (watchId) {
      const history = this.store.get('history') || []
      this.store.set('history', history.filter(h => h.watchId !== watchId))
      return
    }
    this.store.set('history', [])
  }

  // ==================== 辅助 ====================

  /**
   * 旧版混写 history → 拆成 history + wakeupHistory（一次性）。
   * 已有 wakeupHistory 键则跳过。
   */
  private ensureHistoryBuckets(): void {
    if (this.historyBucketsReady) return
    if (this.store.has('wakeupHistory')) {
      this.historyBucketsReady = true
      return
    }

    const mixed = this.store.get('history') || []
    const user: WatchHistoryRecord[] = []
    const wakeup: WatchHistoryRecord[] = []
    for (const h of mixed) {
      if (h.watchId === WAKEUP_AGENT_KEY) wakeup.push(h)
      else user.push(h)
    }
    user.sort((a, b) => b.at - a.at)
    wakeup.sort((a, b) => b.at - a.at)
    this.store.set('history', user.slice(0, MAX_HISTORY_RECORDS))
    this.store.set('wakeupHistory', wakeup.slice(0, MAX_WAKEUP_HISTORY_RECORDS))
    this.historyBucketsReady = true
    const truncated =
      user.length > MAX_HISTORY_RECORDS || wakeup.length > MAX_WAKEUP_HISTORY_RECORDS
    log.info(
      `Migrated watch history buckets: user=${user.length}→${Math.min(user.length, MAX_HISTORY_RECORDS)} ` +
      `wakeup=${wakeup.length}→${Math.min(wakeup.length, MAX_WAKEUP_HISTORY_RECORDS)}` +
      (truncated ? ' (truncated)' : '')
    )
  }

  private trimAndSave(
    key: 'history' | 'wakeupHistory',
    history: WatchHistoryRecord[],
    max: number
  ): void {
    if (history.length > max) {
      history.sort((a, b) => b.at - a.at)
      history.splice(max)
    }
    this.store.set(key, history)
  }

  private generateId(): string {
    const timestamp = Date.now().toString(36)
    const random = Math.random().toString(36).substring(2, 8)
    return `${timestamp}-${random}`
  }

  exportData(): WatchStoreSchema {
    this.ensureHistoryBuckets()
    return {
      watches: this.getAll(),
      history: this.store.get('history') || [],
      wakeupHistory: this.store.get('wakeupHistory') || [],
      continueWhenAwake: this.listContinueWhenAwake(),
    }
  }

  importData(data: Partial<WatchStoreSchema>): void {
    if (data.watches) this.store.set('watches', data.watches)
    if (data.history) this.store.set('history', data.history)
    if (Array.isArray(data.continueWhenAwake)) {
      this.store.set('continueWhenAwake', data.continueWhenAwake.filter(id => typeof id === 'string'))
    }
    if (data.wakeupHistory) {
      this.store.set('wakeupHistory', data.wakeupHistory)
      this.historyBucketsReady = true
    } else if (data.history) {
      // 仅当导入的 history 仍是旧混写（含唤醒）时才拆分；否则保留现有 wakeupHistory
      const hasWakeupMixed = data.history.some(h => h.watchId === WAKEUP_AGENT_KEY)
      if (hasWakeupMixed) {
        if (this.store.has('wakeupHistory')) {
          ;(this.store as any).delete('wakeupHistory')
        }
        this.historyBucketsReady = false
        this.ensureHistoryBuckets()
      }
    }
  }
}

// 单例
let instance: WatchStore | null = null

export function getWatchStore(): WatchStore {
  if (!instance) {
    instance = new WatchStore()
  }
  return instance
}
