/**
 * Agent 服务类型定义
 */

// 从共享类型导入并重新导出（保持后端 import 路径兼容）
export type {
  TerminalType,
  ExecutionMode,
  ProactiveCompactStyle,
  RemoteChannel,
  RiskLevel,
  PlanStepStatus,
  StepProgress,
  AgentPlanStep,
  AgentPlan,
  AgentStep,
  AgentContextBar,
  PendingConfirmation,
  PendingSecureInput,
  AttachmentInfo,
  PendingUserHandoff,
  TokenUsage,
  CommandRiskPolicy,
  AgentPaneInfo,
} from '@shared/types'

// 本文件内部也要用（AgentRun.context），故单独 import 一份
import type { AgentContext } from '@shared/types'
export type { AgentContext }

import type { ExecutionMode, PendingConfirmation, PendingSecureInput, AgentStep, AgentContextBar, AgentPlan, AttachmentInfo, TokenUsage, CommandRiskPolicy, PendingUserHandoff } from '@shared/types'

// Agent 配置
export interface AgentConfig {
  enabled: boolean
  maxSteps: number              // 最大执行步数，0 表示无限制（由 Agent 自行决定结束）
  commandTimeout: number        // 命令超时时间（毫秒），默认 30000
  autoExecuteSafe: boolean      // safe 命令自动执行
  autoExecuteModerate: boolean  // moderate 命令是否自动执行
  executionMode: ExecutionMode  // 执行模式：strict=所有命令需确认，relaxed=仅危险命令需确认，free=全自动（危险！）
  debugMode: boolean            // 调试模式：显示详细的工具调用步骤
  /** 解析失败 / 未知命令 的风险策略（按 executionMode 分档），默认走 DEFAULT_COMMAND_RISK_POLICY */
  commandRiskPolicy?: CommandRiskPolicy
}

/**
 * 后端内部使用的 PendingConfirmation，包含 resolve 回调
 * IPC 传输时 resolve 会被剥离，前端使用 @shared/types 的 PendingConfirmation
 */
export interface PendingConfirmationInternal extends PendingConfirmation {
  resolve: (approved: boolean, modifiedArgs?: Record<string, unknown>) => void
  /** 这张卡是伙计的。本次允许只对主人自己的操作生效，不借给伙计换个目录再用。 */
  fromWorker?: boolean
}

/**
 * 后端内部使用的 PendingSecureInput，包含 resolve 回调。
 * IPC 传输时 resolve 会被剥离，前端使用 @shared/types 的 PendingSecureInput。
 */
export interface PendingSecureInputInternal extends PendingSecureInput {
  /** 用户完成输入后调用：saved=true 表示已保存到凭证存储，false 表示已取消 */
  resolve: (saved: boolean) => void
}

// 之前任务的执行步骤（用于上下文）
export interface PreviousAgentStep {
  type: string
  content: string
  toolName?: string
  toolArgs?: Record<string, unknown>
  toolResult?: string
  riskLevel?: string
}

// 之前已完成任务的上下文信息（包含完整执行步骤）
export interface PreviousTaskContext {
  userTask: string
  steps: PreviousAgentStep[]
  finalResult: string
  timestamp: number
  messages?: import('../ai.service').AiMessage[]
}

// AgentContext / AgentPaneInfo 已上移到 @shared/types（见文件顶部转出）

// 工具执行结果
export interface ToolResult {
  success: boolean
  output: string
  error?: string
  /** UI 卡片一行摘要（完整诊断放 error 给模型） */
  briefError?: string
  isRunning?: boolean  // 命令仍在后台执行（用于长耗时命令超时但未失败的情况）
  images?: string[]    // 图片 base64 data URL（read_file 读取图片时返回，注入 AI 上下文供视觉分析）
}

// Worker Agent 选项（智能巡检模式）
export interface WorkerAgentOptions {
  isWorker: boolean               // 是否作为 Worker 运行
  orchestratorId: string          // 所属协调器 ID
  planStepId?: string             // 对应的 AgentPlanStep ID
  terminalName: string            // 终端显示名
  reportProgress?: (step: AgentStep) => void  // 进度回调
}

