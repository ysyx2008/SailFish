/**
 * Conversation —— 会话聚合根（领域模型核心）
 *
 * 一条会话「是什么」由它唯一确定，并独占其**唯一真相源**（对话全过程 transcript）与一切派生投影。
 * 这是「记忆必须归 Conversation、不归 Agent」硬约束的落地（见 docs/conversation-refactor-design.md）。
 *
 * 持有：
 * - **身份**（不可变）：`id`(sessionId) / `kind` / `createdAt`
 * - **形态**（创建时定、不可变）：`terminalType` / `sshHost`——跨形态续聊不漫游（避免历史工具名幻觉）
 * - **运行时绑定**（可变）：`agentKey`——当前哪个 tab/实例在跑（会话漫游时 rebind）
 * - **真相源 transcript**：`_messages`（给模型）/ `_steps`（给 UI）
 * - **派生投影**：`_taskMemory`（L1 工作记忆）、`_cachePrefix`（prompt cache 前缀快照）、token 账
 *
 * 绝不碰：IPC、文件 IO、LLM 调用、KnowledgeService、工具执行——保持纯净以换取可测性。
 * （context 的「富化部分」——注入 L2 知识 / L3 检索 / system prompt——留在 Agent。）
 *
 * 重构现状：本类的状态字段与序列化/切分/commit/cache 决策从 `agent.ts` 的 `_session*` +
 * finalizeRun/saveSessionToHistory/restoreFromSessionRecord/buildContext 忠实移植而来。
 * Agent 已持有一个 Conversation 实例并把 `_session*` 退化为只读委托视图（阶段 2b）；
 * taskMemory 仍由 Agent 注入（共享实例），其完整所有权转移留待阶段 3 的 Manager 策略层。
 */
import type {
  AgentRecord,
  AgentStepRecord,
  AgentStep,
  TokenUsage,
  TerminalType,
  ConversationKind
} from '@shared/types'
import { inferConversationKind, filterPersistableSteps } from '@shared/types'
import type { AiMessage } from '../ai.service'
import { TaskMemoryStore, type LookupToolMeta } from '../agent/task-memory'
import { splitMessagesIntoTasks, splitStepsIntoTasks, stepRecordToStep, chunkStepsByUserTask, chunkStepsForCompanionExtract } from './messages'

function lastTaskStatus(
  record: AgentRecord,
  index: number,
  total: number
): 'success' | 'failed' | 'aborted' {
  if (index !== total - 1) return 'success'
  if (record.status === 'aborted') return 'aborted'
  if (record.status === 'failed') return 'failed'
  return 'success'
}

export interface ConversationCreateOptions {
  /** 显式指定会话 id（恢复/漫游续写既有会话）；省略则生成 `session_<ts>` */
  id?: string
  /** 会话开始时间（恢复时取历史记录的 timestamp）；省略则 Date.now() */
  createdAt?: number
  sshHost?: string
}

/**
 * 工作记忆（taskMemory）的来源。
 * - `taskMemory`：注入一个**现成实例**。Agent 用此在 startNewSession（换 session 但保留工作记忆，
 *   如 Watch）时把同一个 store 传给新 Conversation，保持现状的「跨 session 记忆」语义。
 * - `lookupMeta`：未注入实例时，新建一个 TaskMemoryStore 并用此回调查工具元数据（纯函数，保持纯净）。
 *
 * taskMemory 完全归 Conversation 所有权的转移，留待阶段 3（Manager 策略层）。
 */
export interface ConversationDeps {
  taskMemory?: TaskMemoryStore
  lookupMeta?: LookupToolMeta
}

/** finalizeRun 的状态部分入参（与 Agent 的 AgentRun 解耦：只传纯数据） */
export interface CommitRunInput {
  /** run.id（作为 taskMemory 的 taskId） */
  runId: string
  /** run.originalUserRequest（任务标题） */
  userRequest: string
  /** run.steps：已含 user_task + final_result（给 taskMemory 和 _steps 累积） */
  steps: AgentStep[]
  /** run.taskMessageLog：本次 run 的完整 API 消息（**不含**最终纯文本 assistant 回复，由本方法补） */
  taskMessageLog: AiMessage[]
  /** run.messages：发给模型的消息（**不含**最终纯文本回复，cache 快照基于它） */
  runMessages: AiMessage[]
  /** 任务成败（run.aborted ? 'aborted' : 'success'） */
  taskStatus: 'success' | 'aborted'
  /** 最终纯文本回复（可能为空） */
  result: string | null
  /** 最近一次响应的 reasoning_content（思考模式下必须随 finalMsg 回传，含空串保留） */
  reasoningContent?: string
  /** 本次 run 的 token 用量 */
  tokenUsage?: TokenUsage
  /**
   * 本轮触发过「剥图降级」（视觉模型拒收图片后剥离 images 重试成功）。
   * 写 cache 前缀快照时据此剔除 images——前缀只装模型实际处理过的内容，
   * 防止带图毒前缀每轮循环「拒图→剥图→说看不到」（agent/SPEC: 跨模型带图）。
   */
  imagesStripped?: boolean
}

export class Conversation {
  // ===== 身份（不可变） =====
  readonly id: string
  readonly kind: ConversationKind
  readonly createdAt: number

  // ===== 形态（会话创建时确定、不可变） =====
  readonly terminalType: TerminalType
  readonly sshHost?: string

  // ===== 运行时绑定（可变：会话漫游时换接管 tab/实例，形态不变） =====
  private _agentKey: string

  // ===== 唯一真相源：对话全过程 =====
  private _messages: AiMessage[] = []
  private _steps: AgentStep[] = []

  // ===== 派生投影 =====
  private readonly _taskMemory: TaskMemoryStore
  /** 上一次 run 结束时的完整 messages 快照，用于跨任务 prompt cache 前缀复用（原 _previousRunMessages） */
  private _cachePrefix?: AiMessage[]
  /** 这场做过上下文交接后，重开应接着用的工作上下文（与 UI transcript 的完整 messages 分开） */
  private _workingContext?: AiMessage[]
  private _hasHandoff = false
  /** 这场压下去的原文归档，跟交接一起留下，供按编号取回 */
  private _compressedArchives: Array<{
    id: string
    messages: AiMessage[]
    summary: string
    timestamp: number
  }> = []

  /** 侧栏展示标题（LLM / 手动）；缺省则 UI 用 userTask */
  private _title?: string
  /** 用户亲手改过标题后为 true，自动生成不再覆盖 */
  private _titleLocked = false

  // ===== token 账 =====
  private _tokenUsage?: TokenUsage
  private _lastPromptTokens?: number
  private _lastCacheHitRate?: number
  /**
   * 真实用量序列：每次请求发出时的「消息条数 → 该请求真实 prompt_tokens」。
   * 相邻两点相减即得那一段消息的真实规模，用于压缩前算准「最近几轮多大、
   * 这次能释放多少」，替代估算。压缩 / 冷启动重建后作废（见 setLastPromptTokens）。
   */
  private _tokenLedger: Array<{ messageCount: number; promptTokens: number }> = []
  /** ledger 条数上限。长任务几百轮也只是几百个小对象，留个上限防极端会话无限增长。 */
  private static readonly MAX_TOKEN_LEDGER_ENTRIES = 500

