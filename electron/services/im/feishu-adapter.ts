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
import { t } from '../agent/i18n'

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
  private starting = false
  private config: FeishuConfig
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null

  onMessage: ((msg: IMIncomingMessage) => void) | null = null
  onConnectionChange: ((connected: boolean) => void) | null = null

  constructor(config: FeishuConfig) {
    this.config = config
  }

  async start(): Promise<void> {
    if (this.connected || this.starting) {
      console.log('[Feishu] Already connected or connecting')
      return
    }

    this.starting = true
    try {
      await loadSDK()

      // 先验证凭证，失败时直接返回飞书的错误信息给用户
      await this.verifyCredentials()

      this.client = new lark.Client({
        appId: this.config.appId,
        appSecret: this.config.appSecret,
        appType: lark.AppType.SelfBuild,
        domain: lark.Domain.Feishu,
      })

      const eventDispatcher = new lark.EventDispatcher({}).register({
        'im.message.receive_v1': async (data: any) => {
          try {
            await this.handleMessageEvent(data)
          } catch (err) {
            console.error('[Feishu] Error handling message event:', err)
          }
        }
      })

      this.wsClient = new lark.WSClient({
        appId: this.config.appId,
        appSecret: this.config.appSecret,
        loggerLevel: lark.LoggerLevel.warn,
      })

      await this.wsClient.start({ eventDispatcher })
      this.startHealthCheck()
    } catch (err) {
      this.updateConnected(false)
      if (this.wsClient) {
        try { this.wsClient.close({ force: true }) } catch {}
        this.wsClient = null
      }
      this.client = null
      throw err
    } finally {
      this.starting = false
    }
  }

  async stop(): Promise<void> {
    this.stopHealthCheck()
    if (this.wsClient) {
      try {
        this.wsClient.close({ force: true })
      } catch {
        // close() 可能在未连接状态下抛异常，安全忽略
      }
      this.wsClient = null
    }
    this.client = null
    this.updateConnected(false)
    console.log('[Feishu] Disconnected')
  }

  isConnected(): boolean {
    return this.connected
  }

  /**
   * 调用飞书 WS 端点验证凭证，失败时抛出包含飞书错误信息的异常。
   * 这与 SDK 内部 pullConnectConfig 调用的是同一个接口。
   */
  private async verifyCredentials(): Promise<void> {
    const resp = await fetch('https://open.feishu.cn/callback/ws/endpoint', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ AppID: this.config.appId, AppSecret: this.config.appSecret }),
      signal: AbortSignal.timeout(15_000),
    })
    const result = await resp.json()
    if (result.code !== 0) {
      throw new Error(result.msg || `Feishu API error (code: ${result.code})`)
    }
  }

  /**
   * 检查 SDK 内部 WebSocket 实例是否处于 OPEN 状态
   */
  private isWsOpen(): boolean {
    try {
      const ws = this.wsClient?.wsConfig?.getWSInstance?.()
      return ws != null && ws.readyState === 1
    } catch {
      return false
    }
  }

  private updateConnected(value: boolean): void {
    if (this.connected !== value) {
      this.connected = value
      this.onConnectionChange?.(value)
      console.log(`[Feishu] Connection state changed: ${value ? 'connected' : 'disconnected'}`)
    }
  }

  /**
   * 定期检查 WebSocket 实际连接状态，同步 connected 标志。
   * SDK 后台有自动重连，此处只负责感知状态变化并通知 UI。
   * 启动后前 60 秒每 3 秒检查一次（快速感知初始连接），之后降为每 30 秒。
   */
  private startHealthCheck(): void {
    this.stopHealthCheck()
    let checks = 0
    const fastPhaseChecks = 20
    const tick = () => {
      if (!this.wsClient) return
      this.updateConnected(this.isWsOpen())
      checks++
      if (checks === fastPhaseChecks) {
        this.stopHealthCheck()
        this.healthCheckTimer = setInterval(() => {
          if (!this.wsClient) return
          this.updateConnected(this.isWsOpen())
        }, 30_000)
      }
    }
    this.healthCheckTimer = setInterval(tick, 3_000)
  }

  private stopHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer)
      this.healthCheckTimer = null
    }
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
   * 流程：先通过 im.file.create 上传文件获取 file_key，再发送消息
   *
   * 飞书对不同媒体类型要求不同的 msg_type：
   * - mp4 视频 → msg_type: 'media'
   * - opus 音频 → msg_type: 'audio'
   * - 其他文件 → msg_type: 'file'
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

    // Step 2: 根据文件类型选择正确的 msg_type 发送消息
    const ext = path.extname(resolvedFileName).toLowerCase()
    const msgType = this.getFeishuMsgType(ext)

    await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: replyContext.chatId,
        content: JSON.stringify({ file_key: fileKey }),
        msg_type: msgType,
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
   * 将文件扩展名映射为飞书 file_type（上传接口参数）
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

  /**
   * 根据文件扩展名确定飞书消息发送时的 msg_type
   *
   * 飞书对不同媒体类型要求不同的 msg_type：
   * - .mp4  → 'media'（视频消息）
   * - .opus → 'audio'（语音消息）
   * - 其他  → 'file' （文件消息）
   */
  private getFeishuMsgType(ext: string): 'media' | 'audio' | 'file' {
    if (ext === '.mp4') return 'media'
    if (ext === '.opus') return 'audio'
    return 'file'
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
      // 所有媒体类型统一使用 messageResource.get
      // 权限要求：im:resource + im:message 或 im:message:readonly
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
    } catch (err: any) {
      const errDetail = await this.extractApiErrorDetail(err)
      console.error(`[Feishu] Failed to download ${messageType} (key=${fileKey}, msgId=${messageId}): ${errDetail}`)
      return null
    }

    try {
      // 下载后检查文件大小
      const stat = fs.statSync(localPath)
      if (stat.size > IM_DOWNLOAD_MAX_SIZE) {
        fs.unlinkSync(localPath)
        console.error(`[Feishu] File too large: ${(stat.size / 1024 / 1024).toFixed(1)}MB`)
        return null
      }

      console.log(`[Feishu] Downloaded ${messageType}: ${localPath} (${(stat.size / 1024).toFixed(1)}KB)`)
      return { type: attachmentType, localPath, fileName }
    } catch {
      return null
    }
  }

  /**
   * 将 SDK 响应写入文件
   *
   * 飞书 SDK 对二进制下载 API 的响应有多种可能格式：
   * 1. 带 writeFile(path) 方法的包装对象（SDK v1.x 标准）
   * 2. 带 getReadableStream() 方法的包装对象
   * 3. Readable stream（client.request 返回）
   * 4. Buffer
   */
  private async saveResponseToFile(resp: any, filePath: string): Promise<void> {
    // SDK v1.x 标准：resp.writeFile(path) 是异步方法
    if (resp && typeof resp.writeFile === 'function') {
      await resp.writeFile(filePath)
      return
    }

    // SDK v1.x：resp.getReadableStream() 返回 Readable
    if (resp && typeof resp.getReadableStream === 'function') {
      const readable = resp.getReadableStream()
      const ws = fs.createWriteStream(filePath)
      try {
        await new Promise<void>((resolve, reject) => {
          readable.pipe(ws)
          ws.on('finish', resolve)
          ws.on('error', reject)
          readable.on('error', reject)
        })
      } catch (err) {
        ws.destroy()
        try { fs.unlinkSync(filePath) } catch { /* ignore */ }
        throw err
      }
      return
    }

    // Readable stream（如 client.request 的 responseType: 'stream'）
    if (resp && typeof resp.pipe === 'function') {
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
        try { fs.unlinkSync(filePath) } catch { /* ignore */ }
        throw err
      }
      return
    }

    // Buffer
    if (Buffer.isBuffer(resp)) {
      fs.writeFileSync(filePath, resp)
      return
    }

    // Axios response with data 字段（client.request 可能返回）
    if (resp?.data) {
      return this.saveResponseToFile(resp.data, filePath)
    }

    throw new Error(`Unexpected response format: ${typeof resp}`)
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
      .replace(/[\x00-\x1f\x7f]/g, '')     // eslint-disable-line no-control-regex -- 故意移除控制字符
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
   * 从飞书 SDK 错误中提取详细 API 错误信息（同步版本，用于非关键日志）
   */
  private extractApiError(err: any): string {
    let data = err?.response?.data
    if (Buffer.isBuffer(data)) {
      try { data = JSON.parse(data.toString('utf-8')) } catch { /* ignore */ }
    }
    const code = data?.code ?? err?.code
    const msg = data?.msg ?? err?.msg
    if (code !== undefined && msg) {
      return `code=${code}, msg=${msg}`
    }
    return err?.message || 'Unknown error'
  }

  /**
   * 从飞书 SDK 错误中提取详细错误信息（异步版本，能读取流式响应体）
   * 用于下载 API 失败时的诊断
   */
  private async extractApiErrorDetail(err: any): Promise<string> {
    // 先尝试同步提取
    const syncResult = this.extractApiError(err)

    // 如果 response.data 是流（二进制 API 的错误响应），尝试读取
    const responseData = err?.response?.data
    if (responseData && typeof responseData.read === 'function' && typeof responseData.on === 'function') {
      try {
        const chunks: Buffer[] = []
        await new Promise<void>((resolve, reject) => {
          responseData.on('data', (chunk: any) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
          responseData.on('end', resolve)
          responseData.on('error', reject)
          setTimeout(() => resolve(), 3000) // 超时保护
        })
        const body = Buffer.concat(chunks).toString('utf-8')
        if (body) {
          try {
            const parsed = JSON.parse(body)
            if (parsed.code !== undefined) {
              return `code=${parsed.code}, msg=${parsed.msg || 'unknown'} (HTTP ${err?.response?.status || '?'})`
            }
          } catch { /* 非 JSON */ }
          return `HTTP ${err?.response?.status || '?'}, body: ${body.substring(0, 500)}`
        }
      } catch { /* 读取流失败 */ }
    }

    return syncResult
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
