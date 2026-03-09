/**
 * 飞书技能执行器
 * 将 feishu_read / feishu_write 路由到各资源的 API 调用
 */

import * as fs from 'fs'
import * as path from 'path'
import { createLogger } from '../../../../utils/logger'
import { getConfigService } from '../../../config.service'
import { t } from '../../i18n'
import type { ToolResult, AgentConfig } from '../../types'
import type { ToolExecutorConfig } from '../../tool-executor'
import type { FeishuReadArgs, FeishuWriteArgs, FeishuResource } from './types'
import { getClient, extractApiError, closeSession, getRequestOptions } from './session'

const log = createLogger('FeishuExecutor')

function resourceLabel(resource: FeishuResource | string): string {
  const key = `feishu.resource_${resource}`
  const label = t(key as any)
  return label !== key ? label : resource
}

function actionLabel(action: string): string {
  const key = `feishu.action_${action}`
  const label = t(key as any)
  return label !== key ? label : action
}

async function ensureClient(): Promise<any> {
  const configService = getConfigService()
  const appId = configService.get('imFeishuAppId') as string
  const appSecret = configService.get('imFeishuAppSecret') as string
  return getClient(appId, appSecret)
}

export async function executeFeishuTool(
  toolName: string,
  ptyId: string,
  args: Record<string, unknown>,
  toolCallId: string,
  config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  try {
    if (toolName === 'feishu_read') {
      return await feishuRead(args as unknown as FeishuReadArgs, executor)
    }
    if (toolName === 'feishu_write') {
      return await feishuWrite(args as unknown as FeishuWriteArgs, toolCallId, config, executor)
    }
    return { success: false, output: '', error: t('feishu.unknown_tool', { name: toolName }) }
  } catch (err: any) {
    const msg = extractApiError(err)
    log.error(`${toolName} failed:`, msg)
    return { success: false, output: '', error: msg }
  }
}

// ==================== feishu_read ====================

async function feishuRead(args: FeishuReadArgs, executor: ToolExecutorConfig): Promise<ToolResult> {
  const client = await ensureClient()
  const { resource } = args
  if (!resource) {
    return { success: false, output: '', error: t('feishu.missing_resource') }
  }

  const idHint = args.app_token || args.document_id || args.spreadsheet_id || args.calendar_id || args.task_id || args.folder_token || ''
  executor.addStep({
    type: 'tool_call',
    content: t('feishu.reading', { resource: resourceLabel(resource), hint: idHint ? ` (${idHint.substring(0, 20)})` : '' }),
    toolName: 'feishu_read',
    toolArgs: { resource, ...Object.fromEntries(Object.entries(args).filter(([_, v]) => v !== undefined).slice(0, 4)) },
    riskLevel: 'safe'
  })

  const handlers: Record<FeishuResource, () => Promise<ToolResult>> = {
    bitable: () => readBitable(client, args, executor),
    doc: () => readDoc(client, args, executor),
    sheet: () => readSheet(client, args, executor),
    calendar: () => readCalendar(client, args, executor),
    task: () => readTask(client, args, executor),
    drive: () => readDrive(client, args, executor),
  }

  const handler = handlers[resource]
  if (!handler) {
    return { success: false, output: '', error: t('feishu.unsupported_resource', { resource }) }
  }
  return handler()
}

// ==================== feishu_write ====================

async function feishuWrite(
  args: FeishuWriteArgs,
  toolCallId: string,
  config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const client = await ensureClient()
  const { resource, action } = args
  if (!resource || !action) {
    return { success: false, output: '', error: t('feishu.missing_resource_or_action') }
  }

  executor.addStep({
    type: 'tool_call',
    content: t('feishu.writing', { action: actionLabel(action), resource: resourceLabel(resource) }),
    toolName: 'feishu_write',
    toolArgs: { resource, action, ...Object.fromEntries(Object.entries(args).filter(([k, v]) => v !== undefined && k !== 'resource' && k !== 'action').slice(0, 3)) },
    riskLevel: action === 'delete' ? 'moderate' : 'safe'
  })

  const handlers: Record<FeishuResource, () => Promise<ToolResult>> = {
    bitable: () => writeBitable(client, args, toolCallId, executor),
    doc: () => writeDoc(client, args, toolCallId, executor),
    sheet: () => writeSheet(client, args, toolCallId, executor),
    calendar: () => writeCalendar(client, args, toolCallId, executor),
    task: () => writeTask(client, args, toolCallId, executor),
    drive: () => writeDrive(client, args, toolCallId, executor),
  }

  const handler = handlers[resource]
  if (!handler) {
    return { success: false, output: '', error: t('feishu.unsupported_resource', { resource }) }
  }
  return handler()
}

