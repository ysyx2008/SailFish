/**
 * 任务监督（TaskSupervisor）——联络任务管理门面
 *
 * 联络（companion）作为任务 Agent 的总管（Supervisor 模式）：
 * - 查询：枚举任务列表 / 查看单个任务近况（manage_tasks 工具的 list/inspect）
 * - 操作：创建任务、停止任务、再交代、传达用户对危险确认的批准/拒绝（create/stop/instruct/confirm）
 * - 回执：联络开头的那一轮（新建或再交代）做完 / 失败 / 被停 / 要确认 / 向用户提问 → 只交给联络。
 *   用户自己开头的那一轮什么都不送。
 *
 * 信任模型（转述制）：联络永不自行批准危险操作——只把确认请求转述给用户，
 * 再把用户的决定传达给任务。唯一例外是用户创建任务时显式声明「全自动」。
 *
 * 上下文隔离红线：向联络提供的永远是摘要（标题/状态/最近步骤一行截断），
 * 任务对话内容不进联络上下文。
 *
 * 事件源过滤：仅 kind=task 的会话冒泡；companion/watch/wakeup 自身不回流（防循环）。
 * 任务分出去的帮手（身份键里的 :sub:）也不是任务，不进列表、不回流。
 * 内存里已经没有的任务，从历史索引补已结束的摘要；列表分页，可按关键字 / 最后活跃日期找。
 */
import { v4 as uuidv4 } from 'uuid'
import { inferConversationKind, type AgentHistorySummary, type ApprovalMode, type AssignedBy, type RiskLevel, type TerminalType } from '@shared/types'
import { createLogger } from '../../utils/logger'
import { t } from './i18n'
import { getDefaultShell, getLocalOS } from '../../utils/platform'
import type { HistoryService } from '../history.service'
import type { ConfigService } from '../config.service'
import type { AgentContext, AgentConfig, TaskReceiptText } from './types'
import type { SailFish } from './sailfish'

const log = createLogger('TaskSupervisor')

/** 完成/失败事件的防抖窗口：短时间多条合并成一份回执，联络少起几轮 */
const FINISH_DEBOUNCE_MS = 5000

/** 回执里结果概要的长度上限（联络只拿摘要，任务对话不进联络上下文） */
const RECEIPT_SUMMARY_MAX = 500

/** 联络这一轮最多为一个任务等这么久（同后台命令默认的上限）；宿主可改（命令行的 --task-wait） */
const DEFAULT_RECEIPT_WAIT_MS = 60 * 60_000

/** 刚派出去的头一阵：开跑是异步的，这段时间里看不到在跑也不算没了 */
const OWED_START_GRACE_MS = 30_000

/** 界面上回执里要确认的参数只露个头，全文在联络读到的回执里 */
const RECEIPT_DISPLAY_ARGS_MAX = 200

/** 回执里的一件事：给联络读的一行，和界面上给用户看的一句 */
interface ReceiptLine {
  line: string
  display: string
}

/** 任务结束的那件事：交出去之后要给那场销账 */
interface FinishedReceiptLine extends ReceiptLine {
  agentKey: string
}

/** 谁开的这一轮：联络经任务管理开的头才有回执 */
type LedBy = AssignedBy | undefined

/** 任务列表每页条数 */
const TASK_PAGE_SIZE = 20

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
  ledBy?: LedBy
}

/** 任务运行结束事件载荷 */
export interface TaskRunFinishedEvent {
  status: 'success' | 'failed' | 'aborted'
  /** 结果或错误概要（已截断） */
  summary: string
  ledBy?: LedBy
}

/** 任务这一轮向用户提问 */
export interface TaskAskingEvent {
  question: string
  options: string[]
  ledBy?: LedBy
}

/** 任务摘要（manage_tasks list 的单项） */
export interface SupervisedTaskInfo {
  agentKey: string
  title: string
  terminalType: TerminalType
  isRunning: boolean
  phase?: string
  currentToolName?: string
  /** 只在看得到这场全部步骤时才有：列表从历史目录补进来的条目不打开正文，不报 */
  stepCount?: number
  /** 这场任务的结局：在眼前的和只在历史里的说一样的话。正在跑、等确认的，以及还没做过任何事的没有这个字段 */
  settled?: 'completed' | 'failed' | 'aborted'
  pendingConfirmation?: {
    toolCallId: string
    toolName: string
    riskLevel: RiskLevel
    displayName?: string
    argsPreview: string
  }
}

