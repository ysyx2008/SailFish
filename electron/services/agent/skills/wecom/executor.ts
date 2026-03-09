/**
 * 企业微信技能执行器
 * 将 wecom_read / wecom_write 路由到各资源的 API 调用
 */

import { createLogger } from '../../../../utils/logger'
import { getConfigService } from '../../../config.service'
import { t } from '../../i18n'
import type { ToolResult, AgentConfig, ToolExecutorConfig } from '../../tools/types'
import type { WeComReadArgs, WeComWriteArgs, WeComResource } from './types'
import { apiPost, apiGet, extractApiError, closeSession } from './session'

const log = createLogger('WeComExecutor')

function resourceLabel(resource: WeComResource | string): string {
  const key = `wecom.resource_${resource}`
  const label = t(key as any)
  return label !== key ? label : resource
}

function actionLabel(action: string): string {
  const key = `wecom.action_${action}`
  const label = t(key as any)
  return label !== key ? label : action
}

function getCredentials(): { corpId: string; corpSecret: string; agentId: number } {
  const configService = getConfigService()
  const corpId = configService.get('imWeComCorpId') as string
  const corpSecret = configService.get('imWeComCorpSecret') as string
  const agentId = configService.get('imWeComAgentId') as number
  if (!corpId || !corpSecret) {
    throw new Error(t('wecom.credentials_missing' as any))
  }
  return { corpId, corpSecret, agentId }
}

export async function executeWeComTool(
  toolName: string,
  _ptyId: string,
  args: Record<string, unknown>,
  toolCallId: string,
  config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  try {
    if (toolName === 'wecom_read') {
      return await wecomRead(args as unknown as WeComReadArgs, executor)
    }
    if (toolName === 'wecom_write') {
      return await wecomWrite(args as unknown as WeComWriteArgs, toolCallId, config, executor)
    }
    return { success: false, output: '', error: t('wecom.unknown_tool' as any, { name: toolName }) }
  } catch (err: any) {
    const msg = extractApiError(err)
    log.error(`${toolName} failed:`, msg)
    return { success: false, output: '', error: msg }
  }
}

// ==================== wecom_read ====================

async function wecomRead(args: WeComReadArgs, executor: ToolExecutorConfig): Promise<ToolResult> {
  const { resource } = args
  if (!resource) {
    return { success: false, output: '', error: t('wecom.missing_resource' as any) }
  }

  const idHint = args.calendar_id || args.sp_no || args.userid || args.template_id || ''
  executor.addStep({
    type: 'tool_call',
    content: t('wecom.reading' as any, { resource: resourceLabel(resource), hint: idHint ? ` (${idHint.substring(0, 20)})` : '' }),
    toolName: 'wecom_read',
    toolArgs: { resource, ...Object.fromEntries(Object.entries(args).filter(([_, v]) => v !== undefined).slice(0, 4)) },
    riskLevel: 'safe'
  })

  const handlers: Record<WeComResource, () => Promise<ToolResult>> = {
    calendar: () => readCalendar(args, executor),
    approval: () => readApproval(args, executor),
    checkin: () => readCheckin(args, executor),
    contact: () => readContact(args, executor),
  }

  const handler = handlers[resource]
  if (!handler) {
    return { success: false, output: '', error: t('wecom.unsupported_resource' as any, { resource }) }
  }
  return handler()
}

// ==================== wecom_write ====================

async function wecomWrite(
  args: WeComWriteArgs,
  toolCallId: string,
  config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const { resource, action } = args
  if (!resource || !action) {
    return { success: false, output: '', error: t('wecom.missing_resource_or_action' as any) }
  }

  executor.addStep({
    type: 'tool_call',
    content: t('wecom.writing' as any, { action: actionLabel(action), resource: resourceLabel(resource) }),
    toolName: 'wecom_write',
    toolArgs: { resource, action, ...Object.fromEntries(Object.entries(args).filter(([k, v]) => v !== undefined && k !== 'resource' && k !== 'action').slice(0, 3)) },
    riskLevel: action === 'delete' ? 'moderate' : 'safe'
  })

  const handlers: Record<string, () => Promise<ToolResult>> = {
    calendar: () => writeCalendar(args, executor),
    approval: () => writeApproval(args, executor),
  }

  const handler = handlers[resource]
  if (!handler) {
    return { success: false, output: '', error: t('wecom.unsupported_resource' as any, { resource }) }
  }
  return handler()
}

