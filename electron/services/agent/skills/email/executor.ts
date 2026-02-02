/**
 * 邮箱技能执行器
 */

import * as fs from 'fs'
import * as path from 'path'
import type { ToolResult, AgentConfig } from '../../types'
import type { ToolExecutorConfig } from '../../tool-executor'
import { t } from '../../i18n'
import { getEmailCredential } from '../../../credential.service'
import {
  isSessionOpen,
  getSession,
  createSession,
  closeSession,
  getServerConfig,
  getAllSessions,
  type EmailServerConfig
} from './session'

// 动态导入的模块
let ImapFlow: typeof import('imapflow').ImapFlow
let nodemailer: typeof import('nodemailer')
let simpleParser: typeof import('mailparser').simpleParser

/**
 * 初始化依赖模块
 */
async function initDependencies(): Promise<void> {
  if (!ImapFlow) {
    const imapflow = await import('imapflow')
    ImapFlow = imapflow.ImapFlow
  }
  if (!nodemailer) {
    nodemailer = await import('nodemailer')
  }
  if (!simpleParser) {
    const mailparser = await import('mailparser')
    simpleParser = mailparser.simpleParser
  }
}

/**
 * 邮箱账户配置（从渲染进程传入）
 */
interface EmailAccountConfig {
  id: string
  name: string
  email: string
  provider: string
  authType: 'password' | 'oauth2'
  imapHost?: string
  imapPort?: number
  smtpHost?: string
  smtpPort?: number
  smtpSecure?: boolean
  rejectUnauthorized?: boolean
}

// 缓存的账户配置（通过 IPC 从渲染进程获取）
let cachedAccounts: EmailAccountConfig[] = []

/**
 * 设置邮箱账户配置（由主进程调用）
 */
export function setEmailAccounts(accounts: EmailAccountConfig[]): void {
  cachedAccounts = accounts
}

/**
 * 获取邮箱账户配置
 */
function getEmailAccount(accountId?: string): EmailAccountConfig | undefined {
  if (accountId) {
    return cachedAccounts.find(a => a.id === accountId)
  }
  return cachedAccounts[0]
}

/**
 * 执行邮箱技能工具
 */
export async function executeEmailTool(
  toolName: string,
  ptyId: string,
  args: Record<string, unknown>,
  toolCallId: string,
  config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  await initDependencies()

  switch (toolName) {
    case 'email_connect':
      return await emailConnect(args, executor)
    case 'email_list':
      return await emailList(args, executor)
    case 'email_read':
      return await emailRead(args, executor)
    case 'email_search':
      return await emailSearch(args, executor)
    case 'email_send':
      return await emailSend(args, toolCallId, config, executor)
    case 'email_delete':
      return await emailDelete(args, toolCallId, config, executor)
    default:
      return { success: false, output: '', error: t('error.unknown_tool', { name: toolName }) }
  }
}

/**
 * 连接邮箱
 */
async function emailConnect(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const accountId = args.account_id as string | undefined
  const account = getEmailAccount(accountId)

  if (!account) {
    return {
      success: false,
      output: '',
      error: cachedAccounts.length === 0
        ? t('email.no_accounts_configured')
        : t('email.account_not_found', { id: accountId || 'unknown' })
    }
  }

  // 检查是否已连接
  if (isSessionOpen(account.id)) {
    const existingSession = getSession(account.id)
    // 检查 IMAP 连接是否真的还活着
    if (existingSession?.imapClient?.usable) {
      const output = t('email.already_connected', { email: account.email })
      executor.addStep({
        type: 'tool_result',
        content: output,
        toolName: 'email_connect',
        toolResult: output
      })
      return { success: true, output }
    }
    // 连接已断开，先关闭旧会话再重新连接
    console.log(`[EmailSkill] IMAP connection lost for ${account.email}, reconnecting...`)
    await closeSession(account.id)
  }

  // 获取凭据
  const credential = await getEmailCredential(account.id)
  if (!credential) {
    return {
      success: false,
      output: '',
      error: t('email.credential_not_found', { email: account.email })
    }
  }

  // 获取服务器配置
  const serverConfig = getServerConfig(account.provider, {
    imapHost: account.imapHost,
    imapPort: account.imapPort,
    smtpHost: account.smtpHost,
    smtpPort: account.smtpPort,
    smtpSecure: account.smtpSecure
  })

  try {
    // 创建 IMAP 连接
    const imapClient = new ImapFlow({
      host: serverConfig.imapHost,
      port: serverConfig.imapPort,
      secure: true,
      auth: {
        user: account.email,
        pass: credential
      },
      logger: false,
      tls: {
        rejectUnauthorized: account.rejectUnauthorized !== false
      }
    })

    await imapClient.connect()

    // 创建 SMTP 传输器
    const smtpTransporter = nodemailer.createTransport({
      host: serverConfig.smtpHost,
      port: serverConfig.smtpPort,
      secure: serverConfig.smtpSecure,
      auth: {
        user: account.email,
        pass: credential
      },
      tls: {
        rejectUnauthorized: account.rejectUnauthorized !== false
      }
    })

    // 验证 SMTP 连接
    await smtpTransporter.verify()

    // 创建会话
    createSession(account.id, account.email, imapClient, smtpTransporter)

    const output = t('email.connected', { email: account.email })
    executor.addStep({
      type: 'tool_result',
      content: output,
      toolName: 'email_connect',
      toolResult: output
    })

    return { success: true, output }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : t('email.connect_failed')
    return { success: false, output: '', error: errorMsg }
  }
}