// ========================================================================
//  Bitable（多维表格）
// ========================================================================

async function readBitable(client: any, args: FeishuReadArgs, executor: ToolExecutorConfig): Promise<ToolResult> {
  const { app_token, table_id, view_id, filter, sort, limit, page_token } = args
  const opts = await getRequestOptions()

  if (!app_token) {
    return { success: false, output: '', error: t('feishu.bitable_app_token_required') }
  }

  // 不传 table_id → 列出所有数据表
  if (!table_id) {
    const resp = await client.bitable.appTable.list({
      path: { app_token },
      params: { page_size: limit || 50, page_token },
    }, opts)
    const items = resp?.data?.items || []
    const lines = items.map((tb: any) => `- **${tb.name}** (table_id: \`${tb.table_id}\`)`)
    let output = `## ${resourceLabel('bitable')} tables\n\n${lines.join('\n') || t('feishu.no_data')}`
    if (resp?.data?.page_token) {
      output += `\n\n> More available, page_token: \`${resp.data.page_token}\``
    }
    addReadStep(executor, 'feishu_read', `📊 ${items.length} tables`, output)
    return { success: true, output }
  }

  // 传了 table_id → 查询记录
  const params: any = {
    page_size: Math.min(limit || 20, 100),
  }
  if (view_id) params.view_id = view_id
  if (filter) params.filter = filter
  if (sort) {
    try { params.sort = typeof sort === 'string' ? JSON.parse(sort) : sort } catch { /* ignore */ }
  }
  if (page_token) params.page_token = page_token

  const resp = await client.bitable.appTableRecord.list({
    path: { app_token, table_id },
    params,
  }, opts)

  const records = resp?.data?.items || []
  const total = resp?.data?.total || records.length

  if (records.length === 0) {
    const output = t('feishu.query_empty')
    addReadStep(executor, 'feishu_read', output, output)
    return { success: true, output }
  }

  // 将记录格式化为 Markdown 表格
  const allFields = new Set<string>()
  for (const r of records) {
    if (r.fields) Object.keys(r.fields).forEach(k => allFields.add(k))
  }
  const fields = Array.from(allFields)

  let output = `## ${resourceLabel('bitable')} records (${records.length}/${total})\n\n`
  output += `| record_id | ${fields.join(' | ')} |\n`
  output += `| --- | ${fields.map(() => '---').join(' | ')} |\n`
  for (const r of records) {
    const vals = fields.map(f => formatCellValue(r.fields?.[f]))
    output += `| ${r.record_id} | ${vals.join(' | ')} |\n`
  }
  if (resp?.data?.page_token) {
    output += `\n> More available, page_token: \`${resp.data.page_token}\``
  }

  addReadStep(executor, 'feishu_read', `📊 ${records.length}/${total} records`, output)
  return { success: true, output }
}

async function writeBitable(
  client: any, args: FeishuWriteArgs, toolCallId: string, executor: ToolExecutorConfig
): Promise<ToolResult> {
  const { action, app_token, table_id, record_id, record_ids, data } = args
  const opts = await getRequestOptions()

  if (action === 'create' && !app_token) {
    const name = String(data?.name || 'Untitled Bitable')
    const createData: any = { name }
    if (args.folder_token) createData.folder_token = args.folder_token
    const resp = await client.bitable.app.create({ data: createData }, opts)
    const appToken = resp?.data?.app?.app_token || ''
    const appUrl = resp?.data?.app?.url || ''
    const output = [
      t('feishu.bitable_app_created', { name }),
      `app_token: \`${appToken}\``,
      appUrl ? `URL: ${appUrl}` : '',
    ].filter(Boolean).join('\n')
    addWriteStep(executor, 'feishu_write', output, output)
    return { success: true, output }
  }

  if (!app_token || !table_id) {
    return { success: false, output: '', error: t('feishu.bitable_write_required') }
  }

  if (action === 'create') {
    if (!data?.fields) {
      return { success: false, output: '', error: t('feishu.bitable_fields_required', { action: 'create' }) }
    }
    const resp = await client.bitable.appTableRecord.create({
      path: { app_token, table_id },
      data: { fields: data.fields },
    }, opts)
    const rid = resp?.data?.record?.record_id || '(unknown)'
    const output = `Record created, record_id: ${rid}`
    addWriteStep(executor, 'feishu_write', output, output)
    return { success: true, output }
  }

  if (action === 'update') {
    if (!record_id) {
      return { success: false, output: '', error: t('feishu.bitable_record_id_required') }
    }
    if (!data?.fields) {
      return { success: false, output: '', error: t('feishu.bitable_fields_required', { action: 'update' }) }
    }
    await client.bitable.appTableRecord.update({
      path: { app_token, table_id, record_id },
      data: { fields: data.fields },
    }, opts)
    const output = `Record ${record_id} updated`
    addWriteStep(executor, 'feishu_write', output, output)
    return { success: true, output }
  }

  if (action === 'delete') {
    const ids = record_ids || (record_id ? [record_id] : [])
    if (ids.length === 0) {
      return { success: false, output: '', error: t('feishu.bitable_record_ids_required') }
    }
    await client.bitable.appTableRecord.batchDelete({
      path: { app_token, table_id },
      data: { records: ids },
    }, opts)
    const output = `Deleted ${ids.length} record(s)`
    addWriteStep(executor, 'feishu_write', output, output)
    return { success: true, output }
  }

  return { success: false, output: '', error: t('feishu.unsupported_action', { resource: 'bitable', action }) }
}

