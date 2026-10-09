/**
 * 任务监督（TaskSupervisor）——联络任务管理门面
 *
 * 联络（companion）作为任务 Agent 的总管（Supervisor 模式）：
 * - 查询：枚举任务列表 / 查看单个任务近况（manage_tasks 工具的 list/inspect）
 * - 操作：创建任务、停止任务、再交代、传达用户对危险确认的批准/拒绝（create/stop/instruct/confirm）
 * - 回流：任务 Agent 的待确认 / 完成 / 失败 / 停止事件 → 联络线（proactive 通道）
 *
 * 信任模型（转述制）：联络永不自行批准危险操作——只把确认请求转述给用户，
 * 再把用户的决定传达给任务。唯一例外是用户创建任务时显式声明「全自动」。
 *
 * 上下文隔离红线：向联络提供的永远是摘要（标题/状态/最近步骤一行截断），
 * 任务对话内容不进联络上下文。
 *
 * 事件源过滤：仅 kind=task 的会话冒泡；companion/watch/wakeup 自身不回流（防循环）。
 * 任务分出去的帮手（身份键里的 :sub:）也不是任务，不进列表、不回流。
 * 内存里已经没有的任务，从历史索引补最近若干条已结束的摘要。
 */
import os from 'os'
import { v4 as uuidv4 } from 'uuid'
import { COMPANION_AGENT_KEY, inferConversationKind, type RiskLevel, type TerminalType } from '@shared/types'
import { createLogger } from '../../utils/logger'
import { appendProactiveContext } from './proactive-store'
import { deliverProactiveMessage } from './proactive-deliver'
import { t } from './i18n'
import { getDefaultShell, getLocalOS } from '../../utils/platform'
import type { HistoryService } from '../history.service'
import type { ConfigService } from '../config.service'
import type { AgentContext, AgentConfig, AgentCallbacks } from './types'
import type { SailFish } from './sailfish'

const log = createLogger('TaskSupervisor')

const COMPANION_AGENT_ID = COMPANION_AGENT_KEY

/** 完成/失败事件的防抖窗口：短时间多事件合并成一条复命通知，不刷屏 */
const FINISH_DEBOUNCE_MS = 5000

/** 内存里已经没有的任务，列表最多再补这么多条（按最近活跃，同一任务只留最新一条） */
const SETTLED_TASK_LIMIT = 20

/** 受管任务：kind=task，且不是任务分出去的帮手 */
function isManagedTaskKey(agentKey: string | undefined): agentKey is string {
  return !!agentKey && !agentKey.includes(':sub:') && inferConversationKind(agentKey) === 'task'
}

/** 任务确认请求事件载荷（Agent 基类挂钩传入；不含 resolve，可安全跨边界） */
export interface TaskNeedsConfirmationEvent {
  toolCallId: string
  toolName: string
  riskLevel: RiskLevel
  displayName?: string
  reasons?: string[]
  /** 工具参数预览（已截断） */
  argsPreview: string
}

/** 任务运行结束事件载荷 */
export interface TaskRunFinishedEvent {
  status: 'success' | 'failed' | 'aborted'
  /** 结果或错误概要（已截断） */
  summary: string
}

/** 任务摘要（manage_tasks list 的单项） */
export interface SupervisedTaskInfo {
  agentKey: string
  title: string
  terminalType: TerminalType
  isRunning: boolean
  phase?: string
  currentToolName?: string
  stepCount: number
  /** 已不在内存里、只能从历史看见时的结局。正在跑或还加载着的任务没有这个字段 */
  settled?: 'completed' | 'failed' | 'aborted'
  pendingConfirmation?: {
    toolCallId: string
    toolName: string
    riskLevel: RiskLevel
    displayName?: string
    argsPreview: string
  }
}

/** 任务近况（manage_tasks inspect 的返回） */
export interface SupervisedTaskDetail extends SupervisedTaskInfo {
  /** 最近步骤的一行摘要（已截断），按时间升序 */
  recentSteps: string[]
}

