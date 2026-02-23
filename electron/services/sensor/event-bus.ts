/**
 * Event Bus - 内存事件总线
 *
 * 连接传感器（Sensor）和 Watch 执行引擎的管道。
 * 支持优先级队列和事件历史记录。
 */
import type { SensorEvent, EventBus, EventHandler, SensorEventPriority } from './types'
import { createLogger } from '../../utils/logger'

const log = createLogger('EventBus')

const PRIORITY_WEIGHT: Record<SensorEventPriority, number> = {
  high: 0,
  normal: 1,
  low: 2
}

const MAX_RECENT_EVENTS = 100

export class MemoryEventBus implements EventBus {
  private handlers: Set<EventHandler> = new Set()
  private queue: SensorEvent[] = []
  private recent: SensorEvent[] = []
  private processing = false

  emit(event: SensorEvent): void {
    this.recent.push(event)
    if (this.recent.length > MAX_RECENT_EVENTS) {
      this.recent.shift()
    }

    this.queue.push(event)
    this.queue.sort((a, b) => PRIORITY_WEIGHT[a.priority] - PRIORITY_WEIGHT[b.priority])

    this.processQueue()
  }

  on(handler: EventHandler): void {
    this.handlers.add(handler)
  }

  off(handler: EventHandler): void {
    this.handlers.delete(handler)
  }

  pending(): number {
    return this.queue.length
  }

  recentEvents(limit: number = 20): SensorEvent[] {
    return this.recent.slice(-limit)
  }

  private static readonly HANDLER_TIMEOUT_MS = 5 * 60 * 1000  // 5 min per handler

  private async processQueue(): Promise<void> {
    if (this.processing) return
    this.processing = true

    try {
      while (this.queue.length > 0) {
        const event = this.queue.shift()!
        for (const handler of this.handlers) {
          try {
            await Promise.race([
              handler(event),
              new Promise<void>((_, reject) => {
                setTimeout(() => reject(new Error('Handler timeout')), MemoryEventBus.HANDLER_TIMEOUT_MS)
              })
            ])
          } catch (err) {
            log.error(`Handler error for event ${event.type}:`, err)
          }
        }
      }
    } finally {
      this.processing = false
    }
  }
}

// 全局单例
let busInstance: MemoryEventBus | null = null

export function getEventBus(): MemoryEventBus {
  if (!busInstance) {
    busInstance = new MemoryEventBus()
  }
  return busInstance
}
