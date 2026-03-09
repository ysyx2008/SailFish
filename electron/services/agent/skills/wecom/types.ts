/**
 * 企业微信技能类型定义
 */

export type WeComResource = 'calendar' | 'approval' | 'checkin' | 'contact'

export type WeComWriteAction = 'create' | 'update' | 'delete'

export interface WeComReadArgs {
  resource: WeComResource
  // calendar
  calendar_id?: string
  event_id?: string
  start_date?: string
  end_date?: string
  // approval
  template_id?: string
  sp_no?: string
  sp_status?: number
  // checkin
  userid?: string
  // contact
  department_id?: number
  // common
  limit?: number
  cursor?: number
}

export interface WeComWriteArgs {
  resource: WeComResource
  action: WeComWriteAction
  // calendar
  calendar_id?: string
  event_id?: string
  // approval
  template_id?: string
  sp_no?: string
  // payload
  data?: Record<string, unknown>
}
