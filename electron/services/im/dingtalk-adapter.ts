/**
 * DingTalk Adapter - 钉钉 Stream 模式适配器
 *
 * 使用钉钉官方 Stream SDK 建立长连接，接收机器人消息。
 * 支持私聊和群聊两种模式。
 *
 * 配置步骤：
 * 1. 在钉钉开发者后台创建企业内部应用
 * 2. 获取 ClientID（AppKey）和 ClientSecret（AppSecret）
 * 3. 添加机器人能力，选择 Stream 模式
 * 4. 发布应用
 */

import type { IMAdapter, IMIncomingMessage, IMPlatform, DingTalkConfig } from './types'
import { IM_TEXT_MAX_LENGTH } from './types'

// dingtalk-stream SDK 导入
let DWClient: any
let TOPIC_ROBOT: string

async function loadSDK() {
  try {
    const sdk = await import('dingtalk-stream')
    DWClient = sdk.DWClient
    TOPIC_ROBOT = sdk.TOPIC_ROBOT
  } catch (err) {
    console.error('[DingTalk] Failed to load dingtalk-stream SDK:', err)
    throw new Error('dingtalk-stream SDK not available')
  }
}

/**
 * 钉钉机器人消息结构
 */
interface RobotMessage {
  conversationId: string
  chatbotCorpId: string
  chatbotUserId: string
  msgId: string
  senderNick: string
  isAdmin: boolean
  senderStaffId: string
  sessionWebhookExpiredTime: number
  createAt: number
  senderCorpId: string
  conversationType: '1' | '2' // 1=单聊 2=群聊
  msgtype: string
  text?: { content: string }
  sessionWebhook: string
  isInAtList?: boolean
  atUsers?: Array<{ dingtalkId: string }>
}

export class DingTalkAdapter implements IMAdapter {
  readonly platform: IMPlatform = 'dingtalk'

  private client: any = null
  private connected = false
  private config: DingTalkConfig

  onMessage: ((msg: IMIncomingMessage) => void) | null = null
  onConnectionChange: ((connected: boolean) => void) | null = null

  constructor(config: DingTalkConfig) {
    this.config = config
  }

  async start(): Promise<void> {
    if (this.connected) {
      console.log('[DingTalk] Already connected')
      return
    }

    await loadSDK()

    this.client = new DWClient({
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
    })

    // 注册机器人消息回调
    this.client.registerCallbackListener(TOPIC_ROBOT, async (res: any) => {
      try {
        await this.handleRobotMessage(res)
      } catch (err) {
        console.error('[DingTalk] Error handling robot message:', err)
      }
    })

    // 注册全局事件监听（用于 ACK）
    this.client.registerAllEventListener((message: any) => {
      return { status: 'SUCCESS' }
    })

    // 建立连接
    try {
      await this.client.connect()
      this.connected = true
      this.onConnectionChange?.(true)
      console.log('[DingTalk] Stream connected')
    } catch (err) {
      this.connected = false
      this.onConnectionChange?.(false)
      throw err
    }
  }

  async stop(): Promise<void> {
    if (this.client) {
      try {
        this.client.disconnect()
      } catch { /* ignore */ }
      this.client = null
    }
    this.connected = false
    this.onConnectionChange?.(false)
    console.log('[DingTalk] Disconnected')
  }

  isConnected(): boolean {
    return this.connected
  }

  /**
   * 通过 sessionWebhook 发送纯文本消息
   */
  async sendText(replyContext: any, text: string): Promise<void> {
    const truncated = this.truncateText(text)

    if (replyContext.sessionWebhook && !this.isWebhookExpired(replyContext)) {
      await this.postToWebhook(replyContext.sessionWebhook, {
        msgtype: 'text',
        text: { content: truncated }
      })
    } else {
      // Webhook 过期，使用 REST API
      await this.sendViaRestApi(replyContext, 'sampleText', JSON.stringify({ content: truncated }))
    }
  }

