/**
 * 钉钉技能执行器
 * 将 dingtalk_read / dingtalk_write 路由到各资源的 API 调用
 *
 * API 模式：
 * - 日历/待办：新 API (api.dingtalk.com/v1.0)，需要 union_id
 * - 通讯录/考勤/审批：旧 API (oapi.dingtalk.com)
 */

import { createLogger } from '../../../../utils/logger'
import { getConfigService } from '../../../config.service'
import { t } from '../../i18n'
import type { ToolResult } from '../../tools/types'
import type { AgentConfig } from '../../tools/types'
import type { ToolExecutorConfig } from '../../tools/types'
import type { DingTalkReadArgs, DingTalkWriteArgs, DingTalkResource } from './types'
import { oapi, api, extractApiError, closeSession } from './session'

const log = createLogger('DingTalkExecutor')

function resourceLabel(resource: DingTalkResource | string): string {
  const key = `dingtalk.resource_${resource}`
  const label = t(key as any)
  return label !== key ? label : resource
}

function actionLabel(action: string): string {
  const key = `dingtalk.action_${action}`
  const label = t(key as any)
  return label !== key ? label : action
}

function getCredentials(): { clientId: string; clientSecret: string } {
  const configService = getConfigService()
  const clientId = configService.get('imDingTalkClientId') as string
  const clientSecret = configService.get('imDingTalkClientSecret') as string
  if (!clientId || !clientSecret) {
    throw new Error(t('dingtalk.credentials_missing' as any))
  }
  return { clientId, clientSecret }
}

export async function executeDingTalkTool(
  toolName: string,
  _ptyId: string,
  args: Record<string, unknown>,
  toolCallId: string,
  config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  try {
    if (toolName === 'dingtalk_read') {
      return await dingtalkRead(args as unknown as DingTalkReadArgs, executor)
    }
    if (toolName === 'dingtalk_write') {
      return await dingtalkWrite(args as unknown as DingTalkWriteArgs, toolCallId, config, executor)
    }
    return { success: false, output: '', error: t('dingtalk.unknown_tool' as any, { name: toolName }) }
  } catch (err: any) {
    const msg = extractApiError(err)
    log.error(`${toolName} failed:`, msg)
    return { success: false, output: '', error: msg }
  }
}

// ==================== dingtalk_read ====================

async function dingtalkRead(args: DingTalkReadArgs, executor: ToolExecutorConfig): Promise<ToolResult> {
  const { resource } = args
  if (!resource) {
    return { success: false, output: '', error: t('dingtalk.missing_resource' as any) }
  }

  const idHint = args.union_id || args.userid || args.process_instance_id || args.task_id || ''
  executor.addStep({
    type: 'tool_call',
    content: t('dingtalk.reading' as any, { resource: resourceLabel(resource), hint: idHint ? ` (${idHint.substring(0, 20)})` : '' }),
    toolName: 'dingtalk_read',
    toolArgs: { resource, ...Object.fromEntries(Object.entries(args).filter(([_, v]) => v !== undefined).slice(0, 4)) },
    riskLevel: 'safe'
  })

  const handlers: Record<DingTalkResource, () => Promise<ToolResult>> = {
    calendar: () => readCalendar(args, executor),
    todo: () => readTodo(args, executor),
    attendance: () => readAttendance(args, executor),
    contact: () => readContact(args, executor),
    approval: () => readApproval(args, executor),
  }

  const handler = handlers[resource]
  if (!handler) {
    return { success: false, output: '', error: t('dingtalk.unsupported_resource' as any, { resource }) }
  }
  return handler()
}

// ==================== dingtalk_write ====================

