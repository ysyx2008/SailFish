/**
 * Watch Service - 关注点管理与执行引擎
 *
 * 核心职责：
 * 1. Watch CRUD 管理
 * 2. 监听事件总线，匹配 Watch 触发条件
 * 3. 通过 Agent 执行 Watch 的 prompt
 * 4. 将结果投递到配置的输出渠道
 * 5. 管理 cron/interval 类型触发器的定时调度
 */
import type { BrowserWindow } from 'electron'
import { Notification } from 'electron'
import { createLogger } from '../../utils/logger'
import type {
  WatchDefinition,
  CreateWatchParams,
  WatchTrigger,
  WatchRunRecord,
  WatchRunStatus,
  WatchPriority
} from './types'

const log = createLogger('WatchService')
import { WatchStore, getWatchStore } from './store'
import type { SensorEvent, EventHandler } from '../sensor/types'
import { getEventBus } from '../sensor/event-bus'
import { EventPool, type EventPoolConfig } from './event-pool'
import type { PtyService } from '../pty.service'
import type { SshService, SshConfig } from '../ssh.service'
import type { ConfigService, SshSession } from '../config.service'
import type { AgentService } from '../agent'
import type { AgentContext, AgentCallbacks, AgentStep } from '../agent/types'
import type { AiService } from '../ai.service'
import type { SensorService } from '../sensor'
import { watchTemplates, getTemplateById, getAllTemplateCategories, type WatchTemplate } from './templates'

// cron-parser 动态导入
let CronExpressionParser: any = null

// ==================== 常量 ====================

const MIN_INTERVAL_SECONDS = 10
const MAX_INTERVAL_SECONDS = 7 * 24 * 3600 // 7 days
const DEFAULT_TIMEOUT_SECONDS = 300
const MAX_OUTPUT_LENGTH = 1000

// ==================== 类型 ====================

export interface WatchServiceConfig {
  ptyService: PtyService
  sshService: SshService
  configService: ConfigService
  agentService: AgentService
  aiService: AiService
  sensorService: SensorService
  mainWindow: BrowserWindow | null
}

export interface WatchExecutionResult {
  success: boolean
  output: string
  error?: string
  duration: number
  skipped?: boolean
  skipReason?: string
  steps?: AgentStep[]
  /** Agent 通过 talk_to_user 产生的用户可见消息（与内部 output 分离） */
  userMessage?: string
}

// ==================== Watch Service ====================

export class WatchService {
  private store: WatchStore
  private config: WatchServiceConfig | null = null
  private timers: Map<string, NodeJS.Timeout> = new Map()
  private runningWatches: Map<string, { watchId: string; ptyId: string | null; startTime: number }> = new Map()
  private isRunning = false
  private eventHandler: EventHandler | null = null
  private eventPool: EventPool | null = null
  private checkInterval: NodeJS.Timeout | null = null

  constructor() {
    this.store = getWatchStore()
  }

  init(config: WatchServiceConfig): void {
    this.config = config
    log.info('Initialized')
  }

  async start(): Promise<void> {
    if (this.isRunning) return

    // 动态加载 cron-parser
    if (!CronExpressionParser) {
      try {
        const mod = await import('cron-parser')
        CronExpressionParser = (mod as any).default || (mod as any).CronExpressionParser
      } catch (e) {
        log.error('Failed to load cron-parser:', e)
        throw new Error('cron-parser module not available')
      }
    }

    this.isRunning = true

    // 通过 EventPool 订阅事件总线（分流即时/攒批事件）
    const eventBus = getEventBus()
    this.eventHandler = (event) => this.handleEvent(event)
    const drainMinutes = this.config?.configService
      ? this.config.configService.get('watchEventPoolDrainMinutes')
      : 15
    const quietHours = this.config?.configService
      ? this.config.configService.get('watchQuietHours')
      : null
    this.eventPool = new EventPool(this.eventHandler, {
      drainIntervalMs: (drainMinutes || 15) * 60 * 1000,
      quietHours
    })
    this.eventPool.attach(eventBus)

    // 调度触发器 + 注册传感器 target
    const watches = this.store.getAll()
    for (const watch of watches) {
      if (watch.enabled) {
        this.scheduleTimeTriggers(watch)
        this.registerSensorTargets(watch)
      }
    }

    // 每分钟检查遗漏的调度
    this.checkInterval = setInterval(() => this.checkMissedSchedules(), 60 * 1000)

    log.info(`Started with ${watches.filter(w => w.enabled).length} active watches`)
  }

  stop(): void {
    if (!this.isRunning) return
    this.isRunning = false

    // 取消事件订阅
    if (this.eventPool) {
      this.eventPool.detach(getEventBus())
      this.eventPool = null
    }
    this.eventHandler = null

    // 清除所有定时器
    for (const timer of this.timers.values()) {
      clearTimeout(timer)
    }
    this.timers.clear()

    if (this.checkInterval) {
      clearInterval(this.checkInterval)
      this.checkInterval = null
    }

    // 清理所有传感器 target
    const allWatches = this.store.getAll()
    for (const watch of allWatches) {
      this.unregisterSensorTargets(watch.id)
    }

    // 中止正在运行的 Watch（清理 PTY 和 Agent）
    if (this.runningWatches.size > 0 && this.config) {
      for (const [watchId, info] of this.runningWatches) {
        log.info(`Aborting running watch: ${watchId}`)
        if (info.ptyId) {
          try { this.config.agentService.abort(info.ptyId) } catch { /* ignore */ }
        }
      }
      this.runningWatches.clear()
    }

    log.info('Stopped')
  }

  // ==================== Watch CRUD ====================

  getAll(): WatchDefinition[] {
    return this.store.getAll()
  }

  get(id: string): WatchDefinition | undefined {
    return this.store.get(id)
  }

  create(params: CreateWatchParams): WatchDefinition {
    this.validateParams(params)

    // 为 webhook 触发器生成 token
    const triggers = params.triggers.map(t => {
      if (t.type === 'webhook' && !t.token) {
        return { ...t, token: this.generateToken() }
      }
      return t
    })

    const watch = this.store.create({ ...params, triggers })

    if (watch.enabled && this.isRunning) {
      this.scheduleTimeTriggers(watch)
      this.registerSensorTargets(watch)
    }

    log.info(`Created watch: ${watch.name} (${watch.id})`)
    return watch
  }

