/**
 * Agent 服务
 * 
 * OOP 重构版本：AgentService 作为工厂和生命周期管理器
 * 实际执行逻辑在 Agent 基类和 SailFish 子类中
 */
import os from 'os'
import type { AiService, AiMessage } from '../ai.service'
import type { PtyService } from '../pty.service'
import type { SshService } from '../ssh.service'
import type { SftpService } from '../sftp.service'
import type { McpService } from '../mcp.service'
import type { ConfigService } from '../config.service'
import { UnifiedTerminalService } from '../unified-terminal.service'

import type {
  AgentConfig,
  AgentStep,
  AgentContext,
  AgentCallbacks,
  HostProfileServiceInterface,
  RiskLevel,
  AgentServices,
  RunStatus,
  AgentExecutionPhase,
  CommandRiskPolicy,
  CompactContextResult,
  TerminalType,
} from './types'
import type { VisibleConversationSkill } from '@shared/types'
import { SailFish } from './sailfish'
import { ConversationStore, ConversationManager, Companion, Conversation } from '../conversation'
import { assessCommandRisk, analyzeCommand } from './risk-assessor'
import type { CommandHandlingInfo } from './risk-assessor'
import { setConfigService as setI18nConfigService } from './i18n'
import { getTerminalStateService } from '../terminal-state.service'
import { createLogger } from '../../utils/logger'
import { conversationRootId } from './skills/browser/session-key'
import { setAttachLockRunningChecker } from './skills/browser/bridge-session'

const log = createLogger('AgentService')

// 重新导出类型，供外部使用
export type {
  AgentConfig,
  AgentStep,
  AgentContext,
  RiskLevel,
  CommandHandlingInfo,
  AgentServices,
  RunStatus
}
export { assessCommandRisk, analyzeCommand }

// 导出 Agent 类
export { Agent } from './agent'
export { SailFish } from './sailfish'
/** @deprecated Use SailFish instead */
export { SailFish as TerminalAgent } from './sailfish'

/**
 * Agent 服务 - 工厂和生命周期管理器
 * 
 * 概念模型（v2）：一个 tab = 一个 Agent + N 个终端窗格。
 *   - 终端 Agent：agentKey = tabId（前端的 tab.id，跨多个窗格稳定）
 *   - 助手 Agent：agentKey = agentId（前端生成的 UUID）
 *   - 固定 Agent：__companion__（IM/桌面）、__watch__（关切）、__wakeup__（唤醒/心跳）
 *
 * Agent 实例的生命周期独立于底层 PTY/SSH。窗格关闭、SSH 断开都不应清理 Agent；
 * 只在 tab 关闭时由前端显式调 cleanupAgent(tabId) 清理。
 *
 * 职责：
 * - 创建和管理 SailFish 实例
 * - 管理全局回调
 */
export class AgentService {
  /** 陪伴 Agent 固定 ID：IM 对话、桌面助手共用同一实例 */
  static readonly COMPANION_AGENT_ID = '__companion__'
  /** Watch Agent key 前缀（legacy 整 key `__watch__`）；并发后每关切用 `watchAgentKeyFor(id)` → `__watch__:${id}` */
  static readonly WATCH_AGENT_ID = '__watch__'

  /** Agent 实例映射（按 agentKey 索引：终端 Agent 用 tabId，助手/固定 Agent 用 agentId） */
  private agents: Map<string, SailFish> = new Map()

  /** Companion 单例（关系线领域对象，setHistoryService 时装配）。 */
  private _companion?: Companion

  /** 依赖服务集合 */
  private services: AgentServices
  
  /** 默认回调 */
  private defaultCallbacks: AgentCallbacks = {}

  private skillsChangedListeners: Array<(agentKey: string, skills: VisibleConversationSkill[]) => void> = []

  constructor(
    aiService: AiService, 
    ptyService: PtyService,
    hostProfileService?: HostProfileServiceInterface,
    mcpService?: McpService,
    configService?: ConfigService,
    sshService?: SshService,
    sftpService?: SftpService
  ) {
    // 创建统一终端服务
    let unifiedTerminalService: UnifiedTerminalService | undefined
    if (sshService) {
      unifiedTerminalService = new UnifiedTerminalService(ptyService, sshService)
    }
    
    // 组装服务集合
    this.services = {
      aiService,
      ptyService,
      sshService,
      sftpService,
      unifiedTerminalService,
      hostProfileService,
      mcpService,
      configService
    }
    
    // 初始化 i18n
    if (configService) {
      setI18nConfigService(configService)
    }

    setAttachLockRunningChecker((rootId) => this.isConversationRunning(rootId))
  }
  