async function dingtalkWrite(
  args: DingTalkWriteArgs,
  toolCallId: string,
  config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const { resource, action } = args
  if (!resource || !action) {
    return { success: false, output: '', error: t('dingtalk.missing_resource_or_action' as any) }
  }

  executor.addStep({
    type: 'tool_call',
    content: t('dingtalk.writing' as any, { action: actionLabel(action), resource: resourceLabel(resource) }),
    toolName: 'dingtalk_write',
    toolArgs: { resource, action, ...Object.fromEntries(Object.entries(args).filter(([k, v]) => v !== undefined && k !== 'resource' && k !== 'action').slice(0, 3)) },
    riskLevel: action === 'delete' ? 'moderate' : 'safe'
  })

  const handlers: Record<string, () => Promise<ToolResult>> = {
    calendar: () => writeCalendar(args, executor),
    todo: () => writeTodo(args, executor),
    approval: () => writeApproval(args, executor),
  }

  const handler = handlers[resource]
  if (!handler) {
    return { success: false, output: '', error: t('dingtalk.unsupported_resource' as any, { resource }) }
  }
  return handler()
}

// ========================================================================
//  Calendar（日历日程）— 新 API v1.0
// ========================================================================

async function readCalendar(args: DingTalkReadArgs, executor: ToolExecutorConfig): Promise<ToolResult> {
  const { union_id, calendar_id, event_id, start_date, end_date, limit } = args

  if (!union_id) {
    return { success: false, output: '', error: t('dingtalk.union_id_required' as any, { resource: 'calendar' }) }
  }

  const { clientId, clientSecret } = getCredentials()

  // 获取日程详情
  if (event_id && calendar_id) {
    const resp = await api(clientId, clientSecret, 'GET',
      `/v1.0/calendar/users/${union_id}/calendars/${calendar_id}/events/${event_id}`)
    const output = formatEventDetail(resp)
    addReadStep(executor, 'dingtalk_read', `📅 ${resp.summary || '(无标题)'}`, output)
    return { success: true, output }
  }

  // 列出日程
  if (calendar_id) {
    const now = new Date()
    const timeMin = start_date ? new Date(start_date).toISOString() : now.toISOString()
    const endDate = end_date ? new Date(end_date) : new Date(now.getTime() + 7 * 24 * 3600 * 1000)
    const timeMax = endDate.toISOString()
    const maxResults = Math.min(limit || 50, 100)

    const params = new URLSearchParams({ timeMin, timeMax, maxResults: String(maxResults) })
    if (args.cursor) params.set('nextToken', String(args.cursor))

    const resp = await api(clientId, clientSecret, 'GET',
      `/v1.0/calendar/users/${union_id}/calendars/${calendar_id}/events?${params.toString()}`)
    const events = resp?.events || []
    const lines = events.map((e: any) => {
      const start = formatDingTalkTime(e.start)
      const end = formatDingTalkTime(e.end)
      return `- **${e.summary || '(无标题)'}** | ${start} ~ ${end} | event_id: \`${e.id}\``
    })

    let output = `## ${resourceLabel('calendar')} (${start_date || '今天'} ~ ${end_date || '+7天'})\n\n${lines.join('\n') || '（无日程）'}`
    if (resp?.nextToken) {
      output += `\n\n> 还有更多，设置 cursor: \`${resp.nextToken}\` 查看下一页`
    }
    addReadStep(executor, 'dingtalk_read', `📅 ${events.length} 个日程`, output)
    return { success: true, output }
  }

  // 不传 calendar_id → 列出日历
  const resp = await api(clientId, clientSecret, 'GET',
    `/v1.0/calendar/users/${union_id}/calendars`)
  const calendars = resp?.response?.calendars || resp?.calendars || []

  if (Array.isArray(calendars) && calendars.length > 0) {
    const lines = calendars.map((c: any) =>
      `- **${c.summary || c.name || '(无名)'}** (calendar_id: \`${c.id}\`, privilege: ${c.privilege || '-'})`
    )
    const output = `## 钉钉日历列表\n\n${lines.join('\n')}\n\n> 提示：使用 calendar_id: "primary" 表示用户的主日历`
    addReadStep(executor, 'dingtalk_read', `📅 ${calendars.length} 个日历`, output)
    return { success: true, output }
  }

  const output = `## 钉钉日历\n\n未获取到日历列表。\n\n> 提示：直接使用 calendar_id: "primary" 查询主日历上的日程`
  addReadStep(executor, 'dingtalk_read', '📅 日历', output)
  return { success: true, output }
}