export interface CreateTaskOptions {
  title: string
  /** 任务简报：目标、要求、上下文（作为任务的首条用户消息） */
  brief: string
  /** 用户显式声明「全自动」时为 true（free 模式，不再逐条确认） */
  fullAuto?: boolean
}

/**
 * TaskSupervisor 的宿主接口——由 AgentService 结构式满足。
 * 定义在此文件，避免 tools → AgentService 的循环依赖，也便于单测 mock。
 */
export interface TaskSupervisorHost {
  getAllAgentEntries(): Array<{ agentKey: string; agent: SailFish }>
  getAgent(agentKey: string): SailFish | undefined
  confirmToolCall(agentKey: string, toolCallId: string, approved: boolean): boolean
  abort(agentKey: string): boolean
  /** 往正在跑的任务里送一句补充（当场听见） */
  addUserMessage(agentKey: string, message: string): boolean
  /** 同一场接着做：空闲或已从历史找回时开下一轮 */
  continueTask(agentKey: string, message: string, context: AgentContext): Promise<string>
  runAssistant(
    agentId: string,
    userMessage: string,
    context: AgentContext,
    config?: Partial<AgentConfig>,
    profileId?: string,
    callbacks?: AgentCallbacks
  ): Promise<string>
  getHistoryService(): HistoryService | undefined
  getConfigService(): ConfigService | undefined
  /** 创建任务实例并锁住交办标题；autoReview 为真时这场走替我审批 */
  prepareAssignedTask(agentId: string, title: string, autoReview: boolean): void
}

export class TaskSupervisor {
  private host: TaskSupervisorHost
  private finishBuffer: Array<TaskRunFinishedEvent & { agentKey: string; taskTitle: string }> = []
  private finishFlushTimer: NodeJS.Timeout | null = null

  constructor(host: TaskSupervisorHost) {
    this.host = host
  }

  // ==================== 查询 ====================

  /** 枚举受管任务（待确认 > 运行中 > 空闲 > 已从历史找回的结束任务） */
  listSupervisedTasks(): SupervisedTaskInfo[] {
    const rank = (t: SupervisedTaskInfo) =>
      t.pendingConfirmation ? 0 : t.isRunning ? 1 : t.settled ? 3 : 2
    const tasks: SupervisedTaskInfo[] = []
    for (const { agentKey, agent } of this.host.getAllAgentEntries()) {
      if (!isManagedTaskKey(agentKey)) continue
      try {
        tasks.push(this.buildTaskInfo(agentKey, agent))
      } catch (err) {
        // 单个任务状态异常（如正在 dispose）不拖垮整个列表
        log.warn(`枚举任务 ${agentKey} 失败，已跳过:`, err)
      }
    }
    const liveKeys = new Set(tasks.map(t => t.agentKey))
    try {
      tasks.push(...this.recentSettledTasks(liveKeys))
    } catch (err) {
      log.warn('从历史补任务列表失败:', err)
    }
    return tasks.sort((a, b) => rank(a) - rank(b))
  }

  /** 单个任务近况：内存里有就看内存；没有则从历史读最近步骤摘要 */
  inspectTask(agentKey: string, maxSteps = 8): SupervisedTaskDetail | undefined {
    if (!isManagedTaskKey(agentKey)) return undefined
    const agent = this.host.getAgent(agentKey)
    if (agent) {
      const steps = agent.getSessionStepsSnapshot()
      const recentSteps = steps.slice(-Math.max(1, maxSteps)).map(s => this.summarizeStep(s))
      return { ...this.buildTaskInfo(agentKey, agent), recentSteps }
    }
    try {
      return this.inspectSettledTask(agentKey, maxSteps)
    } catch (err) {
      log.warn(`从历史查看任务 ${agentKey} 失败:`, err)
      return undefined
    }
  }

  // ==================== 操作 ====================

