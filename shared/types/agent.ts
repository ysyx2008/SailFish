/**
 * Agent 共享类型定义
 * 前后端通用，IPC 安全（不含不可序列化的字段如函数回调）
 */

/** 终端/执行环境类型：本地终端、SSH 远程终端、纯助手模式（无终端） */
export type TerminalType = 'local' | 'ssh' | 'assistant'

/** Agent 执行模式：strict=所有命令需确认，relaxed=仅危险命令需确认，free=全自动 */
export type ExecutionMode = 'strict' | 'relaxed' | 'free'

/** 远程访问渠道 */
export type RemoteChannel = 'desktop' | 'web' | 'dingtalk' | 'feishu' | 'slack' | 'telegram' | 'wecom'

export type RiskLevel = 'safe' | 'moderate' | 'dangerous' | 'blocked'

export type PlanStepStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped'

export interface StepProgress {
  value: number
  current?: number
  total?: number
  eta?: string
  speed?: string
  isIndeterminate: boolean
  statusText?: string
}

export interface AgentPlanStep {
  id: string
  title: string
  description?: string
  status: PlanStepStatus
  result?: string
  startedAt?: number
  completedAt?: number
  progress?: StepProgress
  terminalId?: string
  terminalName?: string
  hostId?: string
  isParallel?: boolean
}

export interface AgentPlan {
  id: string
  title: string
  steps: AgentPlanStep[]
  createdAt: number
  updatedAt: number
}

export interface AgentStep {
  id: string
  type: 'thinking' | 'tool_call' | 'tool_result' | 'message' | 'error' | 'confirm' | 'streaming' | 'user_supplement' | 'waiting' | 'asking' | 'waiting_password' | 'plan_created' | 'plan_updated' | 'plan_archived' | 'user_task' | 'final_result'
  content: string
  images?: string[]
  toolName?: string
  toolArgs?: Record<string, unknown>
  toolResult?: string
  riskLevel?: RiskLevel
  timestamp: number
  isStreaming?: boolean
  plan?: AgentPlan
  progress?: StepProgress
  contextTokens?: number
}

/**
 * 待确认的工具调用（IPC 安全版本，不含 resolve 回调）
 * 后端通过 PendingConfirmationInternal 扩展 resolve 字段
 */
export interface PendingConfirmation {
  agentId: string
  toolCallId: string
  toolName: string
  toolArgs: Record<string, unknown>
  riskLevel: RiskLevel
}
