/**
 * Watch 系统共享类型定义
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
  expression: string
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
  token: string
}

export interface ManualTrigger {
  type: 'manual'
}

export interface FileChangeTrigger {
  type: 'file_change'
  paths: string[]
  pattern?: string
  events?: Array<'add' | 'change' | 'unlink'>
}

export interface CalendarTrigger {
  type: 'calendar'
  icsPath?: string
  /** 提前提醒窗口（分钟）；缺省时运行时按 15 处理（唤醒等订阅型触发可省略） */
  beforeMinutes?: number
}

export interface EmailTrigger {
  type: 'email'
  filter?: {
    from?: string
    subject?: string
    unseen?: boolean
  }
}

export interface IMConnectedTrigger {
  type: 'im_connected'
}

export interface AppLifecycleTrigger {
  type: 'app_lifecycle'
}

export interface MilestoneTrigger {
  type: 'milestone'
}

export interface WatchFailureTrigger {
  type: 'watch_failure'
}

export interface CommandProbeTrigger {
  type: 'command_probe'
  command: string
  /** 指定 shell（如 'bash', 'powershell'），不指定则自动检测 */
  shell?: string
  /** 探测间隔（秒），最小 10 */
  interval: number
  /** 触发条件：output_changed=输出变化, regex_match=正则匹配, exit_code_nonzero=退出码非零 */
  triggerOn: 'output_changed' | 'regex_match' | 'exit_code_nonzero'
  /** 正则表达式（仅 regex_match 模式） */
  pattern?: string
  workingDirectory?: string
}

export interface HttpProbeTrigger {
  type: 'http_probe'
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
  /** 探测间隔（秒），最小 10 */
  interval: number
  /** 触发条件：status_changed=状态码变化, status_error=非2xx, body_changed=响应体变化, regex_match=正则匹配 */
  triggerOn: 'status_changed' | 'status_error' | 'body_changed' | 'regex_match'
  /** 正则表达式（仅 regex_match 模式） */
  pattern?: string
  /** 请求超时（毫秒），默认 10000 */
  timeout?: number
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
  | IMConnectedTrigger
  | AppLifecycleTrigger
  | MilestoneTrigger
  | CommandProbeTrigger
  | HttpProbeTrigger
  | WatchFailureTrigger

export type WatchTriggerType = WatchTrigger['type']

// ==================== 执行环境 ====================

import type { TerminalType } from './agent'

/** 没单独设置时，一次最多跑这么多秒（15 分钟） */
export const WATCH_RUN_LIMIT_DEFAULT_SEC = 15 * 60
/** 界面上能设的最短（1 分钟） */
export const WATCH_RUN_LIMIT_MIN_SEC = 60
/** 界面上能设的最长（24 小时），避免手误跑个没完 */
export const WATCH_RUN_LIMIT_MAX_SEC = 24 * 60 * 60

export function clampWatchRunLimitSec(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return WATCH_RUN_LIMIT_DEFAULT_SEC
  const minutes = Math.round(seconds / 60)
  const clamped = Math.min(WATCH_RUN_LIMIT_MAX_SEC / 60, Math.max(WATCH_RUN_LIMIT_MIN_SEC / 60, minutes))
  return clamped * 60
}

export interface WatchExecution {
  type: TerminalType
  sshSessionId?: string
  sshSessionName?: string
  workingDirectory?: string
  /** 一次最长跑多少秒；没填就用 15 分钟 */
  timeout?: number
}

// ==================== 输出配置 ====================

export interface WatchOutput {
  type: 'desktop' | 'im' | 'notification' | 'log' | 'silent'
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
  agentSessionId?: string
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