// Agent 执行阶段（用于智能打断判断）
export type AgentExecutionPhase = 
  | 'thinking'           // AI 思考/生成响应中（安全打断）
  | 'executing_command'  // 执行终端命令中（可能可打断）
  | 'writing_file'       // 写入文件中（危险，不建议打断）
  | 'reading'            // 读取文件/搜索等只读操作中（安全打断）
  | 'waiting'            // wait 工具等待中（安全打断）
  | 'confirming'         // 等待用户确认中（安全打断）
  | 'idle'               // 空闲

// 工具白名单键（用于「本次允许」）
export interface AllowedToolKey {
  toolName: string
  argsHash: string  // 关键参数的哈希值（如文件路径）
}

// 用户补充消息（Agent 运行中追加的对话）
export interface PendingUserMessage {
  message: string
  attachments?: AttachmentInfo[]
  documentContext?: string
  images?: string[]
  /** 旁路工作台上下文（不上 user_supplement 气泡） */
  workbenchContext?: import('@shared/types').WorkbenchContext
  /** 伙计敲门：注入对话但不上墙为 user_supplement */
  silent?: boolean
  /** 后台命令结束的通知：给模型看，不上墙，也不要在收场时当成用户的下一句排进队列 */
  backgroundNotice?: boolean
}

// Agent 运行状态
export interface AgentRun {
  id: string
  ptyId?: string
  requestId?: string  // AI Debug: 当前请求 ID（用于调试日志）
  originalUserRequest: string  // 当前任务的原始用户请求（用于保存任务记忆）
  messages: import('../ai.service').AiMessage[]
  steps: AgentStep[]
  isRunning: boolean
  aborted: boolean
  /** 本次 run 的中止信号；abort() 会 abort，长工具据此尽快退出 */
  abortController?: AbortController
  pendingConfirmation?: PendingConfirmationInternal
  pendingSecureInput?: PendingSecureInputInternal
  pendingUserMessages: PendingUserMessage[]
  config: AgentConfig
  context: AgentContext  // 运行上下文
  // 实时终端输出缓冲区（Agent 运行期间收集）
  realtimeOutputBuffer: string[]
  // 终端输出监听器的取消订阅函数
  outputUnsubscribe?: () => void
  // 当前执行计划（Plan/Todo 功能）
  currentPlan?: AgentPlan
  // Worker 模式选项（智能巡检）
  workerOptions?: WorkerAgentOptions
  // 当前执行阶段（用于智能打断）
  executionPhase: AgentExecutionPhase
  // 当前正在执行的工具名（用于显示）
  currentToolName?: string
  // 初始"正在准备..."步骤的 ID（在有实际输出时移除）
  initialStepId?: string
  // 技能会话
  skillSession?: import('./skills').SkillSession
  // 完整对话记录（append-only，不受 compress_context 影响）
  // 与 messages（工作窗口，可被压缩）分离，确保持久化的历史完整不丢失
  taskMessageLog: import('../ai.service').AiMessage[]
  /**
   * 最后一次 assistant 响应的 reasoning_content（思考模型特有，DeepSeek V3.2+ 等）。
   * 由 executeStep 在每次模型响应后更新，finalizeRun 在保存最终纯文本 assistant 消息时取用，
   * 避免 thinking 模式下丢失 reasoning_content 字段导致下轮任务被 DeepSeek 服务端拒绝。
   */
  lastAssistantReasoningContent?: string
  // 压缩归档：压缩后的原始消息归档在此，可通过 recall(archive_id) 找回
  compressedArchives?: Array<{
    id: string                                        // 归档 ID，如 "ca-1"
    messages: import('../ai.service').AiMessage[]     // 被压缩的原始消息
    summary: string                                   // AI 提供的摘要
    timestamp: number
  }>
  // 本次 run 累计的 token 用量（由 LLM provider 返回的精确值）
  tokenUsage?: TokenUsage
  /**
   * 流式生成阶段预先创建的 tool_call 步骤 ID：toolCallId → stepId。
   * 供工具执行器在进入 addStep 时"认领"并就地更新（而不是重复添加一张新卡），
   * 让"生成命令 → 执行命令 → 出结果"表现为同一张卡的状态迁移。
   */
  pendingPreToolCallStepIds?: Map<string, string>
  /**
   * 对应 pendingPreToolCallStepIds 的最后一次成功解析出的字符串值缓存，
   * 用于在后续片段 JSON 解析失败时保持显示不回退。
   */
  pendingPreToolCallText?: Map<string, string>
  /**
   * 流式参数早失败：toolCallId → 失败信息。
   * 在 onToolCallProgress 中由工具的 streamValidate 元数据命中（如「以 create 写已存在文件」）
   * 时记录，并立即中止当前 AI 生成；executeStep 随后据此合成「带 tool_calls 的 assistant
   * 消息 + 失败 tool 结果」，让循环继续、模型改用正确方式重试，而不必等整段参数流完。
   */
  streamEarlyFailures?: Map<string, { toolName: string; error: string; args: Record<string, unknown> }>
  /**
   * 这场 run 里，哪次工具调用是对哪台主机动的手。
   * 只记在内存里，不进对话历史、不改会话形态。
   */
  hostOperations?: Map<string, string>
  /** 这场不是用户开口，是把后台结果送回来。不上用户气泡，也不当新的一轮标题。 */
  internalNotice?: boolean
  /**
   * 工具执行期间记录 toolCallId → tool_call 步骤 ID 的映射。
   * 工具结束后，Agent 使用它反向把 ToolResult.success 回填到 tool_call 步骤上，
   * 让 UI 可以把左侧竖条颜色从"风险色"切换为"执行结果色"（失败=红 / 成功=淡色），
   * 避免高风险但执行成功的命令被误读为"执行失败"。
   * 回填完成后 entry 会被清除。
   */
  activeToolCallStepIds?: Map<string, string>
  /**
   * 当前批次中工具返回的图片暂存区。
   *
   * 工具返回的图片不能在每次 tool 消息后立即追加 user 消息——这会破坏
   * OpenAI/DeepSeek 协议的"assistant.tool_calls 后必须连续跟随对应每个
   * tool_call_id 的 tool 消息（中间不允许夹杂 user/assistant）"约束，
   * 在多个 read_file 并行返回图片的场景下被 DeepSeek 严格校验拒绝
   * （报 "insufficient tool messages following tool_calls message"）。
   *
   * 因此 processToolResult 把图片累积到本字段，由 flushPendingToolImages
   * 在当前批次的所有 tool 消息都写入 messages 之后，统一合并为单条
   * user 消息追加到 messages 末尾。
   */
  pendingToolImages?: string[]