/** 任务列表的查询条件：都不给时列全部 */
export interface TaskListQuery {
  /** 第几页，从 1 开始 */
  page?: number
  /** 关键字，范围同历史搜索 */
  keyword?: string
  /** 按最后活跃那天筛（与侧栏分组一致），格式同历史搜索 */
  startDate?: string
  endDate?: string
}

/** 任务列表的一页（manage_tasks list 的返回） */
export interface TaskListPage {
  tasks: SupervisedTaskInfo[]
  /** 符合条件的任务总数 */
  total: number
  page: number
  pageCount: number
  pageSize: number
}

/** 任务近况（manage_tasks inspect 的返回） */
export interface SupervisedTaskDetail extends SupervisedTaskInfo {
  stepCount: number
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
  /** 往一场对话里说一句——与用户在界面上说话是同一个入口：在跑就补进去，否则开新一轮 */
  say(
    agentKey: string,
    message: string,
    context: AgentContext,
    opts: { surface: 'assistant' | 'terminal'; config?: Partial<AgentConfig>; ledBy?: AssignedBy }
  ): Promise<unknown>
  /** 把回执交给联络：它这一轮还开着就送进这一轮，否则另起一轮 */
  deliverCompanionReceipt(receipt: TaskReceiptText): void
  /** 欠回执的账被清掉、却没有回执送来时，叫醒联络在等的那一轮重新看一遍还要不要等 */
  wakeCompanionWait(): void
  getHistoryService(): HistoryService | undefined
  getConfigService(): ConfigService | undefined
  /** 创建任务实例，锁住交办标题，定下这场的审批方式，记下是谁派的 */
  prepareAssignedTask(agentId: string, title: string, approval: ApprovalMode, assignedBy: AssignedBy): void
}

export class TaskSupervisor {
  private host: TaskSupervisorHost
  /** 已排成回执行、还在防抖窗口里的完成事件（带上是哪场，交出去后好销账） */
  private finishBuffer: FinishedReceiptLine[] = []
  /** 联络开头的那一轮还没交回执的任务 → 派出的时刻。联络那一轮据此决定要不要继续等 */
  private readonly owed = new Map<string, number>()
  private finishFlushTimer: NodeJS.Timeout | null = null
  /** 宿主整体全自动（命令行 --free）：交办的任务也不问 */
  private fullAutoAssigned = false
  /** 联络这一轮为一个任务最多等多久；0 = 不等 */
  private receiptWaitLimitMs = DEFAULT_RECEIPT_WAIT_MS

  constructor(host: TaskSupervisorHost) {
    this.host = host
  }

  setFullAutoForAssignedTasks(on: boolean): void {
    this.fullAutoAssigned = on
  }

  /** 联络这一轮为一个任务最多等多久（毫秒）。0 = 派完就收工，回执另起一轮送来 */
  setReceiptWaitLimit(ms: number): void {
    this.receiptWaitLimitMs = Math.max(0, ms)
  }

  // ==================== 查询 ====================

  /** 内存里的受管任务（待确认 > 运行中 > 空闲） */
  listLiveTasks(): SupervisedTaskInfo[] {
    const rank = (t: SupervisedTaskInfo) => t.pendingConfirmation ? 0 : t.isRunning ? 1 : 2
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
    return tasks.sort((a, b) => rank(a) - rank(b))
  }

  /**
   * 任务列表的一页：内存里的排最前（待确认 > 运行中 > 空闲），其余按最后活跃从历史补，
   * 同一任务只出现一次。给了关键字或日期时，只留历史搜索命中的那些。
   */
  async listTasks(query: TaskListQuery = {}): Promise<TaskListPage> {
    const live = this.listLiveTasks()
    const keyword = query.keyword?.trim()
    const filtering = !!(keyword || query.startDate || query.endDate)

    let summaries: AgentHistorySummary[] = []
    try {
      summaries = await this.searchHistory({ ...query, keyword }, filtering)
    } catch (err) {
      log.warn('从历史补任务列表失败:', err)
    }

    const liveByKey = new Map(live.map(t => [t.agentKey, t]))
    const hitKeys = new Set(summaries.map(s => s.agentKey))
    const head = filtering ? live.filter(t => hitKeys.has(t.agentKey)) : live
    const seen = new Set(liveByKey.keys())
    const rest: SupervisedTaskInfo[] = []
    for (const summary of summaries) {
      const agentKey = summary.agentKey
      if (!isManagedTaskKey(agentKey) || seen.has(agentKey)) continue
      seen.add(agentKey)
      rest.push({
        agentKey,
        title: this.titleFromHistory(summary.title, summary.userTask, agentKey),
        terminalType: summary.terminalType,
        isRunning: false,
        settled: summary.status,
      })
    }

    const all = [...head, ...rest]
    const pageCount = Math.max(1, Math.ceil(all.length / TASK_PAGE_SIZE))
    const page = Number.isFinite(query.page) ? Math.max(1, Math.floor(query.page!)) : 1
    return {
      tasks: all.slice((page - 1) * TASK_PAGE_SIZE, page * TASK_PAGE_SIZE),
      total: all.length,
      page,
      pageCount,
      pageSize: TASK_PAGE_SIZE,
    }
  }