// ========================================================================
//  Doc（云文档）
// ========================================================================

async function readDoc(client: any, args: FeishuReadArgs, executor: ToolExecutorConfig): Promise<ToolResult> {
  const { document_id } = args
  const opts = await getRequestOptions()

  if (!document_id) {
    const resp = await client.drive.file.list({
      params: {
        folder_token: '',
        page_size: args.limit || 20,
        order_by: 'EditedTime',
        direction: 'DESC',
      },
    }, opts)
    const files = resp?.data?.files || []
    const docs = files.filter((f: any) => f.type === 'docx' || f.type === 'doc')
    const lines = docs.map((f: any) =>
      `- **${f.name}** (document_id: \`${f.token}\`, type: ${f.type}, modified: ${formatTimestamp(f.modified_time)})`
    )
    const output = `## ${resourceLabel('doc')} list\n\n${lines.join('\n') || t('feishu.no_data')}`
    addReadStep(executor, 'feishu_read', `📄 ${docs.length} doc(s)`, output)
    return { success: true, output }
  }

  const resp = await client.docx.documentBlock.list({
    path: { document_id },
    params: { page_size: 500 },
  }, opts)
  const blocks = resp?.data?.items || []
  const textParts: string[] = []
  for (const block of blocks) {
    const text = extractBlockText(block)
    if (text) textParts.push(text)
  }
  const output = textParts.join('\n') || t('feishu.no_data')
  addReadStep(executor, 'feishu_read', `📄 doc ${document_id}`, output)
  return { success: true, output }
}

async function writeDoc(
  client: any, args: FeishuWriteArgs, toolCallId: string, executor: ToolExecutorConfig
): Promise<ToolResult> {
  const { action, document_id, data } = args
  const opts = await getRequestOptions()

  if (action === 'create') {
    const title = (data?.title as string) || 'Untitled'
    const resp = await client.docx.document.create({
      data: { title, folder_token: (data?.folder_token as string) || '' },
    }, opts)
    const docId = resp?.data?.document?.document_id
    const output = `Doc created: ${title} (document_id: ${docId})`
    addWriteStep(executor, 'feishu_write', output, output)

    // 如果提供了 content，追加到文档
    if (data?.content && docId) {
      try {
        await appendDocContent(client, docId, data.content as string, opts)
      } catch (err) {
        log.warn('Failed to append content to new doc:', extractApiError(err))
      }
    }
    return { success: true, output }
  }

  if (action === 'update') {
    if (!document_id) {
      return { success: false, output: '', error: t('feishu.doc_id_required', { action: 'update' }) }
    }
    if (!data?.content) {
      return { success: false, output: '', error: t('feishu.doc_content_required') }
    }
    await appendDocContent(client, document_id, data.content as string, opts)
    const output = `Doc ${document_id} content appended`
    addWriteStep(executor, 'feishu_write', output, output)
    return { success: true, output }
  }

  if (action === 'delete') {
    if (!document_id) {
      return { success: false, output: '', error: t('feishu.doc_id_required', { action: 'delete' }) }
    }
    await client.drive.file.delete({
      path: { file_token: document_id },
      params: { type: 'docx' },
    }, opts)
    const output = `Doc ${document_id} deleted`
    addWriteStep(executor, 'feishu_write', output, output)
    return { success: true, output }
  }

  return { success: false, output: '', error: t('feishu.unsupported_action', { resource: 'doc', action }) }
}

