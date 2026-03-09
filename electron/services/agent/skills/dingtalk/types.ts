/**
 * 钉钉技能类型定义
 */

export type DingTalkResource = 'calendar' | 'todo' | 'attendance' | 'contact' | 'approval'

export type DingTalkWriteAction = 'create' | 'update' | 'delete'

export interface DingTalkReadArgs {
  resource: DingTalkResource
  // calendar (v1.0 API, 需要 union_id)
  union_id?: string
  calendar_id?: string
  event_id?: string
  start_date?: string
  end_date?: string
  // todo (v1.0 API, 需要 union_id)
  task_id?: string
  is_done?: boolean
  // attendance (旧 API)
  userid?: string
  // contact (旧 API)
  department_id?: number
  // approval (旧 API)
  process_code?: string
  process_instance_id?: string
  // common
  limit?: number
  cursor?: string | number
}

export interface DingTalkWriteArgs {
  resource: DingTalkResource
  action: DingTalkWriteAction
  // calendar
  union_id?: string
  calendar_id?: string
  event_id?: string
  // todo
  task_id?: string
  // approval
  process_code?: string
  // payload
  data?: Record<string, unknown>
}
