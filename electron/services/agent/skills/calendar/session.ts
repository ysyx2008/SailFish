/**
 * 日历会话管理
 * 管理 CalDAV 客户端连接
 */

import type { DAVClient, DAVCalendar } from 'tsdav'
import type { Calendar, CalDAVServerConfig } from './types'

export interface CalendarSession {
  /** 账户 ID */
  accountId: string
  /** 账户名称 */
  accountName: string
  /** 用户名 */
  username: string
  /** CalDAV 客户端 */
  client: DAVClient | null
  /** 已获取的日历列表缓存（简化版，用于显示） */
  calendars: Calendar[]
  /** 原始的 DAVCalendar 对象（用于 API 调用） */
  davCalendars: DAVCalendar[]
  /** 连接时间 */
  connectedAt: number
  /** 最后访问时间 */
  lastAccess: number
  /** 是否已连接 */
  connected: boolean
  /** 服务商是否支持 VTODO（待办事项） */
  supportsTodo?: boolean
  /** 服务商名称（用于提示信息） */
  provider?: string
}

// 打开的会话 Map<accountId, CalendarSession>
const openSessions = new Map<string, CalendarSession>()

// 超时时间（10 分钟）
const SESSION_TIMEOUT = 10 * 60 * 1000

// 超时检查定时器
let timeoutChecker: NodeJS.Timeout | null = null

/**
 * 启动超时检查器
 */
function startTimeoutChecker(): void {
  if (timeoutChecker) return
  
  timeoutChecker = setInterval(() => {
    const now = Date.now()
    const entries = Array.from(openSessions.entries())
    for (const [accountId, session] of entries) {
      if (now - session.lastAccess > SESSION_TIMEOUT) {
        console.log(`[CalendarSession] Auto-closing timed out session: ${accountId}`)
        closeSession(accountId)
      }
    }
  }, 60 * 1000) // 每分钟检查一次
}

/**
 * 停止超时检查器
 */
function stopTimeoutChecker(): void {
  if (timeoutChecker) {
    clearInterval(timeoutChecker)
    timeoutChecker = null
  }
}

/**
 * 检查会话是否已打开
 */
export function isSessionOpen(accountId: string): boolean {
  return openSessions.has(accountId)
}

/**
 * 获取会话
 */
export function getSession(accountId: string): CalendarSession | undefined {
  const session = openSessions.get(accountId)
  if (session) {
    session.lastAccess = Date.now()
  }
  return session
}

/**
 * 创建新会话
 */
export function createSession(
  accountId: string,
  accountName: string,
  username: string,
  client: DAVClient | null,
  calendars: Calendar[] = [],
  davCalendars: DAVCalendar[] = []
): CalendarSession {
  const session: CalendarSession = {
    accountId,
    accountName,
    username,
    client,
    calendars,
    davCalendars,
    connectedAt: Date.now(),
    lastAccess: Date.now(),
    connected: !!client
  }
  
  openSessions.set(accountId, session)
  startTimeoutChecker()
  
  return session
}

/**
 * 更新会话的日历列表缓存
 */
export function updateSessionCalendars(accountId: string, calendars: Calendar[], davCalendars?: DAVCalendar[]): void {
  const session = openSessions.get(accountId)
  if (session) {
    session.calendars = calendars
    if (davCalendars) {
      session.davCalendars = davCalendars
    }
    session.lastAccess = Date.now()
  }
}

/**
 * 根据 URL 获取对应的 DAVCalendar 对象
 */
export function getDAVCalendar(accountId: string, calendarUrl: string): DAVCalendar | undefined {
  const session = openSessions.get(accountId)
  if (!session) return undefined
  return session.davCalendars.find(cal => cal.url === calendarUrl)
}

/**
 * 关闭会话
 */
export async function closeSession(accountId: string): Promise<void> {
  const session = openSessions.get(accountId)
  if (!session) return
  
  try {
    // tsdav 的 DAVClient 没有显式的 logout/close 方法
    // 但我们可以清理资源
    if (session.client) {
      // 清空客户端引用
      session.client = null
    }
  } catch (error) {
    console.error(`[CalendarSession] Error closing session for ${accountId}:`, error)
  } finally {
    openSessions.delete(accountId)
    
    if (openSessions.size === 0) {
      stopTimeoutChecker()
    }
  }
}

/**
 * 获取所有打开的会话
 */
export function getAllSessions(): CalendarSession[] {
  return Array.from(openSessions.values())
}

/**
 * 获取第一个有效的会话
 */
export function getFirstOpenSession(): CalendarSession | undefined {
  const sessions = getAllSessions()
  return sessions.find(s => s.connected && s.client) || sessions[0]
}

/**
 * 关闭所有会话
 */
export async function closeAllSessions(): Promise<void> {
  const accountIds = Array.from(openSessions.keys())
  for (const accountId of accountIds) {
    await closeSession(accountId)
  }
  stopTimeoutChecker()
}

/**
 * 获取会话状态摘要
 */
export function getSessionsSummary(): string {
  const sessions = getAllSessions()
  if (sessions.length === 0) {
    return '当前没有连接的日历账户'
  }
  
  return sessions.map(s => {
    const status = s.connected ? '✓ 已连接' : '✗ 未连接'
    const calCount = s.calendars.length
    return `- ${s.accountName} (${s.username}) [${status}] [${calCount} 个日历]`
  }).join('\n')
}

/**
 * 预置的 CalDAV 服务器配置
 */
export const CALDAV_SERVER_CONFIGS: Record<string, CalDAVServerConfig> = {
  google: {
    serverUrl: 'https://www.googleapis.com/caldav/v2',
    specialHandling: 'google'
  },
  icloud: {
    serverUrl: 'https://caldav.icloud.com',
    specialHandling: 'icloud'
  },
  outlook: {
    serverUrl: 'https://outlook.office365.com/caldav'
  },
  wecom: {
    serverUrl: 'https://caldav.wecom.work',
    specialHandling: 'wecom'
  },
  fastmail: {
    serverUrl: 'https://caldav.fastmail.com/dav'
  }
}

/**
 * 获取服务器配置
 */
export function getServerConfig(
  provider: string, 
  customUrl?: string
): CalDAVServerConfig {
  if (provider === 'caldav' && customUrl) {
    return { serverUrl: customUrl }
  }
  
  return CALDAV_SERVER_CONFIGS[provider] || { serverUrl: customUrl || '' }
}
