/**
 * Sensor Service - 感知器统一管理
 *
 * 管理所有传感器的生命周期，提供统一的启停和状态查询接口。
 */
import type { Sensor, EventBus } from './types'
import { MemoryEventBus, getEventBus } from './event-bus'
import { HeartbeatSensor } from './heartbeat-sensor'
import { FileWatchSensor } from './file-watch-sensor'
import { CalendarSensor } from './calendar-sensor'
import { EmailSensor } from './email-sensor'
import { CommandProbeSensor } from './command-probe-sensor'
import { HttpProbeSensor } from './http-probe-sensor'
import { AppLifecycleSensor } from './app-lifecycle-sensor'
import { createLogger } from '../../utils/logger'

const log = createLogger('SensorService')

export interface SensorServiceConfig {
  /** 是否启用心跳（默认 false，用户显式开启） */
  heartbeatEnabled?: boolean
  /** 心跳间隔（分钟），默认 30 */
  heartbeatIntervalMinutes?: number
}

export class SensorService {
  private sensors: Map<string, Sensor> = new Map()
  private eventBus: MemoryEventBus
  private _running = false

  /** 心跳传感器 */
  readonly heartbeat: HeartbeatSensor
  /** 文件变化传感器 */
  readonly fileWatch: FileWatchSensor
  /** 日历传感器 */
  readonly calendar: CalendarSensor
  /** 邮件传感器 */
  readonly email: EmailSensor
  /** 命令探针传感器 */
  readonly commandProbe: CommandProbeSensor
  /** HTTP 探针传感器 */
  readonly httpProbe: HttpProbeSensor
  /** 应用生命周期与里程碑传感器 */
  readonly appLifecycle: AppLifecycleSensor

  constructor(config?: SensorServiceConfig) {
    this.eventBus = getEventBus()
    this.heartbeat = new HeartbeatSensor(
      this.eventBus,
      config?.heartbeatIntervalMinutes
    )
    this.fileWatch = new FileWatchSensor(this.eventBus)
    this.calendar = new CalendarSensor(this.eventBus)
    this.email = new EmailSensor(this.eventBus)
    this.commandProbe = new CommandProbeSensor(this.eventBus)
    this.httpProbe = new HttpProbeSensor(this.eventBus)
    this.appLifecycle = new AppLifecycleSensor(this.eventBus)

    this.register(this.heartbeat)
    this.register(this.fileWatch)
    this.register(this.calendar)
    this.register(this.email)
    this.register(this.commandProbe)
    this.register(this.httpProbe)
    this.register(this.appLifecycle)
  }

  get running(): boolean {
    return this._running
  }

  getEventBus(): EventBus {
    return this.eventBus
  }

  register(sensor: Sensor): void {
    this.sensors.set(sensor.id, sensor)
    log.info(`Registered sensor: ${sensor.id}`)
  }

  unregister(sensorId: string): void {
    const sensor = this.sensors.get(sensorId)
    if (sensor?.running) {
      sensor.stop()
    }
    this.sensors.delete(sensorId)
  }

  async start(config?: SensorServiceConfig): Promise<void> {
    if (this._running) {
      log.warn(`start() called but already running, ensuring heartbeat state`)
      // 即使已在运行，也确保心跳按需启停
      if (config) {
        await this.ensureHeartbeat(config)
      }
      return
    }
    this._running = true

    const heartbeatEnabled = config?.heartbeatEnabled ?? false

    if (config?.heartbeatIntervalMinutes) {
      this.heartbeat.setInterval(config.heartbeatIntervalMinutes)
    }

    const startTasks: Array<Promise<void>> = []

    for (const [id, sensor] of this.sensors) {
      if (id === 'heartbeat' && !heartbeatEnabled) {
        log.info('Heartbeat disabled, skipping')
        continue
      }
      if (sensor.shouldAutoStart && !sensor.shouldAutoStart()) {
        log.info(`${id} not ready, skipping`)
        continue
      }
      startTasks.push(
        sensor.start().catch(err => {
          log.error(`Failed to start sensor ${id}:`, err)
        })
      )
    }

    await Promise.allSettled(startTasks)
    log.info('Started')
  }

