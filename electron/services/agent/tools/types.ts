/**
 * 工具执行器类型定义
 */
import type { McpService } from '../../mcp.service'
import type { UnifiedTerminalInterface } from '../../unified-terminal.service'
import type { SftpService } from '../../sftp.service'
import type { SshConfig } from '../../ssh.service'
import type { 
  AgentConfig, 
  AgentStep, 
  ToolResult, 
  RiskLevel,
  HostProfileServiceInterface,
  AgentPlan
} from '../types'
import type { SkillSession } from '../skills'
import type { TaskMemoryStore } from '../task-memory'

// 错误分类
export type ErrorCategory = 'transient' | 'permission' | 'not_found' | 'timeout' | 'fatal'

// 需要进行路径解码的参数名
export const PATH_PARAM_NAMES = new Set([
  'path', 'file_path', 'target_path', 'source_path', 
  'dest_path', 'directory', 'dir', 'folder'
])

/**
 * 工具执行器配置
 */
export interface ToolExecutorConfig {
  /** 统一终端服务（支持 PTY 和 SSH） */
  terminalService: UnifiedTerminalInterface
  hostProfileService?: HostProfileServiceInterface
  mcpService?: McpService
  addStep: (step: Omit<AgentStep, 'id' | 'timestamp'>) => AgentStep
  updateStep: (stepId: string, updates: Partial<Omit<AgentStep, 'id' | 'timestamp'>>) => void
  waitForConfirmation: (
    toolCallId: string,
    toolName: string,
    toolArgs: Record<string, unknown>,
    riskLevel: RiskLevel
  ) => Promise<boolean>
  isAborted: () => boolean
  getHostId: () => string | undefined
  hasPendingUserMessage: () => boolean
  peekPendingUserMessage: () => string | undefined
  consumePendingUserMessage: () => string | undefined
  getRealtimeTerminalOutput: () => string[]
  // Plan/Todo 功能
  getCurrentPlan: () => AgentPlan | undefined
  setCurrentPlan: (plan: AgentPlan | undefined) => void
  // Task Memory（任务记忆）
  getTaskMemory: () => TaskMemoryStore
  // SFTP 功能（用于 SSH 终端的文件写入）
  getSftpService?: () => SftpService | undefined
  getSshConfig?: (terminalId: string) => SshConfig | null
  // 技能系统
  skillSession?: SkillSession
  // 上下文管理（compress_context / recall_compressed 工具使用）
  compressCurrentContext?: (summary: string, keepRecent: number) => {
    beforeTokens: number
    afterTokens: number
    freedTokens: number
    archiveId: string
  } | null
  getCompressedArchives?: () => Array<{ id: string; summary: string; messageCount: number; timestamp: number }>
  getCompressedArchive?: (archiveId: string) => import('../../ai.service').AiMessage[] | null
}

// 重新导出常用类型
export type { AgentConfig, AgentStep, ToolResult, RiskLevel, AgentPlan }