  /** 恢复任务 id 的实例级单调序号，避免同毫秒多次 split 生成的 task id 碰撞（原 _restoreTaskSeq） */
  private _restoreTaskSeq = 0
  private _dirty = false

  private constructor(
    id: string,
    kind: ConversationKind,
    createdAt: number,
    terminalType: TerminalType,
    sshHost: string | undefined,
    agentKey: string,
    taskMemory: TaskMemoryStore
  ) {
    this.id = id
    this.kind = kind
    this.createdAt = createdAt
    this.terminalType = terminalType
    this.sshHost = sshHost
    this._agentKey = agentKey
    this._taskMemory = taskMemory
  }

  // ==================== 工厂 / 序列化 ====================

  /**
   * 新建会话。kind 默认由 agentKey 推断（companion/watch/task），与历史记录的补默认口径一致。
   */
  static create(
    params: {
      agentKey: string
      terminalType: TerminalType
      kind?: ConversationKind
    },
    opts?: ConversationCreateOptions,
    deps?: ConversationDeps
  ): Conversation {
    const kind = params.kind ?? inferConversationKind(params.agentKey)
    return new Conversation(
      opts?.id ?? `session_${Date.now()}`,
      kind,
      opts?.createdAt ?? Date.now(),
      params.terminalType,
      opts?.sshHost,
      params.agentKey,
      deps?.taskMemory ?? new TaskMemoryStore(deps?.lookupMeta)
    )
  }

  /**
   * 从持久化记录反序列化，并重建工作记忆（taskMemory）。
   * 忠实移植 Agent.restoreFromSessionRecord：优先用 messages 切分，缺 messages 的老记录降级用 steps。
   * 有交接检查点时恢复 `_cachePrefix`，重开从检查点接着；没有则首个 run 带原文冷启动。
   */
  static fromRecord(record: AgentRecord, deps?: ConversationDeps): Conversation {
    const conv = new Conversation(
      record.id,
      record.kind ?? inferConversationKind(record.agentKey),
      record.timestamp,
      record.terminalType,
      record.sshHost,
      record.agentKey ?? '',
      deps?.taskMemory ?? new TaskMemoryStore(deps?.lookupMeta)
    )
    conv.loadFromRecord(record)
    return conv
  }

  /**
   * 把一条记录的 transcript 装载进**本实例**并重建工作记忆。
   * 移植自 Agent.restoreFromSessionRecord，供 Agent 在已建会话后从 latest 记录恢复续写状态
   *（持久命名 Agent 的 restoreRecentTaskMemory 另写同一注入 taskMemory，两者叠加）。
   *
   * **刻意不恢复 token 账**：与现状 restoreFromSessionRecord 对齐——重开会话后 _sessionTokenUsage
   * 保持空白、从零累积（保留当前行为；是否改为持久化累积是另一项独立决策，不在本次重构内）。
   */
  loadFromRecord(record: AgentRecord): void {
    if (record.messages && record.messages.length > 0) {
      const tasks = splitMessagesIntoTasks(
        record.messages as AiMessage[],
        () => `restored_${Date.now()}_${this._restoreTaskSeq++}`
      )
      for (let i = 0; i < tasks.length; i++) {
        const task = tasks[i]
        this._taskMemory.saveTask(task.id, task.userTask, [], lastTaskStatus(record, i, tasks.length), task.finalResult, task.messages)
      }
    } else if (record.steps && record.steps.length > 0) {
      const baseTs = record.steps[0]?.timestamp || Date.now()
      const tasks = splitStepsIntoTasks(record.steps, i => `restored_${baseTs}_${i}`)
      for (let i = 0; i < tasks.length; i++) {
        const task = tasks[i]
        this._taskMemory.saveTask(task.id, task.userTask, task.steps, lastTaskStatus(record, i, tasks.length), task.finalResult)
      }
    }

    this.setRestoredTranscript(record.messages as AiMessage[] | undefined, record.steps)
    this.restoreWorkingContext(record.workingContext as AiMessage[] | undefined)
    this.adoptCompressedArchives(record.compressedArchives as typeof this._compressedArchives | undefined)
    const title = record.title?.trim()
    if (title) this._title = title
    if (record.titleLocked) this._titleLocked = true
  }

  /**
   * 仅装载 transcript（_messages / _steps），不碰 taskMemory。
   * 供 Agent 的 restoreFromSessionRecord 复用——那里 taskMemory 由 Agent 用**自己的** split/seq
   * 写入（与 restoreRecentTaskMemory 共享单调序号，防同毫秒 task id 碰撞），transcript 则交本方法。
   * 守卫 `length === 0`：与现状一致，已有 transcript 时不覆盖（续写续聊保留旧产出物字段）。
   */
  setRestoredTranscript(messages?: AiMessage[], stepRecords?: AgentStepRecord[]): void {
    if (stepRecords && stepRecords.length > 0 && this._steps.length === 0) {
      this._steps = stepRecords.map(s => stepRecordToStep(s))
    }
    if (messages && messages.length > 0 && this._messages.length === 0) {
      this._messages = messages.map(m => ({ ...m }))
    }
  }

  /**
   * 序列化为持久化记录。忠实移植 Agent.saveSessionToHistory 的 record 构建。
   * 无 user_task（空会话）返回 null——与现状「找不到 firstUserTask 直接 return」对齐。
   */
  toRecord(opts?: { terminalId?: string; loadedSkills?: string[]; userDismissedSkills?: string[] }): AgentRecord | null {
    const firstUserTask = this._steps.find(s => s.type === 'user_task')
    if (!firstUserTask) return null

    const lastFinalResult = [...this._steps].reverse().find(s => s.type === 'final_result')

    // 会话整体状态由 taskMemory 最后一个任务的状态决定（比关键词匹配准确）
    let status: 'completed' | 'failed' | 'aborted' = 'completed'
    const lastTask = this._taskMemory.getSummaries(1)[0]
    if (lastTask) {
      if (lastTask.status === 'aborted') status = 'aborted'
      else if (lastTask.status === 'failed') status = 'failed'
    }

    const serializableSteps: AgentStepRecord[] = filterPersistableSteps(this._steps)
      .map(s => Conversation.stepToStepRecord(s))

    return {
      id: this.id,
      kind: this.kind,
      timestamp: this.createdAt,
      terminalId: opts?.terminalId || '',
      agentKey: this._agentKey,
      terminalType: this.terminalType,
      sshHost: this.sshHost,
      userTask: firstUserTask.content,
      ...(this._title ? { title: this._title } : {}),
      ...(this._titleLocked ? { titleLocked: true } : {}),
      steps: serializableSteps,
      messages: this._messages.map(m => JSON.parse(JSON.stringify(m))),
      finalResult: lastFinalResult?.content,
      duration: Date.now() - this.createdAt,
      status,
      tokenUsage: this._tokenUsage,
      ...(opts?.loadedSkills ? { loadedSkills: [...opts.loadedSkills] } : {}),
      ...(opts?.userDismissedSkills?.length ? { userDismissedSkills: [...opts.userDismissedSkills] } : {}),
      ...this.workingContextField(),
      ...this.compressedArchivesField()
    }
  }

