/**
 * 邮箱会话管理
 * 管理 IMAP 和 SMTP 连接
 */

import type { ImapFlow } from 'imapflow'
import type { Transporter } from 'nodemailer'

export interface EmailSession {
  /** 账户 ID */
  accountId: string
  /** 邮箱地址 */
  email: string
  /** IMAP 客户端 */
  imapClient: ImapFlow | null
  /** SMTP 传输器 */
  smtpTransporter: Transporter | null
  /** 打开时间 */
  connectedAt: number
  /** 最后访问时间 */
  lastAccess: number
  /** IMAP 连接状态 */
  imapConnected: boolean
}

// 打开的会话 Map<accountId, EmailSession>
const openSessions = new Map<string, EmailSession>()

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
        console.log(`[EmailSession] Auto-closing timed out session: ${accountId}`)
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
export function getSession(accountId: string): EmailSession | undefined {
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
  email: string,
  imapClient: ImapFlow | null,
  smtpTransporter: Transporter | null
): EmailSession {
  const session: EmailSession = {
    accountId,
    email,
    imapClient,
    smtpTransporter,
    connectedAt: Date.now(),
    lastAccess: Date.now(),
    imapConnected: !!imapClient
  }
  
  openSessions.set(accountId, session)
  startTimeoutChecker()
  
  return session
}

/**
 * 更新会话的 IMAP 客户端
 */
export function updateImapClient(accountId: string, imapClient: ImapFlow): void {
  const session = openSessions.get(accountId)
  if (session) {
    session.imapClient = imapClient
    session.imapConnected = true
    session.lastAccess = Date.now()
  }
}

/**
 * 更新会话的 SMTP 传输器
 */
export function updateSmtpTransporter(accountId: string, smtpTransporter: Transporter): void {
  const session = openSessions.get(accountId)
  if (session) {
    session.smtpTransporter = smtpTransporter
    session.lastAccess = Date.now()
  }
}

/**
 * 关闭会话
 */
export async function closeSession(accountId: string): Promise<void> {
  const session = openSessions.get(accountId)
  if (!session) return
  
  try {
    // 关闭 IMAP 连接
    if (session.imapClient) {
      try {
        await session.imapClient.logout()
      } catch (error) {
        console.error(`[EmailSession] Error closing IMAP connection for ${accountId}:`, error)
      }
    }
    
    // 关闭 SMTP 连接
    if (session.smtpTransporter) {
      try {
        session.smtpTransporter.close()
      } catch (error) {
        console.error(`[EmailSession] Error closing SMTP connection for ${accountId}:`, error)
      }
    }
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
export function getAllSessions(): EmailSession[] {
  return Array.from(openSessions.values())
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
    return '当前没有打开的邮箱连接'
  }
  
  return sessions.map(s => {
    const imapStatus = s.imapConnected ? '✓ IMAP' : '✗ IMAP'
    const smtpStatus = s.smtpTransporter ? '✓ SMTP' : '✗ SMTP'
    return `- ${s.email} [${imapStatus}] [${smtpStatus}]`
  }).join('\n')
}

/**
 * 邮箱服务器配置
 */
export interface EmailServerConfig {
  imapHost: string
  imapPort: number
  smtpHost: string
  smtpPort: number
  smtpSecure: boolean
}

/**
 * 预置邮箱服务器配置
 */
export const EMAIL_SERVER_CONFIGS: Record<string, EmailServerConfig> = {
  gmail: {
    imapHost: 'imap.gmail.com',
    imapPort: 993,
    smtpHost: 'smtp.gmail.com',
    smtpPort: 465,
    smtpSecure: true
  },
  outlook: {
    imapHost: 'outlook.office365.com',
    imapPort: 993,
    smtpHost: 'smtp.office365.com',
    smtpPort: 587,
    smtpSecure: false  // STARTTLS
  },
  qq: {
    imapHost: 'imap.qq.com',
    imapPort: 993,
    smtpHost: 'smtp.qq.com',
    smtpPort: 465,
    smtpSecure: true
  },
  '163': {
    imapHost: 'imap.163.com',
    imapPort: 993,
    smtpHost: 'smtp.163.com',
    smtpPort: 465,
    smtpSecure: true
  }
}

/**
 * 获取服务器配置
 */
export function getServerConfig(provider: string, customConfig?: Partial<EmailServerConfig>): EmailServerConfig {
  if (provider === 'custom' && customConfig) {
    return {
      imapHost: customConfig.imapHost || '',
      imapPort: customConfig.imapPort || 993,
      smtpHost: customConfig.smtpHost || '',
      smtpPort: customConfig.smtpPort || 465,
      smtpSecure: customConfig.smtpSecure ?? true
    }
  }
  
  return EMAIL_SERVER_CONFIGS[provider] || EMAIL_SERVER_CONFIGS.gmail
}

