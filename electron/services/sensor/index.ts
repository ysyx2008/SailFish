/**
 * Sensor Service - 感知器统一管理
 *
 * 管理所有传感器的生命周期，提供统一的启停和状态查询接口。
 */
import type { Sensor, EventBus } from './types'
import { MemoryEventBus, getEventBus } from './event-bus'
import { HeartbeatSensor } from './heartbeat-sensor'

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

  /** 心跳传感器（可直接访问以调整参数） */
  readonly heartbeat: HeartbeatSensor

  constructor(config?: SensorServiceConfig) {
    this.eventBus = getEventBus()
    this.heartbeat = new HeartbeatSensor(
      this.eventBus,
      config?.heartbeatIntervalMinutes
    )
    this.register(this.heartbeat)
  }

  get running(): boolean {
    return this._running
  }

  getEventBus(): EventBus {
    return this.eventBus
  }

  register(sensor: Sensor): void {
    this.sensors.set(sensor.id, sensor)
    console.log(`[SensorService] Registered sensor: ${sensor.id}`)
  }

  unregister(sensorId: string): void {
    const sensor = this.sensors.get(sensorId)
    if (sensor?.running) {
      sensor.stop()
    }
    this.sensors.delete(sensorId)
  }

  async start(config?: SensorServiceConfig): Promise<void> {
    if (this._running) return
    this._running = true

    const heartbeatEnabled = config?.heartbeatEnabled ?? false

    for (const [id, sensor] of this.sensors) {
      if (id === 'heartbeat' && !heartbeatEnabled) {
        console.log('[SensorService] Heartbeat disabled, skipping')
        continue
      }
      try {
        await sensor.start()
      } catch (err) {
        console.error(`[SensorService] Failed to start sensor ${id}:`, err)
      }
    }

    console.log('[SensorService] Started')
  }

  async stop(): Promise<void> {
    if (!this._running) return

    for (const sensor of this.sensors.values()) {
      try {
        await sensor.stop()
      } catch (err) {
        console.error(`[SensorService] Failed to stop sensor ${sensor.id}:`, err)
      }
    }

    this._running = false
    console.log('[SensorService] Stopped')
  }

  getSensorStatus(): Array<{ id: string; name: string; running: boolean }> {
    return Array.from(this.sensors.values()).map(s => ({
      id: s.id,
      name: s.name,
      running: s.running
    }))
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
export type { Sensor, SensorEvent, EventBus, EventHandler } from './types'