  /** 单个任务近况：内存里有就看内存；没有则从历史读最近步骤摘要 */
  inspectTask(agentKey: string, maxSteps = 8): SupervisedTaskDetail | undefined {
    if (!isManagedTaskKey(agentKey)) return undefined
    const agent = this.host.getAgent(agentKey)
    if (agent) {
      // 连正在跑的这一轮一起看；步数和明细出自同一份，对得上
      const steps = agent.getLiveStepsSnapshot()
      const recentSteps = steps.slice(-Math.max(1, maxSteps)).map(s => this.summarizeStep(s))
      return { ...this.buildTaskInfo(agentKey, agent), stepCount: steps.length, recentSteps }
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
    const terminalType = agent?.getTerminalType() || record?.terminalType || 'assistant'
    if (!agent && terminalType === 'ssh') {
      return { ok: false, reason: 'terminal_closed', title }
    }

    // 只用来回报「当场听见 / 下一轮」，补话还是开新一轮由那场对话自己决定
    const status = agent?.getRunStatus()
    const running = !!status?.isRunning
    const delivered = running ? 'now' : 'next'
    // 在跑的那一轮若是用户开的头，补一句不改它的归属，也就不欠联络回执
    const wasOwed = this.owed.has(agentKey)
    if (!running || status?.ledBy === 'companion') this.owed.set(agentKey, Date.now())
    const sessionId = agent?.getSessionId() || record?.id
    const context: AgentContext = {
      ...this.contextWithoutWindow(terminalType),
      ...(sessionId ? { sessionId } : {}),
      ...(record?.timestamp ? { sessionStartTime: record.timestamp } : {}),
      ...(record?.sshHost ? { sshHost: record.sshHost } : {}),
    }
    this.host.say(agentKey, text, context, {
      surface: terminalType === 'assistant' ? 'assistant' : 'terminal',
      config: agent ? undefined : this.runConfig(),
      ledBy: 'companion',
    }).catch(err => {
      if (!wasOwed) {
        this.owed.delete(agentKey)
        this.wakeCompanionWait()
      }
      log.error(`再交代失败 (${agentKey}):`, err)
    })
    return { ok: true, title, delivered }
  }

  /**
   * 创建任务（一期仅无终端助手形态）：新开一场助手对话，把简报作为第一句说进去。
   * 和用户在界面上新开一场是同一个入口；打开着的界面会把这场认领到侧栏。
   */
  async createTask(opts: CreateTaskOptions): Promise<{ agentKey: string; fullAuto: boolean }> {
    const agentId = `assistant-${uuidv4()}`
    const fullAuto = opts.fullAuto === true || this.fullAutoAssigned
    // 等于用户在那场里选：没说全自动就是替我审批；只管这一场，不改起步值
    this.host.prepareAssignedTask(agentId, opts.title, fullAuto ? 'free' : 'autoReview', 'companion')
    this.owed.set(agentId, Date.now())
    this.host.say(agentId, opts.brief, this.contextWithoutWindow('assistant'), {
      surface: 'assistant',
      config: this.runConfig(),
      ledBy: 'companion',
    }).catch(err => {
      this.owed.delete(agentId)
      this.wakeCompanionWait()
      log.error(`任务执行失败 (${agentId}):`, err)
    })
    return { agentKey: agentId, fullAuto }
  }

  /**
   * 联络开头的这场任务，回执还没交给联络。联络那一轮据此决定要不要继续等。
   * 三种情形不再算欠：回执已经交出去、等了超过上限、头一阵之后既没在跑也没有排着的完成事件
   * （比如重启过，或开跑失败）。
   */
  isOwed(agentKey: string): boolean {
    const since = this.owed.get(agentKey)
    if (since === undefined) return false
    const age = Date.now() - since
    if (age >= this.receiptWaitLimitMs) {
      this.owed.delete(agentKey)
      return false
    }
    if (age >= OWED_START_GRACE_MS && !this.finishBuffer.some(e => e.agentKey === agentKey)) {
      let running = false
      try {
        running = !!this.host.getAgent(agentKey)?.getRunStatus()?.isRunning
      } catch {
        // 状态读不出来按没在跑算：宁可少等，不能卡死联络这一轮
      }
      if (!running) {
        this.owed.delete(agentKey)
        return false
      }
    }
    return true
  }

  // ==================== 回执（Agent 基类挂钩调用） ====================

  /**
   * 任务的危险确认请求。联络开头的那一轮：连同防抖窗口里攒着的完成事件，立刻交给联络转述。
   * 回执里带全部 ID，用户答复后联络凭此调 manage_tasks confirm。
   */
  handleNeedsConfirmation(agentKey: string | undefined, event: TaskNeedsConfirmationEvent): void {
    try {
      if (!isManagedTaskKey(agentKey) || event.ledBy !== 'companion') return
      const title = this.resolveTaskTitle(agentKey)
      const risk = t(`taskmgr.risk.${event.riskLevel}`)
      this.deliverNow({
        line: t('taskmgr.receipt.confirm_line', {
          title,
          taskId: agentKey,
          tool: `${event.toolName}${event.displayName ? `（${event.displayName}）` : ''}`,
          risk,
          args: event.argsPreview,
          toolCallId: event.toolCallId,
        }),
        display: t('taskmgr.receipt.display.confirm', {
          title,
          action: event.displayName || event.toolName,
          risk,
          args: this.truncate(event.argsPreview, RECEIPT_DISPLAY_ARGS_MAX),
        }),
      })
    } catch (err) {
      log.warn('handleNeedsConfirmation 失败:', err)
    }
  }

  /** 任务向用户提问。联络开头的那一轮：立刻交给联络转述，用户的答复由联络经 instruct 送回 */
  handleAsking(agentKey: string | undefined, event: TaskAskingEvent): void {
    try {
      if (!isManagedTaskKey(agentKey) || event.ledBy !== 'companion') return
      const options = event.options.length > 0
        ? t('taskmgr.receipt.ask_options', { options: event.options.join(' / ') })
        : ''
      const title = this.resolveTaskTitle(agentKey)
      const question = this.truncate(event.question.replace(/\s+/g, ' ').trim(), RECEIPT_SUMMARY_MAX)
      this.deliverNow({
        line: t('taskmgr.receipt.ask_line', { title, taskId: agentKey, question }) + options,
        display: t('taskmgr.receipt.display.ask', { title, question }) + options,
      })
    } catch (err) {
      log.warn('handleAsking 失败:', err)
    }
  }

  /**
   * 立即冲刷防抖窗口里的完成事件。供进程退出前调用（CLI 跑完即退，挂起的防抖会丢回执）；
   * 桌面常驻进程无需调用。
   *
   * 收尾竞态：任务 finalize 先置 isRunning=false、末尾才发完成事件，调用方观察到
   * 「全部空闲」时事件可能还在路上。因此冲刷后让出事件循环再复查一次，兜底晚到事件。
   */
  async flushPendingEvents(): Promise<void> {
    for (let round = 0; round < 2; round++) {
      this.flushFinishEvents()
      if (round === 0) await new Promise(resolve => setTimeout(resolve, 100))
    }
  }

  /** 任务完成 / 失败 / 被停。联络开头的那一轮：防抖合并后交给联络 */
  handleRunFinished(agentKey: string | undefined, event: TaskRunFinishedEvent): void {
    try {
      if (!isManagedTaskKey(agentKey) || event.ledBy !== 'companion') return
      const statusText = {
        success: t('taskmgr.status_completed'),
        failed: t('taskmgr.status_failed'),
        aborted: t('taskmgr.status_aborted'),
      } as const
      const title = this.resolveTaskTitle(agentKey)
      const status = statusText[event.status]
      const summary = this.truncate(event.summary.trim(), RECEIPT_SUMMARY_MAX) || t('taskmgr.receipt.no_output')
      this.finishBuffer.push({
        agentKey,
        line: t('taskmgr.receipt.finish_line', { title, taskId: agentKey, status, summary }),
        display: t('taskmgr.receipt.display.finish', { title, status, summary }),
      })
      if (this.finishFlushTimer) clearTimeout(this.finishFlushTimer)
      this.finishFlushTimer = setTimeout(() => this.flushFinishEvents(), FINISH_DEBOUNCE_MS)
      // 不拖住进程退出（CLI / 应用退出时挂起的防抖不应阻塞）
      this.finishFlushTimer.unref?.()
    } catch (err) {
      log.warn('handleRunFinished 失败:', err)
    }
  }

  // ==================== 内部 ====================

  private flushFinishEvents(): void {
    if (this.finishFlushTimer) {
      clearTimeout(this.finishFlushTimer)
      this.finishFlushTimer = null
    }
    if (this.finishBuffer.length === 0) return
    this.deliverReceipt(this.finishBuffer.splice(0), [])
  }

  /** 要用户拿主意的事不等防抖；攒着的完成事件一并带上，免得联络为它们再起一轮 */
  private deliverNow(entry: ReceiptLine): void {
    if (this.finishFlushTimer) {
      clearTimeout(this.finishFlushTimer)
      this.finishFlushTimer = null
    }
    this.deliverReceipt(this.finishBuffer.splice(0), [entry])
  }

  /**
   * 交出去之后，那几场任务就不再欠回执（提问 / 确认事件不销账：任务还没做完）。
   * 没投出去时账照样销（回执丢了，继续等也等不来），并叫醒联络在等的那一轮，免得它空等到下一个检查点。
   */
  private deliverReceipt(finished: FinishedReceiptLine[], extra: ReceiptLine[]): void {
    const entries = [...finished, ...extra]
    let delivered = false
    try {
      this.host.deliverCompanionReceipt({
        body: [t('taskmgr.receipt.header'), ...entries.map(e => e.line)].join('\n'),
        footerWhenPresent: t('taskmgr.receipt.footer_present'),
        footerWhenAway: t('taskmgr.receipt.footer_away'),
        display: entries.map(e => e.display).join('\n'),
      })
      delivered = true
    } catch (err) {
      log.warn('任务回执投递失败:', err)
    }
    for (const entry of finished) this.owed.delete(entry.agentKey)
    if (!delivered) this.wakeCompanionWait()
  }

  /** 叫醒联络在等的那一轮；宿主出错不连累清账 */
  private wakeCompanionWait(): void {
    try {
      this.host.wakeCompanionWait()
    } catch (err) {
      log.warn('叫醒联络失败:', err)
    }
  }

  /** 历史里的任务会话摘要，按最后活跃从新到旧（同一任务可能有多条，由调用方去重） */
  private async searchHistory(query: TaskListQuery, filtering: boolean): Promise<AgentHistorySummary[]> {
    const history = this.host.getHistoryService()
    if (!history) return []
    if (!filtering) return history.listAgentHistorySummaries(true)
    return history.searchAgentHistorySummaries({
      keyword: query.keyword,
      startDate: query.startDate,
      endDate: query.endDate,
      dateBy: 'lastActive',
      filter: r => isManagedTaskKey(r.agentKey),
    })
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

  private titleFromHistory(title: string | undefined, userTask: string | undefined, agentKey: string): string {
    const custom = title?.trim()
    if (custom) return custom
    const brief = (userTask ?? '').replace(/\s+/g, ' ').trim()
    if (brief) return this.truncate(brief, 60)
    return agentKey.length > 16 ? `${agentKey.slice(0, 16)}…` : agentKey
  }

  private buildTaskInfo(agentKey: string, agent: SailFish): SupervisedTaskInfo & { stepCount: number } {
    const status = agent.getRunStatus()
    const pending = agent.getPendingConfirmationInfo()
    const isRunning = status?.isRunning ?? false
    const settled = isRunning || pending ? undefined : agent.getOutcome()
    return {
      agentKey,
      title: this.resolveTaskTitle(agentKey),
      terminalType: agent.getTerminalType() ?? 'assistant',
      isRunning,
      phase: status?.phase,
      currentToolName: status?.currentToolName,
      stepCount: status?.stepCount ?? 0,
      ...(settled ? { settled } : {}),
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
    const firstTask = agent?.getLiveStepsSnapshot().find(s => s.type === 'user_task')?.content
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

  /** 不是从哪扇窗里说的：只知道本机环境，目录由那场对话开跑时自己定 */
  private contextWithoutWindow(terminalType: TerminalType): AgentContext {
    return {
      terminalOutput: [],
      systemInfo: { os: getLocalOS(), shell: getDefaultShell() },
      terminalType,
      remoteChannel: 'desktop',
    }
  }

  /** 新开一轮时的运行设置。审批方式不在这里：它是那场对话自己的 */
  private runConfig(): Partial<AgentConfig> {
    return {
      enabled: true,
      maxSteps: 0,
      commandTimeout: 30000,
      autoExecuteSafe: true,
      autoExecuteModerate: true,
      debugMode: this.host.getConfigService()?.getAgentDebugMode() ?? false,
    }
  }

  private historyRecord(agentKey: string) {
    const record = this.host.getHistoryService()?.getLatestRecordByAgentKey(agentKey)
    if (!record || record.agentKey !== agentKey || !isManagedTaskKey(record.agentKey)) return undefined
    return record
  }
}