  update(id: string, updates: Partial<CreateWatchParams>): WatchDefinition | null {
    if (updates.triggers) {
      this.validateTriggers(updates.triggers)
    }
    const watch = this.store.update(id, updates)
    if (watch) {
      this.cancelTimers(id)
      this.unregisterSensorTargets(id)
      if (watch.enabled && this.isRunning) {
        this.scheduleTimeTriggers(watch)
        this.registerSensorTargets(watch)
      }
    }
    return watch
  }

  delete(id: string): boolean {
    this.cancelTimers(id)
    this.unregisterSensorTargets(id)
    return this.store.delete(id)
  }

  toggle(id: string): WatchDefinition | null {
    const watch = this.store.toggle(id)
    if (watch) {
      if (watch.enabled && this.isRunning) {
        this.scheduleTimeTriggers(watch)
        this.registerSensorTargets(watch)
      } else {
        this.cancelTimers(id)
        this.unregisterSensorTargets(id)
      }
    }
    return watch
  }

  getHistory(watchId?: string, limit?: number) {
    return this.store.getHistory(watchId, limit)
  }

  clearHistory(watchId?: string) {
    this.store.clearHistory(watchId)
  }

  // ==================== 模板 ====================

  getTemplates(): WatchTemplate[] {
    return watchTemplates
  }

  getTemplateCategories() {
    return getAllTemplateCategories()
  }

  createFromTemplate(templateId: string, options?: Record<string, unknown>): WatchDefinition {
    const template = getTemplateById(templateId)
    if (!template) {
      throw new Error(`Template not found: ${templateId}`)
    }
    const params = template.create(options)
    return this.create(params)
  }

  /** 手动触发 Watch */
  async triggerWatch(id: string): Promise<WatchExecutionResult> {
    const watch = this.store.get(id)
    if (!watch) {
      return { success: false, output: '', error: 'Watch not found', duration: 0 }
    }

    // 唤醒关切：通过 drain 事件池触发，使其能看到池中积累的事件（或空 batch 做例行检查）
    if (id === WatchService.WAKEUP_ID && this.eventPool) {
      await this.eventPool.drain(true, { fromManualCheck: true })
      return { success: true, output: '', error: '', duration: 0, skipped: false }
    }

    const event: SensorEvent = {
      id: `manual-${Date.now().toString(36)}`,
      type: 'manual',
      source: 'user',
      timestamp: Date.now(),
      watchId: id,
      payload: {},
      priority: watch.priority
    }

    return this.executeWatch(watch, event)
  }

  /** 更新 Watch 的工作流状态 */
  updateWatchState(id: string, state: Record<string, unknown>): void {
    this.store.updateState(id, state)
  }

  isWatchRunning(id: string): boolean {
    return this.runningWatches.has(id)
  }

  getRunningWatches(): string[] {
    return Array.from(this.runningWatches.keys())
  }

  getSshSessions(): SshSession[] {
    return this.config?.configService.getSshSessions() || []
  }

  // ==================== 事件处理 ====================

  private async handleEvent(event: SensorEvent): Promise<void> {
    // 查找匹配此事件的 Watch
    const watches = this.findMatchingWatches(event)
    if (watches.length === 0) return

    log.info(`Event ${event.type} matched ${watches.length} watch(es)`)

    for (const watch of watches) {
      // 检查是否过期
      if (watch.expiresAt && watch.expiresAt < Date.now()) {
        log.info(`Watch expired: ${watch.name}`)
        this.store.update(watch.id, { enabled: false })
        continue
      }

      // 检查是否已在运行
      if (this.runningWatches.has(watch.id)) {
        log.info(`Watch already running: ${watch.name}`)
        continue
      }

      // 串行执行（当前 watch 完成后才处理下一个）
      await this.executeWatch(watch, event)
    }
  }

  private findMatchingWatches(event: SensorEvent): WatchDefinition[] {
    // 如果事件指定了 watchId，只匹配该 Watch
    if (event.watchId) {
      const watch = this.store.get(event.watchId)
      return watch?.enabled ? [watch] : []
    }

    // 按事件类型匹配
    return this.store.getAll().filter(w =>
      w.enabled && w.triggers.some(t => t.type === event.type)
    )
  }

  // ==================== 执行引擎 ====================

  private static readonly AUTO_TRIGGER_TYPES = new Set([
    'heartbeat', 'cron', 'interval', 'email', 'calendar', 'file_change', 'im_connected',
    'command_probe', 'http_probe', 'app_lifecycle', 'milestone'
  ])

