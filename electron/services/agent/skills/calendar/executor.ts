/**
 * 日历技能执行器
 */

import type { ToolResult, AgentConfig } from '../../types'
import type { ToolExecutorConfig } from '../../tool-executor'
import { t } from '../../i18n'
import { getCalendarCredential } from '../../../credential.service'
import {
  isSessionOpen,
  getSession,
  createSession,
  closeSession,
  getServerConfig,
  getFirstOpenSession,
  updateSessionCalendars,
  getDAVCalendar
} from './session'
import type { 
  Calendar, 
  CalendarEvent, 
  CalendarAccountConfig,
  CreateEventParams,
  UpdateEventParams,
  DeleteEventParams
} from './types'

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
  await initDependencies()

  switch (toolName) {
    case 'calendar_connect':
      return await calendarConnect(args, executor)
    case 'calendar_list':
      return await calendarList(args, executor)
    case 'calendar_create':
      return await calendarCreate(args, toolCallId, config, executor)
    case 'calendar_update':
      return await calendarUpdate(args, toolCallId, config, executor)
    case 'calendar_delete':
      return await calendarDelete(args, toolCallId, config, executor)
    default:
      return { success: false, output: '', error: t('error.unknown_tool', { name: toolName }) }
  }
}

/**
 * 连接日历
 */