  // ==================== 服务设置（延迟初始化） ====================

  /**
   * 设置 SSH 服务
   */
  setSshService(sshService: SshService): void {
    this.services.sshService = sshService
    if (this.services.ptyService) {
      this.services.unifiedTerminalService = new UnifiedTerminalService(
        this.services.ptyService, 
        sshService
      )
    }
  }

  /**
   * 设置 SFTP 服务
   */
  setSftpService(sftpService: SftpService): void {
    this.services.sftpService = sftpService
  }

  /**
   * 设置 MCP 服务
   */
  setMcpService(mcpService: McpService): void {
    this.services.mcpService = mcpService
  }

  /**
   * 设置历史记录服务
   */
  setHistoryService(historyService: import('../history.service').HistoryService): void {
    this.services.historyService = historyService
    // 随 historyService 一并装配会话策略 / 查询接缝（按 kind 决策回种、会话查询委托）。
    // ConversationStore 现在直接包 AgentRecordStore（会话存储聚合），不再伸手进 HistoryService 这个大类。
    this.services.conversationManager = new ConversationManager(
      new ConversationStore(historyService.getAgentRecordStore())
    )
    // 装配 Companion 单例（关系线领域对象，封装 companion → task 抽取等流程）。
    // 当前为轻量版，只收口 fork 重构所需的 extractTask；后续工程搬迁合并视图/主动消息至此。
    this._companion = new Companion(historyService)
  }

  /**
   * 取会话管理器（读侧权威：会话 list/search/get/delete + kind 策略）。
   * 供 main.ts 的 history:* 读侧 IPC handler 走统一接缝，而非各处直接调 HistoryService。
   * 仅在 `setHistoryService` 后可用。
   */
  getConversationManager(): ConversationManager | undefined {
    return this.services.conversationManager
  }

  /**
   * 取 companion 关系线的合并视图 record（供联络 tab 重启后恢复历史展示）。
   * 薄转发到 `Companion.getMergedViewRecord`——companion 未装配（setHistoryService 未跑）返回 undefined。
   */
  getCompanionMergedViewRecord(): import('../history.service').AgentRecord | undefined {
    if (!this._companion) return undefined
    return this._companion.getMergedViewRecord() ?? undefined
  }

  /**
   * 设置插件注册表
   */
  setPluginRegistry(pluginRegistry: import('../plugin/registry').PluginRegistry): void {
    this.services.pluginRegistry = pluginRegistry
  }

  // ==================== 工厂方法 ====================

  /**
   * 把 ConfigService 中的 commandRiskPolicy 注入 Agent。
   * 仅在 Agent 新建时调用一次（默认值）；后续用户改 policy 后通过 updateConfig 覆盖。
   */
  private bindSkillsChangedHook(agentKey: string, agent: SailFish): void {
    agent.setSkillsChangedHook(() => {
      const skills = agent.listVisibleSkills()
      for (const listener of this.skillsChangedListeners) {
        listener(agentKey, skills)
      }
    })
  }

  onSkillsChanged(listener: (agentKey: string, skills: VisibleConversationSkill[]) => void): () => void {
    this.skillsChangedListeners.push(listener)
    return () => {
      this.skillsChangedListeners = this.skillsChangedListeners.filter(l => l !== listener)
    }
  }

  private applyDefaultCommandRiskPolicy(agent: SailFish): void {
    const cs = this.services.configService
    if (!cs) return
    try {
      agent.commandRiskPolicy = cs.getCommandRiskPolicy()
    } catch (err) {
      log.warn('Failed to apply default commandRiskPolicy:', err)
    }
  }

