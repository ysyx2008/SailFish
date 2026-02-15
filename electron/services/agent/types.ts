/**
 * Agent 服务类型定义
 */

// 执行模式
export type ExecutionMode = 'strict' | 'relaxed' | 'free'

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

// 命令风险等级
export type RiskLevel = 'safe' | 'moderate' | 'dangerous' | 'blocked'

// Agent 执行步骤
export interface AgentStep {
  id: string
  type: 'thinking' | 'tool_call' | 'tool_result' | 'message' | 'error' | 'confirm' | 'streaming' | 'user_supplement' | 'waiting' | 'asking' | 'waiting_password' | 'plan_created' | 'plan_updated' | 'plan_archived'
  content: string
  images?: string[]  // 用户消息附带的图片（base64 data URL），用于在聊天中显示
  toolName?: string
  toolArgs?: Record<string, unknown>
  toolResult?: string
  riskLevel?: RiskLevel
  timestamp: number
  isStreaming?: boolean  // 是否正在流式输出
  plan?: AgentPlan       // 任务计划（仅 plan_created/plan_updated 类型使用）
  progress?: StepProgress  // 命令执行进度（仅 tool_result 类型使用）
  contextTokens?: number  // 当前上下文的 token 数（后端计算）
}

// 步骤进度信息
export interface StepProgress {
  value: number           // 进度值 (0-100)
  current?: number        // 当前值
  total?: number          // 总数
  eta?: string            // 预计剩余时间
  speed?: string          // 速度
  isIndeterminate: boolean // 是否为不确定进度
  statusText?: string     // 状态文本
}

// ==================== Plan/Todo 相关类型 ====================

// 计划步骤状态
export type PlanStepStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped'

// 计划步骤
export interface AgentPlanStep {
  id: string
  title: string
  description?: string
  status: PlanStepStatus
  result?: string
  startedAt?: number
  completedAt?: number
  progress?: StepProgress
  // 多终端支持（智能巡检模式）
  terminalId?: string       // 关联的终端 ID
  terminalName?: string     // 终端显示名（如 "prod-web-1"）
  hostId?: string           // 主机配置 ID
  isParallel?: boolean      // 是否与其他步骤并行执行
}

// Agent 执行计划
export interface AgentPlan {
  id: string
  title: string
  steps: AgentPlanStep[]
  createdAt: number
  updatedAt: number
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
  userTask: string  // 用户的原始任务
  steps: PreviousAgentStep[]  // 执行步骤
  finalResult: string  // 最终结果
  timestamp: number  // 完成时间
}

// Agent 上下文
export interface AgentContext {
  ptyId: string
  terminalOutput: string[]  // 最近的终端输出
  systemInfo: {
    os: string
    shell: string
  }
  terminalType: 'local' | 'ssh'  // 终端类型：本地终端或 SSH 远程终端
  remoteChannel?: 'desktop' | 'web' | 'dingtalk' | 'feishu'  // 请求来源通道：桌面端、Web远程、钉钉、飞书
  cwd?: string  // 当前工作目录（用于告知 AI 当前位置，帮助正确处理相对路径）
  hostId?: string  // 主机档案 ID
  documentContext?: string  // 用户上传的文档内容
  images?: string[]  // 用户上传的图片（base64 data URL），发送给 AI 用于视觉理解
  previousTasks?: PreviousTaskContext[]  // 之前已完成任务的上下文列表（用于初始化 TaskMemoryStore）
  currentPlan?: AgentPlan  // 当前执行计划（从前端 steps 恢复，用于跨对话持久化）
}

// 工具执行结果
export interface ToolResult {
  success: boolean
  output: string
  error?: string
  isRunning?: boolean  // 命令仍在后台执行（用于长耗时命令超时但未失败的情况）
}

// 待确认的工具调用
export interface PendingConfirmation {
  agentId: string
  toolCallId: string
  toolName: string
  toolArgs: Record<string, unknown>
  riskLevel: RiskLevel
  resolve: (approved: boolean, modifiedArgs?: Record<string, unknown>) => void
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
  ptyId: string
  requestId?: string  // AI Debug: 当前请求 ID（用于调试日志）
  originalUserRequest: string  // 当前任务的原始用户请求（用于保存任务记忆）
  messages: import('../ai.service').AiMessage[]
  steps: AgentStep[]
  isRunning: boolean
  aborted: boolean
  pendingConfirmation?: PendingConfirmation
  pendingUserMessages: string[]  // 用户补充消息队列
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
  onNeedConfirm?: (confirmation: PendingConfirmation) => void
  onComplete?: (agentId: string, result: string, pendingUserMessages?: string[]) => void  // 附带未处理的用户消息
  onError?: (agentId: string, error: string) => void
  onTextChunk?: (agentId: string, chunk: string) => void  // 流式文本回调
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
 * 包含执行过程中的关键信息，用于语义预加载和 recall_task
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
  
  // L3: 完整执行步骤（原始数据）
  fullSteps: AgentStep[]
  
  // 语义索引
  keywords: string[]              // 关键词（用于快速匹配）
  embedding?: number[]            // 向量嵌入（用于语义搜索，可选）
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
  // 可用任务 ID 列表（用于 recall_task）
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
export interface PromptOptions {
  /** MBTI 风格类型 */
  mbtiType?: import('../config.service').AgentMbtiType
  /** 知识库上下文 */
  knowledgeContext?: string
  /** 知识库是否启用 */
  knowledgeEnabled?: boolean
  /** 主机记忆列表 */
  hostMemories?: string[]
  /** 用户自定义 AI 规则 */
  aiRules?: string
  /** 任务历史摘要 */
  taskSummaries?: string
  /** 相关任务摘要 */
  relatedTaskDigests?: string
  /** 可用任务 ID 列表 */
  availableTaskIds?: Array<{ id: string; summary: string }>
}

/**
 * 知识库上下文加载结果
 */
export interface KnowledgeContextResult {
  context: string
  enabled: boolean
  hostMemories: string[]
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
