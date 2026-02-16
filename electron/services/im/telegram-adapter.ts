/**
 * Telegram Adapter - Telegram Bot API 适配器
 *
 * 使用 Telegraf SDK 的长轮询模式接收消息，无需公网服务器。
 * 支持私聊和群组两种模式。
 *
 * 配置步骤：
 * 1. 在 Telegram 中找到 @BotFather
 * 2. 发送 /newbot 创建机器人
 * 3. 获取 Bot Token
 * 4. 如需在群组中使用，将机器人添加到群组
 * 5. 可选：通过 /setprivacy 关闭 Privacy Mode 以接收所有群消息
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { IMAdapter, IMIncomingMessage, IMPlatform, TelegramConfig, IMAttachment } from './types'
import { IM_TEXT_MAX_LENGTH, IM_FILE_MAX_SIZE_TELEGRAM, IM_IMAGE_MAX_SIZE_TELEGRAM, IM_DOWNLOAD_MAX_SIZE } from './types'
import { t } from '../agent/i18n'

// Telegraf SDK 懒加载
let Telegraf: any

async function loadSDK() {
  try {
    const telegraf = await import('telegraf')
    Telegraf = telegraf.Telegraf
  } catch (err) {
    console.error('[Telegram] Failed to load telegraf:', err)
    throw new Error('telegraf not available. Install with: npm install telegraf')
  }
}

export class TelegramAdapter implements IMAdapter {
  readonly platform: IMPlatform = 'telegram'

  private bot: any = null
  private connected = false
  private config: TelegramConfig

  onMessage: ((msg: IMIncomingMessage) => void) | null = null
  onConnectionChange: ((connected: boolean) => void) | null = null

  constructor(config: TelegramConfig) {
    this.config = config
  }

  async start(): Promise<void> {
    if (this.connected) {
      console.log('[Telegram] Already connected')
      return
    }

    await loadSDK()

    this.bot = new Telegraf(this.config.botToken)

    // 监听文本消息
    this.bot.on('text', async (ctx: any) => {
      try {
        await this.handleMessage(ctx)
      } catch (err) {
        console.error('[Telegram] Error handling text message:', err)
      }
    })

    // 监听媒体消息（照片、文档、音频、视频、语音）
    for (const msgType of ['photo', 'document', 'audio', 'video', 'voice']) {
      this.bot.on(msgType, async (ctx: any) => {
        try {
          await this.handleMessage(ctx)
        } catch (err) {
          console.error(`[Telegram] Error handling ${msgType} message:`, err)
        }
      })
    }

    try {
      // 使用长轮询模式启动
      await this.bot.launch({ dropPendingUpdates: true })
      this.connected = true
      this.onConnectionChange?.(true)
      console.log('[Telegram] Long polling started')
    } catch (err) {
      this.connected = false
      this.onConnectionChange?.(false)
      throw err
    }
  }

  async stop(): Promise<void> {
    if (this.bot) {
      try {
        this.bot.stop('IMService stopped')
      } catch {
        // 安全忽略
      }
      this.bot = null
    }
    this.connected = false
    this.onConnectionChange?.(false)
    console.log('[Telegram] Disconnected')
  }

  isConnected(): boolean {
    return this.connected
  }

  /**
   * 发送纯文本消息
   */
  async sendText(replyContext: any, text: string): Promise<void> {
    if (!this.bot) throw new Error('[Telegram] Bot not initialized')

    const truncated = this.truncateText(text)
    await this.bot.telegram.sendMessage(replyContext.chatId, truncated, {
      ...(replyContext.topicId ? { message_thread_id: replyContext.topicId } : {}),
    })
  }

  /**
   * 发送 Markdown 消息
   * Telegram 支持 MarkdownV2 格式
   */
  async sendMarkdown(replyContext: any, title: string, content: string): Promise<void> {
    if (!this.bot) throw new Error('[Telegram] Bot not initialized')

    const truncated = this.truncateText(content)
    // Telegram 的 MarkdownV2 对特殊字符要求严格，退回到 HTML 格式更安全
    const htmlContent = `<b>${this.escapeHtml(title.substring(0, 100))}</b>\n\n${this.markdownToHtml(truncated)}`

    try {
      await this.bot.telegram.sendMessage(replyContext.chatId, htmlContent, {
        parse_mode: 'HTML',
        ...(replyContext.topicId ? { message_thread_id: replyContext.topicId } : {}),
      })
    } catch {
      // HTML 解析失败时退回纯文本
      await this.bot.telegram.sendMessage(
        replyContext.chatId,
        `${title}\n\n${truncated}`,
        {
          ...(replyContext.topicId ? { message_thread_id: replyContext.topicId } : {}),
        }
      )
    }
  }

  /**
   * 发送图片消息
   */
  async sendImage(replyContext: any, filePath: string): Promise<void> {
    if (!this.bot) throw new Error('[Telegram] Bot not initialized')

    let stat: fs.Stats
    try {
      stat = fs.statSync(filePath)
    } catch {
      throw new Error(`[Telegram] Image file not found: ${filePath}`)
    }
    if (!stat.isFile() || stat.size === 0) {
      throw new Error(`[Telegram] Invalid image file: ${filePath}`)
    }
    if (stat.size > IM_IMAGE_MAX_SIZE_TELEGRAM) {
      const sizeMB = (stat.size / 1024 / 1024).toFixed(1)
      throw new Error(`[Telegram] Image too large: ${sizeMB}MB (limit: 10MB)`)
    }

    await this.bot.telegram.sendPhoto(replyContext.chatId, {
      source: fs.createReadStream(filePath),
    }, {
      ...(replyContext.topicId ? { message_thread_id: replyContext.topicId } : {}),
    })
  }

  /**
   * 发送文件消息
   */
  async sendFile(replyContext: any, filePath: string, fileName?: string): Promise<void> {
    if (!this.bot) throw new Error('[Telegram] Bot not initialized')

    let stat: fs.Stats
    try {
      stat = fs.statSync(filePath)
    } catch {
      throw new Error(`[Telegram] File not found: ${filePath}`)
    }
    if (!stat.isFile() || stat.size === 0) {
      throw new Error(`[Telegram] Invalid file: ${filePath}`)
    }
    if (stat.size > IM_FILE_MAX_SIZE_TELEGRAM) {
      const sizeMB = (stat.size / 1024 / 1024).toFixed(1)
      throw new Error(`[Telegram] File too large: ${sizeMB}MB (limit: 50MB)`)
    }

    const resolvedFileName = fileName || path.basename(filePath)

    await this.bot.telegram.sendDocument(replyContext.chatId, {
      source: fs.createReadStream(filePath),
      filename: resolvedFileName,
    }, {
      ...(replyContext.topicId ? { message_thread_id: replyContext.topicId } : {}),
    })
  }

  // ==================== 内部方法 ====================

  /**
   * 处理消息
   */
  private async handleMessage(ctx: any) {
    const message = ctx.message
    if (!message) return

    // 忽略来自 bot 的消息
    if (message.from?.is_bot) return

    const chatId = message.chat.id
    const userId = String(message.from?.id || '')
    const userName = message.from?.first_name
      ? `${message.from.first_name}${message.from.last_name ? ' ' + message.from.last_name : ''}`
      : message.from?.username || userId
    const chatType = message.chat.type === 'private' ? 'single' as const : 'group' as const
    const topicId = message.message_thread_id

    // 提取文本
    let text = ''
    if (message.text) {
      text = message.text.trim()
      // 群聊中处理 @bot mention（移除 /command@botname 中的 @botname）
      if (chatType === 'group' && message.entities) {
        for (const entity of message.entities) {
          if (entity.type === 'bot_command') {
            // 保留命令本身，移除 @botname 后缀
            const cmdText = message.text.substring(entity.offset, entity.offset + entity.length)
            const atIndex = cmdText.indexOf('@')
            if (atIndex > 0) {
              text = text.replace(cmdText, cmdText.substring(0, atIndex))
            }
          }
        }
        text = text.trim()
      }
    } else if (message.caption) {
      text = message.caption.trim()
    }

    // 处理附件
    const attachments: IMAttachment[] = []

    if (message.photo && message.photo.length > 0) {
      // 选择最大尺寸的图片
      const photo = message.photo[message.photo.length - 1]
      const attachment = await this.downloadTelegramFile(photo.file_id, 'image', `telegram_photo_${Date.now()}.jpg`)
      if (attachment) attachments.push(attachment)
    }

    if (message.document) {
      const doc = message.document
      const fileName = doc.file_name ? this.sanitizeFileName(doc.file_name) : `telegram_file_${Date.now()}`
      const attachment = await this.downloadTelegramFile(doc.file_id, 'file', fileName)
      if (attachment) attachments.push(attachment)
    }

    if (message.audio) {
      const fileName = message.audio.file_name
        ? this.sanitizeFileName(message.audio.file_name)
        : `telegram_audio_${Date.now()}.mp3`
      const attachment = await this.downloadTelegramFile(message.audio.file_id, 'audio', fileName)
      if (attachment) attachments.push(attachment)
    }

    if (message.voice) {
      const attachment = await this.downloadTelegramFile(message.voice.file_id, 'audio', `telegram_voice_${Date.now()}.ogg`)
      if (attachment) attachments.push(attachment)
    }

    if (message.video) {
      const fileName = message.video.file_name
        ? this.sanitizeFileName(message.video.file_name)
        : `telegram_video_${Date.now()}.mp4`
      const attachment = await this.downloadTelegramFile(message.video.file_id, 'video', fileName)
      if (attachment) attachments.push(attachment)
    }

    if (!text && attachments.length === 0) return

    const replyContext = {
      chatId,
      topicId,
    }

    const msg: IMIncomingMessage = {
      platform: 'telegram',
      userId,
      userName,
      text,
      chatType,
      chatId: String(chatId),
      replyContext,
      ...(attachments.length > 0 ? { attachments } : {}),
    }

    this.onMessage?.(msg)
  }

  /**
   * 下载 Telegram 文件到本地临时目录
   */
  private async downloadTelegramFile(
    fileId: string,
    type: IMAttachment['type'],
    fileName: string
  ): Promise<IMAttachment | null> {
    if (!this.bot) return null

    try {
      // 获取文件链接
      const fileLink = await this.bot.telegram.getFileLink(fileId)
      const url = fileLink.href || fileLink.toString()

      const tempDir = this.ensureTempDir()
      const localPath = path.join(tempDir, fileName)

      const response = await fetch(url)
      if (!response.ok) {
        throw new Error(`Download failed: ${response.status}`)
      }

      const buffer = Buffer.from(await response.arrayBuffer())
      if (buffer.length > IM_DOWNLOAD_MAX_SIZE) {
        throw new Error(`File too large: ${(buffer.length / 1024 / 1024).toFixed(1)}MB`)
      }

      fs.writeFileSync(localPath, buffer)

      console.log(`[Telegram] Downloaded ${type}: ${localPath} (${(buffer.length / 1024).toFixed(1)}KB)`)
      return { type, localPath, fileName }
    } catch (err: any) {
      console.error(`[Telegram] Failed to download ${type}:`, err.message || err)
      return null
    }
  }

  /**
   * 将简单 Markdown 转换为 HTML（用于 Telegram HTML parse_mode）
   */
  private markdownToHtml(md: string): string {
    let html = this.escapeHtml(md)

    // 代码块 ```...```
    html = html.replace(/```([\s\S]*?)```/g, '<pre>$1</pre>')
    // 行内代码
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>')
    // 粗体 **...**
    html = html.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    // 斜体 *...*
    html = html.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<i>$1</i>')

    return html
  }

  /**
   * HTML 转义
   */
  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
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
    const dir = path.join(os.tmpdir(), 'sf-terminal-im', 'telegram')
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
