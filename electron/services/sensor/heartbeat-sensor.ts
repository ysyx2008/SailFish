/**
 * Heartbeat Sensor - 心跳感知器
 *
 * 周期性唤醒 Agent，让它自主检查是否有事情要做。
 * 不指定具体任务，而是让 AI 根据上下文（日历、邮件、记忆等）自主判断。
 */
import type { Sensor, SensorEvent, EventBus } from './types'
import { createLogger } from '../../utils/logger'

const log = createLogger('HeartbeatSensor')

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000  // 默认 30 分钟

export class HeartbeatSensor implements Sensor {
  readonly id = 'heartbeat'
  readonly name = 'Heartbeat'

  private timer: NodeJS.Timeout | null = null
  private _running = false
  private intervalMs: number
  private eventBus: EventBus

  get running(): boolean {
    return this._running
  }

  constructor(eventBus: EventBus, intervalMinutes?: number) {
    this.eventBus = eventBus
    this.intervalMs = intervalMinutes
      ? intervalMinutes * 60 * 1000
      : DEFAULT_INTERVAL_MS
  }

  async start(): Promise<void> {
    if (this._running) return
    this._running = true

    this.timer = setInterval(() => {
      this.beat()
    }, this.intervalMs)

    log.info(`Started (interval: ${this.intervalMs / 60000}min)`)
  }

  async stop(): Promise<void> {
    if (!this._running) return
    this._running = false

    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }

    log.info('Stopped')
  }

  /** 手动触发一次心跳（用于测试或 Webhook wake） */
  beat(): void {
    const event: SensorEvent = {
      id: `hb-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 6)}`,
      type: 'heartbeat',
      source: this.id,
      timestamp: Date.now(),
      payload: {
        intervalMs: this.intervalMs
      },
      priority: 'normal'
    }

    log.info(`Beat at ${new Date().toLocaleTimeString()}`)
    this.eventBus.emit(event)
  }

  /** 修改心跳间隔（分钟） */
  setInterval(minutes: number): void {
    this.intervalMs = minutes * 60 * 1000
    if (this._running) {
      this.stop()
      this.start()
    }
  }

  getIntervalMinutes(): number {
    return this.intervalMs / 60000
  }
}
