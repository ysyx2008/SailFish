/**
 * Watch Service - 关注点管理与执行引擎
 *
 * 核心职责：
 * 1. Watch CRUD 管理
 * 2. 监听事件总线，匹配 Watch 触发条件
 * 3. 对匹配的 Watch 执行 pre-check（可选）
 * 4. 通过 Agent 执行 Watch 的 prompt
 * 5. 将结果投递到配置的输出渠道
 * 6. 管理 cron/interval 类型触发器的定时调度
 */
import type { BrowserWindow } from 'electron'
import { Notification } from 'electron'
import type {
  WatchDefinition,
  CreateWatchParams,
  WatchTrigger,
  WatchRunRecord,
  WatchRunStatus,
  WatchPriority
} from './types'
import { WatchStore, getWatchStore } from './store'
import type { SensorEvent, EventHandler } from '../sensor/types'
import { getEventBus } from '../sensor/event-bus'
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
const MAX_PRECHECK_REASON_LENGTH = 500
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
}

// ==================== Watch Service ====================

export class WatchService {
  private store: WatchStore
  private config: WatchServiceConfig | null = null
  private timers: Map<string, NodeJS.Timeout> = new Map()
  private runningWatches: Map<string, { watchId: string; ptyId: string | null; startTime: number }> = new Map()
  private isRunning = false
  private eventHandler: EventHandler | null = null
  private checkInterval: NodeJS.Timeout | null = null

  constructor() {
    this.store = getWatchStore()
  }

  init(config: WatchServiceConfig): void {
    this.config = config
    console.log('[WatchService] Initialized')
  }

  async start(): Promise<void> {
    if (this.isRunning) return

    // 动态加载 cron-parser
    if (!CronExpressionParser) {
      try {
        const mod = await import('cron-parser')
        CronExpressionParser = (mod as any).default || (mod as any).CronExpressionParser
      } catch (e) {
        console.error('[WatchService] Failed to load cron-parser:', e)
        throw new Error('cron-parser module not available')
      }
    }

    this.isRunning = true

    // 订阅事件总线
    const eventBus = getEventBus()
    this.eventHandler = (event) => this.handleEvent(event)
    eventBus.on(this.eventHandler)

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

    console.log(`[WatchService] Started with ${watches.filter(w => w.enabled).length} active watches`)
  }

