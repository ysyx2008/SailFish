/**
 * Word 会话管理
 * 管理打开的 Word 文档
 */

import type { Document } from 'docx'

/** 页面设置 */
export interface PageSettings {
  /** 页眉文字 */
  header?: string
  /** 页脚文字 */
  footer?: string
  /** 是否显示页码 */
  pageNumber?: boolean
  /** 页码格式 */
  pageNumberFormat?: 'numeric' | 'roman' | 'letter'
  /** 页码位置 */
  pageNumberPosition?: 'header' | 'footer'
}

interface WordSession {
  /** 文件路径 */
  filePath: string
  /** 文档对象 */
  document: Document
  /** 文档内容（段落列表） */
  sections: SectionContent[]
  /** 页面设置 */
  pageSettings?: PageSettings
  /** 打开时间 */
  openedAt: number
  /** 最后访问时间 */
  lastAccess: number
  /** 是否有未保存的修改 */
  dirty: boolean
  /** 是否为新建文档 */
  isNew: boolean
}

/** 段落内容 */
export interface SectionContent {
  type: 'paragraph' | 'heading' | 'list' | 'table' | 'image' | 'page_break' | 'toc'
  content: string
  level?: number  // 标题级别 1-6
  style?: {
    font?: string       // 字体名称
    size?: number       // 字号（磅）
    bold?: boolean      // 粗体
    italic?: boolean    // 斜体
    underline?: boolean // 下划线
    color?: string      // 文字颜色（十六进制，如 "FF0000"）
    highlight?: string  // 高亮背景色
    center?: boolean    // 居中对齐
    indent?: number     // 首行缩进（字符数）
  }
  /** 列表项（仅 type=list 时使用） */
  items?: string[]
  /** 表格数据（仅 type=table 时使用） */
  rows?: string[][]
  /** 图片路径（仅 type=image 时使用） */
  imagePath?: string
  /** 图片宽度（像素，仅 type=image 时使用） */
  imageWidth?: number
  /** 图片高度（像素，仅 type=image 时使用） */
  imageHeight?: number
}

// 打开的文档 Map<filePath, WordSession>
const openSessions = new Map<string, WordSession>()

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
        console.log(`[WordSession] Auto-closing timed out session: ${filePath}`)
        closeSession(filePath, false)
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
export function getSession(filePath: string): WordSession | undefined {
  const session = openSessions.get(filePath)
  if (session) {
    session.lastAccess = Date.now()
  }
  return session
}

/**
 * 创建新会话
 */
export function createSession(filePath: string, document: Document, isNew: boolean = false): WordSession {
  const session: WordSession = {
    filePath,
    document,
    sections: [],
    openedAt: Date.now(),
    lastAccess: Date.now(),
    dirty: isNew,
    isNew
  }
  
  openSessions.set(filePath, session)
  startTimeoutChecker()
  
  return session
}

/**
 * 添加内容到会话
 */
export function addContent(filePath: string, content: SectionContent): void {
  const session = openSessions.get(filePath)
  if (session) {
    session.sections.push(content)
    session.dirty = true
    session.lastAccess = Date.now()
  }
}

/**
 * 获取会话内容
 */
export function getSessionContent(filePath: string): SectionContent[] {
  const session = openSessions.get(filePath)
  return session?.sections || []
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
 * 标记会话为已保存
 */
export function markSaved(filePath: string): void {
  const session = openSessions.get(filePath)
  if (session) {
    session.dirty = false
    session.isNew = false
    session.lastAccess = Date.now()
  }
}

/**
 * 设置页面属性
 */
export function setPageSettings(filePath: string, settings: PageSettings): void {
  const session = openSessions.get(filePath)
  if (session) {
    session.pageSettings = { ...session.pageSettings, ...settings }
    session.dirty = true
    session.lastAccess = Date.now()
  }
}

/**
 * 获取页面属性
 */
export function getPageSettings(filePath: string): PageSettings | undefined {
  return openSessions.get(filePath)?.pageSettings
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
export function getAllSessions(): WordSession[] {
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
    return '当前没有打开的 Word 文档'
  }
  
  return sessions.map(s => {
    const status = s.dirty ? '(有未保存的修改)' : ''
    return `- ${s.filePath} ${status}`
  }).join('\n')
}