// ========================================================================
//  Calendar（日历 + 日程）
// ========================================================================

async function readCalendar(args: WeComReadArgs, executor: ToolExecutorConfig): Promise<ToolResult> {
  const { corpId, corpSecret } = getCredentials()
  const { calendar_id, event_id, start_date, end_date, limit } = args

  // 获取单个日程详情
  if (event_id) {
    const resp = await apiPost(corpId, corpSecret, '/oa/schedule/get', {
      schedule_id_list: [event_id],
    })
    const schedules = resp?.schedule_list || []
    if (schedules.length === 0) {
      return { success: false, output: '', error: `日程 ${event_id} 不存在` }
    }
    const output = formatScheduleDetail(schedules[0])
    addReadStep(executor, 'wecom_read', `📅 ${schedules[0].summary || '(无标题)'}`, output)
    return { success: true, output }
  }

  // 获取日历下的日程列表
  if (calendar_id) {
    const resp = await apiPost(corpId, corpSecret, '/oa/schedule/get_by_calendar', {
      cal_id: calendar_id,
      offset: args.cursor || 0,
      limit: Math.min(limit || 50, 500),
    })
    const schedules = resp?.schedule_list || []
    const lines = schedules.map((s: any) => {
      const start = formatTs(s.start_time)
      const end = formatTs(s.end_time)
      return `- **${s.summary || '(无标题)'}** | ${start} ~ ${end} | schedule_id: \`${s.schedule_id}\``
    })
    let output = `## 日历日程列表\n\n${lines.join('\n') || '（无日程）'}`
    if (schedules.length === (limit || 50)) {
      output += `\n\n> 可能还有更多，设置 cursor: ${(args.cursor || 0) + schedules.length} 查看下一页`
    }
    addReadStep(executor, 'wecom_read', `📅 ${schedules.length} 个日程`, output)
    return { success: true, output }
  }

  // 不传 calendar_id → 列出日历
  // 企微没有"列出所有日历"的 API，但可以通过 calendar/get 获取指定日历
  // 这里返回使用提示
  const output = `## 企业微信日历

企业微信日历 API 需要指定 calendar_id 才能查询日程。

**获取 calendar_id 的方式**：
1. 如果已知日历 ID，直接传入 calendar_id 查询日程
2. 创建新日历时会返回 calendar_id
3. 不传 calendar_id 可以直接创建日程（会使用默认日历）

**建议操作**：
- 查询日程：传入 calendar_id 和可选的时间范围
- 创建日程：使用 wecom_write calendar create
- 获取日程详情：传入 event_id（即 schedule_id）`

  addReadStep(executor, 'wecom_read', '📅 日历使用说明', output)
  return { success: true, output }
}