  /** 传达用户对危险确认的批准/拒绝（转述制：本方法只传达，不生成决定） */
  confirmTask(agentKey: string, toolCallId: string, approved: boolean): { ok: boolean; reason?: string; title?: string } {
    if (!isManagedTaskKey(agentKey)) return { ok: false, reason: 'task_not_found' }
    const agent = this.host.getAgent(agentKey)
    if (!agent) {
      const title = this.settledTitle(agentKey)
      return title ? { ok: false, reason: 'settled', title } : { ok: false, reason: 'task_not_found' }
    }
    const title = this.resolveTaskTitle(agentKey)
    const delivered = this.host.confirmToolCall(agentKey, toolCallId, approved)
    return delivered ? { ok: true, title } : { ok: false, reason: 'confirmation_stale', title }
  }

  /** 停止执行中的任务（不关 tab、不销毁会话；abort 幂等） */
  stopTask(agentKey: string): { ok: boolean; reason?: string; title?: string } {
    if (!isManagedTaskKey(agentKey)) return { ok: false, reason: 'task_not_found' }
    const agent = this.host.getAgent(agentKey)
    if (!agent) {
      const title = this.settledTitle(agentKey)
      return title ? { ok: false, reason: 'settled', title } : { ok: false, reason: 'task_not_found' }
    }
    const title = this.resolveTaskTitle(agentKey)
    const stopped = this.host.abort(agentKey)
    return stopped ? { ok: true, title } : { ok: false, reason: 'not_running', title }
  }

  /**
   * 往一场已经存在的任务里再交代一句。
   * 还在跑：当场送进去。已经停了，或只剩历史：仍是原来那场，接着做。
   * 远程终端窗口已经不在时送不进去。
   */
  async instructTask(agentKey: string, message: string): Promise<{
    ok: boolean
    reason?: 'task_not_found' | 'terminal_closed'
    title?: string
    delivered?: 'now' | 'next'
  }> {
    const text = message.trim()
    if (!text || !isManagedTaskKey(agentKey)) return { ok: false, reason: 'task_not_found' }

    const agent = this.host.getAgent(agentKey)
    const record = this.historyRecord(agentKey)
    if (!agent && !record) return { ok: false, reason: 'task_not_found' }

    const title = agent
      ? this.resolveTaskTitle(agentKey)
      : this.titleFromHistory(record?.title, record?.userTask ?? '', agentKey)
    if (agent?.getRunStatus()?.isRunning) {
      const delivered = this.host.addUserMessage(agentKey, text)
      return delivered
        ? { ok: true, title, delivered: 'now' }
        : { ok: false, reason: 'task_not_found', title }
    }

    const terminalType = agent?.getTerminalType() || record?.terminalType || 'assistant'
    if (!agent && terminalType === 'ssh') {
      return { ok: false, reason: 'terminal_closed', title }
    }

    const sessionId = agent?.getSessionId() || record?.id
    const context: AgentContext = {
      terminalOutput: [],
      systemInfo: { os: getLocalOS(), shell: getDefaultShell() },
      terminalType,
      cwd: terminalType === 'ssh' ? '~' : os.homedir(),
      remoteChannel: 'desktop',
      ...(sessionId ? { sessionId } : {}),
      ...(record?.timestamp ? { sessionStartTime: record.timestamp } : {}),
      ...(record?.sshHost ? { sshHost: record.sshHost } : {}),
    }

    if (this.notifyFrontendTaskContinue({
      agentId: agentKey,
      message: text,
      title,
      terminalType,
      sessionId,
      sessionStartTime: record?.timestamp,
      sshHost: record?.sshHost,
    })) {
      return { ok: true, title, delivered: 'next' }
    }

    this.host.continueTask(agentKey, text, context).catch(err => {
      log.error(`再交代失败 (${agentKey}):`, err)
    })
    return { ok: true, title, delivered: 'next' }
  }

