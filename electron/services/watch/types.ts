/**
 * Watch 系统类型定义
 *
 * Watch（关注点）是感知层的核心抽象：
 * - 定义何时唤醒 Agent（triggers）
 * - 定义 Agent 做什么（prompt + skills）
 * - 定义结果送哪里（output）
 * - 事件分流由 EventPool 在程序层完成，不再使用 AI pre-check
 */

// ==================== 触发器 ====================

export interface CronTrigger {
  type: 'cron'
  expression: string  // "0 9 * * *"
}

export interface IntervalTrigger {
  type: 'interval'
  seconds: number
}

export interface HeartbeatTrigger {
  type: 'heartbeat'
}

export interface WebhookTrigger {
  type: 'webhook'
  token: string  // URL 路径标识，如 /hooks/:token
}

export interface ManualTrigger {
  type: 'manual'
}

export interface FileChangeTrigger {
  type: 'file_change'
  paths: string[]                              // 监控路径（文件或目录）
  pattern?: string                             // glob 过滤，如 "*.log"
  events?: Array<'add' | 'change' | 'unlink'>  // 默认全部
}

export interface CalendarTrigger {
  type: 'calendar'
  icsPath?: string         // .ics 文件路径（留空则用系统日历目录）
  beforeMinutes: number    // 事件开始前 N 分钟触发
}

export interface EmailTrigger {
  type: 'email'
  filter?: {
    from?: string          // 发件人过滤（子串匹配）
    subject?: string       // 主题过滤（子串匹配）
    unseen?: boolean       // 仅未读，默认 true
  }
}

export type WatchTrigger =
  | CronTrigger
  | IntervalTrigger
  | HeartbeatTrigger
  | WebhookTrigger
  | ManualTrigger
  | FileChangeTrigger
  | CalendarTrigger
  | EmailTrigger

export type WatchTriggerType = WatchTrigger['type']

// ==================== 执行环境 ====================

export interface WatchExecution {
  type: 'assistant' | 'local' | 'ssh'
  sshSessionId?: string
  sshSessionName?: string
  workingDirectory?: string
  timeout?: number  // 秒，默认 300
}

// ==================== 输出配置 ====================

export interface WatchOutput {
  type: 'im' | 'notification' | 'log' | 'silent'
}

// ==================== Watch 定义 ====================

export type WatchPriority = 'high' | 'normal' | 'low'

export interface WatchDefinition {
  id: string
  name: string
  description?: string
  enabled: boolean

  triggers: WatchTrigger[]

  prompt: string
  skills?: string[]

  execution: WatchExecution
  output: WatchOutput

  /** 有状态工作流使用的持久化状态 */
  state?: Record<string, unknown>

  priority: WatchPriority

  createdAt: number
  updatedAt: number
  expiresAt?: number

  // 运行时信息（不持久化到配置）
  lastRun?: WatchRunRecord
  nextRun?: number
}

// ==================== 执行记录 ====================

export type WatchRunStatus = 'completed' | 'failed' | 'skipped' | 'timeout' | 'cancelled' | 'running'

export interface WatchRunRecord {
  at: number
  status: WatchRunStatus
  duration: number
  triggerType: WatchTriggerType
  output?: string
  error?: string
  skipReason?: string
}

export interface WatchHistoryRecord extends WatchRunRecord {
  id: string
  watchId: string
  watchName: string
}

// ==================== Watch 创建参数 ====================

export interface CreateWatchParams {
  name: string
  description?: string
  triggers: WatchTrigger[]
  prompt: string
  skills?: string[]
  execution: WatchExecution
  output: WatchOutput
  state?: Record<string, unknown>
  priority?: WatchPriority
  enabled?: boolean
  expiresAt?: number
}
