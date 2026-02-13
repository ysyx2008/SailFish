/**
 * Word 会话管理
 * 管理打开的 Word 文档
 */

import type { Document } from 'docx'
import type JSZip from 'jszip'

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

/** 文档设置 */
export interface DocumentSettings {
  /** 是否启用修订追踪 */
  trackRevisions?: boolean
  /** 修订作者 */
  revisionAuthor?: string
}

interface WordSession {
  /** 文件路径 */
  filePath: string
  /** 文档对象（创建模式使用） */
  document: Document
  /** 文档内容（段落列表，创建模式使用） */
  sections: SectionContent[]
  /** 页面设置 */
  pageSettings?: PageSettings
  /** 文档设置 */
  documentSettings?: DocumentSettings
  /** 打开时间 */
  openedAt: number
  /** 最后访问时间 */
  lastAccess: number
  /** 是否有未保存的修改 */
  dirty: boolean
  /** 是否为新建文档 */
  isNew: boolean
  /** XML 编辑模式：JSZip 实例 */
  zip?: JSZip
  /** XML 编辑模式：document.xml 内容 */
  documentXml?: string
}

/** 段落内容 */
export interface SectionContent {
  type: 'paragraph' | 'heading' | 'list' | 'table' | 'image' | 'page_break' | 'toc' | 'hyperlink' | 'bookmark' | 'comment'
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
    align?: 'left' | 'center' | 'right' | 'justify'  // 对齐方式
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
  /** 超链接URL（仅 type=hyperlink 时使用） */
  url?: string
  /** 书签名称（仅 type=bookmark 时使用） */
  bookmarkName?: string
  /** 评论内容（仅 type=comment 时使用） */
  commentText?: string
  /** 评论作者（仅 type=comment 时使用） */
  commentAuthor?: string
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
 * 创建 XML 编辑会话（用于编辑已有文档时保留格式）
 */
export function createXmlSession(filePath: string, zip: JSZip, documentXml: string): WordSession {
  const session: WordSession = {
    filePath,
    document: {} as Document, // XML 模式不使用 Document 对象
    sections: [],
    openedAt: Date.now(),
    lastAccess: Date.now(),
    dirty: false,
    isNew: false,
    zip,
    documentXml
  }

  openSessions.set(filePath, session)
  startTimeoutChecker()

  return session
}

/**
 * 更新会话中的 document.xml（XML 编辑模式）
 */
export function updateDocumentXml(filePath: string, documentXml: string): void {
  const session = openSessions.get(filePath)
  if (session) {
    session.documentXml = documentXml
    session.dirty = true
    session.lastAccess = Date.now()
  }
}

/**
 * 检查是否为 XML 编辑会话
 */
export function isXmlSession(filePath: string): boolean {
  const session = openSessions.get(filePath)
  return !!(session?.zip && session?.documentXml)
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
 * 设置文档属性
 */
export function setDocumentSettings(filePath: string, settings: DocumentSettings): void {
  const session = openSessions.get(filePath)
  if (session) {
    session.documentSettings = { ...session.documentSettings, ...settings }
    session.dirty = true
    session.lastAccess = Date.now()
  }
}

/**
 * 获取文档属性
 */
export function getDocumentSettings(filePath: string): DocumentSettings | undefined {
  return openSessions.get(filePath)?.documentSettings
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

