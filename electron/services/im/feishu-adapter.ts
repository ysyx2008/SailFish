/**
 * Feishu Adapter - 飞书 WebSocket 长连接适配器
 *
 * 使用飞书官方 Node SDK 的 WSClient 建立长连接，接收机器人消息。
 * 支持私聊和群聊两种模式。
 *
 * 配置步骤：
 * 1. 在飞书开发者后台创建企业自建应用
 * 2. 获取 App ID 和 App Secret
 * 3. 添加机器人能力
 * 4. 在「事件订阅」中添加 im.message.receive_v1 事件
 * 5. 选择长连接模式
 * 6. 发布应用版本
 */

import type { IMAdapter, IMIncomingMessage, IMPlatform, FeishuConfig } from './types'
import { IM_TEXT_MAX_LENGTH } from './types'

// 飞书 SDK 懒加载
let lark: any

async function loadSDK() {
  try {
    lark = await import('@larksuiteoapi/node-sdk')
  } catch (err) {
    console.error('[Feishu] Failed to load @larksuiteoapi/node-sdk:', err)
    throw new Error('@larksuiteoapi/node-sdk not available')
  }
}

export class FeishuAdapter implements IMAdapter {
  readonly platform: IMPlatform = 'feishu'

  private client: any = null
  private wsClient: any = null
  private connected = false
  private config: FeishuConfig

  onMessage: ((msg: IMIncomingMessage) => void) | null = null
  onConnectionChange: ((connected: boolean) => void) | null = null

  constructor(config: FeishuConfig) {
    this.config = config
  }

  async start(): Promise<void> {
    if (this.connected) {
      console.log('[Feishu] Already connected')
      return
    }

    await loadSDK()

    // 创建 API 客户端（用于发送消息）
    this.client = new lark.Client({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      appType: lark.AppType.SelfBuild,
      domain: lark.Domain.Feishu,
    })

    // 创建事件分发器
    const eventDispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: any) => {
        try {
          await this.handleMessageEvent(data)
        } catch (err) {
          console.error('[Feishu] Error handling message event:', err)
        }
      }
    })

    // 创建 WebSocket 长连接客户端
    this.wsClient = new lark.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      loggerLevel: lark.LoggerLevel.warn,
    })

    try {
      await this.wsClient.start({ eventDispatcher })
      this.connected = true
      this.onConnectionChange?.(true)
      console.log('[Feishu] WebSocket connected')
    } catch (err) {
      this.connected = false
      this.onConnectionChange?.(false)
      throw err
    }
  }

  async stop(): Promise<void> {
    if (this.wsClient) {
      try {
        await this.wsClient.stop()
      } catch {
        // WSClient.stop() 可能在未连接状态下抛异常，安全忽略
      }
      this.wsClient = null
    }
    this.client = null
    this.connected = false
    this.onConnectionChange?.(false)
    console.log('[Feishu] Disconnected')
  }

  isConnected(): boolean {
    return this.connected
  }

  /**
   * 发送纯文本消息
   * 失败时抛出异常，由调用方决定如何处理
   */
  async sendText(replyContext: any, text: string): Promise<void> {
    if (!this.client) throw new Error('[Feishu] Client not initialized')

    const truncated = this.truncateText(text)
    await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: replyContext.chatId,
        content: JSON.stringify({ text: truncated }),
        msg_type: 'text',
      }
    })
  }

  /**
   * 发送 Markdown 消息（以交互卡片形式）
   * 失败时抛出异常，由调用方决定如何处理
   */
  async sendMarkdown(replyContext: any, title: string, content: string): Promise<void> {
    if (!this.client) throw new Error('[Feishu] Client not initialized')

    const truncated = this.truncateText(content)
    await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: replyContext.chatId,
        content: JSON.stringify({
          config: { wide_screen_mode: true },
          elements: [
            {
              tag: 'markdown',
              content: truncated
            }
          ],
          header: {
            template: 'blue',
            title: {
              content: title.substring(0, 50),
              tag: 'plain_text'
            }
          }
        }),
        msg_type: 'interactive',
      }
    })
  }

  // ==================== 内部方法 ====================

  /**
   * 处理消息接收事件
   */
  private async handleMessageEvent(data: any) {
    const message = data.message
    const sender = data.sender

    if (!message || !sender) return

    const chatId = message.chat_id
    const chatType = message.chat_type === 'p2p' ? 'single' as const : 'group' as const
    const userId = sender.sender_id?.open_id || ''
    const userName = sender.sender_id?.user_id || userId

    // 解析消息内容
    let text = ''
    if (message.message_type === 'text') {
      try {
        const content = JSON.parse(message.content)
        text = content.text?.trim() || ''
      } catch {
        text = ''
      }
    } else {
      // 暂时只支持文本消息
      return
    }

    if (!text) return

    // 群聊中需要 @机器人 才响应（检查 mentions）
    if (chatType === 'group') {
      // 飞书群聊中 @机器人 的消息会包含 mentions
      // 如果没有 @机器人，可以忽略（但有些配置下所有消息都会推送）
      // 先去掉 @mention 标记
      if (message.mentions && message.mentions.length > 0) {
        for (const mention of message.mentions) {
          text = text.replace(mention.key || '', '').trim()
        }
      }
    }

    if (!text) return

    const replyContext = {
      chatId,
      openId: userId,
      chatType: message.chat_type,
    }

    const msg: IMIncomingMessage = {
      platform: 'feishu',
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
   * 截断过长文本
   */
  private truncateText(text: string): string {
    if (text.length <= IM_TEXT_MAX_LENGTH) return text
    return text.substring(0, IM_TEXT_MAX_LENGTH - 20) + '\n\n...(内容已截断)'
  }
}