  stop(): void {
    if (!this.isRunning) return
    this.isRunning = false

    // 取消事件订阅
    if (this.eventHandler) {
      getEventBus().off(this.eventHandler)
      this.eventHandler = null
    }

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
        console.log(`[WatchService] Aborting running watch: ${watchId}`)
        if (info.ptyId) {
          try { this.config.agentService.abort(info.ptyId) } catch { /* ignore */ }
        }
      }
      this.runningWatches.clear()
    }

    console.log('[WatchService] Stopped')
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

    console.log(`[WatchService] Created watch: ${watch.name} (${watch.id})`)
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

    console.log(`[WatchService] Event ${event.type} matched ${watches.length} watch(es)`)

    for (const watch of watches) {
      // 检查是否过期
      if (watch.expiresAt && watch.expiresAt < Date.now()) {
        console.log(`[WatchService] Watch expired: ${watch.name}`)
        this.store.update(watch.id, { enabled: false })
        continue
      }

      // 检查是否已在运行
      if (this.runningWatches.has(watch.id)) {
        console.log(`[WatchService] Watch already running: ${watch.name}`)
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

  private async executeWatch(watch: WatchDefinition, event: SensorEvent): Promise<WatchExecutionResult> {
    if (!this.config) {
      return { success: false, output: '', error: 'WatchService not initialized', duration: 0 }
    }

    const startTime = Date.now()

    // Pre-check：让 AI 判断是否应该执行
    if (watch.preCheck?.enabled) {
      const shouldRun = await this.runPreCheck(watch, event)
      if (!shouldRun.execute) {
        const result: WatchExecutionResult = {
          success: true,
          output: '',
          duration: Date.now() - startTime,
          skipped: true,
          skipReason: shouldRun.reason || 'AI decided to skip'
        }
        this.recordExecution(watch, event, result)
        console.log(`[WatchService] Watch skipped (pre-check): ${watch.name} - ${shouldRun.reason}`)
        return result
      }
    }

    // 构建增强 prompt（原始 prompt + 事件上下文 + Watch 状态）
    const enhancedPrompt = this.buildEnhancedPrompt(watch, event)

    let ptyId: string | null = null
    let result: WatchExecutionResult

    try {
      // 创建执行环境
      if (watch.execution.type === 'local') {
        ptyId = this.config.ptyService.create({
          cwd: watch.execution.workingDirectory
        })
      } else if (watch.execution.type === 'ssh') {
        const session = this.config.configService.getSshSessions()
          .find(s => s.id === watch.execution.sshSessionId)
        if (!session) {
          throw new Error(`SSH session not found: ${watch.execution.sshSessionId}`)
        }
        const sshConfig: SshConfig = {
          host: session.host,
          port: session.port,
          username: session.username,
          password: session.password,
          privateKeyPath: session.privateKeyPath,
          passphrase: session.passphrase
        }
        ptyId = await this.config.sshService.connect(sshConfig)
      }

      this.runningWatches.set(watch.id, {
        watchId: watch.id,
        ptyId,
        startTime
      })

      // 通知前端（如果有 UI）
      this.notifyFrontend('watch:task-started', {
        watchId: watch.id,
        ptyId,
        watchName: watch.name,
        prompt: enhancedPrompt,
        triggerType: event.type,
        executionType: watch.execution.type
      })

      // 通过 Agent 执行
      result = await this.executeWithAgent(watch, enhancedPrompt, ptyId)

    } catch (error) {
      result = {
        success: false,
        output: '',
        error: error instanceof Error ? error.message : String(error),
        duration: Date.now() - startTime
      }
    } finally {
      this.runningWatches.delete(watch.id)

      // 清理终端（Watch 执行完后自动销毁）
      if (ptyId) {
        try {
          if (watch.execution.type === 'local') {
            this.config.ptyService.destroy(ptyId)
          } else if (watch.execution.type === 'ssh') {
            this.config.sshService.disconnect(ptyId)
          }
        } catch { /* 忽略清理错误 */ }
      }
    }

    // 提取并保存状态更新
    if (result.success && result.output) {
      this.extractAndApplyStateUpdates(watch.id, result.output)
    }

    // 记录执行结果
    this.recordExecution(watch, event, result)

    // 投递结果
    await this.deliverOutput(watch, result)

    // 通知前端完成
    this.notifyFrontend('watch:task-completed', {
      watchId: watch.id,
      result: {
        success: result.success,
        output: result.output.substring(0, MAX_OUTPUT_LENGTH),
        error: result.error,
        duration: result.duration,
        skipped: result.skipped,
        skipReason: result.skipReason
      }
    })

    return result
  }

  private async executeWithAgent(
    watch: WatchDefinition,
    prompt: string,
    ptyId: string | null
  ): Promise<WatchExecutionResult> {
    if (!this.config?.agentService) {
      return { success: false, output: '', error: 'Agent service not available', duration: 0 }
    }

    // assistant 模式暂不支持（同 Scheduler 行为）
    if (!ptyId) {
      return { success: false, output: '', error: 'Assistant mode not yet supported for Watches', duration: 0 }
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
        systemInfo: {
          os: process.platform,
          shell: process.env.SHELL || '/bin/bash'
        },
        terminalType: watch.execution.type === 'ssh' ? 'ssh' : 'local'
      }

      const callbacks: AgentCallbacks = {
        onStep: (_agentId: string, step: AgentStep) => {
          const existingIdx = steps.findIndex(s => s.id === step.id)
          if (existingIdx >= 0) {
            steps[existingIdx] = step
          } else {
            steps.push(step)
          }
          if (step.type === 'message') {
            finalOutput += step.content + '\n'
          } else if (step.type === 'error') {
            hasError = true
            if (!errorMessage) errorMessage = step.content
          }
        },
        onComplete: (_agentId: string, result: string) => {
          // onComplete 提供最终结果，仅在无错误时覆盖步骤累积的内容
          if (result && !hasError) finalOutput = result
        },
        onError: (_agentId: string, error: string) => {
          hasError = true
          errorMessage = error || errorMessage
        }
      }

      const timeoutMs = (watch.execution.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000
      let timeoutHandle: NodeJS.Timeout

      const agentResult = await Promise.race([
        this.config.agentService.run(
          ptyId,
          prompt,
          context,
          {
            enabled: true,
            maxSteps: 50,
            commandTimeout: 30000,
            autoExecuteSafe: true,
            autoExecuteModerate: true,
            executionMode: 'relaxed',
            debugMode: false
          },
          undefined,
          undefined,
          callbacks
        ),
        new Promise<string>((_, reject) => {
          timeoutHandle = setTimeout(() => reject(new Error(`Watch timeout (${watch.execution.timeout ?? 300}s)`)), timeoutMs)
        })
      ]).finally(() => clearTimeout(timeoutHandle!))

      finalOutput = agentResult || finalOutput

      return {
        success: !hasError,
        output: finalOutput.trim(),
        error: hasError ? errorMessage : undefined,
        duration: Date.now() - startTime,
        steps
      }

    } catch (error) {
      try { this.config.agentService.abort(ptyId) } catch { /* ignore */ }
      return {
        success: false,
        output: finalOutput.trim(),
        error: error instanceof Error ? error.message : String(error),
        duration: Date.now() - startTime,
        steps
      }
    }
  }

  // ==================== Pre-check ====================

  private async runPreCheck(watch: WatchDefinition, event: SensorEvent): Promise<{ execute: boolean; reason?: string }> {
    if (!this.config?.aiService) {
      return { execute: true }
    }

    try {
      const aiService = this.config.aiService

      const now = new Date()
      const preCheckPrompt = `You are deciding whether to execute an automated task. Answer with JSON only.

Task: "${watch.name}"
Description: ${watch.description || 'N/A'}
Trigger: ${event.type}
Current time: ${now.toLocaleString()}
Day of week: ${now.toLocaleDateString('en-US', { weekday: 'long' })}
${watch.preCheck?.hint ? `User hint: ${watch.preCheck.hint}` : ''}

Should this task run now? Respond in JSON format:
{"execute": true/false, "reason": "brief explanation"}
`
      const text = await aiService.chat([
        { role: 'system', content: 'You are a scheduling assistant. Respond only with valid JSON.' },
        { role: 'user', content: preCheckPrompt }
      ])
      const jsonMatch = text.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0])
          if (
            typeof parsed === 'object' && parsed !== null &&
            'execute' in parsed && typeof parsed.execute === 'boolean'
          ) {
            const reason = typeof parsed.reason === 'string'
              ? parsed.reason.slice(0, MAX_PRECHECK_REASON_LENGTH)
              : undefined
            return { execute: parsed.execute, reason }
          }
        } catch (parseErr) {
          console.error('[WatchService] Pre-check JSON parse error:', parseErr)
        }
      }
    } catch (err) {
      console.error('[WatchService] Pre-check failed, defaulting to execute:', err)
    }

    return { execute: true }
  }

  // ==================== Prompt 构建 ====================

  private buildEnhancedPrompt(watch: WatchDefinition, event: SensorEvent): string {
    const parts: string[] = []

    // 事件上下文
    if (event.type === 'heartbeat') {
      parts.push(`[Heartbeat wake-up at ${new Date().toLocaleString()}]`)
    } else if (event.type === 'webhook') {
      const payloadStr = Object.keys(event.payload).length > 0
        ? `\nWebhook payload: ${JSON.stringify(event.payload).substring(0, 500)}`
        : ''
      parts.push(`[Triggered by webhook${payloadStr}]`)
    } else if (event.type === 'manual') {
      parts.push(`[Manually triggered]`)
    } else if (event.type === 'file_change') {
      const p = event.payload
      parts.push(`[File ${p.changeType}: ${p.filename} in ${p.directory}]`)
    } else if (event.type === 'calendar') {
      const p = event.payload
      parts.push(`[Upcoming calendar event: "${p.summary}" starts in ${p.minutesUntilStart} minutes${p.location ? `, location: ${p.location}` : ''}]`)
    } else if (event.type === 'email') {
      const p = event.payload
      parts.push(`[New email from ${p.fromName || p.from}: "${p.subject}"]`)
    }

    // Watch 自身状态（工作流延续）
    if (watch.state && Object.keys(watch.state).length > 0) {
      parts.push(`[Watch state from last execution: ${JSON.stringify(watch.state).substring(0, 500)}]`)
    }

    // 共享状态（跨 Watch 上下文）
    const sharedState = this.store.getSharedState()
    if (Object.keys(sharedState).length > 0) {
      parts.push(`[Shared context: ${JSON.stringify(sharedState).substring(0, 800)}]`)
    }

    // 状态管理指令
    parts.push(
      '\n[If you need to save state for future executions, include at the end of your response:',
      'STATE_UPDATE: {"key": "value"} for watch-specific state,',
      'SHARED_UPDATE: {"key": "value"} for cross-watch shared context.]'
    )

    // 技能提示
    if (watch.skills && watch.skills.length > 0) {
      parts.push(`[Pre-load skills: ${watch.skills.join(', ')}]`)
    }

    // 原始 prompt
    parts.push(watch.prompt)

    return parts.join('\n')
  }

  // ==================== 输出投递 ====================

  private async deliverOutput(watch: WatchDefinition, result: WatchExecutionResult): Promise<void> {
    if (result.skipped) return

    const outputType = watch.output.type

    if (outputType === 'silent') return

    if (outputType === 'notification') {
      this.sendNotification(watch, result)
      return
    }

    if (outputType === 'im') {
      const imResult = await this.sendIMNotification(watch, result)
      if (!imResult) {
        this.sendNotification(watch, result)
      }
      return
    }

    // 'log' 类型不做额外投递，执行历史已记录
  }

  private sendNotification(watch: WatchDefinition, result: WatchExecutionResult): void {
    try {
      const title = result.success ? `✓ ${watch.name}` : `✗ ${watch.name}`
      const body = result.success
        ? (result.output.substring(0, 200) || `Completed in ${Math.round(result.duration / 1000)}s`)
        : (result.error || 'Failed')

      const notification = new Notification({ title, body, silent: false })
      notification.show()
    } catch (err) {
      console.error('[WatchService] Failed to send notification:', err)
    }
  }

  /** 尝试通过 IM 发送通知，返回是否成功 */
  private async sendIMNotification(watch: WatchDefinition, result: WatchExecutionResult): Promise<boolean> {
    try {
      const { getIMService } = await import('../im/im.service')
      const imService = getIMService()

      const title = result.success ? `✓ ${watch.name}` : `✗ ${watch.name}`
      const message = result.success
        ? (result.output.substring(0, 2000) || `Completed in ${Math.round(result.duration / 1000)}s`)
        : `Error: ${result.error || 'Unknown'}`

      const sendResult = await imService.sendNotification(`**${title}**\n\n${message}`, {
        markdown: true,
        title
      })
      return sendResult.success
    } catch (err) {
      console.error('[WatchService] Failed to send IM notification:', err)
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
      console.error(`[WatchService] Failed to schedule cron for ${watchId}:`, err)
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

  private static readonly MAX_STATE_JSON_LENGTH = 2000
  private static readonly MAX_STATE_KEYS = 20

  private extractAndApplyStateUpdates(watchId: string, output: string): void {
    try {
      this.applyStateUpdate(output, /STATE_UPDATE:\s*(\{[^}]{1,2000}\})/i, (parsed) => {
        const currentState = this.store.get(watchId)?.state || {}
        this.store.updateState(watchId, { ...currentState, ...parsed })
        console.log(`[WatchService] Updated state for watch ${watchId}`)
      })

      this.applyStateUpdate(output, /SHARED_UPDATE:\s*(\{[^}]{1,2000}\})/i, (parsed) => {
        this.store.mergeSharedState(parsed)
        console.log('[WatchService] Updated shared state')
      })
    } catch (err) {
      console.error('[WatchService] Failed to extract state updates:', err)
    }
  }

  private applyStateUpdate(
    output: string,
    pattern: RegExp,
    apply: (data: Record<string, unknown>) => void
  ): void {
    const match = output.match(pattern)
    if (!match?.[1]) return

    try {
      const parsed = JSON.parse(match[1])
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return

      const keys = Object.keys(parsed)
      if (keys.length > WatchService.MAX_STATE_KEYS) return

      const sanitized: Record<string, unknown> = {}
      for (const key of keys) {
        if (typeof key !== 'string' || key.length > 100) continue
        const val = parsed[key]
        if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean' || val === null) {
          sanitized[key] = typeof val === 'string' ? val.slice(0, 500) : val
        }
      }

      if (Object.keys(sanitized).length > 0) {
        apply(sanitized)
      }
    } catch { /* invalid JSON, skip */ }
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
              console.error('[WatchService] Failed to start FileWatchSensor:', err)
            )
          }
        } else if (trigger.type === 'calendar') {
          sensor.calendar.addTarget(watch.id, {
            icsPath: trigger.icsPath,
            beforeMinutes: trigger.beforeMinutes
          })
          if (!sensor.calendar.running && sensor.running) {
            sensor.calendar.start().catch(err =>
              console.error('[WatchService] Failed to start CalendarSensor:', err)
            )
          }
        } else if (trigger.type === 'email') {
          sensor.email.addTarget(watch.id, trigger.filter)
          if (!sensor.email.running && sensor.running) {
            sensor.email.start().catch(err =>
              console.error('[WatchService] Failed to start EmailSensor:', err)
            )
          }
        }
      } catch (err) {
        console.error(`[WatchService] Failed to register sensor target for watch ${watch.id}:`, err)
      }
    }
  }

  private unregisterSensorTargets(watchId: string): void {
    const sensor = this.config?.sensorService
    if (!sensor) return

    sensor.fileWatch.removeTarget(watchId)
    sensor.calendar.removeTarget(watchId)
    sensor.email.removeTarget(watchId)
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

  private static readonly DAILY_PATROL_ID = '__daily_patrol__'

  /**
   * 确保内置「日常巡视」关切存在（觉醒模式开启时调用）
   * 幂等：已存在则跳过
   */
  ensureDailyPatrol(): boolean {
    try {
      const existing = this.store.get(WatchService.DAILY_PATROL_ID)
      if (existing) return true

      const patrol: WatchDefinition = {
        id: WatchService.DAILY_PATROL_ID,
        name: '日常巡视',
        description: '觉醒模式下的主动巡视——定期检查环境变化，有值得关注的事主动告知用户',
        enabled: true,
        triggers: [{ type: 'heartbeat' }],
        prompt: `你刚刚被心跳唤醒了。作为用户的个人助手，请快速巡视一下当前环境：

1. **日历**：检查接下来几小时有没有日程安排，有的话提前告知
2. **已有关切**：查看你之前创建的关切是否有异常（用 watch_list）
3. **环境感知**：如果有任何值得用户注意的事情，主动告知

**重要行为准则**：
- 如果一切正常、没什么特别的——保持沉默，不要打扰用户
- 只在确实有值得关注的信息时才推送消息
- 推送时用简洁自然的语气，像朋友提醒一样
- 如果是深夜或周末，降低打扰意愿`,
        skills: ['calendar', 'email'],
        execution: { type: 'local' },
        output: { type: 'im' },
        preCheck: { enabled: false },
        priority: 'low',
        createdAt: Date.now(),
        updatedAt: Date.now()
      }

      const created = this.store.createWithId(patrol)
      if (!created) {
        console.warn('[WatchService] 日常巡视关切创建失败')
        return false
      }

      if (this.isRunning) {
        this.registerSensorTargets(patrol)
      }
      console.log('[WatchService] 日常巡视关切已创建')
      return true
    } catch (e) {
      console.error('[WatchService] ensureDailyPatrol 异常:', e)
      return false
    }
  }

  /**
   * 移除内置「日常巡视」关切（觉醒模式关闭时调用）
   */
  removeDailyPatrol(): void {
    try {
      const existing = this.store.get(WatchService.DAILY_PATROL_ID)
      if (!existing) return

      try { this.cancelTimers(WatchService.DAILY_PATROL_ID) } catch (e) {
        console.warn('[WatchService] cancelTimers failed:', e)
      }
      try { this.unregisterSensorTargets(WatchService.DAILY_PATROL_ID) } catch (e) {
        console.warn('[WatchService] unregisterSensorTargets failed:', e)
      }
      this.store.delete(WatchService.DAILY_PATROL_ID)
      console.log('[WatchService] 日常巡视关切已移除')
    } catch (e) {
      console.error('[WatchService] removeDailyPatrol 异常:', e)
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
        console.log(`[WatchService] 已从 Scheduler 迁移 ${result.migrated} 个任务`)
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