  /**
   * 获取或创建 Agent 实例
   *
   * @param agentKey Agent 标识符。终端 Agent 传 tabId，固定 Agent 传 __companion__/__watch__。
   *   形参名保留为 ptyId 仅为向后兼容；新代码请按 agentKey 语义传入。
   */
  getOrCreateAgent(ptyId: string): SailFish {
    let agent = this.agents.get(ptyId)
    if (!agent) {
      agent = new SailFish(this.services)
      agent.setAgentId(ptyId)
      agent.setCallbacks(this.defaultCallbacks)
      this.applyDefaultCommandRiskPolicy(agent)
      this.agents.set(ptyId, agent)
      log.info(`Created agent: agentKey=${ptyId}`)
    }
    this.bindSkillsChangedHook(ptyId, agent)
    return agent
  }

  /**
   * 获取 Agent 实例（不创建）
   * @param ptyId 实际语义为 agentKey（终端 = tabId，助手 = agentId UUID）
   */
  getAgent(ptyId: string): SailFish | undefined {
    return this.agents.get(ptyId)
  }

  /**
   * 按 sessionId 设置展示标题：同步所有匹配的 in-memory Conversation，并轻量落盘。
   * 标题未变化时不写盘。
   */
  setConversationTitleBySessionId(
    sessionId: string,
    title: string,
    opts?: { locked?: boolean }
  ): boolean {
    const trimmed = title.trim()
    if (!sessionId || !trimmed) return false

    for (const agent of this.agents.values()) {
      if (agent.getSessionId() === sessionId) {
        agent.setConversationTitle(trimmed, opts)
      }
    }

    const history = this.services.historyService
    if (history) {
      return history.updateConversationTitle(sessionId, trimmed, opts)
    }
    return true
  }

  /**
   * 检查是否存在 Agent 实例
   * @param ptyId 实际语义为 agentKey
   */
  hasAgent(ptyId: string): boolean {
    return this.agents.has(ptyId)
  }

  /**
   * 是否存在正在运行（ReAct 循环执行中）的 Agent。
   * 覆盖终端 / 助手 / Watch / IM 等所有 Agent 实例。
   * 用于数据目录迁移前提示用户：重启会中断进行中的任务。
   */
  hasRunningAgents(): boolean {
    return Array.from(this.agents.values()).some(agent => agent.isRunning())
  }

  /**
   * 这场对话（含伙计）是否还有人在跑。
   * 吸附锁用：占着用户浏览器的那场还在跑，别的对话不能抢。
   */
  isConversationRunning(rootId: string): boolean {
    const root = conversationRootId(rootId)
    for (const [key, agent] of this.agents) {
      if (conversationRootId(key) === root && agent.isRunning()) return true
    }
    return false
  }
  
  /**
   * 创建独立助手 Agent（无终端绑定）
   *
   * 注：是否为「持久命名 Agent」（固定 ID、跨重启回种历史）不再由这里手动 mark，而是由
   * Agent 按 `agentId → inferConversationKind → CONVERSATION_POLICY` 自决（companion/watch=true）。
   */
  createAssistantAgent(agentId: string): SailFish {
    let agent = this.agents.get(agentId)
    if (!agent) {
      agent = new SailFish(this.services)
      agent.setAgentId(agentId)
      agent.setCallbacks(this.defaultCallbacks)
      this.applyDefaultCommandRiskPolicy(agent)
      this.agents.set(agentId, agent)
      log.info(`Created assistant agent: ${agentId} (persistentNamed=${agent.isPersistentNamedAgent()})`)
    }
    this.bindSkillsChangedHook(agentId, agent)
    return agent
  }

