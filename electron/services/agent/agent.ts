/**
 * Agent 抽象基类
 * 
 * 实现 Agent 的核心执行逻辑，子类（如 SailFish）实现特定行为。
 * 
 * 职责划分：
 * - Agent（基类）：执行循环、AI 交互、工具执行、步骤管理
 * - SailFish（子类）：工具列表管理、系统提示构建、可选终端能力
 */

import type { AiMessage, ToolCall, ChatWithToolsResult, ToolDefinition, RetryInfo, AiModelFailoverNotice, TokenUsageInfo } from '../ai.service'
import { StreamingToolExecutor } from './streaming-tool-executor'
import type { AgentRecord } from '../history.service'
import type {
  AgentConfig,
  AgentStep,
  AgentContextBar,
  TokenUsage,
  AgentContext,
  AgentPlan,
  AgentRun,
  AgentCallbacks,
  AgentServices,
  RunOptions,
  PromptOptions,
  KnowledgeContextResult,
  RunStatus,
  CompactContextResult,
  RiskLevel,
  TerminalType,
  ExecutionMode,
  AgentExecutionPhase,
  PendingConfirmationInternal,
  PendingSecureInputInternal,
  PendingUserMessage,
  CommandRiskPolicy,
} from './types'
import { DEFAULT_AGENT_CONFIG } from './types'
import { TaskMemoryStore } from './task-memory'
import { Conversation, conversationPolicy } from '../conversation'
import { generateConversationTitle, shouldRefreshConversationTitle } from '../conversation/title-generator'
import { ContextWindowManager } from './context-window'
import { beginUserCompactTurn, cancelUserCompactTurn, failUserCompactTurn, finishUserCompactTurn } from './tools/context'
import { SUMMARY_OUTPUT_BUDGET_CHARS } from './compression-summary'
import { resolveBudgetProfileId, shouldSkipCachePathForVision } from './vision-routing'
import {
  splitMessagesIntoTasks as splitMessagesIntoTasksShared,
  splitStepsIntoTasks as splitStepsIntoTasksShared
} from '../conversation/messages'
import { inferConversationKind, type AutoReviewTrail, type VisibleConversationSkill } from '@shared/types'
import { estimateTextTokens } from './token-estimate'
import { runUntilIdle } from './run-until-idle'
import { SubAgentRoster } from './sub-agent-roster'
import { isOemFeatureEnabled } from '@shared/oem-features'
import { getBondService } from '../bond.service'
import type { ConfirmationOptions, ToolExecutorConfig, ToolResult } from './tools/types'
import { executeTool } from './tools/index'
import { stripToolMeta } from './tools'
import { measureContextComposition } from './context-composition'
import { getMetaByName, buildPreToolCallDisplay, tryParsePartialJson } from './tool-metadata'
import {
  buildAllowlistKeyCandidates,
} from './allowlist'
import { buildTaskHistoryContext, type TaskHistoryOptions } from './context-builder'
import { getKnowledgeService } from '../knowledge'
import { getContextKnowledgeService } from '../knowledge/context-knowledge'
import {
  sessionKnowledgeHostId,
  resolveKnowledgeUpdateTargets,
  hostIdForKnowledgeRecord,
  composeKnowledgeDocuments,
  collectOpenPaneHostIds,
  uniqueHosts,
} from './tools/host-identity'
import { getWatchService } from '../watch/watch.service'
import { formatWatchListForPrompt } from './skills/watch/executor'
import {
  buildLoadedSkillsRosterSection,
  buildLoadedSkillsThisTurnHint,
  buildSkillsContentSectionText,
  patchLoadedSkillsSectionsInSystemPrompt,
} from './prompt-builder'
import { consumeProactiveContext } from './proactive-store'
import { applyParallelShare, computeToolOutputBudget } from './tool-output-budget'
import { collapseRepeatedToolOutputs, reduceRepeatedToolOutput } from './repeated-tool-output'
import { SUMMARY_MAX_OUTPUT_TOKENS } from '../ai-request-budget'
import { t, getLocale, type TranslationKey } from './i18n'
import { AutoApprovalReviewer, buildInspectorDeps, resolveInspectPtyId, type AutoReviewResult } from './auto-review'
import { CommandExecutorService } from '../command-executor.service'
import { createSkillSession, SkillSession, getSkill } from './skills'
import { McpToolSession, parseMcpSkillId, toMcpSkillId } from './mcp-tool-session'
import { getUserSkillService, parseUserSkillId, toUserSkillId } from '../user-skill.service'
import { getAiDebugService } from '../ai-debug.service'
import { createLogger } from '../../utils/logger'
import { isAbortError } from '../../utils/abort'
import { toSendableVisionImageUrl } from '../../utils/vision-image'
import { assembleUserMessageContent, formatSelectionScopeBody, wrapSystemContext } from './message-envelope'
import { buildUserImageNote, collectImageAttachmentPaths } from './image-note'
import { notifyFrontendConfigChanged } from './skills/config/executor'
import { getBrowserBridgeService } from '../browser-bridge/browser-bridge.service'
import { patchBrowserBridgeSectionInSystemPrompt } from '../browser-bridge/prompt-section'
import {
  WAITING_FOR_MODEL_LABEL_IDS,
  WAITING_FOR_MODEL_EASTER_EGG_LABEL_IDS,
  WAITING_FOR_MODEL_SLOW_LABEL_IDS,
  WAITING_FOR_MODEL_EASTER_EGG_CHANCE,
  WAITING_FOR_MODEL_SLOW_TTFT_MS,
  waitingForModelI18nKey,
} from '@shared/types/ai'

const log = createLogger('Agent')

/**
 * 去除流式输出中因 API 代理重复发送 reasoning_content 而产生的连续相同思考块。
 * 仅移除内容完全相同的相邻 <details> 块，保留不同的块。
 */
function deduplicateThinkingBlocks(html: string): string {
  const thinkingBlockRe = /(<details[^>]*>\s*<summary>[^<]*🤔[\s\S]*?<\/details>)\s*/g
  const blocks: { full: string; normalized: string; index: number }[] = []
  let match: RegExpExecArray | null
  while ((match = thinkingBlockRe.exec(html)) !== null) {
    blocks.push({ full: match[0], normalized: match[1].replace(/\s+/g, ' '), index: match.index })
  }
  if (blocks.length < 2) return html
  let result = html
  for (let i = blocks.length - 1; i > 0; i--) {
    if (blocks[i].normalized === blocks[i - 1].normalized) {
      result = result.slice(0, blocks[i].index) + result.slice(blocks[i].index + blocks[i].full.length)
    }
  }
  return result.trim() ? result : html
}

/**
 * Agent 抽象基类
 *
 * 注意：本基类不应硬编码任何具体工具名做行为分支。所有"按工具名差异化"的逻辑
 * 都通过 `ToolDefinition._meta`（声明在工具自己的定义上）+ `tool-metadata.ts`
 * 的 helper 完成查询，使基类对具体工具完全无感（OOP 抽象层不应穿透具体层）。
 *
 * 详见 SPEC.md「工具元数据驱动模型」一节。
 */
export abstract class Agent {
  // ==================== 配置（持久化） ====================
  
  /** 执行模式 */
  executionMode: ExecutionMode = 'strict'

  /** 命令超时时间（毫秒） */
  commandTimeout: number = 30000

  /** 调试模式 */
  debugMode: boolean = false

  /** 解析失败 / 未知命令 的风险策略（按 executionMode 分档） */
  commandRiskPolicy?: CommandRiskPolicy
  
  /** AI 配置档案 ID（每个 Agent 实例独立，未设置时 fallback 到全局） */
  profileId?: string

  /** Agent 实例的逻辑 ID（用于路由 proactive message 等场景） */
  private _agentId?: string

  /** 这场 run 里的伙计花名册（仅主人持有） */
  private _subAgentRoster?: SubAgentRoster

  /** 伙计：关掉落盘 / 侧栏 / L2 / L3 / 诞生引导 */
  private _isSubAgent = false

  /** 替我审批的评审员：第一次需要时才建，跟着这个 Agent 实例走 */
  private _autoReviewer?: AutoApprovalReviewer

  /** 伙计开局：清洗后的父对话，第一次 run 用完即清空 */
  private _seedMessages: AiMessage[] = []

  /**
   * 「持久命名 Agent」的显式覆盖位（仅测试 / 特殊场景用）。
   * 生产代码不再手动 mark——是否持久命名由 `agentId → kind → CONVERSATION_POLICY` 自决，见
   * 下方 `_persistentNamedAgent` getter。
   */
  private _persistentNamedOverride?: boolean

  /**
   * 是否为「持久命名 Agent」（如 Companion / Wakeup 这类固定 ID、跨重启复用的 Agent）。
   *
   * 现仅影响 `restoreFromHistory` 的全局历史 fallback（sessionId 找不到 record 时从全局最近 N 条
   * 历史提取任务恢复工作记忆，让 Companion/Wakeup 重启后"记得最近聊过什么"）+ `isPersistentNamedAgent()`
   * 对外查询。run 初始化的 sessionId 回种决策已上移至 `ConversationManager.seedsFromHistory`
   * （经 `openConversationForRun`），不再走本 getter。
   *
   * 取值由 `CONVERSATION_POLICY[kind].seedFromHistoryOnColdStart` 数据驱动：
   * companion + wakeup（持久命名）= true，watch + task = false。
   * `_persistentNamedOverride` 优先（供测试显式指定）。
   */
  private get _persistentNamedAgent(): boolean {
    return this._persistentNamedOverride
      ?? conversationPolicy(inferConversationKind(this._agentId)).seedFromHistoryOnColdStart
  }
  
  // ==================== 状态（持久化） ====================
  
  /** 当前执行计划 */
  currentPlan?: AgentPlan
  
  /** 任务记忆存储 */
  protected taskMemory: TaskMemoryStore
  
  // ==================== 运行时 ====================
  
  /** 当前运行状态 */
  protected currentRun?: AgentRun

  /** run() 尚未进入 initializeRun 时收到的用户补充（前端已显示 isRunning） */
  private preRunUserMessages: PendingUserMessage[] = []
  
  /** 依赖服务 */
  protected services: AgentServices
  
  /** 事件回调 */
  protected callbacks?: AgentCallbacks
  
  /** ID 计数器 */
  private idCounter = 0
  
  /** 技能会话（Agent 实例级别，跨 Run 持久化） */
  private _skillSession?: SkillSession

  /** 这场对话里用户亲手卸掉的技能，禁止它自己再装回来 */
  private _userDismissedSkills = new Set<string>()

  /** 这场对话装着的自己写的技能（`user:<id>`） */
  private _loadedUserSkillIds = new Set<string>()

  /** 开口前用户已经点过胶囊；历史恢复不得把这份决定盖掉 */
  private _skillsMutatedByUser = false

  /** 技能清单变化（装上 / 卸掉）时通知外壳，与单次 run 的 callbacks 解耦 */
  private _skillsChangedHook?: () => void

  /** MCP 工具渐进披露会话（Agent 实例级 sticky LRU） */
  private _mcpToolSession?: McpToolSession

  /**
   * 从历史记录取出、尚未装回技能会话的清单。
   * `undefined`：这场恢复没有技能清单（老记录），不要动当前技能。
   * 数组：按这份清单替换（含空数组 = 当时没装着）。
   */
  private _pendingRestoreSkillIds?: string[]

  /** 这场对话还该挂着的技能（含现在已经关掉或没有了的），开口装完后仍留着给人看 */
  private _rememberedSkillIds?: string[]

  /** 「本次允许」工具白名单（Agent 实例内存，跨 Run；关 tab / 重启清空） */
  private allowedTools = new Set<string>()

  /** 当前步骤的流式工具执行器；abort() 用来停掉排队中的工具 */
  private currentStreamingExecutor?: StreamingToolExecutor

  /**
   * 上一次 API usage 写入时的拟用 profileId。
   * 仅用于「下一轮启动若拟用模型变了 → 丢掉旧 Cache%」，避免文/视混挂。
   */
  private _lastStatsProfileId?: string

  /** 会话级上下文栏快照（UI 唯一实时源；与 step 解耦） */
  private _contextBar: AgentContextBar = {}