async function calendarConnect(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const accountId = args.account_id as string | undefined
  const account = getCalendarAccount(accountId)

  if (!account) {
    return {
      success: false,
      output: '',
      error: cachedAccounts.length === 0
        ? t('calendar.no_accounts_configured')
        : t('calendar.account_not_found', { id: accountId || 'unknown' })
    }
  }

  // 检查是否已连接
  if (isSessionOpen(account.id)) {
    const existingSession = getSession(account.id)
    if (existingSession?.connected && existingSession?.client) {
      const output = t('calendar.already_connected', { name: account.name })
      executor.addStep({
        type: 'tool_result',
        content: output,
        toolName: 'calendar_connect',
        toolResult: output
      })
      return { success: true, output }
    }
    // 连接已断开，先关闭旧会话再重新连接
    console.log(`[CalendarSkill] Connection lost for ${account.name}, reconnecting...`)
    await closeSession(account.id)
  }

  // 获取凭据
  const credential = await getCalendarCredential(account.id)
  if (!credential) {
    return {
      success: false,
      output: '',
      error: t('calendar.credential_not_found', { name: account.name })
    }
  }

  // 获取服务器配置
  const serverConfig = getServerConfig(account.provider, account.serverUrl)

  try {
    // 创建 CalDAV 客户端
    const client = new tsdav.DAVClient({
      serverUrl: serverConfig.serverUrl,
      credentials: {
        username: account.username,
        password: credential
      },
      authMethod: 'Basic',
      defaultAccountType: 'caldav'
    })

    // 登录
    await client.login()

    // 获取日历列表
    const davCalendars = await client.fetchCalendars()
    
    const calendars: Calendar[] = davCalendars.map(cal => ({
      id: cal.url || '',
      name: typeof cal.displayName === 'string' ? cal.displayName : extractCalendarName(cal.url || ''),
      description: typeof cal.description === 'string' ? cal.description : undefined,
      color: typeof cal.calendarColor === 'string' ? cal.calendarColor : undefined,
      readonly: false,
      url: cal.url
    }))

    // 创建会话，同时保存原始的 DAVCalendar 对象用于后续 API 调用
    createSession(account.id, account.name, account.username, client, calendars, davCalendars)

    const output = t('calendar.connected', { 
      name: account.name, 
      count: calendars.length 
    })
    executor.addStep({
      type: 'tool_result',
      content: output,
      toolName: 'calendar_connect',
      toolResult: output
    })

    return { success: true, output }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : t('calendar.connect_failed')
    return { success: false, output: '', error: errorMsg }
  }
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

      const calendarList = session.calendars.map(cal => {
        const readonly = cal.readonly ? ' (只读)' : ''
        const color = cal.color ? ` 🎨${cal.color}` : ''
        return `- **${cal.name}**${readonly}${color}\n  ID: \`${cal.id}\``
      })

      const output = `## ${t('calendar.calendar_list')}\n\n${calendarList.join('\n\n')}`
      executor.addStep({
        type: 'tool_result',
        content: output,
        toolName: 'calendar_list',
        toolResult: truncateOutput(output, 500)
      })

      return { success: true, output }
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
      
      // 获取事件数据（限制数量，从最新开始）
      if (eventUrls.length > 0) {
        const fetchLimit = Math.min(eventUrls.length, 200)
        
        for (const eventUrl of eventUrls.slice(0, fetchLimit)) {
          try {
            const response = await fetch(eventUrl, {
              method: 'GET',
              headers: { 'Authorization': authHeader }
            })
            
            if (response.ok) {
              const data = await response.text()
              if (data.includes('VEVENT')) {
                calendarObjects.push({
                  url: eventUrl,
                  etag: response.headers.get('etag') || undefined,
                  data: data
                })
              }
            }
          } catch (fetchError: any) {
            // 忽略单个失败
          }
        }
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
      if (event) {
        // 本地时间范围过滤
        const eventStart = event.start.getTime()
        const eventEnd = event.end.getTime()
        
        // 检查事件是否在查询范围内
        if ((eventStart >= startTime && eventStart <= endTime) ||
            (eventEnd >= startTime && eventEnd <= endTime) ||
            (eventStart <= startTime && eventEnd >= endTime)) {
          events.push(event)
          if (events.length >= limit) break
        }
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
      return `- **${event.title}**\n  ${timeStr}${location}\n  ID: \`${event.uid}\``
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
  const recurrence = args.recurrence as string | undefined

  if (!calendarId || !title || !startStr) {
    return { success: false, output: '', error: t('calendar.params_required') }
  }

  const session = getFirstOpenSession()
  if (!session || !session.client) {
    return { success: false, output: '', error: t('calendar.not_connected') }
  }

  // 解析时间
  const startDate = new Date(startStr)
  const endDate = endStr 
    ? new Date(endStr) 
    : new Date(startDate.getTime() + 60 * 60 * 1000) // 默认 1 小时

  // 构建确认信息
  let confirmInfo = `${t('calendar.create_confirm')}\n\n`
  confirmInfo += `**${t('calendar.title')}**: ${title}\n`
  confirmInfo += `**${t('calendar.time')}**: ${formatDateTime(startDate)} - ${formatDateTime(endDate)}\n`
  if (allDay) confirmInfo += `**${t('calendar.all_day')}**: ${t('misc.yes')}\n`
  if (location) confirmInfo += `**${t('calendar.location')}**: ${location}\n`
  if (reminderMinutes) confirmInfo += `**${t('calendar.reminder')}**: ${t('calendar.reminder_minutes', { minutes: reminderMinutes })}\n`
  if (recurrence) {
    const recurrenceKey = `calendar.recurrence_${recurrence}` as keyof typeof import('../../i18n')
    confirmInfo += `**${t('calendar.recurrence')}**: ${t(recurrenceKey as any)}\n`
  }

  // 请求用户确认
  executor.addStep({
    type: 'tool_call',
    content: confirmInfo,
    toolName: 'calendar_create',
    toolArgs: { title, start: startStr, location },
    riskLevel: 'moderate'
  })

  const approved = await executor.waitForConfirmation(
    toolCallId,
    'calendar_create',
    { title, start: startStr },
    'moderate'
  )

  if (!approved) {
    return { success: false, output: '', error: t('calendar.user_rejected') }
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
      allDay: allDay || false,
      location,
      description,
      reminderMinutes,
      recurrence
    })

    // 创建事件
    await session.client.createCalendarObject({
      calendar: { url: calendarId },
      filename: `${uid}.ics`,
      iCalString: icalData
    })

    const output = t('calendar.created', { title })
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

  const session = getFirstOpenSession()
  if (!session || !session.client) {
    return { success: false, output: '', error: t('calendar.not_connected') }
  }

  try {
    // 获取原事件
    const calendarObjects = await session.client.fetchCalendarObjects({
      calendar: { url: calendarId }
    })
    
    const eventObj = calendarObjects.find(obj => {
      const event = parseICalEvent(obj.data, obj.url, obj.etag)
      return event && event.uid === eventId
    })

    if (!eventObj) {
      return { success: false, output: '', error: t('calendar.event_not_found', { id: eventId }) }
    }

    const originalEvent = parseICalEvent(eventObj.data, eventObj.url, eventObj.etag)
    if (!originalEvent) {
      return { success: false, output: '', error: t('calendar.event_parse_failed') }
    }

    // 构建确认信息
    const changes: string[] = []
    if (title && title !== originalEvent.title) changes.push(`${t('calendar.title')}: ${originalEvent.title} → ${title}`)
    if (startStr) changes.push(`${t('calendar.start')}: ${formatDateTime(originalEvent.start)} → ${startStr}`)
    if (endStr) changes.push(`${t('calendar.end')}: ${formatDateTime(originalEvent.end)} → ${endStr}`)
    if (location !== undefined && location !== originalEvent.location) changes.push(`${t('calendar.location')}: ${originalEvent.location || '(无)'} → ${location || '(无)'}`)

    if (changes.length === 0) {
      return { success: false, output: '', error: t('calendar.no_changes') }
    }

    let confirmInfo = `${t('calendar.update_confirm')}\n\n`
    confirmInfo += `**${t('calendar.event')}**: ${originalEvent.title}\n\n`
    confirmInfo += `**${t('calendar.changes')}**:\n${changes.map(c => `- ${c}`).join('\n')}`

    // 请求用户确认
    executor.addStep({
      type: 'tool_call',
      content: confirmInfo,
      toolName: 'calendar_update',
      toolArgs: { event_id: eventId, changes },
      riskLevel: 'moderate'
    })

    const approved = await executor.waitForConfirmation(
      toolCallId,
      'calendar_update',
      { event_id: eventId },
      'moderate'
    )

    if (!approved) {
      return { success: false, output: '', error: t('calendar.user_rejected') }
    }

    // 构建更新后的 iCalendar 数据
    const updatedEvent = {
      ...originalEvent,
      title: title || originalEvent.title,
      start: startStr ? new Date(startStr) : originalEvent.start,
      end: endStr ? new Date(endStr) : originalEvent.end,
      location: location !== undefined ? location : originalEvent.location,
      description: description !== undefined ? description : originalEvent.description
    }

    const icalData = buildICalEvent({
      uid: originalEvent.uid,
      title: updatedEvent.title,
      start: updatedEvent.start,
      end: updatedEvent.end,
      allDay: updatedEvent.allDay || false,
      location: updatedEvent.location,
      description: updatedEvent.description
    })

    // 更新事件
    await session.client.updateCalendarObject({
      calendarObject: {
        url: eventObj.url,
        etag: eventObj.etag,
        data: icalData
      }
    })

    const output = t('calendar.updated', { title: updatedEvent.title })
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
    // 获取要删除的事件
    const calendarObjects = await session.client.fetchCalendarObjects({
      calendar: { url: calendarId }
    })

    const eventsToDelete: Array<{ url: string; etag?: string; title: string }> = []
    for (const obj of calendarObjects) {
      const event = parseICalEvent(obj.data, obj.url, obj.etag)
      if (event && eventIds.includes(event.uid)) {
        eventsToDelete.push({
          url: obj.url,
          etag: obj.etag,
          title: event.title
        })
      }
    }

    if (eventsToDelete.length === 0) {
      return { success: false, output: '', error: t('calendar.events_not_found') }
    }

    // 构建确认信息
    let confirmInfo = `${t('calendar.delete_confirm')}\n\n`
    confirmInfo += `**${t('calendar.events_to_delete')}** (${eventsToDelete.length}):\n`
    confirmInfo += eventsToDelete.map(e => `- ${e.title}`).join('\n')

    // 请求用户确认
    executor.addStep({
      type: 'tool_call',
      content: confirmInfo,
      toolName: 'calendar_delete',
      toolArgs: { count: eventsToDelete.length },
      riskLevel: 'dangerous'
    })

    const approved = await executor.waitForConfirmation(
      toolCallId,
      'calendar_delete',
      { count: eventsToDelete.length },
      'dangerous'
    )

    if (!approved) {
      return { success: false, output: '', error: t('calendar.user_rejected') }
    }

    // 删除事件
    let deletedCount = 0
    for (const event of eventsToDelete) {
      try {
        await session.client.deleteCalendarObject({
          calendarObject: {
            url: event.url,
            etag: event.etag
          }
        })
        deletedCount++
      } catch (e) {
        console.error(`[CalendarSkill] Failed to delete event: ${event.title}`, e)
      }
    }

    const output = t('calendar.deleted', { count: deletedCount })
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

// ============ 辅助函数 ============

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
function parseICalEvent(icalData: string, url?: string, etag?: string): CalendarEvent | null {
  try {
    // 处理折叠行（以空格或制表符开头的行是上一行的续行）
    const unfoldedData = icalData.replace(/\r?\n[ \t]/g, '')
    
    // 简单解析 iCalendar 格式
    const lines = unfoldedData.split(/\r?\n/)
    let uid = ''
    let summary = ''
    let dtstart = ''
    let dtend = ''
    let dtstartTzid = ''
    let dtendTzid = ''
    let location = ''
    let description = ''
    let isAllDay = false
    let inVEvent = false

    // 提取时区信息的辅助函数
    const extractTzid = (line: string): string => {
      const tzidMatch = line.match(/TZID=([^:;]+)/)
      return tzidMatch ? tzidMatch[1] : ''
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
      console.log('[CalendarSkill] Missing required fields - uid:', uid, 'dtstart:', dtstart, 'summary:', summary)
      return null
    }

    // 如果没有标题，使用 "(无标题)" 
    if (!summary) {
      summary = '(无标题)'
    }

    return {
      uid,
      title: summary,
      start: parseICalDate(dtstart, dtstartTzid),
      end: dtend ? parseICalDate(dtend, dtendTzid || dtstartTzid) : parseICalDate(dtstart, dtstartTzid),
      allDay: isAllDay,
      location: location || undefined,
      description: description || undefined,
      url,
      etag
    }
  } catch (error) {
    console.error('[CalendarSkill] Failed to parse iCal event:', error, 'Data:', icalData.substring(0, 500))
    return null
  }
}

/**
 * 解析 iCalendar 日期格式
 */
function parseICalDate(dateStr: string, tzid?: string): Date {
  // 格式: 20240115T090000Z 或 20240115 或带时区 20240115T090000
  if (dateStr.length === 8) {
    // 全天事件 YYYYMMDD
    const year = parseInt(dateStr.substring(0, 4))
    const month = parseInt(dateStr.substring(4, 6)) - 1
    const day = parseInt(dateStr.substring(6, 8))
    return new Date(year, month, day)
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
    return new Date(Date.UTC(year, month, day, hour, minute, second))
  }
  
  // 处理带时区的情况
  // 常见时区映射（企业微信使用 TZ08 表示 UTC+8）
  const tzOffsets: Record<string, number> = {
    'TZ08': 8, 'Asia/Shanghai': 8, 'Asia/Hong_Kong': 8,
    'TZ09': 9, 'Asia/Tokyo': 9,
    'TZ00': 0, 'UTC': 0, 'GMT': 0,
    'TZ-05': -5, 'America/New_York': -5,
    'TZ-08': -8, 'America/Los_Angeles': -8
  }
  
  if (tzid && tzOffsets[tzid] !== undefined) {
    // 将带时区的本地时间转换为 Date 对象
    // 创建 UTC 时间然后减去时区偏移
    const offsetHours = tzOffsets[tzid]
    return new Date(Date.UTC(year, month, day, hour - offsetHours, minute, second))
  }
  
  // 没有时区信息，假设是本地时间
  return new Date(year, month, day, hour, minute, second)
}

/**
 * 反转义 iCalendar 文本
 */
function unescapeICalText(text: string): string {
  return text
    .replace(/\\n/g, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
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
 * 构建 iCalendar 事件数据
 */
function buildICalEvent(params: {
  uid: string
  title: string
  start: Date
  end: Date
  allDay: boolean
  location?: string
  description?: string
  reminderMinutes?: number
  recurrence?: string
}): string {
  const { uid, title, start, end, allDay, location, description, reminderMinutes, recurrence } = params
  
  const now = new Date()
  const dtstamp = formatICalDate(now, false)
  
  let dtstart: string
  let dtend: string
  
  if (allDay) {
    dtstart = `DTSTART;VALUE=DATE:${formatICalDate(start, true)}`
    dtend = `DTEND;VALUE=DATE:${formatICalDate(end, true)}`
  } else {
    dtstart = `DTSTART:${formatICalDate(start, false)}`
    dtend = `DTEND:${formatICalDate(end, false)}`
  }
  
  let ical = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//SFTerminal//Calendar//EN
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
  }
  
  if (recurrence) {
    const rruleMap: Record<string, string> = {
      daily: 'FREQ=DAILY',
      weekly: 'FREQ=WEEKLY',
      monthly: 'FREQ=MONTHLY',
      yearly: 'FREQ=YEARLY'
    }
    if (rruleMap[recurrence]) {
      ical += `\nRRULE:${rruleMap[recurrence]}`
    }
  }
  
  ical += `
END:VEVENT
END:VCALENDAR`

  return ical
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