  /**
   * 通过 sessionWebhook 发送 Markdown 消息
   */
  async sendMarkdown(replyContext: any, title: string, content: string): Promise<void> {
    const truncated = this.truncateText(content)

    if (replyContext.sessionWebhook && !this.isWebhookExpired(replyContext)) {
      await this.postToWebhook(replyContext.sessionWebhook, {
        msgtype: 'markdown',
        markdown: {
          title: title.substring(0, 50),
          text: truncated
        }
      })
    } else {
      await this.sendViaRestApi(replyContext, 'sampleMarkdown', JSON.stringify({
        title: title.substring(0, 50),
        text: truncated
      }))
    }
  }

  // ==================== 内部方法 ====================

  /**
   * 处理机器人消息
   */
  private async handleRobotMessage(res: any) {
    const robotMsg: RobotMessage = JSON.parse(res.data)

    // 立即 ACK，避免重试
    try {
      this.client.socketCallBackResponse(res.headers.messageId, { status: 'OK' })
    } catch { /* ignore */ }

    // 提取消息内容
    let text = ''
    if (robotMsg.msgtype === 'text' && robotMsg.text) {
      text = robotMsg.text.content?.trim() || ''
    } else {
      // 暂时只支持文本消息
      return
    }

    if (!text) return

    const userId = robotMsg.senderStaffId
    const userName = robotMsg.senderNick || ''
    const chatType = robotMsg.conversationType === '1' ? 'single' as const : 'group' as const
    const chatId = robotMsg.conversationId

    const replyContext = {
      sessionWebhook: robotMsg.sessionWebhook,
      sessionWebhookExpiredTime: robotMsg.sessionWebhookExpiredTime,
      senderStaffId: robotMsg.senderStaffId,
      conversationType: robotMsg.conversationType,
      conversationId: robotMsg.conversationId,
    }

    const msg: IMIncomingMessage = {
      platform: 'dingtalk',
      userId,
      userName,
      text,
      chatType,
      chatId,
      replyContext,
    }

    this.onMessage?.(msg)
  }

  /**
   * POST 到 sessionWebhook
   * 失败时抛出异常，由调用方决定如何处理
   */
  private async postToWebhook(webhookUrl: string, body: any): Promise<void> {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`[DingTalk] Webhook failed: ${response.status} ${text}`)
    }
  }

  /**
   * 通过 REST API 发送消息（Webhook 过期时的后备方案）
   * 失败时抛出异常，由调用方决定如何处理
   */
  private async sendViaRestApi(replyContext: any, msgKey: string, msgParam: string): Promise<void> {
    if (!this.client) throw new Error('[DingTalk] Client not initialized')

    const accessToken = await this.client.getAccessToken()
    const url = replyContext.conversationType === '1'
      ? 'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend'
      : 'https://api.dingtalk.com/v1.0/robot/groupMessages/send'

    const body: any = {
      robotCode: this.config.clientId,
      msgKey,
      msgParam,
    }

    if (replyContext.conversationType === '1') {
      body.userIds = [replyContext.senderStaffId]
    } else {
      body.openConversationId = replyContext.conversationId
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-acs-dingtalk-access-token': accessToken,
      },
      body: JSON.stringify(body)
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`[DingTalk] REST API failed: ${response.status} ${text}`)
    }
  }

  /**
   * 检查 Webhook 是否过期
   */
  private isWebhookExpired(replyContext: any): boolean {
    const expiredTime = replyContext.sessionWebhookExpiredTime
    if (typeof expiredTime !== 'number' || isNaN(expiredTime) || expiredTime <= 0) {
      return true
    }
    // 提前 5 分钟视为过期
    return Date.now() > expiredTime - 5 * 60 * 1000
  }

  /**
   * 截断过长文本
   */
  private truncateText(text: string): string {
    if (text.length <= IM_TEXT_MAX_LENGTH) return text
    return text.substring(0, IM_TEXT_MAX_LENGTH - 20) + '\n\n...(内容已截断)'
  }
}