  /**
   * Fork（同质分叉）：从一个已存在的 task Agent 会话分叉出一个新的助手 Agent。
   *
   * @deprecated 新代码请用 `forkTask`——语义更清晰（task → task 同质分叉，区别于
   * companion → task 的 `extractTaskFromCompanion`）。本方法保留为薄转发，兼容现有调用点。
   */
  async forkAgent(opts: {
    sourceAgentKey: string
    newAgentId: string
    untilTaskCount?: number
    targetMode?: 'assistant'
    titleSuffix?: string
    sourceSessionId?: string
  }): Promise<{
    newSessionId: string
    newAgentId: string
    sourceUserTask: string
    newRecord: import('../history.service').AgentRecord
  } | null> {
    // companion 走 extractTaskFromCompanion（异质转化）；task 走 forkTask（同质分叉）。
    if (opts.sourceAgentKey === AgentService.COMPANION_AGENT_ID) {
      // untilTaskCount 是旧语义（截止到第 N 个，1-based）；新语义 anchorTaskIndex 是 0-based 锚点位置。
      // untilTaskCount = group.index + 1 → anchorTaskIndex = untilTaskCount - 1
      const anchorTaskIndex = opts.untilTaskCount !== undefined ? opts.untilTaskCount - 1 : undefined
      const result = await this.extractTaskFromCompanion({
        newAgentId: opts.newAgentId,
        anchorTaskIndex,
        titleSuffix: opts.titleSuffix
      })
      if (!result) return null
      return {
        newSessionId: result.newSessionId,
        newAgentId: result.newAgentId,
        sourceUserTask: result.sourceUserTask,
        newRecord: result.newRecord
      }
    }
    return this.forkTask({
      sourceAgentKey: opts.sourceAgentKey,
      newAgentId: opts.newAgentId,
      untilTaskCount: opts.untilTaskCount,
      titleSuffix: opts.titleSuffix,
      sourceSessionId: opts.sourceSessionId
    })
  }

  /**
   * 同质分叉（task → task）：从一个已存在的 task Agent 会话分叉出新助手 Agent。
   *
   * 流程：
   *  1. 取源 record：in-memory（`toCheckpointRecord`）优先；in-memory 空时从磁盘读
   *     `sourceSessionId`（lazy Agent 尚未通过首条消息装载会话的时序差场景）
   *  2. `Conversation.forkFromRecord` 截断产出新 Conversation（含 transcript）
   *  3. `startTaskFromConversation` 落盘 + 建 Agent + 装载
   *
   * 安全约束：
   *  - 源 Agent 不存在 / 在运行中（且未指定 untilTaskCount）/ 无会话数据时返回 null
   *  - HistoryService 未注入时返回 null（fork 必须能持久化）
   *  - 跨模式 fork（终端→助手）不传 cache snapshot：源 system prompt 含终端工具，
   *    新 Agent system prompt 不同，cache 不会命中且历史 messages 中残留的终端 tool_call
   *    在新工具列表里"看起来不存在"——保守起见走 cold start
   */
  async forkTask(opts: {
    sourceAgentKey: string
    newAgentId: string
    untilTaskCount?: number
    titleSuffix?: string
    /** 源 Agent 无 in-memory 会话时（如前端仅从 HistoryService 加载历史），用此 sessionId 从磁盘分叉 */
    sourceSessionId?: string
  }): Promise<{
    newSessionId: string
    newAgentId: string
    sourceUserTask: string
    /** 截断后的完整 AgentRecord——前端用它调 restoreAgentHistory 把 steps 填到新 tab */
    newRecord: import('../history.service').AgentRecord
  } | null> {
    const historyService = this.services.historyService
    if (!historyService) {
      log.warn(`forkTask: historyService not available`)
      return null
    }

    const sourceAgent = this.getAgent(opts.sourceAgentKey)
    // 运行中仅允许按 task 截断分叉（已完成段落）；全量 fork 会带上进行中的半截 task
    if (sourceAgent?.isRunning() && opts.untilTaskCount === undefined) {
      log.warn(`forkTask: source agent is running, refuse full fork`)
      return null
    }

    // 取源 record：in-memory 优先（toCheckpointRecord 含进行中状态，比磁盘更全）；
    // in-memory 空（lazy Agent 尚未装载）时从磁盘读 sourceSessionId。
    let sourceRecord: import('../history.service').AgentRecord | null = null
    let sourceTerminalType: import('@shared/types').TerminalType | undefined

    if (sourceAgent) {
      sourceRecord = sourceAgent.toRecordForFork()
      sourceTerminalType = sourceAgent.getTerminalType()
    }

    if (!sourceRecord && opts.sourceSessionId) {
      const historyRecord = historyService.getAgentRecordById(opts.sourceSessionId)
      if (historyRecord) {
        sourceRecord = historyRecord
        sourceTerminalType = historyRecord.terminalType
      }
    }

    if (!sourceRecord) {
      log.warn(
        `forkTask: no session data to fork: sourceAgentKey=${opts.sourceAgentKey}, ` +
        `sourceSessionId=${opts.sourceSessionId ?? 'none'}`
      )
      return null
    }

    const newSessionId = `session_${Date.now()}_fork_${Math.random().toString(36).slice(2, 8)}`
    const forkOpts = {
      untilTaskCount: opts.untilTaskCount,
      titleSuffix: opts.titleSuffix ?? ''
    }

    const forked = Conversation.forkFromRecord(sourceRecord, newSessionId, forkOpts)
    if (!forked) {
      log.warn(`forkTask: forkFromRecord returned null (no user_task in source)`)
      return null
    }
    const { conversation: newConversation, record: newRecord } = forked

    // 同模式 fork 时携带 cache snapshot 让下一次 run 命中 LLM provider 的前缀缓存。
    // cache snapshot 必须与新 record.messages 一致——直接用 newRecord.messages 作为 snapshot。
    // 跨模式 fork（terminal→assistant）system prompt 必然不同，cache 物理上无法命中，走 cold start。
    const targetMode = 'assistant'
    const sourceIsAssistant = sourceTerminalType === undefined || sourceTerminalType === 'assistant'
    const isSameMode = targetMode === 'assistant' && sourceIsAssistant
    const cachePrefix = isSameMode && newRecord.messages && newRecord.messages.length > 0
      ? (newRecord.messages as AiMessage[])
      : undefined

    this.startTaskFromConversation(newConversation, newRecord, opts.newAgentId, { cachePrefix })

    log.info(
      `Forked task: source=${opts.sourceAgentKey} → new=${opts.newAgentId}, ` +
      `sessionId=${newSessionId}, untilTaskCount=${opts.untilTaskCount ?? 'all'}, ` +
      `cacheSnapshotCarried=${!!cachePrefix}, ` +
      `titleSuffix="${opts.titleSuffix ?? ''}", newRecord.userTask="${newRecord.userTask}"`
    )

    return {
      newSessionId,
      newAgentId: opts.newAgentId,
      sourceUserTask: newRecord.userTask,
      newRecord
    }
  }

