/**
 * App Lifecycle Sensor - 应用生命周期与里程碑传感器
 *
 * 感知两类事件：
 * 1. 生命周期：app_started / app_will_quit / app_resumed / app_idle / awakening 变化
 * 2. 里程碑：陪伴天数、对话次数、周年纪念日
 *
 * 生命周期事件由 main.ts 通过 notify* 方法触发。
 * 里程碑每小时检查一次，使用持久化计数器避免重复触发，纯数学运算无 I/O 开销。
 */
import type { Sensor, SensorEvent, EventBus, SensorEventPriority } from './types'
import { getConfigService, type ConfigService } from '../config.service'
import { createLogger } from '../../utils/logger'

const log = createLogger('AppLifecycleSensor')

const MILESTONE_CHECK_INTERVAL_MS = 60 * 60 * 1000 // 1 hour

export type AppLifecycleEvent =
  | 'app_started'
  | 'app_will_quit'
  | 'app_resumed'
  | 'app_idle'
  | 'awakening_enabled'
  | 'awakening_disabled'

export type MilestoneType = 'days_together' | 'conversations' | 'anniversary'

const DAYS_MILESTONES = [7, 30, 100, 365, 730, 1095]
const CONVERSATION_MILESTONES = [1, 10, 50, 100, 500, 1000, 5000]

export class AppLifecycleSensor implements Sensor {
  readonly id = 'app_lifecycle'
  readonly name = 'App Lifecycle'

  private _running = false
  private eventBus: EventBus
  private configService: ConfigService | null = null
  private milestoneTimer: NodeJS.Timeout | null = null
  private initialized = false

  private firstUseDate = 0
  private totalConversations = 0
  private achievedMilestones: Set<string> = new Set()

  get running(): boolean {
    return this._running
  }

  constructor(eventBus: EventBus) {
    this.eventBus = eventBus
  }

  private ensureInit(): void {
    if (this.initialized) return
    this.initialized = true

    this.configService = getConfigService()
    const stored = this.configService.get('appLifecycleFirstUseDate')
    this.firstUseDate = stored || Date.now()
    if (!stored) {
      this.configService.set('appLifecycleFirstUseDate', this.firstUseDate)
    }

    this.totalConversations = this.configService.get('appLifecycleTotalConversations') || 0
    this.achievedMilestones = new Set(this.configService.get('appLifecycleAchievedMilestones') || [])
  }

  async start(): Promise<void> {
    if (this._running) return
    this._running = true

    this.ensureInit()
    this.checkMilestones()
    this.milestoneTimer = setInterval(() => this.checkMilestones(), MILESTONE_CHECK_INTERVAL_MS)

    log.info(`Started (firstUse: ${new Date(this.firstUseDate).toLocaleDateString()}, conversations: ${this.totalConversations})`)
  }

  async stop(): Promise<void> {
    if (!this._running) return
    this._running = false
    if (this.milestoneTimer) {
      clearInterval(this.milestoneTimer)
      this.milestoneTimer = null
    }
    log.info('Stopped')
  }

  // ==================== 生命周期通知（由 main.ts 调用） ====================

  notifyAppStarted(): void {
    this.emitLifecycle('app_started', 'high', {
      daysTogether: this.getDaysTogether(),
      totalConversations: this.totalConversations,
    })
  }

  notifyAppWillQuit(): void {
    this.emitLifecycle('app_will_quit', 'high', {
      daysTogether: this.getDaysTogether(),
      totalConversations: this.totalConversations,
    })
  }

  notifyResumed(): void {
    this.emitLifecycle('app_resumed', 'normal')
  }

  notifyIdle(idleSeconds: number): void {
    this.emitLifecycle('app_idle', 'low', { idleSeconds })
  }

  notifyAwakeningChanged(enabled: boolean): void {
    this.emitLifecycle(enabled ? 'awakening_enabled' : 'awakening_disabled', 'normal')
  }

  // ==================== 对话计数（由 main.ts 在 agent 完成时调用） ====================

  notifyConversationCompleted(): void {
    this.ensureInit()
    this.totalConversations++
    this.configService?.set('appLifecycleTotalConversations', this.totalConversations)
    this.checkConversationMilestone()
  }

  // ==================== 里程碑检查 ====================

  private checkMilestones(): void {
    this.checkDaysMilestone()
    this.checkAnniversary()
    this.checkConversationMilestone()
  }

  private checkDaysMilestone(): void {
    const days = this.getDaysTogether()
    for (const threshold of DAYS_MILESTONES) {
      if (days < threshold) break
      const key = `days_${threshold}`
      if (!this.achievedMilestones.has(key)) {
        this.achieveMilestone(key)
        this.emitMilestone('days_together', threshold, { totalDays: days })
      }
    }
  }

  private checkAnniversary(): void {
    const now = new Date()
    const first = new Date(this.firstUseDate)
    if (now.getUTCMonth() !== first.getUTCMonth() || now.getUTCDate() !== first.getUTCDate()) return

    const years = now.getUTCFullYear() - first.getUTCFullYear()
    if (years <= 0) return

    const key = `anniversary_${years}`
    if (!this.achievedMilestones.has(key)) {
      this.achieveMilestone(key)
      this.emitMilestone('anniversary', years, { totalDays: this.getDaysTogether() })
    }
  }

  private checkConversationMilestone(): void {
    for (const threshold of CONVERSATION_MILESTONES) {
      if (this.totalConversations < threshold) break
      const key = `conversations_${threshold}`
      if (!this.achievedMilestones.has(key)) {
        this.achieveMilestone(key)
        this.emitMilestone('conversations', threshold, { total: this.totalConversations })
      }
    }
  }

  // ==================== 内部方法 ====================

  private getDaysTogether(): number {
    return Math.floor((Date.now() - this.firstUseDate) / 86400000)
  }

  private achieveMilestone(key: string): void {
    this.achievedMilestones.add(key)
    this.configService?.set(
      'appLifecycleAchievedMilestones',
      Array.from(this.achievedMilestones)
    )
  }

  private emitLifecycle(
    event: AppLifecycleEvent,
    priority: SensorEventPriority = 'normal',
    extra?: Record<string, unknown>
  ): void {
    if (!this._running) return
    this.eventBus.emit({
      id: `lifecycle-${event}-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 6)}`,
      type: 'app_lifecycle',
      source: this.id,
      timestamp: Date.now(),
      payload: { event, ...extra },
      priority,
    })
    log.info(`Lifecycle: ${event}`)
  }

  private emitMilestone(
    milestoneType: MilestoneType,
    value: number,
    extra?: Record<string, unknown>
  ): void {
    if (!this._running) return
    this.eventBus.emit({
      id: `milestone-${milestoneType}-${value}-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 6)}`,
      type: 'milestone',
      source: this.id,
      timestamp: Date.now(),
      payload: { milestoneType, value, ...extra },
      priority: 'high',
    })
    log.info(`Milestone: ${milestoneType} = ${value}`)
  }

  /** 状态摘要（供 sensor:status 使用） */
  getStatus(): { daysTogether: number; totalConversations: number; achievedCount: number } {
    this.ensureInit()
    return {
      daysTogether: this.getDaysTogether(),
      totalConversations: this.totalConversations,
      achievedCount: this.achievedMilestones.size,
    }
  }
}
