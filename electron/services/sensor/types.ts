/**
 * Sensor 系统类型定义
 *
 * Sensor（传感器）是轻量级的事件生产者，
 * 持续运行但不消耗 AI 资源。
 */

// ==================== 事件 ====================

export type SensorEventType =
  | 'heartbeat' | 'cron' | 'interval' | 'webhook' | 'manual'
  | 'file_change' | 'calendar' | 'email'

export type SensorEventPriority = 'high' | 'normal' | 'low'

export interface SensorEvent {
  id: string
  type: SensorEventType
  source: string          // sensor ID 或 'user'
  timestamp: number
  watchId?: string        // 指向特定 Watch
  payload: Record<string, unknown>
  priority: SensorEventPriority
}

// ==================== 传感器接口 ====================

export interface Sensor {
  /** 传感器唯一标识 */
  readonly id: string
  /** 传感器名称 */
  readonly name: string
  /** 是否正在运行 */
  readonly running: boolean

  /** 启动传感器 */
  start(): Promise<void>
  /** 停止传感器 */
  stop(): Promise<void>
  /** 是否应该启动（有 target 等前置条件） */
  shouldAutoStart?(): boolean
}

/** 事件处理回调 */
export type EventHandler = (event: SensorEvent) => void | Promise<void>

// ==================== Event Bus 接口 ====================

export interface EventBus {
  /** 发布事件 */
  emit(event: SensorEvent): void
  /** 订阅事件 */
  on(handler: EventHandler): void
  /** 取消订阅 */
  off(handler: EventHandler): void
  /** 获取队列中待处理的事件数 */
  pending(): number
  /** 获取历史事件（用于调试） */
  recentEvents(limit?: number): SensorEvent[]
}
