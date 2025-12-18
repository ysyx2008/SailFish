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
}

// 命令风险等级
export type RiskLevel = 'safe' | 'moderate' | 'dangerous' | 'blocked'

// Agent 执行步骤
export interface AgentStep {
  id: string
  type: 'thinking' | 'tool_call' | 'tool_result' | 'message' | 'error' | 'confirm' | 'streaming' | 'user_supplement' | 'waiting' | 'asking' | 'waiting_password' | 'plan_created' | 'plan_updated' | 'plan_archived'
  content: string
  toolName?: string
  toolArgs?: Record<string, unknown>
  toolResult?: string
  riskLevel?: RiskLevel
  timestamp: number
  isStreaming?: boolean  // 是否正在流式输出
  plan?: AgentPlan       // 任务计划（仅 plan_created/plan_updated 类型使用）
  progress?: StepProgress  // 命令执行进度（仅 tool_result 类型使用）
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

// 前一个失败 Agent 的执行步骤（用于重试上下文）
export interface PreviousAgentStep {
  type: string
  content: string
  toolName?: string
  toolArgs?: Record<string, unknown>
  toolResult?: string
  riskLevel?: string
}

// 前一个失败 Agent 的上下文信息
export interface PreviousFailedAgentContext {
  userTask: string  // 用户的原始任务
  steps: PreviousAgentStep[]  // 执行步骤
  finalResult: string  // 最终结果（错误信息）
  timestamp: number  // 失败时间
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
  hostId?: string  // 主机档案 ID
  historyMessages?: { role: string; content: string }[]  // 历史对话记录
  documentContext?: string  // 用户上传的文档内容
  previousFailedAgents?: PreviousFailedAgentContext[]  // 前面连续失败的 Agent 上下文列表（用于重试，最多 3 个）
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

// 执行策略（与 planner 中的定义保持一致）
export type ExecutionStrategy = 'default' | 'conservative' | 'aggressive' | 'diagnostic'

// 策略切换记录
export interface StrategySwitchRecord {
  timestamp: number
  fromStrategy: ExecutionStrategy
  toStrategy: ExecutionStrategy
  reason: string
  triggerCondition: string  // 触发切换的条件
}

// 执行质量评分
export interface ExecutionQualityScore {
  successRate: number       // 成功率 (0-1)
  efficiency: number        // 效率评分 (0-1)
  adaptability: number      // 适应性评分 (0-1)
  overallScore: number      // 综合评分 (0-1)
}

// 增强版反思追踪
export interface ReflectionState {
  toolCallCount: number           // 工具调用计数
  failureCount: number            // 连续失败次数
  totalFailures: number           // 总失败次数
  successCount: number            // 成功次数
  lastCommands: string[]          // 最近执行的命令（用于检测循环）
  lastToolCalls: string[]         // 最近调用的工具签名（工具名+参数哈希，用于检测工具循环）
  lastReflectionAt: number        // 上次反思时的步数
  reflectionCount: number         // 反思次数（用于限制反思上限）
  // 新增：策略相关
  currentStrategy: ExecutionStrategy  // 当前执行策略
  strategySwitches: StrategySwitchRecord[]  // 策略切换历史
  // 新增：质量追踪
  qualityScore?: ExecutionQualityScore  // 执行质量评分
  // 新增：问题分析
  detectedIssues: string[]        // 检测到的问题列表
  appliedFixes: string[]          // 已应用的修复措施
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
  | 'waiting'            // wait 工具等待中（安全打断）
  | 'confirming'         // 等待用户确认中（安全打断）
  | 'idle'               // 空闲

// Agent 运行状态
export interface AgentRun {
  id: string
  ptyId: string
  messages: import('../ai.service').AiMessage[]
  steps: AgentStep[]
  isRunning: boolean
  aborted: boolean
  pendingConfirmation?: PendingConfirmation
  pendingUserMessages: string[]  // 用户补充消息队列
  config: AgentConfig
  context: AgentContext  // 运行上下文
  // 自我反思追踪（增强版）
  reflection: ReflectionState
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
  executionMode: 'strict'     // 默认严格模式：所有命令都需确认
}