async function writeCalendar(args: WeComWriteArgs, executor: ToolExecutorConfig): Promise<ToolResult> {
  const { corpId, corpSecret, agentId } = getCredentials()
  const { action, calendar_id, event_id, data } = args

  if (action === 'create') {
    if (!data) {
      return { success: false, output: '', error: t('wecom.calendar_data_required' as any) }
    }

    const schedule: any = {
      summary: (data.summary as string) || (data.title as string) || '新建日程',
      start_time: parseToUnixTs(data.start_time as string || data.start as string),
      end_time: parseToUnixTs(data.end_time as string || data.end as string),
    }

    if (!schedule.start_time || !schedule.end_time) {
      return { success: false, output: '', error: t('wecom.calendar_time_required' as any) }
    }

    if (data.description) schedule.description = data.description
    if (data.location) schedule.location = data.location
    if (calendar_id || data.cal_id) schedule.cal_id = calendar_id || data.cal_id

    if (data.attendees) {
      const attendees = data.attendees as string[]
      schedule.attendees = attendees.map(uid => ({ userid: uid }))
    }

    if (data.reminders || data.remind_before_secs) {
      schedule.reminders = data.reminders || {
        is_remind: 1,
        remind_before_event_secs: (data.remind_before_secs as number) || 900,
      }
    }

    const resp = await apiPost(corpId, corpSecret, '/oa/schedule/add', {
      schedule,
      agentid: agentId || undefined,
    })

    const scheduleId = resp?.schedule_id || '(unknown)'
    const output = `日程已创建: ${schedule.summary} (schedule_id: ${scheduleId})`
    addWriteStep(executor, 'wecom_write', output, output)
    return { success: true, output }
  }

  if (action === 'update') {
    if (!event_id) {
      return { success: false, output: '', error: t('wecom.event_id_required' as any, { action: 'update' }) }
    }
    if (!data) {
      return { success: false, output: '', error: t('wecom.calendar_data_required' as any) }
    }

    const schedule: any = { schedule_id: event_id }
    if (data.summary || data.title) schedule.summary = data.summary || data.title
    if (data.start_time || data.start) schedule.start_time = parseToUnixTs((data.start_time || data.start) as string)
    if (data.end_time || data.end) schedule.end_time = parseToUnixTs((data.end_time || data.end) as string)
    if (data.description !== undefined) schedule.description = data.description
    if (data.location !== undefined) schedule.location = data.location

    if (data.attendees) {
      const attendees = data.attendees as string[]
      schedule.attendees = attendees.map(uid => ({ userid: uid }))
    }

    if (!schedule.start_time || !schedule.end_time) {
      try {
        const current = await apiPost(corpId, corpSecret, '/oa/schedule/get', { schedule_id_list: [event_id] })
        const existing = current?.schedule_list?.[0]
        if (existing) {
          if (!schedule.start_time) schedule.start_time = existing.start_time
          if (!schedule.end_time) schedule.end_time = existing.end_time
        }
      } catch {
        return { success: false, output: '', error: 'calendar update 需要 start_time 和 end_time（企微 API 强制要求），且无法自动获取当前日程信息，请手动传入' }
      }
    }

    await apiPost(corpId, corpSecret, '/oa/schedule/update', { schedule })
    const output = `日程 ${event_id} 已更新`
    addWriteStep(executor, 'wecom_write', output, output)
    return { success: true, output }
  }

  if (action === 'delete') {
    if (!event_id) {
      return { success: false, output: '', error: t('wecom.event_id_required' as any, { action: 'delete' }) }
    }
    await apiPost(corpId, corpSecret, '/oa/schedule/del', { schedule_id: event_id })
    const output = `日程 ${event_id} 已取消`
    addWriteStep(executor, 'wecom_write', output, output)
    return { success: true, output }
  }

  return { success: false, output: '', error: t('wecom.unsupported_action' as any, { resource: 'calendar', action }) }
}

// ========================================================================
//  Approval（审批）
// ========================================================================

