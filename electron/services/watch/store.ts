/**
 * Watch Store - 持久化存储
 * 使用 electron-store 管理 Watch 定义和执行历史
 */
import Store from 'electron-store'
import type {
  WatchDefinition,
  WatchRunRecord,
  WatchHistoryRecord,
  CreateWatchParams,
  WatchPriority
} from './types'

interface WatchStoreSchema {
  watches: WatchDefinition[]
  history: WatchHistoryRecord[]
  sharedState: Record<string, unknown>
}

const MAX_HISTORY_RECORDS = 500

const defaults: WatchStoreSchema = {
  watches: [],
  history: [],
  sharedState: {}
}

export class WatchStore {
  private store: Store<WatchStoreSchema>

  constructor() {
    this.store = new Store<WatchStoreSchema>({
      name: 'qiyu-terminal-watches',
      defaults
    })
  }

  // ==================== Watch CRUD ====================

  getAll(): WatchDefinition[] {
    return this.store.get('watches') || []
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
      preCheck: params.preCheck,
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

  // ==================== 执行历史 ====================

  getHistory(watchId?: string, limit: number = 50): WatchHistoryRecord[] {
    let history = this.store.get('history') || []
    if (watchId) {
      history = history.filter(h => h.watchId === watchId)
    }
    history.sort((a, b) => b.at - a.at)
    return history.slice(0, limit)
  }

  addHistory(record: Omit<WatchHistoryRecord, 'id'>): WatchHistoryRecord {
    const history = this.store.get('history') || []
    const newRecord: WatchHistoryRecord = {
      ...record,
      id: this.generateId()
    }
    history.push(newRecord)

    if (history.length > MAX_HISTORY_RECORDS) {
      history.sort((a, b) => b.at - a.at)
      history.splice(MAX_HISTORY_RECORDS)
    }

    this.store.set('history', history)
    return newRecord
  }

  clearHistory(watchId?: string): void {
    if (watchId) {
      const history = this.store.get('history') || []
      this.store.set('history', history.filter(h => h.watchId !== watchId))
    } else {
      this.store.set('history', [])
    }
  }

  // ==================== 共享状态 ====================

  getSharedState(): Record<string, unknown> {
    return this.store.get('sharedState') || {}
  }

  setSharedState(key: string, value: unknown): void {
    const state = this.getSharedState()
    state[key] = value
    this.store.set('sharedState', state)
  }

  mergeSharedState(updates: Record<string, unknown>): void {
    const state = this.getSharedState()
    Object.assign(state, updates)
    this.store.set('sharedState', state)
  }

  deleteSharedStateKey(key: string): void {
    const state = this.getSharedState()
    delete state[key]
    this.store.set('sharedState', state)
  }

  clearSharedState(): void {
    this.store.set('sharedState', {})
  }

  // ==================== 辅助 ====================

  private generateId(): string {
    const timestamp = Date.now().toString(36)
    const random = Math.random().toString(36).substring(2, 8)
    return `${timestamp}-${random}`
  }

  exportData(): WatchStoreSchema {
    return {
      watches: this.getAll(),
      history: this.store.get('history') || [],
      sharedState: this.getSharedState()
    }
  }

  importData(data: Partial<WatchStoreSchema>): void {
    if (data.watches) this.store.set('watches', data.watches)
    if (data.history) this.store.set('history', data.history)
    if (data.sharedState) this.store.set('sharedState', data.sharedState)
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