  /**
   * 创建任务（一期仅无终端助手形态）。
   *
   * 桌面：发 IPC 给前端建 tab 并自动执行（复用标准 runAgent 路径，确认卡/渲染全一致）。
   * CLI / 无窗口：后端直驱 runAssistant（无 UI 回调，历史照落盘，事件照回流）。
   */
  async createTask(opts: CreateTaskOptions): Promise<{ agentKey: string }> {
    const agentId = `assistant-${uuidv4()}`
    this.host.prepareAssignedTask(agentId, opts.title, opts.fullAuto !== true)
    const payload = {
      agentId,
      title: opts.title,
      brief: opts.brief,
      fullAuto: opts.fullAuto === true,
    }

    if (this.notifyFrontendTaskCreated(payload)) {
      return { agentKey: agentId }
    }

    // 无前端窗口（CLI）：后端直驱
    const context: AgentContext = {
      terminalOutput: [],
      systemInfo: { os: getLocalOS(), shell: getDefaultShell() },
      terminalType: 'assistant',
      cwd: os.homedir(),
      remoteChannel: 'desktop',
    }
    const config: Partial<AgentConfig> = {
      enabled: true,
      maxSteps: 0,
      commandTimeout: 30000,
      autoExecuteSafe: true,
      autoExecuteModerate: true,
      executionMode: opts.fullAuto ? 'free' : 'relaxed',
      debugMode: this.host.getConfigService()?.getAgentDebugMode() ?? false,
    }
    this.host.runAssistant(agentId, opts.brief, context, config).catch(err => {
      log.error(`任务执行失败 (${agentId}):`, err)
    })
    return { agentKey: agentId }
  }

  // ==================== 事件回流（Agent 基类挂钩调用） ====================

  /**
   * 任务的危险确认请求 → 立即回流联络线（转述制第二入口）。
   * 暂存上下文含全部 ID，用户回复"批准/拒绝"时联络凭此调 manage_tasks confirm。
   */
  handleNeedsConfirmation(agentKey: string | undefined, event: TaskNeedsConfirmationEvent): void {
    try {
      if (!isManagedTaskKey(agentKey)) return
      const title = this.resolveTaskTitle(agentKey)

      appendProactiveContext(COMPANION_AGENT_ID, t('taskmgr.ctx.confirm', {
        title,
        taskId: agentKey,
        tool: `${event.toolName}${event.displayName ? `（${event.displayName}）` : ''}`,
        risk: event.riskLevel,
        args: event.argsPreview,
        toolCallId: event.toolCallId,
      }), t('taskmgr.notice.confirm_title'))

      const notice = `⏳ ${t('taskmgr.notice.confirm', {
        title,
        action: event.displayName || event.toolName,
        risk: t(`taskmgr.risk.${event.riskLevel}`),
        args: event.argsPreview,
      })}`
      void deliverProactiveMessage(notice, {
        title: t('taskmgr.notice.confirm_title'),
        historyService: this.host.getHistoryService(),
      }).catch(err => log.warn('任务确认回流投递失败:', err))
    } catch (err) {
      log.warn('handleNeedsConfirmation 失败:', err)
    }
  }

  /**
   * 立即冲刷挂起的完成/失败事件（跳过防抖窗口），并等待投递落盘完成。
   * 供进程退出前调用（CLI 跑完即退，防抖挂起/异步投递未完成都会丢复命）；
   * 桌面常驻进程无需调用。
   *
   * 收尾竞态：任务 finalize 先置 isRunning=false、末尾才发完成事件，调用方观察到
   * 「全部空闲」时事件可能还在路上。因此冲刷后让出事件循环再复查一次，兜底晚到事件。
   */
  async flushPendingEvents(): Promise<void> {
    // 两轮：首轮冲刷（若有）后让出一拍，第二轮兜底 finalize 收尾窗口晚到的事件
    for (let round = 0; round < 2; round++) {
      if (this.finishFlushTimer) {
        clearTimeout(this.finishFlushTimer)
        this.finishFlushTimer = null
      }
      if (this.finishBuffer.length > 0) await this.flushFinishEvents()
      if (round === 0) await new Promise(resolve => setTimeout(resolve, 100))
    }
  }