  /**
   * 异质转化（companion → task）：从 companion 关系线抽取一段开新任务。
   *
   * 与 `forkTask` 的语义差异：
   * - forkTask：同质分叉，单条 record 按 `untilTaskCount` 截止（task → task，连续工作流）
   * - extractTaskFromCompanion：异质转化，N 条 record 合并后按时间窗口取最近连续段
   *   （companion → task，升格种子，带最近这段在聊啥即可）
   *
   * companion 是「N 条物理 record 拼成的逻辑关系线」，in-memory 只装最近一段，
   * fork 必须从磁盘拉全部近期 record 合并才能正确选择窗口。详见 `Companion` 类。
   *
   * 流程：
   *  1. `Companion.extractTask` 拉最近 N 条 record 合并 + 时间窗口选择产出新 Conversation
   *  2. `startTaskFromConversation` 落盘 + 建 Agent + 装载
   *  3. companion 始终视为 assistant 模式，cache snapshot 恒传递
   */
  async extractTaskFromCompanion(opts: {
    newAgentId: string
    anchorTaskIndex?: number
    anchorTaskStepId?: string
    titleSuffix?: string
    sourceSteps?: import('../history.service').AgentRecord['steps']
  }): Promise<{
    newSessionId: string
    newAgentId: string
    sourceUserTask: string
    newRecord: import('../history.service').AgentRecord
  } | null> {
    const historyService = this.services.historyService
    if (!historyService) {
      log.warn(`extractTaskFromCompanion: historyService not available`)
      return null
    }
    if (!this._companion) {
      log.warn(`extractTaskFromCompanion: companion not assembled (setHistoryService not called)`)
      return null
    }

    const newSessionId = `session_${Date.now()}_extract_${Math.random().toString(36).slice(2, 8)}`
    const forkOpts = {
      anchorTaskIndex: opts.anchorTaskIndex,
      anchorTaskStepId: opts.anchorTaskStepId,
      titleSuffix: opts.titleSuffix ?? '',
      sourceSteps: opts.sourceSteps,
    }

    const forked = this._companion.extractTaskWithLiveOverlay(
      newSessionId,
      this.getAgent('__companion__')?.toRecordForFork() ?? undefined,
      forkOpts
    )
    if (!forked) {
      log.warn(
        `extractTaskFromCompanion: companion.extractTask returned null ` +
        `(anchorTaskStepId=${opts.anchorTaskStepId ?? 'n/a'}, ` +
        `anchorTaskIndex=${opts.anchorTaskIndex ?? 'n/a'}, ` +
        `sourceSteps=${opts.sourceSteps?.length ?? 0})`
      )
      return null
    }
    const { conversation: newConversation, record: newRecord } = forked

    // companion 恒为 assistant 模式，cache snapshot 总能传递
    const cachePrefix = newRecord.messages && newRecord.messages.length > 0
      ? (newRecord.messages as AiMessage[])
      : undefined

    this.startTaskFromConversation(newConversation, newRecord, opts.newAgentId, { cachePrefix })

    log.info(
      `Extracted task from companion: new=${opts.newAgentId}, ` +
      `sessionId=${newSessionId}, anchorTaskStepId=${opts.anchorTaskStepId ?? 'n/a'}, ` +
      `anchorTaskIndex=${opts.anchorTaskIndex ?? 'n/a'}, ` +
      `titleSuffix="${opts.titleSuffix ?? ''}", newRecord.userTask="${newRecord.userTask}"`
    )

    return {
      newSessionId,
      newAgentId: opts.newAgentId,
      sourceUserTask: newRecord.userTask,
      newRecord
    }
  }