  /**
   * 本轮 AI 请求触发过「剥图降级」（视觉模型拒收图片后剥离 images 重试成功）。
   * commit 写 cache 前缀快照时据此剔除 images——前缀只装模型实际处理过的内容，
   * 防止带图毒前缀每轮循环「拒图→剥图→说看不到」（SPEC: 跨模型带图）。
   */
  imagesStripped?: boolean
}

// 主机档案服务接口
export interface HostProfileServiceInterface {
  generateHostContext: (hostId: string) => string
  addNote: (hostId: string, note: string) => void
  getProfile: (hostId: string) => {
    os?: string
    osVersion?: string
    shell?: string
    hostname?: string
    username?: string
    homeDir?: string
    installedTools?: string[]
    notes?: string[]
  } | null
}

// Agent 事件回调
export interface AgentCallbacks {
  onStep?: (agentId: string, step: AgentStep) => void
  /** run 开始（user_task 步骤已发出后），供 IM/WebChat 等外部入口同步桌面 tab 的 isRunning */
  onStart?: (agentId: string, userTask: string) => void
  onStepRemoved?: (agentId: string, stepId: string) => void
  /** 会话级上下文栏快照（与 step 解耦；token/cache/拟用模型） */
  onContextBar?: (agentId: string, contextBar: AgentContextBar) => void
  onNeedConfirm?: (confirmation: PendingConfirmationInternal) => void
  /** 确认卡片该收掉了（伙计被打断、这场停了），不必等用户点 */
  onConfirmDismissed?: () => void
  /** 需要安全输入框时触发（如技能 API Key）。前端弹框，值直接写入加密存储，不经过 LLM。 */
  onNeedSecureInput?: (request: PendingSecureInputInternal) => void
  onComplete?: (agentId: string, result: string, pendingUserMessages?: Array<string | PendingUserHandoff>, extra?: { aborted?: boolean }) => void
  onError?: (agentId: string, error: string, extra?: { aborted?: boolean }) => void
  onTextChunk?: (agentId: string, chunk: string) => void
  /** 当前对话因模型不可用已换到下一个（不改默认模型） */
  onModelFailover?: (agentId: string, notice: import('../ai.service').AiModelFailoverNotice) => void
}