  private async executeWatch(watch: WatchDefinition, event: SensorEvent): Promise<WatchExecutionResult> {
    if (!this.config) {
      return { success: false, output: '', error: 'WatchService not initialized', duration: 0 }
    }

    const startTime = Date.now()
    const enhancedPrompt = this.buildEnhancedPrompt(watch, event)
    const isDesktop = watch.output.type === 'desktop'
    const isWakeup = watch.id === WatchService.WAKEUP_ID
    // 唤醒 Watch 始终"静默执行"：内心独白只在 Awaken 面板展示，不走主聊天；有话说才通知用户
    const isSilent = isWakeup
      ? true
      : (isDesktop && WatchService.AUTO_TRIGGER_TYPES.has(event.type) && !event.payload?.fromManualCheck)

    let ptyId: string | null = null
    let result: WatchExecutionResult

    try {
      if (isDesktop) {
        // 唤醒 Watch：只通知 Awaken 面板（不创建聊天标签页），标签页由 talk_to_user 按需创建
        if (isWakeup) {
          this.notifyFrontend('watch:task-started', {
            watchId: watch.id, ptyId: null, watchName: watch.name,
            prompt: enhancedPrompt, triggerType: event.type, executionType: 'assistant'
          })
        } else if (!isSilent) {
          this.ensureDesktopTab()
          this.notifyFrontend('watch:task-started', {
            watchId: watch.id, ptyId: null, watchName: watch.name,
            prompt: enhancedPrompt, triggerType: event.type, executionType: 'assistant'
          })
        }
        this.runningWatches.set(watch.id, { watchId: watch.id, ptyId: null, startTime })
        // 唤醒 Watch：发送 agent:step（内心独白），但不发送 agent:complete/error（不影响主聊天）
        result = await this.executeWithAssistantAgent(watch, enhancedPrompt, isSilent, isWakeup)
      } else {
        // 其他输出类型：创建 PTY 执行
        if (watch.execution.type === 'local') {
          ptyId = this.config.ptyService.create({ cwd: watch.execution.workingDirectory })
        } else if (watch.execution.type === 'ssh') {
          const session = this.config.configService.getSshSessions()
            .find(s => s.id === watch.execution.sshSessionId)
          if (!session) throw new Error(`SSH session not found: ${watch.execution.sshSessionId}`)
          const sshConfig: SshConfig = {
            host: session.host, port: session.port, username: session.username,
            password: session.password, privateKeyPath: session.privateKeyPath, passphrase: session.passphrase
          }
          ptyId = await this.config.sshService.connect(sshConfig)
        }
        this.runningWatches.set(watch.id, { watchId: watch.id, ptyId, startTime })
        this.notifyFrontend('watch:task-started', {
          watchId: watch.id, ptyId, watchName: watch.name,
          prompt: enhancedPrompt, triggerType: event.type, executionType: watch.execution.type
        })
        result = await this.executeWithPtyAgent(watch, enhancedPrompt, ptyId)
      }
    } catch (error) {
      result = {
        success: false, output: '',
        error: error instanceof Error ? error.message : String(error),
        duration: Date.now() - startTime
      }
    } finally {
      this.runningWatches.delete(watch.id)
      if (ptyId) {
        try {
          if (watch.execution.type === 'local') this.config.ptyService.dispose(ptyId)
          else if (watch.execution.type === 'ssh') this.config.sshService.disconnect(ptyId)
        } catch { /* 忽略清理错误 */ }
      }
    }

    this.recordExecution(watch, event, result)

    await this.deliverOutput(watch, result, isSilent)

    this.notifyFrontend('watch:task-completed', {
      watchId: watch.id,
      result: {
        success: result.success,
        output: result.output.substring(0, MAX_OUTPUT_LENGTH),
        error: result.error, duration: result.duration,
        skipped: result.skipped, skipReason: result.skipReason
      }
    })

    return result
  }