async function readApproval(args: WeComReadArgs, executor: ToolExecutorConfig): Promise<ToolResult> {
  const { corpId, corpSecret } = getCredentials()
  const { sp_no, template_id, sp_status, start_date, end_date, limit, cursor } = args

  // 获取审批详情
  if (sp_no) {
    const resp = await apiPost(corpId, corpSecret, '/oa/getapprovaldetail', { sp_no })
    const info = resp?.info
    if (!info) {
      return { success: false, output: '', error: `审批单 ${sp_no} 不存在` }
    }
    const output = formatApprovalDetail(info)
    addReadStep(executor, 'wecom_read', `📋 审批 ${sp_no}`, output)
    return { success: true, output }
  }

  // 获取审批模板详情
  if (template_id && !start_date) {
    const resp = await apiPost(corpId, corpSecret, '/oa/gettemplatedetail', { template_id })
    const tpl = resp?.template_names || []
    const controls = resp?.template_content?.controls || []
    const name = tpl.length > 0 ? tpl[0].text : template_id
    const lines = controls.map((c: any) => {
      const ctrlName = c.property?.title?.[0]?.text || c.property?.id || '(未命名)'
      return `- **${ctrlName}** (control: \`${c.property?.control}\`, id: \`${c.property?.id}\`)`
    })
    const output = `## 审批模板: ${name}\n\ntemplate_id: \`${template_id}\`\n\n### 控件列表\n${lines.join('\n') || '（无控件）'}`
    addReadStep(executor, 'wecom_read', `📋 模板 ${name}`, output)
    return { success: true, output }
  }

  // 列出审批记录
  const now = new Date()
  const startTs = start_date ? Math.floor(new Date(start_date).getTime() / 1000) : Math.floor((now.getTime() - 30 * 24 * 3600 * 1000) / 1000)
  const endTs = end_date ? Math.floor(new Date(end_date).getTime() / 1000) : Math.floor(now.getTime() / 1000)

  const body: any = {
    starttime: String(startTs),
    endtime: String(endTs),
    cursor: cursor || 0,
    size: Math.min(limit || 20, 100),
  }

  const filters: any[] = []
  if (template_id) filters.push({ key: 'template_id', value: template_id })
  if (sp_status !== undefined) filters.push({ key: 'sp_status', value: String(sp_status) })
  if (filters.length > 0) body.filters = filters

  const resp = await apiPost(corpId, corpSecret, '/oa/getapprovalinfo', body)
  const spNoList = resp?.sp_no_list || []
  const total = resp?.total || spNoList.length

  if (spNoList.length === 0) {
    const output = '查询范围内无审批记录'
    addReadStep(executor, 'wecom_read', output, output)
    return { success: true, output }
  }

  // 批量获取详情（最多 10 条）
  const details: any[] = []
  for (const no of spNoList.slice(0, 10)) {
    try {
      const detailResp = await apiPost(corpId, corpSecret, '/oa/getapprovaldetail', { sp_no: no })
      if (detailResp?.info) details.push(detailResp.info)
    } catch { /* skip failed */ }
  }

  let output = `## 审批记录 (${details.length}/${total})\n\n`
  for (const info of details) {
    const status = formatSpStatus(info.sp_status)
    const applicant = info.applyer?.userid || '(unknown)'
    const name = info.sp_name || '(未命名)'
    const time = formatTs(info.apply_time)
    output += `- ${status} **${name}** | 申请人: ${applicant} | ${time} | sp_no: \`${info.sp_no}\`\n`
  }

  const nextCursor = resp?.next_cursor
  if (total > 10 || nextCursor) {
    output += `\n> 共 ${total} 条记录，当前显示前 10 条${nextCursor ? `。传入 cursor: ${nextCursor} 查看下一页` : ''}`
  }

  addReadStep(executor, 'wecom_read', `📋 ${details.length}/${total} 条审批`, output)
  return { success: true, output }
}

async function writeApproval(args: WeComWriteArgs, executor: ToolExecutorConfig): Promise<ToolResult> {
  const { corpId, corpSecret } = getCredentials()
  const { action, data } = args

  if (action !== 'create') {
    return { success: false, output: '', error: t('wecom.unsupported_action' as any, { resource: 'approval', action }) }
  }

  if (!data?.template_id && !args.template_id) {
    return { success: false, output: '', error: t('wecom.approval_template_required' as any) }
  }

  const body: any = {
    creator_userid: data.creator_userid || data.userid,
    template_id: args.template_id || data.template_id,
    use_template_approver: data.use_template_approver ?? 1,
  }

  if (!body.creator_userid) {
    return { success: false, output: '', error: t('wecom.approval_creator_required' as any) }
  }

  if (data.apply_data) body.apply_data = data.apply_data
  if (data.approver) body.approver = data.approver
  if (data.summary_list) body.summary_list = data.summary_list
  if (data.notifyer) body.notifyer = data.notifyer

  const resp = await apiPost(corpId, corpSecret, '/oa/applyevent', body)
  const spNo = resp?.sp_no || '(unknown)'
  const output = `审批申请已提交 (sp_no: ${spNo})`
  addWriteStep(executor, 'wecom_write', output, output)
  return { success: true, output }
}

// ========================================================================
//  Checkin（考勤打卡）
// ========================================================================

