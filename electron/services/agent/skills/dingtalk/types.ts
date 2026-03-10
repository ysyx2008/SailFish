/**
 * 钉钉技能类型定义
 */

export type DingTalkResource =
  | 'calendar' | 'todo' | 'attendance' | 'contact' | 'approval'
  | 'bitable' | 'drive' | 'wiki'

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
  // bitable (v1.0 notable API, 需要 union_id 作为 operatorId)
  base_id?: string
  sheet_id?: string
  record_id?: string
  filter?: string
  // drive (v1.0 drive API, 需要 union_id)
  space_id?: string
  file_id?: string
  parent_id?: string
  // wiki (v2.0 wiki API, 需要 union_id 作为 operatorId)
  workspace_id?: string
  node_id?: string
  keyword?: string
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
  // bitable
  base_id?: string
  sheet_id?: string
  record_id?: string
  record_ids?: string[]
  // drive
  space_id?: string
  file_id?: string
  parent_id?: string
  // wiki
  workspace_id?: string
  node_id?: string
  // payload
  data?: Record<string, unknown>
}
