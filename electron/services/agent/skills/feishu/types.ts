/**
 * 飞书技能类型定义
 */

export type FeishuResource = 'bitable' | 'doc' | 'sheet' | 'calendar' | 'task' | 'drive'

export type FeishuWriteAction = 'create' | 'update' | 'delete' | 'upload'

export interface FeishuReadArgs {
  resource: FeishuResource
  // bitable
  app_token?: string
  table_id?: string
  view_id?: string
  // doc
  document_id?: string
  // sheet
  spreadsheet_id?: string
  sheet_id?: string
  range?: string
  // calendar
  calendar_id?: string
  event_id?: string
  // task
  task_id?: string
  // drive
  folder_token?: string
  file_token?: string
  // filters
  filter?: string
  sort?: string
  start_date?: string
  end_date?: string
  limit?: number
  page_token?: string
}

export interface FeishuWriteArgs {
  resource: FeishuResource
  action: FeishuWriteAction
  // bitable
  app_token?: string
  table_id?: string
  record_id?: string
  record_ids?: string[]
  // doc
  document_id?: string
  // sheet
  spreadsheet_id?: string
  sheet_id?: string
  range?: string
  // calendar
  calendar_id?: string
  event_id?: string
  // task
  task_id?: string
  // drive
  folder_token?: string
  file_token?: string
  parent_token?: string
  // payload
  data?: Record<string, unknown>
  file_path?: string
  file_name?: string
}
