/**
 * 日历技能执行器
 */

import { createLogger } from '../../../../utils/logger'
import type { ToolResult, AgentConfig } from '../../types'
import type { ToolExecutorConfig } from '../../tool-executor'
import { t, type TranslationKey } from '../../i18n'
import {
  mergeRRule,
  readRRuleValue,
  readRecurrencePatch,
  recurrenceEndedBefore,
  untilOnOrAfterStart,
  viewRecurrence,
  type RecurrenceReadError,
} from './recurrence'
import {
  findMismatch,
  isSameLocalDay,
  normalizeText,
  organizerIsOther,
  parseUserDateTime,
  readWritePrivilege,
  resolveEnd,
  shiftEnd,
  unverifiedMoments,
  type CheckedField,
  type ExpectedWrite,
  type WriteOperation
} from './write-check'
import {
  addICalDuration,
  findMasterEventRange,
  parseICalDuration,
  readCalAddress,
  readReportResource,
  zonedToUtc
} from './ical-util'
import { riskNeedsConfirm } from '../../command-audit/confirm-policy'

const log = createLogger('CalendarExecutor')
import { getCalendarCredential } from '../../../credential.service'
import {
  isSessionOpen,
  getSession,
  createSession,
  closeSession,
  getServerConfig,
  getFirstOpenSession,
  updateSessionCalendars,
  getDAVCalendar,
  type CalendarSession
} from './session'
import type { 
  Calendar, 
  CalendarEvent, 
  CalendarTodo,
  CalendarAccountConfig
} from './types'

type EnsureConnectedResult =
  | { ok: true; session: CalendarSession; justConnected: boolean }
  | { ok: false; result: ToolResult }

// 动态导入的模块
let tsdav: typeof import('tsdav')

/**
 * 初始化依赖模块
 */
async function initDependencies(): Promise<void> {
  if (!tsdav) {
    tsdav = await import('tsdav')
  }
}

/**
 * 缓存的账户配置（通过 IPC 从渲染进程获取）
 */
let cachedAccounts: CalendarAccountConfig[] = []

/**
 * 设置日历账户配置（由主进程调用）
 */
export function setCalendarAccounts(accounts: CalendarAccountConfig[]): void {
  cachedAccounts = accounts
}

/**
 * 获取日历账户配置
 */
function getCalendarAccount(accountId?: string): CalendarAccountConfig | undefined {
  if (accountId) {
    return cachedAccounts.find(a => a.id === accountId)
  }
  return cachedAccounts[0]
}

/**
 * 确保已连接到日历账户（懒连接）。
 * 已有有效会话则复用；否则用已配置账户自动建立 CalDAV 连接。
 */
async function ensureConnected(accountId?: string): Promise<EnsureConnectedResult> {
  await initDependencies()

  if (accountId) {
    if (isSessionOpen(accountId)) {
      const existing = getSession(accountId)
      if (existing?.connected && existing.client) {
        existing.lastAccess = Date.now()
        return { ok: true, session: existing, justConnected: false }
      }
      log.info(`Connection lost for account ${accountId}, reconnecting...`)
      await closeSession(accountId)
    }
  } else {
    // 懒连接路径：优先复用任意已打开会话（保留 calendar_connect 切换的活动账户）
    const existing = getFirstOpenSession()
    if (existing?.connected && existing.client) {
      existing.lastAccess = Date.now()
      return { ok: true, session: existing, justConnected: false }
    }
    if (existing) {
      log.info(`Stale calendar session for ${existing.accountId}, reconnecting...`)
      await closeSession(existing.accountId)
    }
  }

  const account = getCalendarAccount(accountId)
  if (!account) {
    return {
      ok: false,
      result: {
        success: false,
        output: '',
        error: cachedAccounts.length === 0
          ? t('calendar.no_accounts_configured')
          : t('calendar.account_not_found', { id: accountId || 'unknown' })
      }
    }
  }

  const credential = await getCalendarCredential(account.id)
  if (!credential) {
    return {
      ok: false,
      result: {
        success: false,
        output: '',
        error: t('calendar.credential_not_found', { name: account.name })
      }
    }
  }

  const serverConfig = getServerConfig(account.provider, account.serverUrl)

  try {
    const client = new tsdav.DAVClient({
      serverUrl: serverConfig.serverUrl,
      credentials: {
        username: account.username,
        password: credential
      },
      authMethod: 'Basic',
      defaultAccountType: 'caldav'
    })

    await client.login()

    const davCalendars = await client.fetchCalendars()

    const calendars: Calendar[] = davCalendars.map(cal => ({
      id: cal.url || '',
      name: typeof cal.displayName === 'string' ? cal.displayName : extractCalendarName(cal.url || ''),
      description: typeof cal.description === 'string' ? cal.description : undefined,
      color: typeof cal.calendarColor === 'string' ? cal.calendarColor : undefined,
      readonly: false,
      url: cal.url
    }))

    const session = createSession(account.id, account.name, account.username, client, calendars, davCalendars)
    session.provider = account.provider
    session.supportsTodo = await detectTodoSupport(account.provider, calendars, credential, account.username)

    log.info(`Auto-connected calendar account: ${account.name} (${calendars.length} calendars)`)
    return { ok: true, session, justConnected: true }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : t('calendar.connect_failed')
    return { ok: false, result: { success: false, output: '', error: errorMsg } }
  }
}

/**
 * 执行日历技能工具
 */
export async function executeCalendarTool(
  toolName: string,
  ptyId: string,
  args: Record<string, unknown>,
  toolCallId: string,
  config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  if (toolName === 'calendar_connect') {
    return await calendarConnect(args, executor)
  }

  // 读写工具：无会话时自动连接已配置账户（ensureConnected 内会 initDependencies）
  const ensured = await ensureConnected()
  if (!ensured.ok) return ensured.result

  if (toolName.startsWith('calendar_todo_') && ensured.session.supportsTodo === false) {
    return {
      success: false,
      output: '',
      error: t('calendar.todo_not_supported_error', { provider: ensured.session.accountName })
    }
  }

  switch (toolName) {
    case 'calendar_list':
      return await calendarList(args, executor)
    case 'calendar_create':
      return await calendarCreate(args, toolCallId, config, executor)
    case 'calendar_update':
      return await calendarUpdate(args, toolCallId, config, executor)
    case 'calendar_delete':
      return await calendarDelete(args, toolCallId, config, executor)
    case 'calendar_todo_list':
      return await todoList(args, executor)
    case 'calendar_todo_create':
      return await todoCreate(args, toolCallId, config, executor)
    case 'calendar_todo_update':
      return await todoUpdate(args, toolCallId, config, executor)
    case 'calendar_todo_delete':
      return await todoDelete(args, toolCallId, config, executor)
    default:
      return { success: false, output: '', error: t('error.unknown_tool', { name: toolName }) }
  }
}

/**
 * 连接日历（显式；多账户切换时使用）。读写工具会懒连接，通常不必先调此工具。
 */
async function calendarConnect(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  // 显式连接总是按目标账户判定（无 account_id 时落到默认账户），避免误复用其它已开会话
  const account = getCalendarAccount(args.account_id as string | undefined)
  if (!account) {
    return {
      success: false,
      output: '',
      error: cachedAccounts.length === 0
        ? t('calendar.no_accounts_configured')
        : t('calendar.account_not_found', { id: (args.account_id as string) || 'unknown' })
    }
  }

  const ensured = await ensureConnected(account.id)
  if (!ensured.ok) return ensured.result

  const { session, justConnected } = ensured
  const output = justConnected
    ? t('calendar.connected', { name: session.accountName, count: session.calendars.length })
    : t('calendar.already_connected', { name: session.accountName })

  executor.addStep({
    type: 'tool_result',
    content: output,
    toolName: 'calendar_connect',
    toolResult: output
  })

  return { success: true, output }
}

/**
 * 列出日历或日程
 */