// ========================================================================
//  Sheet（电子表格）
// ========================================================================

async function readSheet(client: any, args: FeishuReadArgs, executor: ToolExecutorConfig): Promise<ToolResult> {
  const { spreadsheet_id, sheet_id, range } = args
  const opts = await getRequestOptions()

  if (!spreadsheet_id) {
    return { success: false, output: '', error: t('feishu.sheet_id_required') }
  }

  // 不传 sheet_id → 列出工作表
  if (!sheet_id) {
    const resp = await client.sheets.spreadsheetSheet.query({
      path: { spreadsheet_token: spreadsheet_id },
    }, opts)
    const sheets = resp?.data?.sheets || []
    const lines = sheets.map((s: any) =>
      `- **${s.title}** (sheet_id: \`${s.sheet_id}\`, ${s.row_count} rows × ${s.column_count} cols)`
    )
    const output = `## ${resourceLabel('sheet')} worksheets\n\n${lines.join('\n') || t('feishu.no_data')}`
    addReadStep(executor, 'feishu_read', `📊 ${sheets.length} sheet(s)`, output)
    return { success: true, output }
  }

  const fullRange = range ? `${sheet_id}!${range}` : sheet_id
  const valResp = await client.request({
    method: 'GET',
    url: `/open-apis/sheets/v2/spreadsheets/${spreadsheet_id}/values/${encodeURIComponent(fullRange)}`,
  }, opts)
  const valueRange = valResp?.data?.valueRange || valResp?.data
  const values = valueRange?.values || []

  if (values.length === 0) {
    const output = `Sheet ${sheet_id} ${range ? `range ${range}` : ''} no data`
    addReadStep(executor, 'feishu_read', output, output)
    return { success: true, output }
  }

  // 格式化为 Markdown 表格
  let output = `## ${resourceLabel('sheet')} data (${values.length} rows)\n\n`
  const header = values[0] || []
  output += `| ${header.map((h: any) => String(h ?? '')).join(' | ')} |\n`
  output += `| ${header.map(() => '---').join(' | ')} |\n`
  for (let i = 1; i < Math.min(values.length, (args.limit || 50) + 1); i++) {
    const row = values[i] || []
    output += `| ${row.map((c: any) => String(c ?? '')).join(' | ')} |\n`
  }
  if (values.length > (args.limit || 50) + 1) {
    output += `\n> Total ${values.length - 1} rows, showing first ${args.limit || 50}`
  }

  addReadStep(executor, 'feishu_read', `📊 ${values.length - 1} row(s)`, output)
  return { success: true, output }
}

async function writeSheet(
  client: any, args: FeishuWriteArgs, toolCallId: string, executor: ToolExecutorConfig
): Promise<ToolResult> {
  const { action, spreadsheet_id, sheet_id, range, data } = args
  const opts = await getRequestOptions()

  if (action === 'create') {
    const title = (data?.title as string) || 'Untitled'
    const folderToken = (data?.folder_token as string) || ''
    const resp = await client.sheets.spreadsheet.create({
      data: { title, folder_token: folderToken },
    }, opts)
    const token = resp?.data?.spreadsheet?.spreadsheet_token
    const output = `Sheet created: ${title} (spreadsheet_id: ${token})`
    addWriteStep(executor, 'feishu_write', output, output)
    return { success: true, output }
  }

  if (action === 'update') {
    if (!spreadsheet_id || !sheet_id) {
      return { success: false, output: '', error: t('feishu.sheet_write_required') }
    }
    if (!data?.values) {
      return { success: false, output: '', error: t('feishu.sheet_values_required') }
    }
    const fullRange = range ? `${sheet_id}!${range}` : sheet_id
    await client.request({
      method: 'PUT',
      url: `/open-apis/sheets/v2/spreadsheets/${spreadsheet_id}/values`,
      data: {
        valueRange: {
          range: fullRange,
          values: data.values,
        },
      },
    }, opts)
    const rows = (data.values as any[][]).length
    const output = `Written ${rows} row(s) to ${fullRange}`
    addWriteStep(executor, 'feishu_write', output, output)
    return { success: true, output }
  }

  return { success: false, output: '', error: t('feishu.unsupported_action', { resource: 'sheet', action }) }
}

