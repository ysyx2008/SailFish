/**
 * Slack Adapter - Slack Socket Mode 适配器
 *
 * 使用 Slack Bolt SDK 的 Socket Mode 建立 WebSocket 连接，接收机器人消息。
 * 支持私聊（DM）和频道（Channel）两种模式。
 *
 * 配置步骤：
 * 1. 在 Slack API (api.slack.com) 创建 App
 * 2. 在 OAuth & Permissions 中添加 Bot Token Scopes:
 *    - chat:write, files:read, files:write, im:history, im:read, im:write,
 *      channels:history, channels:read, groups:history, groups:read
 * 3. 在 Event Subscriptions 中订阅 message.im, message.channels, message.groups
 * 4. 在 Socket Mode 中启用 Socket Mode，生成 App-Level Token (xapp-...)
 * 5. Install App 到 Workspace，获取 Bot Token (xoxb-...)
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { IMAdapter, IMIncomingMessage, IMPlatform, SlackConfig, IMAttachment } from './types'
import { IM_TEXT_MAX_LENGTH, IM_FILE_MAX_SIZE_SLACK, IM_DOWNLOAD_MAX_SIZE } from './types'
import { t } from '../agent/i18n'

// Slack SDK 懒加载
let App: any
let LogLevel: any

async function loadSDK() {
  try {
    const bolt = await import('@slack/bolt')
    App = bolt.App
    LogLevel = bolt.LogLevel
  } catch (err) {
    console.error('[Slack] Failed to load @slack/bolt:', err)
    throw new Error('@slack/bolt not available. Install with: npm install @slack/bolt')
  }
}

export class SlackAdapter implements IMAdapter {
  readonly platform: IMPlatform = 'slack'

  private app: any = null
  private connected = false
  private config: SlackConfig

  onMessage: ((msg: IMIncomingMessage) => void) | null = null
  onConnectionChange: ((connected: boolean) => void) | null = null

  constructor(config: SlackConfig) {
    this.config = config
  }

  async start(): Promise<void> {
    if (this.connected) {
      console.log('[Slack] Already connected')
      return
    }

    await loadSDK()

    this.app = new App({
      token: this.config.botToken,
      appToken: this.config.appToken,
      socketMode: true,
      logLevel: LogLevel.WARN,
    })

    // 监听所有消息事件
    this.app.message(async ({ message, say }: any) => {
      try {
        await this.handleMessageEvent(message)
      } catch (err) {
        console.error('[Slack] Error handling message event:', err)
      }
    })

    try {
      await this.app.start()
      this.connected = true
      this.onConnectionChange?.(true)
      console.log('[Slack] Socket Mode connected')
    } catch (err) {
      this.connected = false
      this.onConnectionChange?.(false)
      throw err
    }
  }

  async stop(): Promise<void> {
    if (this.app) {
      try {
        await this.app.stop()
      } catch {
        // 安全忽略
      }
      this.app = null
    }
    this.connected = false
    this.onConnectionChange?.(false)
    console.log('[Slack] Disconnected')
  }

  isConnected(): boolean {
    return this.connected
  }

  /**
   * 发送纯文本消息
   */
  async sendText(replyContext: any, text: string): Promise<void> {
    if (!this.app) throw new Error('[Slack] App not initialized')

    const truncated = this.truncateText(text)
    await this.app.client.chat.postMessage({
      channel: replyContext.channelId,
      text: truncated,
      ...(replyContext.threadTs ? { thread_ts: replyContext.threadTs } : {}),
    })
  }

  /**
   * 发送 Markdown 消息
   * Slack 使用 mrkdwn 格式（Slack 的类 Markdown 语法）
   */
  async sendMarkdown(replyContext: any, title: string, content: string): Promise<void> {
    if (!this.app) throw new Error('[Slack] App not initialized')

    const truncated = this.truncateText(content)
    await this.app.client.chat.postMessage({
      channel: replyContext.channelId,
      text: truncated,
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: title.substring(0, 150),
            emoji: true,
          }
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: truncated.substring(0, 3000),
          }
        }
      ],
      ...(replyContext.threadTs ? { thread_ts: replyContext.threadTs } : {}),
    })
  }

  /**
   * 发送图片消息
   */
  async sendImage(replyContext: any, filePath: string): Promise<void> {
    await this.sendFile(replyContext, filePath)
  }

  /**
   * 发送文件消息
   * 使用 Slack files.uploadV2 API
   */
  async sendFile(replyContext: any, filePath: string, fileName?: string): Promise<void> {
    if (!this.app) throw new Error('[Slack] App not initialized')

    let stat: fs.Stats
    try {
      stat = fs.statSync(filePath)
    } catch {
      throw new Error(`[Slack] File not found or not accessible: ${filePath}`)
    }
    if (!stat.isFile()) {
      throw new Error(`[Slack] Not a regular file: ${filePath}`)
    }
    if (stat.size === 0) {
      throw new Error(`[Slack] File is empty: ${filePath}`)
    }
    if (stat.size > IM_FILE_MAX_SIZE_SLACK) {
      const sizeMB = (stat.size / 1024 / 1024).toFixed(1)
      throw new Error(`[Slack] File too large: ${sizeMB}MB (limit: 1GB)`)
    }

    const resolvedFileName = fileName || path.basename(filePath)

    await this.app.client.filesUploadV2({
      channel_id: replyContext.channelId,
      file: fs.createReadStream(filePath),
      filename: resolvedFileName,
      ...(replyContext.threadTs ? { thread_ts: replyContext.threadTs } : {}),
    })
  }

  // ==================== 内部方法 ====================

  /**
   * 处理消息事件
   */
  private async handleMessageEvent(message: any) {
    // 忽略 bot 消息、编辑、删除等子类型
    if (message.subtype || message.bot_id) return
    // 忽略无文本也无文件的消息
    if (!message.text && (!message.files || message.files.length === 0)) return

    const channelId = message.channel
    const userId = message.user || ''
    const threadTs = message.thread_ts || message.ts

    // 获取用户名
    let userName = userId
    try {
      const userInfo = await this.app.client.users.info({ user: userId })
      userName = userInfo.user?.real_name || userInfo.user?.name || userId
    } catch {
      // 获取用户名失败，使用 userId
    }

    // 判断聊天类型：im = DM, channel/group = group
    let chatType: 'single' | 'group' = 'single'
    try {
      const convInfo = await this.app.client.conversations.info({ channel: channelId })
      chatType = convInfo.channel?.is_im ? 'single' : 'group'
    } catch {
      // 默认 single
    }

    // 处理文本
    const text = (message.text || '').trim()

    // 处理附件
    const attachments: IMAttachment[] = []
    if (message.files && message.files.length > 0) {
      for (const file of message.files) {
        try {
          const attachment = await this.downloadSlackFile(file)
          if (attachment) {
            attachments.push(attachment)
          }
        } catch (err) {
          console.error('[Slack] Failed to download file:', err)
        }
      }
    }

    if (!text && attachments.length === 0) return

    const replyContext = {
      channelId,
      threadTs,
    }

    const msg: IMIncomingMessage = {
      platform: 'slack',
      userId,
      userName,
      text,
      chatType,
      chatId: channelId,
      replyContext,
      ...(attachments.length > 0 ? { attachments } : {}),
    }

    this.onMessage?.(msg)
  }

  /**
   * 下载 Slack 文件到本地临时目录
   */
  private async downloadSlackFile(file: any): Promise<IMAttachment | null> {
    if (!file.url_private_download && !file.url_private) return null

    const downloadUrl = file.url_private_download || file.url_private
    const timestamp = Date.now()

    // 检查文件大小
    if (file.size && file.size > IM_DOWNLOAD_MAX_SIZE) {
      console.warn(`[Slack] File too large: ${(file.size / 1024 / 1024).toFixed(1)}MB`)
      return null
    }

    // 确定文件类型
    let attachmentType: IMAttachment['type'] = 'file'
    const mimetype = (file.mimetype || '').toLowerCase()
    if (mimetype.startsWith('image/')) {
      attachmentType = 'image'
    } else if (mimetype.startsWith('audio/')) {
      attachmentType = 'audio'
    } else if (mimetype.startsWith('video/')) {
      attachmentType = 'video'
    }

    const fileName = file.name
      ? this.sanitizeFileName(file.name)
      : `slack_file_${timestamp}`

    const tempDir = this.ensureTempDir()
    const localPath = path.join(tempDir, fileName)

    try {
      const response = await fetch(downloadUrl, {
        headers: {
          'Authorization': `Bearer ${this.config.botToken}`,
        },
      })

      if (!response.ok) {
        throw new Error(`Download failed: ${response.status}`)
      }

      const buffer = Buffer.from(await response.arrayBuffer())
      if (buffer.length > IM_DOWNLOAD_MAX_SIZE) {
        throw new Error(`File too large: ${(buffer.length / 1024 / 1024).toFixed(1)}MB`)
      }

      fs.writeFileSync(localPath, buffer)

      console.log(`[Slack] Downloaded file: ${localPath} (${(buffer.length / 1024).toFixed(1)}KB)`)
      return { type: attachmentType, localPath, fileName }
    } catch (err: any) {
      console.error(`[Slack] Failed to download file:`, err.message || err)
      return null
    }
  }

  /**
   * 清理文件名，防止路径遍历攻击
   */
  private sanitizeFileName(name: string): string {
    return name
      .replace(/[/\\]/g, '_')
      .replace(/\.\./g, '_')
      .replace(/[\x00-\x1f\x7f]/g, '')     // eslint-disable-line no-control-regex -- 故意移除控制字符
      .replace(/[<>:"|?*]/g, '_')
      .substring(0, 200)
      || 'unnamed'
  }

  /**
   * 确保临时下载目录存在
   */
  private ensureTempDir(): string {
    const dir = path.join(os.tmpdir(), 'sf-terminal-im', 'slack')
    fs.mkdirSync(dir, { recursive: true })
    return dir
  }

  /**
   * 截断过长文本
   */
  private truncateText(text: string): string {
    if (text.length <= IM_TEXT_MAX_LENGTH) return text
    const suffix = t('im.text_truncated')
    return text.substring(0, IM_TEXT_MAX_LENGTH - suffix.length) + suffix
  }
}