async function calendarList(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const calendarId = args.calendar_id as string | undefined
  const startDateStr = args.start_date as string | undefined
  const endDateStr = args.end_date as string | undefined
  const limit = Math.min(Math.max((args.limit as number) || 50, 1), 200)

  const session = getFirstOpenSession()
  if (!session || !session.client) {
    return { success: false, output: '', error: t('calendar.not_connected') }
  }

  try {
    if (!calendarId) {
      // 列出所有日历
      const calendars = session.calendars
      if (calendars.length === 0) {
        // 尝试重新获取
        const davCalendars = await session.client.fetchCalendars()
        const newCalendars: Calendar[] = davCalendars.map(cal => ({
          id: cal.url || '',
          name: typeof cal.displayName === 'string' ? cal.displayName : extractCalendarName(cal.url || ''),
          description: typeof cal.description === 'string' ? cal.description : undefined,
          color: typeof cal.calendarColor === 'string' ? cal.calendarColor : undefined,
          readonly: false,
          url: cal.url
        }))
        updateSessionCalendars(session.accountId, newCalendars, davCalendars)
        session.calendars = newCalendars
        session.davCalendars = davCalendars
      }

      const calendarList = session.calendars.map((cal, index) => {
        const readonly = cal.readonly ? ' (只读)' : ''
        const color = cal.color ? ` ${cal.color}` : ''
        return `${index + 1}. **${cal.name}**${readonly}${color}`
      })

      // 简洁输出给用户看，完整 ID 映射在 toolResult 中给 AI 用
      const output = `## ${t('calendar.calendar_list')}\n\n${calendarList.join('\n')}`
      
      // 给 AI 的完整信息（包含 ID 映射）
      const aiOutput = session.calendars.map((cal, index) => 
        `${index + 1}. ${cal.name} → ID: ${cal.id}`
      ).join('\n')
      executor.addStep({
        type: 'tool_result',
        content: output,
        toolName: 'calendar_list',
        toolResult: aiOutput  // AI 需要完整 ID 来后续调用
      })

      return { success: true, output: aiOutput }
    }

    // 列出指定日历的日程
    const startDate = startDateStr 
      ? new Date(startDateStr) 
      : new Date()
    const endDate = endDateStr 
      ? new Date(endDateStr) 
      : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    
    // 设置时间边界
    startDate.setHours(0, 0, 0, 0)
    endDate.setHours(23, 59, 59, 999)

    // 尝试使用时间范围查询，如果失败则获取所有事件
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, prefer-const
    let calendarObjects: any[] = []
    
    // 获取完整的 DAVCalendar 对象
    const davCalendar = getDAVCalendar(session.accountId, calendarId)
    const calendarObj = davCalendar || { url: calendarId }
    
    // 获取认证凭据
    const credential = await getCalendarCredential(session.accountId)
    const authHeader = `Basic ${Buffer.from(`${session.username}:${credential}`).toString('base64')}`
    
    // 格式化为 CalDAV time-range 格式 (YYYYMMDDTHHMMSSZ)
    const formatTimeRange = (date: Date) => {
      return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
    }
    
    // 方法1（首选）：使用带时间过滤的 REPORT calendar-query
    // 这样服务端只返回指定时间范围内的事件，避免获取大量历史数据
    try {
      const reportBody = `<?xml version="1.0" encoding="utf-8" ?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <D:getetag/>
    <C:calendar-data/>
  </D:prop>
  <C:filter>
    <C:comp-filter name="VCALENDAR">
      <C:comp-filter name="VEVENT">
        <C:time-range start="${formatTimeRange(startDate)}" end="${formatTimeRange(endDate)}"/>
      </C:comp-filter>
    </C:comp-filter>
  </C:filter>
</C:calendar-query>`

      const reportResponse = await fetch(calendarId, {
        method: 'REPORT',
        headers: {
          'Authorization': authHeader,
          'Content-Type': 'application/xml; charset=utf-8',
          'Depth': '1'
        },
        body: reportBody
      })
      
      const reportText = await reportResponse.text()
      
      if (reportResponse.status === 207) {
        // 解析响应中的 calendar-data
        const calDataMatches = reportText.match(/<[^>]*calendar-data[^>]*>([\s\S]*?)<\/[^>]*calendar-data>/gi) || []
        
        for (const match of calDataMatches) {
          let data = match.replace(/<[^>]+>/g, '').trim()
          // 处理 CDATA
          if (data.startsWith('<![CDATA[')) {
            data = data.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '')
          }
          // 解码 XML 实体
          data = data.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
          
          if (data.includes('VEVENT')) {
            calendarObjects.push({
              url: calendarId,
              data: data
            })
          }
        }
      }
    } catch (reportError: any) {
      // REPORT 失败，将尝试备选方法
    }
    
    // 方法2：如果 REPORT 没有返回数据，使用 PROPFIND + GET（但限制数量并从最新开始）
    if (calendarObjects.length === 0) {
      // eslint-disable-next-line prefer-const
      let eventUrls: string[] = []
      try {
        const propfindBody = `<?xml version="1.0" encoding="utf-8" ?>
<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <D:getetag/>
    <D:getcontenttype/>
    <D:getlastmodified/>
  </D:prop>
</D:propfind>`

        const propfindResponse = await fetch(calendarId, {
          method: 'PROPFIND',
          headers: {
            'Authorization': authHeader,
            'Content-Type': 'application/xml; charset=utf-8',
            'Depth': '1'
          },
          body: propfindBody
        })
        
        const responseText = await propfindResponse.text()
        
        // 解析 XML 响应，提取 href
        const hrefMatches = responseText.match(/<[^>]*href[^>]*>([^<]+)<\/[^>]*href>/gi) || []
        
        for (const match of hrefMatches) {
          const hrefContent = match.replace(/<[^>]+>/g, '').trim()
          if (hrefContent === calendarId || 
              hrefContent === calendarId.replace(/\/$/, '') || 
              hrefContent.endsWith('/calendar/') ||
              !hrefContent) {
            continue
          }
          if (hrefContent.includes('.ics') || hrefContent.match(/\/[A-Za-z0-9_-]{10,}\/?$/)) {
            const fullUrl = hrefContent.startsWith('http') ? hrefContent : new URL(hrefContent, calendarId).href
            eventUrls.push(fullUrl)
          }
        }
        
        // 反转 URL 列表，从最新的开始获取
        eventUrls.reverse()
      } catch (propfindError: any) {
        // PROPFIND 失败
      }
      
      // 获取事件数据（限制数量，从最新开始，并行获取提升性能）
      if (eventUrls.length > 0) {
        const fetchLimit = Math.min(eventUrls.length, 200)
        const urlsToFetch = eventUrls.slice(0, fetchLimit)
        
        // 并行获取所有事件，使用 Promise.allSettled 避免单个失败影响整体
        const BATCH_SIZE = 20 // 每批并发请求数，避免过多并发
        const results: { url: string; data: string; etag?: string }[] = []
        
        for (let i = 0; i < urlsToFetch.length; i += BATCH_SIZE) {
          const batch = urlsToFetch.slice(i, i + BATCH_SIZE)
          const batchPromises = batch.map(async (eventUrl) => {
            try {
              const response = await fetch(eventUrl, {
                method: 'GET',
                headers: { 'Authorization': authHeader }
              })
              
              if (response.ok) {
                const data = await response.text()
                if (data.includes('VEVENT')) {
                  return {
                    url: eventUrl,
                    etag: response.headers.get('etag') || undefined,
                    data: data
                  }
                }
              }
              return null
            } catch {
              return null
            }
          })
          
          const batchResults = await Promise.all(batchPromises)
          for (const result of batchResults) {
            if (result) {
              results.push(result)
            }
          }
        }
        
        calendarObjects.push(...results)
      }
    }
    
    // 方法3：如果上述方法都失败，尝试 tsdav 的 fetchCalendarObjects
    if (calendarObjects.length === 0) {
      try {
        const fetchedObjects = await session.client.fetchCalendarObjects({
          calendar: calendarObj as any
        })
        
        for (const obj of fetchedObjects) {
          if (obj.data && typeof obj.data === 'string') {
            calendarObjects.push(obj)
          }
        }
      } catch (fetchError: any) {
        // fetchCalendarObjects 失败
      }
    }

    const events: CalendarEvent[] = []
    const startTime = startDate.getTime()
    const endTime = endDate.getTime()
    
    for (const obj of calendarObjects) {
      if (!obj.data) continue
      
      const event = parseICalEvent(obj.data, obj.url, obj.etag)
      if (event && eventInRange(event, startTime, endTime)) {
        events.push(event)
        if (events.length >= limit) break
      }
    }

    // 按开始时间排序
    events.sort((a, b) => a.start.getTime() - b.start.getTime())

    if (events.length === 0) {
      const output = t('calendar.no_events', { 
        start: formatDate(startDate), 
        end: formatDate(endDate) 
      })
      
      executor.addStep({
        type: 'tool_result',
        content: output,
        toolName: 'calendar_list',
        toolResult: output
      })
      return { success: true, output }
    }

    const eventList = events.map(event => {
      const timeStr = event.allDay 
        ? `📅 ${formatDate(event.start)}（全天）`
        : `🕐 ${formatDateTime(event.start)} - ${formatTime(event.end)}`
      const location = event.location ? `\n  📍 ${event.location}` : ''
      const recur = event.recurrence ? `\n  🔁 ${formatRecurrenceLabel(event.recurrence)}` : ''
      const first = event.recurrence && event.start.getTime() < startTime
        ? `\n  ${t('calendar.recurrence_first')}`
        : ''
      return `- **${event.title}**\n  ${timeStr}${location}${recur}${first}\n  ID: \`${event.uid}\``
    })

    const output = `## ${t('calendar.event_list')} (${formatDate(startDate)} ~ ${formatDate(endDate)})\n\n${t('calendar.total_events', { count: events.length })}\n\n${eventList.join('\n\n')}`
    executor.addStep({
      type: 'tool_result',
      content: output,
      toolName: 'calendar_list',
      toolResult: truncateOutput(output, 800)
    })

    return { success: true, output }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : t('calendar.list_failed')
    return { success: false, output: '', error: errorMsg }
  }
}

/**
 * 创建日程
 */
async function calendarCreate(
  args: Record<string, unknown>,
  toolCallId: string,
  config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const calendarId = args.calendar_id as string
  const title = args.title as string
  const startStr = args.start as string
  const endStr = args.end as string | undefined
  const allDay = args.all_day as boolean | undefined
  const location = args.location as string | undefined
  const description = args.description as string | undefined
  const reminderMinutes = args.reminder_minutes as number | undefined

  if (!calendarId || !title || !startStr) {
    return { success: false, output: '', error: t('calendar.params_required') }
  }

  const recurrenceRead = readRecurrencePatch(args, 'create')
  if (!recurrenceRead.ok) {
    return { success: false, output: '', error: recurrenceReadError(recurrenceRead.error) }
  }

  const session = getFirstOpenSession()
  if (!session || !session.client) {
    return { success: false, output: '', error: t('calendar.not_connected') }
  }

  // 解析时间
  const allDayFlag = Boolean(allDay)
  const startDate = parseUserDateTime(startStr, allDayFlag)
  if (!startDate) {
    return { success: false, output: '', error: t('calendar.invalid_time', { value: startStr }) }
  }
  const endInput = endStr ? parseUserDateTime(endStr, allDayFlag) : null
  if (endStr && !endInput) {
    return { success: false, output: '', error: t('calendar.invalid_time', { value: endStr }) }
  }
  // 没给结束时：全天按一天，定时按一小时
  const rawEnd = endInput ?? (allDayFlag ? startDate : new Date(startDate.getTime() + 60 * 60 * 1000))
  const endDate = resolveEnd(startDate, rawEnd, allDayFlag)
  if (!endDate) {
    return { success: false, output: '', error: t('calendar.end_before_start') }
  }

  if (recurrenceRead.patch?.until && !untilOnOrAfterStart(recurrenceRead.patch.until, startDate, allDayFlag)) {
    return { success: false, output: '', error: t('calendar.recurrence_until_before_start') }
  }
  const rrule = mergeRRule(undefined, recurrenceRead.patch, allDayFlag)

  // 构建确认信息
  let confirmInfo = `${t('calendar.create_confirm')}\n\n`
  confirmInfo += `**${t('calendar.title')}**: ${title}\n`
  confirmInfo += `**${t('calendar.time')}**: ${formatDateTime(startDate)} - ${formatDateTime(endDate)}\n`
  if (allDayFlag) confirmInfo += `**${t('calendar.all_day')}**: ${t('misc.yes')}\n`
  if (location) confirmInfo += `**${t('calendar.location')}**: ${location}\n`
  if (reminderMinutes) confirmInfo += `**${t('calendar.reminder')}**: ${t('calendar.reminder_minutes', { minutes: reminderMinutes })}\n`
  if (rrule) {
    confirmInfo += `**${t('calendar.recurrence')}**: ${formatRecurrenceLabel(rrule)}\n`
  }

  // 显示创建信息
  executor.addStep({
    type: 'tool_call',
    content: confirmInfo,
    toolName: 'calendar_create',
    toolArgs: { title, start: startStr, location },
    riskLevel: 'moderate'
  })

  if (riskNeedsConfirm('moderate', config.executionMode, config.commandRiskPolicy)) {
    const approved = await executor.waitForConfirmation(
      toolCallId,
      'calendar_create',
      { title, start: startStr },
      'moderate'
    )

    if (!approved) {
      return { success: false, output: '', error: t('calendar.user_rejected') }
    }
  }

  try {
    // 生成唯一 UID
    const uid = generateUID()
    
    // 构建 iCalendar 数据
    const icalData = buildICalEvent({
      uid,
      title,
      start: startDate,
      end: endDate,
      allDay: allDayFlag,
      location,
      description,
      reminderMinutes,
      rrule
    })

    // 创建事件。tsdav 只返回 Response、不校验 ok，服务端拒绝时不会抛异常
    const response = await session.client.createCalendarObject({
      calendar: { url: calendarId },
      filename: `${uid}.ics`,
      iCalString: icalData
    })

    if (!response.ok) {
      return {
        success: false,
        output: '',
        error: await describeWriteFailure('create', response.status, undefined, calendarId, session)
      }
    }

    // 回读核验：读不到、或标题与开始时间对不上，都不能报「已创建」
    const verified = await verifyEventWritten(
      calendarId,
      uid,
      {
        allDay: allDayFlag,
        title,
        start: startDate,
        end: endDate,
        location: location || undefined,
        description: description || undefined,
        recurrence: rrule
      },
      session,
      'create'
    )
    if (!verified.ok) {
      return { success: false, output: '', error: verified.error }
    }

    const output = withNote(t('calendar.created', { title }), verified.note)
    executor.addStep({
      type: 'tool_result',
      content: output,
      toolName: 'calendar_create',
      toolResult: output
    })

    return { success: true, output }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : t('calendar.create_failed')
    return { success: false, output: '', error: errorMsg }
  }
}

/**
 * 更新日程
 */