  /**
   * 把一个已构造好的 Conversation 落盘 + 建 Agent + 装载。
   *
   * `forkTask` / `extractTaskFromCompanion` 的共用编排底层。三步：
   *  1. `saveAgentRecord(newRecord)` 持久化为新 sessionId 的独立记录
   *  2. `createAssistantAgent(newAgentId)` 建新助手 Agent
   *  3. `attachConversation(newConversation)` 直接注入（含 transcript + 可选 cachePrefix）
   *
   * 新 Agent 首次 run 时 `initializeRun` 发现 `_conversation` 已存在跳过新建，`restoreFromHistory`
   * 因 taskMemory 非空跳过重建——fork 产物不再走磁盘往返。
   *
   * @param conversation 已构造好的会话（身份/transcript 已就绪）
   * @param record 与 conversation 配套的 record（含带后缀的 userTask，落盘用）
   * @param opts.cachePrefix 可选的 LLM 前缀缓存快照
   */
  private startTaskFromConversation(
    conversation: Conversation,
    record: import('../history.service').AgentRecord,
    newAgentId: string,
    opts?: { cachePrefix?: AiMessage[] }
  ): SailFish {
    // fork 产物的 agentKey 必须绑定到新 Agent，而非继承源会话：
    // 从 companion fork 时 record 会带 agentKey='__companion__'（见 extractTaskFromRecords
    // 的 ...earliest 展开），若不修正，listAgentHistorySummaries(excludeWakeup=true) 会把
    // 这条 task 记录误判为联络会话过滤掉，导致前端 pruneConversationMetadata 删除其自定义标题。
    conversation.rebind(newAgentId)
    record.agentKey = newAgentId

    const historyService = this.services.historyService!
    historyService.saveAgentRecord(record)
    const newAgent = this.createAssistantAgent(newAgentId)
    newAgent.attachConversation(conversation, { cachePrefix: opts?.cachePrefix })
    return newAgent
  }

  /**
   * 运行独立助手 Agent
   */
  async runAssistant(
    agentId: string,
    userMessage: string,
    context: AgentContext,
    config?: Partial<AgentConfig>,
    profileId?: string,
    callbacks?: AgentCallbacks
  ): Promise<string> {
    const agent = this.createAssistantAgent(agentId)
    
    if (config) {
      agent.updateConfig(config)
    }
    
    // assistant 模式无终端，用 HOME 目录兜底（避免系统提示词显示"未成功获取"触发 AI 执行 pwd）
    const enrichedContext: AgentContext = {
      ...context,
      cwd: context.cwd || os.homedir()
    }
    
    return agent.run(userMessage, enrichedContext, {
      profileId,
      callbacks
    })
  }

  // ==================== 生命周期管理 ====================