async function writeCalendar(args: DingTalkWriteArgs, executor: ToolExecutorConfig): Promise<ToolResult> {
  const { action, union_id, calendar_id, event_id, data } = args

  if (!union_id) {
    return { success: false, output: '', error: t('dingtalk.union_id_required' as any, { resource: 'calendar' }) }
  }

  const calId = calendar_id || 'primary'

  // 参数校验（凭证检查之前）
  if (action === 'create' && !data) {
    return { success: false, output: '', error: t('dingtalk.calendar_data_required' as any) }
  }
  if ((action === 'update' || action === 'delete') && !event_id) {
    return { success: false, output: '', error: t('dingtalk.event_id_required' as any, { action }) }
  }
  if (action === 'update' && !data) {
    return { success: false, output: '', error: t('dingtalk.calendar_data_required' as any) }
  }

  if (action === 'create') {
    const eventData: any = {
      summary: (data!.summary as string) || (data!.title as string) || '新建日程',
    }
    if (data!.start) {
      eventData.start = typeof data!.start === 'object' ? data!.start : { dateTime: toISO(data!.start as string) }
    } else if (data!.start_time) {
      eventData.start = { dateTime: toISO(data!.start_time as string) }
    }
    if (data!.end) {
      eventData.end = typeof data!.end === 'object' ? data!.end : { dateTime: toISO(data!.end as string) }
    } else if (data!.end_time) {
      eventData.end = { dateTime: toISO(data!.end_time as string) }
    }
    if (!eventData.start || !eventData.end) {
      return { success: false, output: '', error: t('dingtalk.calendar_time_required' as any) }
    }

    const { clientId, clientSecret } = getCredentials()

    if (data!.description) eventData.description = data!.description
    if (data!.location) eventData.location = { displayName: data!.location }
    if (data!.attendees && Array.isArray(data!.attendees)) {
      eventData.attendees = (data!.attendees as any[]).map(a =>
        typeof a === 'string' ? { id: a, isOptional: false } : a
      )
    }
    if (data!.is_all_day) eventData.isAllDay = data!.is_all_day

    const resp = await api(clientId, clientSecret, 'POST',
      `/v1.0/calendar/users/${union_id}/calendars/${calId}/events`, eventData)

    const eid = resp?.id || '(unknown)'
    const output = `日程已创建: ${eventData.summary} (event_id: ${eid})`
    addWriteStep(executor, 'dingtalk_write', output, output)
    return { success: true, output }
  }

  const { clientId, clientSecret } = getCredentials()

  if (action === 'update') {
    const eventData: any = {}
    if (data!.summary || data!.title) eventData.summary = data!.summary || data!.title
    if (data!.description) eventData.description = data!.description
    if (data!.start) {
      eventData.start = typeof data!.start === 'object' ? data!.start : { dateTime: toISO(data!.start as string) }
    } else if (data!.start_time) {
      eventData.start = { dateTime: toISO(data!.start_time as string) }
    }
    if (data!.end) {
      eventData.end = typeof data!.end === 'object' ? data!.end : { dateTime: toISO(data!.end as string) }
    } else if (data!.end_time) {
      eventData.end = { dateTime: toISO(data!.end_time as string) }
    }
    if (data!.location) eventData.location = { displayName: data!.location }

    await api(clientId, clientSecret, 'PUT',
      `/v1.0/calendar/users/${union_id}/calendars/${calId}/events/${event_id}`, eventData)
    const output = `日程 ${event_id} 已更新`
    addWriteStep(executor, 'dingtalk_write', output, output)
    return { success: true, output }
  }

  if (action === 'delete') {
    await api(clientId, clientSecret, 'DELETE',
      `/v1.0/calendar/users/${union_id}/calendars/${calId}/events/${event_id}`)
    const output = `日程 ${event_id} 已删除`
    addWriteStep(executor, 'dingtalk_write', output, output)
    return { success: true, output }
  }

  return { success: false, output: '', error: t('dingtalk.unsupported_action' as any, { resource: 'calendar', action }) }
}