async function calendarUpdate(
  args: Record<string, unknown>,
  toolCallId: string,
  config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const calendarId = args.calendar_id as string
  const eventId = args.event_id as string
  const title = args.title as string | undefined
  const startStr = args.start as string | undefined
  const endStr = args.end as string | undefined
  const location = args.location as string | undefined
  const description = args.description as string | undefined

  if (!calendarId || !eventId) {
    return { success: false, output: '', error: t('calendar.event_id_required') }
  }

  const recurrenceRead = readRecurrencePatch(args, 'update')
  if (!recurrenceRead.ok) {
    return { success: false, output: '', error: recurrenceReadError(recurrenceRead.error) }
  }

  const session = getFirstOpenSession()
  if (!session || !session.client) {
    return { success: false, output: '', error: t('calendar.not_connected') }
  }

  try {
    // 通过 UID 直接获取事件（比获取所有事件要高效）
    const eventObj = await fetchEventByUid(calendarId, eventId, session)
    
    if (!eventObj) {
      return { success: false, output: '', error: t('calendar.event_not_found', { id: eventId }) }
    }

    const originalEvent = parseICalEvent(eventObj.data, eventObj.url, eventObj.etag)
    if (!originalEvent) {
      return { success: false, output: '', error: t('calendar.event_parse_failed') }
    }

    const allDayFlag = originalEvent.allDay || false
    const startInput = startStr ? parseUserDateTime(startStr, allDayFlag) : null
    if (startStr && !startInput) {
      return { success: false, output: '', error: t('calendar.invalid_time', { value: startStr }) }
    }
    const endInput = endStr ? parseUserDateTime(endStr, allDayFlag) : null
    if (endStr && !endInput) {
      return { success: false, output: '', error: t('calendar.invalid_time', { value: endStr }) }
    }
    const nextStart = startInput ?? originalEvent.start
    if (recurrenceRead.patch?.until && !untilOnOrAfterStart(recurrenceRead.patch.until, nextStart, allDayFlag)) {
      return { success: false, output: '', error: t('calendar.recurrence_until_before_start') }
    }
    const mergedRRule = mergeRRule(originalEvent.recurrence, recurrenceRead.patch, allDayFlag)
    const setsBound = recurrenceRead.patch?.until != null
      || (typeof recurrenceRead.patch?.count === 'number' && recurrenceRead.patch.count > 0)
    // 认不出原来的频率时不要把整条重复写丢；让调用方带上频率再改
    if (recurrenceRead.patch && !mergedRRule && (setsBound || originalEvent.recurrence)) {
      return { success: false, output: '', error: t('calendar.recurrence_freq_required') }
    }
    const nextRRule = recurrenceRead.patch ? mergedRRule : originalEvent.recurrence

    // 构建确认信息
    const changes: string[] = []
    const momentDiffers = (next: Date, prev: Date) =>
      allDayFlag ? !isSameLocalDay(next, prev) : next.getTime() !== prev.getTime()
    const titleChanged = Boolean(title) && title !== originalEvent.title
    const startChanged = startInput != null && momentDiffers(startInput, originalEvent.start)

    // 只改了开始时间：会议时长不变，结束时间跟着后移
    let nextEnd = endInput ?? originalEvent.end
    if (startChanged && !endInput) {
      nextEnd = shiftEnd(originalEvent.start, originalEvent.end, nextStart, allDayFlag)
    }
    if (startChanged || endInput) {
      const resolved = resolveEnd(nextStart, nextEnd, allDayFlag)
      if (!resolved) {
        return { success: false, output: '', error: t('calendar.end_before_start') }
      }
      nextEnd = resolved
    }
    const endChanged = (startChanged || endInput != null) && momentDiffers(nextEnd, originalEvent.end)

    const locationChanged = location !== undefined && (location || '') !== (originalEvent.location || '')
    const descriptionChanged = description !== undefined && description !== (originalEvent.description || '')
    if (titleChanged) changes.push(`${t('calendar.title')}: ${originalEvent.title} → ${title}`)
    if (startChanged) changes.push(`${t('calendar.start')}: ${formatDateTime(originalEvent.start)} → ${formatDateTime(nextStart)}`)
    if (endChanged) changes.push(`${t('calendar.end')}: ${formatDateTime(originalEvent.end)} → ${formatDateTime(nextEnd)}`)
    if (locationChanged) changes.push(`${t('calendar.location')}: ${originalEvent.location || '(无)'} → ${location || '(无)'}`)
    if (descriptionChanged) changes.push(`${t('calendar.description')}: ${originalEvent.description || '(无)'} → ${description || '(无)'}`)
    const recurrenceChanged = (nextRRule ?? '') !== (originalEvent.recurrence ?? '')
    if (recurrenceChanged) {
      const before = originalEvent.recurrence
        ? formatRecurrenceLabel(originalEvent.recurrence)
        : t('calendar.recurrence_none')
      const after = nextRRule
        ? formatRecurrenceLabel(nextRRule)
        : t('calendar.recurrence_none')
      changes.push(`${t('calendar.recurrence')}: ${before} → ${after}`)
    }

    if (changes.length === 0) {
      return { success: false, output: '', error: t('calendar.no_changes') }
    }

    // 他人发起的会议多半改不动，提前把这一点摆出来，别等写完才失败
    if (organizerIsOther(originalEvent.organizer, session.username)) {
      changes.push(t('calendar.organizer_warning', { organizer: originalEvent.organizer || '' }))
    }

    let confirmInfo = `${t('calendar.update_confirm')}\n\n`
    confirmInfo += `**${t('calendar.event')}**: ${originalEvent.title}\n\n`
    confirmInfo += `**${t('calendar.changes')}**:\n${changes.map(c => `- ${c}`).join('\n')}`

    // 显示修改信息
    executor.addStep({
      type: 'tool_call',
      content: confirmInfo,
      toolName: 'calendar_update',
      toolArgs: { event_id: eventId, changes },
      riskLevel: 'moderate'
    })

    if (riskNeedsConfirm('moderate', config.executionMode, config.commandRiskPolicy)) {
      const approved = await executor.waitForConfirmation(
        toolCallId,
        'calendar_update',
        { event_id: eventId },
        'moderate'
      )

      if (!approved) {
        return { success: false, output: '', error: t('calendar.user_rejected') }
      }
    }

    // 只在原始数据上改这次要变的项，保留发起人、参会人等其余内容，
    // 不能用 buildICalEvent 重建——那样会把他人的会议邀请抹成孤立事件。
    // 没变的项不传：只改标题时，开始、结束时间不会被重写成别的写法
    const changed = {
      title: titleChanged ? title : undefined,
      start: startChanged ? nextStart : undefined,
      end: endChanged ? nextEnd : undefined,
      location: locationChanged ? (location ?? '') : undefined,
      description: descriptionChanged ? (description ?? '') : undefined,
      rrule: recurrenceChanged ? (nextRRule ?? '') : undefined
    }
    const icalData = patchICalEvent(eventObj.data, { ...changed, allDay: allDayFlag })

    // 更新事件。必须检查响应状态码：tsdav 只返回 Response、不校验 ok，
    // 服务端回 403（无编辑权限）或 412（版本冲突）时不会抛异常
    const response = await session.client.updateCalendarObject({
      calendarObject: {
        url: eventObj.url,
        etag: eventObj.etag,
        data: icalData
      }
    })

    if (!response.ok) {
      return {
        success: false,
        output: '',
        error: await describeWriteFailure('update', response.status, originalEvent.organizer, eventObj.url, session)
      }
    }

    // 回读核验：拿到 2xx 不等于内容真的落盘，读回来对一次再报成功
    const verified = await verifyEventWritten(
      calendarId,
      eventId,
      {
        allDay: allDayFlag,
        title: changed.title,
        start: changed.start,
        end: changed.end,
        location: changed.location,
        description: changed.description,
        recurrence: changed.rrule
      },
      session,
      'update'
    )
    if (!verified.ok) {
      return { success: false, output: '', error: verified.error }
    }

    const output = withNote(t('calendar.updated', { title: title || originalEvent.title }), verified.note)
    executor.addStep({
      type: 'tool_result',
      content: output,
      toolName: 'calendar_update',
      toolResult: output
    })

    return { success: true, output }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : t('calendar.update_failed')
    return { success: false, output: '', error: errorMsg }
  }
}

/**
 * 删除日程
 */
async function calendarDelete(
  args: Record<string, unknown>,
  toolCallId: string,
  config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const calendarId = args.calendar_id as string
  const eventIds = args.event_ids as string[]

  if (!calendarId || !eventIds || eventIds.length === 0) {
    return { success: false, output: '', error: t('calendar.event_ids_required') }
  }

  const session = getFirstOpenSession()
  if (!session || !session.client) {
    return { success: false, output: '', error: t('calendar.not_connected') }
  }

  try {
    // 通过 UID 直接获取要删除的事件（比获取所有事件要高效）
    const eventsToDelete: Array<{ id: string; url: string; etag?: string; title: string; organizer?: string }> = []
    
    for (const eventId of eventIds) {
      const eventObj = await fetchEventByUid(calendarId, eventId, session)
      if (eventObj) {
        const event = parseICalEvent(eventObj.data, eventObj.url, eventObj.etag)
        if (event) {
          eventsToDelete.push({
            id: eventId,
            url: eventObj.url,
            etag: eventObj.etag,
            title: event.title,
            organizer: event.organizer
          })
        }
      }
    }

    if (eventsToDelete.length === 0) {
      return { success: false, output: '', error: t('calendar.events_not_found') }
    }

    // 构建确认信息
    let confirmInfo = `${t('calendar.delete_confirm')}\n\n`
    confirmInfo += `**${t('calendar.events_to_delete')}** (${eventsToDelete.length}):\n`
    confirmInfo += eventsToDelete.map(e => `- ${e.title}`).join('\n')

    // 显示删除信息
    executor.addStep({
      type: 'tool_call',
      content: confirmInfo,
      toolName: 'calendar_delete',
      toolArgs: { count: eventsToDelete.length },
      riskLevel: 'moderate'
    })

    if (riskNeedsConfirm('moderate', config.executionMode, config.commandRiskPolicy)) {
      const approved = await executor.waitForConfirmation(
        toolCallId,
        'calendar_delete',
        { count: eventsToDelete.length },
        'moderate'
      )

      if (!approved) {
        return { success: false, output: '', error: t('calendar.user_rejected') }
      }
    }

    // 删除事件。tsdav 只返回 Response、不校验 ok，无权删除时也不会抛错，
    // 所以这里必须自己看状态码，再读回确认日程真的没了，失败的如实列出
    const deletedTitles: string[] = []
    const failures: string[] = []
    for (const event of eventsToDelete) {
      try {
        const response = await session.client.deleteCalendarObject({
          calendarObject: {
            url: event.url,
            etag: event.etag
          }
        })
        if (!response.ok) {
          failures.push(`${event.title}：${await describeWriteFailure('delete', response.status, event.organizer, event.url, session)}`)
          continue
        }
        const notDeleted = deleteFailureMessage(await verifyResourceDeleted(event.url, session))
        if (notDeleted) {
          failures.push(`${event.title}：${notDeleted}`)
          continue
        }
        deletedTitles.push(event.title)
      } catch (e) {
        log.error(`Failed to delete event: ${event.title}`, e)
        failures.push(`${event.title}：${e instanceof Error ? e.message : String(e)}`)
      }
    }

    // 只要有没删掉的，整体不报成功；已删掉的与没删掉的分别列出，免得被误以为全没动
    if (failures.length > 0) {
      return {
        success: false,
        output: '',
        error: deletedTitles.length === 0
          ? failures.join('；')
          : t('calendar.deleted_with_failures', {
            count: deletedTitles.length,
            deleted: deletedTitles.join('、'),
            failures: failures.join('；')
          })
      }
    }

    const output = t('calendar.deleted', { count: deletedTitles.length })
    executor.addStep({
      type: 'tool_result',
      content: output,
      toolName: 'calendar_delete',
      toolResult: output
    })

    return { success: true, output }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : t('calendar.delete_failed')
    return { success: false, output: '', error: errorMsg }
  }
}

// ============ 待办事项功能 ============

/**
 * 列出待办事项
 */