async function readCheckin(args: WeComReadArgs, executor: ToolExecutorConfig): Promise<ToolResult> {
  const { corpId, corpSecret } = getCredentials()
  const { userid, start_date, end_date } = args

  if (!userid) {
    return { success: false, output: '', error: t('wecom.checkin_userid_required' as any) }
  }

  const now = new Date()
  const startTs = start_date
    ? Math.floor(new Date(start_date).getTime() / 1000)
    : Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000)
  const endTs = end_date
    ? Math.floor(new Date(end_date).getTime() / 1000)
    : Math.floor(now.getTime() / 1000)

  const userids = userid.includes(',') ? userid.split(',').map(s => s.trim()) : [userid]

  const resp = await apiPost(corpId, corpSecret, '/checkin/getcheckindata', {
    opencheckindatatype: 3,
    starttime: startTs,
    endtime: endTs,
    useridlist: userids,
  })

  const records = resp?.checkindata || []

  if (records.length === 0) {
    const output = '查询范围内无打卡记录'
    addReadStep(executor, 'wecom_read', output, output)
    return { success: true, output }
  }

  let output = `## 打卡记录 (${records.length} 条)\n\n`
  output += '| 用户 | 时间 | 类型 | 地点 | 异常 |\n'
  output += '| --- | --- | --- | --- | --- |\n'

  for (const r of records.slice(0, 50)) {
    const time = formatTs(r.checkin_time)
    const type = r.checkin_type === '上班打卡' ? '上班' : r.checkin_type === '下班打卡' ? '下班' : (r.checkin_type || '-')
    const location = r.location_title || '-'
    const exception = r.exception_type || '正常'
    output += `| ${r.userid} | ${time} | ${type} | ${location} | ${exception} |\n`
  }

  if (records.length > 50) {
    output += `\n> 共 ${records.length} 条记录，显示前 50 条`
  }

  addReadStep(executor, 'wecom_read', `⏰ ${records.length} 条打卡记录`, output)
  return { success: true, output }
}

// ========================================================================
//  Contact（通讯录）
// ========================================================================