  /**
   * 序列化「检查点」记录：会话累积态 + 当前 run 进行态合并（防意外退出丢对话）。
   *
   * 与 `toRecord` 的差异：checkpoint 在 **commitRun 之前** 触发（每轮工具调用后），
   * Conversation 自己的 `_steps`/`_messages` 还不含当前 run 的内容，故需把
   * `run.steps` / `run.taskMessageLog` 合并进来。字段映射复用同一份 `stepToStepRecord`，
   * 避免重复实现（原 Agent.saveCheckpoint 的内联映射曾是第二份实现，已收敛于此）。
   *
   * `status` 恒为 `'completed'`——与原实现一致：检查点视为「进行中但有效的记录」，
   * 读侧无运行中状态（`AgentRecord.status` 类型不含 running），靠最近 timestamp 区分。
   *
   * 返回 null 的场景：会话与当前 run 都没有 user_task（空会话首_run 首轮前）。
   */
  toCheckpointRecord(run: {
    steps: AgentStep[]
    taskMessageLog: AiMessage[]
    tokenUsage?: TokenUsage
    contextPtyId?: string
    loadedSkills?: string[]
    userDismissedSkills?: string[]
  }): AgentRecord | null {
    const firstUserTask =
      this._steps.find(s => s.type === 'user_task') ??
      run.steps.find(s => s.type === 'user_task')
    if (!firstUserTask) return null

    const mergedSteps = filterPersistableSteps([...this._steps, ...run.steps])
    const mergedMessages = [...this._messages, ...run.taskMessageLog]
    const checkpointTokenUsage = Conversation.mergeTokenUsage(this._tokenUsage, run.tokenUsage)

    return {
      id: this.id,
      kind: this.kind,
      timestamp: this.createdAt,
      terminalId: run.contextPtyId || '',
      agentKey: this._agentKey,
      terminalType: this.terminalType,
      sshHost: this.sshHost,
      userTask: firstUserTask.content,
      ...(this._title ? { title: this._title } : {}),
      ...(this._titleLocked ? { titleLocked: true } : {}),
      steps: mergedSteps.map(s => Conversation.stepToStepRecord(s)),
      messages: mergedMessages.map(m => JSON.parse(JSON.stringify(m))),
      duration: Date.now() - this.createdAt,
      status: 'completed',
      tokenUsage: checkpointTokenUsage,
      ...(run.loadedSkills ? { loadedSkills: [...run.loadedSkills] } : {}),
      ...(run.userDismissedSkills?.length ? { userDismissedSkills: [...run.userDismissedSkills] } : {}),
      ...this.workingContextField(),
      ...this.compressedArchivesField()
    }
  }

  // ==================== fork / extractTask（数据变换：产新会话） ====================

  /**
   * 同质分叉（task → task）：从单条 record 截断产出一个新会话。
   *
   * 与 `extractTaskFromRecords`（companion 多 record 合并抽取）的区别：
   * - 本方法用 `untilTaskCount` 截止语义（截止到第 N 个 task 全量），适合 task 连续工作流
   * - `extractTaskFromRecords` 用时间窗口语义（同天 + 6h 跨夜，cap 兜底），适合 companion 升格种子
   * 两者数据来源不同——本方法接收**已就绪的单条 record**，调用方负责把它从 in-memory
   *（`toCheckpointRecord`）或磁盘读出来。
   *
   * 返回的 Conversation：
   * - 身份：新 sessionId（由调用方生成）；kind 始终为 `'task'`（fork 产物是独立任务会话）
   * - 形态：继承源 record 的 terminalType / sshHost（同模式 fork 的 cache 前缀才能命中）
   * - transcript：按 `untilTaskCount` 截断后的 steps / messages
   * - taskMemory：用截断后的 messages 重建（`loadFromRecord` 内部完成）
   * - cachePrefix：刻意**不设**——fork 后首次 run 走冷启动重建，由 AgentService 按同/跨模式
   *   决定是否把 newRecord.messages 作为 snapshot 注入（`applyForkSnapshot` / `attachConversation`）
   *
   * @param sourceRecord 源会话记录（in-memory 的 toCheckpointRecord 产物，或磁盘读出的 AgentRecord）
   * @param newSessionId 新 session ID（由调用方生成）
   * @param opts.untilTaskCount 截断到第 N 个 task（包含），undefined / >= 总数 = 不截断
   * @param opts.titleSuffix userTask 后缀（如「· 分支」）
   */
  static forkFromRecord(
    sourceRecord: AgentRecord,
    newSessionId: string,
    opts?: { untilTaskCount?: number; titleSuffix?: string }
  ): { conversation: Conversation; record: AgentRecord } | null {
    const record = Conversation.buildForkedRecord(sourceRecord, newSessionId, opts)
    if (!record) return null
    // fork 产物恒为 task（从 task 或 companion 派生出的独立任务会话）
    record.kind = 'task'
    const conversation = Conversation.fromRecord(record)
    return { conversation, record }
  }