async function todoList(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const calendarId = args.calendar_id as string
  const statusFilter = args.status as string | undefined
  const limit = Math.min(Math.max((args.limit as number) || 50, 1), 200)

  if (!calendarId) {
    return { success: false, output: '', error: t('calendar.todo_calendar_id_required') }
  }

  const session = getFirstOpenSession()
  if (!session || !session.client) {
    return { success: false, output: '', error: t('calendar.not_connected') }
  }

  try {
    // 获取认证凭据
    const credential = await getCalendarCredential(session.accountId)
    const authHeader = `Basic ${Buffer.from(`${session.username}:${credential}`).toString('base64')}`

    // eslint-disable-next-line @typescript-eslint/no-explicit-any, prefer-const
    let calendarObjects: any[] = []

    // 方法1：使用 REPORT calendar-query 查询 VTODO
    try {
      // 构建状态过滤条件
      let compFilter = '<C:comp-filter name="VTODO"'
      if (statusFilter && statusFilter !== 'all') {
        const statusMap: Record<string, string> = {
          'needs-action': 'NEEDS-ACTION',
          'in-process': 'IN-PROCESS',
          'completed': 'COMPLETED',
          'cancelled': 'CANCELLED'
        }
        const icalStatus = statusMap[statusFilter]
        if (icalStatus) {
          compFilter += `>
            <C:prop-filter name="STATUS">
              <C:text-match collation="i;ascii-casemap">${icalStatus}</C:text-match>
            </C:prop-filter>
          </C:comp-filter>`
        } else {
          compFilter += '/>'
        }
      } else if (!statusFilter) {
        // 默认不返回已完成和已取消的
        compFilter += '/>'
      } else {
        compFilter += '/>'
      }

      const reportBody = `<?xml version="1.0" encoding="utf-8" ?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <D:getetag/>
    <C:calendar-data/>
  </D:prop>
  <C:filter>
    <C:comp-filter name="VCALENDAR">
      ${compFilter}
    </C:comp-filter>
  </C:filter>
</C:calendar-query>`

      const reportResponse = await fetch(calendarId, {
        method: 'REPORT',
        headers: {
          'Authorization': authHeader,
          'Content-Type': 'application/xml; charset=utf-8',
          'Depth': '1'
        },
        body: reportBody
      })

      const reportText = await reportResponse.text()

      if (reportResponse.status === 207) {
        const calDataMatches = reportText.match(/<[^>]*calendar-data[^>]*>([\s\S]*?)<\/[^>]*calendar-data>/gi) || []

        for (const match of calDataMatches) {
          let data = match.replace(/<[^>]+>/g, '').trim()
          if (data.startsWith('<![CDATA[')) {
            data = data.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '')
          }
          data = data.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

          if (data.includes('VTODO')) {
            calendarObjects.push({
              url: calendarId,
              data: data
            })
          }
        }
      }
    } catch {
      // REPORT 失败，将尝试备选方法
    }

    // 方法2：如果 REPORT 没有返回数据，使用 PROPFIND + GET
    if (calendarObjects.length === 0) {
      // eslint-disable-next-line prefer-const
      let todoUrls: string[] = []
      try {
        const propfindBody = `<?xml version="1.0" encoding="utf-8" ?>
<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <D:getetag/>
    <D:getcontenttype/>
  </D:prop>
</D:propfind>`

        const propfindResponse = await fetch(calendarId, {
          method: 'PROPFIND',
          headers: {
            'Authorization': authHeader,
            'Content-Type': 'application/xml; charset=utf-8',
            'Depth': '1'
          },
          body: propfindBody
        })

        const responseText = await propfindResponse.text()
        const hrefMatches = responseText.match(/<[^>]*href[^>]*>([^<]+)<\/[^>]*href>/gi) || []

        for (const match of hrefMatches) {
          const hrefContent = match.replace(/<[^>]+>/g, '').trim()
          if (hrefContent === calendarId ||
              hrefContent === calendarId.replace(/\/$/, '') ||
              !hrefContent) {
            continue
          }
          if (hrefContent.includes('.ics') || hrefContent.match(/\/[A-Za-z0-9_-]{10,}\/?$/)) {
            const fullUrl = hrefContent.startsWith('http') ? hrefContent : new URL(hrefContent, calendarId).href
            todoUrls.push(fullUrl)
          }
        }
      } catch {
        // PROPFIND 失败
      }

      // 并行获取，筛选包含 VTODO 的
      if (todoUrls.length > 0) {
        const fetchLimit = Math.min(todoUrls.length, 200)
        const urlsToFetch = todoUrls.slice(0, fetchLimit)

        const BATCH_SIZE = 20
        for (let i = 0; i < urlsToFetch.length; i += BATCH_SIZE) {
          const batch = urlsToFetch.slice(i, i + BATCH_SIZE)
          const batchPromises = batch.map(async (todoUrl) => {
            try {
              const response = await fetch(todoUrl, {
                method: 'GET',
                headers: { 'Authorization': authHeader }
              })
              if (response.ok) {
                const data = await response.text()
                if (data.includes('VTODO')) {
                  return {
                    url: todoUrl,
                    etag: response.headers.get('etag') || undefined,
                    data
                  }
                }
              }
              return null
            } catch {
              return null
            }
          })

          const batchResults = await Promise.all(batchPromises)
          for (const result of batchResults) {
            if (result) calendarObjects.push(result)
          }
        }
      }
    }

    // 解析待办事项
    const todos: CalendarTodo[] = []
    for (const obj of calendarObjects) {
      if (!obj.data) continue
      const todo = parseICalTodo(obj.data, obj.url, obj.etag)
      if (todo) {
        // 默认过滤：不返回已完成/已取消的（除非明确请求）
        if (!statusFilter) {
          if (todo.status === 'completed' || todo.status === 'cancelled') continue
        } else if (statusFilter !== 'all') {
          if (todo.status !== statusFilter) continue
        }
        todos.push(todo)
        if (todos.length >= limit) break
      }
    }

    // 按优先级排序（高优先级在前），优先级相同则按截止日期排序
    todos.sort((a, b) => {
      const pa = a.priority || 0
      const pb = b.priority || 0
      if (pa !== pb) {
        // 有优先级的排在无优先级前面，优先级数值小的更高
        if (pa === 0) return 1
        if (pb === 0) return -1
        return pa - pb
      }
      // 有截止日期的排在前面
      if (a.due && b.due) return a.due.getTime() - b.due.getTime()
      if (a.due) return -1
      if (b.due) return 1
      return 0
    })

    if (todos.length === 0) {
      const output = t('calendar.no_todos')
      executor.addStep({
        type: 'tool_result',
        content: output,
        toolName: 'calendar_todo_list',
        toolResult: output
      })
      return { success: true, output }
    }

    const todoListItems = todos.map(todo => {
      const statusIcon = todo.status === 'completed' ? '✅' :
        todo.status === 'in-process' ? '🔄' :
        todo.status === 'cancelled' ? '❌' : '⬜'
      const priorityStr = todo.priority ? ` ${formatPriority(todo.priority)}` : ''
      const dueStr = todo.due ? `\n  📅 ${t('calendar.todo_due')}: ${formatDateTime(todo.due)}` : ''
      const percentStr = (todo.percentComplete !== undefined && todo.percentComplete > 0) 
        ? `\n  📊 ${todo.percentComplete}%` : ''
      const categoriesStr = todo.categories?.length 
        ? `\n  🏷️ ${todo.categories.join(', ')}` : ''
      return `- ${statusIcon} **${todo.title}**${priorityStr}${dueStr}${percentStr}${categoriesStr}\n  ID: \`${todo.uid}\``
    })

    const filterLabel = statusFilter === 'all' ? t('calendar.todo_all') :
      statusFilter === 'completed' ? t('calendar.todo_status_completed') :
      statusFilter === 'in-process' ? t('calendar.todo_status_in_process') :
      statusFilter === 'cancelled' ? t('calendar.todo_status_cancelled') :
      t('calendar.todo_status_pending')

    const output = `## ${t('calendar.todo_list_title')} (${filterLabel})\n\n${t('calendar.total_todos', { count: todos.length })}\n\n${todoListItems.join('\n\n')}`
    executor.addStep({
      type: 'tool_result',
      content: output,
      toolName: 'calendar_todo_list',
      toolResult: truncateOutput(output, 800)
    })

    return { success: true, output }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : t('calendar.todo_list_failed')
    return { success: false, output: '', error: errorMsg }
  }
}

/**
 * 创建待办事项
 */
async function todoCreate(
  args: Record<string, unknown>,
  toolCallId: string,
  config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const calendarId = args.calendar_id as string
  const title = args.title as string
  const dueStr = args.due as string | undefined
  const priority = args.priority as number | undefined
  const description = args.description as string | undefined
  const categories = args.categories as string[] | undefined

  if (!calendarId || !title) {
    return { success: false, output: '', error: t('calendar.todo_params_required') }
  }

  const session = getFirstOpenSession()
  if (!session || !session.client) {
    return { success: false, output: '', error: t('calendar.not_connected') }
  }

  // 构建确认信息
  let confirmInfo = `${t('calendar.todo_create_confirm')}\n\n`
  confirmInfo += `**${t('calendar.title')}**: ${title}\n`
  if (dueStr) confirmInfo += `**${t('calendar.todo_due')}**: ${dueStr}\n`
  if (priority) confirmInfo += `**${t('calendar.todo_priority')}**: ${formatPriority(priority)}\n`
  if (description) confirmInfo += `**${t('calendar.todo_description')}**: ${description}\n`
  if (categories?.length) confirmInfo += `**${t('calendar.todo_categories')}**: ${categories.join(', ')}\n`

  executor.addStep({
    type: 'tool_call',
    content: confirmInfo,
    toolName: 'calendar_todo_create',
    toolArgs: { title, due: dueStr },
    riskLevel: 'moderate'
  })

  if (riskNeedsConfirm('moderate', config.executionMode, config.commandRiskPolicy)) {
    const approved = await executor.waitForConfirmation(
      toolCallId,
      'calendar_todo_create',
      { title, due: dueStr },
      'moderate'
    )

    if (!approved) {
      return { success: false, output: '', error: t('calendar.user_rejected') }
    }
  }

  try {
    const uid = generateUID()
    const dueDate = dueStr ? new Date(dueStr) : undefined

    const icalData = buildICalTodo({
      uid,
      title,
      due: dueDate,
      priority,
      description,
      categories,
      status: 'needs-action'
    })

    const response = await session.client.createCalendarObject({
      calendar: { url: calendarId },
      filename: `${uid}.ics`,
      iCalString: icalData
    })

    // tsdav 只返回 Response、不校验 ok，服务端拒绝时不会抛异常
    if (!response.ok) {
      return {
        success: false,
        output: '',
        error: await describeWriteFailure('create', response.status, undefined, calendarId, session)
      }
    }

    // 回读核验：读不到、或标题对不上，都不能报「已创建」
    const verified = await verifyTodoWritten(calendarId, uid, { title }, session, 'create')
    if (!verified.ok) {
      return { success: false, output: '', error: verified.error }
    }

    const output = t('calendar.todo_created', { title })
    executor.addStep({
      type: 'tool_result',
      content: output,
      toolName: 'calendar_todo_create',
      toolResult: output
    })

    return { success: true, output }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : t('calendar.todo_create_failed')
    return { success: false, output: '', error: errorMsg }
  }
}

/**
 * 更新待办事项
 */
async function todoUpdate(
  args: Record<string, unknown>,
  toolCallId: string,
  config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const calendarId = args.calendar_id as string
  const todoId = args.todo_id as string
  const title = args.title as string | undefined
  const dueStr = args.due as string | undefined
  const priority = args.priority as number | undefined
  const status = args.status as string | undefined
  const percentComplete = args.percent_complete as number | undefined
  const description = args.description as string | undefined
  const categories = args.categories as string[] | undefined

  if (!calendarId || !todoId) {
    return { success: false, output: '', error: t('calendar.todo_id_required') }
  }

  const session = getFirstOpenSession()
  if (!session || !session.client) {
    return { success: false, output: '', error: t('calendar.not_connected') }
  }

  try {
    // 通过 UID 获取待办事项
    const todoObj = await fetchTodoByUid(calendarId, todoId, session)
    if (!todoObj) {
      return { success: false, output: '', error: t('calendar.todo_not_found', { id: todoId }) }
    }

    const originalTodo = parseICalTodo(todoObj.data, todoObj.url, todoObj.etag)
    if (!originalTodo) {
      return { success: false, output: '', error: t('calendar.event_parse_failed') }
    }

    // 构建变更列表
    const changes: string[] = []
    if (title && title !== originalTodo.title) changes.push(`${t('calendar.title')}: ${originalTodo.title} → ${title}`)
    if (dueStr) {
      const oldDue = originalTodo.due ? formatDateTime(originalTodo.due) : t('calendar.todo_no_due')
      changes.push(`${t('calendar.todo_due')}: ${oldDue} → ${dueStr}`)
    }
    if (priority !== undefined && priority !== originalTodo.priority) {
      changes.push(`${t('calendar.todo_priority')}: ${formatPriority(originalTodo.priority || 0)} → ${formatPriority(priority)}`)
    }
    if (status && status !== originalTodo.status) {
      changes.push(`${t('calendar.todo_status')}: ${formatTodoStatus(originalTodo.status)} → ${formatTodoStatus(status)}`)
    }
    if (percentComplete !== undefined && percentComplete !== originalTodo.percentComplete) {
      changes.push(`${t('calendar.todo_progress')}: ${originalTodo.percentComplete || 0}% → ${percentComplete}%`)
    }
    if (description !== undefined && description !== originalTodo.description) {
      changes.push(`${t('calendar.todo_description')}: ${t('calendar.todo_updated_field')}`)
    }
    if (categories && JSON.stringify(categories) !== JSON.stringify(originalTodo.categories)) {
      changes.push(`${t('calendar.todo_categories')}: ${categories.join(', ')}`)
    }

    if (changes.length === 0) {
      return { success: false, output: '', error: t('calendar.no_changes') }
    }

    let confirmInfo = `${t('calendar.todo_update_confirm')}\n\n`
    confirmInfo += `**${t('calendar.todo_item')}**: ${originalTodo.title}\n\n`
    confirmInfo += `**${t('calendar.changes')}**:\n${changes.map(c => `- ${c}`).join('\n')}`

    executor.addStep({
      type: 'tool_call',
      content: confirmInfo,
      toolName: 'calendar_todo_update',
      toolArgs: { todo_id: todoId, changes },
      riskLevel: 'moderate'
    })

    if (riskNeedsConfirm('moderate', config.executionMode, config.commandRiskPolicy)) {
      const approved = await executor.waitForConfirmation(
        toolCallId,
        'calendar_todo_update',
        { todo_id: todoId },
        'moderate'
      )

      if (!approved) {
        return { success: false, output: '', error: t('calendar.user_rejected') }
      }
    }

    // 构建更新后的 VTODO
    const updatedTodo = {
      uid: originalTodo.uid,
      title: title || originalTodo.title,
      due: dueStr ? new Date(dueStr) : originalTodo.due,
      priority: priority !== undefined ? priority : originalTodo.priority,
      status: (status || originalTodo.status || 'needs-action') as CalendarTodo['status'],
      percentComplete: percentComplete !== undefined ? percentComplete : originalTodo.percentComplete,
      description: description !== undefined ? description : originalTodo.description,
      categories: categories || originalTodo.categories,
      start: originalTodo.start
    }

    // 如果标记为完成，自动设置完成时间和百分比
    if (status === 'completed') {
      updatedTodo.percentComplete = 100
    }

    const icalData = buildICalTodo(updatedTodo)

    const response = await session.client.updateCalendarObject({
      calendarObject: {
        url: todoObj.url,
        etag: todoObj.etag,
        data: icalData
      }
    })

    if (!response.ok) {
      return {
        success: false,
        output: '',
        error: await describeWriteFailure('update', response.status, undefined, todoObj.url, session)
      }
    }

    // 回读核验：这次改了标题或状态的，读回来要对得上
    const verified = await verifyTodoWritten(
      calendarId,
      todoId,
      {
        title: title && title !== originalTodo.title ? updatedTodo.title : undefined,
        status: status ? updatedTodo.status : undefined
      },
      session,
      'update'
    )
    if (!verified.ok) {
      return { success: false, output: '', error: verified.error }
    }

    const output = t('calendar.todo_updated', { title: updatedTodo.title })
    executor.addStep({
      type: 'tool_result',
      content: output,
      toolName: 'calendar_todo_update',
      toolResult: output
    })

    return { success: true, output }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : t('calendar.todo_update_failed')
    return { success: false, output: '', error: errorMsg }
  }
}

