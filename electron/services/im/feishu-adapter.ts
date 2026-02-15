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

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { IMAdapter, IMIncomingMessage, IMPlatform, FeishuConfig, IMAttachment } from './types'
import { IM_TEXT_MAX_LENGTH, IM_FILE_MAX_SIZE_FEISHU, IM_IMAGE_MAX_SIZE_FEISHU, IM_DOWNLOAD_MAX_SIZE } from './types'

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

  /**
   * 发送图片消息（内联显示）
   * 流程：先通过 im.image.create 上传图片获取 image_key，再发送 image 类型消息
   */
  async sendImage(replyContext: any, filePath: string): Promise<void> {
    if (!this.client) throw new Error('[Feishu] Client not initialized')

    // 检查文件存在性和大小
    let stat: fs.Stats
    try {
      stat = fs.statSync(filePath)
    } catch {
      throw new Error(`[Feishu] Image file not found or not accessible: ${filePath}`)
    }
    if (!stat.isFile()) {
      throw new Error(`[Feishu] Not a regular file: ${filePath}`)
    }
    if (stat.size === 0) {
      throw new Error(`[Feishu] Image file is empty: ${filePath}`)
    }
    if (stat.size > IM_IMAGE_MAX_SIZE_FEISHU) {
      const sizeMB = (stat.size / 1024 / 1024).toFixed(1)
      throw new Error(`[Feishu] Image too large: ${sizeMB}MB (limit: ${IM_IMAGE_MAX_SIZE_FEISHU / 1024 / 1024}MB)`)
    }

    // Step 1: 上传图片获取 image_key
    const imageKey = await this.uploadImage(filePath)

    // Step 2: 发送图片消息
    await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: replyContext.chatId,
        content: JSON.stringify({ image_key: imageKey }),
        msg_type: 'image',
      }
    })
  }

  /**
   * 发送文件消息
   * 流程：先通过 im.file.create 上传文件获取 file_key，再发送 file 类型消息
   */
  async sendFile(replyContext: any, filePath: string, fileName?: string): Promise<void> {
    if (!this.client) throw new Error('[Feishu] Client not initialized')

    // 检查文件存在性和大小（合并为一次系统调用）
    let stat: fs.Stats
    try {
      stat = fs.statSync(filePath)
    } catch {
      throw new Error(`[Feishu] File not found or not accessible: ${filePath}`)
    }
    if (!stat.isFile()) {
      throw new Error(`[Feishu] Not a regular file: ${filePath}`)
    }
    if (stat.size > IM_FILE_MAX_SIZE_FEISHU) {
      const sizeMB = (stat.size / 1024 / 1024).toFixed(1)
      throw new Error(`[Feishu] File too large: ${sizeMB}MB (limit: 30MB)`)
    }
    if (stat.size === 0) {
      throw new Error(`[Feishu] File is empty: ${filePath}`)
    }

    const resolvedFileName = fileName || path.basename(filePath)

    // Step 1: 上传文件获取 file_key
    const fileKey = await this.uploadFile(filePath, resolvedFileName)

    // Step 2: 发送文件消息
    await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: replyContext.chatId,
        content: JSON.stringify({ file_key: fileKey }),
        msg_type: 'file',
      }
    })
  }

  /**
   * 上传图片到飞书，返回 image_key
   */
  private async uploadImage(filePath: string): Promise<string> {
    const imageStream = fs.createReadStream(filePath)

    try {
      const response = await this.client.im.image.create({
        data: {
          image_type: 'message',
          image: imageStream,
        }
      })

      const imageKey = response?.image_key
      if (!imageKey) {
        throw new Error('[Feishu] Image upload returned no image_key')
      }

      return imageKey
    } catch (err: any) {
      throw new Error(`[Feishu] Image upload failed: ${this.extractApiError(err)}`)
    } finally {
      imageStream.destroy()
    }
  }

  /**
   * 上传文件到飞书，返回 file_key
   */
  private async uploadFile(filePath: string, fileName: string): Promise<string> {
    const fileStream = fs.createReadStream(filePath)

    try {
      // 根据文件扩展名推断 file_type
      const ext = path.extname(fileName).toLowerCase()
      const fileType = this.resolveFeishuFileType(ext)

      const response = await this.client.im.file.create({
        data: {
          file_type: fileType,
          file_name: fileName,
          file: fileStream,
        }
      })

      const fileKey = response?.file_key
      if (!fileKey) {
        throw new Error('[Feishu] File upload returned no file_key')
      }

      return fileKey
    } catch (err: any) {
      throw new Error(`[Feishu] File upload failed: ${this.extractApiError(err)}`)
    } finally {
      fileStream.destroy()
    }
  }

  /**
   * 将文件扩展名映射为飞书 file_type
   * 飞书支持的 file_type: opus(语音), mp4(视频), pdf, doc, xls, ppt, stream(二进制流)
   */
  private resolveFeishuFileType(ext: string): string {
    const typeMap: Record<string, string> = {
      '.opus': 'opus',
      '.mp4': 'mp4',
      '.pdf': 'pdf',
      '.doc': 'doc', '.docx': 'doc',
      '.xls': 'xls', '.xlsx': 'xls',
      '.ppt': 'ppt', '.pptx': 'ppt',
    }
    return typeMap[ext] || 'stream'
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
    const messageId = message.message_id

    // 解析消息内容
    let text = ''
    const attachments: IMAttachment[] = []
    const messageType = message.message_type

    if (messageType === 'text') {
      try {
        const content = JSON.parse(message.content)
        text = content.text?.trim() || ''
      } catch {
        text = ''
      }
    } else if (messageType === 'post') {
      // 富文本消息：提取纯文本
      try {
        const content = JSON.parse(message.content || '{}')
        text = this.extractPostText(content)
      } catch {
        text = ''
      }
    } else if (['image', 'audio', 'media', 'file'].includes(messageType)) {
      // 媒体消息：下载到本地临时目录
      try {
        const content = JSON.parse(message.content || '{}')
        const attachment = await this.downloadMessageResource(messageId, messageType, content)
        if (attachment) {
          attachments.push(attachment)
        }
      } catch (err) {
        console.error(`[Feishu] Failed to process ${messageType} message:`, err)
      }
    } else {
      console.log(`[Feishu] Unsupported message type: ${messageType}, ignoring`)
      return
    }

    // 群聊中需要 @机器人 才响应（检查 mentions）
    if (chatType === 'group') {
      // 飞书群聊中 @机器人 的消息会包含 mentions
      // 如果没有 @机器人，可以忽略（但有些配置下所有消息都会推送）
      // 先去掉 @mention 标记
      if (text && message.mentions && message.mentions.length > 0) {
        for (const mention of message.mentions) {
          text = text.replace(mention.key || '', '').trim()
        }
      }
    }

    // 没有文本也没有附件则忽略
    if (!text && attachments.length === 0) return

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
      ...(attachments.length > 0 ? { attachments } : {}),
    }

    this.onMessage?.(msg)
  }

  /**
   * 下载飞书消息中的媒体资源到本地临时目录
   */
  private async downloadMessageResource(
    messageId: string,
    messageType: string,
    content: any
  ): Promise<IMAttachment | null> {
    if (!this.client || !messageId) return null

    const timestamp = Date.now()
    let fileKey = ''
    let fileName = ''
    let resourceType = ''      // 飞书 API 的 type 参数：'image' | 'file'
    let attachmentType: IMAttachment['type'] = 'file'

    switch (messageType) {
      case 'image':
        fileKey = content.image_key
        fileName = `feishu_image_${timestamp}.png`
        resourceType = 'image'
        attachmentType = 'image'
        break
      case 'audio':
        fileKey = content.file_key
        fileName = `feishu_audio_${timestamp}.opus`
        resourceType = 'file'
        attachmentType = 'audio'
        break
      case 'media': // 视频
        fileKey = content.file_key
        fileName = content.file_name ? this.sanitizeFileName(content.file_name) : `feishu_video_${timestamp}.mp4`
        resourceType = 'file'
        attachmentType = 'video'
        break
      case 'file':
        fileKey = content.file_key
        fileName = content.file_name ? this.sanitizeFileName(content.file_name) : `feishu_file_${timestamp}`
        resourceType = 'file'
        attachmentType = 'file'
        break
      default:
        return null
    }

    if (!fileKey) {
      console.warn(`[Feishu] No file_key/image_key in ${messageType} message`)
      return null
    }

    const tempDir = this.ensureTempDir()
    const localPath = path.join(tempDir, fileName)

    try {
      const resp = await this.client.im.messageResource.get({
        path: {
          message_id: messageId,
          file_key: fileKey,
        },
        params: {
          type: resourceType,
        },
      })

      await this.saveResponseToFile(resp, localPath)

      // 下载后检查文件大小
      const stat = fs.statSync(localPath)
      if (stat.size > IM_DOWNLOAD_MAX_SIZE) {
        fs.unlinkSync(localPath)
        throw new Error(`File too large: ${(stat.size / 1024 / 1024).toFixed(1)}MB (limit: ${IM_DOWNLOAD_MAX_SIZE / 1024 / 1024}MB)`)
      }

      console.log(`[Feishu] Downloaded ${messageType}: ${localPath} (${(stat.size / 1024).toFixed(1)}KB)`)
      return { type: attachmentType, localPath, fileName }
    } catch (err: any) {
      console.error(`[Feishu] Failed to download ${messageType} (key=${fileKey}):`, this.extractApiError(err))
      return null
    }
  }

  /**
   * 将 SDK 响应（可能是 Buffer、Stream 或包装对象）写入文件
   */
  private async saveResponseToFile(resp: any, filePath: string): Promise<void> {
    if (Buffer.isBuffer(resp)) {
      fs.writeFileSync(filePath, resp)
    } else if (resp && typeof resp.pipe === 'function') {
      // Readable stream
      const ws = fs.createWriteStream(filePath)
      try {
        await new Promise<void>((resolve, reject) => {
          resp.pipe(ws)
          ws.on('finish', resolve)
          ws.on('error', reject)
          resp.on('error', reject)
        })
      } catch (err) {
        ws.destroy()
        // 清理可能残留的损坏文件
        try { fs.unlinkSync(filePath) } catch { /* ignore */ }
        throw err
      }
    } else if (resp?.writeFile) {
      // 某些 SDK 版本返回 { writeFile: Buffer }
      fs.writeFileSync(filePath, resp.writeFile)
    } else {
      throw new Error(`Unexpected response format: ${typeof resp}`)
    }
  }

  /**
   * 从富文本（post）消息中提取纯文本
   */
  private extractPostText(content: any): string {
    try {
      // 飞书 post 格式: { zh_cn: { title, content: [[{tag, text}, ...]] } }
      // 也可能是 { title, content: [[...]] }
      const post = content.zh_cn || content.en_us || content.ja_jp || content
      const lines: string[] = []

      if (post.title) lines.push(post.title)

      if (Array.isArray(post.content)) {
        for (const paragraph of post.content) {
          if (Array.isArray(paragraph)) {
            const lineText = paragraph
              .filter((el: any) => el.tag === 'text' || el.tag === 'a')
              .map((el: any) => el.text || el.href || '')
              .join('')
            if (lineText) lines.push(lineText)
          }
        }
      }

      return lines.join('\n').trim()
    } catch {
      return ''
    }
  }

  /**
   * 清理文件名，防止路径遍历攻击
   * 移除路径分隔符、特殊字符，仅保留安全字符
   */
  private sanitizeFileName(name: string): string {
    return name
      .replace(/[/\\]/g, '_')               // 路径分隔符
      .replace(/\.\./g, '_')                // 路径遍历
      .replace(/[\x00-\x1F\x7F]/g, '')     // 控制字符
      .replace(/[<>:"|?*]/g, '_')           // Windows 特殊字符
      .substring(0, 200)                    // 限制长度
      || 'unnamed'
  }

  /**
   * 确保临时下载目录存在
   */
  private ensureTempDir(): string {
    const dir = path.join(os.tmpdir(), 'sf-terminal-im', 'feishu')
    fs.mkdirSync(dir, { recursive: true })
    return dir
  }

  /**
   * 从飞书 SDK 错误中提取详细 API 错误信息
   */
  private extractApiError(err: any): string {
    // 飞书 SDK 错误可能在 response.data 中包含 code 和 msg
    const code = err?.response?.data?.code ?? err?.code
    const msg = err?.response?.data?.msg ?? err?.msg
    if (code !== undefined && msg) {
      return `code=${code}, msg=${msg}`
    }
    // 回退到原始错误消息
    return err?.message || 'Unknown error'
  }

  /**
   * 截断过长文本
   */
  private truncateText(text: string): string {
    if (text.length <= IM_TEXT_MAX_LENGTH) return text
    return text.substring(0, IM_TEXT_MAX_LENGTH - 20) + '\n\n...(内容已截断)'
  }
}