  /**
   * 异质转化（companion → task）：从多条 record 合并抽取一个新会话。
   *
   * companion 是「N 条物理 record 拼成的逻辑关系线」，前端展示用合并视图，group.index
   *（前端传来的 anchorTaskIndex）是合并视图里的位置，无法映射到任何单条 record 的 task 索引。
   * 故需把所有 records 的 steps 按时间排序合并、用非 proactive record 的 messages 拼出
   * LLM 上下文，再走「时间窗口」选择路径。
   *
   * messages 策略：proactive record（userTask='__proactive__'）没有 API messages；
   * 只拼接真实对话 record 的 messages（按 timestamp 升序），保证 LLM 前缀连贯。
   *
   * 窗口语义（见 `selectCompanionTaskWindow`）：以锚点为基准向前取「同天 + 6h 跨夜连续」的
   * task 集合，最多 cap 段兜底。区别于 task 之间 fork 的 `untilTaskCount` 截止语义——
   * companion 是「升格种子」，带最近这段在聊啥即可，不是整个关系线的追溯。
   */
  static extractTaskFromRecords(
    records: AgentRecord[],
    newSessionId: string,
    opts?: {
      anchorTaskIndex?: number
      anchorTaskStepId?: string
      titleSuffix?: string
      /** 前端联络 tab 当前展示的 steps（与屏幕分组一致）；有则优先于磁盘合并 */
      sourceSteps?: AgentStepRecord[]
    }
  ): { conversation: Conversation; record: AgentRecord } | null {
    if (!records.length && !(opts?.sourceSteps && opts.sourceSteps.length > 0)) return null

    const ordered = [...records].sort((a, b) => a.timestamp - b.timestamp)

    // 合并 steps：优先用前端传来的展示态（与用户点击的 group 同源）；否则磁盘合并
    let mergedSteps: AgentStep[]
    if (opts?.sourceSteps && opts.sourceSteps.length > 0) {
      mergedSteps = opts.sourceSteps.map(s => stepRecordToStep(s))
    } else {
      const seen = new Set<string>()
      mergedSteps = ordered
        .flatMap(r => (r.steps ?? []).map(s => stepRecordToStep(s)))
        .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0))
        .filter(s => (s.id && !seen.has(s.id) ? (seen.add(s.id), true) : !s.id))
    }

    // 合并 messages：只取真实对话 record（非 __proactive__），按 timestamp 升序拼接
    const realRecords = ordered.filter(r => r.userTask !== '__proactive__')
    const mergedMessages: AiMessage[] = realRecords
      .flatMap(r => (r.messages ?? []).map(m => JSON.parse(JSON.stringify(m)) as AiMessage))

    // 切段与前端 agentTaskGroups 对齐（结束后的 proactive_notice 单独成段）
    const stepChunks = chunkStepsForCompanionExtract(mergedSteps)
    const messageTasks = splitMessagesIntoTasks(mergedMessages, i => `restored_${Date.now()}_${i}`)
    // proactive 有 steps、无 API messages → messageTasks 比 stepChunks 短。
    // 绝不能用 stepChunk 下标直接取 messageTasks[i]，否则锚点会「往后滑」1～N 段
    //（N = 锚点前的 proactive 数），且随主动消息增减而不稳定。
    const messagesByChunk = Conversation.alignMessagesToStepChunks(stepChunks, messageTasks)
    const anchorIndex = Conversation.resolveAnchorChunkIndex(stepChunks, opts)
    // 锚点无法解析时宁可失败，也不要默默落到最后一条（会把截止点滑到更新的消息）
    if (anchorIndex < 0 || anchorIndex >= stepChunks.length) return null
    const selectedIndices = Conversation.selectCompanionTaskWindow(stepChunks, anchorIndex)

    const selectedSteps: AgentStep[] = selectedIndices
      .map(i => stepChunks[i] ?? [])
      .flat()
    const selectedMessages: AiMessage[] = selectedIndices
      .flatMap(i => messagesByChunk[i] ?? [])

    if (selectedSteps.length === 0) return null

    const anchorChunk = stepChunks[anchorIndex]
    if (!anchorChunk?.length) return null
    const anchorTitle = Conversation.chunkDisplayTitle(anchorChunk)
    if (!anchorTitle) return null
    const lastFinalResult = [...selectedSteps].reverse().find(s => s.type === 'final_result' || s.type === 'proactive_notice')
    const extractedSkills = [...ordered].reverse().find(r => Array.isArray(r.loadedSkills))?.loadedSkills

    // 独立 proactive_notice 段没有 user_task：补一条，便于落盘 / UI 分组
    let stepsForRecord = selectedSteps
    if (!selectedSteps.some(s => s.type === 'user_task')) {
      const ts = selectedSteps[0]?.timestamp ?? Date.now()
      stepsForRecord = [
        {
          id: `user_task_extract_${ts}`,
          type: 'user_task',
          content: anchorTitle,
          timestamp: ts
        },
        ...selectedSteps
      ]
    }

    // 用最早的 record 身份 + assistant 形态构造虚拟 record（companion 始终视为 assistant 模式）
    // 保留 earliest 的额外字段（如 images 等），但核心字段用窗口选择后的结果
    const earliest = ordered[0] ?? {
      id: newSessionId,
      timestamp: Date.now(),
      terminalId: '',
      terminalType: 'assistant' as const,
      userTask: anchorTitle,
      steps: [],
      duration: 0,
      status: 'completed' as const
    }
    const record: AgentRecord = {
      ...earliest,
      id: newSessionId,
      kind: 'task', // fork 产物恒为 task（脱离关系线）
      // agentKey 不继承 earliest（companion 源会带 '__companion__'，与 task kind 矛盾）；
      // 由 startTaskFromConversation 落盘前 rebind 到新 Agent。此处置空避免脏值流出
      agentKey: '',
      timestamp: Date.now(),
      terminalId: '',
      terminalType: 'assistant',
      sshHost: undefined,
      userTask: anchorTitle + (opts?.titleSuffix ?? ''),
      title: undefined,
      titleLocked: undefined,
      steps: stepsForRecord.map(s => Conversation.stepToStepRecord(s)),
      messages: selectedMessages,
      finalResult: lastFinalResult?.content,
      duration: 0,
      status: 'completed',
      ...(extractedSkills?.length ? { loadedSkills: [...extractedSkills] } : {})
    }

    const conversation = Conversation.fromRecord(record)
    return { conversation, record }
  }

  /**
   * 解析锚点 chunk 索引。优先用 `anchorTaskStepId`（与前端 AgentTaskGroup.id 一致）。
   *
   * 若显式传了 stepId 但合并视图里找不到：
   * - 若同时有 sourceSteps（与 UI 同源），可信 fallback 到 anchorTaskIndex
   * - 否则返回 -1（由调用方失败），**绝不**落到 length-1
   */
  private static resolveAnchorChunkIndex(
    stepChunks: AgentStep[][],
    opts?: {
      anchorTaskIndex?: number
      anchorTaskStepId?: string
      sourceSteps?: AgentStepRecord[]
    }
  ): number {
    if (stepChunks.length === 0) return 0

    if (opts?.anchorTaskStepId) {
      let byId = stepChunks.findIndex(chunk =>
        chunk.some(s => s.type === 'user_task' && s.id === opts.anchorTaskStepId)
      )
      if (byId < 0) {
        byId = stepChunks.findIndex(chunk =>
          chunk.some(s => s.id === opts.anchorTaskStepId)
        )
      }
      if (byId >= 0) return byId

      // sourceSteps 与屏幕分组同源时，index 可用；否则拒绝猜测
      if (
        opts.sourceSteps &&
        opts.sourceSteps.length > 0 &&
        opts.anchorTaskIndex !== undefined &&
        opts.anchorTaskIndex >= 0 &&
        opts.anchorTaskIndex < stepChunks.length
      ) {
        return opts.anchorTaskIndex
      }
      return -1
    }

    if (
      opts?.anchorTaskIndex !== undefined &&
      opts.anchorTaskIndex >= 0 &&
      opts.anchorTaskIndex < stepChunks.length
    ) {
      return opts.anchorTaskIndex
    }

    return stepChunks.length - 1
  }

  /** 锚点 chunk 的展示标题（侧栏 / tab 用）。proactive 取摘要，不用 __proactive__。 */
  private static chunkDisplayTitle(chunk: AgentStep[]): string {
    const ut = chunk.find(s => s.type === 'user_task')
    if (ut) {
      if (ut.content === '__proactive__' || ut.content === '__onboarding__') {
        const fr = chunk.find(s => s.type === 'final_result' || s.type === 'proactive_notice')
        const text = (fr?.content ?? chunk.find(s => s.type === 'message')?.content ?? '').trim()
        if (!text) return '主动消息'
        return text.length > 80 ? text.slice(0, 80) + '…' : text
      }
      return ut.content
    }
    // 仅 proactive_notice 的独立段（与前端 isProactive group 对应）
    const notice = chunk.find(s => s.type === 'proactive_notice')
    if (notice?.content) {
      const text = notice.content.trim()
      return text.length > 80 ? text.slice(0, 80) + '…' : text
    }
    return ''
  }

  /**
   * proactive record 无 API messages 时，从 steps 重建 LLM 上下文（与 UI 展示一致）。
   */
  private static messagesFromStepChunk(chunk: AgentStep[]): AiMessage[] {
    const msgs: AiMessage[] = []
    const ut = chunk.find(s => s.type === 'user_task')
    if (ut && ut.content !== '__proactive__' && ut.content !== '__onboarding__') {
      msgs.push({ role: 'user', content: ut.content })
    }
    for (const s of chunk) {
      if (s.type === 'message' && s.content) {
        msgs.push({ role: 'assistant', content: s.content })
      } else if (s.type === 'proactive_notice' && s.content) {
        msgs.push({ role: 'assistant', content: s.content })
      }
    }
    const fr = chunk.find(s => s.type === 'final_result')
    if (fr?.content && !msgs.some(m => m.role === 'assistant')) {
      msgs.push({ role: 'assistant', content: fr.content })
    }
    return msgs
  }

  /**
   * 把 `splitMessagesIntoTasks` 的结果按 stepChunks 对齐。
   *
   * mergedMessages 刻意排除了 `__proactive__` record，而 stepChunks 含这些段——
   * 两者长度/下标不一致。按 stepChunks 顺序推进：proactive/onboarding/独立 notice 用 steps 重建，
   * 真实 user_task 依次消费下一个 messageTask（缺则回退 steps 重建）。
   */
  private static alignMessagesToStepChunks(
    stepChunks: AgentStep[][],
    messageTasks: Array<{ messages: AiMessage[] }>
  ): AiMessage[][] {
    let msgIdx = 0
    return stepChunks.map(chunk => {
      const ut = chunk.find(s => s.type === 'user_task')
      const isProactiveOnly =
        !ut ||
        ut.content === '__proactive__' ||
        ut.content === '__onboarding__' ||
        (chunk.length === 1 && chunk[0]?.type === 'proactive_notice')
      // 无真实 user 对话：不消费 messageTasks 游标
      if (isProactiveOnly) {
        return Conversation.messagesFromStepChunk(chunk)
      }
      const fromApi = messageTasks[msgIdx]?.messages
      msgIdx++
      if (fromApi && fromApi.length > 0) return fromApi
      return Conversation.messagesFromStepChunk(chunk)
    })
  }

  /**
   * companion → task 的时间窗口选择：以锚点为基准向前取连续 task。
   *
   * 1) 先只按**用户对话**往前扩窗（间隔 < 6h、最多 CAP 段）；主动消息不参与扩窗、也不当切断点。
   * 2) 再把落在窗口内（含紧挨窗口首条用户话之前）的主动消息补进来——
   *    常见「通知 → 用户接着回」不能丢掉通知，否则升格任务缺来由。
   * 3) 锚点本身是主动消息 → 只带这一条。
   */
  private static selectCompanionTaskWindow(
    stepChunks: AgentStep[][],
    anchorIndex: number
  ): number[] {
    if (stepChunks.length === 0) return []

    const isProactiveChunk = (chunk: AgentStep[] | undefined): boolean => {
      if (!chunk) return false
      const ut = chunk.find(s => s.type === 'user_task')
      return (
        ut?.content === '__proactive__' ||
        (!ut && chunk.some(s => s.type === 'proactive_notice'))
      )
    }

    const anchorChunk = stepChunks[anchorIndex] ?? []
    if (isProactiveChunk(anchorChunk)) {
      return [anchorIndex]
    }

    const GAP_MS = 6 * 60 * 60 * 1000
    const CAP = 10

    const userSelected: number[] = [anchorIndex]
    let lastIncludedTime = stepChunks[anchorIndex]?.[0]?.timestamp ?? 0

    for (let i = anchorIndex - 1; i >= 0; i--) {
      if (isProactiveChunk(stepChunks[i])) continue
      const t = stepChunks[i]?.[0]?.timestamp ?? 0
      if (lastIncludedTime - t >= GAP_MS) break
      userSelected.unshift(i)
      lastIncludedTime = t
      if (userSelected.length >= CAP) break
    }

    const lo = userSelected[0]
    const hi = userSelected[userSelected.length - 1]
    // 窗口内 + 紧挨首条用户话之前的主动消息一并纳入
    const withNotices: number[] = []
    for (let i = 0; i < stepChunks.length; i++) {
      if (i >= lo && i <= hi) {
        withNotices.push(i)
        continue
      }
      if (i === lo - 1 && isProactiveChunk(stepChunks[i])) {
        withNotices.push(i)
      }
    }
    return withNotices
  }

  /**
   * fork 内核：按 task 边界截断 record 的 steps / messages，产出一个新的 `AgentRecord`。
   *
   * 收敛自原 `Agent.buildForkRecord`（已删除）。三处旧实现（`cloneRecordForFork` /
   * `buildForkRecordFromStoredRecord` / `buildForkRecordFromMergedRecords`）共享同一份截断逻辑，
   * 现统一收口于此。字段映射复用 `stepToStepRecord`（含 `toolCallId`），避免重复实现漏字段。
   *
   * 返回 null：源 record 没有 user_task step 且无法从 userTask 字段补出来——空会话无法 fork。
   */
  private static buildForkedRecord(
    source: AgentRecord,
    newSessionId: string,
    opts?: { untilTaskCount?: number; titleSuffix?: string }
  ): AgentRecord | null {
    // 把持久化 step 记录转成运行时 step（补齐 images / subAgents / canvasData 等富字段）
    let steps: AgentStep[] = (source.steps ?? []).map(s => stepRecordToStep(s))

    // 老记录可能没有 user_task step（仅 record.userTask 字段），补一条保证截断/标题可用
    if (!steps.some(s => s.type === 'user_task') && source.userTask) {
      steps = [{
        id: `user_task_${source.timestamp}`,
        type: 'user_task',
        content: source.userTask,
        timestamp: source.timestamp
      }, ...steps]
    }

    let messages = (source.messages ?? []).map(m => JSON.parse(JSON.stringify(m)) as AiMessage)

    // 按 task 边界截断（messages 用 splitMessagesIntoTasks，steps 用 chunkStepsByUserTask）
    if (opts?.untilTaskCount !== undefined && opts.untilTaskCount > 0) {
      const tasks = splitMessagesIntoTasks(messages, i => `restored_${Date.now()}_${i}`)
      if (opts.untilTaskCount < tasks.length) {
        messages = tasks.slice(0, opts.untilTaskCount).flatMap(t => t.messages)
      }
      const stepChunks = chunkStepsByUserTask(steps)
      if (opts.untilTaskCount < stepChunks.length) {
        steps = stepChunks.slice(0, opts.untilTaskCount).flat()
      }
    }

    const firstUserTask = steps.find(s => s.type === 'user_task')
    if (!firstUserTask) return null

    const lastFinalResult = [...steps].reverse().find(s => s.type === 'final_result')
    const serializableSteps: AgentStepRecord[] = steps.map(s => Conversation.stepToStepRecord(s))

    return {
      id: newSessionId,
      // fork 产物恒为 task（从 task 或 companion 派生出的独立任务会话）；
      // 上层 forkFromRecord / extractTaskFromRecords 也会强制覆盖为 'task'，此处直接写死
      kind: 'task',
      timestamp: Date.now(),
      terminalId: '',
      terminalType: source.terminalType || 'local',
      sshHost: source.sshHost,
      userTask: firstUserTask.content + (opts?.titleSuffix ?? ''),
      steps: serializableSteps,
      messages,
      finalResult: lastFinalResult?.content,
      duration: 0,
      status: 'completed',
      ...(Array.isArray(source.loadedSkills) ? { loadedSkills: [...source.loadedSkills] } : {}),
      ...(Array.isArray(source.userDismissedSkills) ? { userDismissedSkills: [...source.userDismissedSkills] } : {}),
      ...(Array.isArray(source.compressedArchives) ? {
        compressedArchives: source.compressedArchives.map(a => JSON.parse(JSON.stringify(a)))
      } : {})
    }
  }

  // ==================== run 提交（finalizeRun 的状态部分） ====================

  /**
   * 提交一次 run 的结果到会话状态。忠实移植 Agent.finalizeRun + accumulateSessionData 的状态部分：
   * 1. 补最终纯文本 assistant 回复（带 reasoning_content，思考模式必需）到 taskMessageLog
   * 2. 存入 taskMemory（L1 工作记忆）
   * 3. 刷新 cache 前缀快照（runMessages + finalMsg）
   * 4. 累积 transcript（_steps / _messages）与 token 账
   */
  commitRun(input: CommitRunInput): void {
    const finalMsg = this.buildFinalAssistantMessage(input.result, input.reasoningContent)

    // 完整对话日志（含最终回复）——saveTask 与 transcript 累积共用
    const taskLog = [...input.taskMessageLog]
    if (finalMsg) taskLog.push(finalMsg)

    this._taskMemory.saveTask(
      input.runId,
      input.userRequest,
      input.steps,
      input.taskStatus,
      input.result ?? undefined,
      taskLog
    )

    // cache 前缀：run.messages（不含最终纯文本回复）+ 补最终回复
    let snapshot = input.runMessages.map(m => ({ ...m }))
    // 剥图降级自愈：视觉模型拒图后剥图重试成功时，快照里的图从未被模型处理过，
    // 若原样保留会让下一轮继续带图触发同样的拒收→剥图循环；剔除后前缀只剩
    // 模型实际处理过的文本内容（agent/SPEC: 跨模型带图「剥图自愈」）。
    if (input.imagesStripped) {
      snapshot = snapshot.map(m => (m.images?.length ? { ...m, images: undefined } : m))
    }
    if (finalMsg) snapshot.push(finalMsg)
    this._cachePrefix = snapshot
    if (this._hasHandoff) this._workingContext = snapshot

    this.accumulate(input.steps, taskLog, input.tokenUsage)
  }

  /**
   * 提交一次**失败** run（Agent.handleError 的状态部分）。与成功路径不对称：
   * 错误 assistant 回复已由 Agent 先 push 进 run.messages / taskMessageLog（保证悬空 tool_calls 被补全），
   * 故 taskLog 已含最终回复、不再补；cache 前缀由调用方按「run.messages 是否含 user」决定传入或 null
   *（buildContext 阶段就抛错时不更新前缀，保留上次成功快照走冷启动）。
   */
  commitFailedRun(input: {
    runId: string
    userRequest: string
    steps: AgentStep[]
    /** 完整失败现场日志（**已含**错误 assistant 回复） */
    taskLog: AiMessage[]
    /** 新 cache 前缀（已含错误回复）；null = 不更新前缀（保留上次成功快照） */
    cachePrefix: AiMessage[] | null
    errorMessage: string
    tokenUsage?: TokenUsage
    /** 本轮触发过剥图降级：写 cache 前缀时剔除 images（与 commitRun 对称） */
    imagesStripped?: boolean
  }): void {
    this._taskMemory.saveTask(
      input.runId,
      input.userRequest,
      input.steps,
      'failed',
      input.errorMessage,
      input.taskLog
    )

    if (input.cachePrefix) {
      let snapshot = input.cachePrefix.map(m => ({ ...m }))
      if (input.imagesStripped) {
        snapshot = snapshot.map(m => (m.images?.length ? { ...m, images: undefined } : m))
      }
      this._cachePrefix = snapshot
      if (this._hasHandoff) this._workingContext = snapshot
    }

    this.accumulate(input.steps, input.taskLog, input.tokenUsage)
  }

  /** 累积 transcript（_steps / _messages）与 token 账——成功/失败路径共用。 */
  private accumulate(steps: AgentStep[], taskLog: AiMessage[], tokenUsage?: TokenUsage): void {
    this._steps.push(...steps)
    this._messages.push(...taskLog)

    if (tokenUsage) {
      if (!this._tokenUsage) {
        this._tokenUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      }
      this._tokenUsage.prompt_tokens += tokenUsage.prompt_tokens
      this._tokenUsage.completion_tokens += tokenUsage.completion_tokens
      this._tokenUsage.total_tokens += tokenUsage.total_tokens
      if (tokenUsage.cache_hit_tokens !== undefined) {
        this._tokenUsage.cache_hit_tokens = (this._tokenUsage.cache_hit_tokens || 0) + tokenUsage.cache_hit_tokens
      }
      if (tokenUsage.cache_miss_tokens !== undefined) {
        this._tokenUsage.cache_miss_tokens = (this._tokenUsage.cache_miss_tokens || 0) + tokenUsage.cache_miss_tokens
      }
    }

    this._dirty = true
  }

  private buildFinalAssistantMessage(result: string | null, reasoningContent?: string): AiMessage | null {
    if (result == null) return null
    const finalMsg: AiMessage = { role: 'assistant', content: result }
    // 思考模式：!== undefined 保留空串，避免 DeepSeek V3.2+ 因字段缺失报 400
    if (reasoningContent !== undefined) {
      finalMsg.reasoning_content = reasoningContent
    }
    return finalMsg
  }

  // ==================== cache 前缀（buildContext 的纯判定部分） ====================

  /**
   * 是否应复用 cache 前缀（buildContext 的「Cache-optimized path」判定）。
   * 跳过条件：无前缀、唤醒 run（wakeup）、前缀大到连压缩自身的空间都不剩。
   *
   * `maxPrefixTokens` 由调用方按「窗口 - 压缩预留」给出：历史变长本身不是重建
   * 理由，能复用就复用把前缀缓存吃满；真到装不下时由压缩接手，只有连压缩都做不了
   * （典型是中途换到更小窗口的模型）才回冷启动重建。
   *
   * `estimateTokens` 由调用方注入「锚点 + 增量」口径（见 ContextWindowManager
   * .estimateCurrentPromptTokens）——它内部已优先采信真实用量，这里不再单独
   * 短路 _lastPromptTokens，否则会漏算上一轮的 assistant 回复。
   */
  shouldReuseCachePrefix(maxPrefixTokens: number, opts: { wakeup?: boolean; estimateTokens: (msgs: AiMessage[]) => number }): boolean {
    if (!this._cachePrefix || this._cachePrefix.length === 0) return false
    if (opts.wakeup) return false
    // 有交接就接着检查点，不因窗口变小去把已交原文再展开。
    if (this._hasHandoff) return true
    return opts.estimateTokens(this._cachePrefix) < maxPrefixTokens
  }

  /**
   * 续聊 / 重开时该不该接着当前工作前缀。
   * 有交接必须接着；还在这场也接着（窗口满了交给本步交接）；唤醒和「新图首投无图前缀」除外。
   */
  shouldResumeWorkingPrefix(opts: { wakeup?: boolean; skipVisionCache?: boolean }): boolean {
    if (!this._cachePrefix?.length || opts.wakeup) return false
    if (this._hasHandoff) return true
    return !opts.skipVisionCache
  }

  /**
   * 取出 cache 前缀的拷贝并清除旧断点标记（调用方负责设置新断点 + 追加新 user 消息）。
   * 仅在 shouldReuseCachePrefix() 为真时调用。
   */
  prepareCachePrefix(): AiMessage[] {
    return (this._cachePrefix ?? []).map(m => {
      const copy = { ...m }
      delete (copy as Record<string, unknown>)._cacheBreakpoint
      return copy
    })
  }

  getCachePrefix(): AiMessage[] | undefined {
    return this._cachePrefix
  }

  /** 直接设置 cache 前缀（fork 同形态时由调用方传入 newRecord.messages，命中 LLM 前缀缓存） */
  setCachePrefix(messages: AiMessage[] | undefined): void {
    this._cachePrefix = messages ? messages.map(m => JSON.parse(JSON.stringify(m))) : undefined
  }

  hasHandoff(): boolean {
    return this._hasHandoff
  }

  /** 上下文交接后记下当前工作上下文，重开从这里接着。 */
  setWorkingContext(messages: AiMessage[] | undefined): void {
    this._hasHandoff = true
    this._workingContext = messages ? messages.map(m => JSON.parse(JSON.stringify(m))) : undefined
  }

  /** 只追加界面过程（如任务进行中的自动交接），不另开一轮、不进工作记忆。 */
  appendSteps(steps: AgentStep[]): void {
    const persistable = filterPersistableSteps(steps)
    if (persistable.length === 0) return
    this._steps.push(...persistable)
    this._dirty = true
  }

  /**
   * 人主动要求的一轮（如压缩上下文）：写入画面和任务记忆，
   * 不改工作上下文——脑子里带着什么仍由交接检查点说了算。
   */
  commitTranscriptTurn(input: {
    runId: string
    userRequest: string
    steps: AgentStep[]
    taskStatus: 'success' | 'failed' | 'aborted'
    result: string
  }): void {
    const persistable = filterPersistableSteps(input.steps)
    const taskLog: AiMessage[] = [
      { role: 'user', content: input.userRequest },
      { role: 'assistant', content: input.result }
    ]
    this._taskMemory.saveTask(
      input.runId,
      input.userRequest,
      persistable,
      input.taskStatus,
      input.result,
      taskLog
    )
    this.accumulate(persistable, taskLog)
  }

  /** 从落盘的交接检查点恢复工作上下文，并接上 cache 前缀。 */
  restoreWorkingContext(messages: AiMessage[] | undefined): void {
    if (!messages?.length) return
    this._hasHandoff = true
    this._workingContext = messages.map(m => JSON.parse(JSON.stringify(m)))
    this.setCachePrefix(this._workingContext)
  }

  private workingContextField(): { workingContext?: AiMessage[] } {
    if (!this._hasHandoff) return {}
    const src = this._workingContext ?? this._cachePrefix
    if (!src?.length) return {}
    return { workingContext: src.map(m => JSON.parse(JSON.stringify(m))) }
  }

  getCompressedArchives(): Array<{
    id: string
    messages: AiMessage[]
    summary: string
    timestamp: number
  }> {
    return this._compressedArchives.map(a => ({
      id: a.id,
      messages: JSON.parse(JSON.stringify(a.messages)),
      summary: a.summary,
      timestamp: a.timestamp
    }))
  }

  getCompressedArchive(archiveId: string): AiMessage[] | null {
    const archive = this._compressedArchives.find(a => a.id === archiveId)
    return archive ? JSON.parse(JSON.stringify(archive.messages)) : null
  }

  /** 按 id 追加，已有的不覆盖。压完或从记录恢复时把原文归档收进这场对话。 */
  adoptCompressedArchives(archives?: Array<{
    id: string
    messages: AiMessage[]
    summary: string
    timestamp: number
  }>): void {
    if (!archives?.length) return
    const seen = new Set(this._compressedArchives.map(a => a.id))
    let added = false
    for (const archive of archives) {
      if (!archive?.id || seen.has(archive.id)) continue
      seen.add(archive.id)
      this._compressedArchives.push({
        id: archive.id,
        messages: JSON.parse(JSON.stringify(archive.messages ?? [])),
        summary: archive.summary ?? '',
        timestamp: archive.timestamp ?? Date.now()
      })
      added = true
    }
    if (added) this._dirty = true
  }

  private compressedArchivesField(): { compressedArchives?: AgentRecord['compressedArchives'] } {
    if (this._compressedArchives.length === 0) return {}
    return { compressedArchives: this.getCompressedArchives() }
  }

  // ==================== 会话操作 ====================

  /** 会话漫游：仅换接管的 tab/实例（agentKey），形态不变（限同 terminalType，由调用方保证） */
  rebind(agentKey: string): void {
    if (this._agentKey === agentKey) return
    this._agentKey = agentKey
    this._dirty = true
  }

  /** 侧栏展示标题；未设置时 UI 回退 userTask */
  get title(): string | undefined {
    return this._title
  }

  /** 用户亲手改过标题后为 true */
  get titleLocked(): boolean {
    return this._titleLocked
  }

  /** 会话内用户完整轮次（user_task，不含中途追加） */
  get userTaskCount(): number {
    return this._steps.filter(s => s.type === 'user_task').length
  }

  /**
   * 设置展示标题。未变化时返回 false（调用方据此跳过写盘）。
   * 空串视为清除。`locked: true` 表示用户手改，之后自动生成不再覆盖。
   */
  setTitle(title: string, opts?: { locked?: boolean }): boolean {
    const trimmed = title.trim()
    const next = trimmed || undefined
    const lock = opts?.locked === true
    if (this._titleLocked && !lock) return false
    const titleChanged = this._title !== next
    const lockChanged = lock && !this._titleLocked
    if (!titleChanged && !lockChanged) return false
    if (titleChanged) this._title = next
    if (lockChanged) this._titleLocked = true
    this._dirty = true
    return true
  }

  /**
   * 清空对话（reset）：清空 transcript / 工作记忆 / cache / token 账。
   * 对应 Agent.resetSession 的状态部分（会话身份的销毁/重建由上层 Manager 负责）。
   */
  reset(): void {
    this._messages = []
    this._steps = []
    this._cachePrefix = undefined
    this._workingContext = undefined
    this._hasHandoff = false
    this._compressedArchives = []
    this._tokenUsage = undefined
    this._lastPromptTokens = undefined
    this._lastCacheHitRate = undefined
    this._tokenLedger = []
    this._taskMemory.clear()
    this._dirty = true
  }

  // ==================== token 账 setter（API 调用后由 Agent 回填） ====================

  setLastPromptTokens(tokens: number | undefined): void {
    this._lastPromptTokens = tokens
    // 作废锚点意味着消息序列已经改变（压缩 / 冷启动重建），ledger 里记的
    // 「第 N 条消息处用了多少」全部对不上号，必须一起清掉。
    if (tokens === undefined) this._tokenLedger = []
  }

  /**
   * 记录一次请求的真实用量。
   *
   * `messageCount` 是**发出该请求时** messages 的条数，`promptTokens` 是这批消息
   * （连同固定前缀）的真实规模。两次记录相减即得中间那段消息的真实 token 数——
   * 固定前缀在两边同时出现、自动约掉，所以这个差值比任何估算都准，且不花钱。
   */
  recordPromptUsage(messageCount: number, promptTokens: number): void {
    this._lastPromptTokens = promptTokens
    const last = this._tokenLedger[this._tokenLedger.length - 1]
    // 同一条数重复上报（如剥图重试）以最后一次为准，避免同一位置出现两个读数
    if (last && last.messageCount === messageCount) {
      last.promptTokens = promptTokens
      return
    }
    // 条数回退说明序列被改过而没走作废路径，此时旧记录已不可信，丢弃后重新开始
    if (last && messageCount < last.messageCount) {
      this._tokenLedger = []
    }
    this._tokenLedger.push({ messageCount, promptTokens })
    if (this._tokenLedger.length > Conversation.MAX_TOKEN_LEDGER_ENTRIES) {
      this._tokenLedger.shift()
    }
  }

  /**
   * 消息区间 [fromCount, toCount) 的真实 token 数。
   *
   * 两端都必须**精确**落在记录过的位置上，任一端没有记录就返回 undefined，
   * 由调用方回退估算。刻意不做「取最近记录点」的近似：那会把两个不同位置映射到
   * 同一个读数，算出虚假的 0，比老实说"不知道"更危险。
   */
  measureMessageRange(fromCount: number, toCount: number): number | undefined {
    if (toCount <= fromCount) return 0
    const from = this.findLedgerPoint(fromCount)
    const to = this.findLedgerPoint(toCount)
    if (from === undefined || to === undefined) return undefined
    return Math.max(0, to - from)
  }

  /** 该位置上记录过的 promptTokens；没有精确记录返回 undefined */
  private findLedgerPoint(messageCount: number): number | undefined {
    return this._tokenLedger.find(e => e.messageCount === messageCount)?.promptTokens
  }

  /** 已记录真实读数的消息位置（升序），供压缩决策挑可测量的切分点 */
  getLedgerPositions(): number[] {
    return this._tokenLedger.map(e => e.messageCount)
  }
  setLastCacheHitRate(rate: number | undefined): void {
    this._lastCacheHitRate = rate
  }

  // ==================== 访问器 ====================

  get agentKey(): string { return this._agentKey }
  get messages(): readonly AiMessage[] { return this._messages }
  get steps(): readonly AgentStep[] { return this._steps }
  get taskMemory(): TaskMemoryStore { return this._taskMemory }
  get tokenUsage(): TokenUsage | undefined { return this._tokenUsage }
  get lastPromptTokens(): number | undefined { return this._lastPromptTokens }
  get lastCacheHitRate(): number | undefined { return this._lastCacheHitRate }
  get isDirty(): boolean { return this._dirty }
  markClean(): void { this._dirty = false }

  // ==================== 私有：step 运行时 → 持久化记录（序列化，toRecord/toCheckpointRecord 用） ====================
  // 切分逻辑（split*）与 record→step 转换已抽到 ./messages 纯函数，Agent 与本类共用。

  private static stepToStepRecord(s: AgentStep): AgentStepRecord {
    return {
      id: s.id,
      type: s.type,
      content: s.content || '',
      images: s.images,
      echartsOption: s.echartsOption,
      attachments: s.attachments,
      toolName: s.toolName,
      /**
       * 关联的 tool_call ID——精确配对 tool_call ↔ tool_result 的钥匙。
       * 历史实现（saveCheckpoint 内联映射 + 本方法）都漏了这个字段，导致存盘后
       * 配对退化为按 toolName 匹配，并发同名工具调用会相互覆盖。此处补全，
       * 老记录读盘仍走「缺 toolCallId 退化按 toolName」兼容路径，新记录精确配对。
       */
      toolCallId: s.toolCallId,
      toolArgs: s.toolArgs ? JSON.parse(JSON.stringify(s.toolArgs)) : undefined,
      toolResult: s.toolResult,
      riskLevel: s.riskLevel,
      timestamp: s.timestamp,
      webSearchResults: s.webSearchResults,
      success: s.success,
      askingStatus: s.askingStatus,
      askingAnswer: s.askingAnswer,
      autoReview: s.autoReview,
      subAgents: s.subAgents,
      canvasData: s.canvasData,
      hugeOutput: s.hugeOutput,
    }
  }

  /**
   * 合并 token 用量（会话累积态 + 本次 run）。忠实移植 Agent.saveCheckpoint 的合并逻辑：
   * cache_hit/cache_miss 字段按「任一侧有则保留」策略，与 accumulate 的「两侧相加」不同——
   * accumulate 是 commitRun 时把 run 完整并入会话；checkpoint 是「快照 = 累积 + run 进行中」，
   * 不并入、只合并视图，故 cache 字段保持「存在即传递」而非累加。
   */
  private static mergeTokenUsage(
    base: TokenUsage | undefined,
    run: TokenUsage | undefined
  ): TokenUsage | undefined {
    if (!base && !run) return undefined
    if (!run) return base
    if (!base) return run
    const merged: TokenUsage = {
      prompt_tokens: (base.prompt_tokens || 0) + run.prompt_tokens,
      completion_tokens: (base.completion_tokens || 0) + run.completion_tokens,
      total_tokens: (base.total_tokens || 0) + run.total_tokens
    }
    if (run.cache_hit_tokens !== undefined || base.cache_hit_tokens !== undefined) {
      merged.cache_hit_tokens = (base.cache_hit_tokens || 0) + (run.cache_hit_tokens || 0)
    }
    if (run.cache_miss_tokens !== undefined || base.cache_miss_tokens !== undefined) {
      merged.cache_miss_tokens = (base.cache_miss_tokens || 0) + (run.cache_miss_tokens || 0)
    }
    return merged
  }
}