/**
 * 删除待办事项
 */
async function todoDelete(
  args: Record<string, unknown>,
  toolCallId: string,
  config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const calendarId = args.calendar_id as string
  const todoIds = args.todo_ids as string[]

  if (!calendarId || !todoIds || todoIds.length === 0) {
    return { success: false, output: '', error: t('calendar.todo_ids_required') }
  }

  const session = getFirstOpenSession()
  if (!session || !session.client) {
    return { success: false, output: '', error: t('calendar.not_connected') }
  }

  try {
    const todosToDelete: Array<{ url: string; etag?: string; title: string }> = []

    for (const todoId of todoIds) {
      const todoObj = await fetchTodoByUid(calendarId, todoId, session)
      if (todoObj) {
        const todo = parseICalTodo(todoObj.data, todoObj.url, todoObj.etag)
        if (todo) {
          todosToDelete.push({
            url: todoObj.url,
            etag: todoObj.etag,
            title: todo.title
          })
        }
      }
    }

    if (todosToDelete.length === 0) {
      return { success: false, output: '', error: t('calendar.todos_not_found') }
    }

    let confirmInfo = `${t('calendar.todo_delete_confirm')}\n\n`
    confirmInfo += `**${t('calendar.todos_to_delete')}** (${todosToDelete.length}):\n`
    confirmInfo += todosToDelete.map(e => `- ${e.title}`).join('\n')

    executor.addStep({
      type: 'tool_call',
      content: confirmInfo,
      toolName: 'calendar_todo_delete',
      toolArgs: { count: todosToDelete.length },
      riskLevel: 'moderate'
    })

    if (riskNeedsConfirm('moderate', config.executionMode, config.commandRiskPolicy)) {
      const approved = await executor.waitForConfirmation(
        toolCallId,
        'calendar_todo_delete',
        { count: todosToDelete.length },
        'moderate'
      )

      if (!approved) {
        return { success: false, output: '', error: t('calendar.user_rejected') }
      }
    }

    const deletedTitles: string[] = []
    const failures: string[] = []
    for (const todo of todosToDelete) {
      try {
        const response = await session.client.deleteCalendarObject({
          calendarObject: {
            url: todo.url,
            etag: todo.etag
          }
        })
        if (!response.ok) {
          failures.push(`${todo.title}：${await describeWriteFailure('delete', response.status, undefined, todo.url, session)}`)
          continue
        }
        const notDeleted = deleteFailureMessage(await verifyResourceDeleted(todo.url, session))
        if (notDeleted) {
          failures.push(`${todo.title}：${notDeleted}`)
          continue
        }
        deletedTitles.push(todo.title)
      } catch (e) {
        log.error(`Failed to delete todo: ${todo.title}`, e)
        failures.push(`${todo.title}：${e instanceof Error ? e.message : String(e)}`)
      }
    }

    // 只要有没删掉的，整体不报成功；已删掉的与没删掉的分别列出
    if (failures.length > 0) {
      return {
        success: false,
        output: '',
        error: deletedTitles.length === 0
          ? failures.join('；')
          : t('calendar.deleted_with_failures', {
            count: deletedTitles.length,
            deleted: deletedTitles.join('、'),
            failures: failures.join('；')
          })
      }
    }

    const output = t('calendar.todos_deleted', { count: deletedTitles.length })
    executor.addStep({
      type: 'tool_result',
      content: output,
      toolName: 'calendar_todo_delete',
      toolResult: output
    })

    return { success: true, output }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : t('calendar.todo_delete_failed')
    return { success: false, output: '', error: errorMsg }
  }
}

// ============ 辅助函数 ============

/**
 * 已知不支持 VTODO 的服务商
 * 这些服务商的 CalDAV 实现只支持 VEVENT，不支持 VTODO
 */
const PROVIDERS_WITHOUT_TODO: string[] = [
  'wecom',    // 企业微信
  'google',   // Google Calendar
  'outlook'   // Microsoft Outlook
]

/**
 * 检测 CalDAV 服务器是否支持 VTODO
 * 
 * 策略：
 * 1. 已知不支持的服务商直接返回 false
 * 2. 其他服务商尝试发送 VTODO REPORT 请求探测
 */
async function detectTodoSupport(
  provider: string,
  calendars: Calendar[],
  credential: string,
  username: string
): Promise<boolean> {
  // 已知不支持的服务商直接返回
  if (PROVIDERS_WITHOUT_TODO.includes(provider)) {
    log.info(`Provider "${provider}" is known to not support VTODO`)
    return false
  }

  // 对于未知服务商，尝试发送 VTODO REPORT 探测
  if (calendars.length === 0) {
    return false
  }

  const calendarUrl = calendars[0].id
  if (!calendarUrl) return false

  const authHeader = `Basic ${Buffer.from(`${username}:${credential}`).toString('base64')}`

  try {
    // 发送一个简单的 VTODO REPORT 查询，只要不返回错误就说明支持
    const reportBody = `<?xml version="1.0" encoding="utf-8" ?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <D:getetag/>
  </D:prop>
  <C:filter>
    <C:comp-filter name="VCALENDAR">
      <C:comp-filter name="VTODO"/>
    </C:comp-filter>
  </C:filter>
</C:calendar-query>`

    const response = await fetch(calendarUrl, {
      method: 'REPORT',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/xml; charset=utf-8',
        'Depth': '1'
      },
      body: reportBody
    })

    // 207 Multi-Status 说明服务器能处理 VTODO 查询（即使结果为空）
    // 4xx/5xx 错误说明不支持
    if (response.status === 207) {
      log.info('VTODO support detected via REPORT probe')
      return true
    }

    log.info(`VTODO REPORT probe returned status ${response.status}, assuming not supported`)
    return false
  } catch (error) {
    log.info('VTODO REPORT probe failed, assuming not supported:', error)
    return false
  }
}

/**
 * 通过事件 UID 直接获取单个事件
 * 比 fetchCalendarObjects 获取所有事件要高效得多
 */
async function fetchEventByUid(
  calendarId: string,
  eventUid: string,
  session: import('./session').CalendarSession
): Promise<{ url: string; etag?: string; data: string } | null> {
  // 获取认证凭据
  const credential = await getCalendarCredential(session.accountId)
  if (!credential) return null
  
  const authHeader = `Basic ${Buffer.from(`${session.username}:${credential}`).toString('base64')}`
  
  // 尝试多种 URL 格式
  const possibleUrls = [
    `${calendarId}${eventUid}.ics`,
    `${calendarId}${encodeURIComponent(eventUid)}.ics`,
    `${calendarId.replace(/\/$/, '')}/${eventUid}.ics`,
    `${calendarId.replace(/\/$/, '')}/${encodeURIComponent(eventUid)}.ics`
  ]
  
  for (const eventUrl of possibleUrls) {
    try {
      const response = await fetch(eventUrl, {
        method: 'GET',
        headers: { 'Authorization': authHeader },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      })
      
      if (response.ok) {
        const data = await response.text()
        if (data.includes('VEVENT')) {
          return {
            url: eventUrl,
            etag: response.headers.get('etag') || undefined,
            data
          }
        }
      }
    } catch {
      // 继续尝试下一个 URL
    }
  }
  
  // 如果直接 URL 不行，使用 REPORT 查询
  try {
    const reportBody = `<?xml version="1.0" encoding="utf-8" ?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <D:getetag/>
    <C:calendar-data/>
  </D:prop>
  <C:filter>
    <C:comp-filter name="VCALENDAR">
      <C:comp-filter name="VEVENT">
        <C:prop-filter name="UID">
          <C:text-match collation="i;octet">${eventUid}</C:text-match>
        </C:prop-filter>
      </C:comp-filter>
    </C:comp-filter>
  </C:filter>
</C:calendar-query>`

    const response = await fetch(calendarId, {
      method: 'REPORT',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/xml; charset=utf-8',
        'Depth': '1'
      },
      body: reportBody,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    })
    
    if (response.status === 207) {
      const responseText = await response.text()
      const found = readReportResource(responseText, calendarId, 'VEVENT')
      if (found) return found
    }
  } catch {
    // REPORT 失败
  }
  
  return null
}

/**
 * 写操作被服务端拒绝时，探测当前账户对该资源的写权限。
 * 走标准的 current-user-privilege-set；服务端不支持时返回 unknown。
 * 目的只是把「被拒绝的原因」从猜测收敛到有依据的判断，不支持的场景不硬猜。
 */
async function probeWritePermission(
  resourceUrl: string,
  operation: WriteOperation,
  session: import('./session').CalendarSession
): Promise<'write' | 'read-only' | 'unknown'> {
  try {
    const credential = await getCalendarCredential(session.accountId)
    if (!credential) return 'unknown'
    const authHeader = `Basic ${Buffer.from(`${session.username}:${credential}`).toString('base64')}`

    const response = await fetch(resourceUrl, {
      method: 'PROPFIND',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/xml; charset=utf-8',
        'Depth': '0'
      },
      body: `<?xml version="1.0" encoding="utf-8" ?>
<D:propfind xmlns:D="DAV:">
  <D:prop>
    <D:current-user-privilege-set/>
  </D:prop>
</D:propfind>`,
      signal: AbortSignal.timeout(8000)
    })

    if (!response.ok && response.status !== 207) return 'unknown'
    return readWritePrivilege(await response.text(), operation)
  } catch {
    return 'unknown'
  }
}

/**
 * 把写操作被服务端拒绝的状态码翻译成人能看懂的说明。
 * 403 的原因不止一种（非发起人、日历只读、授权范围不足、服务端策略），
 * 所以先做一次权限取证，取不到就如实列出可能性，不下单因结论。
 */