// ========================================================================
//  Todo（待办任务）— 新 API v1.0
// ========================================================================

async function readTodo(args: DingTalkReadArgs, executor: ToolExecutorConfig): Promise<ToolResult> {
  const { union_id, task_id, is_done, limit, cursor } = args

  if (!union_id) {
    return { success: false, output: '', error: t('dingtalk.union_id_required' as any, { resource: 'todo' }) }
  }

  const { clientId, clientSecret } = getCredentials()

  // 获取待办详情
  if (task_id) {
    const resp = await api(clientId, clientSecret, 'GET',
      `/v1.0/todo/users/${union_id}/tasks/${task_id}`)
    const output = formatTodoDetail(resp)
    addReadStep(executor, 'dingtalk_read', `✅ ${resp.subject || '(无标题)'}`, output)
    return { success: true, output }
  }

  // 列出待办
  const body: any = {
    nextToken: cursor ? String(cursor) : undefined,
    maxResults: Math.min(limit || 20, 50),
  }
  if (is_done !== undefined) body.isDone = is_done

  const resp = await api(clientId, clientSecret, 'POST',
    `/v1.0/todo/users/${union_id}/org/tasks/query`, body)
  const tasks = resp?.todoCards || resp?.items || []

  if (tasks.length === 0) {
    const output = '无待办任务'
    addReadStep(executor, 'dingtalk_read', output, output)
    return { success: true, output }
  }

  const lines = tasks.map((tk: any) => {
    const status = tk.done || tk.isDone ? '✅' : '⬜'
    const due = tk.dueTime ? new Date(tk.dueTime).toLocaleDateString() : ''
    return `- ${status} **${tk.subject || '(无标题)'}** | task_id: \`${tk.taskId || tk.id}\`${due ? ` | 截止: ${due}` : ''}`
  })

  let output = `## ${resourceLabel('todo')} (${tasks.length})\n\n${lines.join('\n')}`
  if (resp?.nextToken) {
    output += `\n\n> 还有更多，设置 cursor: \`${resp.nextToken}\` 查看下一页`
  }
  addReadStep(executor, 'dingtalk_read', `✅ ${tasks.length} 个待办`, output)
  return { success: true, output }
}

async function writeTodo(args: DingTalkWriteArgs, executor: ToolExecutorConfig): Promise<ToolResult> {
  const { action, union_id, task_id, data } = args

  if (!union_id) {
    return { success: false, output: '', error: t('dingtalk.union_id_required' as any, { resource: 'todo' }) }
  }

  if (action === 'create' && !data?.subject) {
    return { success: false, output: '', error: t('dingtalk.todo_subject_required' as any) }
  }
  if ((action === 'update' || action === 'delete') && !task_id) {
    return { success: false, output: '', error: t('dingtalk.task_id_required' as any, { action }) }
  }
  if (action === 'update' && !data) {
    return { success: false, output: '', error: t('dingtalk.todo_data_required' as any) }
  }

  const { clientId, clientSecret } = getCredentials()

  if (action === 'create') {
    const todoData: any = {
      subject: data!.subject,
      creatorId: union_id,
    }
    if (data!.description) todoData.description = data!.description
    if (data!.due_time) todoData.dueTime = Number(data!.due_time)
    if (data!.priority) todoData.priority = data!.priority
    if (data!.executor_ids && Array.isArray(data!.executor_ids)) {
      todoData.executorIds = data!.executor_ids
    }
    if (data!.participant_ids && Array.isArray(data!.participant_ids)) {
      todoData.participantIds = data!.participant_ids
    }

    const resp = await api(clientId, clientSecret, 'POST',
      `/v1.0/todo/users/${union_id}/tasks`, todoData)
    const tid = resp?.id || resp?.taskId || '(unknown)'
    const output = `待办已创建: ${data!.subject} (task_id: ${tid})`
    addWriteStep(executor, 'dingtalk_write', output, output)
    return { success: true, output }
  }

  if (action === 'update') {
    const todoData: any = {}
    if (data!.subject) todoData.subject = data!.subject
    if (data!.description) todoData.description = data!.description
    if (data!.due_time) todoData.dueTime = Number(data!.due_time)
    if (data!.done !== undefined) todoData.done = data!.done
    if (data!.executor_ids) todoData.executorIds = data!.executor_ids
    if (data!.participant_ids) todoData.participantIds = data!.participant_ids

    await api(clientId, clientSecret, 'PUT',
      `/v1.0/todo/users/${union_id}/tasks/${task_id}`, todoData)
    const output = `待办 ${task_id} 已更新`
    addWriteStep(executor, 'dingtalk_write', output, output)
    return { success: true, output }
  }

  if (action === 'delete') {
    await api(clientId, clientSecret, 'DELETE',
      `/v1.0/todo/users/${union_id}/tasks/${task_id}`)
    const output = `待办 ${task_id} 已删除`
    addWriteStep(executor, 'dingtalk_write', output, output)
    return { success: true, output }
  }

  return { success: false, output: '', error: t('dingtalk.unsupported_action' as any, { resource: 'todo', action }) }
}

