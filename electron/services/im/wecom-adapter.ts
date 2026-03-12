/**
 * WeCom Adapter - 企业微信 WebSocket 长连接适配器
 *
 * 使用官方 @wecom/aibot-node-sdk 建立长连接，接收智能机器人消息。
 * 支持单聊和群聊两种模式。
 *
 * 配置步骤：
 * 1. 在企业微信管理后台创建智能机器人
 * 2. 开启 API 模式，选择「长连接」方式
 * 3. 获取 BotID 和 Secret
 * 4. 填入配置，点击连接
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { IMAdapter, IMIncomingMessage, IMPlatform, WeComConfig, IMAttachment } from './types'
import { IM_TEXT_MAX_LENGTH, IM_DOWNLOAD_MAX_SIZE } from './types'
import { t } from '../agent/i18n'
import { createLogger } from '../../utils/logger'

const log = createLogger('WeCom')

let AiBot: any

async function loadSDK() {
  try {
    const sdk = await import('@wecom/aibot-node-sdk')
    AiBot = sdk.default || sdk
  } catch (err) {
    log.error('Failed to load @wecom/aibot-node-sdk:', err)
    throw new Error('@wecom/aibot-node-sdk not available')
  }
}

export class WeComAdapter implements IMAdapter {
  readonly platform: IMPlatform = 'wecom'

  private wsClient: any = null
  private connected = false
  private config: WeComConfig
  /** msgid 去重集合，防止重复处理 */
  private processedMsgIds = new Set<string>()
  private static readonly MSG_ID_TTL_MS = 5 * 60 * 1000 // 5 min
  private abortStartController: AbortController | null = null

  onMessage: ((msg: IMIncomingMessage) => void) | null = null
  onConnectionChange: ((connected: boolean) => void) | null = null

  constructor(config: WeComConfig) {
    this.config = config
  }

  async start(): Promise<void> {
    if (this.connected) {
      log.info('Already connected')
      return
    }

    await loadSDK()

    this.wsClient = new AiBot.WSClient({
      botId: this.config.botId,
      secret: this.config.secret,
      maxReconnectAttempts: -1,
      heartbeatInterval: 30_000,
      logger: {
        debug: (...args: any[]) => log.debug('[SDK]', ...args),
        info: (...args: any[]) => log.info('[SDK]', ...args),
        warn: (...args: any[]) => log.warn('[SDK]', ...args),
        error: (...args: any[]) => log.error('[SDK]', ...args),
      },
    })

    this.wsClient.on('authenticated', () => {
      log.info('WebSocket authenticated')
      if (!this.connected) {
        this.connected = true
        this.onConnectionChange?.(true)
      }
    })

    this.wsClient.on('disconnected', (reason: string) => {
      log.info('WebSocket disconnected:', reason)
      if (this.connected) {
        this.connected = false
        this.onConnectionChange?.(false)
      }
    })

    this.wsClient.on('reconnecting', (attempt: number) => {
      log.info(`Reconnecting (attempt ${attempt})...`)
    })

    this.wsClient.on('error', (err: Error) => {
      log.error('WebSocket error:', err)
    })

    this.wsClient.on('message.text', (frame: any) => this.handleTextMessage(frame))
    this.wsClient.on('message.image', (frame: any) => this.handleMediaMessage(frame, 'image'))
    this.wsClient.on('message.voice', (frame: any) => this.handleVoiceMessage(frame))
    this.wsClient.on('message.file', (frame: any) => this.handleMediaMessage(frame, 'file'))
    this.wsClient.on('message.mixed', (frame: any) => this.handleMixedMessage(frame))

    this.wsClient.connect()

    // 等待认证完成（最长 15 秒）
    this.abortStartController = new AbortController()
    const { signal } = this.abortStartController
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('WeCom WebSocket authentication timeout'))
        }, 15_000)

        const cleanup = () => {
          clearTimeout(timeout)
          signal.removeEventListener('abort', onAbort)
          this.wsClient?.removeListener('authenticated', onAuth)
          this.wsClient?.removeListener('error', onErr)
        }

        const onAuth = () => { cleanup(); resolve() }
        const onErr = (err: Error) => { cleanup(); reject(err) }
        const onAbort = () => { cleanup(); reject(new Error('WeCom connection aborted')) }

        signal.addEventListener('abort', onAbort)
        this.wsClient.once('authenticated', onAuth)
        this.wsClient.once('error', onErr)
      })
    } finally {
      this.abortStartController = null
    }
  }

  async stop(): Promise<void> {
    this.abortStartController?.abort()
    if (this.wsClient) {
      this.wsClient.disconnect()
      this.wsClient = null
    }
    this.connected = false
    this.processedMsgIds.clear()
    this.onConnectionChange?.(false)
    log.info('Disconnected')
  }

  isConnected(): boolean {
    return this.connected
  }

  // ==================== 发送消息 ====================

  async sendText(replyContext: any, text: string): Promise<void> {
    if (!this.wsClient) return
    const truncated = this.truncateText(text)
    if (replyContext.reqId) {
      await this.replyViaStream(replyContext.reqId, truncated)
    } else if (replyContext.chatId) {
      await this.wsClient.sendMessage(replyContext.chatId, {
        msgtype: 'markdown',
        markdown: { content: truncated },
      })
    } else {
      log.warn('sendText: replyContext missing both reqId and chatId, message dropped')
    }
  }

  async sendMarkdown(replyContext: any, _title: string, content: string): Promise<void> {
    if (!this.wsClient) return
    const truncated = this.truncateText(content)
    if (replyContext.reqId) {
      await this.replyViaStream(replyContext.reqId, truncated)
    } else if (replyContext.chatId) {
      await this.wsClient.sendMessage(replyContext.chatId, {
        msgtype: 'markdown',
        markdown: { content: truncated },
      })
    } else {
      log.warn('sendMarkdown: replyContext missing both reqId and chatId, message dropped')
    }
  }

  async sendImage(_replyContext: any, _filePath: string): Promise<void> {
    log.warn('sendImage not supported in WeCom long-connection mode, falling back to file description')
  }

  async sendFile(_replyContext: any, _filePath: string, _fileName?: string): Promise<void> {
    log.warn('sendFile not supported in WeCom long-connection mode, falling back to file description')
  }

  // ==================== 消息处理 ====================

  private handleTextMessage(frame: any) {
    const body = frame.body
    if (!body || this.isDuplicate(body.msgid)) return

    const text = body.text?.content?.trim() || ''
    if (!text) return

    this.emitMessage(frame, text, [])
  }

  private handleVoiceMessage(frame: any) {
    const body = frame.body
    if (!body || this.isDuplicate(body.msgid)) return

    const text = body.voice?.content?.trim() || ''
    if (!text) return

    this.emitMessage(frame, text, [])
  }

  private async handleMediaMessage(frame: any, type: 'image' | 'file') {
    const body = frame.body
    if (!body || this.isDuplicate(body.msgid)) return

    const mediaInfo = type === 'image' ? body.image : body.file
    if (!mediaInfo?.url) return

    const attachments: IMAttachment[] = []
    try {
      const attachment = await this.downloadAndDecrypt(mediaInfo.url, mediaInfo.aeskey, type)
      if (attachment) attachments.push(attachment)
    } catch (err) {
      log.error(`Failed to download ${type}:`, err)
    }

    this.emitMessage(frame, '', attachments)
  }

  private async handleMixedMessage(frame: any) {
    const body = frame.body
    if (!body || this.isDuplicate(body.msgid)) return

    let text = ''
    const attachments: IMAttachment[] = []

    if (body.mixed?.msg_item) {
      for (const item of body.mixed.msg_item) {
        if (item.msgtype === 'text' && item.text?.content) {
          text += item.text.content
        } else if (item.msgtype === 'image' && item.image?.url) {
          try {
            const attachment = await this.downloadAndDecrypt(item.image.url, item.image.aeskey, 'image')
            if (attachment) attachments.push(attachment)
          } catch (err) {
            log.error('Failed to download mixed image:', err)
          }
        }
      }
    }

    if (!text && attachments.length === 0) return
    this.emitMessage(frame, text.trim(), attachments)
  }

  private emitMessage(frame: any, text: string, attachments: IMAttachment[]) {
    const body = frame.body
    const userId = body.from?.userid || ''
    if (!userId) return

    const reqId = frame.headers?.req_id || null
    const chatType = body.chattype === 'group' ? 'group' : 'single'
    const chatId = chatType === 'single' ? userId : (body.chatid || '')

    const replyContext = {
      reqId,
      chatId,
      chatType,
      userId,
    }

    const msg: IMIncomingMessage = {
      platform: 'wecom',
      userId,
      userName: userId,
      text,
      chatType,
      chatId: body.chatid,
      replyContext,
      ...(attachments.length > 0 ? { attachments } : {}),
    }

    this.onMessage?.(msg)
  }

  // ==================== 流式回复 ====================

  /**
   * 通过流式消息回复（长连接模式原生支持）
   * 对于非回调触发的消息（主动推送场景），使用 sendMessage
   */
  private async replyViaStream(reqId: string, content: string): Promise<void> {
    const sdk = await import('@wecom/aibot-node-sdk')
    const streamId = sdk.generateReqId('stream')

    await this.wsClient.replyStream(
      { headers: { req_id: reqId } },
      streamId,
      content,
      true,
    )
  }

  // ==================== 文件下载解密 ====================

  private async downloadAndDecrypt(
    url: string, aesKey: string | undefined, type: IMAttachment['type']
  ): Promise<IMAttachment | null> {
    if (!this.wsClient) return null

    const { buffer, filename } = await this.wsClient.downloadFile(url, aesKey)

    if (buffer.length > IM_DOWNLOAD_MAX_SIZE) {
      throw new Error(`File too large: ${(buffer.length / 1024 / 1024).toFixed(1)}MB`)
    }

    const extMap: Record<string, string> = {
      image: '.png',
      audio: '.amr',
      video: '.mp4',
      file: '',
    }
    const ext = extMap[type] || ''
    const fileName = filename || `wecom_${type}_${Date.now()}${ext}`
    const sanitized = this.sanitizeFileName(fileName)

    const tempDir = this.ensureTempDir()
    const localPath = path.join(tempDir, sanitized)
    fs.writeFileSync(localPath, buffer)

    log.info(`Downloaded ${type}: ${localPath} (${(buffer.length / 1024).toFixed(1)}KB)`)
    return { type, localPath, fileName: sanitized }
  }

  // ==================== 工具方法 ====================

  private isDuplicate(msgId: string | undefined): boolean {
    if (!msgId) return false
    if (this.processedMsgIds.has(msgId)) return true
    this.processedMsgIds.add(msgId)
    setTimeout(() => this.processedMsgIds.delete(msgId), WeComAdapter.MSG_ID_TTL_MS)
    return false
  }

  private sanitizeFileName(name: string): string {
    return name
      .replace(/[/\\]/g, '_')
      .replace(/\.\./g, '_')
      .replace(/[\x00-\x1f\x7f]/g, '')     // eslint-disable-line no-control-regex -- 移除控制字符
      .replace(/[<>:"|?*]/g, '_')
      .substring(0, 200)
      || 'unnamed'
  }

  private ensureTempDir(): string {
    const dir = path.join(os.tmpdir(), 'sf-terminal-im', 'wecom')
    fs.mkdirSync(dir, { recursive: true })
    return dir
  }

  private truncateText(text: string): string {
    if (text.length <= IM_TEXT_MAX_LENGTH) return text
    const suffix = t('im.text_truncated')
    return text.substring(0, IM_TEXT_MAX_LENGTH - suffix.length) + suffix
  }
}