async function describeWriteFailure(
  operation: WriteOperation,
  status: number,
  organizer: string | undefined,
  resourceUrl: string,
  session: import('./session').CalendarSession
): Promise<string> {
  const hint = organizer && organizerIsOther(organizer, session.username)
    ? t('calendar.organizer_hint', { organizer })
    : ''

  if (status === 401 || status === 403) {
    const probe = await probeWritePermission(resourceUrl, operation, session)
    if (probe === 'read-only') {
      return t('calendar.write_forbidden_readonly', { status, hint })
    }
    if (probe === 'write') {
      return t('calendar.write_forbidden_privileged', { status, hint })
    }
    return t('calendar.write_forbidden', { status, hint })
  }
  // 创建时的 412 是「同名日程已存在」，不是被别人改过
  if (status === 412 && operation !== 'create') {
    return t('calendar.write_conflict', { status })
  }
  return t('calendar.write_rejected', { status })
}

/** 写入后回读前的等待。只在第一次核对不过时用；测试里可以改短 */
export const verifyTiming = { retryDelayMs: 800 }

/** 读取单个日程 / 待办时每次请求的等待上限，服务端卡住时不至于一直挂着 */
const FETCH_TIMEOUT_MS = 15000

/** 核对通过时可带一句需要告诉用户的说明（例如某一项没能核对） */
type VerifyResult = { ok: true; note?: string } | { ok: false; error: string }

/** 在成功说明后面附上核对时发现的情况 */
function withNote(output: string, note: string | undefined): string {
  return note ? `${output}\n${note}` : output
}

/** 核对不过时等一拍再核一次：部分服务端写入后短暂延迟才可见 */
async function checkWithRetry<T extends { ok: boolean }>(check: () => Promise<T>): Promise<T> {
  const first = await check()
  if (first.ok) return first
  await new Promise(resolve => setTimeout(resolve, verifyTiming.retryDelayMs))
  return check()
}

const FIELD_LABEL_KEYS: Record<CheckedField, TranslationKey> = {
  title: 'calendar.title',
  start: 'calendar.start',
  end: 'calendar.end',
  location: 'calendar.location',
  description: 'calendar.description',
  recurrence: 'calendar.recurrence'
}

type VerifyKind = 'create' | 'update'

/** 回读发现对不上时的说明。创建后日程已经在服务端，要提醒别重复创建 */
function mismatchMessage(kind: VerifyKind, field: string, expected: string, actual: string): string {
  return t(kind === 'create' ? 'calendar.create_mismatch' : 'calendar.verify_mismatch', { field, expected, actual })
}

/** 读不到时的说明。创建与修改的后果不同：创建读不到，重复创建可能出现两份 */
function missingMessage(kind: VerifyKind): string {
  return t(kind === 'create' ? 'calendar.create_unconfirmed' : 'calendar.verify_read_failed')
}

/**
 * 写后回读核验：重新拉一次事件，对照这次预期的结果。
 * 服务端回了 2xx 但内容没变的情况并不罕见，这一步避免把「请求发出去」当成「事情办成了」。
 */
async function verifyEventWritten(
  calendarId: string,
  eventId: string,
  expected: ExpectedWrite,
  session: import('./session').CalendarSession,
  kind: VerifyKind
): Promise<VerifyResult> {
  return checkWithRetry<VerifyResult>(async () => {
    const fresh = await fetchEventByUid(calendarId, eventId, session)
    if (!fresh) return { ok: false, error: missingMessage(kind) }

    const parsed = parseICalEvent(fresh.data, fresh.url, fresh.etag)
    if (!parsed) return { ok: false, error: t('calendar.verify_parse_failed') }

    const mismatch = findMismatch(expected, parsed, {
      moment: (date, allDay) => (allDay ? formatDate(date) : formatDateTime(date)),
      recurrence: rrule => (rrule ? formatRecurrenceLabel(rrule) : t('calendar.recurrence_none')),
      empty: t('calendar.value_empty')
    })
    if (mismatch) {
      return {
        ok: false,
        error: mismatchMessage(kind, t(FIELD_LABEL_KEYS[mismatch.field]), mismatch.expected, mismatch.actual)
      }
    }

    // 时区认不出而没能核对的时刻，不能当成对上了：除时刻之外还有别的项核对过，
    // 就照实附一句说明；这次只有时刻可核对，则整体是「未能确认」
    if (unverifiedMoments(expected, parsed).length > 0) {
      const note = t('calendar.verify_time_unconfirmed')
      const checkedOthers = [expected.title, expected.location, expected.description, expected.recurrence]
        .some(value => value !== undefined)
      return checkedOthers ? { ok: true, note } : { ok: false, error: note }
    }
    return { ok: true }
  })
}

/** 待办写入后回读：核对标题与状态（待办没有日程那么多项） */
async function verifyTodoWritten(
  calendarId: string,
  todoId: string,
  expected: { title?: string; status?: NonNullable<CalendarTodo['status']> },
  session: import('./session').CalendarSession,
  kind: VerifyKind
): Promise<VerifyResult> {
  const statusLabel = (status: string) =>
    t(`calendar.todo_status_${status.replace('-', '_')}` as TranslationKey)

  return checkWithRetry<VerifyResult>(async () => {
    const fresh = await fetchTodoByUid(calendarId, todoId, session)
    if (!fresh) return { ok: false, error: missingMessage(kind) }

    const parsed = parseICalTodo(fresh.data, fresh.url, fresh.etag)
    if (!parsed) return { ok: false, error: t('calendar.verify_parse_failed') }

    if (expected.title !== undefined && normalizeText(expected.title) !== normalizeText(parsed.title)) {
      return {
        ok: false,
        error: mismatchMessage(kind, t('calendar.title'), expected.title, parsed.title)
      }
    }
    const actualStatus = parsed.status ?? 'needs-action'
    if (expected.status && expected.status !== actualStatus) {
      return {
        ok: false,
        error: mismatchMessage(kind, t('calendar.todo_status'), statusLabel(expected.status), statusLabel(actualStatus))
      }
    }
    return { ok: true }
  })
}

/** 一个资源现在的状态：还在、没了、没问成 */
type ResourceState = 'present' | 'absent' | 'unknown'

/**
 * 直接问服务端：这个地址上的资源还在不在。
 * 只有明确的「不存在」（404 / 410）才算没了；读取出错、鉴权失败等不能当成没了。
 */