/**
 * 列出文件夹或邮件
 */
async function emailList(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const folder = args.folder as string | undefined
  const limit = Math.min(Math.max((args.limit as number) || 20, 1), 100)
  const page = Math.max((args.page as number) || 1, 1)

  // 获取当前会话
  const session = getFirstOpenSession()
  if (!session || !session.imapClient) {
    return { success: false, output: '', error: t('email.not_connected') }
  }
  
  // 检查 IMAP 连接是否有效
  if (!session.imapClient.usable) {
    // 连接已断开，清理会话
    await closeSession(session.accountId)
    return { 
      success: false, 
      output: '', 
      error: t('email.connection_lost') + ' ' + t('email.please_reconnect')
    }
  }

  try {
    if (!folder) {
      // 列出所有文件夹
      const mailboxes = await session.imapClient.list()
      const folders = mailboxes.map(mb => {
        const flags = mb.flags ? Array.from(mb.flags).join(', ') : ''
        return `- **${mb.path}** ${flags ? `(${flags})` : ''}`
      })

      const output = `## ${t('email.folder_list')}\n\n${folders.join('\n')}`
      // content 简洁，toolResult 详细
      executor.addStep({
        type: 'tool_result',
        content: `📁 ${mailboxes.length} 个文件夹`,
        toolName: 'email_list',
        toolResult: output
      })

      return { success: true, output }
    }

    // 列出指定文件夹的邮件
    const lock = await session.imapClient.getMailboxLock(folder)
    try {
      const mailbox = session.imapClient.mailbox
      if (!mailbox) {
        return { success: false, output: '', error: t('email.folder_not_found', { folder }) }
      }

      const total = mailbox.exists || 0
      const start = Math.max(1, total - (page * limit) + 1)
      const end = Math.max(1, total - ((page - 1) * limit))

      if (total === 0) {
        const output = t('email.folder_empty', { folder })
        executor.addStep({
          type: 'tool_result',
          content: output,
          toolName: 'email_list',
          toolResult: output
        })
        return { success: true, output }
      }

      const messages: string[] = []
      for await (const message of session.imapClient.fetch(`${start}:${end}`, {
        envelope: true,
        flags: true,
        uid: true
      })) {
        const envelope = message.envelope
        if (!envelope) continue
        const flags = message.flags ? Array.from(message.flags) : []
        const seen = flags.includes('\\Seen') ? '' : '📬 '
        const flagged = flags.includes('\\Flagged') ? '⭐ ' : ''
        // 简化日期格式：只显示 MM/DD HH:mm
        const date = envelope.date ? formatShortDate(new Date(envelope.date)) : ''
        // 发件人只显示名字或邮箱前缀
        const fromAddr = envelope.from?.[0]
        const from = fromAddr ? formatAddress(fromAddr) : t('email.unknown_sender')
        const subject = envelope.subject || t('email.no_subject')

        messages.unshift(`- ${seen}${flagged}**${message.uid}** | ${from} | ${subject} | ${date}`)
      }

      const output = `## ${folder} (${total} ${t('email.total_messages')})\n\n${t('email.page_info', { page, limit })}\n\n${messages.join('\n')}`
      // content 简洁，toolResult 详细
      executor.addStep({
        type: 'tool_result',
        content: `📬 ${folder}: ${messages.length} 封邮件`,
        toolName: 'email_list',
        toolResult: output
      })

      return { success: true, output }
    } finally {
      lock.release()
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : t('email.list_failed')
    return { success: false, output: '', error: errorMsg }
  }
}

/**
 * 读取邮件
 */
async function emailRead(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const folder = (args.folder as string) || 'INBOX'
  const uid = args.uid as number

  if (!uid) {
    return { success: false, output: '', error: t('email.uid_required') }
  }

  const session = getFirstOpenSession()
  if (!session || !session.imapClient) {
    return { success: false, output: '', error: t('email.not_connected') }
  }
  
  // 检查 IMAP 连接是否有效
  if (!session.imapClient.usable) {
    await closeSession(session.accountId)
    return { 
      success: false, 
      output: '', 
      error: t('email.connection_lost') + ' ' + t('email.please_reconnect')
    }
  }

  try {
    const lock = await session.imapClient.getMailboxLock(folder)
    try {
      // 获取邮件源
      const message = await session.imapClient.fetchOne(String(uid), {
        source: true,
        uid: true
      }, { uid: true })

      if (!message || !message.source) {
        return { success: false, output: '', error: t('email.message_not_found', { uid }) }
      }

      // 解析邮件
      const parsed = await simpleParser(message.source)

      // 构建输出 - 使用简洁格式
      let output = `## ${parsed.subject || t('email.no_subject')}\n\n`
      // 发件人只显示名字
      const fromName = parsed.from?.value?.[0] 
        ? formatAddress(parsed.from.value[0])
        : (parsed.from?.text || t('email.unknown_sender'))
      output += `**${t('email.from')}**: ${fromName}\n`
      // 收件人和抄送限制显示数量
      const toText = formatAddressList(parsed.to)
      if (toText) output += `**${t('email.to')}**: ${toText}\n`
      if (parsed.cc) {
        const ccText = formatAddressList(parsed.cc)
        if (ccText) output += `**${t('email.cc')}**: ${ccText}\n`
      }
      output += `**${t('email.date')}**: ${parsed.date?.toLocaleString() || ''}\n`
      output += `**UID**: ${uid}\n\n`

      // 正文
      output += `### ${t('email.body')}\n\n`
      if (parsed.text) {
        // 限制正文长度
        const bodyText = parsed.text.length > 5000
          ? parsed.text.substring(0, 5000) + `\n\n... (${t('email.body_truncated')})`
          : parsed.text
        output += bodyText + '\n'
      } else if (parsed.html) {
        output += `(HTML ${t('email.content')}, ${t('email.text_not_available')})\n`
      } else {
        output += t('email.no_content') + '\n'
      }

      // 附件
      if (parsed.attachments && parsed.attachments.length > 0) {
        output += `\n### ${t('email.attachments')} (${parsed.attachments.length})\n\n`
        parsed.attachments.forEach((att, i) => {
          const size = att.size ? `${(att.size / 1024).toFixed(1)} KB` : t('email.unknown_size')
          output += `${i + 1}. ${att.filename || t('email.unnamed_attachment')} (${size})\n`
        })
      }

      // content 简洁（只显示标题），toolResult 详细
      const subject = parsed.subject || t('email.no_subject')
      executor.addStep({
        type: 'tool_result',
        content: `📧 ${subject}`,
        toolName: 'email_read',
        toolResult: output
      })

      return { success: true, output }
    } finally {
      lock.release()
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : t('email.read_failed')
    return { success: false, output: '', error: errorMsg }
  }
}

/**
 * 搜索邮件
 */
async function emailSearch(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const folder = (args.folder as string) || 'INBOX'
  const limit = Math.min(Math.max((args.limit as number) || 20, 1), 100)

  const session = getFirstOpenSession()
  if (!session || !session.imapClient) {
    return { success: false, output: '', error: t('email.not_connected') }
  }
  
  // 检查 IMAP 连接是否有效
  if (!session.imapClient.usable) {
    await closeSession(session.accountId)
    return { 
      success: false, 
      output: '', 
      error: t('email.connection_lost') + ' ' + t('email.please_reconnect')
    }
  }

  try {
    const lock = await session.imapClient.getMailboxLock(folder)
    try {
      // 构建搜索条件
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const searchCriteria: any = {}

      if (args.from) searchCriteria.from = args.from as string
      if (args.to) searchCriteria.to = args.to as string
      if (args.subject) searchCriteria.subject = args.subject as string
      if (args.text) searchCriteria.body = args.text as string
      if (args.since) searchCriteria.since = new Date(args.since as string)
      if (args.before) searchCriteria.before = new Date(args.before as string)
      if (args.unseen === true) searchCriteria.unseen = true

      // 执行搜索
      const searchResult = await session.imapClient.search(searchCriteria, { uid: true })
      const uids = Array.isArray(searchResult) ? searchResult : []

      if (uids.length === 0) {
        const output = t('email.no_results')
        executor.addStep({
          type: 'tool_result',
          content: output,
          toolName: 'email_search',
          toolResult: output
        })
        return { success: true, output }
      }

      // 获取最近的邮件
      const recentUids = uids.slice(-limit).reverse()
      const messages: string[] = []

      for await (const message of session.imapClient.fetch(recentUids.join(','), {
        envelope: true,
        flags: true,
        uid: true
      }, { uid: true })) {
        const envelope = message.envelope
        if (!envelope) continue
        const flags = message.flags ? Array.from(message.flags) : []
        const seen = flags.includes('\\Seen') ? '' : '📬 '
        const date = envelope.date ? formatShortDate(new Date(envelope.date)) : ''
        const fromAddr = envelope.from?.[0]
        const from = fromAddr ? formatAddress(fromAddr) : t('email.unknown_sender')
        const subject = envelope.subject || t('email.no_subject')

        messages.push(`- ${seen}**${message.uid}** | ${from} | ${subject} | ${date}`)
      }

      const output = `## ${t('email.search_results')} (${uids.length} ${t('email.found')})\n\n${t('email.showing', { count: messages.length })}\n\n${messages.join('\n')}`
      // content 简洁，toolResult 详细
      executor.addStep({
        type: 'tool_result',
        content: `🔍 搜索到 ${uids.length} 封邮件`,
        toolName: 'email_search',
        toolResult: output
      })

      return { success: true, output }
    } finally {
      lock.release()
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : t('email.search_failed')
    return { success: false, output: '', error: errorMsg }
  }
}

/**
 * 发送邮件
 */
async function emailSend(
  args: Record<string, unknown>,
  toolCallId: string,
  config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const to = args.to as string
  const subject = args.subject as string
  const body = args.body as string | undefined
  const html = args.html as string | undefined
  const cc = args.cc as string | undefined
  const bcc = args.bcc as string | undefined
  const attachments = args.attachments as string[] | undefined

  if (!to || !subject) {
    return { success: false, output: '', error: t('email.to_and_subject_required') }
  }

  const session = getFirstOpenSession()
  if (!session || !session.smtpTransporter) {
    return { success: false, output: '', error: t('email.not_connected') }
  }

  // 构建确认信息
  let confirmInfo = `${t('email.send_confirm')}\n\n`
  confirmInfo += `**${t('email.to')}**: ${to}\n`
  if (cc) confirmInfo += `**${t('email.cc')}**: ${cc}\n`
  if (bcc) confirmInfo += `**${t('email.bcc')}**: ${bcc}\n`
  confirmInfo += `**${t('email.subject')}**: ${subject}\n`
  if (attachments && attachments.length > 0) {
    confirmInfo += `**${t('email.attachments')}**: ${attachments.length} ${t('email.files')}\n`
  }

  // 请求用户确认
  executor.addStep({
    type: 'tool_call',
    content: confirmInfo,
    toolName: 'email_send',
    toolArgs: { to, subject, attachments_count: attachments?.length || 0 },
    riskLevel: 'dangerous'
  })

  const approved = await executor.waitForConfirmation(
    toolCallId,
    'email_send',
    { to, subject },
    'dangerous'
  )

  if (!approved) {
    return { success: false, output: '', error: t('email.user_rejected') }
  }

  try {
    // 构建邮件选项
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mailOptions: any = {
      from: session.email,
      to,
      subject,
      text: body,
      html: html
    }

    if (cc) mailOptions.cc = cc
    if (bcc) mailOptions.bcc = bcc

    // 处理附件
    if (attachments && attachments.length > 0) {
      mailOptions.attachments = attachments.map(filePath => {
        const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(filePath)
        if (!fs.existsSync(absolutePath)) {
          throw new Error(t('email.attachment_not_found', { path: filePath }))
        }
        return {
          filename: path.basename(absolutePath),
          path: absolutePath
        }
      })
    }

    // 发送邮件
    const info = await session.smtpTransporter.sendMail(mailOptions)

    const output = t('email.sent_success', { to, messageId: info.messageId })
    executor.addStep({
      type: 'tool_result',
      content: output,
      toolName: 'email_send',
      toolResult: output
    })

    return { success: true, output }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : t('email.send_failed')
    return { success: false, output: '', error: errorMsg }
  }
}

/**
 * 删除/移动邮件
 */
async function emailDelete(
  args: Record<string, unknown>,
  toolCallId: string,
  config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const folder = (args.folder as string) || 'INBOX'
  const uids = args.uids as number[]
  const action = args.action as 'trash' | 'delete' | 'move'
  const targetFolder = args.target_folder as string | undefined

  if (!uids || uids.length === 0) {
    return { success: false, output: '', error: t('email.uids_required') }
  }

  if (action === 'move' && !targetFolder) {
    return { success: false, output: '', error: t('email.target_folder_required') }
  }

  const session = getFirstOpenSession()
  if (!session || !session.imapClient) {
    return { success: false, output: '', error: t('email.not_connected') }
  }
  
  // 检查 IMAP 连接是否有效
  if (!session.imapClient.usable) {
    await closeSession(session.accountId)
    return { 
      success: false, 
      output: '', 
      error: t('email.connection_lost') + ' ' + t('email.please_reconnect')
    }
  }

  // 构建确认信息
  const actionText = action === 'trash' ? t('email.action_trash')
    : action === 'delete' ? t('email.action_delete')
    : t('email.action_move', { folder: targetFolder || '' })

  const confirmInfo = `${actionText}\n\n${t('email.affected_messages')}: ${uids.length}\nUIDs: ${uids.join(', ')}`

  // 请求用户确认
  executor.addStep({
    type: 'tool_call',
    content: confirmInfo,
    toolName: 'email_delete',
    toolArgs: { action, count: uids.length },
    riskLevel: 'moderate'
  })

  const approved = await executor.waitForConfirmation(
    toolCallId,
    'email_delete',
    { action, uids },
    'moderate'
  )

  if (!approved) {
    return { success: false, output: '', error: t('email.user_rejected') }
  }

  try {
    const lock = await session.imapClient.getMailboxLock(folder)
    try {
      const uidSequence = uids.join(',')

      switch (action) {
        case 'trash':
          // 移动到垃圾箱
          await session.imapClient.messageMove(uidSequence, 'Trash', { uid: true })
          break
        case 'delete':
          // 永久删除
          await session.imapClient.messageDelete(uidSequence, { uid: true })
          break
        case 'move':
          // 移动到目标文件夹
          await session.imapClient.messageMove(uidSequence, targetFolder!, { uid: true })
          break
      }

      const output = t('email.operation_success', { count: uids.length, action: actionText })
      executor.addStep({
        type: 'tool_result',
        content: output,
        toolName: 'email_delete',
        toolResult: output
      })

      return { success: true, output }
    } finally {
      lock.release()
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : t('email.operation_failed')
    return { success: false, output: '', error: errorMsg }
  }
}

// ============ 辅助函数 ============

/**
 * 获取第一个有效的会话（IMAP 连接可用）
 */
function getFirstOpenSession() {
  const sessions = getAllSessions()
  // 优先返回 IMAP 连接可用的会话
  const validSession = sessions.find(s => s.imapClient?.usable)
  if (validSession) {
    return validSession
  }
  // 如果没有有效连接，返回第一个会话（后续操作会报错提示重新连接）
  return sessions[0]
}

/**
 * 检查会话是否有效
 */
function isSessionValid(session: ReturnType<typeof getSession>): boolean {
  return !!session?.imapClient?.usable
}

/**
 * 截断输出
 */
function truncateOutput(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  return text.slice(0, maxLength) + '\n\n... (' + t('email.output_truncated') + ')'
}

/**
 * 格式化简短日期：MM/DD HH:mm
 */
function formatShortDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${month}/${day} ${hours}:${minutes}`
}

/**
 * 格式化邮箱地址，只保留名字或邮箱前缀
 */
function formatAddress(addr: { name?: string; address?: string }): string {
  if (addr.name) {
    return addr.name
  }
  if (addr.address) {
    // 只取邮箱 @ 前面的部分
    return addr.address.split('@')[0]
  }
  return ''
}

/**
 * 格式化地址列表，限制显示数量
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatAddressList(addresses: any, maxCount: number = 3): string {
  if (!addresses) return ''
  
  // 统一转为数组 - 处理 mailparser 的 AddressObject 类型
  let addrArray: Array<{ name?: string; address?: string }> = []
  
  if (Array.isArray(addresses)) {
    // AddressObject[] - 提取每个对象的 value
    addresses.forEach(addr => {
      if (addr.value && Array.isArray(addr.value)) {
        addrArray.push(...addr.value)
      } else if (addr.address) {
        addrArray.push(addr)
      }
    })
  } else if (addresses.value && Array.isArray(addresses.value)) {
    // 单个 AddressObject
    addrArray = addresses.value
  } else if (addresses.address) {
    addrArray = [addresses]
  }
  
  if (addrArray.length === 0) return ''
  
  const formatted = addrArray.slice(0, maxCount).map(formatAddress).filter(Boolean)
  
  if (addrArray.length > maxCount) {
    return formatted.join(', ') + ` 等 ${addrArray.length} 人`
  }
  
  return formatted.join(', ')
}