async function readContact(args: WeComReadArgs, executor: ToolExecutorConfig): Promise<ToolResult> {
  const { corpId, corpSecret } = getCredentials()
  const { userid, department_id } = args

  // 获取用户详情
  if (userid) {
    const resp = await apiGet(corpId, corpSecret, '/user/get', { userid })
    const output = formatUserDetail(resp)
    addReadStep(executor, 'wecom_read', `👤 ${resp.name || userid}`, output)
    return { success: true, output }
  }

  // 获取部门成员
  if (department_id) {
    const resp = await apiGet(corpId, corpSecret, '/user/simplelist', {
      department_id: String(department_id),
    })
    const users = resp?.userlist || []
    const lines = users.map((u: any) =>
      `- **${u.name}** (userid: \`${u.userid}\`, 部门: ${(u.department || []).join('/')})`
    )
    const output = `## 部门成员 (${users.length})\n\n${lines.join('\n') || '（无成员）'}`
    addReadStep(executor, 'wecom_read', `👥 ${users.length} 个成员`, output)
    return { success: true, output }
  }

  // 列出部门（department/list 返回完整部门信息）
  const resp = await apiGet(corpId, corpSecret, '/department/list')
  const depts = resp?.department || []

  if (Array.isArray(depts) && depts.length > 0) {
    const lines = depts.map((d: any) =>
      `- **${d.name || `部门${d.id}`}** (id: ${d.id}, 上级: ${d.parentid || '-'})`
    )
    const output = `## 部门列表 (${depts.length})\n\n${lines.join('\n')}`
    addReadStep(executor, 'wecom_read', `🏢 ${depts.length} 个部门`, output)
    return { success: true, output }
  }

  const output = '未获取到部门信息。可能需要在企业微信管理后台为该应用开通通讯录读取权限。'
  addReadStep(executor, 'wecom_read', output, output)
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

function parseToUnixTs(timeStr: string | undefined): number | undefined {
  if (!timeStr) return undefined
  if (/^\d+$/.test(timeStr)) return Number(timeStr)
  const ts = new Date(timeStr).getTime()
  if (isNaN(ts)) return undefined
  return Math.floor(ts / 1000)
}

function formatTs(ts: any): string {
  if (!ts) return ''
  const n = typeof ts === 'string' ? Number(ts) : ts
  if (!n || isNaN(n)) return ''
  const d = new Date(n * 1000)
  const month = d.getMonth() + 1
  const day = d.getDate()
  const hours = String(d.getHours()).padStart(2, '0')
  const mins = String(d.getMinutes()).padStart(2, '0')
  return `${month}/${day} ${hours}:${mins}`
}

function formatScheduleDetail(schedule: any): string {
  const parts: string[] = [`## ${schedule.summary || '(无标题)'}`]
  if (schedule.start_time) parts.push(`**开始**: ${formatTs(schedule.start_time)}`)
  if (schedule.end_time) parts.push(`**结束**: ${formatTs(schedule.end_time)}`)
  if (schedule.location) parts.push(`**地点**: ${schedule.location}`)
  if (schedule.description) parts.push(`\n${schedule.description}`)

  if (schedule.attendees?.length) {
    const names = schedule.attendees.map((a: any) => a.userid).join(', ')
    parts.push(`**参与者**: ${names}`)
  }

  parts.push(`\nschedule_id: \`${schedule.schedule_id}\``)
  if (schedule.cal_id) parts.push(`calendar_id: \`${schedule.cal_id}\``)
  return parts.join('\n')
}

function formatSpStatus(status: number): string {
  const map: Record<number, string> = {
    1: '⏳ 审批中',
    2: '✅ 已通过',
    3: '❌ 已驳回',
    4: '↩️ 已撤销',
    6: '🔄 通过后撤销',
    7: '🗑️ 已删除',
    10: '💰 已支付',
  }
  return map[status] || `状态${status}`
}

function formatApprovalDetail(info: any): string {
  const status = formatSpStatus(info.sp_status)
  const parts: string[] = [`## ${info.sp_name || '(未命名审批)'}`]
  parts.push(`**状态**: ${status}`)
  parts.push(`**审批单号**: \`${info.sp_no}\``)
  if (info.applyer?.userid) parts.push(`**申请人**: ${info.applyer.userid}`)
  if (info.apply_time) parts.push(`**申请时间**: ${formatTs(info.apply_time)}`)

  // 审批内容
  const contents = info.apply_data?.contents || []
  if (contents.length > 0) {
    parts.push('\n### 申请内容')
    for (const item of contents) {
      const title = item.title?.[0]?.text || item.id || '(未命名)'
      const value = extractApplyValue(item)
      parts.push(`- **${title}**: ${value}`)
    }
  }

  // 审批节点
  const nodes = info.sp_record || []
  if (nodes.length > 0) {
    parts.push('\n### 审批流程')
    for (const node of nodes) {
      const nodeStatus = node.sp_status === 1 ? '审批中' : node.sp_status === 2 ? '已同意' : node.sp_status === 3 ? '已驳回' : `状态${node.sp_status}`
      const approvers = (node.details || []).map((d: any) => d.approver?.userid || '').filter(Boolean).join(', ')
      parts.push(`- ${nodeStatus}: ${approvers || '(无审批人)'}`)
    }
  }

  return parts.join('\n')
}

function extractApplyValue(item: any): string {
  const v = item.value
  if (!v) return '(空)'
  if (typeof v === 'string') return v
  if (v.text) return v.text
  if (v.new_money) return `${v.new_money} 元`
  if (v.new_number) return String(v.new_number)
  if (v.date?.s_timestamp) return formatTs(v.date.s_timestamp)
  if (v.selector?.options) {
    return v.selector.options.map((o: any) => o.value?.[0]?.text || o.key).join(', ')
  }
  if (v.members) {
    return v.members.map((m: any) => m.userid || m.name).join(', ')
  }
  if (v.departments) {
    return v.departments.map((d: any) => d.name || d.id).join(', ')
  }
  return JSON.stringify(v).substring(0, 200)
}

function formatUserDetail(user: any): string {
  const parts: string[] = [`## ${user.name || '(未命名)'}`]
  parts.push(`**UserID**: \`${user.userid}\``)
  if (user.department?.length) parts.push(`**部门**: ${user.department.join(' / ')}`)
  if (user.position) parts.push(`**职位**: ${user.position}`)
  if (user.mobile) parts.push(`**手机**: ${user.mobile}`)
  if (user.email) parts.push(`**邮箱**: ${user.email}`)
  if (user.gender) parts.push(`**性别**: ${user.gender === '1' ? '男' : user.gender === '2' ? '女' : '未知'}`)
  if (user.status !== undefined) {
    const statusMap: Record<number, string> = { 1: '已激活', 2: '已禁用', 4: '未激活', 5: '退出企业' }
    parts.push(`**状态**: ${statusMap[user.status] || `状态${user.status}`}`)
  }
  return parts.join('\n')
}

/**
 * 清理技能会话
 */
export function cleanup(): void {
  closeSession()
}
