/**
 * Excel 会话管理
 * 管理打开的 Excel 工作簿
 */

import type { Workbook } from 'exceljs'
import { createLogger } from '../../../../utils/logger'

const log = createLogger('ExcelSession')

interface ExcelSession {
  /** 文件路径 */
  filePath: string
  /** 工作簿对象 */
  workbook: Workbook
  /** 打开时间 */
  openedAt: number
  /** 最后访问时间 */
  lastAccess: number
  /** 是否有未保存的修改 */
  dirty: boolean
}

// 打开的工作簿 Map<filePath, ExcelSession>
const openSessions = new Map<string, ExcelSession>()

// 超时时间（5 分钟）
const SESSION_TIMEOUT = 5 * 60 * 1000

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
    for (const [filePath, session] of entries) {
      if (now - session.lastAccess > SESSION_TIMEOUT) {
        log.info(`Auto-closing timed out session: ${filePath}`)
        closeSession(filePath, false) // 不保存，因为超时可能意味着问题
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
 * 检查文件是否已打开
 */
export function isSessionOpen(filePath: string): boolean {
  return openSessions.has(filePath)
}

/**
 * 获取会话
 */
export function getSession(filePath: string): ExcelSession | undefined {
  const session = openSessions.get(filePath)
  if (session) {
    session.lastAccess = Date.now()
  }
  return session
}

/**
 * 创建新会话
 */
export function createSession(filePath: string, workbook: Workbook): ExcelSession {
  const session: ExcelSession = {
    filePath,
    workbook,
    openedAt: Date.now(),
    lastAccess: Date.now(),
    dirty: false
  }
  
  openSessions.set(filePath, session)
  startTimeoutChecker()
  
  return session
}

/**
 * 标记会话为已修改
 */
export function markDirty(filePath: string): void {
  const session = openSessions.get(filePath)
  if (session) {
    session.dirty = true
    session.lastAccess = Date.now()
  }
}

/**
 * 关闭会话
 */
export function closeSession(filePath: string, saved: boolean): boolean {
  const session = openSessions.get(filePath)
  if (!session) return false
  
  const wasDirty = session.dirty && !saved
  openSessions.delete(filePath)
  
  if (openSessions.size === 0) {
    stopTimeoutChecker()
  }
  
  return wasDirty // 返回是否有未保存的修改被丢弃
}

/**
 * 获取所有打开的会话
 */
export function getAllSessions(): ExcelSession[] {
  return Array.from(openSessions.values())
}

/**
 * 关闭所有会话
 */
export async function closeAllSessions(): Promise<void> {
  const keys = Array.from(openSessions.keys())
  for (const filePath of keys) {
    closeSession(filePath, false)
  }
  stopTimeoutChecker()
}

/**
 * 获取会话状态摘要
 */
export function getSessionsSummary(): string {
  const sessions = getAllSessions()
  if (sessions.length === 0) {
    return '当前没有打开的 Excel 文件'
  }
  
  return sessions.map(s => {
    const status = s.dirty ? '(有未保存的修改)' : ''
    return `- ${s.filePath} ${status}`
  }).join('\n')
}