// ========================================================================
//  Attendance（考勤打卡）— 旧 API
// ========================================================================

async function readAttendance(args: DingTalkReadArgs, executor: ToolExecutorConfig): Promise<ToolResult> {
  const { userid, start_date, end_date, limit, cursor } = args

  if (!userid) {
    return { success: false, output: '', error: t('dingtalk.attendance_userid_required' as any) }
  }

  const { clientId, clientSecret } = getCredentials()

  const userIds = userid.includes(',') ? userid.split(',').map(s => s.trim()) : [userid]

  const now = new Date()
  const workDateFrom = start_date || formatDate(now)
  const workDateTo = end_date || formatDate(now)

  const resp = await oapi(clientId, clientSecret, 'POST', '/attendance/list', {
    workDateFrom: `${workDateFrom} 00:00:00`,
    workDateTo: `${workDateTo} 23:59:59`,
    userIdList: userIds,
    offset: Number(cursor) || 0,
    limit: Math.min(limit || 50, 50),
  })

  const records = resp?.recordresult || []

  if (records.length === 0) {
    const output = '查询范围内无打卡记录'
    addReadStep(executor, 'dingtalk_read', output, output)
    return { success: true, output }
  }

  let output = `## 打卡记录 (${records.length} 条)\n\n`
  output += '| 用户 | 日期 | 打卡类型 | 打卡时间 | 打卡结果 | 地点 |\n'
  output += '| --- | --- | --- | --- | --- | --- |\n'

  for (const r of records.slice(0, 50)) {
    const date = r.workDate ? new Date(r.workDate).toLocaleDateString() : '-'
    const checkType = r.checkType === 'OnDuty' ? '上班' : r.checkType === 'OffDuty' ? '下班' : (r.checkType || '-')
    const time = r.userCheckTime ? new Date(r.userCheckTime).toLocaleTimeString() : '-'
    const result = formatAttendanceResult(r.timeResult, r.locationResult)
    const location = r.userAddress || '-'
    output += `| ${r.userId} | ${date} | ${checkType} | ${time} | ${result} | ${location} |\n`
  }

  if (resp?.hasMore) {
    output += `\n> 还有更多记录，设置 cursor: ${(Number(cursor) || 0) + records.length} 查看下一页`
  }

  addReadStep(executor, 'dingtalk_read', `⏰ ${records.length} 条打卡记录`, output)
  return { success: true, output }
}

// ========================================================================
//  Contact（通讯录）— 旧 API
// ========================================================================