// ========================================================================
//  Calendar（日历）
// ========================================================================

async function readCalendar(client: any, args: FeishuReadArgs, executor: ToolExecutorConfig): Promise<ToolResult> {
  const { calendar_id, event_id, start_date, end_date, limit, page_token } = args
  const opts = await getRequestOptions()

  if (!calendar_id) {
    const resp = await client.calendar.calendar.list({
      params: { page_size: limit || 50, page_token },
    }, opts)
    const calendars = resp?.data?.calendar_list || []
    const lines = calendars.map((c: any) =>
      `- **${c.summary || '(untitled)'}** (calendar_id: \`${c.calendar_id}\`, type: ${c.type}, role: ${c.role})`
    )
    const output = `## ${resourceLabel('calendar')} list\n\n${lines.join('\n') || t('feishu.no_data')}`
    addReadStep(executor, 'feishu_read', `📅 ${calendars.length} calendar(s)`, output)
    return { success: true, output }
  }

  if (event_id) {
    const resp = await client.calendar.calendarEvent.get({
      path: { calendar_id, event_id },
    }, opts)
    const event = resp?.data?.event
    if (!event) {
      return { success: false, output: '', error: `Event ${event_id} not found` }
    }
    const output = formatCalendarEvent(event)
    addReadStep(executor, 'feishu_read', `📅 ${event.summary || '(untitled)'}`, output)
    return { success: true, output }
  }

  // 列出日程
  const now = new Date()
  const startTs = start_date ? new Date(start_date).getTime() / 1000 : Math.floor(now.getTime() / 1000)
  const endDate = end_date ? new Date(end_date) : new Date(now.getTime() + 7 * 24 * 3600 * 1000)
  const endTs = Math.floor(endDate.getTime() / 1000)

  const resp = await client.calendar.calendarEvent.list({
    path: { calendar_id },
    params: {
      start_time: String(Math.floor(startTs)),
      end_time: String(Math.floor(endTs)),
      page_size: Math.min(limit || 50, 100),
      page_token,
    },
  }, opts)
  const events = resp?.data?.items || []
  const lines = events.map((e: any) => {
    const start = formatFeishuTime(e.start_time)
    const end = formatFeishuTime(e.end_time)
    return `- **${e.summary || '(untitled)'}** | ${start} ~ ${end} | event_id: \`${e.event_id}\``
  })

  const output = `## ${resourceLabel('calendar')} events (${start_date || 'today'} ~ ${end_date || '+7d'})\n\n${lines.join('\n') || t('feishu.no_data')}`
  addReadStep(executor, 'feishu_read', `📅 ${events.length} event(s)`, output)
  return { success: true, output }
}

async function writeCalendar(
  client: any, args: FeishuWriteArgs, toolCallId: string, executor: ToolExecutorConfig
): Promise<ToolResult> {
  const { action, calendar_id, event_id, data } = args
  const opts = await getRequestOptions()

  if (!calendar_id) {
    // create 时如果没传 calendar_id，用主日历
    if (action !== 'create') {
      return { success: false, output: '', error: t('feishu.calendar_id_required') }
    }
  }

  const calId = calendar_id || 'primary'

  if (action === 'create') {
    if (!data) {
      return { success: false, output: '', error: t('feishu.calendar_data_required') }
    }
    const eventData: any = {
      summary: data.summary || data.title || 'Untitled',
      start_time: buildFeishuTime(data.start_time as string || data.start as string),
      end_time: buildFeishuTime(data.end_time as string || data.end as string),
    }
    if (data.description) eventData.description = data.description
    if (data.location) eventData.location = { name: data.location }

    const resp = await client.calendar.calendarEvent.create({
      path: { calendar_id: calId },
      data: eventData,
    }, opts)
    const eid = resp?.data?.event?.event_id
    const output = `Event created: ${eventData.summary} (event_id: ${eid})`
    addWriteStep(executor, 'feishu_write', output, output)
    return { success: true, output }
  }

  if (action === 'update') {
    if (!event_id) {
      return { success: false, output: '', error: t('feishu.event_id_required', { action: 'update' }) }
    }
    if (!data) {
      return { success: false, output: '', error: t('feishu.calendar_data_required') }
    }
    const eventData: any = {}
    if (data.summary || data.title) eventData.summary = data.summary || data.title
    if (data.start_time || data.start) eventData.start_time = buildFeishuTime((data.start_time || data.start) as string)
    if (data.end_time || data.end) eventData.end_time = buildFeishuTime((data.end_time || data.end) as string)
    if (data.description) eventData.description = data.description
    if (data.location) eventData.location = { name: data.location }

    await client.calendar.calendarEvent.patch({
      path: { calendar_id: calId, event_id },
      data: eventData,
    }, opts)
    const output = `Event ${event_id} updated`
    addWriteStep(executor, 'feishu_write', output, output)
    return { success: true, output }
  }

  if (action === 'delete') {
    if (!event_id) {
      return { success: false, output: '', error: t('feishu.event_id_required', { action: 'delete' }) }
    }
    await client.calendar.calendarEvent.delete({
      path: { calendar_id: calId, event_id },
    }, opts)
    const output = `Event ${event_id} deleted`
    addWriteStep(executor, 'feishu_write', output, output)
    return { success: true, output }
  }

  return { success: false, output: '', error: t('feishu.unsupported_action', { resource: 'calendar', action }) }
}