  /**
   * 清理 Agent 实例
   *
   * @param ptyId 实际语义为 agentKey（终端 = tabId，助手 = agentId UUID）。
   *   ⚠️ 不应在 PTY 销毁/SSH 断开时调用——Agent 与底层连接生命周期解耦。
   *   仅在以下场景调用：
   *   - 用户关闭 tab（前端 closeTab 显式触发）
   *   - Worker Agent 任务完成（与 worker 终端 1:1 绑定）
   *   - 固定 Agent 的 IM/Web 会话彻底结束
   */
  cleanupAgent(ptyId: string): void {
    const agent = this.agents.get(ptyId)
    if (agent) {
      agent.cleanup()
      this.agents.delete(ptyId)
      log.info(`Cleaned up agent: agentKey=${ptyId}`)
    }
  }

  /**
   * 清理所有 Agent 实例
   */
  cleanupAllAgents(): void {
    Array.from(this.agents.entries()).forEach(([agentKey, agent]) => {
      agent.cleanup()
      log.info(`Cleaned up agent: agentKey=${agentKey}`)
    })
    this.agents.clear()
  }

  // ==================== 全局设置 ====================
  
  /**
   * 设置默认回调
   */
  setCallbacks(callbacks: AgentCallbacks): void {
    this.defaultCallbacks = callbacks
    // 更新已存在的 agents
    Array.from(this.agents.values()).forEach(agent => {
      agent.setCallbacks(callbacks)
    })
  }

  // ==================== 便捷方法（向后兼容） ====================

  /**
   * 运行 Agent
   * 
   * 向后兼容的便捷方法，内部委托给 SailFish
   */
  async run(
    ptyId: string,
    userMessage: string,
    context: AgentContext,
    config?: Partial<AgentConfig>,
    profileId?: string,
    workerOptions?: import('./types').WorkerAgentOptions,
    callbacks?: AgentCallbacks
  ): Promise<string> {
    const agent = this.getOrCreateAgent(ptyId)
    
    // 更新配置
    if (config) {
      agent.updateConfig(config)
    }
    
    // 将 CWD 刷新延迟到 user_task 步骤发出之后，避免阻塞用户消息上墙。
    // 第一个参数是 agentKey（tabId），不是终端；目录要问眼前那扇窗。
    const terminalStateService = getTerminalStateService()
    const targetPtyId = context.ptyId || ptyId
    const cwdResolver = async () => {
      const cwd = await terminalStateService.refreshCwd(targetPtyId, 'initial')
      // 远程窗的 ~ 就是远端家目录，不能换成本机主目录
      if (context.terminalType === 'ssh') return cwd || '~'
      return (cwd && cwd !== '~') ? cwd : os.homedir()
    }
    
    return agent.run(userMessage, context, {
      profileId,
      workerOptions,
      callbacks,
      cwdResolver
    })
  }
  
  /**
   * 中止运行
   */
  abort(ptyId: string): boolean {
    const agent = this.getAgent(ptyId)
    return agent?.abort() ?? false
    }

  async compactContext(params: {
    agentKey: string
    sessionId?: string
    sessionStartTime?: number
    terminalType: TerminalType
    sshHost?: string
    hint?: string
    callbacks?: AgentCallbacks
  }): Promise<CompactContextResult> {
    const agent = this.getOrCreateAgent(params.agentKey)
    return agent.compactContext({
      sessionId: params.sessionId,
      sessionStartTime: params.sessionStartTime,
      terminalType: params.terminalType,
      sshHost: params.sshHost,
      hint: params.hint,
      callbacks: params.callbacks
    })
  }
    
  /**
   * 确认工具调用
   */
  confirmToolCall(
    ptyId: string,
    toolCallId: string,
    approved: boolean,
    modifiedArgs?: Record<string, unknown>,
    alwaysAllow?: boolean
  ): boolean {
    const agent = this.getAgent(ptyId)
    if (!agent) {
      log.info(`[confirm] rejected: agent not found (agentKey=${ptyId}, toolCallId=${toolCallId})`)
      return false
    }
    return agent.confirmToolCall(toolCallId, approved, modifiedArgs, alwaysAllow)
  }

  /**
   * 解决安全输入请求（前端弹框完成后调用）
   */
  resolveSecureInput(ptyId: string, requestId: string, saved: boolean): boolean {
    const agent = this.getAgent(ptyId)
    return agent?.resolveSecureInput(requestId, saved) ?? false
  }