async function readContact(args: DingTalkReadArgs, executor: ToolExecutorConfig): Promise<ToolResult> {
  const { clientId, clientSecret } = getCredentials()
  const { userid, department_id, cursor, limit } = args

  // 获取用户详情
  if (userid) {
    const resp = await oapi(clientId, clientSecret, 'POST', '/topapi/v2/user/get', { userid })
    const user = resp?.result
    if (!user) {
      return { success: false, output: '', error: `用户 ${userid} 不存在` }
    }
    const output = formatUserDetail(user)
    addReadStep(executor, 'dingtalk_read', `👤 ${user.name || userid}`, output)
    return { success: true, output }
  }

  // 获取部门成员
  if (department_id) {
    const resp = await oapi(clientId, clientSecret, 'POST', '/topapi/v2/user/list', {
      dept_id: department_id,
      cursor: Number(cursor) || 0,
      size: Math.min(limit || 20, 100),
    })
    const users = resp?.result?.list || []
    const lines = users.map((u: any) =>
      `- **${u.name}** (userid: \`${u.userid}\`, unionid: \`${u.unionid || '-'}\`, 职位: ${u.title || '-'})`
    )
    let output = `## 部门成员 (${users.length})\n\n${lines.join('\n') || '（无成员）'}`
    if (resp?.result?.has_more) {
      output += `\n\n> 还有更多，设置 cursor: ${resp.result.next_cursor} 查看下一页`
    }
    addReadStep(executor, 'dingtalk_read', `👥 ${users.length} 个成员`, output)
    return { success: true, output }
  }

  // 列出部门
  const resp = await oapi(clientId, clientSecret, 'POST', '/topapi/v2/department/listsub', {
    dept_id: 1,
  })
  const depts = resp?.result || []

  if (Array.isArray(depts) && depts.length > 0) {
    const lines = depts.map((d: any) =>
      `- **${d.name}** (dept_id: ${d.dept_id}, 上级: ${d.parent_id})`
    )
    const output = `## 部门列表 (${depts.length})\n\n${lines.join('\n')}\n\n> 提示：传入 department_id 可查看部门成员列表（含 unionid）`
    addReadStep(executor, 'dingtalk_read', `🏢 ${depts.length} 个部门`, output)
    return { success: true, output }
  }

  const output = '未获取到部门信息。可能需要在钉钉开发者后台为该应用开通通讯录读取权限。'
  addReadStep(executor, 'dingtalk_read', output, output)
  return { success: true, output }
}

// ========================================================================
//  Approval（审批流程）— 旧 API
// ========================================================================

async function readApproval(args: DingTalkReadArgs, executor: ToolExecutorConfig): Promise<ToolResult> {
  const { process_instance_id, process_code, start_date, end_date, limit, cursor } = args

  if (!process_instance_id && !process_code) {
    return { success: false, output: '', error: t('dingtalk.process_code_required' as any) }
  }

  const { clientId, clientSecret } = getCredentials()

  // 获取审批实例详情
  if (process_instance_id) {
    const resp = await oapi(clientId, clientSecret, 'POST', '/topapi/processinstance/get', {
      process_instance_id,
    })
    const info = resp?.process_instance
    if (!info) {
      return { success: false, output: '', error: `审批实例 ${process_instance_id} 不存在` }
    }
    const output = formatApprovalDetail(info, process_instance_id)
    addReadStep(executor, 'dingtalk_read', `📋 审批 ${process_instance_id.substring(0, 12)}...`, output)
    return { success: true, output }
  }

  const now = new Date()
  const startTime = start_date
    ? new Date(start_date).getTime()
    : now.getTime() - 30 * 24 * 3600 * 1000
  const endTime = end_date
    ? new Date(end_date).getTime()
    : undefined

  const body: any = {
    process_code,
    start_time: startTime,
    size: Math.min(limit || 10, 20),
    cursor: Number(cursor) || 0,
  }
  if (endTime) body.end_time = endTime

  const resp = await oapi(clientId, clientSecret, 'POST', '/topapi/processinstance/listids', body)
  const instanceIds = resp?.result?.list || []

  if (instanceIds.length === 0) {
    const output = '查询范围内无审批记录'
    addReadStep(executor, 'dingtalk_read', output, output)
    return { success: true, output }
  }

  // 批量获取详情（最多 10 条）
  const details: any[] = []
  for (const id of instanceIds.slice(0, 10)) {
    try {
      const detailResp = await oapi(clientId, clientSecret, 'POST', '/topapi/processinstance/get', {
        process_instance_id: id,
      })
      if (detailResp?.process_instance) {
        details.push({ ...detailResp.process_instance, _id: id })
      }
    } catch { /* skip failed */ }
  }

  let output = `## 审批记录 (${details.length}/${instanceIds.length})\n\n`
  for (const info of details) {
    const status = formatApprovalStatus(info.status, info.result)
    const applicant = info.originator_userid || '(unknown)'
    const title = info.title || '(未命名)'
    const time = info.create_time || ''
    output += `- ${status} **${title}** | 发起人: ${applicant} | ${time} | id: \`${info._id}\`\n`
  }

  if (resp?.result?.next_cursor !== undefined) {
    output += `\n> 还有更多，设置 cursor: ${resp.result.next_cursor} 查看下一页`
  }

  addReadStep(executor, 'dingtalk_read', `📋 ${details.length} 条审批`, output)
  return { success: true, output }
}