// ========================================================================
//  Task（任务）
// ========================================================================

async function readTask(client: any, args: FeishuReadArgs, executor: ToolExecutorConfig): Promise<ToolResult> {
  const { task_id, limit, page_token } = args
  const opts = await getRequestOptions()

  if (task_id) {
    const resp = await client.task.task.get({
      path: { task_id },
    }, opts)
    const task = resp?.data?.task
    if (!task) {
      return { success: false, output: '', error: `Task ${task_id} not found` }
    }
    const output = formatTask(task)
    addReadStep(executor, 'feishu_read', `✅ ${task.summary || '(untitled)'}`, output)
    return { success: true, output }
  }

  const resp = await client.task.task.list({
    params: {
      page_size: Math.min(limit || 20, 100),
      page_token,
    },
  }, opts)
  const tasks = resp?.data?.items || []
  const lines = tasks.map((tk: any) => {
    const status = tk.completed_at ? '✅' : '⬜'
    const due = tk.due?.timestamp ? new Date(Number(tk.due.timestamp) * 1000).toLocaleDateString() : ''
    return `- ${status} **${tk.summary || '(untitled)'}** | task_id: \`${tk.task_id}\`${due ? ` | due: ${due}` : ''}`
  })
  let output = `## ${resourceLabel('task')} list\n\n${lines.join('\n') || t('feishu.no_data')}`
  if (resp?.data?.page_token) {
    output += `\n\n> More available, page_token: \`${resp.data.page_token}\``
  }
  addReadStep(executor, 'feishu_read', `✅ ${tasks.length} task(s)`, output)
  return { success: true, output }
}

async function writeTask(
  client: any, args: FeishuWriteArgs, toolCallId: string, executor: ToolExecutorConfig
): Promise<ToolResult> {
  const { action, task_id, data } = args
  const opts = await getRequestOptions()

  if (action === 'create') {
    if (!data?.summary) {
      return { success: false, output: '', error: t('feishu.task_summary_required') }
    }
    const taskData: any = {
      summary: data.summary,
      origin: {
        platform_i18n_name: 'SailFish',
      },
    }
    if (data.description) taskData.description = data.description
    if (data.due) taskData.due = data.due
    if (data.origin) taskData.origin = data.origin

    const resp = await client.task.task.create({
      data: taskData,
    }, opts)
    const tid = resp?.data?.task?.task_id
    const output = `Task created: ${data.summary} (task_id: ${tid})`
    addWriteStep(executor, 'feishu_write', output, output)
    return { success: true, output }
  }

  if (action === 'update') {
    if (!task_id) {
      return { success: false, output: '', error: t('feishu.task_id_required', { action: 'update' }) }
    }
    if (!data) {
      return { success: false, output: '', error: t('feishu.task_data_required') }
    }
    const taskData: any = {}
    if (data.summary) taskData.summary = data.summary
    if (data.description) taskData.description = data.description
    if (data.due) taskData.due = data.due
    if (data.completed_at) taskData.completed_at = data.completed_at
    if (data.status !== undefined) taskData.status = data.status

    await client.task.task.patch({
      path: { task_id },
      data: taskData,
    }, opts)
    const output = `Task ${task_id} updated`
    addWriteStep(executor, 'feishu_write', output, output)
    return { success: true, output }
  }

  if (action === 'delete') {
    if (!task_id) {
      return { success: false, output: '', error: t('feishu.task_id_required', { action: 'delete' }) }
    }
    await client.task.task.delete({
      path: { task_id },
    }, opts)
    const output = `Task ${task_id} deleted`
    addWriteStep(executor, 'feishu_write', output, output)
    return { success: true, output }
  }

  return { success: false, output: '', error: t('feishu.unsupported_action', { resource: 'task', action }) }
}

