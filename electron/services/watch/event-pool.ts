/**
 * EventPool - 事件分流与攒批
 *
 * 坐在 EventBus 和 WatchService 事件处理之间，提供程序层面的事件分流，
 * 替代之前 AI pre-check 的角色，更快、更便宜、更可预测。
 *
 * 分流规则：
 * - 即时事件（high 优先级 / webhook / manual / file_change）：直接转发给 WatchService
 * - 心跳事件：触发一次排水，把池中已攒的事件打包投递；池空则跳过，不唤醒 AI
 * - 其他事件（normal/low 优先级的 email / calendar / cron / interval）：
 *   放入池中等待排水
 *
 * 去重：按 event.id 幂等，同一事件不会入池两次
 * 静默时段：可配置不打扰的时间窗口（默认关闭）
 */
import type { SensorEvent, EventBus, EventHandler } from '../sensor/types'
import { createLogger } from '../../utils/logger'

const log = createLogger('EventPool')

export interface EventPoolConfig {
  /** 排水间隔（毫秒），默认 15 分钟 */
  drainIntervalMs?: number
  /** 静默时段（24h 格式），如 { start: '23:00', end: '07:00' }。静默期间攒批事件不排水 */
  quietHours?: { start: string; end: string } | null
  /** 池子最大容量，超过时自动排水 */
  maxPoolSize?: number
}

const DEFAULT_DRAIN_INTERVAL_MS = 15 * 60 * 1000
const DEFAULT_MAX_POOL_SIZE = 50

export class EventPool {
  private pool: SensorEvent[] = []
  private seenIds: Set<string> = new Set()
  private drainTimer: NodeJS.Timeout | null = null
  private busHandler: EventHandler | null = null

  private drainIntervalMs: number
  private quietHours: { start: string; end: string } | null
  private maxPoolSize: number

  private downstream: EventHandler

  constructor(downstream: EventHandler, config?: EventPoolConfig) {
    this.downstream = downstream
    this.drainIntervalMs = config?.drainIntervalMs ?? DEFAULT_DRAIN_INTERVAL_MS
    this.quietHours = config?.quietHours ?? null
    this.maxPoolSize = config?.maxPoolSize ?? DEFAULT_MAX_POOL_SIZE
  }

  /** 接管 EventBus：订阅事件总线，所有事件经过 EventPool 分流 */
  attach(eventBus: EventBus): void {
    if (this.busHandler) return

    this.busHandler = (event) => this.onEvent(event)
    eventBus.on(this.busHandler)

    this.startDrainTimer()
    log.info(`Attached (drain every ${this.drainIntervalMs / 1000}s, maxPool=${this.maxPoolSize})`)
  }

  /** 从 EventBus 脱离 */
  detach(eventBus: EventBus): void {
    if (this.busHandler) {
      eventBus.off(this.busHandler)
      this.busHandler = null
    }
    this.stopDrainTimer()
    this.pool = []
    this.seenIds.clear()
  }

  /** 获取当前池中事件数 */
  get poolSize(): number {
    return this.pool.length
  }

  /** 手动排水（可供外部触发） */
  async drain(): Promise<void> {
    if (this.pool.length === 0) return

    const batch = this.pool.splice(0)
    this.seenIds.clear()

    const batchEvent: SensorEvent = {
      id: `batch-${Date.now().toString(36)}`,
      type: 'heartbeat',
      source: 'event-pool',
      timestamp: Date.now(),
      payload: {
        isBatch: true,
        eventCount: batch.length,
        events: batch.map(e => ({
          type: e.type,
          source: e.source,
          timestamp: e.timestamp,
          payload: e.payload
        })),
        summary: this.buildBatchSummary(batch)
      },
      priority: 'normal'
    }

    log.info(`Draining ${batch.length} pooled event(s)`)
    await this.downstream(batchEvent)
  }

  /** 更新配置 */
  updateConfig(config: Partial<EventPoolConfig>): void {
    if (config.drainIntervalMs !== undefined) {
      this.drainIntervalMs = config.drainIntervalMs
      if (this.busHandler) {
        this.stopDrainTimer()
        this.startDrainTimer()
      }
    }
    if (config.quietHours !== undefined) {
      this.quietHours = config.quietHours
    }
    if (config.maxPoolSize !== undefined) {
      this.maxPoolSize = config.maxPoolSize
    }
  }

  // ==================== 内部逻辑 ====================

  private async onEvent(event: SensorEvent): Promise<void> {
    if (event.type === 'heartbeat') {
      if (this.pool.length === 0) {
        log.info('Heartbeat: pool empty, skipping')
        return
      }
      log.info(`Heartbeat: draining ${this.pool.length} pooled event(s)`)
      await this.drain()
      return
    }

    if (this.shouldPassThrough(event)) {
      await this.downstream(event)
      return
    }

    this.addToPool(event)
  }

  /** 判断事件是否应该立即通过（不入池） */
  private shouldPassThrough(event: SensorEvent): boolean {
    if (event.priority === 'high') return true
    if (event.type === 'webhook') return true
    if (event.type === 'manual') return true
    if (event.type === 'file_change') return true
    return false
  }

  private addToPool(event: SensorEvent): void {
    if (this.seenIds.has(event.id)) return

    this.seenIds.add(event.id)
    this.pool.push(event)

    if (this.pool.length >= this.maxPoolSize) {
      log.info(`Pool full (${this.maxPoolSize}), force draining`)
      this.drain()
    }
  }

  private startDrainTimer(): void {
    this.stopDrainTimer()
    this.drainTimer = setInterval(async () => {
      if (this.isInQuietHours()) {
        log.info('In quiet hours, skipping drain')
        return
      }
      await this.drain()
    }, this.drainIntervalMs)
  }

  private stopDrainTimer(): void {
    if (this.drainTimer) {
      clearInterval(this.drainTimer)
      this.drainTimer = null
    }
  }

  private isInQuietHours(): boolean {
    if (!this.quietHours) return false

    const now = new Date()
    const currentMinutes = now.getHours() * 60 + now.getMinutes()
    const [startH, startM] = this.quietHours.start.split(':').map(Number)
    const [endH, endM] = this.quietHours.end.split(':').map(Number)
    const start = startH * 60 + startM
    const end = endH * 60 + endM

    // 跨午夜：23:00 ~ 07:00
    if (start > end) {
      return currentMinutes >= start || currentMinutes < end
    }
    return currentMinutes >= start && currentMinutes < end
  }

  private buildBatchSummary(events: SensorEvent[]): string {
    const byType: Record<string, number> = {}
    for (const e of events) {
      byType[e.type] = (byType[e.type] || 0) + 1
    }
    return Object.entries(byType)
      .map(([type, count]) => `${type}×${count}`)
      .join(', ')
  }
}