// 默认配置
export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  enabled: true,
  maxSteps: 0,                // 0 表示无限制，由 Agent 自行决定何时结束
  commandTimeout: 30000,
  autoExecuteSafe: true,
  autoExecuteModerate: true,
  executionMode: 'strict',    // 默认严格模式：所有命令都需确认
  debugMode: false            // 默认关闭调试模式，使用简洁交互
}

// ==================== 任务记忆相关类型（多层次上下文管理）====================

/**
 * 任务摘要（L2 层）
 * 包含执行过程中的关键信息，用于语义预加载和 recall
 */
export interface TaskDigest {
  commands: string[]              // 执行的关键命令
  paths: string[]                 // 涉及的文件路径
  services: string[]              // 涉及的服务名
  errors: string[]                // 遇到的错误
  keyFindings: string[]           // 关键发现
  pendingAction?: string          // 待确认的操作（如果任务在等待用户确认）
}

/**
 * 任务记忆（完整结构）
 * L1: summary（一句话总结）
 * L2: digest（关键信息摘要）
 * L3: fullSteps（完整执行步骤）
 */
export interface TaskMemory {
  id: string                      // 任务 ID
  userRequest: string             // 用户原始请求
  timestamp: number               // 执行时间
  status: 'success' | 'failed' | 'aborted' | 'pending_confirmation'
  
  // L1: 一句话总结（~50 字符）
  summary: string
  
  // L2: 关键步骤摘要（~500 字符）
  digest: TaskDigest
  
  // L3: 完整执行步骤（原始数据，用于 digest 提取、recall(detail="full") 等）
  fullSteps: AgentStep[]
  
  // 完整 API 对话记录（可选，用于 Level 0 上下文注入）
  // 有此字段时 getFullMessages 直接返回，无需从 fullSteps 重建
  messages?: import('../ai.service').AiMessage[]
  
  // 语义索引
  keywords: string[]              // 关键词（用于快速匹配）
  embedding?: number[]            // 向量嵌入（用于语义搜索，可选）
  
  // AI 建议的压缩级别（由 manage_memory 工具设置，用于 buildRecentTasksContext 优先取值）
  aiSuggestedLevel?: CompressionLevel
}

/**
 * L1 总结（精简版，用于上下文列表）
 */
export interface TaskSummary {
  id: string
  summary: string
  status: 'success' | 'failed' | 'aborted' | 'pending_confirmation'
  timestamp: number
}

/**
 * 相关任务摘要（语义预加载结果）
 */
export interface RelatedTaskDigest {
  taskId: string
  userRequest: string
  digest: TaskDigest
  relevanceScore: number
}

// ==================== 上下文构建器相关类型 ====================

/**
 * 留给 manage_memory 建议档、以及写交接失败时的规则兜底。
 * 同一场续聊的装配不再按档位降级：有检查点接检查点，没有就带原文。
 */
export type CompressionLevel = 0 | 1 | 2 | 3 | 4

// ContextBudget / TaskWithLevel / ContextBuildResult 定义在 context-builder.ts —— 只有它产出这些结构。
// 这里曾各留一份无人引用的副本，且已经漂移（TaskWithLevel.status 少了 pending_confirmation）。

// ==================== Agent OOP 架构相关类型 ====================