  /**
   * 任务完成/失败/停止 → 防抖聚合后回流联络线复命（多条合并，不刷屏）。
   */
  handleRunFinished(agentKey: string | undefined, event: TaskRunFinishedEvent): void {
    try {
      if (!isManagedTaskKey(agentKey)) return
      this.finishBuffer.push({
        ...event,
        summary: this.truncate(event.summary, 200),
        agentKey,
        taskTitle: this.resolveTaskTitle(agentKey),
      })
      if (this.finishFlushTimer) clearTimeout(this.finishFlushTimer)
      this.finishFlushTimer = setTimeout(() => void this.flushFinishEvents(), FINISH_DEBOUNCE_MS)
      // 不拖住进程退出（CLI / 应用退出时挂起的防抖不应阻塞）
      this.finishFlushTimer.unref?.()
    } catch (err) {
      log.warn('handleRunFinished 失败:', err)
    }
  }

  // ==================== 内部 ====================

  /** 内存里没有、历史里还在的最近任务（同一 agentKey 只留最新一条） */
  private recentSettledTasks(liveKeys: Set<string>): SupervisedTaskInfo[] {
    const history = this.host.getHistoryService()
    if (!history) return []
    const seen = new Set<string>()
    const settled: SupervisedTaskInfo[] = []
    for (const summary of history.listAgentHistorySummaries(true)) {
      const agentKey = summary.agentKey
      if (!agentKey || liveKeys.has(agentKey) || seen.has(agentKey)) continue
      if (!isManagedTaskKey(agentKey)) continue
      seen.add(agentKey)
      settled.push({
        agentKey,
        title: this.titleFromHistory(summary.title, summary.userTask, agentKey),
        terminalType: summary.terminalType,
        isRunning: false,
        stepCount: 0,
        settled: summary.status,
      })
      if (settled.length >= SETTLED_TASK_LIMIT) break
    }
    return settled
  }

  private inspectSettledTask(agentKey: string, maxSteps: number): SupervisedTaskDetail | undefined {
    const record = this.host.getHistoryService()?.getLatestRecordByAgentKey(agentKey)
    if (!record || record.agentKey !== agentKey || !isManagedTaskKey(record.agentKey)) return undefined
    const steps = record.steps ?? []
    return {
      agentKey,
      title: this.titleFromHistory(record.title, record.userTask, agentKey),
      terminalType: record.terminalType,
      isRunning: false,
      stepCount: steps.length,
      settled: record.status,
      recentSteps: steps.slice(-Math.max(1, maxSteps)).map(s => this.summarizeStep(s)),
    }
  }

  private settledTitle(agentKey: string): string | undefined {
    const record = this.host.getHistoryService()?.getLatestRecordByAgentKey(agentKey)
    if (!record || record.agentKey !== agentKey) return undefined
    return this.titleFromHistory(record.title, record.userTask, agentKey)
  }

  private titleFromHistory(title: string | undefined, userTask: string, agentKey: string): string {
    const custom = title?.trim()
    if (custom) return custom
    const brief = userTask.replace(/\s+/g, ' ').trim()
    if (brief) return this.truncate(brief, 60)
    return agentKey.length > 16 ? `${agentKey.slice(0, 16)}…` : agentKey
  }

  private async flushFinishEvents(): Promise<void> {
    this.finishFlushTimer = null
    const events = this.finishBuffer.splice(0)
    if (events.length === 0) return

    const statusIcon = { success: '✅', failed: '❌', aborted: '⏹' } as const
    const statusText = {
      success: t('taskmgr.status_completed'),
      failed: t('taskmgr.status_failed'),
      aborted: t('taskmgr.status_aborted'),
    } as const
    const summaryOf = (e: { summary?: string }) => e.summary || t('taskmgr.notice.no_output')
    const lines = events.map(e => t('taskmgr.notice.finish_line', {
      icon: statusIcon[e.status], title: e.taskTitle, status: statusText[e.status], summary: summaryOf(e),
    }))
    const contextLines = events.map(e => t('taskmgr.ctx.finish_line', {
      title: e.taskTitle, taskId: e.agentKey, status: statusText[e.status], summary: summaryOf(e),
    }))

    appendProactiveContext(
      COMPANION_AGENT_ID,
      `${t('taskmgr.ctx.finish_header')}\n${contextLines.join('\n')}`,
      t('taskmgr.notice.report_title'),
    )

    const notice = events.length === 1
      ? t('taskmgr.notice.finish_one', {
          icon: statusIcon[events[0].status],
          title: events[0].taskTitle,
          status: statusText[events[0].status],
          summary: summaryOf(events[0]),
        })
      : t('taskmgr.notice.finish_many', { count: events.length, lines: lines.join('\n') })
    // alwaysPersist：复命是数据事件不是尽力通知——CLI 无窗口/IM 时 deliveredVia 为空，
    // 联络历史记录是它唯一留下的痕迹（下次联络运行冷启动恢复可见）
    await deliverProactiveMessage(notice, {
      title: t('taskmgr.notice.report_title'),
      historyService: this.host.getHistoryService(),
      alwaysPersist: true,
    }).catch(err => log.warn('任务复命投递失败:', err))
  }

