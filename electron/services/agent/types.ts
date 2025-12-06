/**
 * Agent 服务类型定义
 */

// Agent 配置
export interface AgentConfig {
  enabled: boolean
  maxSteps: number              // 最大执行步数，默认 20
  commandTimeout: number        // 命令超时时间（毫秒），默认 30000
  autoExecuteSafe: boolean      // safe 命令自动执行
  autoExecuteModerate: boolean  // moderate 命令是否自动执行
  strictMode: boolean           // 严格模式：所有命令都需确认，在终端执行
}

// 命令风险等级
export type RiskLevel = 'safe' | 'moderate' | 'dangerous' | 'blocked'

// Agent 执行步骤
export interface AgentStep {
  id: string
  type: 'thinking' | 'tool_call' | 'tool_result' | 'message' | 'error' | 'confirm' | 'streaming' | 'user_supplement'
  content: string
  toolName?: string
  toolArgs?: Record<string, unknown>
  toolResult?: string
  riskLevel?: RiskLevel
  timestamp: number
  isStreaming?: boolean  // 是否正在流式输出
}

// Agent 上下文
export interface AgentContext {
  ptyId: string
  terminalOutput: string[]  // 最近的终端输出
  systemInfo: {
    os: string
    shell: string
  }
  hostId?: string  // 主机档案 ID
  historyMessages?: { role: string; content: string }[]  // 历史对话记录
  documentContext?: string  // 用户上传的文档内容
}

// 工具执行结果
export interface ToolResult {
  success: boolean
  output: string
  error?: string
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
  // 自我反思追踪
  reflection: {
    toolCallCount: number         // 工具调用计数
    failureCount: number          // 连续失败次数
    lastCommands: string[]        // 最近执行的命令（用于检测循环）
    lastReflectionAt: number      // 上次反思时的步数
  }
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
  onComplete?: (agentId: string, result: string) => void
  onError?: (agentId: string, error: string) => void
  onTextChunk?: (agentId: string, chunk: string) => void  // 流式文本回调
}

// 默认配置
export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  enabled: true,
  maxSteps: 50,
  commandTimeout: 30000,
  autoExecuteSafe: true,
  autoExecuteModerate: true,
  strictMode: false           // 默认关闭严格模式
}