async function probeResourceState(
  resourceUrl: string,
  session: import('./session').CalendarSession
): Promise<ResourceState> {
  try {
    const credential = await getCalendarCredential(session.accountId)
    if (!credential) return 'unknown'
    const authHeader = `Basic ${Buffer.from(`${session.username}:${credential}`).toString('base64')}`
    const response = await fetch(resourceUrl, {
      method: 'GET',
      headers: { 'Authorization': authHeader },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    })
    if (response.status === 404 || response.status === 410) return 'absent'
    if (!response.ok) return 'unknown'
    // 200 但内容不是日历（登录页、网关提示页等）：既不能说它还在，也不能说它没了
    return /BEGIN:V(EVENT|TODO)/.test(await response.text()) ? 'present' : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** 删除后回读：确认那个地址上的资源已经没了。第一次不过再等一拍核一次 */
async function verifyResourceDeleted(
  resourceUrl: string,
  session: import('./session').CalendarSession
): Promise<ResourceState> {
  const result = await checkWithRetry(async () => {
    const state = await probeResourceState(resourceUrl, session)
    return { ok: state === 'absent', state }
  })
  return result.state
}

/** 把删除后回读的结果翻译成失败说明；已删掉返回 null */
function deleteFailureMessage(state: ResourceState): string | null {
  if (state === 'present') return t('calendar.delete_not_applied')
  if (state === 'unknown') return t('calendar.delete_unconfirmed')
  return null
}

function recurrenceReadError(code: RecurrenceReadError): string {
  switch (code) {
    case 'bound_conflict':
      return t('calendar.recurrence_bound_conflict')
    case 'freq_invalid':
      return t('calendar.recurrence_freq_invalid')
    case 'until_invalid':
      return t('calendar.recurrence_until_invalid')
    case 'count_invalid':
      return t('calendar.recurrence_count_invalid')
    case 'freq_required':
      return t('calendar.recurrence_freq_required')
  }
}

function formatRecurrenceLabel(rrule: string): string {
  const view = viewRecurrence(rrule)
  if (!view) return rrule
  let label = t(`calendar.recurrence_${view.freq}` as TranslationKey)
  if (view.until) label += t('calendar.recurrence_until', { date: view.until })
  if (view.count != null) label += t('calendar.recurrence_count', { count: view.count })
  return label
}

/** 单次看开始结束是否落在范围内；重复系列则看到查询结束前还没截止。 */
function eventInRange(event: CalendarEvent, startTime: number, endTime: number): boolean {
  const eventStart = event.start.getTime()
  const eventEnd = event.end.getTime()
  if ((eventStart >= startTime && eventStart <= endTime) ||
      (eventEnd >= startTime && eventEnd <= endTime) ||
      (eventStart <= startTime && eventEnd >= endTime)) {
    return true
  }
  if (!event.recurrence || eventStart > endTime) return false
  return !recurrenceEndedBefore(event.recurrence, new Date(startTime), event.start, event.end)
}

function readAlarmBlock(icalData: string): string | undefined {
  const eventStart = icalData.indexOf('BEGIN:VEVENT')
  const eventEnd = icalData.indexOf('END:VEVENT')
  const scope = eventStart >= 0 && eventEnd > eventStart
    ? icalData.slice(eventStart, eventEnd)
    : icalData
  const start = scope.indexOf('BEGIN:VALARM')
  const end = scope.indexOf('END:VALARM')
  if (start < 0 || end < start) return undefined
  return scope.slice(start, end + 'END:VALARM'.length)
}

/**
 * 从日历 URL 中提取名称
 */
function extractCalendarName(url: string): string {
  const parts = url.split('/')
  const name = parts[parts.length - 2] || parts[parts.length - 1] || 'Calendar'
  return decodeURIComponent(name)
}

/**
 * 解析 iCalendar 事件数据
 */
export function parseICalEvent(icalData: string | undefined, url?: string, etag?: string): CalendarEvent | null {
  if (!icalData) {
    return null
  }
  
  try {
    // 处理折叠行（以空格或制表符开头的行是上一行的续行）
    const unfoldedData = icalData.replace(/\r?\n[ \t]/g, '')
    
    // 简单解析 iCalendar 格式
    const allLines = unfoldedData.split(/\r?\n/)
    // 重复日程里单独改过的场次排在前面时，也要读主日程
    const masterRange = findMasterEventRange(allLines)
    const lines = masterRange ? allLines.slice(masterRange[0], masterRange[1] + 1) : allLines
    let uid = ''
    let summary = ''
    let dtstart = ''
    let dtend = ''
    let duration = ''
    let dtstartTzid = ''
    let dtendTzid = ''
    let location = ''
    let description = ''
    let isAllDay = false
    let inVEvent = false
    let organizer = ''
    const attendees: string[] = []
    // 日程里嵌套的子块（提醒等）深度：子块里的属性不属于日程本身
    let nestedDepth = 0

    // 提取时区信息的辅助函数
    const extractTzid = (line: string): string => {
      const tzidMatch = line.match(/TZID=("[^"]+"|[^:;]+)/)
      return tzidMatch ? tzidMatch[1].replace(/^"|"$/g, '') : ''
    }

    for (const line of lines) {
      // 只解析 VEVENT 块内的内容
      if (line.startsWith('BEGIN:VEVENT')) {
        inVEvent = true
        continue
      }
      if (line.startsWith('END:VEVENT')) {
        break // 只取第一个事件
      }
      if (!inVEvent) continue

      // 提醒（VALARM）等子块里也有 DESCRIPTION 之类的属性，不能算到日程头上
      if (line.startsWith('BEGIN:')) {
        nestedDepth++
        continue
      }
      if (line.startsWith('END:') && nestedDepth > 0) {
        nestedDepth--
        continue
      }
      if (nestedDepth > 0) continue

      if (line.startsWith('UID:')) {
        uid = line.substring(4).trim()
      } else if (line.startsWith('SUMMARY')) {
        // 可能是 SUMMARY: 或 SUMMARY;LANGUAGE=...:
        const colonIdx = line.indexOf(':')
        if (colonIdx !== -1) {
          summary = unescapeICalText(line.substring(colonIdx + 1).trim())
        }
      } else if (line.startsWith('DTSTART')) {
        const match = line.match(/DTSTART[^:]*:(.+)/)
        if (match) {
          dtstart = match[1].trim()
          dtstartTzid = extractTzid(line)
          isAllDay = line.includes('VALUE=DATE') && !line.includes('VALUE=DATE-TIME')
        }
      } else if (line.startsWith('DTEND')) {
        const match = line.match(/DTEND[^:]*:(.+)/)
        if (match) {
          dtend = match[1].trim()
          dtendTzid = extractTzid(line)
        }
      } else if (line.startsWith('DURATION')) {
        const colonIdx = line.indexOf(':')
        if (colonIdx !== -1) duration = line.substring(colonIdx + 1).trim()
      } else if (line.startsWith('LOCATION')) {
        const colonIdx = line.indexOf(':')
        if (colonIdx !== -1) {
          location = unescapeICalText(line.substring(colonIdx + 1).trim())
        }
      } else if (line.startsWith('DESCRIPTION')) {
        const colonIdx = line.indexOf(':')
        if (colonIdx !== -1) {
          description = unescapeICalText(line.substring(colonIdx + 1).trim())
        }
      } else if (line.startsWith('ORGANIZER')) {
        const mail = readCalAddress(line)
        if (mail) organizer = mail
      } else if (line.startsWith('ATTENDEE')) {
        const mail = readCalAddress(line)
        if (mail && !attendees.includes(mail)) attendees.push(mail)
      }
    }

    // 如果没有找到 VEVENT 块，尝试直接解析（兼容简化格式）
    if (!inVEvent) {
      for (const line of lines) {
        if (line.startsWith('UID:')) {
          uid = line.substring(4).trim()
        } else if (line.startsWith('SUMMARY')) {
          const colonIdx = line.indexOf(':')
          if (colonIdx !== -1) {
            summary = unescapeICalText(line.substring(colonIdx + 1).trim())
          }
        } else if (line.startsWith('DTSTART')) {
          const match = line.match(/DTSTART[^:]*:(.+)/)
          if (match) {
            dtstart = match[1].trim()
            dtstartTzid = extractTzid(line)
            isAllDay = line.includes('VALUE=DATE') && !line.includes('VALUE=DATE-TIME')
          }
        } else if (line.startsWith('DTEND')) {
          const match = line.match(/DTEND[^:]*:(.+)/)
          if (match) {
            dtend = match[1].trim()
            dtendTzid = extractTzid(line)
          }
        }
      }
    }

    if (!uid || !dtstart) {
      log.info('Missing required fields - uid:', uid, 'dtstart:', dtstart, 'summary:', summary)
      return null
    }

    // 如果没有标题，使用 "(无标题)" 
    if (!summary) {
      summary = '(无标题)'
    }

    const alarmBlock = readAlarmBlock(unfoldedData)
    const startMoment = resolveICalDate(dtstart, dtstartTzid)
    const endMoment = dtend ? resolveICalDate(dtend, dtendTzid || dtstartTzid) : null
    // 没有结束时间时：有时长就按时长算；全天日程按一天；其余结束即开始
    const spanned = parseICalDuration(duration)
    const end = endMoment
      ? endMoment.date
      : spanned
        ? addICalDuration(startMoment.date, spanned, isAllDay)
        : isAllDay
          ? addICalDuration(startMoment.date, { days: 1, ms: 0 }, true)
          : startMoment.date
    return {
      uid,
      title: summary,
      start: startMoment.date,
      end,
      timeZoneUnknown: !startMoment.resolved || (endMoment ? !endMoment.resolved : false) || undefined,
      allDay: isAllDay,
      location: location || undefined,
      description: description || undefined,
      // 只在主日程里找：单独改过的场次排在前面时，整份文本里第一个日程并不带规则
      recurrence: readRRuleValue(lines.join('\n')),
      alarmBlock,
      organizer: organizer || undefined,
      attendees: attendees.length > 0 ? attendees : undefined,
      url,
      etag
    }
  } catch (error) {
    log.error('Failed to parse iCal event:', error, 'Data:', icalData?.substring(0, 500))
    return null
  }
}

/**
 * 解析 iCalendar 日期格式。
 * resolved 为 false 表示原始数据里的时区认不出来，时刻只是按本机时区估的。
 */
function resolveICalDate(dateStr: string, tzid?: string): { date: Date; resolved: boolean } {
  // 格式: 20240115T090000Z 或 20240115 或带时区 20240115T090000
  if (dateStr.length === 8) {
    // 全天事件 YYYYMMDD
    const year = parseInt(dateStr.substring(0, 4))
    const month = parseInt(dateStr.substring(4, 6)) - 1
    const day = parseInt(dateStr.substring(6, 8))
    return { date: new Date(year, month, day), resolved: true }
  }

  // 带时间 YYYYMMDDTHHMMSS 或 YYYYMMDDTHHMMSSZ
  const cleanStr = dateStr.replace('Z', '')
  const year = parseInt(cleanStr.substring(0, 4))
  const month = parseInt(cleanStr.substring(4, 6)) - 1
  const day = parseInt(cleanStr.substring(6, 8))
  const hour = parseInt(cleanStr.substring(9, 11)) || 0
  const minute = parseInt(cleanStr.substring(11, 13)) || 0
  const second = parseInt(cleanStr.substring(13, 15)) || 0

  if (dateStr.endsWith('Z')) {
    // UTC 时间
    return { date: new Date(Date.UTC(year, month, day, hour, minute, second)), resolved: true }
  }

  // 没有时区标识的是「浮动时间」，本来就按本机时间理解
  if (!tzid) {
    return { date: new Date(year, month, day, hour, minute, second), resolved: true }
  }

  // 标准时区名（Asia/Shanghai、Europe/Berlin 等）按真实规则换算，含夏令时
  const zoned = zonedToUtc(year, month + 1, day, hour, minute, second, tzid)
  if (zoned) return { date: zoned, resolved: true }

  // 非标准写法：企业微信用 TZ08 表示 UTC+8
  const tzOffsets: Record<string, number> = {
    'TZ08': 8, 'TZ09': 9, 'TZ00': 0, 'TZ-05': -5, 'TZ-08': -8
  }
  if (tzOffsets[tzid] !== undefined) {
    return { date: new Date(Date.UTC(year, month, day, hour - tzOffsets[tzid], minute, second)), resolved: true }
  }

  // 认不出的时区：按本机时区估一个，并如实标明不可信
  return { date: new Date(year, month, day, hour, minute, second), resolved: false }
}

function parseICalDate(dateStr: string, tzid?: string): Date {
  return resolveICalDate(dateStr, tzid).date
}

/**
 * 反转义 iCalendar 文本
 */
function unescapeICalText(text: string): string {
  // 一次扫完：分步替换会把「反斜杠 + n」先误当成换行
  return text.replace(/\\([nN,;\\])/g, (_match, ch: string) => (ch === 'n' || ch === 'N' ? '\n' : ch))
}

/**
 * 转义 iCalendar 文本
 */
function escapeICalText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n')
}

/**
 * 按 RFC 5545 把一行折叠到 75 字节以内（续行以单个空格开头），
 * 避免长描述、长地点被服务端拒收。
 */
export function foldICalLine(line: string): string {
  const bytes = Buffer.from(line, 'utf8')
  if (bytes.length <= 75) return line

  const chunks: string[] = []
  let current = ''
  let currentBytes = 0
  for (const char of line) {
    const charBytes = Buffer.byteLength(char, 'utf8')
    const limit = chunks.length === 0 ? 75 : 74
    if (currentBytes + charBytes > limit) {
      chunks.push(current)
      current = char
      currentBytes = charBytes
    } else {
      current += char
      currentBytes += charBytes
    }
  }
  if (current) chunks.push(current)
  return chunks.join('\r\n ')
}

/**
 * 在原始 iCalendar 数据上做字段级替换。
 *
 * 与 buildICalEvent 重建整份数据不同，这里只动传入的那几项，
 * ORGANIZER、ATTENDEE、STATUS、CLASS、提醒等一律原样保留——否则他人发起的会议邀请
 * 会被抹成一份没有发起人、没有参会人的孤立事件，服务端要么拒收要么忽略。
 * 只改主日程（重复日程里单独改过的场次不动），按规范递增 SEQUENCE、刷新 DTSTAMP；
 * 提醒等子块里的同名属性（如提醒的 DESCRIPTION）不算日程自己的。
 */
export function patchICalEvent(
  originalData: string,
  patch: {
    title?: string
    start?: Date
    end?: Date
    allDay?: boolean
    location?: string
    description?: string
    rrule?: string
  }
): string {
  const lines = originalData.replace(/\r?\n[ \t]/g, '').split(/\r?\n/)
  const updates = new Map<string, string | null>()

  if (patch.title !== undefined) {
    updates.set('SUMMARY', `SUMMARY:${escapeICalText(patch.title)}`)
  }
  if (patch.start) {
    updates.set('DTSTART', patch.allDay
      ? `DTSTART;VALUE=DATE:${formatICalDate(patch.start, true)}`
      : `DTSTART:${formatICalDateUTC(patch.start)}`)
  }
  if (patch.end) {
    updates.set('DTEND', patch.allDay
      ? `DTEND;VALUE=DATE:${formatICalDate(patch.end, true)}`
      : `DTEND:${formatICalDateUTC(patch.end)}`)
  }
  if (patch.location !== undefined) {
    updates.set('LOCATION', patch.location ? `LOCATION:${escapeICalText(patch.location)}` : null)
  }
  if (patch.description !== undefined) {
    updates.set('DESCRIPTION', patch.description ? `DESCRIPTION:${escapeICalText(patch.description)}` : null)
  }
  if (patch.rrule !== undefined) {
    updates.set('RRULE', patch.rrule ? `RRULE:${patch.rrule}` : null)
  }

  const out: string[] = []
  const applied = new Set<string>()
  // 只改主日程；重复日程里单独改过的场次（带 RECURRENCE-ID）和其它组件原样放过
  const range = findMasterEventRange(lines)
  let nestedDepth = 0
  let sequenceSeen = false
  let dtstampSeen = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!range || i <= range[0] || i > range[1]) {
      out.push(line)
      continue
    }

    if (i === range[1]) {
      // 原日程里没有的属性，在日程结束前补上
      for (const [key, value] of updates) {
        if (!applied.has(key) && value !== null) out.push(value)
      }
      if (!sequenceSeen) out.push('SEQUENCE:1')
      if (!dtstampSeen) out.push(`DTSTAMP:${formatICalDateUTC(new Date())}`)
      out.push(line)
      continue
    }

    if (line.startsWith('BEGIN:')) {
      nestedDepth++
      out.push(line)
      continue
    }
    if (nestedDepth > 0) {
      if (line.startsWith('END:')) nestedDepth--
      out.push(line)
      continue
    }

    const key = line.split(/[;:]/, 1)[0].toUpperCase()

    if (updates.has(key)) {
      const value = updates.get(key)
      // 同名属性重复出现时，只在第一处落笔
      if (!applied.has(key) && typeof value === 'string') out.push(value)
      applied.add(key)
      continue
    }
    // 写入结束时间后，不能再留着时长：两者并存不合规
    if (key === 'DURATION' && typeof updates.get('DTEND') === 'string') continue
    if (key === 'SEQUENCE') {
      const parsed = parseInt(line.substring(line.indexOf(':') + 1), 10)
      out.push(`SEQUENCE:${Number.isFinite(parsed) ? parsed + 1 : 1}`)
      sequenceSeen = true
      continue
    }
    if (key === 'DTSTAMP') {
      out.push(`DTSTAMP:${formatICalDateUTC(new Date())}`)
      dtstampSeen = true
      continue
    }
    out.push(line)
  }

  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  return out.map(foldICalLine).join('\r\n') + '\r\n'
}

/**
 * 构建 iCalendar 事件数据
 */
