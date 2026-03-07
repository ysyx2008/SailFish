/**
 * Agent 服务类型定义
 */

// 从共享类型导入并重新导出（保持后端 import 路径兼容）
export type {
  TerminalType,
  ExecutionMode,
  RemoteChannel,
  RiskLevel,
  PlanStepStatus,
  StepProgress,
  AgentPlanStep,
  AgentPlan,
  AgentStep,
  PendingConfirmation,
} from '@shared/types'

import type { TerminalType, ExecutionMode, RemoteChannel, PendingConfirmation, AgentStep, AgentPlan } from '@shared/types'

// Agent 配置
export interface AgentConfig {
  enabled: boolean
  maxSteps: number              // 最大执行步数，0 表示无限制（由 Agent 自行决定结束）
  commandTimeout: number        // 命令超时时间（毫秒），默认 30000
  autoExecuteSafe: boolean      // safe 命令自动执行
  autoExecuteModerate: boolean  // moderate 命令是否自动执行
  executionMode: ExecutionMode  // 执行模式：strict=所有命令需确认，relaxed=仅危险命令需确认，free=全自动（危险！）
  debugMode: boolean            // 调试模式：显示详细的工具调用步骤
}

/**
 * 后端内部使用的 PendingConfirmation，包含 resolve 回调
 * IPC 传输时 resolve 会被剥离，前端使用 @shared/types 的 PendingConfirmation
 */
export interface PendingConfirmationInternal extends PendingConfirmation {
  resolve: (approved: boolean, modifiedArgs?: Record<string, unknown>) => void
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

// Agent 上下文
export interface AgentContext {
  ptyId?: string
  terminalOutput: string[]  // 最近的终端输出
  systemInfo: {
    os: string
    shell: string
  }
  terminalType: TerminalType
  remoteChannel?: RemoteChannel
  cwd?: string  // 当前工作目录（用于告知 AI 当前位置，帮助正确处理相对路径）
  hostId?: string  // 主机档案 ID
  documentContext?: string  // 用户上传的文档内容
  images?: string[]  // 用户上传的图片（base64 data URL），发送给 AI 用于视觉理解
  previewImages?: string[]  // UI 展示用的预览图片（仅 PDF 页面渲染），缺省时用 images
  attachments?: import('@shared/types').AttachmentInfo[]  // 用户上传的文件元信息（用于 user_task 步骤展示）
  sshHost?: string  // SSH 主机地址（用于历史记录元数据）
  sessionId?: string  // 从 HistoryService 恢复的会话 ID（后端自行加载历史数据）
  sessionStartTime?: number  // 从 HistoryService 恢复的会话开始时间
  currentPlan?: AgentPlan  // 当前执行计划（从前端 steps 恢复，用于跨对话持久化）
  wakeup?: boolean  // 唤醒模式：静默运行，不累积到会话历史
  proactiveContext?: string  // IM 场景：Agent 之前主动发送的消息内容，作为用户回复的上下文注入 API 消息
}

// 工具执行结果
export interface ToolResult {
  success: boolean
  output: string
  error?: string
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

// 工具白名单键（用于"始终允许"功能）
export interface AllowedToolKey {
  toolName: string
  argsHash: string  // 关键参数的哈希值（如文件路径）
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
  pendingConfirmation?: PendingConfirmationInternal
  pendingUserMessages: string[]
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
  // 会话级别的工具白名单（"始终允许"功能）
  allowedTools: Set<string>
  // 完整对话记录（append-only，不受 compress_context 影响）
  // 与 messages（工作窗口，可被压缩）分离，确保持久化的历史完整不丢失
  taskMessageLog: import('../ai.service').AiMessage[]
  // 压缩归档：compress_context 工具将被压缩的原始消息归档在此，可通过 recall_compressed 找回
  compressedArchives?: Array<{
    id: string                                        // 归档 ID，如 "ca-1"
    messages: import('../ai.service').AiMessage[]     // 被压缩的原始消息
    summary: string                                   // AI 提供的摘要
    timestamp: number
  }>
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
    installedTools?: string[]
    notes?: string[]
  } | null
}

// Agent 事件回调
export interface AgentCallbacks {
  onStep?: (agentId: string, step: AgentStep) => void
  onNeedConfirm?: (confirmation: PendingConfirmationInternal) => void
  onComplete?: (agentId: string, result: string, pendingUserMessages?: string[]) => void
  onError?: (agentId: string, error: string) => void
  onTextChunk?: (agentId: string, chunk: string) => void
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
  aiSuggestedLevel?: import('./context-builder').CompressionLevel
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
 * 压缩级别
 * Level 0: 完整对话（用户请求 + 所有工具调用/结果 + AI 回复）
 * Level 1: 压缩对话（用户请求 + 压缩后的工具输出 + AI 回复）
 * Level 2: 精简对话（用户请求 + AI 最终回复）
 * Level 3: L2 摘要（命令、路径、关键发现）
 * Level 4: L1 总结（一句话概要）
 */
export type CompressionLevel = 0 | 1 | 2 | 3 | 4

/**
 * 上下文预算分配
 */
export interface ContextBudget {
  total: number              // 总预算（tokens）
  systemPrompt: number       // 系统提示基础部分
  knowledge: number          // 知识库/主机记忆
  recentTasks: number        // 最近任务区（按预算填充）
  nearTasks: number          // 较近任务摘要
  historySummary: number     // 历史任务总结
  currentConversation: number // 当前对话预留
}

/**
 * 带压缩级别的任务上下文
 */
export interface TaskWithLevel {
  taskId: string
  level: CompressionLevel    // 实际使用的压缩级别
  tokens: number             // 实际占用的 tokens
  content: import('../ai.service').AiMessage[] | string  // Level 0-2 返回消息数组，Level 3-4 返回字符串
  userRequest: string        // 用户原始请求
  status: 'success' | 'failed' | 'aborted'
}

/**
 * 上下文构建结果
 */
export interface ContextBuildResult {
  // Level 0-2 的任务，作为消息注入
  recentTaskMessages: import('../ai.service').AiMessage[]
  // Level 3-4 的任务，作为摘要/总结写入系统提示
  taskSummarySection: string
  // 统计信息
  stats: {
    totalTasks: number
    level0Count: number
    level1Count: number
    level2Count: number
    level3Count: number
    level4Count: number
    usedTokens: number
    budget: number
  }
  // 可用任务 ID 列表（用于 recall）
  availableTaskIds: Array<{ id: string; summary: string }>
}

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
}

/**
 * 系统提示构建选项
 */
/** 带元数据的主机记忆条目（观察日志模型）- 保留用于 remember_info 存储 */
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
  /** 用户自定义个性定义（优先级高于 MBTI） */
  personalityText?: string
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
