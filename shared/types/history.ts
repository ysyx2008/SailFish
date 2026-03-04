/**
 * 历史记录共享类型定义
 */

import type { TerminalType } from './agent'

export interface AgentStepRecord {
  id: string
  type: string
  content: string
  images?: string[]
  attachments?: import('./agent').AttachmentInfo[]
  toolName?: string
  toolArgs?: Record<string, unknown>
  toolResult?: string
  riskLevel?: string
  timestamp: number
}

export interface AgentRecord {
  id: string
  timestamp: number
  terminalId: string
  terminalType: TerminalType
  sshHost?: string
  userTask: string
  steps: AgentStepRecord[]
  messages?: Array<{ role: string; content: string; tool_calls?: unknown[]; tool_call_id?: string }>
  finalResult?: string
  duration: number
  status: 'completed' | 'failed' | 'aborted'
}