// ========================================================================
//  Drive（云空间）
// ========================================================================

async function readDrive(client: any, args: FeishuReadArgs, executor: ToolExecutorConfig): Promise<ToolResult> {
  const { folder_token, file_token, limit, page_token } = args
  const opts = await getRequestOptions()

  if (file_token) {
    const resp = await client.drive.file.get({
      path: { file_token },
    }, opts)
    const file = resp?.data?.file
    if (!file) {
      return { success: false, output: '', error: `File ${file_token} not found` }
    }
    const output = `## File details\n\n- Name: **${file.name}**\n- Type: ${file.type}\n- Size: ${formatFileSize(file.size)}\n- Created: ${formatTimestamp(file.created_time)}\n- Modified: ${formatTimestamp(file.modified_time)}\n- token: \`${file.token}\``
    addReadStep(executor, 'feishu_read', `📁 ${file.name}`, output)
    return { success: true, output }
  }

  const resp = await client.drive.file.list({
    params: {
      folder_token: folder_token || '',
      page_size: Math.min(limit || 50, 200),
      page_token,
      order_by: 'EditedTime',
      direction: 'DESC',
    },
  }, opts)
  const files = resp?.data?.files || []
  const lines = files.map((f: any) => {
    const icon = f.type === 'folder' ? '📁' : '📄'
    return `- ${icon} **${f.name}** (${f.type}, token: \`${f.token}\`, modified: ${formatTimestamp(f.modified_time)})`
  })
  let output = `## ${resourceLabel('drive')} files\n\n${lines.join('\n') || t('feishu.no_data')}`
  if (resp?.data?.page_token) {
    output += `\n\n> More available, page_token: \`${resp.data.page_token}\``
  }
  addReadStep(executor, 'feishu_read', `📁 ${files.length} file(s)`, output)
  return { success: true, output }
}

async function writeDrive(
  client: any, args: FeishuWriteArgs, toolCallId: string, executor: ToolExecutorConfig
): Promise<ToolResult> {
  const { action, file_token, folder_token, parent_token, data, file_path, file_name } = args
  const opts = await getRequestOptions()

  if (action === 'create') {
    const name = (data?.name as string) || 'New Folder'
    const resp = await client.drive.file.createFolder({
      data: {
        name,
        folder_token: parent_token || folder_token || '',
      },
    }, opts)
    const token = resp?.data?.token
    const output = `Folder created: ${name} (token: ${token})`
    addWriteStep(executor, 'feishu_write', output, output)
    return { success: true, output }
  }

  if (action === 'upload') {
    if (!file_path) {
      return { success: false, output: '', error: t('feishu.drive_file_path_required') }
    }
    const resolvedPath = path.resolve(file_path)
    if (!fs.existsSync(resolvedPath)) {
      return { success: false, output: '', error: t('feishu.drive_file_not_found', { path: file_path }) }
    }
    const stat = fs.statSync(resolvedPath)
    const uploadName = file_name || path.basename(resolvedPath)
    const parentFolderToken = parent_token || folder_token || ''

    const fileStream = fs.createReadStream(resolvedPath)
    try {
      const resp = await client.drive.file.uploadAll({
        data: {
          file_name: uploadName,
          parent_type: 'explorer',
          parent_node: parentFolderToken,
          size: stat.size,
          file: fileStream,
        },
      }, opts)
      const fToken = resp?.data?.file_token
      const output = `File uploaded: ${uploadName} (${formatFileSize(stat.size)}, token: ${fToken})`
      addWriteStep(executor, 'feishu_write', output, output)
      return { success: true, output }
    } finally {
      fileStream.destroy()
    }
  }

  if (action === 'delete') {
    if (!file_token) {
      return { success: false, output: '', error: t('feishu.drive_file_token_required') }
    }
    await client.drive.file.delete({
      path: { file_token },
      params: { type: 'file' },
    }, opts)
    const output = `File ${file_token} deleted`
    addWriteStep(executor, 'feishu_write', output, output)
    return { success: true, output }
  }

  if (action === 'update') {
    // 重命名
    if (!file_token || !data?.name) {
      return { success: false, output: '', error: t('feishu.drive_rename_required') }
    }
    await client.request({
      method: 'POST',
      url: `/open-apis/drive/v1/files/${file_token}/rename`,
      data: { name: data.name },
    }, opts)
    const output = `File ${file_token} renamed to: ${data.name}`
    addWriteStep(executor, 'feishu_write', output, output)
    return { success: true, output }
  }

  return { success: false, output: '', error: t('feishu.unsupported_action', { resource: 'drive', action }) }
}