  private buildTaskInfo(agentKey: string, agent: SailFish): SupervisedTaskInfo {
    const status = agent.getRunStatus()
    const pending = agent.getPendingConfirmationInfo()
    return {
      agentKey,
      title: this.resolveTaskTitle(agentKey),
      terminalType: agent.getTerminalType() ?? 'assistant',
      isRunning: status?.isRunning ?? false,
      phase: status?.phase,
      currentToolName: status?.currentToolName,
      stepCount: status?.stepCount ?? 0,
      pendingConfirmation: pending
        ? {
            toolCallId: pending.toolCallId,
            toolName: pending.toolName,
            riskLevel: pending.riskLevel,
            displayName: pending.displayName,
            argsPreview: pending.argsPreview,
          }
        : undefined,
    }
  }

  /** 展示标题：自定义标题 → 首条用户任务（截断）→ agentKey 前缀兜底 */
  private resolveTaskTitle(agentKey: string): string {
    const agent = this.host.getAgent(agentKey)
    const custom = agent?.getConversationTitle()
    if (custom) return custom
    const firstTask = agent?.getSessionStepsSnapshot().find(s => s.type === 'user_task')?.content
    if (firstTask) return this.truncate(firstTask.replace(/\s+/g, ' ').trim(), 60)
    return agentKey.length > 16 ? `${agentKey.slice(0, 16)}…` : agentKey
  }

  private summarizeStep(step: { timestamp: number; type: string; toolName?: string; content?: string }): string {
    const time = new Date(step.timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
    const namePart = step.toolName ? ` ${step.toolName}` : ''
    const content = this.truncate((step.content || '').replace(/\s+/g, ' ').trim(), 160)
    return `[${time}] ${step.type}${namePart}: ${content}`
  }

  private truncate(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max)}…` : text
  }

  /** 通知前端建 tab 并自动执行；返回是否有窗口可送达（CLI 无窗口返回 false） */
  private notifyFrontendTaskCreated(payload: {
    agentId: string
    title: string
    brief: string
    fullAuto: boolean
  }): boolean {
    return this.sendToFrontend('agent:taskCreated', payload)
  }

  /** 通知前端在原来那场上接着做；无窗口时由调用方直驱 */
  private notifyFrontendTaskContinue(payload: {
    agentId: string
    message: string
    title: string
    terminalType: TerminalType
    sessionId?: string
    sessionStartTime?: number
    sshHost?: string
  }): boolean {
    return this.sendToFrontend('agent:taskContinue', payload)
  }

  private sendToFrontend(channel: string, payload: unknown): boolean {
    try {
      const electron = require('electron')
      const win = electron.BrowserWindow?.getAllWindows?.()?.[0]
      if (win && !win.isDestroyed()) {
        win.webContents.send(channel, payload)
        return true
      }
    } catch (e) {
      log.debug(`${channel} 不可用（CLI 或无窗口）:`, e)
    }
    return false
  }

  private historyRecord(agentKey: string) {
    const record = this.host.getHistoryService()?.getLatestRecordByAgentKey(agentKey)
    if (!record || record.agentKey !== agentKey || !isManagedTaskKey(record.agentKey)) return undefined
    return record
  }
}