async function writeApproval(args: DingTalkWriteArgs, executor: ToolExecutorConfig): Promise<ToolResult> {
  const { action, process_code, data } = args

  if (action !== 'create') {
    return { success: false, output: '', error: t('dingtalk.unsupported_action' as any, { resource: 'approval', action }) }
  }

  const code = process_code || (data?.process_code as string)
  if (!code) {
    return { success: false, output: '', error: t('dingtalk.process_code_required' as any) }
  }

  const originatorUserId = (data?.originator_user_id as string) || (data?.userid as string)
  if (!originatorUserId) {
    return { success: false, output: '', error: t('dingtalk.approval_originator_required' as any) }
  }

  const { clientId, clientSecret } = getCredentials()

  const body: any = {
    process_code: code,
    originator_user_id: originatorUserId,
  }

  if (data?.dept_id) body.dept_id = Number(data.dept_id)
  if (data?.form_component_values) body.form_component_values = data.form_component_values
  if (data?.approvers) body.approvers = data.approvers
  if (data?.cc_list) body.cc_list = data.cc_list

  const resp = await oapi(clientId, clientSecret, 'POST', '/topapi/processinstance/create', body)
  const instanceId = resp?.process_instance_id || '(unknown)'
  const output = `审批申请已提交 (instance_id: ${instanceId})`
  addWriteStep(executor, 'dingtalk_write', output, output)
  return { success: true, output }
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

function toISO(timeStr: string): string {
  if (!timeStr) return ''
  if (timeStr.includes('T')) return timeStr
  return new Date(timeStr).toISOString()
}

function formatDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function formatDingTalkTime(timeObj: any): string {
  if (!timeObj) return ''
  if (timeObj.dateTime) {
    const d = new Date(timeObj.dateTime)
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  if (timeObj.date) return timeObj.date
  return ''
}

function formatEventDetail(event: any): string {
  const parts: string[] = [`## ${event.summary || '(无标题)'}`]
  if (event.start) parts.push(`**开始**: ${formatDingTalkTime(event.start)}`)
  if (event.end) parts.push(`**结束**: ${formatDingTalkTime(event.end)}`)
  if (event.location?.displayName) parts.push(`**地点**: ${event.location.displayName}`)
  if (event.description) parts.push(`\n${event.description}`)
  if (event.attendees?.length) {
    const names = event.attendees.map((a: any) => a.displayName || a.id || '(unknown)').join(', ')
    parts.push(`**参与者**: ${names}`)
  }
  parts.push(`\nevent_id: \`${event.id}\``)
  return parts.join('\n')
}

function formatTodoDetail(todo: any): string {
  const status = (todo.done || todo.isDone) ? '✅ 已完成' : '⬜ 进行中'
  const parts: string[] = [`## ${todo.subject || '(无标题)'}`]
  parts.push(`**状态**: ${status}`)
  if (todo.dueTime) parts.push(`**截止**: ${new Date(todo.dueTime).toLocaleString()}`)
  if (todo.priority) parts.push(`**优先级**: ${formatPriority(todo.priority)}`)
  if (todo.description) parts.push(`\n${todo.description}`)
  parts.push(`\ntask_id: \`${todo.taskId || todo.id}\``)
  if (todo.creatorId) parts.push(`creator: \`${todo.creatorId}\``)
  return parts.join('\n')
}

function formatPriority(p: any): string {
  const map: Record<number, string> = { 10: '较低', 20: '普通', 30: '紧急', 40: '非常紧急' }
  return map[p] || String(p)
}

function formatUserDetail(user: any): string {
  const parts: string[] = [`## ${user.name || '(未命名)'}`]
  parts.push(`**UserID**: \`${user.userid}\``)
  if (user.unionid) parts.push(`**UnionID**: \`${user.unionid}\``)
  if (user.dept_id_list?.length) parts.push(`**部门**: ${user.dept_id_list.join(' / ')}`)
  if (user.title) parts.push(`**职位**: ${user.title}`)
  if (user.mobile) parts.push(`**手机**: ${user.mobile}`)
  if (user.email) parts.push(`**邮箱**: ${user.email}`)
  if (user.job_number) parts.push(`**工号**: ${user.job_number}`)
  if (user.work_place) parts.push(`**办公地点**: ${user.work_place}`)
  if (user.hired_date) parts.push(`**入职日期**: ${new Date(user.hired_date).toLocaleDateString()}`)
  if (user.active !== undefined) parts.push(`**状态**: ${user.active ? '在职' : '离职'}`)
  return parts.join('\n')
}

function formatAttendanceResult(timeResult: string, locationResult: string): string {
  const timeMap: Record<string, string> = {
    Normal: '正常', Early: '早退', Late: '迟到', SeriousLate: '严重迟到',
    Absenteeism: '旷工', NotSigned: '未打卡',
  }
  const locMap: Record<string, string> = {
    Normal: '正常', Outside: '范围外', NotSigned: '未打卡',
  }
  const t = timeMap[timeResult] || timeResult || '-'
  const l = locMap[locationResult] || locationResult || ''
  return l && l !== '正常' ? `${t}(${l})` : t
}

function formatApprovalStatus(status: string, result: string): string {
  if (status === 'NEW') return '⏳ 审批中'
  if (status === 'RUNNING') return '⏳ 审批中'
  if (status === 'TERMINATED') return '⏹️ 已终止'
  if (status === 'COMPLETED') {
    if (result === 'agree') return '✅ 已通过'
    if (result === 'refuse') return '❌ 已拒绝'
    return '✅ 已完成'
  }
  if (status === 'CANCELED') return '↩️ 已撤销'
  return `状态: ${status}`
}

function formatApprovalDetail(info: any, instanceId: string): string {
  const status = formatApprovalStatus(info.status, info.result)
  const parts: string[] = [`## ${info.title || '(未命名审批)'}`]
  parts.push(`**状态**: ${status}`)
  parts.push(`**实例ID**: \`${instanceId}\``)
  if (info.originator_userid) parts.push(`**发起人**: ${info.originator_userid}`)
  if (info.create_time) parts.push(`**发起时间**: ${info.create_time}`)
  if (info.finish_time) parts.push(`**完成时间**: ${info.finish_time}`)

  // 表单内容
  const formValues = info.form_component_values || []
  if (formValues.length > 0) {
    parts.push('\n### 表单内容')
    for (const item of formValues) {
      parts.push(`- **${item.name || item.id || '(未命名)'}**: ${item.value || '(空)'}`)
    }
  }

  // 审批流程
  const tasks = info.operation_records || []
  if (tasks.length > 0) {
    parts.push('\n### 审批流程')
    for (const op of tasks) {
      const opResult = op.result === 'AGREE' ? '同意' : op.result === 'REFUSE' ? '拒绝' : (op.result || '待审批')
      parts.push(`- ${opResult}: ${op.userid || '(unknown)'}${op.date ? ` (${op.date})` : ''}${op.remark ? ` — ${op.remark}` : ''}`)
    }
  }

  return parts.join('\n')
}

/**
 * 清理技能会话
 */
export function cleanup(): void {
  closeSession()
}