/**
 * Agent 依赖的服务集合
 * 通过依赖注入提供给 Agent
 */
export interface AgentServices {
  aiService: import('../ai.service').AiService
  ptyService: import('../pty.service').PtyService
  sshService?: import('../ssh.service').SshService
  sftpService?: import('../sftp.service').SftpService
  unifiedTerminalService?: import('../unified-terminal.service').UnifiedTerminalService
  hostProfileService?: HostProfileServiceInterface
  mcpService?: import('../mcp.service').McpService
  configService?: import('../config.service').ConfigService
  historyService?: import('../history.service').HistoryService
  /** 会话生命周期 / kind 策略接缝（按 kind 决策回种、会话查询委托）。随 historyService 装配。 */
  conversationManager?: import('../conversation').ConversationManager
  pluginRegistry?: import('../plugin/registry').PluginRegistry
}

/**
 * Agent 运行选项
 */
export interface RunOptions {
  /** AI 配置档案 ID */
  profileId?: string
  /** Worker 模式选项（智能巡检时使用） */
  workerOptions?: WorkerAgentOptions
  /** 运行级别回调（覆盖默认回调） */
  callbacks?: AgentCallbacks
  /** 延迟解析 CWD（在 user_task 步骤发出后再执行，避免阻塞消息上墙） */
  cwdResolver?: () => Promise<string>
  /** 不是用户开口：不上用户气泡，结果送回后接着说 */
  internalNotice?: boolean
}

/**
 * 系统提示构建选项
 */
/** 带元数据的主机记忆条目（观察日志模型） */
export interface HostMemoryEntry {
  content: string
  createdAt: number
  volatility?: 'stable' | 'moderate' | 'volatile'
  source?: string
}

export interface PromptOptions {
  /** MBTI 风格类型 */
  mbtiType?: import('../config.service').AgentMbtiType
  /** 知识库上下文 */
  knowledgeContext?: string
  /** 知识库是否启用 */
  knowledgeEnabled?: boolean
  /** 从历史对话中语义检索的相关对话 */
  conversationHistory?: Array<{ userRequest: string; finalResult: string; status: string; timestamp: number; relevance: number }>
  /** L2 知识文档内容 */
  contextKnowledgeDoc?: string
  /** 用户自定义 AI 规则 */
  aiRules?: string
  /** 它有多主动地把已经用不上的过程先交接掉 */
  proactiveCompact?: import('@shared/types').ProactiveCompactStyle
  /** AI 名字 */
  agentName?: string
  /** 任务历史摘要 */
  taskSummaries?: string
  /** 相关任务摘要 */
  relatedTaskDigests?: string
  /** 可用任务 ID 列表 */
  availableTaskIds?: Array<{ id: string; summary: string }>
  /** 当前已设置的关切列表摘要（注入提示词，供 Agent 知晓避免重复创建） */
  watchListSummary?: string
  /** 羁绊上下文（注入提示词，影响对话语气） */
  bondContext?: string
  /** 是否为诞生引导对话（首次使用） */
  isOnboarding?: boolean
}

/**
 * 知识库上下文加载结果
 */
export interface KnowledgeContextResult {
  context: string
  enabled: boolean
  conversationHistory: Array<{ userRequest: string; finalResult: string; status: string; timestamp: number; relevance: number }>
}

/**
 * 运行状态查询结果
 */
export interface RunStatus {
  isRunning: boolean
  phase: AgentExecutionPhase
  currentToolName?: string
  stepCount: number
  hasPendingConfirmation: boolean
}

/**
 * 单步执行结果
 */
export interface StepResult {
  /** 是否继续执行 */
  continue: boolean
  /** 如果不继续，返回的结果 */
  result?: string
  /** 是否需要中断（用户消息等） */
  interrupted?: boolean
}

/** 用户主动要求压缩上下文的结果 */
export type CompactContextReason = 'running' | 'empty' | 'failed'

export type CompactContextResult =
  | { ok: true; freedTokens: number; beforeTokens: number; afterTokens: number }
  | { ok: false; reason: CompactContextReason }