export function buildICalEvent(params: {
  uid: string
  title: string
  start: Date
  end: Date
  allDay: boolean
  location?: string
  description?: string
  reminderMinutes?: number
  /** 修改时原样写回，避免把已有提醒换成另一种 */
  alarmBlock?: string
  /** RRULE 正文，不含前缀 */
  rrule?: string
}): string {
  const { uid, title, start, end, allDay, location, description, reminderMinutes, alarmBlock, rrule } = params
  
  const now = new Date()
  // DTSTAMP 与定时事件的 DTSTART/DTEND 一律用 UTC 带 Z，
  // 避免写成「浮动时间」后被各端按本地时区各自解释导致时间漂移
  const dtstamp = formatICalDateUTC(now)
  
  let dtstart: string
  let dtend: string
  
  if (allDay) {
    // 全天事件用本地日期，转 UTC 会因时区偏移落到前一天
    dtstart = `DTSTART;VALUE=DATE:${formatICalDate(start, true)}`
    dtend = `DTEND;VALUE=DATE:${formatICalDate(end, true)}`
  } else {
    dtstart = `DTSTART:${formatICalDateUTC(start)}`
    dtend = `DTEND:${formatICalDateUTC(end)}`
  }
  
  let ical = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//SailFish//Calendar//EN
BEGIN:VEVENT
UID:${uid}
DTSTAMP:${dtstamp}
${dtstart}
${dtend}
SUMMARY:${escapeICalText(title)}`

  if (location) {
    ical += `\nLOCATION:${escapeICalText(location)}`
  }
  
  if (description) {
    ical += `\nDESCRIPTION:${escapeICalText(description)}`
  }
  
  if (reminderMinutes && reminderMinutes > 0) {
    ical += `
BEGIN:VALARM
TRIGGER:-PT${reminderMinutes}M
ACTION:DISPLAY
DESCRIPTION:Reminder
END:VALARM`
  } else if (alarmBlock) {
    ical += `\n${alarmBlock}`
  }
  
  if (rrule) {
    ical += `\nRRULE:${rrule}`
  }
  
  ical += `
END:VEVENT
END:VCALENDAR`

  // 按规范：每行以回车换行结尾，超过 75 字节的行折叠
  return ical.split(/\r?\n/).map(foldICalLine).join('\r\n') + '\r\n'
}

/**
 * 格式化日期为 iCalendar 格式
 */
function formatICalDate(date: Date, dateOnly: boolean): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  
  if (dateOnly) {
    return `${year}${month}${day}`
  }
  
  const hour = String(date.getHours()).padStart(2, '0')
  const minute = String(date.getMinutes()).padStart(2, '0')
  const second = String(date.getSeconds()).padStart(2, '0')
  
  return `${year}${month}${day}T${hour}${minute}${second}`
}

/**
 * 格式化日期为 iCalendar UTC 格式（用于 CalDAV 查询）
 */
function formatICalDateUTC(date: Date): string {
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  const hour = String(date.getUTCHours()).padStart(2, '0')
  const minute = String(date.getUTCMinutes()).padStart(2, '0')
  const second = String(date.getUTCSeconds()).padStart(2, '0')
  
  return `${year}${month}${day}T${hour}${minute}${second}Z`
}

/**
 * 生成唯一 UID
 */
function generateUID(): string {
  const timestamp = Date.now().toString(36)
  const random = Math.random().toString(36).substring(2, 10)
  return `${timestamp}-${random}@sfterminal`
}

/**
 * 格式化日期显示
 */
function formatDate(date: Date): string {
  return date.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  })
}

/**
 * 格式化时间显示
 */
function formatTime(date: Date): string {
  return date.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit'
  })
}

/**
 * 格式化日期时间显示
 */
function formatDateTime(date: Date): string {
  return `${formatDate(date)} ${formatTime(date)}`
}

/**
 * 截断输出
 */
function truncateOutput(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  return text.slice(0, maxLength) + '\n\n... (' + t('calendar.output_truncated') + ')'
}

// ============ 待办事项辅助函数 ============

/**
 * 通过待办 UID 直接获取单个待办事项
 */
async function fetchTodoByUid(
  calendarId: string,
  todoUid: string,
  session: import('./session').CalendarSession
): Promise<{ url: string; etag?: string; data: string } | null> {
  const credential = await getCalendarCredential(session.accountId)
  if (!credential) return null

  const authHeader = `Basic ${Buffer.from(`${session.username}:${credential}`).toString('base64')}`

  // 尝试多种 URL 格式（与事件相同的策略）
  const possibleUrls = [
    `${calendarId}${todoUid}.ics`,
    `${calendarId}${encodeURIComponent(todoUid)}.ics`,
    `${calendarId.replace(/\/$/, '')}/${todoUid}.ics`,
    `${calendarId.replace(/\/$/, '')}/${encodeURIComponent(todoUid)}.ics`
  ]

  for (const todoUrl of possibleUrls) {
    try {
      const response = await fetch(todoUrl, {
        method: 'GET',
        headers: { 'Authorization': authHeader },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      })

      if (response.ok) {
        const data = await response.text()
        if (data.includes('VTODO')) {
          return {
            url: todoUrl,
            etag: response.headers.get('etag') || undefined,
            data
          }
        }
      }
    } catch {
      // 继续尝试下一个 URL
    }
  }

  // 如果直接 URL 不行，使用 REPORT 查询
  try {
    const reportBody = `<?xml version="1.0" encoding="utf-8" ?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <D:getetag/>
    <C:calendar-data/>
  </D:prop>
  <C:filter>
    <C:comp-filter name="VCALENDAR">
      <C:comp-filter name="VTODO">
        <C:prop-filter name="UID">
          <C:text-match collation="i;octet">${todoUid}</C:text-match>
        </C:prop-filter>
      </C:comp-filter>
    </C:comp-filter>
  </C:filter>
</C:calendar-query>`

    const response = await fetch(calendarId, {
      method: 'REPORT',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/xml; charset=utf-8',
        'Depth': '1'
      },
      body: reportBody,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    })

    if (response.status === 207) {
      const responseText = await response.text()
      const found = readReportResource(responseText, calendarId, 'VTODO')
      if (found) return found
    }
  } catch {
    // REPORT 失败
  }

  return null
}

/**
 * 解析 iCalendar VTODO 数据
 */
function parseICalTodo(icalData: string | undefined, url?: string, etag?: string): CalendarTodo | null {
  if (!icalData) return null

  try {
    // 处理折叠行
    const unfoldedData = icalData.replace(/\r?\n[ \t]/g, '')
    const lines = unfoldedData.split(/\r?\n/)

    let uid = ''
    let summary = ''
    let due = ''
    let dueTzid = ''
    let dtstart = ''
    let dtstartTzid = ''
    let completedDate = ''
    let priority = 0
    let status = ''
    let percentComplete = -1
    let description = ''
    let categories = ''
    let inVTodo = false

    const extractTzid = (line: string): string => {
      const tzidMatch = line.match(/TZID=([^:;]+)/)
      return tzidMatch ? tzidMatch[1] : ''
    }

    for (const line of lines) {
      if (line.startsWith('BEGIN:VTODO')) {
        inVTodo = true
        continue
      }
      if (line.startsWith('END:VTODO')) {
        break
      }
      if (!inVTodo) continue

      if (line.startsWith('UID:')) {
        uid = line.substring(4).trim()
      } else if (line.startsWith('SUMMARY')) {
        const colonIdx = line.indexOf(':')
        if (colonIdx !== -1) {
          summary = unescapeICalText(line.substring(colonIdx + 1).trim())
        }
      } else if (line.startsWith('DUE')) {
        const match = line.match(/DUE[^:]*:(.+)/)
        if (match) {
          due = match[1].trim()
          dueTzid = extractTzid(line)
        }
      } else if (line.startsWith('DTSTART')) {
        const match = line.match(/DTSTART[^:]*:(.+)/)
        if (match) {
          dtstart = match[1].trim()
          dtstartTzid = extractTzid(line)
        }
      } else if (line.startsWith('COMPLETED')) {
        const match = line.match(/COMPLETED[^:]*:(.+)/)
        if (match) {
          completedDate = match[1].trim()
        }
      } else if (line.startsWith('PRIORITY:')) {
        priority = parseInt(line.substring(9).trim()) || 0
      } else if (line.startsWith('STATUS:')) {
        status = line.substring(7).trim()
      } else if (line.startsWith('PERCENT-COMPLETE:')) {
        percentComplete = parseInt(line.substring(17).trim()) || 0
      } else if (line.startsWith('DESCRIPTION')) {
        const colonIdx = line.indexOf(':')
        if (colonIdx !== -1) {
          description = unescapeICalText(line.substring(colonIdx + 1).trim())
        }
      } else if (line.startsWith('CATEGORIES')) {
        const colonIdx = line.indexOf(':')
        if (colonIdx !== -1) {
          categories = line.substring(colonIdx + 1).trim()
        }
      }
    }

    if (!uid) return null

    if (!summary) {
      summary = '(无标题)'
    }

    // 映射 iCal STATUS 到内部状态
    const statusMap: Record<string, CalendarTodo['status']> = {
      'NEEDS-ACTION': 'needs-action',
      'IN-PROCESS': 'in-process',
      'COMPLETED': 'completed',
      'CANCELLED': 'cancelled'
    }

    // 按未转义的逗号分割（即不是 \, 的逗号），然后反转义
    const parsedCategories = categories
      ? categories.split(/(?<!\\),/).map(c => unescapeICalText(c.trim())).filter(Boolean)
      : undefined

    return {
      uid,
      title: summary,
      due: due ? parseICalDate(due, dueTzid) : undefined,
      start: dtstart ? parseICalDate(dtstart, dtstartTzid) : undefined,
      completed: completedDate ? parseICalDate(completedDate) : undefined,
      priority: priority || undefined,
      status: statusMap[status] || 'needs-action',
      percentComplete: percentComplete >= 0 ? percentComplete : undefined,
      description: description || undefined,
      categories: parsedCategories,
      url,
      etag
    }
  } catch (error) {
    log.error('Failed to parse iCal todo:', error, 'Data:', icalData?.substring(0, 500))
    return null
  }
}

/**
 * 构建 iCalendar VTODO 数据
 */
function buildICalTodo(params: {
  uid: string
  title: string
  due?: Date
  start?: Date
  priority?: number
  status?: CalendarTodo['status']
  percentComplete?: number
  description?: string
  categories?: string[]
}): string {
  const { uid, title, due, start, priority, status, percentComplete, description, categories } = params

  const now = new Date()
  const dtstamp = formatICalDate(now, false)

  let ical = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//SailFish//Calendar//EN
BEGIN:VTODO
UID:${uid}
DTSTAMP:${dtstamp}
SUMMARY:${escapeICalText(title)}`

  if (start) {
    ical += `\nDTSTART:${formatICalDate(start, false)}`
  }

  if (due) {
    ical += `\nDUE:${formatICalDate(due, false)}`
  }

  if (priority !== undefined && priority > 0) {
    ical += `\nPRIORITY:${priority}`
  }

  // 映射状态到 iCal 格式
  const statusICalMap: Record<string, string> = {
    'needs-action': 'NEEDS-ACTION',
    'in-process': 'IN-PROCESS',
    'completed': 'COMPLETED',
    'cancelled': 'CANCELLED'
  }
  if (status) {
    ical += `\nSTATUS:${statusICalMap[status] || 'NEEDS-ACTION'}`
  }

  if (percentComplete !== undefined && percentComplete >= 0) {
    ical += `\nPERCENT-COMPLETE:${percentComplete}`
  }

  // 如果状态为完成，添加完成时间
  if (status === 'completed') {
    ical += `\nCOMPLETED:${formatICalDate(now, false)}`
  }

  if (description) {
    ical += `\nDESCRIPTION:${escapeICalText(description)}`
  }

  if (categories?.length) {
    ical += `\nCATEGORIES:${categories.map(c => escapeICalText(c)).join(',')}`
  }

  ical += `
END:VTODO
END:VCALENDAR`

  return ical
}

/**
 * 格式化优先级显示
 */
function formatPriority(priority: number): string {
  if (priority >= 1 && priority <= 4) return '🔴 ' + t('calendar.todo_priority_high')
  if (priority === 5) return '🟡 ' + t('calendar.todo_priority_medium')
  if (priority >= 6 && priority <= 9) return '🔵 ' + t('calendar.todo_priority_low')
  return ''
}

/**
 * 格式化待办状态显示
 */
function formatTodoStatus(status?: string): string {
  switch (status) {
    case 'needs-action': return t('calendar.todo_status_needs_action')
    case 'in-process': return t('calendar.todo_status_in_process')
    case 'completed': return t('calendar.todo_status_completed')
    case 'cancelled': return t('calendar.todo_status_cancelled')
    default: return t('calendar.todo_status_needs_action')
  }
}