  /**
   * 获取当前待处理的安全输入请求（供 main.ts IPC handler 取 skillId/envName）
   */
  getPendingSecureInput(ptyId: string): import('@shared/types').PendingSecureInput | undefined {
    const agent = this.getAgent(ptyId)
    if (!agent) return undefined
    const run = (agent as any).currentRun
    return run?.pendingSecureInput
      ? { ...run.pendingSecureInput, resolve: undefined }
      : undefined
  }
  
  /**
   * 添加用户消息
   */
  addUserMessage(ptyId: string, message: string, attachments?: import('@shared/types').AttachmentInfo[], documentContext?: string, images?: string[], workbenchContext?: import('@shared/types').WorkbenchContext, silent?: boolean): boolean {
    // 准备阶段 run() 尚未 initializeRun 时也要能接收补充（getAgent 会返回 undefined）
    const agent = this.getOrCreateAgent(ptyId)
    return agent.addUserMessage(message, attachments, documentContext, images, workbenchContext, silent)
  }
  
  /**
   * 重置 Agent 会话状态（前端"新对话"时调用）
   */
  resetSession(ptyId: string): void {
    const agent = this.getAgent(ptyId)
    agent?.resetSession()
  }

  /**
   * 开始新的持久化会话（保留工作记忆，仅重置 session 追踪）
   */
  startNewSession(agentId: string): void {
    const agent = this.getAgent(agentId)
    agent?.startNewSession()
  }

  /**
   * 为指定助手 Agent 预加载技能（会 create 若不存在）
   */
  async preloadSkills(agentId: string, skillIds: string[]): Promise<void> {
    if (!skillIds.length) return
    const agent = this.createAssistantAgent(agentId)
    await agent.preloadSkills(skillIds)
  }

  async pinSkill(agentKey: string, skillId: string): Promise<{ ok: boolean; error?: string; skills: VisibleConversationSkill[] }> {
    const agent = this.getOrCreateAgent(agentKey)
    const result = await agent.pinSkill(skillId)
    return { ...result, skills: agent.listVisibleSkills() }
  }

  async unpinSkill(agentKey: string, skillId: string): Promise<{ ok: true; skills: VisibleConversationSkill[] }> {
    const agent = this.getOrCreateAgent(agentKey)
    await agent.unpinSkill(skillId)
    return { ok: true, skills: agent.listVisibleSkills() }
  }

  hydrateSkills(agentKey: string, loadedSkills?: string[], userDismissedSkills?: string[]): VisibleConversationSkill[] {
    const agent = this.getOrCreateAgent(agentKey)
    agent.hydrateSkills(loadedSkills, userDismissedSkills)
    return agent.listVisibleSkills()
  }

  getVisibleSkills(agentKey: string): VisibleConversationSkill[] {
    return this.getAgent(agentKey)?.listVisibleSkills() ?? []
  }
  
  /**
   * 更新配置
   */
  updateConfig(ptyId: string, config: Partial<AgentConfig>): void {
    const agent = this.getAgent(ptyId)
    agent?.updateConfig(config)
  }

  /**
   * 终端重连后同步运行中 Agent：同 id 时重绑输出监听；异 id 时切换默认操作窗格。
   * @param agentKey 终端 = tabId
   */
  remapPtyId(agentKey: string, oldPtyId: string, newPtyId: string): boolean {
    const agent = this.getAgent(agentKey)
    if (!agent) return false
    return agent.remapPtyId(oldPtyId, newPtyId)
  }

  /**
   * 把新的 commandRiskPolicy 同步到所有已存在的 Agent 实例。
   * 用户在设置页改 policy 后调用，保证运行中 Agent 立即生效。
   */
  broadcastCommandRiskPolicy(policy: CommandRiskPolicy): void {
    for (const agent of this.agents.values()) {
      agent.updateConfig({ commandRiskPolicy: policy })
    }
  }
  
  /**
   * 获取运行状态
   */
  getRunStatus(ptyId: string): RunStatus | undefined {
    const agent = this.getAgent(ptyId)
    return agent?.getRunStatus()
  }

  /**
   * 获取执行阶段
   */
  getExecutionPhase(ptyId: string): AgentExecutionPhase {
    const agent = this.getAgent(ptyId)
    return agent?.getExecutionPhase() ?? 'idle'
  }

  /**
   * 检查是否正在运行
   */
  isRunning(ptyId: string): boolean {
    const agent = this.getAgent(ptyId)
    return agent?.isRunning() ?? false
  }
}