// ========================================================================
//  辅助函数
// ========================================================================

function addReadStep(executor: ToolExecutorConfig, toolName: string, content: string, toolResult: string): void {
  executor.addStep({
    type: 'tool_result',
    content,
    toolName,
    toolResult,
  })
}

function addWriteStep(executor: ToolExecutorConfig, toolName: string, content: string, toolResult: string): void {
  executor.addStep({
    type: 'tool_result',
    content,
    toolName,
    toolResult,
  })
}

function formatCellValue(val: any): string {
  if (val == null) return ''
  if (Array.isArray(val)) {
    // 飞书多维表格的链接、人员等字段是数组
    return val.map(v => {
      if (typeof v === 'object' && v !== null) {
        return v.text || v.name || v.en_name || JSON.stringify(v)
      }
      return String(v)
    }).join(', ')
  }
  if (typeof val === 'object') {
    if (val.text) return val.text
    if (val.link) return val.link
    return JSON.stringify(val)
  }
  return String(val)
}

function extractBlockText(block: any): string {
  if (!block) return ''
  const blockType = block.block_type
  // 文本类 block：page_header(1), text(2), heading1-9(3-11), bullet(12), ordered(13), code(14), quote(15)
  const textTypes = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]
  if (textTypes.includes(blockType)) {
    const elements = block[Object.keys(block).find(k => k !== 'block_id' && k !== 'block_type' && k !== 'parent_id' && k !== 'children') || '']
    if (elements?.elements) {
      return elements.elements.map((e: any) => e?.text_run?.content || '').join('')
    }
  }
  return ''
}

async function appendDocContent(client: any, documentId: string, content: string, opts?: any): Promise<void> {
  await client.docx.documentBlockChildren.create({
    path: { document_id: documentId, block_id: documentId },
    data: {
      children: [{
        block_type: 2,
        text: {
          elements: [{
            text_run: { content },
          }],
        },
      }],
      index: -1,
    },
  }, opts)
}

function buildFeishuTime(timeStr: string): any {
  if (!timeStr) return undefined
  // 支持 ISO 8601 和 Unix 时间戳
  const ts = /^\d+$/.test(timeStr) ? Number(timeStr) : Math.floor(new Date(timeStr).getTime() / 1000)
  return { timestamp: String(ts) }
}

function formatFeishuTime(timeObj: any): string {
  if (!timeObj) return ''
  const ts = timeObj.timestamp ? Number(timeObj.timestamp) * 1000 : (timeObj.date ? new Date(timeObj.date).getTime() : 0)
  if (!ts) return ''
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function formatCalendarEvent(event: any): string {
  const parts: string[] = [`## ${event.summary || '(untitled)'}`]
  if (event.start_time) parts.push(`**Start**: ${formatFeishuTime(event.start_time)}`)
  if (event.end_time) parts.push(`**End**: ${formatFeishuTime(event.end_time)}`)
  if (event.location?.name) parts.push(`**Location**: ${event.location.name}`)
  if (event.description) parts.push(`\n${event.description}`)
  parts.push(`\nevent_id: \`${event.event_id}\``)
  return parts.join('\n')
}

function formatTask(task: any): string {
  const status = task.completed_at ? '✅ completed' : '⬜ in progress'
  const parts: string[] = [`## ${task.summary || '(untitled)'}`]
  parts.push(`**Status**: ${status}`)
  if (task.due?.timestamp) {
    parts.push(`**Due**: ${new Date(Number(task.due.timestamp) * 1000).toLocaleString()}`)
  }
  if (task.description) parts.push(`\n${task.description}`)
  parts.push(`\ntask_id: \`${task.task_id}\``)
  return parts.join('\n')
}

function formatTimestamp(ts: any): string {
  if (!ts) return ''
  const n = typeof ts === 'string' ? Number(ts) : ts
  if (!n) return ''
  return new Date(n * 1000).toLocaleDateString()
}

function formatFileSize(bytes: any): string {
  const b = Number(bytes) || 0
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  return `${(b / 1024 / 1024).toFixed(1)} MB`
}

/**
 * 清理技能会话
 */
export function cleanup(): void {
  closeSession()
}