  /**
   * 确保心跳传感器状态与配置一致（在 start() 被重复调用时兜底）
   */
  private async ensureHeartbeat(config: SensorServiceConfig): Promise<void> {
    const heartbeatEnabled = config.heartbeatEnabled ?? false
    if (config.heartbeatIntervalMinutes) {
      this.heartbeat.setInterval(config.heartbeatIntervalMinutes)
    }
    if (heartbeatEnabled && !this.heartbeat.running) {
      log.info('Heartbeat was not running, starting now')
      try {
        await this.heartbeat.start()
      } catch (err) {
        log.error('Failed to start heartbeat:', err)
      }
    } else if (!heartbeatEnabled && this.heartbeat.running) {
      await this.heartbeat.stop()
    }
  }

  async stop(): Promise<void> {
    if (!this._running) return

    for (const sensor of this.sensors.values()) {
      try {
        await sensor.stop()
      } catch (err) {
        log.error(`Failed to stop sensor ${sensor.id}:`, err)
      }
    }

    this._running = false
    log.info('Stopped')
  }

  getSensorStatus(): Array<{ id: string; name: string; running: boolean }> {
    return Array.from(this.sensors.values()).map(s => ({
      id: s.id,
      name: s.name,
      running: s.running
    }))
  }

  getSensorStatusDetailed(): Array<{
    id: string; name: string; running: boolean;
    details?: Record<string, unknown>
  }> {
    return Array.from(this.sensors.values()).map(s => {
      const base: { id: string; name: string; running: boolean; details?: Record<string, unknown> } = {
        id: s.id,
        name: s.name,
        running: s.running
      }

      if (s.id === 'heartbeat') {
        const hb = s as HeartbeatSensor
        base.details = { intervalMinutes: hb.getIntervalMinutes() }
      } else if (s.id === 'email') {
        const em = s as EmailSensor
        base.details = {
          connected: em.connected,
          targetCount: em.getTargetCount(),
          accounts: em.getAccountStatuses()
        }
      } else if (s.id === 'file-watch') {
        const fw = s as FileWatchSensor
        base.details = { targetCount: fw.getTargetCount?.() ?? 0 }
      } else if (s.id === 'calendar') {
        const cal = s as CalendarSensor
        base.details = {
          targetCount: cal.getTargetCount?.() ?? 0,
          accountStatuses: cal.getAccountStatuses?.() ?? []
        }
      } else if (s.id === 'command_probe') {
        const cp = s as CommandProbeSensor
        base.details = { targetCount: cp.getTargetCount() }
      } else if (s.id === 'http_probe') {
        const hp = s as HttpProbeSensor
        base.details = { targetCount: hp.getTargetCount() }
      } else if (s.id === 'app_lifecycle') {
        const al = s as AppLifecycleSensor
        base.details = al.getStatus()
      }

      return base
    })
  }

  getSensor(id: string): Sensor | undefined {
    return this.sensors.get(id)
  }

  getRecentEvents(limit?: number) {
    return this.eventBus.recentEvents(limit)
  }

  getPendingEventCount(): number {
    return this.eventBus.pending()
  }
}

// 单例
let instance: SensorService | null = null

export function getSensorService(config?: SensorServiceConfig): SensorService {
  if (!instance) {
    instance = new SensorService(config)
  }
  return instance
}

// 重新导出
export { MemoryEventBus, getEventBus } from './event-bus'
export { HeartbeatSensor } from './heartbeat-sensor'
export { FileWatchSensor } from './file-watch-sensor'
export { CalendarSensor } from './calendar-sensor'
export { EmailSensor } from './email-sensor'
export { CommandProbeSensor } from './command-probe-sensor'
export { HttpProbeSensor } from './http-probe-sensor'
export { AppLifecycleSensor } from './app-lifecycle-sensor'
export type { Sensor, SensorEvent, EventBus, EventHandler } from './types'