  /**
   * 当前会话在本进程内的累计 API 消耗（不落盘、不从历史回种）。
   * 与 Conversation.tokenUsage（会写入历史统计）分开，避免恢复旧对话时数字跳变。
   */
  private _consumedUsage: TokenUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  /** 当前请求进行中的估算（发请求时计入 prompt 估，流式输出时累加 completion 估；onDone 用精确值替换） */
  private _pendingUsage: TokenUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }

  /** 上下文窗口管理协作者(token估算/压力/压缩/工具序列修复)。构造时装配,见 _contextWindow。 */
  private _contextWindow!: ContextWindowManager

  /** 用量是否已到高水位：委托给 ContextWindowManager（≥85% 后不回退）。
   *  SailFish.getAvailableTools 用它决定要不要带上按水位才出现的附属能力。 */
  protected get contextManagementEnabled(): boolean { return this._contextWindow.enabled }
  
  // ==================== 会话追踪（跨 Run 持久化） ====================
  
  /**
   * 当前会话聚合根——唯一真相源（transcript / 工作记忆 / cache 前缀 / token 账）。
   * 首次 run（或 applyForkSnapshot）时创建或从历史恢复，跨多次 run 累积；
   * resetSession / startNewSession 时置空，下一次 run 重建。
   * 下方 `_session*` 系列已退化为它的**只读委托视图**（getter），赋值/累积统一走
   * Conversation 的 commitRun / commitFailedRun / setRestoredTranscript 等方法。
   */
  private _conversation?: Conversation

  /** 恢复任务 id 的实例级单调序号：保证 split* 在同一毫秒内多次调用（如 restoreRecentTaskMemory
   *  + restoreFromSessionRecord 接连执行）生成的 task id 不碰撞，避免 saveTask 互相覆盖丢任务。 */
  private _restoreTaskSeq = 0

  /** 抑制下一次 run 从历史回种 sessionId：resetSession（清空对话）/ startNewSession（Watch 每次
   *  独立记录）时置位，表示「本次有意要全新会话」，不要续写到历史最近一条。consume 后自动清零。 */
  private _suppressSessionSeed = false

  /** 是否正在从 HistoryService 恢复（防止并发竞态） */
  private _isRestoring = false

  // ===== 会话状态委托视图：唯一真相源是 _conversation，以下 getter 只读转发 =====
  /** 会话 ID */
  private get _sessionId(): string | undefined { return this._conversation?.id }
  /** 会话开始时间 */
  private get _sessionStartTime(): number | undefined { return this._conversation?.createdAt }
  /** 会话内累积的所有 steps（跨多次 run） */
  private get _sessionSteps(): AgentStep[] { return (this._conversation?.steps as AgentStep[] | undefined) ?? [] }
  /** 会话内累积的所有 API 消息（跨多次 run 的 taskMessageLog 合并） */
  private get _sessionMessages(): AiMessage[] { return (this._conversation?.messages as AiMessage[] | undefined) ?? [] }
  /** 终端元数据（形态，会话创建时定、不可变） */
  private get _terminalMeta(): { terminalType: TerminalType; sshHost?: string } | undefined {
    return this._conversation
      ? { terminalType: this._conversation.terminalType, sshHost: this._conversation.sshHost }
      : undefined
  }
  /** 会话内累积的 token 用量（跨多次 run 汇总） */
  private get _sessionTokenUsage(): import('@shared/types').TokenUsage | undefined { return this._conversation?.tokenUsage }
  /** 最近一次 API 调用返回的 prompt_tokens（用于精确的上下文压力估算） */
  private get _lastPromptTokens(): number | undefined { return this._conversation?.lastPromptTokens }
  /** 最近一次 API 调用计算出的缓存命中率（0-100），用于跨步骤保持显示 */
  private get _lastCacheHitRate(): number | undefined { return this._conversation?.lastCacheHitRate }
  /** 上一次 run 结束时的完整 messages 快照（用于跨任务 prompt cache 复用） */
  private get _previousRunMessages(): AiMessage[] | undefined { return this._conversation?.getCachePrefix() }
  
  // ==================== 构造函数 ====================
  
  constructor(services: AgentServices) {
    this.services = services
    this.taskMemory = this.createTaskMemory()
    this._contextWindow = new ContextWindowManager({
      config: this.services.configService,
      // 与 resolveEffectiveProfileId 对齐：有图时按视觉模型算预算，避免按主模型 1000K 复用后打到豆包 256K 超限
      getProfileId: () => this.resolveContextBudgetProfileId(),
      getLastPromptTokens: () => this._lastPromptTokens,
      getLastCacheHitRate: () => this._lastCacheHitRate,
      invalidateTokenAnchor: () => this._conversation?.setLastPromptTokens(undefined),
      measureMessageRange: (from, to) => this._conversation?.measureMessageRange(from, to),
      getTools: () => this.getAvailableTools(),
      shouldNudgeModelToCompact: () =>
        !this.isSubAgent() && this.services.configService?.getProactiveCompact?.() !== 'off',
      summarizeMessages: (opts) => this.summarizeForCompression(opts),
      reportUsage: (tokens, cacheHitRate) => {
        // updatePressure 拿到 API 精确值时刷新上下文栏（不靠 lastStep）。
        const next: AgentContextBar = {
          ...this._contextBar,
          contextTokens: tokens,
        }
        if (cacheHitRate !== undefined) next.cacheHitRate = cacheHitRate
        this.applyProfileFieldsToContextBar(next)
        this.setContextBar(next)
      }
    })
  }
  
  /**
   * 创建任务记忆存储（可被子类重写以支持测试 mock）。
   * 注入按工具名查 _meta 的回调，让 task-memory 能根据 lifecycle / argRole 决策行为，
   * 而不是硬编码具体工具名。回调内的 `this.getAvailableTools()` 在调用时才解析，
   * 此处构造时 subclass 还未完成初始化也没关系。
   * @param maxMemories 最大存储任务数（默认 2000，只防失控）
   */
  protected createTaskMemory(maxMemories?: number): TaskMemoryStore {
    return new TaskMemoryStore((name) => getMetaByName(this.getAvailableTools(), name), maxMemories)
  }

  /**
   * 设置 Agent 实例的逻辑 ID（由 AgentService.createAssistantAgent 调用）
   */
  setAgentId(id: string): void {
    this._agentId = id
  }

  /** 这场对话的身份（伙计、浏览器会话跟这个走）。没有逻辑 ID 时退回运行标识。 */
  protected getConversationAgentId(): string {
    return this._agentId || this.getAgentId()
  }

  /**
   * 显式标记为「持久命名 Agent」（覆盖 kind→policy 自决）。
   * 生产代码不再需要调用——companion/watch 由 agentId 推断的 kind 自动判定。
   * 保留此方法主要供测试构造无 companion agentId 的持久命名场景。
   */
  markAsPersistentNamed(): void {
    this._persistentNamedOverride = true
  }

  /**
   * 是否为持久命名 Agent（供测试和子类查询）。
   */
  isPersistentNamedAgent(): boolean {
    return this._persistentNamedAgent
  }

  markAsSubAgent(): void {
    this._isSubAgent = true
  }

  isSubAgent(): boolean {
    return this._isSubAgent
  }

  seedOpeningMessages(messages: AiMessage[]): void {
    this._seedMessages = messages
  }

  
  /**
   * 获取技能会话（延迟初始化，Agent 实例级别持久化）
   * 技能加载状态会在多轮对话间保持
   */
  protected getSkillSession(): SkillSession {
    if (!this._skillSession) {
      this._skillSession = createSkillSession(this.getAvailableTools(), this._agentId)
      this._skillSession.setOnChange(() => this._skillsChangedHook?.())
    }
    return this._skillSession
  }

  setSkillsChangedHook(hook: (() => void) | undefined): void {
    this._skillsChangedHook = hook
  }

  isSkillDismissed(skillId: string): boolean {
    return this.skillIdAliases(skillId).some(id => this._userDismissedSkills.has(id))
  }

  /** `user:foo` 与 `foo`（自己写的技能）视为同一条 */
  private skillIdAliases(skillId: string): string[] {
    const ids = new Set<string>([skillId])
    const userId = parseUserSkillId(skillId)
    if (userId) {
      ids.add(userId)
      ids.add(toUserSkillId(userId))
      return [...ids]
    }
    if (getUserSkillService().getSkill(skillId)) {
      ids.add(toUserSkillId(skillId))
    }
    return [...ids]
  }

  private isUserSkillId(skillId: string): boolean {
    return Boolean(parseUserSkillId(skillId) || getUserSkillService().getSkill(skillId))
  }

  /**
   * 用户点上技能：立刻装上，并允许这场对话再次使用它。
   */
  async pinSkill(skillId: string): Promise<{ ok: boolean; error?: string }> {
    if (parseMcpSkillId(skillId)) {
      return { ok: false, error: 'mcp_not_supported' }
    }
    this._skillsMutatedByUser = true
    for (const id of this.skillIdAliases(skillId)) {
      this._userDismissedSkills.delete(id)
    }
    if (this._pendingRestoreSkillIds) {
      this._pendingRestoreSkillIds = [
        ...this._pendingRestoreSkillIds.filter(id => id !== skillId),
        skillId
      ]
    }
    const userSkillId = parseUserSkillId(skillId)
    if (userSkillId) {
      const pinned = this.pinUserSkill(skillId, userSkillId)
      if (pinned.ok) this.rememberSkillId(skillId)
      this.persistSkillStateIfPossible()
      this._skillsChangedHook?.()
      return pinned
    }
    const result = await this.getSkillSession().loadSkill(skillId)
    if (!result.success && result.error && result.error !== 'Skill already loaded') {
      this.persistSkillStateIfPossible()
      this._skillsChangedHook?.()
      return { ok: false, error: result.error }
    }
    this.rememberSkillId(skillId)
    this.persistSkillStateIfPossible()
    this._skillsChangedHook?.()
    return { ok: true }
  }

  /**
   * 用户点掉胶囊：卸掉；这场对话里禁止秘书悄悄再装（预加载/重开恢复），
   * 但秘书自己再装上的允许。
   */
  async unpinSkill(skillId: string): Promise<void> {
    this._skillsMutatedByUser = true
    const aliases = this.skillIdAliases(skillId)
    const dismissed = new Set(aliases)
    for (const id of aliases) {
      this._userDismissedSkills.add(id)
      this._loadedUserSkillIds.delete(id)
      this.forgetRememberedSkillId(id)
    }
    if (this._pendingRestoreSkillIds) {
      this._pendingRestoreSkillIds = this._pendingRestoreSkillIds.filter(id => !dismissed.has(id))
    }
    if (this._skillSession && !this.isUserSkillId(skillId)) {
      await this._skillSession.unloadSkill(skillId)
    }
    this.persistSkillStateIfPossible()
    this._skillsChangedHook?.()
  }

  /**
   * 重开对话时先把清单记上，胶囊立刻能画出来，不必等下一轮开口。
   */
  hydrateSkills(loadedSkills?: string[], userDismissedSkills?: string[]): void {
    if (Array.isArray(userDismissedSkills)) {
      this._userDismissedSkills = new Set(userDismissedSkills.filter(id => typeof id === 'string'))
    }
    if (Array.isArray(loadedSkills)) {
      this._pendingRestoreSkillIds = loadedSkills.filter(id => !this.isSkillDismissed(id))
      this._rememberedSkillIds = [...this._pendingRestoreSkillIds]
    }
    this._skillsChangedHook?.()
  }

  listVisibleSkills(): VisibleConversationSkill[] {
    const visible: VisibleConversationSkill[] = []
    for (const id of this.orderedLoadedSkillIds()) {
      if (parseMcpSkillId(id)) continue
      if (this.isSkillDismissed(id)) continue
      visible.push({
        id,
        ...this.resolveVisibleSkillMeta(id),
        ...(this.isConversationSkillAvailable(id) ? {} : { unavailable: true })
      })
    }
    return visible
  }

  /** 这场对话现在开着的技能（含已接上的外部工具包），给模型看的同一份清单 */
  protected getLoadedSkillsRoster(): Array<{ id: string; name: string }> {
    const ids = this.collectPersistedSkillIds() ?? []
    const roster: Array<{ id: string; name: string }> = []
    for (const id of ids) {
      if (this.isSkillDismissed(id)) continue
      if (parseMcpSkillId(id)) {
        const resolved = this.services.mcpService?.resolveServerRef(id)
        roster.push({ id, name: resolved?.name || id })
        continue
      }
      if (!this.isConversationSkillAvailable(id)) continue
      roster.push({ id, name: this.resolveVisibleSkillMeta(id).name })
    }
    return roster
  }

  markUserSkillLoaded(skillId: string): void {
    const persistedId = toUserSkillId(skillId)
    this._userDismissedSkills.delete(persistedId)
    this._userDismissedSkills.delete(skillId)
    this._loadedUserSkillIds.add(persistedId)
    if (this._pendingRestoreSkillIds) {
      this._pendingRestoreSkillIds = [
        ...this._pendingRestoreSkillIds.filter(id => id !== persistedId),
        persistedId
      ]
    }
    this.rememberSkillId(persistedId)
    this.persistSkillStateIfPossible()
    this._skillsChangedHook?.()
  }

  /** 秘书装上系统技能后：清掉用户卸掉标记，胶囊能再显示 */
  markBuiltinSkillLoaded(skillId: string): void {
    this._userDismissedSkills.delete(skillId)
    this.rememberSkillId(skillId)
    this.persistSkillStateIfPossible()
    this._skillsChangedHook?.()
  }

  isUserSkillLoaded(skillId: string): boolean {
    return this._loadedUserSkillIds.has(skillId) || this._loadedUserSkillIds.has(toUserSkillId(skillId))
  }

  /** 秘书卸掉：这场不再开着，但不记成用户点掉 */
  markSkillUnloaded(skillId: string): void {
    const persistedUserId = toUserSkillId(parseUserSkillId(skillId) ?? skillId)
    this._loadedUserSkillIds.delete(skillId)
    this._loadedUserSkillIds.delete(persistedUserId)
    if (this._pendingRestoreSkillIds) {
      this._pendingRestoreSkillIds = this._pendingRestoreSkillIds.filter(
        id => id !== skillId && id !== persistedUserId
      )
    }
    this.forgetRememberedSkillId(skillId)
    this.forgetRememberedSkillId(persistedUserId)
    this.persistSkillStateIfPossible()
    this._skillsChangedHook?.()
  }

  protected getLoadedUserSkillsContent(): string {
    const parts: string[] = []
    for (const persistedId of this._loadedUserSkillIds) {
      const rawId = parseUserSkillId(persistedId) ?? persistedId
      const content = getUserSkillService().getSkillContent(rawId)
      if (!content?.trim()) continue
      const name = getUserSkillService().getSkill(rawId)?.name ?? rawId
      parts.push(`## ${name}\n\n${content.trim()}`)
    }
    return parts.join('\n\n')
  }

  private pinUserSkill(persistedId: string, rawId: string): { ok: boolean; error?: string } {
    const skill = getUserSkillService().getSkill(rawId)
    if (!skill) {
      return { ok: false, error: `Skill "${rawId}" not found` }
    }
    if (!skill.enabled) {
      return { ok: false, error: `Skill "${rawId}" is disabled` }
    }
    this._loadedUserSkillIds.add(persistedId)
    return { ok: true }
  }

  private resolveVisibleSkillMeta(id: string): { name: string; description?: string } {
    const userId = parseUserSkillId(id)
    if (userId) {
      const skill = getUserSkillService().getSkill(userId)
      const description = skill?.description?.trim()
      return { name: skill?.name ?? userId, ...(description ? { description } : {}) }
    }
    const skill = getSkill(id)
    const description = skill?.description?.trim()
    return { name: skill?.name ?? id, ...(description ? { description } : {}) }
  }

  private isConversationSkillAvailable(id: string): boolean {
    const userId = parseUserSkillId(id)
    if (userId) {
      const skill = getUserSkillService().getSkill(userId)
      return !!skill?.enabled
    }
    if (!getSkill(id)) return false
    const disabled = this.services.configService?.get?.('disabledBuiltinSkills')
    const disabledSet = new Set(Array.isArray(disabled) ? disabled.filter((item): item is string => typeof item === 'string') : [])
    return !disabledSet.has(id)
  }

  private rememberSkillId(skillId: string): void {
    if (parseMcpSkillId(skillId)) return
    if (!this._rememberedSkillIds) this._rememberedSkillIds = []
    this._rememberedSkillIds = [
      ...this._rememberedSkillIds.filter(id => id !== skillId),
      skillId
    ]
  }

  private forgetRememberedSkillId(skillId: string): void {
    if (!this._rememberedSkillIds) return
    this._rememberedSkillIds = this._rememberedSkillIds.filter(id => id !== skillId)
  }

  private collectDismissedSkillIds(): string[] | undefined {
    if (this._userDismissedSkills.size === 0) return undefined
    return [...this._userDismissedSkills]
  }

  private persistSkillStateIfPossible(): void {
    if (!this._conversation) return
    this.saveSessionToHistory()
  }

  /**
   * 预加载技能（Watch 等入口、以及重开对话恢复清单时真正 load，而不只是 prompt 文案提示）。
   * `mcp:<serverId>` 记进 MCP 渐进披露会话；普通技能走技能会话。装不上的跳过。
   */
  async preloadSkills(skillIds: string[]): Promise<void> {
    if (!skillIds.length) return
    const disabled = this.services.configService?.get?.('disabledBuiltinSkills')
    const disabledSet = new Set(Array.isArray(disabled) ? disabled.filter((id): id is string => typeof id === 'string') : [])
    for (const skillId of skillIds) {
      if (parseMcpSkillId(skillId)) {
        await this.preloadMcpSkill(skillId)
        continue
      }
      const userSkillId = parseUserSkillId(skillId)
      if (userSkillId) {
        if (this.isSkillDismissed(skillId)) {
          log.info(`Skip restoring user-dismissed skill "${skillId}"`)
          continue
        }
        const pinned = this.pinUserSkill(skillId, userSkillId)
        if (!pinned.ok) {
          log.warn(`Failed to preload user skill "${skillId}": ${pinned.error}`)
        }
        continue
      }
      if (disabledSet.has(skillId)) {
        log.warn(`Skip restoring disabled skill "${skillId}"`)
        continue
      }
      if (this.isSkillDismissed(skillId)) {
        log.info(`Skip restoring user-dismissed skill "${skillId}"`)
        continue
      }
      const result = await this.getSkillSession().loadSkill(skillId)
      if (!result.success) {
        log.warn(`Failed to preload skill "${skillId}": ${result.error}`)
      }
    }
  }

  /**
   * 静默装回 MCP：校验配置、必要时重连，再记进渐进披露会话。
   * 不往当前对话塞加载卡片。已删除 / 已禁用 / 连不上的跳过。
   */
  private async preloadMcpSkill(skillId: string): Promise<void> {
    const mcp = this.services.mcpService
    if (!mcp) {
      log.warn(`Skip restoring MCP skill "${skillId}": MCP service not available`)
      return
    }
    const configs = this.services.configService?.getMcpServers?.() ?? []
    const configured = mcp.findConfiguredServer(skillId, configs)
    if (configured?.enabled === false) {
      log.warn(`Skip restoring disabled MCP "${skillId}"`)
      return
    }
    let resolved = mcp.resolveServerRef(skillId)
    if (!resolved && configured) {
      try {
        await mcp.ensureConnected(configured)
        resolved = mcp.resolveServerRef(configured.id)
      } catch (err) {
        log.warn(`Failed to reconnect MCP "${skillId}":`, err)
        return
      }
    }
    if (!resolved) {
      log.warn(`Skip restoring missing MCP "${skillId}"`)
      return
    }
    this.getMcpToolSession().loadServer(resolved.serverId)
  }

  /** 这场对话当前还装着的技能（含 MCP 虚拟 skill id），供检查点落盘 */
  private collectLoadedSkillIds(): Set<string> {
    const ids = new Set<string>()
    if (this._skillSession) {
      for (const id of this._skillSession.getLoadedSkills()) ids.add(id)
    }
    for (const id of this._loadedUserSkillIds) ids.add(id)
    if (this._pendingRestoreSkillIds) {
      for (const id of this._pendingRestoreSkillIds) ids.add(id)
    }
    if (this._rememberedSkillIds) {
      for (const id of this._rememberedSkillIds) ids.add(id)
    }
    return ids
  }

  /** 胶囊展示顺序：按用户/秘书加入先后，不以 skillSession 内部顺序为准 */
  private orderedLoadedSkillIds(): string[] {
    const loaded = this.collectLoadedSkillIds()
    const ordered: string[] = []
    const seen = new Set<string>()
    const push = (id: string) => {
      if (!loaded.has(id) || seen.has(id)) return
      seen.add(id)
      ordered.push(id)
    }
    if (this._rememberedSkillIds) {
      for (const id of this._rememberedSkillIds) push(id)
    }
    if (this._pendingRestoreSkillIds) {
      for (const id of this._pendingRestoreSkillIds) push(id)
    }
    if (this._skillSession) {
      for (const id of this._skillSession.getLoadedSkills()) push(id)
    }
    for (const id of this._loadedUserSkillIds) push(id)
    for (const id of loaded) push(id)
    return ordered
  }

  private collectPersistedSkillIds(): string[] | undefined {
    const ids = new Set<string>()
    if (this._skillSession) {
      for (const id of this._skillSession.getLoadedSkills()) ids.add(id)
    }
    if (this._mcpToolSession) {
      for (const serverId of this._mcpToolSession.getLoadedServerIds()) {
        ids.add(toMcpSkillId(serverId))
      }
    }
    for (const id of this._loadedUserSkillIds) ids.add(id)
    if (this._pendingRestoreSkillIds) {
      for (const id of this._pendingRestoreSkillIds) ids.add(id)
    }
    if (this._rememberedSkillIds) {
      for (const id of this._rememberedSkillIds) ids.add(id)
    }
    if (ids.size === 0) return undefined
    const ordered = this.orderedLoadedSkillIds().filter(id => ids.has(id))
    for (const id of ids) {
      if (!ordered.includes(id)) ordered.push(id)
    }
    return ordered.length > 0 ? ordered : undefined
  }

  /**
   * 把历史记录里的技能清单装回本实例。只在清单存在时替换；老记录没有字段则不动。
   */
  private async applyRestoredSkills(): Promise<void> {
    if (this._pendingRestoreSkillIds === undefined) return
    const skillIds = this._pendingRestoreSkillIds
    this._pendingRestoreSkillIds = undefined
    this._loadedUserSkillIds.clear()
    if (this._skillSession) {
      await this._skillSession.cleanup()
    }
    this._mcpToolSession?.clear()
    await this.preloadSkills(skillIds)
    this._skillsChangedHook?.()
    if (skillIds.length) {
      log.info(`Restored ${this.collectPersistedSkillIds()?.length ?? 0} skill(s) from session record`)
    }
  }

  /** MCP 渐进披露会话（跨 Run；resetSession / cleanup 清空） */
  protected getMcpToolSession(): McpToolSession {
    if (!this._mcpToolSession) {
      this._mcpToolSession = new McpToolSession()
    }
    return this._mcpToolSession
  }
  
  // ==================== 抽象方法（子类必须实现） ====================
  
  /**
   * 获取当前可用的工具列表
   */
  abstract getAvailableTools(): ToolDefinition[]
  
  /**
   * 构建系统提示词
   */
  protected abstract buildSystemPrompt(context: AgentContext, options: PromptOptions): string
  
  /**
   * 获取 Agent 标识（用于日志和调试）
   */
  protected abstract getAgentId(): string
  
  // ==================== 公开方法 ====================
  
  /**
   * 执行 Agent 任务
   */
  async run(message: string, context: AgentContext, options?: RunOptions): Promise<string> {
    // 检查是否已有运行中的任务
    if (this.currentRun?.isRunning) {
      throw new Error('Agent is already running')
    }
    
    // 这场对话用哪个模型：显式传入优先；否则联络沿用界面上已选的。
    // 从没选过就保持空，下游回落到设置里当时的默认——微信进线不能写死、也不能盖掉界面选择。
    // 唤醒没有自己的选择器，每次未显式指定都跟默认。详见 agent/SPEC.md。
    if (options?.profileId) {
      this.profileId = options.profileId
    } else if (this._agentId === '__wakeup__' && this.services.configService) {
      const active = this.services.configService.getActiveAiProfile()
      if (active) this.profileId = active
    }

    const run = this.initializeRun(message, context, options)
    const taskPreview = message.length > 80 ? message.slice(0, 80) + '...' : message
    log.info(`Task started: runId=${run.id}, ptyId=${run.ptyId}, mode=${this.executionMode}, task="${taskPreview}"`)
    const taskStartTime = Date.now()
    
    try {
      // 历史恢复带出的技能清单要在组上下文 / 取工具表之前装上，否则模型会看见旧工具名却没有对应工具
      await this.applyRestoredSkills()

      // CWD 刷新与上下文构建互不依赖，并行执行以缩短「正在准备...」阶段
      const cwdPromise = options?.cwdResolver
        ? options.cwdResolver().then(cwd => {
            run.context = { ...run.context, cwd }
          }).catch(e => {
            log.warn('CWD resolve failed, using fallback:', e)
          })
        : Promise.resolve()

      await Promise.all([cwdPromise, this.buildContext(run, message)])
      const result = await runUntilIdle({
        executeLoop: () => this.executeLoop(run),
        hasPendingMessages: () => run.pendingUserMessages.length > 0,
        hasLiveChildren: () => this._subAgentRoster?.hasLive() ?? false,
        waitForChildrenOrKnock: () => {
          const signal = run.abortController?.signal
          if (!this._subAgentRoster || !signal) return Promise.resolve()
          return this._subAgentRoster.waitForKnock(signal)
        },
        isAborted: () => run.aborted,
      })
      this.finalizeRun(run, result)
      const elapsed = ((Date.now() - taskStartTime) / 1000).toFixed(1)
      log.info(`Task completed: runId=${run.id}, duration=${elapsed}s, steps=${run.steps.length}`)
      return result
    } catch (error) {
      this.handleError(run, error)
      const elapsed = ((Date.now() - taskStartTime) / 1000).toFixed(1)
      log.error(`Task failed: runId=${run.id}, duration=${elapsed}s, error=${error instanceof Error ? error.message : error}`)
      throw error
    } finally {
      this.cleanupRun(run)
    }
  }
  
  /**
   * 中止当前运行
   */
  abort(): boolean {
    if (!this.currentRun) {
      return false
    }
    if (!this.currentRun.isRunning && !this.currentStreamingExecutor) {
      return false
    }
    
    this.currentRun.aborted = true
    this.currentRun.isRunning = false
    this.currentRun.abortController?.abort()
    this.currentStreamingExecutor?.abort()
    this._subAgentRoster?.abortAll()

    // 释放待确认/安全输入等待，避免 abort 后 Promise 永久挂起、阻塞同实例下一次 run
    if (this.currentRun.pendingConfirmation) {
      const pending = this.currentRun.pendingConfirmation
      log.info(
        `[confirm] aborted while waiting (agent=${this._agentId ?? 'unknown'}, run=${this.currentRun.id}, tool=${pending.toolName}, toolCallId=${pending.toolCallId})`
      )
      this.currentRun.pendingConfirmation.resolve(false)
      this.currentRun.pendingConfirmation = undefined
    }
    if (this.currentRun.pendingSecureInput) {
      this.currentRun.pendingSecureInput.resolve(false)
      this.currentRun.pendingSecureInput = undefined
    }
    
    // 中止 AI 请求
    if (this.currentRun.requestId) {
      this.services.aiService.abort(this.currentRun.requestId)
    }
    
    return true
  }
  
  /**
   * 检查是否正在运行
   */
  isRunning(): boolean {
    return this.currentRun?.isRunning ?? false
  }

  /**
   * 用户主动交接：压缩工作窗口。人点名压是新交办的一轮；不当成普通聊天发给模型。
   * 正在跑时拒绝；空对话返回 empty。
   */
  async compactContext(opts: {
    sessionId?: string
    sessionStartTime?: number
    terminalType: TerminalType
    sshHost?: string
    hint?: string
    callbacks?: AgentCallbacks
  }): Promise<CompactContextResult> {
    if (this.isRunning()) return { ok: false, reason: 'running' }

    this.ensureConversationForCompact(opts)
    const conv = this._conversation
    if (!conv) return { ok: false, reason: 'empty' }

    const prefix = conv.getCachePrefix()
    const source = prefix?.length ? prefix : [...conv.messages]
    if (source.length === 0) return { ok: false, reason: 'empty' }

    const hint = opts.hint?.trim()
    const run: AgentRun = {
      id: `compact_${Date.now()}`,
      originalUserRequest: '',
      messages: source.map(m => ({ ...m })),
      steps: [],
      isRunning: true,
      aborted: false,
      pendingUserMessages: [],
      config: { ...DEFAULT_AGENT_CONFIG },
      context: {
        terminalOutput: [],
        systemInfo: { os: '', shell: '' },
        terminalType: opts.terminalType,
        sshHost: opts.sshHost,
        sessionId: conv.id,
        sessionStartTime: conv.createdAt
      },
      realtimeOutputBuffer: [],
      executionPhase: 'idle',
      taskMessageLog: []
    }

    this.seedCompressedArchives(run)
    if (!this._contextWindow.canHandoff(run)) return { ok: false, reason: 'empty' }

    const previousCallbacks = this.callbacks
    if (opts.callbacks) this.callbacks = opts.callbacks
    this.currentRun = run

    const sink = {
      addStep: (step: Partial<AgentStep>) => this.addStep(step),
      updateStep: (stepId: string, updates: Partial<AgentStep>) => this.updateStep(stepId, updates),
      removeStep: (stepId: string) => this.removeStep(stepId)
    }
    const compactTurn = beginUserCompactTurn(sink, hint || undefined)
    run.originalUserRequest = compactTurn.userRequest

    try {
      const result = await this._contextWindow.userCompress(run, hint ? { userHint: hint } : undefined)
      if (!result) {
        cancelUserCompactTurn(sink, compactTurn)
        return { ok: false, reason: 'empty' }
      }

      const output = finishUserCompactTurn(sink, compactTurn, result)
      conv.setWorkingContext(run.messages)
      conv.setCachePrefix(run.messages)
      conv.adoptCompressedArchives(run.compressedArchives)
      conv.commitTranscriptTurn({
        runId: run.id,
        userRequest: compactTurn.userRequest,
        steps: run.steps,
        taskStatus: 'success',
        result: output
      })
      this.saveSessionToHistory()

      const afterTokens = this._contextWindow.estimateCurrentPromptTokens(run.messages)
      const bar: AgentContextBar = {
        ...this._contextBar,
        contextTokens: afterTokens
      }
      this.applyProfileFieldsToContextBar(bar)
      this.setContextBar(bar)

      log.info(`User compact: freed ${result.freedTokens} tokens (${result.beforeTokens} → ${result.afterTokens})`)
      return {
        ok: true,
        freedTokens: result.freedTokens,
        beforeTokens: result.beforeTokens,
        afterTokens: result.afterTokens
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const output = failUserCompactTurn(sink, compactTurn, message)
      conv.adoptCompressedArchives(run.compressedArchives)
      conv.commitTranscriptTurn({
        runId: run.id,
        userRequest: compactTurn.userRequest,
        steps: run.steps,
        taskStatus: 'failed',
        result: output
      })
      this.saveSessionToHistory()
      log.error('User compact failed:', err)
      return { ok: false, reason: 'failed' }
    } finally {
      run.isRunning = false
      this.currentRun = undefined
      this.callbacks = previousCallbacks
    }
  }

  private ensureConversationForCompact(opts: {
    sessionId?: string
    sessionStartTime?: number
    terminalType: TerminalType
    sshHost?: string
  }): void {
    if (!this._conversation) {
      const manager = this.services.conversationManager
      if (manager) {
        this._conversation = manager.openConversationForRun({
          agentKey: this._agentId,
          terminalType: opts.terminalType,
          sshHost: opts.sshHost,
          contextSessionId: opts.sessionId,
          contextStartTime: opts.sessionStartTime,
          taskMemory: this.taskMemory
        })
      } else {
        this._conversation = Conversation.create(
          { agentKey: this._agentId ?? '', terminalType: opts.terminalType },
          {
            id: opts.sessionId ?? `session_${Date.now()}`,
            createdAt: opts.sessionStartTime ?? Date.now(),
            sshHost: opts.sshHost
          },
          { taskMemory: this.taskMemory }
        )
      }
    }

    const conv = this._conversation
    const needsRestore =
      !!this._sessionId &&
      !this._isSubAgent &&
      !this._isRestoring &&
      !conv.getCachePrefix()?.length &&
      conv.messages.length === 0
    if (!needsRestore) return

    this._isRestoring = true
    try {
      this.restoreFromHistory()
    } finally {
      this._isRestoring = false
    }
  }
  
  /**
   * 更新配置
   */
  updateConfig(config: Partial<AgentConfig> & { profileId?: string }): void {
    if (config.executionMode !== undefined) {
      this.executionMode = config.executionMode
    }
    if (config.commandTimeout !== undefined) {
      this.commandTimeout = config.commandTimeout
    }
    if (config.debugMode !== undefined) {
      this.debugMode = config.debugMode
    }
    if (config.commandRiskPolicy !== undefined) {
      this.commandRiskPolicy = config.commandRiskPolicy
    }
    if (config.profileId !== undefined) {
      this.profileId = config.profileId
      // 切模型即刻刷新上下文条：保留 token 快照，把 model/limit 换成新选 profile，
      // 清掉旧 Cache%（避免张冠李戴）。否则联络空闲时切了模型，状态栏仍显示上一次的模型。
      const bar: AgentContextBar = {
        ...this._contextBar,
        profileId: config.profileId,
        cacheHitRate: undefined,
      }
      this.applyProfileFieldsToContextBar(bar, config.profileId)
      this.setContextBar(bar)
    }
    // 如果正在运行，也更新运行时配置
    if (this.currentRun) {
      Object.assign(this.currentRun.config, config)
    }
  }
  
  /**
   * 添加用户补充消息
   */
  addUserMessage(
    message: string,
    attachments?: import('@shared/types').AttachmentInfo[],
    documentContext?: string,
    images?: string[],
    workbenchContext?: import('@shared/types').WorkbenchContext,
    silent?: boolean
  ): boolean {
    const pending: PendingUserMessage = {
      message,
      attachments: attachments?.length ? attachments : undefined,
      documentContext: documentContext || undefined,
      images: images?.length ? images : undefined,
      workbenchContext: workbenchContext || undefined,
      silent: silent || undefined
    }

    if (!this.currentRun?.isRunning) {
      // 前端已 setAgentRunning，但 run() 尚未 initializeRun — 先缓冲，initializeRun 时上墙
      this.preRunUserMessages.push(pending)
      return true
    }
    
    // 立即创建 user_supplement 步骤（追加到当前时间线末尾；流式输出会被 abort 打断，补充自然落在中断内容之后）
    // 点选答题等 silent 回复只注入 pending，不上墙
    if (!silent) {
      this.addStep({
        type: 'user_supplement',
        content: message,
        attachments: attachments?.length ? attachments : undefined,
        images: images?.length ? images : undefined
      })
    }
    
    this.currentRun.pendingUserMessages.push(pending)
    
    // 如果 Agent 正在等待（AI 思考中），中断当前请求让它处理新消息
    if (this.currentRun.executionPhase === 'thinking' && this.currentRun.requestId) {
      this.services.aiService.abort(this.currentRun.requestId)
    }
    
    return true
  }
  
  /**
   * 处理工具调用确认
   */
  confirmToolCall(
    toolCallId: string | undefined, 
    approved: boolean, 
    modifiedArgs?: Record<string, unknown>,
    alwaysAllow?: boolean
  ): boolean {
    const agentKey = this._agentId ?? 'unknown'
    const runId = this.currentRun?.id
    if (!this.currentRun || !this.currentRun.pendingConfirmation) {
      log.info(`[confirm] rejected: no pending (agent=${agentKey}, run=${runId}, toolCallId=${toolCallId ?? 'any'})`)
      return false
    }

    const pending = this.currentRun.pendingConfirmation
    if (toolCallId && pending.toolCallId !== toolCallId) {
      log.info(
        `[confirm] rejected: toolCallId mismatch (agent=${agentKey}, run=${runId}, expected=${pending.toolCallId}, got=${toolCallId})`
      )
      return false
    }

    log.info(
      `[confirm] resolved (agent=${agentKey}, run=${runId}, tool=${pending.toolName}, toolCallId=${pending.toolCallId}, approved=${approved}, alwaysAllow=${!!alwaysAllow})`
    )
    return this.resolvePendingConfirmation(approved, modifiedArgs, alwaysAllow)
  }

  /**
   * 确认当前待处理的工具调用（不要求 toolCallId，仅供 IM Companion 等单实例场景）。
   */
  confirmPendingToolCall(
    approved: boolean,
    modifiedArgs?: Record<string, unknown>,
    alwaysAllow?: boolean
  ): boolean {
    const agentKey = this._agentId ?? 'unknown'
    const runId = this.currentRun?.id
    if (!this.currentRun?.pendingConfirmation) {
      log.info(`[confirm] rejected: no pending (agent=${agentKey}, run=${runId}, via=pendingToolCall)`)
      return false
    }
    const pending = this.currentRun.pendingConfirmation
    log.info(
      `[confirm] resolved via pendingToolCall (agent=${agentKey}, run=${runId}, tool=${pending.toolName}, toolCallId=${pending.toolCallId}, approved=${approved})`
    )
    return this.resolvePendingConfirmation(approved, modifiedArgs, alwaysAllow)
  }

  private resolvePendingConfirmation(
    approved: boolean,
    modifiedArgs?: Record<string, unknown>,
    alwaysAllow?: boolean
  ): boolean {
    const pending = this.currentRun!.pendingConfirmation!
    const toolArgs = modifiedArgs || pending.toolArgs
    // 会话内存白名单：shell 工具写入 exec/execute_command 双键，互认同一条命令
    const keys = buildAllowlistKeyCandidates(pending.toolName, toolArgs)

    if (!approved) {
      for (const key of keys) this.allowedTools.delete(key)
    } else if (alwaysAllow) {
      for (const key of keys) this.allowedTools.add(key)
    }
    pending.resolve(approved, modifiedArgs)
    return true
  }
  
  /**
   * 是否有待确认的工具调用
   */
  hasPendingConfirmation(): boolean {
    return !!this.currentRun?.pendingConfirmation
  }

  /**
   * 解决安全输入请求（前端弹框用户完成输入后调用）。
   * @param requestId 请求 ID
   * @param saved true=用户已保存 key，false=用户取消
   */
  resolveSecureInput(requestId: string, saved: boolean): boolean {
    if (!this.currentRun?.pendingSecureInput) return false
    if (this.currentRun.pendingSecureInput.requestId !== requestId) return false
    this.currentRun.pendingSecureInput.resolve(saved)
    return true
  }

  /**
   * 是否有待处理的安全输入请求
   */
  hasPendingSecureInput(): boolean {
    return !!this.currentRun?.pendingSecureInput
  }

  /**
   * 获取运行状态
   */
  getRunStatus(): RunStatus | undefined {
    if (!this.currentRun) {
      return undefined
    }
    
    return {
      isRunning: this.currentRun.isRunning,
      phase: this.currentRun.executionPhase,
      currentToolName: this.currentRun.currentToolName,
      stepCount: this.currentRun.steps.length,
      hasPendingConfirmation: !!this.currentRun.pendingConfirmation
    }
  }
  
  /**
   * 获取当前执行阶段
   */
  getExecutionPhase(): AgentExecutionPhase {
    return this.currentRun?.executionPhase ?? 'idle'
  }
  
  /**
   * 设置回调
   */
  setCallbacks(callbacks: AgentCallbacks): void {
    this.callbacks = callbacks
  }
  
  /**
   * 清理资源
   */
  cleanup(): void {
    if (this.currentRun) {
      this.cleanupRun(this.currentRun)
      this.currentRun = undefined
    }
    
    // 清理技能会话
    if (this._skillSession) {
      this._skillSession.cleanup()
      this._skillSession = undefined
    }
    this._mcpToolSession?.clear()
    this._mcpToolSession = undefined
    this._pendingRestoreSkillIds = undefined
    this._rememberedSkillIds = undefined
    this._userDismissedSkills.clear()
    this._loadedUserSkillIds.clear()
    this._skillsMutatedByUser = false
  }
  
  // ==================== 受保护方法：生命周期 ====================
  
  /**
   * 初始化运行状态
   */
  protected initializeRun(message: string, context: AgentContext, options?: RunOptions): AgentRun {
    const runId = this.generateId()
    const config: AgentConfig = {
      ...DEFAULT_AGENT_CONFIG,
      executionMode: this.executionMode,
      commandTimeout: this.commandTimeout,
      debugMode: this.debugMode,
      commandRiskPolicy: this.commandRiskPolicy,
    }
    
    const run: AgentRun = {
      id: runId,
      ptyId: context.ptyId,
      originalUserRequest: message,  // 保存原始用户请求，避免被历史消息覆盖
      messages: [],
      steps: [],
      isRunning: true,
      aborted: false,
      abortController: new AbortController(),
      pendingUserMessages: [],
      config,
      context,
      realtimeOutputBuffer: [...context.terminalOutput],
      workerOptions: options?.workerOptions,
      executionPhase: 'thinking',
      skillSession: this.getSkillSession(),  // 使用 Agent 级别的技能会话，跨 Run 持久化
      taskMessageLog: [],
      hostOperations: new Map()
    }
    
    this.currentRun = run
    if (!this._isSubAgent) {
      this._subAgentRoster = new SubAgentRoster()
    }
    
    // 注册运行级别回调
    if (options?.callbacks) {
      this.callbacks = options.callbacks
    }
    
    // 初始化会话聚合根（首次 run 时创建；applyForkSnapshot 已建则沿用，随后由 restoreFromHistory 装载）
    if (!this._conversation) {
      if (this._isSubAgent) {
        this._conversation = Conversation.create(
          { agentKey: this._agentId ?? '', terminalType: context.terminalType },
          {
            id: `sub_${this._agentId ?? 'child'}_${Date.now()}`,
            createdAt: Date.now(),
            sshHost: context.sshHost
          },
          { taskMemory: this.taskMemory }
        )
      } else {
      const suppressSeed = this._suppressSessionSeed
      this._suppressSessionSeed = false

      // 「馆长发证」：回种决策（无 sessionId 入口是否从历史回种）+ 建会话一次完成，交还现成聚合根。
      // Agent 不再自己做回种分支 + `Conversation.create`——这套逻辑统一收口在 ConversationManager。
      // 生产环境 setHistoryService 时已装配 manager。
      const manager = this.services.conversationManager
      if (manager) {
        this._conversation = manager.openConversationForRun({
          agentKey: this._agentId,
          terminalType: context.terminalType,
          sshHost: context.sshHost,
          contextSessionId: context.sessionId,
          contextStartTime: context.sessionStartTime,
          suppressSeed,
          taskMemory: this.taskMemory
        })
      } else {
        // 退化路径：无 manager（仅部分无 historyService 的纯单测）。按 context.sessionId 或新建，
        // **不**做 companion 回种——回种需 manager + 历史，相关行为由带 manager 的测试覆盖。
        this._conversation = Conversation.create(
          { agentKey: this._agentId ?? '', terminalType: context.terminalType },
          {
            id: context.sessionId ?? `session_${Date.now()}`,
            createdAt: context.sessionStartTime ?? Date.now(),
            sshHost: context.sshHost
          },
          { taskMemory: this.taskMemory }
        )
      }
      }
    }

    // 先推送 user_task 步骤，让用户消息立即上墙，再做耗时的初始化
    this.addStep({
      type: 'user_task',
      content: message,
      images: context.previewImages || context.images,
      attachments: context.attachments
    })

    this.callbacks?.onStart?.(this._agentId ?? run.id, message)

    // 准备阶段用户补充：run() IPC 往返期间缓冲的消息，紧跟 user_task 上墙
    if (this.preRunUserMessages.length > 0) {
      const queued = this.preRunUserMessages.splice(0)
      for (const supplement of queued) {
        run.pendingUserMessages.push(supplement)
        if (supplement.silent) continue
        this.addStep({
          type: 'user_supplement',
          content: supplement.message,
          attachments: supplement.attachments,
          images: supplement.images
        })
      }
    }
    
    // 先推送「正在准备...」，再做可能较慢的历史恢复，避免 UI 长时间无反馈
    const initialStep = this.addStep({
      type: 'thinking',
      content: t('ai.preparing'),
      isStreaming: true,
      placeholder: 'startup',
    })
    run.initialStepId = initialStep.id

    // 初始化 TaskMemory（仅首次 run 时，从 HistoryService 恢复）
    // 场景：用户恢复了历史对话，Agent 实例刚创建，TaskMemory 为空
    // 通过 sessionId 从 HistoryService 加载完整记录，避免前端反复传递大量数据
    if (!this._isSubAgent && this.taskMemory.getTaskCount() === 0 && this._sessionId && !this._isRestoring) {
      this._isRestoring = true
      try {
        this.restoreFromHistory()
      } finally {
        this._isRestoring = false
      }
    }

    // 历史恢复之后再落盘：第一条用户消息确定即进历史，侧栏立刻能看到，崩溃也不丢整段对话。
    // 必须在 restore 之后写——否则会把自己刚写下的检查点再读回来（工作记忆重复），
    // 续聊还会用只有新消息的残本盖掉旧记录。之后每轮工具调用仍会再写检查点。
    this.seedCompressedArchives(run)
    this.saveCheckpoint(run)

    // 历史恢复后发布会话级上下文栏：上轮 API 确认的 token/cache + 本轮拟用 model/limit。
    // 与占位 step 解耦——流式接替 / 重试删 step 不会打空状态栏。用法仍只在 onDone 更新为确认值。
    this.publishPlannedContextBar()
    
    // 设置终端输出监听器
    this.setupOutputListener(run)
    
    return run
  }
  
  /**
   * 从 HistoryService 恢复 TaskMemory 和 session 步骤
   * 使用 sessionId 直接从后端存储加载，无需前端传递数据
   *
   * Fallback 策略（sessionId 找不到 record 时）：
   *   - 持久命名 Agent（Companion/Watch）：从全局最近历史恢复工作记忆
   *     —— 这些 Agent 重启后用 `session_${Date.now()}` 找不到 record，但语义上是
   *     「同一个长期 Agent」，需要记得最近聊过什么
   *   - 普通 tab Agent（terminal/独立助手）：直接返回，保持 TaskMemory 空白
   *     —— 新开 tab 的第一次对话本就是新任务，注入全局历史会让 AI 误以为是连续
   *     对话，沿用历史里的工具名（甚至当前 tab 工具表里没有的工具），造成幻觉调用
   */
  private restoreFromHistory(): void {
    const historyService = this.services.historyService
    if (!historyService || !this._sessionId) return

    // 持久命名 Agent（Companion / Watch）：重启后前端传回的 sessionId 只是「最新一条」
    // 记录，并非用户主动选择恢复某次会话。若只按它精确命中单条，会丢掉同期其它会话
    //（典型：另一条 companion 线刚写完的文档）——这正是「屏幕合并展示看得见、AI 上下文
    // 只有单条记不住」的根因。这类 Agent 语义上是「同一个长期 Agent」，应从最近 N 条
    // 历史重建工作记忆（数据 scope 见 restoreRecentTaskMemory），与前端 getRecentByAgentKey 的合并
    // 展示对齐。同时仍恢复「最新单条」的完整会话状态，保证后续 checkpoint 续写到这条
    // 记录、不覆盖丢历史。
    if (this._persistentNamedAgent) {
      const latest = historyService.getAgentRecordById(this._sessionId)
      // 先补「除最新外」的最近会话进工作记忆（更旧/并行，插入在前，排到较早位置）
      this.restoreRecentTaskMemory(historyService, latest?.id)
      // 再恢复最新单条：其任务插入在后（排到 taskIndex 0 最近位），并复位
      // _sessionSteps / _sessionMessages 供 checkpoint 续写
      if (latest) {
        this.restoreFromSessionRecord(latest)
      }
      return
    }

    // 普通 tab Agent：精确恢复用户指定的那次历史会话；找不到则保持空白（新任务）。
    // 不走 recent fallback——新 tab 第一次对话本就是新任务，注入历史会造成工具名幻觉。
    const record = historyService.getAgentRecordById(this._sessionId)
    if (record) {
      this.restoreFromSessionRecord(record)
      return
    }
    log.info(`No record for sessionId=${this._sessionId}; skipping recent fallback (not a persistent named agent)`)
  }

  /**
   * 从精确匹配的 session 记录恢复完整状态（TaskMemory + session 追踪）
   * 场景：前端传回旧 sessionId，恢复之前的完整会话
   */
  private restoreFromSessionRecord(record: AgentRecord): void {
    if (record.messages && record.messages.length > 0) {
      const tasks = splitMessagesIntoTasksShared(
        record.messages as AiMessage[],
        () => `restored_${Date.now()}_${this._restoreTaskSeq++}`
      )
      for (let i = 0; i < tasks.length; i++) {
        const task = tasks[i]
        const status = i === tasks.length - 1 && (record.status === 'aborted' || record.status === 'failed')
          ? record.status
          : 'success'
        this.taskMemory.saveTask(
          task.id,
          task.userTask,
          [],
          status,
          task.finalResult,
          task.messages
        )
      }
      log.info(`Restored TaskMemory from session record: ${tasks.length} tasks (from messages)`)
    } else if (record.steps && record.steps.length > 0) {
      const baseTs = record.steps[0]?.timestamp || Date.now()
      const tasks = splitStepsIntoTasksShared(record.steps, i => `restored_${baseTs}_${i}`)
      for (let i = 0; i < tasks.length; i++) {
        const task = tasks[i]
        const status = i === tasks.length - 1 && (record.status === 'aborted' || record.status === 'failed')
          ? record.status
          : 'success'
        this.taskMemory.saveTask(
          task.id,
          task.userTask,
          task.steps,
          status,
          task.finalResult
        )
      }
      log.info(`Restored TaskMemory from session record: ${tasks.length} tasks (from steps, no messages)`)
    }
    
    // transcript 交给会话聚合根装载（含「已有则不覆盖」守卫，保留续聊旧产出物字段）。
    // taskMemory 上面已由 Agent 用自己的 split/seq 写入（与 restoreRecentTaskMemory 共享单调
    // 序号防同毫秒 task id 碰撞），故此处只补 transcript。
    this._conversation?.setRestoredTranscript(record.messages as AiMessage[] | undefined, record.steps)
    this._conversation?.restoreWorkingContext(record.workingContext as AiMessage[] | undefined)
    this._conversation?.adoptCompressedArchives(record.compressedArchives as AgentRun['compressedArchives'])

    // 关切 / 唤醒自己预装技能，不按历史清单恢复。
    const kind = record.kind ?? inferConversationKind(record.agentKey)
    if (kind === 'watch' || kind === 'wakeup') return
    // 重开后、开口前用户已经点过胶囊：以当场决定为准，不要用盘上旧清单盖回去。
    if (this._skillsMutatedByUser) return
    if (Array.isArray(record.userDismissedSkills)) {
      this._userDismissedSkills = new Set(record.userDismissedSkills.filter(id => typeof id === 'string'))
    }
    if (Array.isArray(record.loadedSkills)) {
      this._pendingRestoreSkillIds = record.loadedSkills.filter(id => !this._userDismissedSkills.has(id))
      this._rememberedSkillIds = [...this._pendingRestoreSkillIds]
    }
  }

  /**
   * 从最近历史记录恢复工作记忆（仅 TaskMemory，不恢复 session 状态）
   * 场景：App 重启后 Companion 等命名 Agent 的首次 run，提取最近若干任务作为工作记忆
   *
   * 数据 scope 按 kind 分流（与前端展示口径对齐）：
   *  - companion：仅同 agentKey（`__companion__`）的最近 N 条。联络是独立常驻 tab，
   *    UI 只展示联络线，AI 上下文也应只含联络线——若灌入任务 tab 的 transcript 会让
   *    AI 在联络里「串台」（沿用任务里的工具/话题，像在接另一场对话）。
   *    多条 companion 线合并的语义保留：重启后前端传回的 sessionId 只是「最新一条」，
   *    其它并行 companion 线仍需从同 agentKey 最近历史补齐，避免「记得屏幕看得见、
   *    AI 记不住」。
   *  - wakeup：维持全局 main 树（排除 watch/wakeup 自身噪声）——Wakeup 是 Agent 的「内心独白」，
   *    需要参考用户在任意 tab 的最近活动做决策，全局借记忆对 wakeup 仍成立。
   *  - watch：本方法不会被调用（`_persistentNamedAgent` 为 false 时不进 fallback）——
   *    关切逐次失忆，prompt 自带完整指令与上下文。
   *  - task：本方法不会被调用（`_persistentNamedAgent` 为 false 时不进 fallback）。
   */
  private restoreRecentTaskMemory(
    historyService: {
      getRecentAgentRecords(limit: number, filter?: (r: AgentRecord) => boolean): AgentRecord[]
      getRecentRecordsByAgentKey?(agentKey: string, limit: number): AgentRecord[]
    },
    excludeId?: string
  ): void {
    const kind = inferConversationKind(this._agentId)
    // wakeup：广度优先 + 强制 L4，工作记忆装 ~30 条任务即可（见 SPEC wakeup 装载策略）。
    // companion 维持紧凑（联络是单线对话，6 条 record 已够）；task 不会走到这里。
    // watch 因 seedFromHistoryOnColdStart=false，本方法不会被调用——保留 'watch' 分支是防御性的。
    const broadScope = kind === 'watch' || kind === 'wakeup'
    const MAX_RECENT_RECORDS = broadScope ? 20 : 6
    const MAX_RESTORE_TASKS = broadScope ? 30 : 40

    // 排除两类记录：
    //  - watch/wakeup「内心独白」：自我循环的触发记录（[当前时间：...触发事件...]），
    //    SPEC 明确不应被借作工作记忆——它们是噪声，不是用户活动
    //  - excludeId：调用方已单独精确恢复的「最新单条」，避免重复
    const isWakeupNoise = (r: AgentRecord): boolean =>
      typeof r.userTask === 'string' &&
      r.userTask.startsWith('[当前时间：') &&
      r.userTask.includes('触发事件')

    const recentRecords: AgentRecord[] =
      kind === 'companion' && historyService.getRecentRecordsByAgentKey && this._agentId
        ? historyService.getRecentRecordsByAgentKey(this._agentId, MAX_RECENT_RECORDS)
            .filter(r => r.id !== excludeId)
        : historyService.getRecentAgentRecords(
            MAX_RECENT_RECORDS,
            r => !isWakeupNoise(r) && r.id !== excludeId
          )
    if (recentRecords.length === 0) return

    // 按「最后活跃时间」升序：旧记录在前。saveTask 依插入顺序累积，
    // getTasksInOrder 取「最近」时才能正确把刚发生的任务排到 taskIndex 0。
    const ordered = [...recentRecords].sort(
      (a, b) => (a.timestamp + (a.duration || 0)) - (b.timestamp + (b.duration || 0))
    )

    const allTasks: Array<{ id: string; userTask: string; finalResult: string; messages?: AiMessage[]; steps?: AgentStep[] }> = []
    for (const rec of ordered) {
      if (rec.messages && rec.messages.length > 0) {
        allTasks.push(...splitMessagesIntoTasksShared(
          rec.messages as AiMessage[],
          () => `restored_${Date.now()}_${this._restoreTaskSeq++}`
        ))
      } else if (rec.steps && rec.steps.length > 0) {
        const baseTs = rec.steps[0]?.timestamp || Date.now()
        allTasks.push(...splitStepsIntoTasksShared(rec.steps, i => `restored_${baseTs}_${i}`))
      }
    }
    if (allTasks.length === 0) return

    const recentTasks = allTasks.slice(-MAX_RESTORE_TASKS)
    for (const task of recentTasks) {
      if (task.messages) {
        this.taskMemory.saveTask(task.id, task.userTask, [], 'success', task.finalResult, task.messages as AiMessage[])
      } else {
        this.taskMemory.saveTask(task.id, task.userTask, task.steps as AgentStep[] || [], 'success', task.finalResult)
      }
    }

    log.info(`Restored ${recentTasks.length} recent tasks into working memory (from ${recentRecords.length} records, wakeup${excludeId ? ' + latest' : ''} excluded)`)
  }
  
  // splitMessagesIntoTasks / splitStepsIntoTasks 已抽到 ../conversation/messages 纯函数，
  // 与 Conversation 共用同一份实现（见顶部 splitMessagesIntoTasksShared / splitStepsIntoTasksShared）。

  /**
   * 完成运行，保存任务记忆
   */
  protected finalizeRun(run: AgentRun, result: string): void {
    run.isRunning = false

    // 先添加 final_result 步骤到 run.steps，确保后续 commitRun 时 run.steps 已含完整数据
    // （纯文本最终回复的「补录到对话日志 / cache 快照」由 Conversation.commitRun 统一负责，
    //  含 reasoning_content 空串保留——思考模式下 DeepSeek V3.2+ 必需）
    if (result) {
      this.addStep({
        type: 'final_result',
        content: result
      })
    }

    const status = run.aborted ? 'aborted' : 'success'

    // 提交本次 run 到会话聚合根：补最终回复 → 存工作记忆 → 刷新 cache 前缀 → 累积 transcript / token
    this._conversation?.commitRun({
      runId: run.id,
      userRequest: run.originalUserRequest,
      steps: run.steps,
      taskMessageLog: run.taskMessageLog,
      runMessages: run.messages,
      taskStatus: status,
      result: result ?? null,
      reasoningContent: run.lastAssistantReasoningContent,
      tokenUsage: run.tokenUsage,
      imagesStripped: run.imagesStripped,
    })
    if (!this._isSubAgent) {
      this.saveSessionToHistory()
      this.scheduleTitleRefreshIfDue()

      // 诞生引导完成判定：调用了任何被标注 lifecycle.marksOnboardingComplete 的工具
      // 即视为引导完成（基类不知道具体是哪个工具，由 ToolDefinition._meta.lifecycle 声明）
      if (!(this.services.configService?.getAgentOnboardingCompleted())) {
        const tools = this.getAvailableTools()
        const onboardingMarkerCalled = run.steps.some(s => {
          if (s.type !== 'tool_call' || !s.toolName) return false
          return getMetaByName(tools, s.toolName)?.lifecycle?.marksOnboardingComplete === true
        })
        if (onboardingMarkerCalled) {
          this.services.configService?.setAgentOnboardingCompleted(true)
          notifyFrontendConfigChanged()
          log.info('Agent onboarding completed — onboarding-marker tool was called')
        }
      }

      // L2: 异步更新知识文档（唤醒 run 跳过，避免短问候污染知识文档）
      this.updateContextKnowledgeAsync(run, result).catch(err => {
        log.error('知识文档更新失败:', err)
      })

      // L3: 异步索引对话到向量库（供跨会话语义检索）
      this.indexConversationAsync(run, 'success', result).catch(err => {
        log.warn('对话向量索引失败:', err)
      })
    }

    // 触发完成回调
    this.callbacks?.onComplete?.(run.id, result, run.pendingUserMessages.map(m => ({
      message: m.message,
      ...(m.images?.length ? { images: m.images } : {}),
      ...(m.attachments?.length ? { attachments: m.attachments } : {}),
      ...(m.documentContext ? { documentContext: m.documentContext } : {}),
      ...(m.workbenchContext ? { workbenchContext: m.workbenchContext } : {}),
    })), { aborted: run.aborted })
  }
  
  // ==================== 会话持久化 ====================
  
  /** 这场对话里已有的原文归档种进当前 run，编号接着往下走，取回也能对上。 */
  private seedCompressedArchives(run: AgentRun): void {
    const archives = this._conversation?.getCompressedArchives()
    if (!archives?.length) return
    run.compressedArchives = archives
  }

  /**
   * 将会话数据保存到 HistoryService。
   * 记录的构建（首个 user_task 标题、taskMemory 末态决定整体状态、steps/messages 序列化、kind/形态/token）
   * 全部由 Conversation.toRecord 负责；空会话（无 user_task）返回 null，与现状一致跳过。
   */
  private saveSessionToHistory(): void {
    const historyService = this.services.historyService
    if (!historyService || !this._conversation) return

    const record = this._conversation.toRecord({
      terminalId: this.currentRun?.context.ptyId || '',
      loadedSkills: this.collectPersistedSkillIds(),
      userDismissedSkills: this.collectDismissedSkillIds()
    })
    if (!record) return

    try {
      historyService.saveAgentRecord(record)
    } catch (err) {
      log.error('保存会话历史失败:', err)
    }
  }
  
  /**
   * 保存执行检查点：将「会话累积态 + 当前 run 进行态」合并写入 HistoryService。
   * 第一条 user_task 上墙后立即触发一次，之后每完成一轮工具调用再写，
   * 确保程序意外退出时不丢失已开了头的对话。
   *
   * record 构建委托给 `Conversation.toCheckpointRecord`——字段映射（stepToStepRecord）、
   * token 合并、kind/形态/身份等全部由 Conversation 唯一负责，本方法只做薄转发。
   * 这消除了原实现里与 `Conversation.stepToStepRecord` 重复的第二份字段映射，
   * 以及原 record 缺 `kind` 字段、两份实现都漏 `toolCallId` 字段的问题。
   */
  private saveCheckpoint(run: AgentRun): void {
    if (this._isSubAgent) return
    const historyService = this.services.historyService
    if (!historyService || !this._conversation) return

    if (this._conversation.hasHandoff() && run.messages.length > 0) {
      this._conversation.setWorkingContext(run.messages)
    }
    this._conversation.adoptCompressedArchives(run.compressedArchives)
    const record = this._conversation.toCheckpointRecord({
      steps: run.steps,
      taskMessageLog: run.taskMessageLog,
      tokenUsage: run.tokenUsage,
      contextPtyId: run.context.ptyId,
      loadedSkills: this.collectPersistedSkillIds(),
      userDismissedSkills: this.collectDismissedSkillIds()
    })
    if (!record) return

    try {
      historyService.saveAgentRecord(record)
    } catch (err) {
      log.error('保存检查点失败:', err)
    }
  }
  
  // ==================== Fork（另开一聊） ====================

  /**
   * 获取当前 session ID（fork 时给 AgentService 用，判断源 Agent 是否有可分叉的会话）
   */
  getSessionId(): string | undefined {
    return this._sessionId
  }

  /**
   * 设置当前会话展示标题。同步到 Conversation 内存；是否落盘由调用方经 History 决定。
   * @returns 是否实际变更（未变化返回 false）
   */
  setConversationTitle(title: string, opts?: { locked?: boolean }): boolean {
    if (!this._conversation) return false
    return this._conversation.setTitle(title, opts)
  }

  /**
   * 任务会话每完整三轮后，复用刚结束的前缀异步重写侧栏标题。
   * 不阻塞 run；手改过的 / 无前缀的跳过。
   */
  private scheduleTitleRefreshIfDue(): void {
    const conv = this._conversation
    const historyService = this.services.historyService
    const configService = this.services.configService
    if (!conv || !historyService || !configService) return
    if (conv.kind !== 'task' || conv.titleLocked) return
    if (!shouldRefreshConversationTitle(conv.userTaskCount)) return

    const cachePrefix = conv.getCachePrefix()
    if (!cachePrefix?.length) return

    const sessionId = conv.id
    void generateConversationTitle(
      {
        aiService: this.services.aiService,
        configService,
        historyService,
        agentService: {
          setConversationTitleBySessionId: (id, title) => {
            if (id === conv.id) conv.setTitle(title)
            return historyService.updateConversationTitle(id, title)
          },
        },
      },
      {
        sessionId,
        mode: 'refresh',
        cachePrefix,
        tools: this.getAvailableTools(),
        profileId: this.profileId,
      }
    ).catch(err => {
      log.warn('Refresh conversation title failed:', err)
    })
  }

  /**
   * 获取终端模式元数据（fork 时给 AgentService 用，判断是否同模式以决定 cache snapshot 是否传递）
   */
  getTerminalType(): TerminalType | undefined {
    return this._terminalMeta?.terminalType
  }

  /**
   * 为 fork 生成截断后的新 AgentRecord。
   *
   * 实现要点：
   * - 直接基于 in-memory 的 _sessionMessages / _sessionSteps 构造，不读 HistoryService
   *   （source Agent 总是持有最新状态，HistoryService 中可能略滞后）
   * - 截断按 task 边界（user_task step / 真实 user message）进行，task 内部的 tool_calls
   *   配对天然完整，不会破坏 LLM API 协议
   * - 返回的 record 还未写入 HistoryService，由调用方负责 saveAgentRecord
   *
   * @param newSessionId 新 session ID（由调用方生成）
   * @param opts.untilTaskCount 截断到第 N 个 task（包含），undefined / >= 总数 = 不截断
   * @param opts.titleSuffix userTask 后缀（如「· 分支」）
   */
  /**
   * 取当前会话的持久化 record，供 fork 用。
   *
   * @deprecated 新代码请由 AgentService 直接调 `Conversation.forkFromRecord`——它会
   * 内部完成截断 + 产新 Conversation。本方法保留为薄转发，兼容现有测试。
   *
   * 返回 null：会话无 user_task（空会话首_run 首轮前）。
   */
  toRecordForFork(): AgentRecord | null {
    if (!this._conversation) return null
    return this._conversation.toRecord({
      loadedSkills: this.collectPersistedSkillIds(),
      userDismissedSkills: this.collectDismissedSkillIds()
    })
  }

  /**
   * 为 fork 生成截断后的新 AgentRecord。
   *
   * @deprecated 新代码请由 AgentService 直接调 `Conversation.forkFromRecord`。本方法
   * 保留为薄转发，兼容现有测试。逻辑已收口到 `Conversation.forkFromRecord` +
   * `Conversation.buildForkedRecord`（含 toolCallId 字段，修复了本方法旧实现的漏字段 bug）。
   */
  cloneRecordForFork(
    newSessionId: string,
    opts?: { untilTaskCount?: number; titleSuffix?: string }
  ): AgentRecord | null {
    const sourceRecord = this.toRecordForFork()
    if (!sourceRecord) return null
    const forked = Conversation.forkFromRecord(sourceRecord, newSessionId, opts)
    return forked ? forked.record : null
  }

  /**
   * 装载 fork 数据到新 Agent 实例上。
   *
   * @deprecated 新代码请用 `attachConversation`——它直接注入已构造好的 Conversation
   *（含 transcript），不再需要「建空壳 + restoreFromHistory 从磁盘装载」的两步走。
   * 本方法保留为薄转发，兼容现有测试。
   *
   * - sessionId：必须，让首次 run 走 restoreFromHistory(sessionId) 路径而非生成新 id
   * - previousRunMessages：可选 cache snapshot。同模式 fork 时由 AgentService.forkAgent
   *   直接用 newRecord.messages（与新 record 字节一致）传入，让下次 run 命中 LLM 前缀缓存；
   *   跨模式不传，新 Agent 走 cold start 从 record 重建上下文
   */
  applyForkSnapshot(opts: {
    sessionId: string
    previousRunMessages?: AiMessage[]
    terminalType?: TerminalType
    sshHost?: string
  }): void {
    // 建空壳会话（fork 始终是 assistant Agent）。首次 run 见 _conversation 已存在
    // 即跳过新建，转由 restoreFromHistory(sessionId) 把已保存的 fork record 装载进来。
    // 同样经馆长发证（显式 sessionId，不做回种）；无 manager 的退化路径直接建。
    const manager = this.services.conversationManager
    const forkParams = {
      agentKey: this._agentId ?? '',
      terminalType: opts.terminalType ?? 'assistant' as TerminalType,
      sshHost: opts.sshHost,
      sessionId: opts.sessionId,
      taskMemory: this.taskMemory
    }
    const conv = manager
      ? manager.openConversation(forkParams)
      : Conversation.create(
          { agentKey: forkParams.agentKey, terminalType: forkParams.terminalType },
          { id: opts.sessionId, createdAt: Date.now(), sshHost: opts.sshHost },
          { taskMemory: this.taskMemory }
        )
    this.attachConversation(conv, { cachePrefix: opts.previousRunMessages })
  }

  /**
   * 把一个已构造好的 Conversation（通常由 `Conversation.forkFromRecord` /
   * `extractTaskFromRecords` 产出）直接注入 Agent，作为它的当前会话。
   *
   * 与旧 `applyForkSnapshot` 的区别：
   * - 不建空壳 + 等 `restoreFromHistory` 从磁盘装载——传入的 Conversation 已含完整 transcript
   *   （`fromRecord` 在 fork 静态方法里已完成装载）
   * - 首次 run 时 `initializeRun` 发现 `_conversation` 已存在跳过新建；`restoreFromHistory`
   *   因 taskMemory 非空跳过重建——fork 产物不再走磁盘往返
   *
   * @param conversation 已构造好的会话（身份/transcript 已就绪）
   * @param opts.cachePrefix 可选的 LLM 前缀缓存快照。同模式 fork 时由 AgentService 传入
   *   newRecord.messages（与落盘 record 字节一致），让下次 run 命中 provider 前缀缓存；
   *   跨模式不传，新 Agent 走 cold start
   */
  attachConversation(conversation: Conversation, opts?: { cachePrefix?: AiMessage[] }): void {
    this._conversation = conversation
    this.resetConsumedUsage()
    if (opts?.cachePrefix && opts.cachePrefix.length > 0) {
      // setCachePrefix 内部深拷贝，避免与源 Agent 共享引用
      this._conversation.setCachePrefix(opts.cachePrefix)
    }
  }

  /**
   * 重置会话状态（前端"新对话"或终端重连时调用）
   */
  resetSession(): void {
    this.preRunUserMessages = []
    this._suppressSessionSeed = true
    // 置空会话聚合根（身份/transcript/cache/token 随之全部失效），并清空 Agent 持有的工作记忆。
    // 下一次 run 会以全新 session 重建会话。
    this._conversation = undefined
    this._lastStatsProfileId = undefined
    this._contextBar = {}
    this.resetConsumedUsage()
    this.taskMemory.clear()
    if (this._skillSession) {
      void this._skillSession.cleanup()
      this._skillSession = undefined
    }
    this._mcpToolSession?.clear()
    this._pendingRestoreSkillIds = undefined
    this._rememberedSkillIds = undefined
    this._userDismissedSkills.clear()
    this._loadedUserSkillIds.clear()
    this._skillsMutatedByUser = false
    this._skillsChangedHook?.()
    this._autoReviewer?.reset()
  }

  /**
   * 开始新的持久化会话（下次 run 时使用新 sessionId 创建独立 AgentRecord）
   * 与 resetSession 不同：保留 TaskMemory（工作记忆），仅重置 session 追踪
   * 用途：Watch 每次执行需要独立的历史记录，但 Agent 需要记住之前做过什么
   */
  startNewSession(): void {
    this._suppressSessionSeed = true
    // 仅置空会话聚合根（下次 run 建新 session 记录）；**不**清 taskMemory——
    // 下次 run 创建新会话时注入同一个（保留的）store，维持「跨 session 记忆」语义。
    this._conversation = undefined
    this._lastStatsProfileId = undefined
    this._contextBar = {}
    this.resetConsumedUsage()
    if (this._skillSession) {
      void this._skillSession.cleanup()
      this._skillSession = undefined
    }
    this._mcpToolSession?.clear()
    this._pendingRestoreSkillIds = undefined
    this._rememberedSkillIds = undefined
    this._userDismissedSkills.clear()
    this._loadedUserSkillIds.clear()
    this._skillsMutatedByUser = false
    this._skillsChangedHook?.()
  }

  
  /**
   * L2: 异步更新知识文档
   * 收集执行记录（或纯对话内容），交给 LLM 判断是否有值得持久化的新信息
   */
  private async updateContextKnowledgeAsync(run: AgentRun, result?: string): Promise<void> {
    const aiService = this.services.aiService
    if (!aiService) return

    // 唤醒 run 跳过（短问候不产生值得持久化的信息）
    if (run.context.wakeup) return

    const sessionHostId = sessionKnowledgeHostId({
      terminalType: run.context.terminalType,
      hostId: run.context.hostId,
    })
    const targets = resolveKnowledgeUpdateTargets({
      terminalType: run.context.terminalType,
      sessionHostId,
      operatedHostIds: [...(run.hostOperations?.values() ?? [])],
    })

    const MAX_ARG_DISPLAY = 200
    const MAX_RESULT_DISPLAY = 300
    const MAX_FINAL_RESULT_DISPLAY = 500
    const ckService = getContextKnowledgeService()
    const profileId = this.services.configService?.getActiveAiProfile() ?? undefined
    const finalResponse = result ? result.substring(0, MAX_FINAL_RESULT_DISPLAY) : undefined

    const toolSteps = run.steps.filter(s => s.type === 'tool_call' && s.toolName)

    // 纯对话（无工具调用）：助手只写个人；终端页仍写自己那台
    if (toolSteps.length === 0) {
      if (!finalResponse) return
      const contextIds = targets.personal ? ['personal'] : [sessionHostId]
      await Promise.all(contextIds.map(contextId =>
        ckService.updateWithLLM(contextId, aiService, profileId, {
          userRequest: run.originalUserRequest,
          commandRecords: [],
          finalResponse
        })
      ))
      return
    }

    const recordsByHost = new Map<string, string[]>()
    const pushRecord = (hostId: string, line: string) => {
      const list = recordsByHost.get(hostId) ?? []
      list.push(line)
      recordsByHost.set(hostId, list)
    }

    for (const step of run.steps) {
      const mapped = step.toolCallId
        ? run.hostOperations?.get(step.toolCallId)
        : undefined
      const bucket = hostIdForKnowledgeRecord({
        mappedHostId: mapped,
        sessionHostId,
        terminalType: run.context.terminalType,
      })
      if (step.type === 'tool_call' && step.toolName && step.toolArgs) {
        const argsStr = Object.entries(step.toolArgs)
          .map(([k, v]) => {
            let str: string
            if (typeof v === 'string') {
              str = v
            } else {
              try { str = JSON.stringify(v) ?? String(v) } catch { str = String(v) }
            }
            return `${k}=${str.substring(0, MAX_ARG_DISPLAY)}`
          })
          .join(', ')
        pushRecord(bucket, `[${step.toolName}] ${argsStr}`)
      }
      if (step.type === 'tool_result' && step.toolName && step.toolResult) {
        pushRecord(bucket, `  → ${step.toolResult.substring(0, MAX_RESULT_DISPLAY)}`)
      }
    }

    const jobs: Promise<unknown>[] = []

    if (targets.personal) {
      const records = [...(recordsByHost.get('personal') ?? [])]
      if (records.length > 0) {
        if (finalResponse) records.push(`\n最终结果: ${finalResponse}`)
        jobs.push(ckService.updateWithLLM('personal', aiService, profileId, {
          userRequest: run.originalUserRequest,
          commandRecords: records
        }))
      } else if (finalResponse) {
        jobs.push(ckService.updateWithLLM('personal', aiService, profileId, {
          userRequest: run.originalUserRequest,
          commandRecords: [],
          finalResponse
        }))
      }
    }

    for (const hostId of targets.hostIds) {
      const records = [...(recordsByHost.get(hostId) ?? [])]
      if (records.length === 0) continue
      if (finalResponse && hostId === sessionHostId) {
        records.push(`\n最终结果: ${finalResponse}`)
      }
      jobs.push(ckService.updateWithLLM(hostId, aiService, profileId, {
        userRequest: run.originalUserRequest,
        commandRecords: records
      }))
    }

    if (jobs.length === 0) return
    await Promise.all(jobs)
  }

  private hostIdentityDeps() {
    return {
      getTerminalType: (id: string): 'local' | 'ssh' | null => {
        const unified = this.services.unifiedTerminalService
        if (unified) return unified.getTerminalType(id)
        return this.services.ptyService ? 'local' : null
      },
      getSshConfig: (id: string) => this.services.sshService?.getConfig(id) || null,
    }
  }

  /**
   * L3: 将对话摘要异步索引到向量库，供跨会话语义检索
   */
  private async indexConversationAsync(
    run: AgentRun,
    status: 'success' | 'failed' | 'aborted',
    result?: string
  ): Promise<void> {
    if (!run.originalUserRequest?.trim()) return

    // 唤醒 run 跳过（"你好"之类的短问候不值得索引）
    if (run.context.wakeup) return

    const knowledgeService = getKnowledgeService()
    if (!knowledgeService || !knowledgeService.isEnabled()) return

    const hostId = sessionKnowledgeHostId({
      terminalType: run.context.terminalType,
      hostId: run.context.hostId,
    })

    await knowledgeService.indexConversation({
      taskId: run.id,
      sessionId: this._sessionId,
      hostId,
      userRequest: run.originalUserRequest,
      finalResult: result || '',
      status,
      timestamp: Date.now()
    })
  }
  
  /**
   * 清理运行资源
   * 注意：技能会话在 Agent 实例级别维护，不在单次 Run 结束时清理
   */
  protected cleanupRun(run: AgentRun): void {
    // 取消输出监听
    if (run.outputUnsubscribe) {
      run.outputUnsubscribe()
      run.outputUnsubscribe = undefined
    }
    
    // 技能会话已提升到 Agent 实例级别，这里不再清理
    // 技能会话会在 Agent.cleanup() 中统一清理
    
    run.isRunning = false
    this.currentStreamingExecutor = undefined
    this._subAgentRoster?.abortAll()
    this._subAgentRoster = undefined
  }
  
  /**
   * 处理运行错误
   *
   * 维护对话记录的对称性：成功路径（finalizeRun）会把最终 assistant 回复追加到
   * taskMessageLog 与 _previousRunMessages，失败路径必须做同样的事，否则下次任务：
   *   • cache path：复用上一次成功 run 的快照，整个失败任务的消息被沉默丢弃，
   *                 AI 完全不知道用户上条消息存在过，无法做错误恢复
   *   • cold start：TaskMemory 中的 messages 缺最终 assistant 回复，AI 看到工具
   *                 调用历史后突然到下一个用户消息，无法理解为什么没有回复
   */
  protected handleError(run: AgentRun, error: unknown): void {
    const errorMessage = error instanceof Error ? error.message : String(error)

    this.addStep({
      type: 'error',
      content: errorMessage
    })

    // 修复运行抛错时可能遗留的悬空 tool_calls：assistant 已宣告调用工具但 tool result
    // 还没产生（典型场景：工具执行中崩溃、AI 流式输出后调下一轮 API 时网络超时）。
    // fixIncompleteToolCalls 会同步补占位到 run.messages 与 run.taskMessageLog
    this._contextWindow.fixIncompleteToolCalls(run, `[执行中断: ${errorMessage}]`)

    // 把错误作为一条 assistant 回复追加到对话日志（与 finalizeRun 的成功路径对称）
    const errorAssistantMsg: AiMessage = {
      role: 'assistant',
      content: `❌ ${errorMessage}`
    }
    if (run.lastAssistantReasoningContent !== undefined) {
      errorAssistantMsg.reasoning_content = run.lastAssistantReasoningContent
    }
    run.messages.push(errorAssistantMsg)
    run.taskMessageLog.push({ ...errorAssistantMsg })

    // 添加 final_result 步骤（错误时也统一由后端生成，❌ 前缀供前端区分成功/失败）
    this.addStep({
      type: 'final_result',
      content: `❌ ${errorMessage}`
    })

    // 提交失败 run 到会话聚合根：错误回复已在上面 push 进 taskMessageLog / run.messages，
    // commitFailedRun 据此存工作记忆（failed）+ 累积 transcript / token。
    // cache 前缀：仅当 run.messages 含 user 消息时才更新（让下个任务的 cache path 看到失败现场）；
    // 否则说明 buildContext 阶段就抛错（半成品序列不合法），传 null 保留上次成功快照、下次走冷启动。
    const hasUserMessage = run.messages.some(m => m.role === 'user')
    this._conversation?.commitFailedRun({
      runId: run.id,
      userRequest: run.originalUserRequest,
      steps: run.steps,
      taskLog: run.taskMessageLog,
      cachePrefix: hasUserMessage ? run.messages : null,
      errorMessage,
      tokenUsage: run.tokenUsage,
      imagesStripped: run.imagesStripped
    })
    if (!this._isSubAgent) {
      this.saveSessionToHistory()
      this.scheduleTitleRefreshIfDue()

      // L3: 异步索引失败的对话（失败经验同样有检索价值）
      this.indexConversationAsync(run, 'failed', errorMessage).catch(err => {
        log.warn('对话向量索引失败:', err)
      })
    }

    this.callbacks?.onError?.(run.id, errorMessage, { aborted: run.aborted })
  }
  
  // ==================== 受保护方法：上下文构建 ====================
  
  /**
   * 构建执行上下文
   */
  protected async buildContext(run: AgentRun, message: string): Promise<void> {
    // 逐任务状态清零（如「主动压缩压不动」的判定）——ContextWindowManager 跨 run 复用
    this._contextWindow.resetForNewRun()

    if (this._isSubAgent && this._seedMessages.length > 0) {
      this.buildSubAgentOpening(run, message)
      return
    }

    // ── Cache-optimized path ──
    // 同一 session 内，直接沿用上一个任务的完整 messages 作为前缀，只追加新 user 消息。
    // LLM 的前缀缓存（Anthropic explicit / DeepSeek·OpenAI automatic）可命中整段前缀。
    // 跳过条件：首次任务、唤醒 run（Watch 等，上下文差异大）、上下文预算不足，
    // 以及「新图首投无图前缀」的跨模型视觉路由（避免把主模型长前缀塞给视觉模型多模态请求；
    // 前缀已有图则说明视觉模型接受过它，照常复用）。
    if (this._previousRunMessages && this._previousRunMessages.length > 0 && !run.context.wakeup) {
      const contextLength = this._contextWindow.getContextLength()
      // 锚点 + 上轮末尾新增：纯锚点会漏掉上一轮的 assistant 回复（它已进前缀）
      const prevTokens = this._contextWindow.estimateCurrentPromptTokens(this._previousRunMessages)
      const configService = this.services.configService
      const skipVisionCache = configService
        ? shouldSkipCachePathForVision({
            mainProfileId: this.profileId,
            activeProfileId: configService.getActiveAiProfile(),
            profiles: configService.getAiProfiles(),
            autoVisionModel: !!configService.get('autoVisionModel'),
            hasImages: this.requestWillContainImages(),
            hasNewImagesThisTurn: this.requestHasNewImagesThisTurn(run),
            prefixHasImages: this.conversationContainsImages(this._previousRunMessages),
            usingCachePath: true,
          })
        : false

      // 有交接检查点：必须接着，不能因窗口变小 / 跨模型视觉路由去把已交原文再展开。
      // 还在这场、没有交接：前缀在就接着用，窗口快满交给本步已有交接，不再退回原文重装。
      if (!this._conversation?.shouldResumeWorkingPrefix({ skipVisionCache })) {
        log.info('[Cache] Skip reuse: cross-model vision routing with images, cold start for compatibility')
      } else {
        run.messages = this._previousRunMessages.map(m => {
          const copy = { ...m }
          delete copy._cacheBreakpoint
          return copy
        })

        this.refreshBrowserBridgeSectionInMessages(run.messages)
        this.refreshLoadedSkillsSectionsInMessages(run.messages)

        const lastPrevMsg = run.messages[run.messages.length - 1]
        if (lastPrevMsg) {
          lastPrevMsg._cacheBreakpoint = true
        }

        const userMsg = await this.buildUserMessage(run, message, true)
        run.messages.push(userMsg)
        run.taskMessageLog.push({ ...userMsg })

        log.info(`[Cache] Reusing ${this._previousRunMessages.length} messages (~${prevTokens} tokens, ${Math.round(prevTokens / contextLength * 100)}% of context)${this._conversation?.hasHandoff() ? ' [handoff]' : ''}`)
        return
      }
    }

    // ── Cold start path: 从零构建上下文 ──

    // messages 即将被重建（无检查点带原文）。有检查点的不会走到这里。
    // 上一轮的 prompt_tokens 不再对应新序列——留着当锚点会对不上这次装配。
    this._conversation?.setLastPromptTokens(undefined)

    // 提前并行启动两个异步操作（均需 embedding + 向量搜索，相互独立）
    const sessionHostId = sessionKnowledgeHostId({
      terminalType: run.context.terminalType,
      hostId: run.context.hostId,
    })
    const knowledgeResultPromise = this.loadKnowledgeContextWithTimeout(message, sessionHostId)

    const L3_RECALL_TIMEOUT_MS = 2000
    const recallPromise: Promise<Array<{ userRequest: string; finalResult: string; status: string; timestamp: number; relevance: number }>> = (() => {
      const ks = getKnowledgeService()
      if (!ks || !ks.isEnabled() || message.trim().length < 5) return Promise.resolve([])
      const searchPromise = ks.searchConversations(message, sessionHostId, 3)
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('L3 recall timeout')), L3_RECALL_TIMEOUT_MS)
      )
      return Promise.race([searchPromise, timeoutPromise])
        .then(results => results.map(r => ({
          userRequest: r.userRequest,
          finalResult: r.finalResult,
          status: r.status,
          timestamp: r.timestamp,
          relevance: r.relevance ?? 0
        })))
        .catch(e => {
          log.warn('L3 auto-recall error:', e)
          return []
        })
    })()

    // 同步操作在异步请求进行期间并发执行
    let taskSummaries = ''
    let relatedTaskDigests = ''
    let recentTaskMessages: AiMessage[] = []
    let availableTaskIds: Array<{ id: string; summary: string }> = []
    
    if (this.taskMemory.getTaskCount() > 0) {
      const contextLength = this._contextWindow.getContextLength()
      // wakeup：广度优先 + 一句话概要，最多 30 条。见 SPEC。
      // 历史预算在「窗口减去固定开销（工具 schema + system prompt）」的剩余空间里分配
      const fixedPrefixTokens = this._contextWindow.getFixedPrefixTokens(this.systemPromptScope(run.context))
      const historyOptions: TaskHistoryOptions = run.context.wakeup
        ? { maxTasks: 30, summaryOnly: true, fixedPrefixTokens }
        : inferConversationKind(this._agentId) === 'companion'
          ? { processLevels: true, fixedPrefixTokens }
          : { fixedPrefixTokens }
      const contextResult = buildTaskHistoryContext(this.taskMemory, contextLength, message, historyOptions)
      
      recentTaskMessages = contextResult.recentTaskMessages
      if (contextResult.taskSummarySection) {
        taskSummaries = contextResult.taskSummarySection
      }
      availableTaskIds = contextResult.availableTaskIds
      
      const relatedDigests = this.taskMemory.getRelatedDigests(message, 3)
      if (relatedDigests.length > 0) {
        relatedTaskDigests = this.taskMemory.formatRelatedDigestsForContext(relatedDigests)
      }
    }
    
    let contextKnowledgeDoc = ''
    try {
      const ckService = getContextKnowledgeService()
      const openHostIds = collectOpenPaneHostIds(
        [run.ptyId, run.context.ptyId, ...(run.context.panes ?? []).map(p => p.ptyId)],
        this.hostIdentityDeps()
      )
      contextKnowledgeDoc = composeKnowledgeDocuments(
        uniqueHosts([sessionHostId, ...openHostIds]).map(contextId => ({
          contextId,
          content: ckService.getDocument(contextId)
        }))
      )
    } catch (e) {
      log.warn('ContextKnowledge load error:', e)
    }

    let watchListSummary = ''
    try {
      const watches = getWatchService().getAll()
      watchListSummary = formatWatchListForPrompt(watches)
    } catch (e) {
      log.warn('Watch list for prompt error:', e)
    }

    // 等待两个异步操作同时完成
    const [knowledgeResult, conversationHistory] = await Promise.all([knowledgeResultPromise, recallPromise])

    const isOnboarding = !(this.services.configService?.getAgentOnboardingCompleted() ?? true)

    const promptOptions: PromptOptions = {
      mbtiType: this.services.configService?.getAgentMbti() ?? undefined,
      knowledgeContext: knowledgeResult.context,
      knowledgeEnabled: knowledgeResult.enabled,
      conversationHistory: conversationHistory.length > 0 ? conversationHistory : undefined,
      contextKnowledgeDoc,
      aiRules: this.services.configService?.getAiRules() ?? '',
      proactiveCompact: this.services.configService?.getProactiveCompact?.(),
      agentName: this.services.configService?.getAgentName() ?? '',
      taskSummaries,
      relatedTaskDigests,
      availableTaskIds,
      watchListSummary: watchListSummary || undefined,
      bondContext: this.resolveBondContext(),
      isOnboarding,
    }
    
    const systemPrompt = this.buildSystemPrompt(run.context, promptOptions)
    // 量下本轮规模，供下一轮预算分配（打破「预算→摘要→system prompt→预算」的循环）
    this._contextWindow.recordSystemPromptTokens(systemPrompt, this.systemPromptScope(run.context))
    run.messages.push({ role: 'system', content: systemPrompt })
    
    if (recentTaskMessages.length > 0) {
      for (const msg of recentTaskMessages) {
        run.messages.push(msg)
      }
    }

    const userMsg = await this.buildUserMessage(run, message, false)
    run.messages.push(userMsg)
    run.taskMessageLog.push({ ...userMsg })
  }

  private buildSubAgentOpening(run: AgentRun, message: string): void {
    const systemPrompt = this.buildSystemPrompt(run.context, {
      aiRules: this.services.configService?.getAiRules() ?? '',
    })
    this._contextWindow.recordSystemPromptTokens(systemPrompt, this.systemPromptScope(run.context))
    const userBody = Agent.formatTimestamp() + Agent.formatWorkbenchTag(run.context.terminalType) + message
    const seed = this._seedMessages
    this._seedMessages = []
    run.messages = [
      { role: 'system', content: systemPrompt },
      ...seed,
      { role: 'user', content: userBody }
    ]
    run.taskMessageLog = [{ role: 'user', content: userBody }]
  }

  /** prompt cache 复用时刷新「现在开着的技能」清单和技能文档 */
  private refreshLoadedSkillsSectionsInMessages(messages: AiMessage[]): void {
    const systemIdx = messages.findIndex(m => m.role === 'system' && typeof m.content === 'string')
    if (systemIdx === -1) return
    const current = messages[systemIdx].content as string
    const roster = buildLoadedSkillsRosterSection(this.getLoadedSkillsRoster())
    const skillsContent = buildSkillsContentSectionText(
      [this.getSkillSession().getLoadedSkillsContent(), this.getLoadedUserSkillsContent()]
        .filter(Boolean)
        .join('\n\n'),
    )
    const patched = patchLoadedSkillsSectionsInSystemPrompt(current, roster, skillsContent)
    if (patched !== current) {
      messages[systemIdx] = { ...messages[systemIdx], content: patched }
    }
  }

  /** prompt cache 复用时刷新 system 消息中的浏览器助手章节（连接状态可能已变） */
  private refreshBrowserBridgeSectionInMessages(messages: AiMessage[]): void {
    const systemIdx = messages.findIndex(m => m.role === 'system' && typeof m.content === 'string')
    if (systemIdx === -1) return
    try {
      const status = getBrowserBridgeService().getStatus()
      const current = messages[systemIdx].content as string
      const patched = patchBrowserBridgeSectionInSystemPrompt(current, status)
      if (patched !== current) {
        messages[systemIdx] = { ...messages[systemIdx], content: patched }
      }
    } catch (error) {
      log.debug('Browser bridge section refresh skipped:', error)
    }
  }

  /**
   * 组装增强后的用户消息
   * @param injectKnowledge cache-reuse 路径下，知识检索结果不在 system prompt 中，需注入到 user 消息
   */
  private async buildUserMessage(run: AgentRun, message: string, injectKnowledge: boolean): Promise<AiMessage> {
    const userBody = this.enhanceUserMessage(message, run.context.terminalType)

    let knowledgeRefs = ''
    if (injectKnowledge) {
      const knowledgeResult = await this.loadKnowledgeContextWithTimeout(
        message,
        sessionKnowledgeHostId({
          terminalType: run.context.terminalType,
          hostId: run.context.hostId,
        })
      )
      knowledgeRefs = knowledgeResult.context
    }

    const systemContextParts: string[] = []
    if (run.context.contextHint?.trim()) {
      systemContextParts.push(run.context.contextHint.trim())
    }
    const proactiveCtx = run.context.proactiveContext
      || (this._agentId ? consumeProactiveContext(this._agentId) : undefined)
    if (proactiveCtx?.trim()) {
      systemContextParts.push(proactiveCtx.trim())
    }
    systemContextParts.push(buildLoadedSkillsThisTurnHint(this.getLoadedSkillsRoster()))
    const hasImages = !!(run.context.images && run.context.images.length > 0)
    const visionAvailable = this.currentProfileHasVision()
    let imageNote = ''
    if (hasImages) {
      const imageCount = run.context.images!.length
      const totalSize = run.context.images!.reduce((sum, img) => sum + img.length, 0)
      const imagePaths = collectImageAttachmentPaths(run.context.attachments)
      log.info(`User images: ${imageCount} image(s), total base64 size: ${(totalSize / 1024).toFixed(0)}KB, vision=${visionAvailable}, paths=${imagePaths.length}`)
      if (!visionAvailable) {
        log.warn(`Dropping ${imageCount} user image(s) due to no vision capability on current profile`)
      }
      imageNote = buildUserImageNote({
        count: imageCount,
        paths: imagePaths,
        visionAvailable,
      })
    }

    const selectionScopeBody = run.context.workbenchContext?.selectionScope
      ? formatSelectionScopeBody(run.context.workbenchContext.selectionScope)
      : ''

    const enhancedMessage = assembleUserMessageContent({
      knowledgeRefs,
      systemContext: systemContextParts.length > 0 ? wrapSystemContext(systemContextParts.join('\n\n')) : undefined,
      selectionScope: selectionScopeBody || undefined,
      userMessage: userBody,
      uploadedDocs: run.context.documentContext,
      imageNote: imageNote || undefined,
    })

    const userMsg: AiMessage = { role: 'user', content: enhancedMessage }
    if (hasImages && visionAvailable) {
      userMsg.images = run.context.images
    }
    return userMsg
  }
  
  /** L2 知识检索超时：不阻塞首 token，超时则跳过召回 */
  private static readonly L2_KNOWLEDGE_TIMEOUT_MS = 2500

  private loadKnowledgeContextWithTimeout(
    message: string,
    hostId?: string,
    timeoutMs = Agent.L2_KNOWLEDGE_TIMEOUT_MS
  ): Promise<KnowledgeContextResult> {
    return new Promise(resolve => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        log.warn(`L2 knowledge context timeout (${timeoutMs}ms), skipping recall`)
        resolve({ context: '', enabled: false, conversationHistory: [] })
      }, timeoutMs)
      this.loadKnowledgeContext(message, hostId)
        .then(result => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(result)
        })
        .catch(e => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          log.warn('Knowledge service error:', e)
          resolve({ context: '', enabled: false, conversationHistory: [] })
        })
    })
  }

  /**
   * 加载知识库上下文
   */
  protected async loadKnowledgeContext(message: string, hostId?: string): Promise<KnowledgeContextResult> {
    let context = ''
    let enabled = false
    
    try {
      const knowledgeService = getKnowledgeService()
      if (knowledgeService && knowledgeService.isEnabled()) {
        enabled = true
        context = await knowledgeService.buildContext(message, { hostId })
      }
    } catch (e) {
      log.warn('Knowledge service error:', e)
    }
    
    return { context, enabled, conversationHistory: [] }
  }
  
  // ==================== 受保护方法：执行循环 ====================
  
  /**
   * 主执行循环
   */
  protected async executeLoop(run: AgentRun): Promise<string> {
    let stepCount = 0
    let lastResponse: ChatWithToolsResult | null = null
    let hasExecutedAnyTool = false
    let noToolCallRetryCount = 0
    let truncationRetryCount = 0
    let contextOverflowRetryCount = 0
    const MAX_NO_TOOL_RETRIES = 2
    const MAX_TRUNCATION_RETRIES = 3
    const MAX_CONTEXT_OVERFLOW_RETRIES = 1
    
    // 创建工具执行器配置
    const toolExecutorConfig = this.createToolExecutorConfig(run)
    
    // 外层循环：支持从 catch 块恢复
    executionLoop: while (run.isRunning && !run.aborted) {
      try {
        // 内层循环：Agent 执行
        while ((run.config.maxSteps === 0 || stepCount < run.config.maxSteps) && run.isRunning && !run.aborted) {
          stepCount++
          
          // 处理待处理的用户消息
          this.processPendingUserMessages(run)
          
          // 执行单步
          const stepResult = await this.executeStep(run, toolExecutorConfig)
          
          if (stepResult.response) {
            lastResponse = stepResult.response
          }
          
          // 输出被截断时强制继续循环（已在 executeStep 中注入续写提示）
          if (stepResult.truncated) {
            truncationRetryCount++
            if (truncationRetryCount >= MAX_TRUNCATION_RETRIES) {
              log.warn('Output repeatedly truncated, giving up continuation')
              return lastResponse?.content || t('agent.no_response')
            }
            continue
          }
          
          if (stepResult.hasToolCalls) {
            hasExecutedAnyTool = true
            noToolCallRetryCount = 0
            truncationRetryCount = 0
            // 每完成一轮工具调用后保存检查点，防止程序意外退出丢失对话记录
            this.saveCheckpoint(run)
          }
          
          // 处理无工具调用的情况
          if (!stepResult.hasToolCalls) {
            if (!hasExecutedAnyTool) {
              // 从未执行过工具
              if (run.pendingUserMessages.length > 0) {
                continue
              }
              
              if (lastResponse?.content?.trim()) {
                // 直接返回，让 run() 方法中的 finalizeRun 处理完成回调
                return lastResponse.content
              }
              
              noToolCallRetryCount++
              if (noToolCallRetryCount >= MAX_NO_TOOL_RETRIES) {
                this.addStep({
                  type: 'error',
                  content: `⚠️ ${t('agent.no_content')}\n\n${t('agent.no_content_reasons')}`
                })
                return t('agent.no_response')
              }
              continue
            }
            
            // 已执行过工具，检查是否有待处理的消息
            if (run.pendingUserMessages.length > 0) {
              continue
            }
            
            // 检查计划进度
            const planAction = this.checkPlanProgress(run)
            if (planAction === 'continue') {
              continue
            }
            
            // 正常结束，直接返回结果
            const finalResult = lastResponse?.content || t('agent.task_complete')
            return finalResult
          }
        }
        
        // 循环正常结束
        break executionLoop
        
      } catch (error) {
        // 检查是否是用户消息中断
        const errorMsg = error instanceof Error ? error.message : String(error)
        const isAborted = errorMsg.toLowerCase().includes('aborted')
        
        if (isAborted && run.pendingUserMessages.length > 0) {
          log.info('AI 输出被用户消息中断，继续循环处理')
          // 修复不完整的 tool_calls 消息序列
          // 当 abort 发生在工具执行过程中时，可能存在 assistant 消息（含 tool_calls）但缺少对应的 tool result
          this._contextWindow.fixIncompleteToolCalls(run)
          continue executionLoop
        }
        
        // 上下文超限兜底：API 返回 context_length_exceeded 时，AI 可能忽略了 85% 警告
        // 仍未调用 compress_context。此时自动紧急压缩早期对话，注入提示后重试当前请求。
        if (
          ContextWindowManager.isContextLimitError(error) &&
          contextOverflowRetryCount < MAX_CONTEXT_OVERFLOW_RETRIES &&
          !run.aborted
        ) {
          // 先修复可能悬空的 tool_calls（API 报错时 assistant 可能已宣告工具但 result 未生成）
          this._contextWindow.fixIncompleteToolCalls(run, `[上下文超限，工具调用已中断]`)
          const compressed = this._contextWindow.emergencyCompress(run)
          if (compressed) {
            this._conversation?.setWorkingContext(run.messages)
            this._conversation?.adoptCompressedArchives(run.compressedArchives)
            // 仅在真正重试时消耗配额（压缩失败时不消耗，避免下次循环跳过本可救的请求）
            contextOverflowRetryCount++
            log.warn(`Context limit exceeded, auto-compressed (kept recent ${compressed.keepRecent}, freed ${compressed.freedTokens} tokens), retrying`)
            // 注入系统提示让 AI 知道发生了什么、当前上下文已压缩
            run.messages.push({
              role: 'user',
              content: t('agent.context_limit_auto_compressed', {
                keepRecent: compressed.keepRecent,
                freed: compressed.freedTokens.toLocaleString()
              }),
              _systemInjected: true
            })
            // 重试当前请求（stepCount 继续正常递增，不重置——失败的这次调用也算一步）
            continue executionLoop
          }
          // 压缩失败（如无 user 消息可压缩）→ 注入失败提示后继续抛出
          run.messages.push({
            role: 'user',
            content: t('agent.context_limit_compress_failed'),
            _systemInjected: true
          })
          log.warn('Context limit exceeded but emergency compress found nothing to compress')
        }
        
        throw error
      }
    }
    
    // 被中止
    if (run.aborted) {
      return t('error.operation_aborted')
    }
    
    return lastResponse?.content || t('agent.task_complete')
  }
  
  /**
   * 执行单步
   */
  protected async executeStep(
    run: AgentRun, 
    toolExecutorConfig: ToolExecutorConfig
  ): Promise<{ response: ChatWithToolsResult | null; hasToolCalls: boolean; truncated?: boolean }> {
    // 更新上下文状态（注入 Context Status + 渐进式提醒）
    // 旧 tool 结果不再做每步微压缩（会提前丢信息并打掉 prompt cache）；
    // 上下文紧张时走 compress_context / proactiveCompress / emergencyCompress。
    this._contextWindow.updatePressure(run)

    // 主动压缩（本地触发路径）：基于上一轮 API 返回的真实 prompt_tokens 预测本轮会超限，
    // 在调用 API 前主动压缩。与 catch 里的 emergencyCompress（API 报错兜底）分工：
    // - 本方法：DeepSeek 等"不报 context_length_exceeded 但会默默截断"的 provider 主力
    // - emergencyCompress：OpenAI 等"会真报错"的 provider 兜底
    // 不限次数：压缩会作废真实用量锚点，要等下一次 API 响应才可能再压，天然隔开轮次
    if (this._contextWindow.shouldProactiveCompress(run)) {
      const compressed = await this._contextWindow.proactiveCompress(run)
      if (compressed) {
        this._conversation?.setWorkingContext(run.messages)
        this._conversation?.adoptCompressedArchives(run.compressedArchives)
        log.warn(`Proactive compress triggered (lastPromptTokens=${this._lastPromptTokens}, contextLength=${this._contextWindow.getContextLength()}, reserve=${this._contextWindow.getCompactionReserveTokens()}), kept recent ${compressed.keepRecent}, freed ${compressed.freedTokens} tokens`)
        run.messages.push({
          role: 'user',
          content: t('agent.context_proactive_compressed', {
            keepRecent: compressed.keepRecent,
            freed: compressed.freedTokens.toLocaleString()
          }),
          _systemInjected: true
        })
      }
    }

    // 发送前：估出来已经装不下就先紧急压缩（冷启动也算）。
    // 主动写交接小结仍只走上面有真实用量的路径；这里用固定模板，避免刚建好的上下文被误拆。
    if (this._contextWindow.needsRequestCompaction(run)) {
      const compressed = this._contextWindow.emergencyCompress(run)
      if (compressed) {
        this._conversation?.setWorkingContext(run.messages)
        this._conversation?.adoptCompressedArchives(run.compressedArchives)
        log.warn(`Pre-send compact (lastPromptTokens=${this._lastPromptTokens}, inputLimit=${this._contextWindow.getInputLimit()}), kept recent ${compressed.keepRecent}, freed ${compressed.freedTokens} tokens`)
      }
      if (this._contextWindow.needsRequestCompaction(run)) {
        throw new Error(t('error.context_length_exceeded'))
      }
    }

    // 记录流式执行前的步骤数，用于后续 ensureToolResultStep 正确检测预执行工具的步骤
    const stepCountBeforeStreaming = run.steps.length

    // 创建流式工具执行器：AI 流式输出过程中提前启动工具，并在每个工具完成的瞬间
    // 立即把 UI 卡片切到完成态（"完成一个显示一个"），不必等 AI 整段输出结束。
    const availableToolNames = new Set(this.getAvailableTools().map(t => t.function.name))
    const streamingExecutor = new StreamingToolExecutor({
      run,
      executeFn: (toolCall, options) => {
        const share = options?.parallelShare ?? 1
        const config =
          share > 1
            ? this.withParallelToolOutputBudget(toolExecutorConfig, share)
            : toolExecutorConfig
        return this.executeToolWithChecks(run, toolCall, config)
      },
      availableToolNames,
      isConcurrencySafe: (name) => this.isParallelizableTool(name),
      onToolCompleted: ({ toolCall, result }) => {
        log.info(`[onToolCompleted] tool=${toolCall.function.name} id=${toolCall.id} success=${result.success}`)
        // 仅做 UI 层回填（兜底 tool_result + finalizeToolCallStep），消息历史
        // 仍保留按 toolCalls 原始顺序在 executeToolCallsWithStreaming 中统一写入。
        this.ensureToolResultStep(run, stepCountBeforeStreaming, toolCall, result)
        this.finalizeToolCallStep(run, toolCall.id, result.success)
      }
    })
    this.currentStreamingExecutor = streamingExecutor
    
    // 调用 AI（传入流式执行器，使其在流式输出中提前执行工具）
    const response = await this.callAiWithStreaming(run, streamingExecutor)

    // 流式参数早失败：streamValidate 在生成阶段命中并中止了请求。此时 response 通常
    // 不含完整 tool_calls，需要合成「带 tool_calls 的 assistant 消息 + 失败 tool 结果」，
    // 让循环继续、模型根据错误改用正确方式（如 overwrite）重试。
    if (run.streamEarlyFailures && run.streamEarlyFailures.size > 0) {
      // 先收集流式执行器已投入并完成的工具结果：abort 只停掉未开始的，已完成的可能已有
      // 副作用（如 read_file 已读、写文件已落盘），不能丢弃——否则同批多个 tool_call 里
      // 已完成的那个会静默丢失，消息历史也少一条 tool 结果。
      const preExecuted = await streamingExecutor.waitForAll()
      streamingExecutor.abort()
      try {
        // 合成一条带全部 tool_calls 的 assistant 消息（已完成的 + 早失败的），
        // 后接所有 tool 结果。协议要求：一条 assistant.tool_calls 对应紧随其后的
        // 若干 role=tool 消息，且每个 tool_call_id 都有匹配——不能把每个 tool_call
        // 拆成独立 assistant 消息，也不能让已完成工具的 tool 结果悬空。
        const allToolCalls: ToolCall[] = [
          ...preExecuted.map(r => r.toolCall),
          ...[...run.streamEarlyFailures.entries()].map(([toolCallId, failure]) => ({
            id: toolCallId,
            type: 'function' as const,
            function: { name: failure.toolName, arguments: JSON.stringify(failure.args) }
          }))
        ]
        const assistantMsg: AiMessage = {
          role: 'assistant',
          content: response.content ?? '',
          tool_calls: allToolCalls
        }
        if (response.reasoning_content !== undefined) {
          assistantMsg.reasoning_content = response.reasoning_content
        }
        run.messages.push(assistantMsg)
        run.taskMessageLog.push({ ...assistantMsg })

        const collapsedEarly = collapseRepeatedToolOutputs(
          run.messages,
          preExecuted.map(item => ({ id: item.toolCall.id, result: item.result }))
        )
        for (let i = 0; i < preExecuted.length; i++) {
          const completed = preExecuted[i]
          const result = collapsedEarly[i]
          if (result !== completed.result) {
            this.refreshToolResultPreview(run, stepCountBeforeStreaming, completed.toolCall, result)
          }
          this.processToolResult(run, completed.toolCall, result, completed.toolArgs)
        }
        for (const [toolCallId, failure] of run.streamEarlyFailures) {
          const toolCall: ToolCall = {
            id: toolCallId,
            type: 'function',
            function: { name: failure.toolName, arguments: JSON.stringify(failure.args) }
          }
          this.processToolResult(run, toolCall, { success: false, output: '', error: failure.error }, failure.args)
          this.finalizeToolCallStep(run, toolCallId, false)
        }
      } finally {
        run.streamEarlyFailures.clear()
      }
      return { response, hasToolCalls: true }
    }

    // 缓存最近一次 assistant 响应的 reasoning_content
    // finalizeRun 的最终纯文本 assistant 消息会从这里取（思考模式必须回传）
    if (response.reasoning_content !== undefined) {
      run.lastAssistantReasoningContent = response.reasoning_content
    }

    // 处理 finish_reason=length（输出被 max_tokens 截断）
    if (response.finish_reason === 'length') {
      streamingExecutor.abort()
      
      const totalToolCalls = response.tool_calls?.length || 0
      const validToolCalls = (response.tool_calls || []).filter(tc => {
        if (!tc.id || !tc.function.name || !tc.function.arguments) return false
        try { JSON.parse(tc.function.arguments); return true }
        catch (e) { if (e instanceof SyntaxError) return false; throw e }
      })
      const discardedCount = totalToolCalls - validToolCalls.length
      
      if (discardedCount > 0) {
        log.warn(`Output truncated (finish_reason=length): discarded ${discardedCount}/${totalToolCalls} tool_calls with incomplete arguments`)
      } else if (totalToolCalls === 0) {
        log.warn(`Output truncated (finish_reason=length): text content may be incomplete`)
      }
      
      // 有有效的工具调用 → 正常执行，截断的已被丢弃
      if (validToolCalls.length > 0) {
        log.info(`Proceeding with ${validToolCalls.length} valid tool_calls despite truncation`)
        response.tool_calls = validToolCalls
      } else {
        const truncationHint: AiMessage = {
          role: 'assistant',
          content: response.content || ''
        }
        if (response.reasoning_content !== undefined) {
          truncationHint.reasoning_content = response.reasoning_content
        }
        run.messages.push(truncationHint)
        run.taskMessageLog.push({ ...truncationHint })
        
        const continuationPrompt: AiMessage = {
          role: 'user',
          content: t('agent.output_truncated_hint'),
          _systemInjected: true
        }
        run.messages.push(continuationPrompt)
        run.taskMessageLog.push({ ...continuationPrompt })
        
        this.addStep({
          type: 'thinking',
          content: `⚠️ ${t('agent.output_truncated')}`
        })
        
        return { response, hasToolCalls: false, truncated: true }
      }
    }
    
    // 处理工具调用
    if (response.tool_calls && response.tool_calls.length > 0) {
      const validToolCalls = response.tool_calls.filter(tc => {
        if (!tc.id || !tc.function.name || !tc.function.arguments) return false
        try { JSON.parse(tc.function.arguments); return true }
        catch (e) { if (e instanceof SyntaxError) return false; throw e }
      })
      
      if (validToolCalls.length < response.tool_calls.length) {
        log.warn(`Discarded ${response.tool_calls.length - validToolCalls.length} tool_calls with malformed arguments`)
      }
      
      if (validToolCalls.length === 0) {
        streamingExecutor.abort()
        const discardedNames = response.tool_calls.map(tc => tc.function?.name || 'unknown').join(', ')
        log.warn(`All tool_calls discarded due to malformed arguments: [${discardedNames}], triggering retry`)
        
        const assistantMsg: AiMessage = {
          role: 'assistant',
          content: response.content || ''
        }
        if (response.reasoning_content !== undefined) {
          assistantMsg.reasoning_content = response.reasoning_content
        }
        run.messages.push(assistantMsg)
        run.taskMessageLog.push({ ...assistantMsg })
        
        const retryHint: AiMessage = {
          role: 'user',
          content: t('agent.tool_args_malformed', { tools: discardedNames }),
          _systemInjected: true
        }
        run.messages.push(retryHint)
        run.taskMessageLog.push({ ...retryHint })
        
        this.addStep({
          type: 'thinking',
          content: `⚠️ ${t('agent.tool_args_malformed_step', { tools: discardedNames })}`
        })
        
        return { response, hasToolCalls: false, truncated: true }
      }
      
      // 移除初始步骤
      if (run.initialStepId) {
        this.removeStep(run.initialStepId)
        run.initialStepId = undefined
      }
      
      // 添加 assistant 消息到历史
      // DeepSeek V3.2+ 思考模式：带 tool_calls 的 assistant 消息后续请求必须回传 reasoning_content
      // 这里用 !== undefined 确保即使模型只返回空字符串也会被保留（避免 || 把空串转成 undefined）
      const assistantMsg: AiMessage = {
        role: 'assistant',
        content: response.content || '',
        tool_calls: validToolCalls
      }
      if (response.reasoning_content !== undefined) {
        assistantMsg.reasoning_content = response.reasoning_content
      }
      run.messages.push(assistantMsg)
      run.taskMessageLog.push({ ...assistantMsg })
      
      // 执行工具调用（流式执行器可能已完成部分工具）
      await this.executeToolCallsWithStreaming(run, validToolCalls, toolExecutorConfig, streamingExecutor, stepCountBeforeStreaming)
      
      return { response, hasToolCalls: true }
    }
    
    return { response, hasToolCalls: false }
  }
  
  // ==================== 受保护方法：AI 交互 ====================
  
  /**
   * 本次请求是否会在 API 消息体中带有多模态图片（与 AiService.formatMessageForApi 一致：仅 user 消息的 images）
   * 注意：不能只检查「最新一轮 user 是否带图」。历史 user 消息里的 images 仍会原样发给 API，
   * 若主模型不支持视觉却未切换到关联视觉模型，会报错（例如火山 deepseek「Model do not support image input」）。
   */
  private conversationContainsImages(messages: AiMessage[]): boolean {
    return messages.some(m =>
      m.role === 'user' &&
      !!m.images?.some(url => toSendableVisionImageUrl(url) !== null)
    )
  }

  /**
   * 本轮是否「新增」图片：用户消息自带的图（context.images）或待 flush 补充消息里的图。
   * 与 requestWillContainImages 的区别：不含 cache 前缀/历史消息里已有的图——
   * 那是视觉模型已经接受过的内容，只有「新图首投」才需要避开主模型前缀。
   */
  private requestHasNewImagesThisTurn(run: AgentRun): boolean {
    if (run.context.images && run.context.images.length > 0) return true
    return run.pendingUserMessages.some(p => !!(p.images && p.images.length > 0))
  }

  /**
   * 预算侧「有没有图」：复用 conversationContainsImages，只看两处——
   * 已组装的 messages（或 cache 前缀 _previousRunMessages）+ 本轮即将附带的 context.images。
   * 不扫 taskMemory / conversation 全文：联络热路径靠 cache 前缀已够；冷启动偶发低估靠 emergencyCompress 兜底。
   */
  private requestWillContainImages(): boolean {
    const assembled = this.currentRun?.messages?.length
      ? this.currentRun.messages
      : this._previousRunMessages
    if (assembled?.length && this.conversationContainsImages(assembled)) return true
    const pending = this.currentRun?.context?.images
    return !!(pending && pending.length > 0)
  }

  /**
   * 上下文预算用的 profileId：与实际 API 调用（resolveEffectiveProfileId）对齐。
   * ContextWindowManager.getContextLength / cache path / tool-output-budget / UI stamp 都走这里。
   */
  private resolveContextBudgetProfileId(): string | undefined {
    const configService = this.services.configService
    if (!configService) return this.profileId
    return resolveBudgetProfileId({
      mainProfileId: this.profileId,
      activeProfileId: configService.getActiveAiProfile(),
      profiles: configService.getAiProfiles(),
      autoVisionModel: !!configService.get('autoVisionModel'),
      hasImages: this.requestWillContainImages(),
    })
  }

  /**
   * 主动压缩的 AI 小结：在当前完整对话后追加一条小结指令，调一次非流式 chat。
   * 小结写给未来的自己（提示词见 i18n agent.compress_summary_prompt，只描述
   * 归档后的处境、由模型自己判断该写什么）；返回 null 由 ContextWindowManager
   * 回退固定模板。
   *
   * 模型与上下文预算同一 profile（resolveContextBudgetProfileId），避免按主模型
   * 算预算却打到视觉模型。压不动时会停止重试，不会反复烧摘要调用。
   */
  private async summarizeForCompression(
    opts: { conversation: AiMessage[]; keepRecent: number; userHint?: string }
  ): Promise<string | null> {
    const aiService = this.services.aiService
    if (!aiService?.chatWithTools) return null
    if (opts.conversation.length === 0) return null
    // 小结指令作为一条 user 消息追加在当前对话末尾：前缀与上一轮逐字一致，
    // provider 的前缀缓存直接命中（实测 99%）；模型也是在原本语境里写，
    // 不必读一份拍平的转录。这条指令不进 run.messages，只用于这一次调用。
    //
    // tools 照常带上：schema 是前缀的一部分，不带就等于换了前缀、白丢整段缓存。
    // 指令末尾已说明这一步只写小结不执行操作，模型据此直接回文本（实测缓存 98%）。
    const messages: AiMessage[] = [
      ...opts.conversation,
      {
        role: 'user',
        content: [
          t('agent.compress_summary_prompt', {
            budget: SUMMARY_OUTPUT_BUDGET_CHARS,
            keepRecent: opts.keepRecent
          }),
          opts.userHint?.trim() ? t('agent.compress_summary_user_hint', { hint: opts.userHint.trim() }) : ''
        ].filter(Boolean).join('\n\n')
      }
    ]
    const tools = stripToolMeta(this.getAvailableTools())
    const profileId = this.resolveContextBudgetProfileId()
    const summaryInputLimit = this._contextWindow.getInputLimit(SUMMARY_MAX_OUTPUT_TOKENS)
    if (this._contextWindow.estimateTotalTokens(messages) > summaryInputLimit) {
      log.warn(`Compaction summary skipped: estimated input exceeds summary budget (${summaryInputLimit})`)
      return null
    }

    const first = await aiService.chatWithTools(messages, tools, profileId, undefined, {
      maxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS
    })
    if (first?.content?.trim()) return first.content.trim()

    // 模型没写正文、转头去调工具了。再要一次并禁止调用——部分 provider 在
    // tool_choice='none' 下不再把 tools 计入 prompt，这一次拿不到缓存，
    // 但比压缩落空强。仍不给正文就交给固定模板收场。
    log.warn('Compaction summary returned no text (model chose tools); retrying with tool calls disabled')
    const retry = await aiService.chatWithTools(messages, tools, profileId, undefined, {
      toolChoice: 'none',
      maxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS
    })
    return retry?.content?.trim() || null
  }

  /** 解析拟用 / 已确认 profile 的展示字段写入 bar（不 publish） */
  private applyProfileFieldsToContextBar(
    bar: AgentContextBar,
    profileId?: string
  ): string | undefined {
    const configService = this.services.configService
    if (!configService) return profileId
    const effectiveId =
      profileId || this.resolveContextBudgetProfileId() || configService.getActiveAiProfile()
    if (!effectiveId) return undefined
    bar.profileId = effectiveId
    const profile = configService.getAiProfiles().find(p => p.id === effectiveId)
    if (profile?.contextLength) bar.effectiveContextLength = profile.contextLength
    if (profile?.name) bar.effectiveModel = profile.name
    return effectiveId
  }

  /** 把拟用模型写入 step（历史落盘用；实时状态栏走 contextBar） */
  private stampEffectiveProfileOnStep(step: AgentStep, profileId?: string): void {
    const bar: AgentContextBar = {}
    this.applyProfileFieldsToContextBar(bar, profileId)
    if (bar.effectiveContextLength !== undefined) step.effectiveContextLength = bar.effectiveContextLength
    if (bar.effectiveModel !== undefined) step.effectiveModel = bar.effectiveModel
  }

  private setContextBar(bar: AgentContextBar): void {
    this.stampConsumedOnContextBar(bar)
    this._contextBar = bar
    const agentKey = this._agentId ?? this.currentRun?.id ?? ''
    this.callbacks?.onContextBar?.(agentKey, { ...bar })
  }

  private resetConsumedUsage(): void {
    this._consumedUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    this._pendingUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  }

  private addConsumedUsage(usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }): void {
    this._consumedUsage.prompt_tokens += usage.prompt_tokens
    this._consumedUsage.completion_tokens += usage.completion_tokens
    this._consumedUsage.total_tokens += usage.total_tokens
  }

  /**
   * system prompt 规模读数的适用范围：同一 profile + 终端模式下才可复用。
   * 换了模型或模式（local/ssh/assistant 的提示词规模差数千 tokens）就得重新量。
   */
  private systemPromptScope(context: AgentContext): string {
    return `${this.resolveContextBudgetProfileId() ?? 'default'}:${context.terminalType ?? 'local'}`
  }

  /** 本轮请求开始：先把 prompt 估算挂上，数字立刻跳起来，等流式输出再往上加。 */
  private beginPendingUsage(run: AgentRun): void {
    // 与压力判断同口径（锚点 + 增量），避免这里独自走全量重估
    const promptEst = this._contextWindow.estimateCurrentPromptTokens(run.messages)
    this._pendingUsage = {
      prompt_tokens: promptEst,
      completion_tokens: 0,
      total_tokens: promptEst,
    }
  }

  private updatePendingCompletion(streamText: string): void {
    const completionEst = estimateTextTokens(streamText)
    if (completionEst <= this._pendingUsage.completion_tokens) return
    this._pendingUsage.completion_tokens = completionEst
    this._pendingUsage.total_tokens = this._pendingUsage.prompt_tokens + completionEst
  }

  /** 精确 usage 入账并清掉估算；没有精确值则把估算折算进去，避免中断后数字回退。 */
  private commitPendingUsage(usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }): void {
    if (usage) {
      this.addConsumedUsage(usage)
    } else if (this._pendingUsage.total_tokens > 0) {
      this.addConsumedUsage(this._pendingUsage)
    }
    this._pendingUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  }

  private liveConsumed(): TokenUsage {
    return {
      prompt_tokens: this._consumedUsage.prompt_tokens + this._pendingUsage.prompt_tokens,
      completion_tokens: this._consumedUsage.completion_tokens + this._pendingUsage.completion_tokens,
      total_tokens: this._consumedUsage.total_tokens + this._pendingUsage.total_tokens,
    }
  }

  private publishConsumedLive(): void {
    this.setContextBar({ ...this._contextBar })
  }

  /** 把本进程累计消耗写入 bar（含进行中估算；为 0 则去掉字段） */
  private stampConsumedOnContextBar(bar: AgentContextBar): void {
    const used = this.liveConsumed()
    if (used.total_tokens > 0) {
      bar.consumedTokens = used.total_tokens
      bar.consumedPromptTokens = used.prompt_tokens
      bar.consumedCompletionTokens = used.completion_tokens
    } else {
      delete bar.consumedTokens
      delete bar.consumedPromptTokens
      delete bar.consumedCompletionTokens
    }
  }

  /**
   * 请求启动：暂挂上轮 API 确认的 token/cache + 本轮拟用 model/limit。
   * 换模型则丢掉旧 Cache%（不能张冠李戴）。
   */
  private publishPlannedContextBar(): void {
    const plannedId =
      this.resolveContextBudgetProfileId() ||
      this.services.configService?.getActiveAiProfile()
    const bar: AgentContextBar = {}
    if (this._lastPromptTokens !== undefined) {
      bar.contextTokens = this._lastPromptTokens
    }
    if (
      this._lastCacheHitRate !== undefined &&
      plannedId &&
      this._lastStatsProfileId === plannedId
    ) {
      bar.cacheHitRate = this._lastCacheHitRate
    } else if (plannedId && this._lastStatsProfileId && plannedId !== this._lastStatsProfileId) {
      this._conversation?.setLastCacheHitRate(undefined)
    }
    // 保留上轮组成树，直到本轮发请求前刷新
    if (this._contextBar.composition) {
      bar.composition = this._contextBar.composition
    }
    this.applyProfileFieldsToContextBar(bar, plannedId)
    this.setContextBar(bar)
  }

  /**
   * 用新步骤接替「正在准备」占位。上下文栏已独立推送，这里只保证步骤流顺序
   * （先 add 再 remove，避免前端 steps 瞬时为 0）。
   */
  private addStepReplacingInitial(
    run: AgentRun,
    step: Partial<AgentStep>,
    _effectiveProfileId?: string
  ): AgentStep {
    const created = this.addStep(step)
    if (run.initialStepId) {
      this.removeStep(run.initialStepId)
      run.initialStepId = undefined
    }
    return created
  }

  /**
   * 当前 Agent 使用的 profile 是否具备视觉能力。
   * 用于在拼装消息阶段判断是否应该携带 base64 图片：
   * - 不具备能力时附带图片，部分网关会静默丢弃 image_url（既不报错也不处理），
   *   但 AI 仍会因 system 提示「图片已嵌入」而假装看到图片，进而瞎编内容。
   * - 因此无视觉能力时应主动剥图，并在文本里告知 AI「用户附了图但你看不到」，
   *   让模型如实告诉用户改用视觉模型。
   */
  private currentProfileHasVision(): boolean {
    const configService = this.services.configService
    if (!configService) return false
    return configService.hasVisionCapability(this.profileId)
  }
  
  /**
   * 解析本次 API 调用应使用的 profileId
   * 当满足以下条件时自动切换到视觉模型：
   * 1. autoVisionModel 全局开关已启用
   * 2. 当前主模型配置了 visionProfileId
   * 3. 整条 messages 中仍有带 images 的 user 消息（formatMessageForApi 会一并发出）
   *
   * 与 resolveContextBudgetProfileId 共用 resolveBudgetProfileId，保证预算与实际调用一致。
   */
  private resolveEffectiveProfileId(run: AgentRun): string | undefined {
    const configService = this.services.configService
    if (!configService) return this.profileId

    const effectiveId = resolveBudgetProfileId({
      mainProfileId: this.profileId,
      activeProfileId: configService.getActiveAiProfile(),
      profiles: configService.getAiProfiles(),
      autoVisionModel: !!configService.get('autoVisionModel'),
      hasImages: this.conversationContainsImages(run.messages),
    })

    if (effectiveId && effectiveId !== (this.profileId || configService.getActiveAiProfile())) {
      const profiles = configService.getAiProfiles()
      const main = profiles.find(p => p.id === (this.profileId || configService.getActiveAiProfile()))
      const vision = profiles.find(p => p.id === effectiveId)
      log.info(`Vision routing: switching from ${main?.model} to ${vision?.model || effectiveId}`)
    }

    return effectiveId
  }
  
  private pickRandomWaitingLabelId(ids: readonly string[]): string {
    return ids[Math.floor(Math.random() * ids.length)]
  }

  /**
   * 从共享池随机挑选等待首 token 的展示文案（5% 彩蛋池）。
   * 调用方 markWaitingForFirstToken 已按 features.bond 门控。
   */
  private pickWaitingForModelLabel(): string {
    const useEasterEgg = Math.random() < WAITING_FOR_MODEL_EASTER_EGG_CHANCE
    if (useEasterEgg) {
      const id = this.pickRandomWaitingLabelId(WAITING_FOR_MODEL_EASTER_EGG_LABEL_IDS)
      return t(waitingForModelI18nKey(id, 'easter') as TranslationKey)
    }
    const id = this.pickRandomWaitingLabelId(WAITING_FOR_MODEL_LABEL_IDS)
    return t(waitingForModelI18nKey(id) as TranslationKey)
  }

  /** TTFT 过长时切换为调侃文案（调用方已按 features.bond 门控） */
  private pickSlowWaitingForModelLabel(): string {
    const id = this.pickRandomWaitingLabelId(WAITING_FOR_MODEL_SLOW_LABEL_IDS)
    return t(waitingForModelI18nKey(id, 'slow') as TranslationKey)
  }

  /** 上下文就绪、HTTP 即将发出：「正在准备…」→ 随机趣味等待文案 */
  private markWaitingForFirstToken(run: AgentRun): void {
    if (!run.initialStepId) return
    if (!isOemFeatureEnabled('bond')) return
    this.updateStep(run.initialStepId, {
      content: this.pickWaitingForModelLabel(),
      isStreaming: true,
    })
  }

  /** 首 token 仍未到达且占位步骤仍在时，切换为 slow 调侃文案 */
  private markSlowWaitingForFirstToken(run: AgentRun): void {
    if (!run.initialStepId) return
    if (!isOemFeatureEnabled('bond')) return
    this.updateStep(run.initialStepId, {
      content: this.pickSlowWaitingForModelLabel(),
      isStreaming: true,
    })
  }

  /**
   * 流式调用 AI
   * @param streamingExecutor 可选的流式工具执行器，传入时会在流式过程中提前启动工具执行
   */
  protected async callAiWithStreaming(run: AgentRun, streamingExecutor?: StreamingToolExecutor): Promise<ChatWithToolsResult> {
    // 用 let 而非 const：第一次 onChunk 时若 initial "正在准备..." step 还在，
    // 会把 streamStepId 复用为 initialStepId，让前端 list item identity 保持不变（详见 onChunk 分支）
    let streamStepId = this.generateId()
    let streamContent = ''
    let lastContentUpdate = 0
    let pendingUpdate = false
    let streamStepCreated = false
    // 最近一次重试提示步骤的 id（用 waiting 类型，让用户知道"自动重试中"，避免误以为卡住）
    // 重试成功（首次 onChunk 到达）/ 最终失败（onError）/ 完成（onDone 兜底）时停掉 streaming 状态
    let lastRetryStepId: string | undefined
    let lastRetryParams: Record<string, string> | undefined
    let retryCountdownTimer: ReturnType<typeof setInterval> | undefined
    // 每个 toolCallId 独立节流（多个 tool_call 并行流式时互不干扰）
    const toolProgressThrottle = new Map<string, number>()
    const toolMetaCache = new Map<string, ReturnType<typeof getMetaByName>>()
    const STREAM_THROTTLE_MS = 100
    const TOOL_PROGRESS_THROTTLE_MS = 120
    let slowTtftTimer: ReturnType<typeof setTimeout> | undefined
    const clearSlowTtftTimer = () => {
      if (slowTtftTimer !== undefined) {
        clearTimeout(slowTtftTimer)
        slowTtftTimer = undefined
      }
    }
    const scheduleSlowTtftHint = () => {
      clearSlowTtftTimer()
      slowTtftTimer = setTimeout(() => {
        slowTtftTimer = undefined
        if (streamStepCreated || !run.initialStepId) return
        this.markSlowWaitingForFirstToken(run)
      }, WAITING_FOR_MODEL_SLOW_TTFT_MS)
    }

    // 把当前"正在重试"卡片定稿（关闭 spinner、改成「已重试」），保留卡片作为审计痕迹。
    // 触发时机：重试成功（首次 onChunk）/ 整体完成（onDone）/ 最终失败（onError）/ 下一轮重试开始
    const clearRetryCountdown = () => {
      if (retryCountdownTimer !== undefined) {
        clearInterval(retryCountdownTimer)
        retryCountdownTimer = undefined
      }
    }
    const finalizeRetryStep = () => {
      clearRetryCountdown()
      if (lastRetryStepId) {
        const doneContent = lastRetryParams
          ? `🔄 ${t('agent.retry_done', lastRetryParams)}`
          : undefined
        this.updateStep(lastRetryStepId, {
          isStreaming: false,
          ...(doneContent ? { content: doneContent } : {})
        })
        lastRetryStepId = undefined
        lastRetryParams = undefined
      }
    }
    
    const sendContentUpdate = () => {
      // reasoning 块一旦闭合（</details> 出现意味着 AI 已结束思考、切到 content 或 tool_calls 阶段），
      // 立刻把 <details open> 替换为 <details> 折叠思考卡。不这样做的话会等到整个流结束（onDone）
      // 才折叠，而 tool_calls 参数流式（尤其 write_text_file 的 content）动辄几秒到几十秒，
      // 用户会误以为"思考还在进行"。替换是幂等的，onDone 里的 replace 继续作为兜底。
      if (streamContent.includes('</details>') && streamContent.includes('<details open>')) {
        streamContent = streamContent.replace(/<details open>/g, '<details>')
      }
      this.updateStep(streamStepId, {
        type: 'message',
        content: streamContent,
        isStreaming: true
      })
      lastContentUpdate = Date.now()
      pendingUpdate = false
      this.updatePendingCompletion(streamContent)
      this.publishConsumedLive()
    }
    
    const availableTools = this.getAvailableTools()
    // 发给 LLM 之前剥离 _meta（内部元数据，发出去会浪费 token）
    const llmTools = stripToolMeta(availableTools)

    // 字数组成树：在 stripToolMeta 之后、真正发请求前测量，写入 contextBar（onDone 只更新总量）
    const composition = measureContextComposition(run.messages, llmTools)
    // 本次请求带出去多少条消息——响应回来时与真实 prompt_tokens 配对记入 ledger。
    // 必须在这里取：onDone 时 messages 可能已经追加了本轮的 assistant / tool。
    const requestMessageCount = run.messages.length
    this.beginPendingUsage(run)
    {
      const bar: AgentContextBar = { ...this._contextBar, composition }
      this.applyProfileFieldsToContextBar(bar)
      this.setContextBar(bar)
    }

    // Plugin hook: before_ai_request (must run before the Promise callback)
    const hookBus = this.services.pluginRegistry?.hookBus
    if (hookBus?.hasHandlers('before_ai_request')) {
      await hookBus.trigger('before_ai_request', {
        messages: run.messages as Array<{ role: string; content: string }>,
        tools: llmTools
      })
    }

    return new Promise<ChatWithToolsResult>((resolve, reject) => {
      streamContent = ''
      lastContentUpdate = 0
      pendingUpdate = false
      streamStepCreated = false
      toolProgressThrottle.clear()

      run.requestId = run.id
      
      let effectiveProfileId = this.resolveEffectiveProfileId(run)

      this.markWaitingForFirstToken(run)
      scheduleSlowTtftHint()

      // 指定 profile 失效回退时：纠正本 Agent 绑定，并在步骤流提示用户（避免每轮重复回退）
      const unsubProfileFallback =
        typeof this.services.aiService.onProfileFallback === 'function'
          ? this.services.aiService.onProfileFallback((notice) => {
              this.profileId = notice.usedId
              this.addStep({
                type: 'message',
                content: t('agent.profile_fallback', { name: notice.usedName })
              })
            })
          : () => {}

      this.services.aiService.chatWithToolsStream(
        run.messages,
        llmTools,
        // onChunk
        (chunk) => {
          streamContent += chunk
          const now = Date.now()
          
          // 第一次收到内容：把 initial "正在准备..." step 和"思考中"拆成两个 step——
          // 新 addStep 一个 message step 到步骤流**末尾**，再 removeStep(initial 占位)。
          // 拆分（而非原地复用占位 step）的原因：占位 step 在 initializeRun 时就已创建在
          // 步骤流前部，准备阶段追加的 user_supplement 落在它之后；若复用它的位置改成
          // message，思考/消息就会出现在补充消息之前——与"agent 已收到补充消息才开始思考"
          // 的时序相反。拆分后思考 step 自然追加到末尾，补充消息留在它之前。
          // 先 add 新 message 再 remove 旧占位，避免前端 steps 出现瞬时为 0 的中间态。
          // 不继承占位 step 的 timestamp：思考中只计思考时长（从首 token 起），等待首 token
          // 的时长由占位 step 自己在等待期间显示（趣味用语 + N.Ns），随占位 step 一并移除。
          if (!streamStepCreated) {
            streamStepCreated = true
            clearSlowTtftTimer()
            // 重试成功：把上一次的"正在重试..."提示定稿（保留卡片但停掉 spinner）
            finalizeRetryStep()
            // 接替 initial 占位时带走 contextTokens/effective*，否则流式阶段 UI 会回退主模型
            this.addStepReplacingInitial(run, {
              id: streamStepId,
              type: 'message',
              content: streamContent,
              isStreaming: true,
            }, effectiveProfileId)
            lastContentUpdate = Date.now()
            this.updatePendingCompletion(streamContent)
            this.publishConsumedLive()
            return
          }
          
          if (now - lastContentUpdate >= STREAM_THROTTLE_MS) {
            sendContentUpdate()
          } else if (!pendingUpdate) {
            pendingUpdate = true
            setTimeout(() => {
              if (pendingUpdate) {
                sendContentUpdate()
              }
            }, STREAM_THROTTLE_MS)
          }
        },
        // onToolCall
        (_toolCalls) => {
          // 工具调用在 onDone 中处理
        },
        // onDone
        (result) => {
          clearSlowTtftTimer()
          pendingUpdate = false
          // 预创建的 tool_call 卡片保留、稍后由工具执行器接管（见 executeToolWithChecks 中的 addStep 拦截）
          // 此处只把仍处于 isStreaming 的预卡片停掉光标，避免"参数没来得及更新但模型已结束"的极端情况下卡片一直抖
          if (run.pendingPreToolCallStepIds) {
            for (const [, stepId] of run.pendingPreToolCallStepIds) {
              this.updateStep(stepId, { isStreaming: false })
            }
          }
          // 重试成功但服务端立即返回（无 content/tool_call 流）时，onChunk 不会触发，这里兜底关掉 spinner
          finalizeRetryStep()

          // 视觉模型拒图后剥图重试成功：标记本轮，commit 时把 cache 前缀快照里的 images 剔除（防毒前缀循环）
          if (result.imagesStripped) {
            run.imagesStripped = true
          }

          // 累积 token usage（由 LLM provider 返回的精确值）
          if (result.usage) {
            if (!run.tokenUsage) {
              run.tokenUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
            }
            run.tokenUsage.prompt_tokens += result.usage.prompt_tokens
            run.tokenUsage.completion_tokens += result.usage.completion_tokens
            run.tokenUsage.total_tokens += result.usage.total_tokens
            if (result.usage.cache_hit_tokens !== undefined) {
              run.tokenUsage.cache_hit_tokens = (run.tokenUsage.cache_hit_tokens || 0) + result.usage.cache_hit_tokens
            }
            if (result.usage.cache_miss_tokens !== undefined) {
              run.tokenUsage.cache_miss_tokens = (run.tokenUsage.cache_miss_tokens || 0) + result.usage.cache_miss_tokens
            }
            this.commitPendingUsage(result.usage)
            this._conversation?.recordPromptUsage(requestMessageCount, result.usage.prompt_tokens)
          } else {
            this.commitPendingUsage()
          }

          // 先定稿流式步骤
          let finalContent = streamContent.replace(/<details open>/g, '<details>')
          if (finalContent.includes('<details>') && !finalContent.includes('</details>')) {
            finalContent += '\n\n</blockquote>\n</details>'
          }
          // 去重：部分 API 代理可能导致连续出现内容相同的思考块，只保留第一个
          finalContent = deduplicateThinkingBlocks(finalContent)
          // message step 内容保持完整（思考块 + 正文），不再剥离正文给 final_result。
          // 前端只渲染 message step（含完整内容），失败/中断的 final_result 才以独立卡片呈现，
          // 成功的 final_result 不再渲染——这样流式 → 完成切换时只有 ThinkingBlock 从流式态
          // 切到完成态，正文位置和下方布局完全不变，达到"持续往下输出"的稳定感。
          if (finalContent && streamStepCreated) {
            this.updateStep(streamStepId, {
              type: 'message',
              content: finalContent,
              isStreaming: false
            })
          } else if (!streamStepCreated && finalContent) {
            this.addStepReplacingInitial(run, {
              id: streamStepId,
              type: 'message',
              content: finalContent,
              isStreaming: false
            }, effectiveProfileId)
            streamStepCreated = true
          }

          // 在步骤定稿后推送 contextTokens（避免设置到即将被删除的临时步骤上）
          if (result.usage) {
            const steps = this.currentRun?.steps
            if (steps && steps.length > 0) {
              // 优先选择已定稿的流式步骤，否则选最近的非临时步骤（跳过 initialStep）
              let targetStep = streamStepCreated
                ? steps.find(s => s.id === streamStepId)
                : undefined
              if (!targetStep) {
                for (let i = steps.length - 1; i >= 0; i--) {
                  if (steps[i].id !== run.initialStepId) { targetStep = steps[i]; break }
                }
              }
              if (targetStep) {
                targetStep.contextTokens = result.usage.prompt_tokens
                this.stampEffectiveProfileOnStep(targetStep, effectiveProfileId)
                // API usage 是唯一真相源：有 cache 明细才显示，否则清空
                const cacheTotal = (result.usage.cache_hit_tokens || 0) + (result.usage.cache_miss_tokens || 0)
                const confirmedBar: AgentContextBar = {
                  contextTokens: result.usage.prompt_tokens,
                }
                if (this._contextBar.composition) {
                  confirmedBar.composition = this._contextBar.composition
                }
                if (cacheTotal > 0 && result.usage.prompt_tokens > 0) {
                  const rate = Math.round((result.usage.cache_hit_tokens || 0) / result.usage.prompt_tokens * 100)
                  targetStep.cacheHitRate = rate
                  confirmedBar.cacheHitRate = rate
                  this._conversation?.setLastCacheHitRate(rate)
                } else {
                  delete targetStep.cacheHitRate
                  this._conversation?.setLastCacheHitRate(undefined)
                }
                const confirmedId = this.applyProfileFieldsToContextBar(confirmedBar, effectiveProfileId)
                if (confirmedId) this._lastStatsProfileId = confirmedId
                this.setContextBar(confirmedBar)
                this.callbacks?.onStep?.(this.currentRun?.id || '', targetStep)
              }
            }
          }
          if (!result.usage) {
            this.publishConsumedLive()
          }
          unsubProfileFallback()
          resolve(result)
        },
        // onError
        (error) => {
          unsubProfileFallback()
          clearSlowTtftTimer()
          this.commitPendingUsage()
          this.publishConsumedLive()
          // 出错时把预创建的 tool_call 卡片移除，避免留下没有结果的空卡
          this.discardPreToolCallSteps(run)
          // 重试最终失败时也要把 spinner 关掉，否则"正在重试"卡片会一直转
          finalizeRetryStep()
          // 清理残留的流式步骤：最后一次重试若已收到部分 chunk，stream step 的
          // isStreaming 还是 true，计时器会一直跑；移除它，避免"思考中 XXXs"僵在屏幕上
          if (streamStepCreated) {
            this.removeStep(streamStepId)
            streamStepCreated = false
          }
          // 清理初始"正在准备..."占位步骤：首次请求就失败（无重试）或 onRetry 里
          // retryInfo 为空（vision-fallback 等内部重试）时，initialStepId 不会在
          // onRetry 中被清理，需要在这里兜底清理，否则计时器会一直跑
          if (run.initialStepId) {
            this.removeStep(run.initialStepId)
            run.initialStepId = undefined
          }
          reject(new Error(error))
        },
        effectiveProfileId, // 视觉路由：有新图片时自动切换到视觉模型
        // onToolCallProgress - 流式生成 tool_call 参数时以"最终形态的"内容预创建一张
        // tool_call 卡片；随后该卡片会被工具执行器"认领"并 updateStep 成正式内容，
        // 因为格式一致（同前缀、同字体、同样式），视觉上就是同一张卡上的文本在逐字增长。
        //
        // 工具执行透明原则（见 SPEC.md「工具执行透明原则」）：所有工具执行器都会无条件
        // emit `tool_call` 卡片再执行，确保用户看到「Agent 准备做什么 → 在做 → 做完」。
        // 预创建（本回调）是这一原则在流式输出场景下的进一步强化：把卡片的出现时机从
        // 「执行开始」提前到「参数还在流」的阶段，避免「AI 在思考但屏幕一片空白」的体感。
        //
        // 默认所有工具都生成预卡片：声明了 _meta.streamDisplay 的工具走富信息渲染，
        // 没声明的工具走通用兜底「调用: {toolName}」。基类不知道具体工具叫什么——
        // 展示行为完全由各自 ToolDefinition 自己声明。
        (toolCallId: string, toolName: string, partialArgs: string) => {
          if (!toolCallId) return  // 没有稳定 id 就无法与后续 executor 的 addStep 关联，跳过

          let meta = toolMetaCache.get(toolCallId)
          if (!toolMetaCache.has(toolCallId)) {
            meta = getMetaByName(this.getAvailableTools(), toolName)
            toolMetaCache.set(toolCallId, meta)
          }

          // 流式参数早失败：不走预卡片节流。节流只服务预卡片刷新；校验必须
          // 在字段刚闭合时立刻跑，并把原始 JSON 交给校验方判断字段是否写完。
          // 抽象层只读元数据，不感知工具名。
          if (meta?.streamValidate && !run.streamEarlyFailures?.has(toolCallId)) {
            const parsed = tryParsePartialJson(partialArgs)
            if (parsed) {
              const earlyError = meta.streamValidate(parsed, partialArgs)
              if (earlyError) {
                if (!run.streamEarlyFailures) run.streamEarlyFailures = new Map()
                run.streamEarlyFailures.set(toolCallId, { toolName, error: earlyError, args: parsed })
                log.info(`[streamValidate] early-fail tool=${toolName} id=${toolCallId}: ${earlyError}`)
                // 中止当前 AI 生成：onDone 会以 aborted=true 返回，executeStep 据此合成
                // 「带 tool_calls 的 assistant 消息 + 失败 tool 结果」，让循环继续、模型改用正确方式。
                if (run.requestId) this.services.aiService.abort(run.requestId)
                // 把预卡片就地定稿为失败态（错误信息并进 tool_call 卡，不单独发 tool_result 卡，
                // 避免同一条消息里「写入文件卡 + 错误卡」两张重复）。toolResult 随卡持久化，
                // 历史详情也能看到失败原因。
                const preStepId = run.pendingPreToolCallStepIds?.get(toolCallId)
                if (preStepId) {
                  this.updateStep(preStepId, {
                    isStreaming: false,
                    success: false,
                    toolResult: earlyError
                  })
                } else {
                  // 预卡片还没创建（path/mode 比卡片先到的极端情况）：补一张失败 tool_call 卡
                  this.addStep({
                    type: 'tool_call',
                    content: `❌ ${earlyError}`,
                    toolName,
                    toolCallId,
                    toolResult: earlyError,
                    success: false
                  })
                }
                return
              }
            }
          }

          const now = Date.now()
          const lastAt = toolProgressThrottle.get(toolCallId) || 0
          if (now - lastAt < TOOL_PROGRESS_THROTTLE_MS) return

          const built = buildPreToolCallDisplay(toolName, partialArgs, meta)
          // 解析失败时不回退显示（保留上一次已解析内容），让用户观感上是"连续增长"
          if (!run.pendingPreToolCallText) run.pendingPreToolCallText = new Map()
          const previousText = run.pendingPreToolCallText.get(toolCallId)
          const displayContent = built ?? previousText
          if (displayContent === undefined) return  // 还没可显示内容
          if (built !== null) run.pendingPreToolCallText.set(toolCallId, built)
          toolProgressThrottle.set(toolCallId, now)
          this.updatePendingCompletion(streamContent + '\n' + partialArgs)
          this.publishConsumedLive()

          if (!run.pendingPreToolCallStepIds) run.pendingPreToolCallStepIds = new Map()
          let stepId = run.pendingPreToolCallStepIds.get(toolCallId)
          if (!stepId) {
            stepId = this.generateId()
            run.pendingPreToolCallStepIds.set(toolCallId, stepId)
            // 先创建 tool_call 卡片再移除初始步骤，避免前端 steps 出现瞬时为 0 的中间态；
            // 同时带走 effective*，避免「只出工具不出正文」时状态栏闪回文字模型
            this.addStepReplacingInitial(run, {
              id: stepId,
              type: 'tool_call',
              content: displayContent,
              toolName,
              toolCallId,
              isStreaming: true
            }, effectiveProfileId)
          } else {
            this.updateStep(stepId, {
              type: 'tool_call',
              content: displayContent,
              toolName,
              isStreaming: true
            })
          }
        },
        run.id, // requestId
        // onRetry - 重试时重置流状态，避免 reasoning 块重复
        // retryInfo 由 ai.service 提供，用来在 UI 上显示"正在重试"，避免用户以为应用卡死
        (retryInfo?: RetryInfo) => {
          clearSlowTtftTimer()
          log.info(`AI request retrying (reason=${retryInfo?.reason ?? 'unknown'}), resetting stream state`)
          streamContent = ''
          pendingUpdate = false
          lastContentUpdate = 0
          toolProgressThrottle.clear()
          this._pendingUsage.completion_tokens = 0
          this._pendingUsage.total_tokens = this._pendingUsage.prompt_tokens
          this.publishConsumedLive()
          if (streamStepCreated) {
            this.removeStep(streamStepId)
            streamStepCreated = false
            // streamStepId 可能复用过 initialStepId，这里重新生成避免下次 addStep 撞 id
            streamStepId = this.generateId()
          }
          this.discardPreToolCallSteps(run)
          // 重试时中止已启动的流式工具执行
          streamingExecutor?.abort()
          // 把上一次的"正在重试"卡片定稿（这次新的重试会再起一张），避免多张同时转 spinner
          finalizeRetryStep()
          // 显示 waiting 卡片让用户清楚"在等下次重试"，而不是"卡住了"。
          // retryInfo 缺失时（如 vision-fallback 等内部重试）不显示，避免误导用户
          if (retryInfo) {
            const params: Record<string, string> = {
              attempt: String(retryInfo.attempt),
              max: String(retryInfo.max),
              seconds: String(Math.max(1, Math.round(retryInfo.delayMs / 1000)))
            }
            if (retryInfo.statusCode !== undefined) params.status = String(retryInfo.statusCode)
            const i18nKey =
              retryInfo.reason === 'rate_limit' ? 'agent.retry_rate_limit' :
              retryInfo.reason === 'server_error' ? 'agent.retry_server_error' :
              retryInfo.cause === 'timeout' ? 'agent.retry_timeout' :
              'agent.retry_network'
            const stepId = this.generateId()
            lastRetryStepId = stepId
            lastRetryParams = params
            const renderWait = (remaining: number) =>
              `🔄 ${t(i18nKey, { ...params, seconds: String(remaining) })}`
            // 接替初始占位；上下文栏独立，删 step 不影响状态栏
            this.addStepReplacingInitial(run, {
              id: stepId,
              type: 'waiting',
              content: renderWait(Math.max(1, Math.round(retryInfo.delayMs / 1000))),
              isStreaming: true
            }, effectiveProfileId)
            // 秒数倒数；间隔一过改成「正在重试」，避免还停在「几秒后重试」
            const waitUntil = Date.now() + retryInfo.delayMs
            const tickRetryWait = () => {
              if (lastRetryStepId !== stepId) return
              const remaining = Math.ceil((waitUntil - Date.now()) / 1000)
              if (remaining <= 0) {
                clearRetryCountdown()
                this.updateStep(stepId, {
                  content: `🔄 ${t('agent.retry_in_flight', params)}`,
                  isStreaming: true
                })
                return
              }
              this.updateStep(stepId, {
                content: renderWait(remaining),
                isStreaming: true
              })
            }
            retryCountdownTimer = setInterval(tickRetryWait, 1000)
          } else {
            // retryInfo 缺失（vision-fallback 等）：不展示 waiting 卡，但仍需清理
            // 初始占位步骤，否则"正在准备..."会在无 waiting 接班时孤立显示
            if (run.initialStepId) {
              this.removeStep(run.initialStepId)
              run.initialStepId = undefined
            }
          }
        },
        // onToolCallReady - 流式中 tool_call 参数完整时立即投入执行
        streamingExecutor
          ? (toolCall) => {
              log.info(`Streaming tool ready: ${toolCall.function.name} (id=${toolCall.id})`)
              streamingExecutor.addTool(toolCall)
            }
          : undefined,
        (notice: AiModelFailoverNotice) => {
          // 视觉路由的临时模型失败：只改这一轮，不把主模型绑死
          const bindCurrent = !this.profileId || notice.fromId === this.profileId
          if (bindCurrent) {
            this.profileId = notice.usedId
          }
          effectiveProfileId = notice.usedId
          const bar: AgentContextBar = {
            ...this._contextBar,
            profileId: notice.usedId,
            cacheHitRate: undefined,
          }
          this.applyProfileFieldsToContextBar(bar, notice.usedId)
          this.setContextBar(bar)
          this.addStep({
            type: 'message',
            content: t('agent.model_failover', { from: notice.fromName, name: notice.usedName }),
          })
          if (bindCurrent) {
            const agentKey = this._agentId || run.id
            this.callbacks?.onModelFailover?.(agentKey, notice)
          }
        },
      )
    })
  }
  
  // ==================== 受保护方法：工具执行 ====================

  /**
   * 判断工具是否可以并行执行（只读 / 无副作用 / 跨工具无相互依赖）
   *
   * 默认 false（串行）；工具可以在 ToolDefinition._meta.parallelizable 里声明覆盖。
   * 基类不知道具体工具叫什么。
   */
  private isParallelizableTool(toolName: string): boolean {
    const meta = getMetaByName(this.getAvailableTools(), toolName)
    return meta?.parallelizable === true
  }
  
  /**
   * 执行工具调用列表（支持并行执行相邻的只读工具）
   * 
   * 执行策略：保持原始顺序，只对相邻的可并行工具进行并行优化
   * 例如：[read_file, read_file, execute_command, read_file, read_file]
   * 会分成3批执行：
   *   1. read_file || read_file （并行）
   *   2. execute_command        （顺序）
   *   3. read_file || read_file （并行）
   */
  protected async executeToolCalls(
    run: AgentRun, 
    toolCalls: ToolCall[],
    toolExecutorConfig: ToolExecutorConfig
  ): Promise<void> {
    if (toolCalls.length === 0) return

    // 防御模型幻觉：校验工具调用是否在当前可用列表中
    const availableToolNames = new Set(this.getAvailableTools().map(t => t.function.name))
    const validToolCalls: ToolCall[] = []
    for (const toolCall of toolCalls) {
      if (availableToolNames.has(toolCall.function.name)) {
        validToolCalls.push(toolCall)
        continue
      }
      log.warn(`Rejected hallucinated tool call: ${toolCall.function.name}`)
      const error = t('error.unknown_tool', { name: toolCall.function.name })
      this.addStep({
        type: 'tool_result',
        content: `⚠️ ${error}`,
        toolName: toolCall.function.name,
        toolCallId: toolCall.id,
        toolResult: error,
        success: false
      })
      this.processToolResult(run, toolCall, { success: false, output: '', error }, {})
    }

    if (validToolCalls.length === 0) {
      run.executionPhase = 'thinking'
      run.currentToolName = undefined
      return
    }
    
    // 将工具调用分成多个批次，相邻的可并行工具放在同一批次
    const batches: { parallel: boolean; tools: ToolCall[] }[] = []
    
    for (const toolCall of validToolCalls) {
      const isParallel = this.isParallelizableTool(toolCall.function.name)
      const lastBatch = batches[batches.length - 1]
      
      if (lastBatch && lastBatch.parallel === isParallel) {
        // 与上一批次类型相同，加入同一批次
        lastBatch.tools.push(toolCall)
      } else {
        // 开始新批次
        batches.push({ parallel: isParallel, tools: [toolCall] })
      }
    }
    
    try {
      for (const batch of batches) {
        if (run.aborted) break

        if (batch.parallel && batch.tools.length > 1) {
          await this.executeToolBatchParallel(run, batch.tools, toolExecutorConfig)
        } else {
          for (const toolCall of batch.tools) {
            if (run.aborted) break
            await this.executeToolSingle(run, toolCall, toolExecutorConfig)
          }
        }
      }
    } finally {
      // 当前 assistant.tool_calls 这批工具的 tool 消息已全部写入 run.messages，
      // 此时把工具返回的图片合并为一条 user 消息追加到末尾（见 flushPendingToolImages）。
      // 用 try/finally 保证即便中途抛异常也不会留下未 flush 的图片污染下一批次。
      this.flushPendingToolImages(run)
      run.executionPhase = 'thinking'
      run.currentToolName = undefined
    }
  }
  
  /**
   * 带流式预执行的工具调用处理。
   *
   * StreamingToolExecutor 在 AI 流式输出过程中已提前启动部分工具。
   * 本方法：
   * 1. 等待流式执行器完成所有已投入的工具
   * 2. 收集预执行的结果并 processToolResult
   * 3. 对剩余未预执行的工具走传统 executeToolCalls 路径
   */
  private async executeToolCallsWithStreaming(
    run: AgentRun,
    toolCalls: ToolCall[],
    toolExecutorConfig: ToolExecutorConfig,
    streamingExecutor: StreamingToolExecutor,
    stepCountBeforeStreaming: number
  ): Promise<void> {
    if (toolCalls.length === 0) return

    try {
      // 等待流式执行器中所有已投入的工具完成
      // UI 层回填（ensureToolResultStep / finalizeToolCallStep）已经在 onToolCompleted
      // 中"完成即处理"，这里只负责按原始 toolCalls 顺序把消息历史串起来。
      const preExecuted = await streamingExecutor.waitForAll()
      const preExecutedIds = new Set(preExecuted.map(r => r.toolCall.id))

      if (preExecuted.length > 0) {
        const names = preExecuted.map(r => r.toolCall.function.name).join(', ')
        log.info(`Streaming pre-executed ${preExecuted.length} tools: [${names}]`)
      }

      const orderedPreExecuted = toolCalls.flatMap((toolCall) => {
        if (!preExecutedIds.has(toolCall.id)) return []
        const completed = preExecuted.find(r => r.toolCall.id === toolCall.id)
        return completed ? [{ toolCall, ...completed }] : []
      })
      const collapsedPreExecuted = collapseRepeatedToolOutputs(
        run.messages,
        orderedPreExecuted.map(item => ({ id: item.toolCall.id, result: item.result }))
      )

      for (let i = 0; i < orderedPreExecuted.length; i++) {
        const { toolCall, toolArgs } = orderedPreExecuted[i]
        const result = collapsedPreExecuted[i]
        // 兜底再调一次：若 onToolCompleted 出错或被跳过，这里仍能保证 UI 状态收尾
        this.ensureToolResultStep(run, stepCountBeforeStreaming, toolCall, result)
        if (result !== orderedPreExecuted[i].result) {
          this.refreshToolResultPreview(run, stepCountBeforeStreaming, toolCall, result)
        }
        this.processToolResult(run, toolCall, result, toolArgs)
        this.finalizeToolCallStep(run, toolCall.id, result.success)
      }

      // 过滤出未被流式执行器处理的工具
      const remaining = toolCalls.filter(tc => !preExecutedIds.has(tc.id))

      if (remaining.length > 0) {
        log.info(`Running ${remaining.length} remaining tools via standard path`)
        // executeToolCalls 内部会统一 flushPendingToolImages，
        // 把流式预执行批次和剩余批次累积的图片一次性合并为一条 user 消息。
        await this.executeToolCalls(run, remaining, toolExecutorConfig)
        // executeToolCalls 内的 finally 已经 flush 过了，下面的 finally 再调一次也是 no-op。
      }
    } finally {
      // 兜底 flush：streaming 全部预执行（无 remaining）路径不会经过 executeToolCalls；
      // 异常路径也不能留下未 flush 的图片污染下一批次。
      this.flushPendingToolImages(run)
      run.executionPhase = 'thinking'
      run.currentToolName = undefined
    }
  }
  
  /**
   * 并行执行一批工具
   *
   * "完成一个显示一个"：每个工具完成的瞬间立即在 UI 层兜底 tool_result 卡 +
   * 收尾 tool_call 卡的状态（success / isStreaming），不必等整批 Promise.all 结束。
   * 消息历史（run.messages）仍按 toolCalls 原始顺序在 await 之后统一 push，
   * 以稳定 OpenAI/Anthropic 协议中 tool 消息序列。
   */
  private async executeToolBatchParallel(
    run: AgentRun,
    toolCalls: ToolCall[],
    toolExecutorConfig: ToolExecutorConfig
  ): Promise<void> {
    const toolNames = toolCalls.map(tc => tc.function.name).join(', ')
    log.info(`Tools parallel batch: [${toolNames}]`)

    run.executionPhase = 'reading'
    run.currentToolName = `${toolCalls.length} tools`

    const batchStartTime = Date.now()
    const stepCountBefore = run.steps.length
    const batchExecutorConfig = this.withParallelToolOutputBudget(
      toolExecutorConfig,
      toolCalls.length
    )
    const parallelPromises = toolCalls.map(async (toolCall) => {
      if (run.aborted) {
        const aborted = {
          result: { success: false, output: '', error: t('error.operation_aborted') } as ToolResult,
          toolArgs: {} as Record<string, unknown>
        }
        // 中止状态也立刻收尾 UI 卡，避免占位卡停留在"运行中"
        this.ensureToolResultStep(run, stepCountBefore, toolCall, aborted.result)
        this.finalizeToolCallStep(run, toolCall.id, aborted.result.success)
        return { toolCall, ...aborted }
      }
      const out = await this.executeToolWithChecks(run, toolCall, batchExecutorConfig)
      // 完成即回填 UI（视觉层面"完成一个显示一个"）
      this.ensureToolResultStep(run, stepCountBefore, toolCall, out.result)
      this.finalizeToolCallStep(run, toolCall.id, out.result.success)
      return { toolCall, ...out }
    })

    const results = await Promise.all(parallelPromises)
    const collapsed = collapseRepeatedToolOutputs(
      run.messages,
      results.map(item => ({ id: item.toolCall.id, result: item.result }))
    )

    const batchElapsed = Date.now() - batchStartTime
    const successCount = collapsed.filter(r => r.success).length
    log.info(`Tools parallel done: ${successCount}/${results.length} succeeded, ${batchElapsed}ms`)

    // 按原始顺序写入消息历史（协议层面）
    for (let i = 0; i < results.length; i++) {
      const { toolCall, toolArgs } = results[i]
      const result = collapsed[i]
      if (result !== results[i].result) {
        this.refreshToolResultPreview(run, stepCountBefore, toolCall, result)
      }
      this.processToolResult(run, toolCall, result, toolArgs)
    }
  }
  
  /**
   * 顺序执行单个工具
   */
  /**
   * 执行单个工具（含安全检查），返回结果但不写入消息历史。
   * 这是工具执行的核心路径，流式预执行和标准路径共用。
   */
  private async executeToolWithChecks(
    run: AgentRun,
    toolCall: ToolCall,
    toolExecutorConfig: ToolExecutorConfig
  ): Promise<{ result: ToolResult; toolArgs: Record<string, unknown> }> {
    let toolArgs: Record<string, unknown> = {}
    try {
      toolArgs = JSON.parse(toolCall.function.arguments)
    } catch {
      // 忽略解析错误
    }
    
    const toolName = toolCall.function.name
    const toolStartTime = Date.now()
    let result: ToolResult

    // Plugin hook: before_tool_call
    const hookBus = this.services.pluginRegistry?.hookBus
    if (hookBus?.hasHandlers('before_tool_call')) {
      const decision = await hookBus.trigger('before_tool_call', {
        toolName, toolArgs, toolCallId: toolCall.id
      })
      if (decision.block) {
        return { result: { success: false, output: '', error: 'Blocked by plugin' }, toolArgs }
      }
      if (decision.requireApproval) {
        // 插件显式要求审批：始终弹窗，不受 executionMode 覆盖（开发者门禁 ≠ Agent 自评估风险）
        const approved = await toolExecutorConfig.waitForConfirmation(
          toolCall.id, toolName, toolArgs, 'dangerous', undefined, undefined, undefined, { humanOnly: true }
        )
        if (!approved) {
          return { result: { success: false, output: '', error: t('error.operation_aborted') }, toolArgs }
        }
      }
    }

    // 把流式阶段预创建的 tool_call 卡片交给工具执行器：当执行器第一次 addStep 一张
    // tool_call 卡时，改为原地 updateStep 原卡，实现"生成→执行→结果"同一张卡的状态迁移。
    const wrappedConfig: ToolExecutorConfig = this.wrapExecutorConfigForToolCall(
      run, toolCall, toolExecutorConfig
    )

    try {
      result = await executeTool(
        run.ptyId,
        toolCall,
        run.config,
        run.context.terminalOutput,
        wrappedConfig
      )
    } catch (error) {
      result = {
        success: false,
        output: '',
        error: isAbortError(error) || run.aborted
          ? t('error.operation_aborted')
          : error instanceof Error ? error.message : String(error)
      }
    }

    const toolElapsed = Date.now() - toolStartTime
    if (result.success) {
      log.info(`Tool executed: ${toolName}, ${toolElapsed}ms, outputLen=${result.output.length}`)
    } else {
      log.warn(`Tool failed: ${toolName}, ${toolElapsed}ms, error=${(result.error || '').slice(0, 200)}`)
    }

    // Plugin hook: after_tool_call
    if (hookBus?.hasHandlers('after_tool_call')) {
      await hookBus.trigger('after_tool_call', {
        toolName, toolArgs, result: { success: result.success, output: result.output, error: result.error }
      })
    }

    return { result, toolArgs }
  }

  /**
   * 为单次工具执行包装 ToolExecutorConfig：
   * - 如果 run 中有本 toolCallId 对应的预创建 tool_call 卡片，首次收到 executor.addStep(type='tool_call')
   *   时改为 updateStep 原卡（把流式命令文本替换为执行器给出的正式内容，并收起光标），
   *   并返回原卡实例；第二次及之后的 tool_call addStep 正常新增。
   * - 其他 step 类型（tool_result / thinking 等）不受影响。
   *
   * 副作用：把 tool_call 步骤 ID 登记到 run.activeToolCallStepIds，
   * 供工具执行结束后 finalizeToolCallStep 反向回填 success（用于 UI 侧的"执行结果色竖条"）。
   */
  private wrapExecutorConfigForToolCall(
    run: AgentRun,
    toolCall: ToolCall,
    base: ToolExecutorConfig
  ): ToolExecutorConfig {
    const preStepId = run.pendingPreToolCallStepIds?.get(toolCall.id)
    const registerActive = (stepId: string) => {
      if (!run.activeToolCallStepIds) run.activeToolCallStepIds = new Map()
      run.activeToolCallStepIds.set(toolCall.id, stepId)
    }
    // 有预创建卡片时先登记：即使 executor 没有再 addStep(tool_call)（例如某些 skill 直接出结果），
    // finalizeToolCallStep 也能找到并收尾。
    if (preStepId) registerActive(preStepId)

    // 给所有 tool_call / tool_result 类型的步骤打上 toolCallId 戳，保证后续按 id 配对的可靠性。
    // 工具实现层不需要感知这个字段，由本层统一注入。
    const stamp = (step: Omit<AgentStep, 'id' | 'timestamp'>): Omit<AgentStep, 'id' | 'timestamp'> => {
      if (step.type === 'tool_call' || step.type === 'tool_result') {
        return { ...step, toolCallId: step.toolCallId ?? toolCall.id }
      }
      return step
    }

    let adopted = false
    return {
      ...base,
      addStep: (step) => {
        const stamped = stamp(step)
        if (!adopted && stamped.type === 'tool_call') {
          adopted = true
          if (preStepId) {
            base.updateStep(preStepId, { ...stamped, isStreaming: false })
            run.pendingPreToolCallStepIds?.delete(toolCall.id)
            run.pendingPreToolCallText?.delete(toolCall.id)
            const existing = run.steps.find(s => s.id === preStepId)
            if (existing) return existing
          }
          const created = base.addStep(stamped)
          registerActive(created.id)
          return created
        }
        return base.addStep(stamped)
      }
    }
  }

  /**
   * 丢弃 run 中所有尚未被执行器认领的预创建 tool_call 卡片（用于出错/重试场景）。
   * 这些卡片只承载了"生成中"的中间状态，没有正式的工具执行结果，所以直接移除是安全的。
   */
  private discardPreToolCallSteps(run: AgentRun): void {
    if (!run.pendingPreToolCallStepIds) return
    for (const [, stepId] of run.pendingPreToolCallStepIds) {
      this.removeStep(stepId)
    }
    run.pendingPreToolCallStepIds.clear()
    run.pendingPreToolCallText?.clear()
    run.streamEarlyFailures?.clear()
  }

  /**
   * 工具执行结束后的统一收尾：
   * - 关闭 tool_call 卡片的 isStreaming 光标
   * - 把 ToolResult.success 回填到卡片，让前端可以按"执行结果"给左竖条着色
   *   （失败=红、成功=不抢戏），和"风险等级"的视觉完全解耦
   * - 清理 pending / active 两份映射
   *
   * 兼容两种路径：
   *   A. 有预创建卡片（流式路径）：pendingPreToolCallStepIds 有 entry
   *   B. 无预创建卡片（非流式路径）：executor.addStep(tool_call) 后 activeToolCallStepIds 有 entry
   */
  private finalizeToolCallStep(run: AgentRun, toolCallId: string, success: boolean): void {
    const pendingStepId = run.pendingPreToolCallStepIds?.get(toolCallId)
    if (pendingStepId) {
      run.pendingPreToolCallStepIds!.delete(toolCallId)
      run.pendingPreToolCallText?.delete(toolCallId)
    }
    const activeStepId = run.activeToolCallStepIds?.get(toolCallId)
    const stepId = activeStepId ?? pendingStepId
    run.activeToolCallStepIds?.delete(toolCallId)
    if (!stepId) {
      log.warn(`[finalizeToolCallStep] no stepId for toolCallId=${toolCallId} (success=${success}, active=${activeStepId}, pending=${pendingStepId})`)
      return
    }
    log.info(`[finalizeToolCallStep] toolCallId=${toolCallId} stepId=${stepId} success=${success}`)
    this.updateStep(stepId, { isStreaming: false, success })
  }

  /**
   * 执行单个工具并写入消息历史（标准路径入口）。
   */
  private async executeToolSingle(
    run: AgentRun,
    toolCall: ToolCall,
    toolExecutorConfig: ToolExecutorConfig
  ): Promise<void> {
    const toolName = toolCall.function.name
    this.setExecutionPhase(run, toolName)
    const stepCountBefore = run.steps.length

    const { result, toolArgs } = await this.executeToolWithChecks(run, toolCall, toolExecutorConfig)
    const reduced = reduceRepeatedToolOutput(run.messages, result)

    this.ensureToolResultStep(run, stepCountBefore, toolCall, reduced)
    if (reduced !== result) {
      this.refreshToolResultPreview(run, stepCountBefore, toolCall, reduced)
    }
    this.processToolResult(run, toolCall, reduced, toolArgs)
    this.finalizeToolCallStep(run, toolCall.id, reduced.success)
  }
  
  /**
   * 处理工具执行结果
   */
  private processToolResult(
    run: AgentRun,
    toolCall: ToolCall,
    result: ToolResult,
    _toolArgs: Record<string, unknown>
  ): void {
    const errorText = !result.success
      ? t('agent.tool_error', { error: result.error || t('agent.unknown_error') })
      : ''
    const resultContent = result.success
      ? result.output
      : result.output
        ? `${result.output}\n\n${errorText}`
        : errorText
    
    // AI Debug: 记录工具执行结果
    if (run.requestId) {
      getAiDebugService().logToolResult(run.requestId, {
        toolCallId: toolCall.id,
        success: result.success,
        result: resultContent
      })
    }
    
    // 添加工具结果到消息历史
    const toolMsg: AiMessage = {
      role: 'tool',
      content: resultContent,
      tool_call_id: toolCall.id
    }
    run.messages.push(toolMsg)
    run.taskMessageLog.push({ ...toolMsg })

    // 工具返回的图片不能立即 push 为 user 消息，否则会插在同批 tool 消息之间，
    // 破坏 OpenAI/DeepSeek 的 tool_calls 序列校验。先暂存，由 flushPendingToolImages
    // 在当前批次所有 tool 消息写完后统一注入（详见 AgentRun.pendingToolImages 注释）。
    if (result.images && result.images.length > 0) {
      if (!run.pendingToolImages) run.pendingToolImages = []
      run.pendingToolImages.push(...result.images)
    }
  }

  /**
   * 把当前批次累积的工具返回图片合并为单条 user 消息追加到 messages 末尾。
   *
   * 必须在一批 tool_calls 对应的所有 tool 消息都已写入 run.messages 之后调用，
   * 不能在每个工具完成后立即调用——否则 user 消息会夹在同批 tool 消息之间，
   * 触发 DeepSeek "insufficient tool messages following tool_calls message" 错误。
   *
   * 当前 profile 不具备视觉能力时，剥图但仍注入一条文本提示，让 AI 主动告知用户
   * （否则部分网关静默丢弃 image_url，AI 拿到「图片已嵌入」的提示却什么都看不到，
   * 容易凭文件名/上下文瞎编内容）。
   *
   * 设计成幂等：pendingToolImages 为空时直接返回，所以可以在多个边界点重复调用。
   */
  protected flushPendingToolImages(run: AgentRun): void {
    const pending = run.pendingToolImages
    if (!pending || pending.length === 0) return

    const sendable = pending
      .map(url => toSendableVisionImageUrl(url))
      .filter((url): url is string => url !== null)
    const skipped = pending.length - sendable.length
    if (skipped > 0) {
      log.warn(`Dropping ${skipped} tool-returned image(s): unsupported MIME for vision APIs`)
    }
    if (sendable.length === 0) {
      run.pendingToolImages = []
      return
    }

    const imageCount = sendable.length
    const visionAvailable = this.currentProfileHasVision()
    let imageMsg: AiMessage
    if (visionAvailable) {
      imageMsg = {
        role: 'user',
        content: t('agent.image_from_tool'),
        images: [...sendable],
        // 标记为系统注入，避免 splitMessagesIntoTasks 把它当作 task 边界——
        // 否则会把同一个 task 切成两段，第二段开头是 tool 消息（孤儿 tool），
        // 下次启动时会触发 DeepSeek "tool must be a response to tool_calls" 错误。
        _systemInjected: true
      }
    } else {
      log.warn(`Dropping ${imageCount} tool-returned image(s) due to no vision capability on current profile`)
      imageMsg = {
        role: 'user',
        content: t('agent.tool_image_no_vision', { count: imageCount }),
        _systemInjected: true
      }
    }
    run.messages.push(imageMsg)
    // taskMessageLog 不保存 images（base64 太大，会撑爆持久化存储）
    run.taskMessageLog.push({ role: 'user', content: imageMsg.content, _systemInjected: true })

    run.pendingToolImages = []
  }
  
  /**
   * 确保工具执行后有 tool_result 步骤（内置工具自己添加，技能工具可能缺失）
   *
   * 优先按 toolCallId 配对，找不到时退化按 toolName 匹配（兼容老历史/未注入 id 的工具）。
   * 适用于顺序、并行、流式预执行等各种路径，同名同批多次调用时也能精准对齐每一份结果。
   *
   * 同时回填 `success` 字段到工具自己 emit 的 tool_result 卡上——前端依据
   * `step.success === false` 决定是否在非调试模式下也展开详情区，让用户看到错误。
   */
  private ensureToolResultStep(
    run: AgentRun,
    stepCountBefore: number,
    toolCall: ToolCall,
    result: ToolResult
  ): void {
    const toolCallId = toolCall.id
    const toolName = toolCall.function.name
    const newSteps = run.steps.slice(stepCountBefore)

    const matches = (s: AgentStep) => {
      if (s.toolCallId) return s.toolCallId === toolCallId
      // 老步骤未带 toolCallId：退化按 toolName 匹配（仅对没有任何 toolCallId 的卡兜底）
      return s.toolName === toolName
    }

    // 回填 success 到工具自己 emit 的 tool_result 卡（按 toolCallId 精准对齐）
    for (const s of newSteps) {
      if (s.type === 'tool_result' && s.success === undefined && matches(s)) {
        this.updateStep(s.id, { success: result.success })
      }
    }

    // 已存在本工具的结果卡（或有 error 步骤）就不再补 result 步骤
    if (newSteps.some(s => s.type === 'error' || (s.type === 'tool_result' && matches(s)))) return

    if (!result.success) {
      const errorMsg = result.error || t('agent.unknown_error')
      this.addStep({
        type: 'tool_result',
        content: `❌ ${toolName}`,
        toolName,
        toolCallId,
        toolResult: errorMsg,
        success: false
      })
    } else if (result.output) {
      const preview = result.output.length > 200
        ? result.output.slice(0, 200) + '…'
        : result.output
      this.addStep({
        type: 'tool_result',
        content: `✅ ${toolName}`,
        toolName,
        toolCallId,
        toolResult: preview,
        success: true
      })
    }
  }

  /** 同批去重后，已显示的结果卡预览跟着改成引用，避免过程里还像灌了两份。 */
  private refreshToolResultPreview(
    run: AgentRun,
    stepCountBefore: number,
    toolCall: ToolCall,
    result: ToolResult
  ): void {
    if (!result.success || !result.output) return
    const preview = result.output.length > 200
      ? result.output.slice(0, 200) + '…'
      : result.output
    const card = run.steps.slice(stepCountBefore).find(
      s => s.type === 'tool_result' && s.toolCallId === toolCall.id
    )
    if (card && card.toolResult !== preview) {
      this.updateStep(card.id, { toolResult: preview })
    }
  }

  /**
   * 并行 tool batch 内分摊单次 output 预算（见 tool-output-budget.applyParallelShare）。
   */
  private withParallelToolOutputBudget(
    base: ToolExecutorConfig,
    parallelShare: number
  ): ToolExecutorConfig {
    if (parallelShare <= 1 || !base.getToolOutputBudget) return base
    return {
      ...base,
      getToolOutputBudget: (override?: number) =>
        applyParallelShare(base.getToolOutputBudget!(override), parallelShare),
    }
  }

  /**
   * 创建工具执行器配置
   */
  protected collectToolCatalog(): ToolDefinition[] {
    return this.getAvailableTools()
  }

  protected injectSubAgentKnock(message: string): void {
    const run = this.currentRun
    if (!run?.isRunning) return
    run.pendingUserMessages.push({ message, silent: true })
    if (run.executionPhase === 'thinking' && run.requestId) {
      this.services.aiService.abort(run.requestId)
    }
    this._subAgentRoster?.wake()
  }

  protected createToolExecutorConfig(run: AgentRun): ToolExecutorConfig {
    return {
      agentId: this.getConversationAgentId(),
      isSubAgent: this._isSubAgent,
      getSessionId: () => this.getSessionId(),
      terminalService: this.services.unifiedTerminalService || this.services.ptyService as any,
      hostProfileService: this.services.hostProfileService,
      mcpService: this.services.mcpService,
      mcpToolSession: this.getMcpToolSession(),
      skillSession: run.skillSession,
      isSkillDismissed: (skillId) =>
        this._userDismissedSkills.has(skillId) || this._userDismissedSkills.has(toUserSkillId(skillId)),
      isUserSkillLoaded: (skillId) => this.isUserSkillLoaded(skillId),
      markUserSkillLoaded: (skillId) => this.markUserSkillLoaded(skillId),
      markBuiltinSkillLoaded: (skillId) => this.markBuiltinSkillLoaded(skillId),
      markSkillUnloaded: (skillId) => this.markSkillUnloaded(skillId),
      pluginRegistry: this.services.pluginRegistry,
      addStep: (step) => this.addStep(step),
      updateStep: (stepId, updates) => this.updateStep(stepId, updates),
      waitForConfirmation: async (toolCallId, toolName, toolArgs, riskLevel, displayName, reasons, trustCommandOffer, opts) => {
        // 「本次允许」：Agent 实例内存白名单（跨 Run，关 tab / 重启清空）
        const candidates = buildAllowlistKeyCandidates(toolName, toolArgs)
        if (candidates.some(k => this.allowedTools.has(k))) {
          return true
        }
        const result = await this.waitForConfirmation(
          run, toolCallId, toolName, toolArgs, riskLevel, displayName, reasons, trustCommandOffer, opts,
        )
        return result.approved
      },
      requestSecureInput: async (skillId, envName, prompt, isUpdate) => {
        return this.requestSecureInput(run, skillId, envName, prompt, isUpdate)
      },
      isAborted: () => run.aborted,
      getAbortSignal: () => run.abortController?.signal,
      getHostId: () => sessionKnowledgeHostId({
        terminalType: run.context.terminalType,
        hostId: run.context.hostId,
      }),
      hasPendingUserMessage: () => run.pendingUserMessages.length > 0,
      peekPendingUserMessage: () => run.pendingUserMessages[0]?.message,
      consumePendingUserMessage: () => run.pendingUserMessages.shift()?.message,
      getRealtimeTerminalOutput: () => [...run.realtimeOutputBuffer],
      getCurrentPlan: () => this.currentPlan,
      setCurrentPlan: (plan) => {
        this.currentPlan = plan
      },
      getTaskMemory: () => this.taskMemory,
      getSftpService: () => this.services.sftpService,
      getSshConfig: (terminalId) => this.services.sshService?.getConfig(terminalId) || null,
      // 上下文余量自查：与压力判断同源（真实锚点 + 本轮新增），
      // 免得模型查到的数跟系统自己的判断对不上
      getContextUsage: () => {
        const total = this._contextWindow.getContextLength()
        const used = this._contextWindow.estimateCurrentPromptTokens(run.messages)
        return { used, total, remaining: Math.max(0, total - used) }
      },
      // 上下文管理
      compressCurrentContext: (summary: string, keepRecent: number) => {
        const result = this._contextWindow.compress(run, summary, keepRecent)
        if (result) {
          this._conversation?.setWorkingContext(run.messages)
          this._conversation?.adoptCompressedArchives(run.compressedArchives)
        }
        return result
      },
      getCompressedArchives: () => {
        const archives = run.compressedArchives?.length
          ? run.compressedArchives
          : (this._conversation?.getCompressedArchives() ?? [])
        return archives.map(a => ({
          id: a.id,
          summary: a.summary,
          messageCount: a.messages.length,
          timestamp: a.timestamp
        }))
      },
      getCompressedArchive: (archiveId: string) => {
        const archive = run.compressedArchives?.find(a => a.id === archiveId)
        if (archive) return archive.messages
        return this._conversation?.getCompressedArchive(archiveId) ?? null
      },
      historyService: this.services.historyService,
      getAiService: () => this.services.aiService,
      getActiveProfileId: () => this.profileId || this.services.configService?.getActiveAiProfile() || undefined,
      getAgentContext: () => run.context,
      getAiRules: () => this.services.configService?.getAiRules() ?? '',
      setCurrentPtyId: (ptyId: string) => {
        this.remapCurrentPtyId(run.ptyId, ptyId)
      },
      getCurrentPtyId: () => run.ptyId,
      getToolOutputBudget: (currentTokensOverride?: number) => {
        const contextLength = this._contextWindow.getContextLength()
        // 锚点 + 本轮新增：同一批工具连续写入时，只看上轮锚点会让每个工具
        // 都以为自己面对的是空窗口，预算发超。
        const currentTokens =
          currentTokensOverride ?? this._contextWindow.estimateCurrentPromptTokens(run.messages)
        return computeToolOutputBudget({ contextLength, currentTokens })
      },
      getSubAgentRoster: () => this._subAgentRoster,
      getParentMessages: () => run.messages,
      knockParent: (message) => this.injectSubAgentKnock(message),
      getToolCatalog: () => this.collectToolCatalog(),
      noteHostOperation: (hostId, meta) => {
        if (!run.hostOperations) run.hostOperations = new Map()
        if (meta?.toolCallId) run.hostOperations.set(meta.toolCallId, hostId)
      },
    }
  }
  
  // ==================== 受保护方法：辅助功能 ====================
  
  /**
   * 添加执行步骤
   */
  protected addStep(step: Partial<AgentStep>): AgentStep {
    const fullStep: AgentStep = {
      id: step.id || this.generateId(),
      type: step.type || 'thinking',
      content: step.content || '',
      timestamp: Date.now(),
      ...step
    }
    
    this.currentRun?.steps.push(fullStep)
    this.callbacks?.onStep?.(this.currentRun?.id || '', fullStep)
    
    return fullStep
  }
  
  /**
   * 更新执行步骤（如果不存在则创建）
   */
  protected updateStep(stepId: string, updates: Partial<AgentStep>): void {
    if (!this.currentRun) return
    
    let step = this.currentRun.steps.find(s => s.id === stepId)
    
    if (!step) {
      // 如果步骤不存在，创建一个新的
      step = {
        id: stepId,
        type: updates.type || 'message',
        content: updates.content || '',
        timestamp: Date.now(),
        isStreaming: updates.isStreaming
      }
      this.currentRun.steps.push(step)
    } else {
      // 更新现有步骤
      Object.assign(step, updates)
    }
    
    this.callbacks?.onStep?.(this.currentRun.id, step)
  }
  
  /**
   * 移除执行步骤
   */
  protected removeStep(stepId: string): void {
    if (!this.currentRun) return

    const index = this.currentRun.steps.findIndex(s => s.id === stepId)
    if (index === -1) return

    this.currentRun.steps.splice(index, 1)
    this.callbacks?.onStepRemoved?.(this.currentRun.id, stepId)
  }
  
  /**
   * 处理待处理的用户消息（运行中追加的 addUserMessage）
   */
  protected processPendingUserMessages(run: AgentRun): void {
    if (run.pendingUserMessages.length === 0) return

    let combinedText = ''
    const allImages: string[] = []
    const visionAvailable = this.currentProfileHasVision()

    for (const pending of run.pendingUserMessages) {
      const userBody = Agent.formatTimestamp() + Agent.formatWorkbenchTag(run.context.terminalType) + pending.message
      let imageNote = ''
      if (pending.images?.length) {
        const imageCount = pending.images.length
        const imagePaths = collectImageAttachmentPaths(pending.attachments)
        log.info(`Supplement images: ${imageCount} image(s), vision=${visionAvailable}, paths=${imagePaths.length}`)
        if (visionAvailable) {
          allImages.push(...pending.images)
        } else {
          log.warn(`Dropping ${imageCount} supplement image(s) due to no vision capability on current profile`)
        }
        imageNote = buildUserImageNote({
          count: imageCount,
          paths: imagePaths,
          visionAvailable,
        })
      }
      const selectionScopeBody = pending.workbenchContext?.selectionScope
        ? formatSelectionScopeBody(pending.workbenchContext.selectionScope)
        : ''
      const msgPart = assembleUserMessageContent({
        userMessage: userBody,
        selectionScope: selectionScopeBody || undefined,
        uploadedDocs: pending.documentContext,
        imageNote: imageNote || undefined,
      })
      combinedText += (combinedText ? '\n\n' : '') + msgPart
    }

    const userSupplementMsg: AiMessage = { role: 'user', content: combinedText }
    if (allImages.length > 0) {
      userSupplementMsg.images = allImages
    }
    run.messages.push(userSupplementMsg)
    // _systemInjected: supplement 是任务中途的追加消息，不是新 task 的起点。
    // 不加此标记会让 splitMessagesIntoTasks（../conversation/messages）把它误计为
    // 新 task 边界，使 message task 数 > step chunk 数，fork 截断时丢失最近 task 的上下文。
    run.taskMessageLog.push({ role: 'user', content: combinedText, _systemInjected: true })

    const heardFromUser = run.pendingUserMessages.some(pending => !pending.silent)
    if (heardFromUser && this.currentPlan && !this.currentPlan.paused && this.currentPlan.steps.some(s => s.status === 'pending')) {
      const planHintMsg: AiMessage = { role: 'user', content: t('agent.user_supplement_with_plan'), _systemInjected: true }
      run.messages.push(planHintMsg)
      run.taskMessageLog.push({ ...planHintMsg })
    }

    run.pendingUserMessages = []
  }
  
  /**
   * 检查计划进度
   */
  protected checkPlanProgress(run: AgentRun): 'continue' | 'complete' {
    if (!this.currentPlan) {
      return 'complete'
    }
    
    if (this.currentPlan.paused) {
      return 'complete'
    }
    
    const pendingSteps = this.currentPlan.steps.filter(s => 
      s.status === 'pending' || s.status === 'in_progress'
    )
    
    if (pendingSteps.length > 0) {
      const stepTitles = pendingSteps.map((s, i) => `${i + 1}. ${s.title}`).join('\n')
      const hint = t('agent.plan_incomplete', { count: pendingSteps.length, steps: stepTitles })
      const planMsg: AiMessage = { role: 'user', content: hint, _systemInjected: true }
      run.messages.push(planMsg)
      run.taskMessageLog.push({ ...planMsg })
      return 'continue'
    }
    
    return 'complete'
  }
  
  /**
   * 设置执行阶段
   *
   * 默认 'executing_command'；工具可以在 ToolDefinition._meta.phase 里声明覆盖
   *（如文件写入工具声明 'writing_file'，wait 工具声明 'waiting'）。基类不知道
   * 具体工具叫什么。
   */
  protected setExecutionPhase(run: AgentRun, toolName: string): void {
    const meta = getMetaByName(this.getAvailableTools(), toolName)
    run.executionPhase = meta?.phase ?? 'executing_command'
    run.currentToolName = toolName
  }
  
  /**
   * 等待用户确认。
   *
   * 无应答通道时按"未批准"返回，理由同 requestSecureInput：没有超时兜底，
   * 缺了结论就是永久挂起。
   */
  protected async waitForConfirmation(
    run: AgentRun,
    toolCallId: string, 
    toolName: string, 
    toolArgs: Record<string, unknown>,
    riskLevel: RiskLevel,
    displayName?: string,
    reasons?: string[],
    trustCommandOffer?: PendingConfirmationInternal['trustCommandOffer'],
    opts?: ConfirmationOptions,
  ): Promise<{ approved: boolean; modifiedArgs?: Record<string, unknown> }> {
    if (this._isSubAgent) {
      if (riskLevel === 'dangerous' || riskLevel === 'blocked') {
        log.warn(`Sub-agent auto-rejected ${riskLevel} operation: ${toolName}`)
        return { approved: false }
      }
      return { approved: true }
    }
    if (!this.callbacks?.onNeedConfirm) {
      log.warn(`No confirmation channel available (tool=${toolName}, risk=${riskLevel}); treating as not approved`)
      return { approved: false }
    }

    let autoReview: AutoReviewTrail | undefined
    if (this.canAutoReview(run, riskLevel, opts)) {
      try {
        const review = await this.runAutoReview(run, toolName, toolArgs, riskLevel, displayName, reasons)
        if (review.kind === 'approved') return { approved: true }
        if (review.kind === 'cancelled' || run.aborted) return { approved: false }
        autoReview = review.trail
      } catch (e) {
        log.warn(`[auto-review] handed over after local error: ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    return new Promise((resolve) => {
      const confirmation: PendingConfirmationInternal = {
        agentId: run.id,
        toolCallId,
        toolName,
        toolArgs,
        riskLevel,
        displayName,
        reasons,
        trustCommandOffer,
        ...(autoReview ? { autoReview } : {}),
        resolve: (approved, modifiedArgs) => {
          run.pendingConfirmation = undefined
          run.executionPhase = 'thinking'
          resolve({ approved, modifiedArgs })
        }
      }
      
      run.pendingConfirmation = confirmation
      run.executionPhase = 'confirming'
      log.info(
        `[confirm] waiting (agent=${this._agentId ?? 'unknown'}, run=${run.id}, tool=${toolName}, toolCallId=${toolCallId}, risk=${riskLevel})`
      )
      this.callbacks?.onNeedConfirm?.(confirmation)
    })
  }

  // ==================== 替我审批 ====================

  /**
   * 只有「有人当场兜底」时才评：用户打开了开关、这类会话允许、有人坐在桌面或交互式命令行前。
   * 插件显式要求审批的一律只问人；硬墙本不进确认，这里再挡一道。
   */
  private canAutoReview(run: AgentRun, riskLevel: RiskLevel, opts?: ConfirmationOptions): boolean {
    if (opts?.humanOnly || riskLevel === 'blocked') return false
    if (!this.services.configService?.isAutoApprovalReviewEnabled()) return false
    if (!conversationPolicy(inferConversationKind(this._agentId)).autoApprovalReview) return false
    if (run.context.unattended) return false
    const channel = run.context.remoteChannel
    return !channel || channel === 'desktop'
  }

  private getAutoReviewer(): AutoApprovalReviewer {
    if (!this._autoReviewer) {
      const aiService = this.services.aiService
      this._autoReviewer = new AutoApprovalReviewer({
        chat: (messages, tools, profileId, signal, options) =>
          aiService.chatWithTools(messages, tools, profileId, signal, options),
      })
    }
    return this._autoReviewer
  }

  private async runAutoReview(
    run: AgentRun,
    toolName: string,
    toolArgs: Record<string, unknown>,
    riskLevel: RiskLevel,
    displayName?: string,
    reasons?: string[],
  ): Promise<{ kind: 'approved' } | { kind: 'cancelled' } | { kind: 'handed_over'; trail: AutoReviewTrail }> {
    const reviewer = this.getAutoReviewer()
    const action = this.describeActionForTrail(toolName, toolArgs, displayName)
    const step = this.addStep({
      type: 'auto_review',
      content: t('autoReview.reviewing', { action }),
      toolName,
      toolArgs,
      riskLevel,
      isStreaming: true,
    })
    const inspectPtyId = resolveInspectPtyId(toolArgs, run.ptyId)
    const ssh = inspectPtyId ? this.services.sshService?.getConfig(inspectPtyId) ?? null : null
    const sftp = this.services.sftpService
    const executor = new CommandExecutorService()
    let result: AutoReviewResult
    try {
    result = await reviewer.review({
      runId: run.id,
      sessionId: this.getSessionId() ?? run.id,
      locale: getLocale(),
      toolName,
      toolArgs,
      displayName,
      riskLevel,
      reasons,
      getSteps: () => run.steps,
      getMessages: () => run.messages,
      aiRules: this.services.configService?.getAiRules() ?? '',
      environment: {
        terminalType: run.context.terminalType,
        sshHost: ssh?.host ?? run.context.sshHost,
        cwd: run.context.cwd,
        os: run.context.systemInfo?.os,
      },
      profileId: this.profileId || this.services.configService?.getActiveAiProfile() || undefined,
      signal: run.abortController?.signal,
      inspector: buildInspectorDeps({
        execute: (command, cwd, timeoutMs) => executor.execute(command, cwd, timeoutMs),
        localCwd: ssh ? undefined : run.context.cwd,
        remote: ssh && sftp && inspectPtyId ? { sftp, ssh, ptyId: inspectPtyId } : undefined,
      }),
    })
    if (result.usage) this.addSideUsage(run, result.usage)
    if (result.kind === 'cancelled') {
      this.updateStep(step.id, { content: t('autoReview.cancelled', { action }), isStreaming: false })
      return { kind: 'cancelled' }
    }

    const trail: AutoReviewTrail = result.kind === 'approved'
      ? { outcome: 'approved', risk: result.assessment.risk, authorization: result.assessment.authorization, rationale: result.assessment.rationale }
      : {
          outcome: 'handed_over',
          reason: result.reason,
          ...(result.assessment
            ? { risk: result.assessment.risk, authorization: result.assessment.authorization, rationale: result.assessment.rationale }
            : {}),
        }
    this.updateStep(step.id, { content: this.formatAutoReviewTrail(trail, action), autoReview: trail, isStreaming: false })
    log.info(`[auto-review] ${trail.outcome}${trail.reason ? `(${trail.reason})` : ''} tool=${toolName} risk=${trail.risk ?? '-'} auth=${trail.authorization ?? '-'}`)
    return result.kind === 'approved' ? { kind: 'approved' } : { kind: 'handed_over', trail }
    } catch (e) {
      const trail: AutoReviewTrail = { outcome: 'handed_over', reason: 'failed' }
      this.updateStep(step.id, { content: this.formatAutoReviewTrail(trail, action), autoReview: trail, isStreaming: false })
      log.warn(`[auto-review] local error, handing over: ${e instanceof Error ? e.message : String(e)}`)
      return { kind: 'handed_over', trail }
    }
  }

  private describeActionForTrail(toolName: string, toolArgs: Record<string, unknown>, displayName?: string): string {
    const summaryField = getMetaByName(this.getAvailableTools(), toolName)?.argRole?.summaryLine
    const summary = summaryField && typeof toolArgs[summaryField] === 'string' ? toolArgs[summaryField] as string : undefined
    const name = displayName ?? toolName
    if (!summary) return name
    const oneLine = summary.replace(/`/g, "'").replace(/\s*\n\s*/g, ' ')
    return `${name} \`${oneLine.length > 200 ? `${oneLine.slice(0, 200)}…` : oneLine}\``
  }

  private formatAutoReviewTrail(trail: AutoReviewTrail, action: string): string {
    const lines = [t(trail.outcome === 'approved' ? 'autoReview.approved' : 'autoReview.handed_over', { action })]
    if (trail.reason && trail.reason !== 'not_approved') lines.push(t(`autoReview.reason.${trail.reason}` as TranslationKey))
    if (trail.risk && trail.authorization) {
      lines.push(t('autoReview.scores', {
        risk: t(`autoReview.risk.${trail.risk}` as TranslationKey),
        authorization: t(`autoReview.auth.${trail.authorization}` as TranslationKey),
      }))
    }
    if (trail.rationale) lines.push(`> ${trail.rationale.replace(/\n+/g, ' ')}`)
    return lines.join('\n\n')
  }

  /** 评审员花的 token 记进这场任务的账，不碰上下文水位。 */
  private addSideUsage(run: AgentRun, usage: TokenUsageInfo): void {
    if (!run.tokenUsage) run.tokenUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    run.tokenUsage.prompt_tokens += usage.prompt_tokens
    run.tokenUsage.completion_tokens += usage.completion_tokens
    run.tokenUsage.total_tokens += usage.total_tokens
    if (usage.cache_hit_tokens !== undefined) {
      run.tokenUsage.cache_hit_tokens = (run.tokenUsage.cache_hit_tokens || 0) + usage.cache_hit_tokens
    }
    if (usage.cache_miss_tokens !== undefined) {
      run.tokenUsage.cache_miss_tokens = (run.tokenUsage.cache_miss_tokens || 0) + usage.cache_miss_tokens
    }
    this.addConsumedUsage(usage)
  }
  
  /**
   * 请求安全输入（弹出前端安全输入框）。
   *
   * 前端弹框后，用户输入的值直接经 IPC 写入加密存储，Agent 只得到"已保存/已取消"。
   * 值的明文**不经过 LLM 上下文**。
   *
   * 无应答通道时（后台关切/唤醒、非交互 CLI 等）立即按"已取消"返回：这个 Promise
   * 没有超时兜底，缺了结论就是永久挂起。
   */
  protected requestSecureInput(
    run: AgentRun,
    skillId: string,
    envName: string,
    prompt: string,
    isUpdate?: boolean
  ): Promise<boolean> {
    if (this._isSubAgent) {
      return Promise.resolve(false)
    }
    if (!this.callbacks?.onNeedSecureInput) {
      log.warn(`No secure input channel available (skill=${skillId}, env=${envName}); treating as cancelled`)
      return Promise.resolve(false)
    }
    return new Promise((resolve) => {
      const requestId = this.generateId()
      const request: PendingSecureInputInternal = {
        agentId: run.id,
        requestId,
        skillId,
        envName,
        prompt,
        isUpdate,
        resolve: (saved) => {
          run.pendingSecureInput = undefined
          run.executionPhase = 'thinking'
          resolve(saved)
        }
      }
      run.pendingSecureInput = request
      run.executionPhase = 'confirming'
      this.callbacks?.onNeedSecureInput?.(request)
    })
  }

  // ==================== 私有方法 ====================
  
  /**
   * 生成唯一 ID
   */
  private generateId(): string {
    const prefix = this._agentId ?? 'agent'
    return `${prefix}_${Date.now()}_${++this.idCounter}`
  }
  
  /**
   * 把当前 run 的默认操作窗格从 oldPtyId 切到 newPtyId，并重绑输出监听。
   *
   * - 同 id（SSH 重连 reuseId）：只重绑监听——底层连接已换，旧 dataCallbacks 已随 disconnect 清空。
   * - 异 id（历史/兜底）：更新 run.ptyId / context.ptyId 后再绑。
   * 仅当 currentRun.ptyId === oldPtyId 时生效，避免误改其它窗格焦点。
   */
  remapPtyId(oldPtyId: string, newPtyId: string): boolean {
    const run = this.currentRun
    if (!run?.isRunning || !oldPtyId || !newPtyId) return false
    if (run.ptyId !== oldPtyId) return false
    if (oldPtyId === newPtyId) {
      run.outputUnsubscribe?.()
      run.outputUnsubscribe = undefined
      this.setupOutputListener(run)
      log.info(`Agent pty listeners rebound (same id): ${newPtyId}`)
      return true
    }
    return this.remapCurrentPtyId(oldPtyId, newPtyId)
  }

  /**
   * 切换当前 run 的默认操作 ptyId，并重绑输出监听。
   * 供 setCurrentPtyId（focus/close/list 自愈）与 remapPtyId（重连）共用。
   */
  private remapCurrentPtyId(oldPtyId: string | undefined, newPtyId: string): boolean {
    const run = this.currentRun
    if (!run?.isRunning || !newPtyId || newPtyId === run.ptyId) return false
    const before = run.ptyId
    run.outputUnsubscribe?.()
    run.outputUnsubscribe = undefined
    run.ptyId = newPtyId
    run.context.ptyId = newPtyId
    this.setupOutputListener(run)
    log.info(`Agent currentPtyId switched: ${before || oldPtyId || '?'} → ${newPtyId}`)
    return true
  }

  /**
   * 设置终端输出监听器
   */
  private setupOutputListener(run: AgentRun): void {
    if (!run.ptyId) return
    
    const MAX_BUFFER_LINES = 200
    const terminalService = this.services.unifiedTerminalService || this.services.ptyService
    
    run.outputUnsubscribe = terminalService.onData(run.ptyId, (data: string) => {
      const newLines = data.split('\n')
      run.realtimeOutputBuffer.push(...newLines)
      
      if (run.realtimeOutputBuffer.length > MAX_BUFFER_LINES) {
        run.realtimeOutputBuffer = run.realtimeOutputBuffer.slice(-MAX_BUFFER_LINES)
      }
    })
  }
  
  // ==================== 上下文窗口管理 ====================
  // 以下逻辑（token 估算 / 用量压力 / 上下文压缩 / 工具调用序列修复）已抽到
  // ContextWindowManager 协作者（./context-window.ts），Agent 通过 this._contextWindow 调用。
  // contextManagementEnabled 也委托给该管理器的 enabled getter。
  
  /**
   * 根据程序设置的语言生成语言提示
   */
  private getLanguageHint(): string {
    const locale = this.services.configService?.getLanguage() || 'zh-CN'
    if (locale === 'en-US') {
      return '[Respond in English]\n'
    }
    return ''  // 中文不需要特别提示
  }
  
  /**
   * 生成工作台标签前缀，格式如 <sf_workbench>local</sf_workbench>
   * 注入到每条用户消息，让 AI 在多工作台对话历史中能识别运行环境
   */
  private static formatWorkbenchTag(terminalType?: string): string {
    return terminalType ? `<sf_workbench>${terminalType}</sf_workbench> ` : ''
  }

  /**
   * 增强用户消息
   */
  private enhanceUserMessage(message: string, terminalType?: string): string {
    const languageHint = this.getLanguageHint()
    return languageHint + Agent.formatTimestamp() + Agent.formatWorkbenchTag(terminalType) + message
  }

  /** 生成用户消息时间戳前缀，格式如 [2026-03-25 22:30 周二] */
  static formatTimestamp(): string {
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
    const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())} ${weekdays[now.getDay()]}`
    return `[${ts}] `
  }

  private resolveBondContext(): string | undefined {
    if (!isOemFeatureEnabled('bond')) return undefined
    try {
      return getBondService().getBondContext()
    } catch {
      return undefined
    }
  }
}