  /**
   * desktop 输出：通过 Companion Agent 执行
   * @param wakeupMode 唤醒模式：发送 agent:step（内心独白）但不发送 agent:complete/error
   */
  private async executeWithAssistantAgent(
    watch: WatchDefinition,
    prompt: string,
    silent: boolean = false,
    wakeupMode: boolean = false
  ): Promise<WatchExecutionResult> {
    if (!this.config?.agentService) {
      return { success: false, output: '', error: 'Agent service not available', duration: 0 }
    }

    const startTime = Date.now()
    const agentId = WatchService.WATCH_ASSISTANT_AGENT_ID
    const mainWindow = this.config.mainWindow
    let hasError = false
    let errorMessage = ''

    // 唤醒模式：始终发送 agent:step（Awaken 面板内心独白），但不发送 complete/error
    // 普通模式：silent 时不发送任何 IPC，非 silent 时全部发送
    const shouldSendSteps = wakeupMode || !silent
    const shouldSendCompletion = !wakeupMode && !silent

    const callbacks: AgentCallbacks = {
      onStep: (_runId: string, step: AgentStep) => {
        if (shouldSendSteps && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('agent:step', {
            agentId, step: JSON.parse(JSON.stringify(step)),
            ...(wakeupMode ? { wakeup: true } : {})
          })
        }
        if (step.type === 'error') {
          hasError = true
          if (!errorMessage) errorMessage = step.content
        }
      },
      onComplete: (_runId: string, result: string, pendingUserMessages?: string[]) => {
        if (shouldSendCompletion && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('agent:complete', { agentId, result, pendingUserMessages })
        }
      },
      onError: (_runId: string, error: string) => {
        hasError = true
        errorMessage = error || errorMessage
        if (shouldSendCompletion && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('agent:error', { agentId, error })
        }
      }
    }

    try {
      const context: AgentContext = {
        terminalOutput: [],
        systemInfo: { os: process.platform, shell: process.env.SHELL || '/bin/bash' },
        terminalType: 'assistant',
        ...(wakeupMode ? { wakeup: true } : {})
      }

      const timeoutMs = (watch.execution.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000
      let timeoutHandle: NodeJS.Timeout | null = null

      const agentResult = await Promise.race([
        this.config.agentService.runAssistant(agentId, prompt, context, {
          enabled: true, commandTimeout: 30000,
          autoExecuteSafe: true, autoExecuteModerate: true,
          executionMode: 'relaxed', debugMode: false
        }, undefined, callbacks),
        new Promise<string>((_, reject) => {
          timeoutHandle = setTimeout(() => reject(new Error(`Watch timeout (${watch.execution.timeout ?? 300}s)`)), timeoutMs)
        })
      ]).finally(() => { if (timeoutHandle) clearTimeout(timeoutHandle) })

      return {
        success: !hasError,
        output: (agentResult || '').trim(),
        error: hasError ? errorMessage : undefined,
        duration: Date.now() - startTime
      }
    } catch (error) {
      try { this.config.agentService.abort(agentId) } catch { /* ignore */ }
      return {
        success: false,
        output: '',
        error: error instanceof Error ? error.message : String(error),
        duration: Date.now() - startTime
      }
    }
  }

  /** 非 desktop 输出：通过 PTY 绑定的 Agent 执行 */
  private async executeWithPtyAgent(
    watch: WatchDefinition,
    prompt: string,
    ptyId: string | null
  ): Promise<WatchExecutionResult> {
    if (!this.config?.agentService) {
      return { success: false, output: '', error: 'Agent service not available', duration: 0 }
    }
    if (!ptyId) {
      return { success: false, output: '', error: 'PTY required for non-desktop Watch execution', duration: 0 }
    }

    const startTime = Date.now()
    const steps: AgentStep[] = []
    let finalOutput = ''
    let hasError = false
    let errorMessage = ''

    try {
      const context: AgentContext = {
        ptyId,
        terminalOutput: [],
        systemInfo: { os: process.platform, shell: process.env.SHELL || '/bin/bash' },
        terminalType: watch.execution.type === 'ssh' ? 'ssh' : 'local'
      }

      const callbacks: AgentCallbacks = {
        onStep: (_agentId: string, step: AgentStep) => {
          const existingIdx = steps.findIndex(s => s.id === step.id)
          if (existingIdx >= 0) { steps[existingIdx] = step } else { steps.push(step) }
          if (step.type === 'message') finalOutput += step.content + '\n'
          else if (step.type === 'error') { hasError = true; if (!errorMessage) errorMessage = step.content }
        },
        onComplete: (_agentId: string, result: string) => {
          if (result && !hasError) finalOutput = result
        },
        onError: (_agentId: string, error: string) => {
          hasError = true; errorMessage = error || errorMessage
        }
      }

      const timeoutMs = (watch.execution.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000
      let timeoutHandle: NodeJS.Timeout | null = null

      const agentResult = await Promise.race([
        this.config.agentService.run(
          ptyId, prompt, context,
          { enabled: true, commandTimeout: 30000,
            autoExecuteSafe: true, autoExecuteModerate: true,
            executionMode: 'relaxed', debugMode: false },
          undefined, undefined, callbacks
        ),
        new Promise<string>((_, reject) => {
          timeoutHandle = setTimeout(() => reject(new Error(`Watch timeout (${watch.execution.timeout ?? 300}s)`)), timeoutMs)
        })
      ]).finally(() => { if (timeoutHandle) clearTimeout(timeoutHandle) })

      finalOutput = agentResult || finalOutput

      return {
        success: !hasError, output: finalOutput.trim(),
        error: hasError ? errorMessage : undefined,
        duration: Date.now() - startTime, steps,
        userMessage: this.extractUserMessage(steps)
      }
    } catch (error) {
      try { this.config.agentService.abort(ptyId) } catch { /* ignore */ }
      return {
        success: false, output: finalOutput.trim(),
        error: error instanceof Error ? error.message : String(error),
        duration: Date.now() - startTime, steps,
        userMessage: this.extractUserMessage(steps)
      }
    }
  }

  // ==================== Prompt 构建 ====================

  private buildEnhancedPrompt(watch: WatchDefinition, event: SensorEvent): string {
    const parts: string[] = []

    // 事件上下文：统一格式化，Agent 只需要知道"发生了什么"
    parts.push(`[当前时间：${new Date().toLocaleString()}]`)

    const eventLines = this.formatEventLines(event)
    if (eventLines.length) {
      parts.push(`触发事件：\n${eventLines.join('\n')}`)
      if (eventLines.length > 1) {
        parts.push('[如果这些事件都不值得通知用户，直接回复 "NO_ACTION" 即可。这些事件会被丢弃，下次再看。]')
      }
    }

    // Watch 自身状态（工作流延续）
    const hasState = watch.state && Object.keys(watch.state).length > 0
    if (hasState) {
      parts.push(`[当前 Watch 状态：${JSON.stringify(watch.state).substring(0, 500)}]`)
    }

    // 共享状态（跨 Watch 上下文）
    const sharedState = this.store.getSharedState()
    const hasSharedState = Object.keys(sharedState).length > 0
    if (hasSharedState) {
      parts.push(`[跨关切共享上下文：${JSON.stringify(sharedState).substring(0, 800)}]`)
    }

    // 状态管理提示：有状态时告知可通过工具更新
    if (hasState || hasSharedState) {
      parts.push('[需要更新状态时，调用 watch_state_update 工具。]')
    }

    // 技能提示
    if (watch.skills && watch.skills.length > 0) {
      parts.push(`[预加载技能：${watch.skills.join(', ')}]`)
    }

    // 用户可见消息必须通过 talk_to_user 发送，最终文本回复仅用于内部记录
    parts.push('[通知用户时，必须调用 talk_to_user 工具发送消息。最终文本回复仅作为内部日志，不会作为通知正文。]')

    // 原始 prompt
    parts.push(watch.prompt)

    return parts.join('\n')
  }

  private formatEventLines(event: SensorEvent): string[] {
    // 批量事件：展开子事件
    if (event.type === 'heartbeat' && event.payload.isBatch) {
      const subEvents = event.payload.events as Array<{ type: string; source: string; timestamp: number; payload: Record<string, unknown> }> | undefined
      if (!subEvents?.length) return ['- 例行检查（传感器未检测到新的邮件、日历或文件变化）']
      return subEvents.slice(0, 20).map((e, i) => `  ${i + 1}. ${this.describeEvent(e.type, e.payload)}`)
    }
    // 单个事件
    if (event.type === 'heartbeat') return ['- 例行检查']
    return [`- ${this.describeEvent(event.type, event.payload)}`]
  }

  private describeEvent(type: string, payload: Record<string, unknown>): string {
    switch (type) {
      case 'email':
        return `邮件 来自 ${payload.fromName || payload.from}："${payload.subject}"`
      case 'calendar':
        return `日历 "${payload.summary}" ${payload.minutesUntilStart}分钟后开始${payload.location ? `（${payload.location}）` : ''}`
      case 'file_change':
        return `文件变更 ${payload.changeType}：${payload.directory}/${payload.filename}`
      case 'webhook':
        return `Webhook${Object.keys(payload).length ? `：${JSON.stringify(payload).substring(0, 500)}` : ''}`
      case 'manual':
        return '用户手动触发'
      case 'im_connected':
        return `IM 上线：${payload.platform}${payload.userName ? `（最近联系人：${payload.userName}）` : ''}`
      case 'command_probe':
        return `命令探针 \`${payload.command}\`：${payload.reason}${payload.output ? `\n输出：${String(payload.output).substring(0, 500)}` : ''}`
      case 'http_probe':
        return `HTTP 探针 ${payload.method || 'GET'} ${payload.url}：${payload.reason}${payload.status != null ? ` (HTTP ${payload.status})` : ''}`
      case 'app_lifecycle':
        return this.describeAppLifecycle(payload)
      case 'milestone':
        return this.describeMilestone(payload)
      default:
        return `${type}${payload.source ? ` 来自 ${payload.source}` : ''}`
    }
  }

  private describeAppLifecycle(payload: Record<string, unknown>): string {
    const event = payload.event as string
    const days = payload.daysTogether as number | undefined
    const convos = payload.totalConversations as number | undefined
    const statsNote = days != null ? `（已陪伴 ${days} 天，共 ${convos ?? 0} 次对话）` : ''
    switch (event) {
      case 'app_started': return `应用启动${statsNote}`
      case 'app_will_quit': return `应用即将退出${statsNote}`
      case 'app_resumed': return '系统从睡眠/锁屏恢复'
      case 'app_idle': return `系统空闲（${payload.idleSeconds}秒）`
      case 'awakening_enabled': return '用户开启了觉醒模式'
      case 'awakening_disabled': return '用户关闭了觉醒模式'
      default: return `应用事件：${event}`
    }
  }

  private describeMilestone(payload: Record<string, unknown>): string {
    const mt = payload.milestoneType as string
    const value = payload.value as number
    switch (mt) {
      case 'days_together': return `里程碑：你们已经在一起 ${value} 天了！`
      case 'conversations': return `里程碑：累计完成了第 ${value} 次对话！`
      case 'anniversary': return `里程碑：${value} 周年纪念日！`
      default: return `里程碑：${mt} = ${value}`
    }
  }

  // ==================== 输出投递 ====================

  private static readonly WATCH_ASSISTANT_AGENT_ID = '__watch__'

  private isNoAction(output: string): boolean {
    const lastLine = output.trim().split('\n').pop()?.trim().toUpperCase() || ''
    return lastLine === 'NO_ACTION'
  }

  private async deliverOutput(watch: WatchDefinition, result: WatchExecutionResult, silent: boolean = false): Promise<void> {
    if (result.skipped) return

    const trimmedOutput = result.output?.trim() || ''
    if (!trimmedOutput && result.success) return
    if (this.isNoAction(trimmedOutput)) {
      log.info(`Agent decided NO_ACTION for: ${watch.name}`)
      return
    }

    const outputType = watch.output.type

    if (outputType === 'silent') return

    const windowAvailable = this.config?.mainWindow && !this.config.mainWindow.isDestroyed()

    // 唤醒 Watch：消息投递由 Agent 通过 talk_to_user 工具完成，此处不重复投递
    if (watch.id === WatchService.WAKEUP_ID) return

    if (outputType === 'desktop') {
      if (silent) {
        this.deliverProactiveMessage(watch, result)
      } else if (!windowAvailable) {
        const imOk = await this.sendIMNotification(watch, result)
        if (!imOk) this.sendNotification(watch, result)
      }
      return
    }

    if (outputType === 'notification') {
      if (windowAvailable) {
        this.deliverProactiveMessage(watch, result)
      } else {
        const imOk = await this.sendIMNotification(watch, result)
        if (!imOk) this.sendNotification(watch, result)
      }
      return
    }

    if (outputType === 'im') {
      if (result.userMessage) return

      const imResult = await this.sendIMNotification(watch, result)
      if (!imResult) {
        if (windowAvailable) {
          this.deliverProactiveMessage(watch, result)
        } else {
          this.sendNotification(watch, result)
        }
      }
      return
    }
  }

  /** 从 Agent 执行步骤中提取 talk_to_user 的消息内容 */
  private extractUserMessage(steps?: AgentStep[]): string | undefined {
    if (!steps || steps.length === 0) return undefined
    const talkSteps = steps.filter(s => s.toolName === 'talk_to_user' && s.toolArgs)
    if (talkSteps.length === 0) return undefined
    return talkSteps.map(s => (s.toolArgs as Record<string, unknown>)?.message as string).filter(Boolean).join('\n')
  }

  /**
   * 将 Watch 执行结果推送到应用内：
   * 1. 确保助手 tab 存在
   * 2. 发送 proactive-message 事件，由 App.vue 负责注入 step 并弹 toast
   */
  private deliverProactiveMessage(watch: WatchDefinition, result: WatchExecutionResult): void {
    const mainWindow = this.config?.mainWindow
    if (!mainWindow || mainWindow.isDestroyed()) return

    const agentId = WatchService.WATCH_ASSISTANT_AGENT_ID

    mainWindow.webContents.send('watch:ensureTab', { agentId })
    mainWindow.webContents.send('watch:proactive-message', {
      agentId,
      message: result.userMessage || result.output,
      watchName: watch.name
    })

    log.info(`Proactive message delivered for: ${watch.name}`)
  }

  /** 通知前端确保 companion tab 存在（Agent 执行前调用） */
  private ensureDesktopTab(): boolean {
    if (!this.config?.mainWindow || this.config.mainWindow.isDestroyed()) {
      return false
    }
    this.config.mainWindow.webContents.send('watch:ensureTab', {
      agentId: WatchService.WATCH_ASSISTANT_AGENT_ID
    })
    return true
  }

  private sendNotification(watch: WatchDefinition, result: WatchExecutionResult): void {
    try {
      const title = result.success ? `✓ ${watch.name}` : `✗ ${watch.name}`
      const body = result.success
        ? (result.userMessage || `已完成 (${Math.round(result.duration / 1000)}s)`).substring(0, 200)
        : (result.error || 'Failed')

      const notification = new Notification({ title, body, silent: false })
      notification.once('click', () => {
        const mainWindow = this.config?.mainWindow
        if (!mainWindow || mainWindow.isDestroyed()) return
        mainWindow.restore()
        mainWindow.show()
        mainWindow.focus()
        this.deliverProactiveMessage(watch, result)
      })
      notification.show()
    } catch (err) {
      log.error('Failed to send notification:', err)
    }
  }

  /** 尝试通过 IM 发送通知，返回是否成功 */
  private async sendIMNotification(watch: WatchDefinition, result: WatchExecutionResult): Promise<boolean> {
    try {
      const { getIMService } = await import('../im/im.service')
      const imService = getIMService()

      const title = result.success ? `✓ ${watch.name}` : `✗ ${watch.name}`
      const message = result.success
        ? (result.userMessage || `已完成 (${Math.round(result.duration / 1000)}s)`).substring(0, 2000)
        : `Error: ${result.error || 'Unknown'}`

      const sendResult = await imService.sendNotification(`**${title}**\n\n${message}`, {
        markdown: true,
        title
      })
      return sendResult.success
    } catch (err) {
      log.error('Failed to send IM notification:', err)
      return false
    }
  }

  // ==================== 记录执行 ====================

  private recordExecution(watch: WatchDefinition, event: SensorEvent, result: WatchExecutionResult): void {
    let status: WatchRunStatus = 'completed'
    if (result.skipped) status = 'skipped'
    else if (!result.success) status = 'failed'

    const runRecord: WatchRunRecord = {
      at: Date.now(),
      status,
      duration: result.duration,
      triggerType: event.type,
      output: result.output.substring(0, MAX_OUTPUT_LENGTH),
      error: result.error,
      skipReason: result.skipReason
    }

    this.store.updateLastRun(watch.id, runRecord)
    this.store.addHistory({
      watchId: watch.id,
      watchName: watch.name,
      ...runRecord
    })
  }

  // ==================== 定时调度 ====================

  private scheduleTimeTriggers(watch: WatchDefinition): void {
    for (const trigger of watch.triggers) {
      if (trigger.type === 'cron') {
        this.scheduleCron(watch.id, trigger.expression)
      } else if (trigger.type === 'interval') {
        this.scheduleInterval(watch.id, trigger.seconds)
      }
    }
  }

  private scheduleCron(watchId: string, expression: string): void {
    if (!CronExpressionParser) return

    const timerKey = `${watchId}:cron`
    this.cancelTimer(timerKey)

    try {
      const interval = CronExpressionParser.parse(expression)
      const nextRun = interval.next().getTime()
      const delay = nextRun - Date.now()

      if (delay <= 0) {
        this.emitTimerEvent(watchId, 'cron')
        return
      }

      this.store.updateNextRun(watchId, nextRun)

      const timer = setTimeout(() => {
        this.timers.delete(timerKey)
        this.emitTimerEvent(watchId, 'cron')
        // 重新调度下一次
        const watch = this.store.get(watchId)
        if (watch?.enabled && this.isRunning) {
          this.scheduleCron(watchId, expression)
        }
      }, delay)

      this.timers.set(timerKey, timer)
    } catch (err) {
      log.error(`Failed to schedule cron for ${watchId}:`, err)
    }
  }

  private scheduleInterval(watchId: string, seconds: number): void {
    const timerKey = `${watchId}:interval`
    this.cancelTimer(timerKey)

    const ms = seconds * 1000
    const nextRun = Date.now() + ms
    this.store.updateNextRun(watchId, nextRun)

    const timer = setTimeout(() => {
      this.timers.delete(timerKey)
      this.emitTimerEvent(watchId, 'interval')
      // 重新调度
      const watch = this.store.get(watchId)
      if (watch?.enabled && this.isRunning) {
        this.scheduleInterval(watchId, seconds)
      }
    }, ms)

    this.timers.set(timerKey, timer)
  }

  private emitTimerEvent(watchId: string, type: 'cron' | 'interval'): void {
    const event: SensorEvent = {
      id: `${type}-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 6)}`,
      type,
      source: 'watch-service',
      timestamp: Date.now(),
      watchId,
      payload: {},
      priority: 'normal'
    }
    getEventBus().emit(event)
  }

  private cancelTimers(watchId: string): void {
    for (const [key, timer] of this.timers) {
      if (key.startsWith(`${watchId}:`)) {
        clearTimeout(timer)
        this.timers.delete(key)
      }
    }
    this.store.updateNextRun(watchId, undefined)
  }

  private cancelTimer(key: string): void {
    const timer = this.timers.get(key)
    if (timer) {
      clearTimeout(timer)
      this.timers.delete(key)
    }
  }

  private checkMissedSchedules(): void {
    const watches = this.store.getAll()
    for (const watch of watches) {
      if (!watch.enabled) continue
      for (const trigger of watch.triggers) {
        if (trigger.type === 'cron') {
          const key = `${watch.id}:cron`
          if (!this.timers.has(key) && !this.runningWatches.has(watch.id)) {
            this.scheduleCron(watch.id, trigger.expression)
          }
        } else if (trigger.type === 'interval') {
          const key = `${watch.id}:interval`
          if (!this.timers.has(key) && !this.runningWatches.has(watch.id)) {
            this.scheduleInterval(watch.id, trigger.seconds)
          }
        }
      }
    }
  }

  // ==================== 状态管理 ====================

  getSharedState(): Record<string, unknown> {
    return this.store.getSharedState()
  }

  setSharedState(key: string, value: unknown): void {
    this.store.setSharedState(key, value)
  }

  clearSharedState(): void {
    this.store.clearSharedState()
  }

  mergeSharedState(updates: Record<string, unknown>): void {
    this.store.mergeSharedState(updates)
  }

  // ==================== 传感器 target 管理 ====================

  private registerSensorTargets(watch: WatchDefinition): void {
    const sensor = this.config?.sensorService
    if (!sensor) return

    for (const trigger of watch.triggers) {
      try {
        if (trigger.type === 'file_change') {
          sensor.fileWatch.addTarget(watch.id, {
            paths: trigger.paths,
            pattern: trigger.pattern,
            events: trigger.events
          })
          if (!sensor.fileWatch.running && sensor.running) {
            sensor.fileWatch.start().catch(err =>
              log.error('Failed to start FileWatchSensor:', err)
            )
          }
        } else if (trigger.type === 'calendar') {
          sensor.calendar.addTarget(watch.id, {
            icsPath: trigger.icsPath,
            beforeMinutes: trigger.beforeMinutes
          })
          if (!sensor.calendar.running && sensor.running) {
            sensor.calendar.start().catch(err =>
              log.error('Failed to start CalendarSensor:', err)
            )
          }
        } else if (trigger.type === 'email') {
          sensor.email.addTarget(watch.id, trigger.filter)
          if (!sensor.email.running && sensor.running) {
            sensor.email.start().catch(err =>
              log.error('Failed to start EmailSensor:', err)
            )
          }
        } else if (trigger.type === 'command_probe') {
          sensor.commandProbe.addTarget(watch.id, {
            command: trigger.command,
            shell: trigger.shell,
            interval: trigger.interval,
            triggerOn: trigger.triggerOn,
            pattern: trigger.pattern,
            workingDirectory: trigger.workingDirectory,
          })
          if (!sensor.commandProbe.running && sensor.running) {
            sensor.commandProbe.start().catch(err =>
              log.error('Failed to start CommandProbeSensor:', err)
            )
          }
        } else if (trigger.type === 'http_probe') {
          sensor.httpProbe.addTarget(watch.id, {
            url: trigger.url,
            method: trigger.method,
            headers: trigger.headers,
            body: trigger.body,
            interval: trigger.interval,
            triggerOn: trigger.triggerOn,
            pattern: trigger.pattern,
            timeout: trigger.timeout,
          })
          if (!sensor.httpProbe.running && sensor.running) {
            sensor.httpProbe.start().catch(err =>
              log.error('Failed to start HttpProbeSensor:', err)
            )
          }
        }
      } catch (err) {
        log.error(`Failed to register sensor target for watch ${watch.id}:`, err)
      }
    }
  }

  private unregisterSensorTargets(watchId: string): void {
    const sensor = this.config?.sensorService
    if (!sensor) return

    sensor.fileWatch.removeTarget(watchId)
    sensor.calendar.removeTarget(watchId)
    sensor.email.removeTarget(watchId)
    sensor.commandProbe.removeTarget(watchId)
    sensor.httpProbe.removeTarget(watchId)
  }

  // ==================== 工具 ====================

  private notifyFrontend(channel: string, data: Record<string, unknown>): void {
    if (this.config?.mainWindow && !this.config.mainWindow.isDestroyed()) {
      this.config.mainWindow.webContents.send(channel, data)
    }
  }

  // ==================== 验证 ====================

  private validateParams(params: CreateWatchParams): void {
    if (!params.name?.trim()) {
      throw new Error('Watch name is required')
    }
    if (!params.prompt?.trim()) {
      throw new Error('Watch prompt is required')
    }
    if (!params.triggers || params.triggers.length === 0) {
      throw new Error('At least one trigger is required')
    }
    this.validateTriggers(params.triggers)
  }

  private validateTriggers(triggers: WatchTrigger[]): void {
    for (const trigger of triggers) {
      switch (trigger.type) {
        case 'cron':
          this.validateCronExpression(trigger.expression)
          break
        case 'interval':
          if (!trigger.seconds || trigger.seconds < MIN_INTERVAL_SECONDS) {
            throw new Error(`Interval must be at least ${MIN_INTERVAL_SECONDS} seconds`)
          }
          if (trigger.seconds > MAX_INTERVAL_SECONDS) {
            throw new Error(`Interval cannot exceed ${MAX_INTERVAL_SECONDS / 86400} days`)
          }
          break
        case 'heartbeat':
        case 'webhook':
        case 'manual':
        case 'im_connected':
        case 'app_lifecycle':
        case 'milestone':
          break
        case 'file_change':
          if (!trigger.paths || trigger.paths.length === 0) {
            throw new Error('File change trigger requires at least one path')
          }
          break
        case 'calendar':
          if (typeof trigger.beforeMinutes !== 'number' || trigger.beforeMinutes < 1) {
            throw new Error('Calendar trigger requires beforeMinutes >= 1')
          }
          break
        case 'email':
          break
        case 'command_probe':
          if (!trigger.command?.trim()) {
            throw new Error('Command probe trigger requires a command')
          }
          if (!trigger.interval || trigger.interval < MIN_INTERVAL_SECONDS) {
            throw new Error(`Command probe interval must be at least ${MIN_INTERVAL_SECONDS} seconds`)
          }
          if (!['output_changed', 'regex_match', 'exit_code_nonzero'].includes(trigger.triggerOn)) {
            throw new Error(`Invalid command probe triggerOn: ${trigger.triggerOn}`)
          }
          if (trigger.triggerOn === 'regex_match' && !trigger.pattern?.trim()) {
            throw new Error('Command probe regex_match requires a pattern')
          }
          break
        case 'http_probe':
          if (!trigger.url?.trim()) {
            throw new Error('HTTP probe trigger requires a URL')
          }
          if (!trigger.interval || trigger.interval < MIN_INTERVAL_SECONDS) {
            throw new Error(`HTTP probe interval must be at least ${MIN_INTERVAL_SECONDS} seconds`)
          }
          if (!['status_changed', 'status_error', 'body_changed', 'regex_match'].includes(trigger.triggerOn)) {
            throw new Error(`Invalid HTTP probe triggerOn: ${trigger.triggerOn}`)
          }
          if (trigger.triggerOn === 'regex_match' && !trigger.pattern?.trim()) {
            throw new Error('HTTP probe regex_match requires a pattern')
          }
          break
        default:
          throw new Error(`Unknown trigger type: ${(trigger as any).type}`)
      }
    }
  }

  private validateCronExpression(expression: string): void {
    if (!expression?.trim()) {
      throw new Error('Cron expression is required')
    }
    if (!CronExpressionParser) {
      return // skip validation if parser not loaded (startup phase)
    }
    try {
      CronExpressionParser.parse(expression)
    } catch (e) {
      throw new Error(`Invalid cron expression "${expression}": ${(e as Error).message}`)
    }
  }

  private generateToken(): string {
    const crypto = require('crypto')
    return crypto.randomBytes(16).toString('base64url')
  }

  /** 更新 mainWindow 引用 */
  setMainWindow(win: BrowserWindow | null): void {
    if (this.config) {
      this.config.mainWindow = win
    }
  }

  // ==================== 觉醒模式 ====================

  private static readonly WAKEUP_ID = '__wakeup__'
  /** @deprecated 旧 ID，仅用于迁移清理 */
  private static readonly LEGACY_PATROL_ID = '__daily_patrol__'

  /** 唤醒关切的 prompt */
  private static readonly WAKEUP_PROMPT = `你刚被唤醒。上方的「触发事件」是传感器已采集的最新数据（日历、邮件、文件变更、IM 上线、应用生命周期、里程碑等）。
用户看不到你的常规输出，只有通过 talk_to_user 工具发送的消息才能送达用户。
有话想说就调用 talk_to_user，没有值得打扰用户的事就直接结束。
请结合你的个性设定决定：若你的个性倾向主动交流，即便无新事件也可简短问候或分享想法。
特殊事件处理指南：
- IM 上线：用户刚通过 IM 平台连上了你，主动打招呼。
- 应用启动：用户刚打开了应用，可以根据当天时间和陪伴天数来决定是否问好。
- 里程碑（陪伴天数/对话次数/周年纪念日）：这是值得庆祝的时刻，用真诚而有个性的方式表达。
以上都不要用模板化的措辞，用你自己的个性和上下文来决定说什么、怎么说。`

  private static readonly WAKEUP_TRIGGERS: WatchTrigger[] = [
    { type: 'heartbeat' },
    { type: 'im_connected' },
    { type: 'app_lifecycle' },
    { type: 'milestone' },
  ]

  /** 确保内置「唤醒」关切存在（觉醒模式开启时调用），幂等 */
  ensureWakeup(): boolean {
    try {
      // 清理旧版日常检查
      if (this.store.get(WatchService.LEGACY_PATROL_ID)) {
        try { this.cancelTimers(WatchService.LEGACY_PATROL_ID) } catch { /* ignore */ }
        try { this.unregisterSensorTargets(WatchService.LEGACY_PATROL_ID) } catch { /* ignore */ }
        this.store.delete(WatchService.LEGACY_PATROL_ID)
        log.info('旧版日常检查已清理')
      }

      const existing = this.store.get(WatchService.WAKEUP_ID)
      if (existing) {
        let needsUpdate = false

        if (existing.prompt?.includes('lastWakeDate')) {
          if (existing.state?.lastWakeDate) {
            const { lastWakeDate, ...rest } = existing.state as Record<string, unknown>
            this.store.updateState(WatchService.WAKEUP_ID, rest)
          }
          needsUpdate = true
        } else if (!existing.prompt?.includes('里程碑')) {
          needsUpdate = true
        }

        if (needsUpdate) {
          this.store.update(WatchService.WAKEUP_ID, {
            prompt: WatchService.WAKEUP_PROMPT,
            triggers: WatchService.WAKEUP_TRIGGERS,
            updatedAt: Date.now()
          })
          log.info('唤醒关切已迁移（支持生命周期与里程碑事件）')
        }
        return true
      }

      const wakeup: WatchDefinition = {
        id: WatchService.WAKEUP_ID,
        name: '唤醒',
        description: '觉醒模式下的定时唤醒，AI 自主决定醒来后做什么',
        enabled: true,
        triggers: WatchService.WAKEUP_TRIGGERS,
        prompt: WatchService.WAKEUP_PROMPT,
        execution: { type: 'local' },
        output: { type: 'desktop' },
        priority: 'normal',
        createdAt: Date.now(),
        updatedAt: Date.now()
      }

      const created = this.store.createWithId(wakeup)
      if (!created) {
        log.warn('唤醒关切创建失败')
        return false
      }

      if (this.isRunning) {
        this.registerSensorTargets(wakeup)
      }
      log.info('唤醒关切已创建')
      return true
    } catch (e) {
      log.error('ensureWakeup 异常:', e)
      return false
    }
  }

  /** 移除内置「唤醒」关切（觉醒模式关闭时调用） */
  removeWakeup(): void {
    try {
      // 同时清理新旧两个 ID
      for (const id of [WatchService.WAKEUP_ID, WatchService.LEGACY_PATROL_ID]) {
        const existing = this.store.get(id)
        if (!existing) continue
        try { this.cancelTimers(id) } catch { /* ignore */ }
        try { this.unregisterSensorTargets(id) } catch { /* ignore */ }
        this.store.delete(id)
        log.info(`${id} 关切已移除`)
      }
    } catch (e) {
      log.error('removeWakeup 异常:', e)
    }
  }

  /**
   * 从旧版 Scheduler 迁移数据到 Watch 系统
   * 幂等操作：已迁移的任务（通过 name 匹配）不会重复创建
   */
  migrateFromScheduler(): { migrated: number; skipped: number; errors: string[] } {
    const result = { migrated: 0, skipped: 0, errors: [] as string[] }

    try {
      let schedulerStore: any
      try {
        const schedulerModule = require('../scheduler.store')
        schedulerStore = schedulerModule.getSchedulerStore?.()
      } catch {
        result.errors.push('Scheduler 模块不可用，跳过迁移')
        return result
      }
      if (!schedulerStore) return result
      const tasks = schedulerStore.getTasks()

      if (tasks.length === 0) return result

      const existingWatches = this.store.getAll()
      const existingNames = new Set(existingWatches.map((w: WatchDefinition) => w.name))

      for (const task of tasks) {
        try {
          if (existingNames.has(task.name)) {
            result.skipped++
            continue
          }

          const trigger = this.convertSchedulerTrigger(task.schedule)
          if (!trigger) {
            result.errors.push(`跳过 "${task.name}": 不支持的调度类型 ${task.schedule.type}`)
            continue
          }

          const execution: import('./types').WatchExecution = {
            type: task.target.type === 'ssh' ? 'ssh' : 'local',
            sshSessionId: task.target.sshSessionId,
            sshSessionName: task.target.sshSessionName,
            workingDirectory: task.target.workingDirectory,
            timeout: task.options?.timeout ?? 300
          }

          const params: CreateWatchParams = {
            name: task.name,
            description: task.description || `从定时任务迁移`,
            triggers: [trigger],
            prompt: task.prompt,
            execution,
            output: { type: task.options?.notifyOnComplete ? 'notification' : 'log' },
            priority: 'normal',
            enabled: task.enabled
          }

          this.create(params)
          result.migrated++
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          result.errors.push(`迁移 "${task.name}" 失败: ${msg}`)
        }
      }

      if (result.migrated > 0) {
        log.info(`已从 Scheduler 迁移 ${result.migrated} 个任务`)
      }
    } catch (err) {
      result.errors.push(`迁移失败: ${err instanceof Error ? err.message : String(err)}`)
    }

    return result
  }

  private convertSchedulerTrigger(schedule: { type: string; expression: string }): WatchTrigger | null {
    switch (schedule.type) {
      case 'cron':
        return { type: 'cron', expression: schedule.expression }
      case 'interval': {
        const match = schedule.expression.match(/^(\d+)(s|m|h|d)$/)
        if (!match) return null
        const value = parseInt(match[1], 10)
        if (!Number.isSafeInteger(value) || value <= 0) return null
        const unitMap: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 }
        return { type: 'interval', seconds: value * (unitMap[match[2]] || 60) }
      }
      case 'once':
        // once 类型的 expression 是 ISO 时间戳，转为 manual 触发（不适合 cron）
        return { type: 'manual' }
      default:
        return null
    }
  }
}

// 单例
let instance: WatchService | null = null

export function getWatchService(): WatchService {
  if (!instance) {
    instance = new WatchService()
  }
  return instance
}
