/**
 * Watch 系统类型定义
 * 从共享类型导入并重新导出（保持后端 import 路径兼容）
 */
export {
  type CronTrigger,
  type IntervalTrigger,
  type HeartbeatTrigger,
  type WebhookTrigger,
  type ManualTrigger,
  type FileChangeTrigger,
  type CalendarTrigger,
  type EmailTrigger,
  type WatchTrigger,
  type WatchTriggerType,
  type WatchExecution,
  type WatchOutput,
  type WatchPriority,
  type WatchDefinition,
  type WatchRunStatus,
  type WatchRunRecord,
  type WatchHistoryRecord,
  type CreateWatchParams,
} from '@shared/types'
