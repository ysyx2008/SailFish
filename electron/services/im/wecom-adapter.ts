/**
 * WeCom Adapter - 企业微信回调模式适配器
 *
 * 使用 HTTP 回调接收消息，REST API 发送消息。
 * 支持单聊（用户 → 应用）。
 *
 * 配置步骤：
 * 1. 在企业微信管理后台创建自建应用
 * 2. 获取 CorpID、AgentId、Secret
 * 3. 在应用的「接收消息」中配置回调 URL、Token、EncodingAESKey
 *    - URL 填写 http://<你的公网IP或域名>:<callbackPort>/wecom/callback
 *    - 需确保该端口可从公网访问（或通过 ngrok/frp 等内网穿透工具）
 * 4. 保存配置后即可接收消息
 */

import * as crypto from 'crypto'
import * as fs from 'fs'
import * as http from 'http'
import * as os from 'os'
import * as path from 'path'
import type { IMAdapter, IMIncomingMessage, IMPlatform, WeComConfig, IMAttachment } from './types'
import { IM_TEXT_MAX_LENGTH, IM_FILE_MAX_SIZE_WECOM, IM_DOWNLOAD_MAX_SIZE } from './types'
import { t } from '../agent/i18n'
import { createLogger } from '../../utils/logger'

const log = createLogger('WeCom')

/** 企业微信 API 基础地址 */
const WECOM_API_BASE = 'https://qyapi.weixin.qq.com/cgi-bin'

export class WeComAdapter implements IMAdapter {
  readonly platform: IMPlatform = 'wecom'

  private server: http.Server | null = null
  private connected = false
  private config: WeComConfig
  private aesKey: Buffer
  private iv: Buffer

  /** access_token 缓存 */
  private accessToken = ''
  private tokenExpiresAt = 0

  onMessage: ((msg: IMIncomingMessage) => void) | null = null
  onConnectionChange: ((connected: boolean) => void) | null = null

  constructor(config: WeComConfig) {
    this.config = config

    // 验证 encodingAESKey 格式（企业微信要求 43 字符 Base64）
    if (!/^[A-Za-z0-9+/]{43}$/.test(config.encodingAESKey)) {
      throw new Error('[WeCom] Invalid encodingAESKey format (must be 43 Base64 characters)')
    }

    // 解码 AES Key: Base64Decode(encodingAESKey + "=")
    this.aesKey = Buffer.from(config.encodingAESKey + '=', 'base64')
    if (this.aesKey.length !== 32) {
      throw new Error('[WeCom] AES key must be 32 bytes')
    }
    // IV 为 AES Key 的前 16 字节
    this.iv = this.aesKey.subarray(0, 16)
  }

  async start(): Promise<void> {
    if (this.connected) {
      log.info('Already connected')
      return
    }

    // 预先获取 access_token 验证凭证是否有效
    await this.getAccessToken()

    // 启动 HTTP 回调服务
    await this.startCallbackServer()

    this.connected = true
    this.onConnectionChange?.(true)
    log.info(`Callback server started on port ${this.config.callbackPort}`)
  }

  async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve())
      })
      this.server = null
    }
    this.connected = false
    this.accessToken = ''
    this.tokenExpiresAt = 0
    this.onConnectionChange?.(false)
    log.info('Disconnected')
  }

  isConnected(): boolean {
    return this.connected
  }

  // ==================== 发送消息 ====================

  async sendText(replyContext: any, text: string): Promise<void> {
    const truncated = this.truncateText(text)
    const token = await this.getAccessToken()

    await this.postJson(`${WECOM_API_BASE}/message/send?access_token=${token}`, {
      touser: replyContext.userId,
      msgtype: 'text',
      agentid: this.config.agentId,
      text: { content: truncated },
    })
  }

  async sendMarkdown(replyContext: any, _title: string, content: string): Promise<void> {
    const truncated = this.truncateText(content)
    const token = await this.getAccessToken()

    await this.postJson(`${WECOM_API_BASE}/message/send?access_token=${token}`, {
      touser: replyContext.userId,
      msgtype: 'markdown',
      agentid: this.config.agentId,
      markdown: { content: truncated },
    })
  }

  async sendImage(replyContext: any, filePath: string): Promise<void> {
    this.validateFile(filePath, IM_FILE_MAX_SIZE_WECOM)

    const token = await this.getAccessToken()
    const mediaId = await this.uploadMedia(token, filePath, 'image')

    await this.postJson(`${WECOM_API_BASE}/message/send?access_token=${token}`, {
      touser: replyContext.userId,
      msgtype: 'image',
      agentid: this.config.agentId,
      image: { media_id: mediaId },
    })
  }

  async sendFile(replyContext: any, filePath: string, _fileName?: string): Promise<void> {
    this.validateFile(filePath, IM_FILE_MAX_SIZE_WECOM)

    const token = await this.getAccessToken()
    const mediaId = await this.uploadMedia(token, filePath, 'file')

    await this.postJson(`${WECOM_API_BASE}/message/send?access_token=${token}`, {
      touser: replyContext.userId,
      msgtype: 'file',
      agentid: this.config.agentId,
      file: { media_id: mediaId },
    })
  }

  // ==================== HTTP 回调服务 ====================

  private startCallbackServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleHttpRequest(req, res)
      })

      this.server.on('error', (err) => {
        log.error('Callback server error:', err)
        if (!this.connected) {
          reject(err)
        }
      })

      this.server.listen(this.config.callbackPort, () => {
        resolve()
      })
    })
  }

  private handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url || '/', `http://localhost:${this.config.callbackPort}`)

    // 只处理 /wecom/callback 路径
    if (url.pathname !== '/wecom/callback') {
      res.writeHead(404)
      res.end('Not Found')
      return
    }

    if (req.method === 'GET') {
      // URL 验证请求
      this.handleVerification(url, res)
    } else if (req.method === 'POST') {
      // 消息回调
      this.handleCallback(url, req, res)
    } else {
      res.writeHead(405)
      res.end('Method Not Allowed')
    }
  }

  /**
   * 处理企业微信 URL 验证（GET 请求）
   * 企业微信会发送 msg_signature, timestamp, nonce, echostr 参数
   * 需要验证签名并返回解密后的 echostr
   */
  private handleVerification(url: URL, res: http.ServerResponse) {
    const msgSignature = url.searchParams.get('msg_signature') || ''
    const timestamp = url.searchParams.get('timestamp') || ''
    const nonce = url.searchParams.get('nonce') || ''
    const echostr = url.searchParams.get('echostr') || ''

    // 验证签名
    const expectedSignature = this.computeSignature(timestamp, nonce, echostr)
    if (expectedSignature !== msgSignature) {
      log.error('Verification signature mismatch')
      res.writeHead(403)
      res.end('Invalid Signature')
      return
    }

    // 解密 echostr
    try {
      const decrypted = this.decrypt(echostr)
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end(decrypted)
      log.info('URL verification successful')
    } catch (err) {
      log.error('Failed to decrypt echostr:', err)
      res.writeHead(500)
      res.end('Decryption Error')
    }
  }

  /**
   * 处理消息回调（POST 请求）
   */
  private handleCallback(url: URL, req: http.IncomingMessage, res: http.ServerResponse) {
    const chunks: Buffer[] = []
    let totalSize = 0
    const MAX_REQUEST_SIZE = 10 * 1024 * 1024 // 10MB

    req.on('data', (chunk: Buffer) => {
      totalSize += chunk.length
      if (totalSize > MAX_REQUEST_SIZE) {
        log.error('Request body too large, aborting')
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', async () => {
      // 立即返回 200，避免企业微信重试
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('success')

      try {
        const body = Buffer.concat(chunks).toString('utf-8')
        const msgSignature = url.searchParams.get('msg_signature') || ''
        const timestamp = url.searchParams.get('timestamp') || ''
        const nonce = url.searchParams.get('nonce') || ''

        await this.processCallback(body, msgSignature, timestamp, nonce)
      } catch (err) {
        log.error('Error processing callback:', err)
      }
    })
  }

  /**
   * 解析并处理回调消息
   */
  private async processCallback(xmlBody: string, msgSignature: string, timestamp: string, nonce: string) {
    // 从 XML 中提取 Encrypt 字段
    const encrypt = this.extractXmlValue(xmlBody, 'Encrypt')
    if (!encrypt) {
      log.warn('No Encrypt field in callback body')
      return
    }

    // 验证签名
    const expectedSignature = this.computeSignature(timestamp, nonce, encrypt)
    if (expectedSignature !== msgSignature) {
      log.error('Callback signature mismatch')
      return
    }

    // 解密消息
    const decryptedXml = this.decrypt(encrypt)

    // 解析消息字段
    const msgType = this.extractXmlValue(decryptedXml, 'MsgType')
    const fromUser = this.extractXmlValue(decryptedXml, 'FromUserName')
    const agentId = this.extractXmlValue(decryptedXml, 'AgentID')

    if (!fromUser) return

    // 忽略非本应用的消息
    if (agentId && Number(agentId) !== this.config.agentId) return

    let text = ''
    const attachments: IMAttachment[] = []

    if (msgType === 'text') {
      text = this.extractXmlValue(decryptedXml, 'Content')?.trim() || ''
    } else if (msgType === 'image') {
      const mediaId = this.extractXmlValue(decryptedXml, 'MediaId')
      if (mediaId) {
        try {
          const attachment = await this.downloadMedia(mediaId, 'image')
          if (attachment) attachments.push(attachment)
        } catch (err) {
          log.error('Failed to download image:', err)
        }
      }
    } else if (msgType === 'voice') {
      const mediaId = this.extractXmlValue(decryptedXml, 'MediaId')
      if (mediaId) {
        try {
          const attachment = await this.downloadMedia(mediaId, 'audio')
          if (attachment) attachments.push(attachment)
        } catch (err) {
          log.error('Failed to download voice:', err)
        }
      }
    } else if (msgType === 'video') {
      const mediaId = this.extractXmlValue(decryptedXml, 'MediaId')
      if (mediaId) {
        try {
          const attachment = await this.downloadMedia(mediaId, 'video')
          if (attachment) attachments.push(attachment)
        } catch (err) {
          log.error('Failed to download video:', err)
        }
      }
    } else if (msgType === 'file') {
      const mediaId = this.extractXmlValue(decryptedXml, 'MediaId')
      if (mediaId) {
        try {
          const attachment = await this.downloadMedia(mediaId, 'file')
          if (attachment) attachments.push(attachment)
        } catch (err) {
          log.error('Failed to download file:', err)
        }
      }
    } else {
      log.info(`Unsupported message type: ${msgType}, ignoring`)
      return
    }

    if (!text && attachments.length === 0) return

    const replyContext = {
      userId: fromUser,
      agentId: this.config.agentId,
    }

    const msg: IMIncomingMessage = {
      platform: 'wecom',
      userId: fromUser,
      userName: fromUser,
      text,
      chatType: 'single',
      replyContext,
      ...(attachments.length > 0 ? { attachments } : {}),
    }

    this.onMessage?.(msg)
  }

  // ==================== 加解密 ====================

  /**
   * 计算企业微信消息签名
   * SHA1(sort(token, timestamp, nonce, encrypt))
   */
  private computeSignature(timestamp: string, nonce: string, encrypt: string): string {
    const items = [this.config.token, timestamp, nonce, encrypt].sort()
    return crypto.createHash('sha1').update(items.join('')).digest('hex')
  }

  /**
   * 解密企业微信消息
   * AES-256-CBC, PKCS#7 padding
   * 解密后格式: random(16) + msgLen(4, big-endian) + msg + corpId
   */
  private decrypt(encrypted: string): string {
    const decipher = crypto.createDecipheriv('aes-256-cbc', this.aesKey, this.iv)
    decipher.setAutoPadding(false)

    const encryptedBuf = Buffer.from(encrypted, 'base64')
    const decrypted = Buffer.concat([decipher.update(encryptedBuf), decipher.final()])

    if (decrypted.length < 20) {
      throw new Error('[WeCom] Decrypted data too short')
    }

    // 去除 PKCS#7 padding
    const padLen = decrypted[decrypted.length - 1]
    if (padLen < 1 || padLen > 32 || padLen > decrypted.length) {
      throw new Error('[WeCom] Invalid PKCS#7 padding')
    }
    const unpaddedBuf = decrypted.subarray(0, decrypted.length - padLen)

    if (unpaddedBuf.length < 20) {
      throw new Error('[WeCom] Decrypted data too short after unpadding')
    }

    // 前 16 字节是随机数，接下来 4 字节是消息长度（big-endian）
    const msgLen = unpaddedBuf.readUInt32BE(16)
    if (20 + msgLen > unpaddedBuf.length) {
      throw new Error('[WeCom] Invalid message length in decrypted data')
    }

    const msg = unpaddedBuf.subarray(20, 20 + msgLen).toString('utf-8')

    // 剩余部分是 corpId，用于验证消息来源
    const corpId = unpaddedBuf.subarray(20 + msgLen).toString('utf-8')
    if (corpId !== this.config.corpId) {
      throw new Error(`[WeCom] CorpId mismatch: expected ${this.config.corpId}, got ${corpId}`)
    }

    return msg
  }

  // ==================== Access Token 管理 ====================

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt) {
      return this.accessToken
    }

    const url = `${WECOM_API_BASE}/gettoken?corpid=${encodeURIComponent(this.config.corpId)}&corpsecret=${encodeURIComponent(this.config.corpSecret)}`
    const response = await fetch(url)

    if (!response.ok) {
      throw new Error(`[WeCom] Failed to get access_token: ${response.status}`)
    }

    const result = await response.json() as any
    if (result.errcode !== 0) {
      throw new Error(`[WeCom] Get access_token error: ${result.errcode} ${result.errmsg}`)
    }

    this.accessToken = result.access_token
    // 提前 5 分钟过期
    this.tokenExpiresAt = Date.now() + (result.expires_in - 300) * 1000
    return this.accessToken
  }

  // ==================== 媒体文件 ====================

  /**
   * 上传临时素材，返回 media_id
   */
  private async uploadMedia(accessToken: string, filePath: string, type: 'image' | 'voice' | 'video' | 'file'): Promise<string> {
    const fileBuffer = fs.readFileSync(filePath)
    const fileName = path.basename(filePath)
    const boundary = `----FormBoundary${Date.now()}`

    const safeFileName = fileName
      .replace(/[\x00-\x1f\x7f]/g, '')   // eslint-disable-line no-control-regex -- 移除控制字符
      .replace(/[\r\n"'`\\]/g, '_')
      .substring(0, 200)

    const disposition = `Content-Disposition: form-data; name="media"; filename="${safeFileName}"`
    const contentType = 'Content-Type: application/octet-stream'

    const prefix = Buffer.from(`--${boundary}\r\n${disposition}\r\n${contentType}\r\n\r\n`)
    const suffix = Buffer.from(`\r\n--${boundary}--\r\n`)
    const body = Buffer.concat([prefix, fileBuffer, suffix])

    const response = await fetch(
      `${WECOM_API_BASE}/media/upload?access_token=${accessToken}&type=${type}`,
      {
        method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        body,
      }
    )

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`[WeCom] Media upload failed: ${response.status} ${text}`)
    }

    const result = await response.json() as any
    if (result.errcode && result.errcode !== 0) {
      throw new Error(`[WeCom] Media upload error: ${result.errcode} ${result.errmsg}`)
    }

    if (!result.media_id) {
      throw new Error('[WeCom] Media upload returned no media_id')
    }

    return result.media_id
  }

  /**
   * 下载临时素材到本地
   */
  private async downloadMedia(mediaId: string, type: IMAttachment['type']): Promise<IMAttachment | null> {
    const token = await this.getAccessToken()
    const url = `${WECOM_API_BASE}/media/get?access_token=${token}&media_id=${mediaId}`

    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`[WeCom] Media download failed: ${response.status}`)
    }

    // 检查 Content-Length
    const contentLength = response.headers.get('content-length')
    if (contentLength && parseInt(contentLength) > IM_DOWNLOAD_MAX_SIZE) {
      throw new Error(`[WeCom] File too large: ${(parseInt(contentLength) / 1024 / 1024).toFixed(1)}MB`)
    }

    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length > IM_DOWNLOAD_MAX_SIZE) {
      throw new Error(`[WeCom] File too large: ${(buffer.length / 1024 / 1024).toFixed(1)}MB`)
    }

    // 检查是否是错误响应（JSON 格式）
    if (buffer.length < 1024) {
      try {
        const jsonStr = buffer.toString('utf-8')
        const json = JSON.parse(jsonStr)
        if (json.errcode) {
          throw new Error(`API error: ${json.errcode} ${json.errmsg}`)
        }
      } catch (e) {
        if (e instanceof SyntaxError) {
          // 不是 JSON，说明是正常的文件内容
        } else {
          throw e
        }
      }
    }

    const timestamp = Date.now()
    const extMap: Record<string, string> = {
      image: '.png',
      audio: '.amr',
      video: '.mp4',
      file: '',
    }
    const ext = extMap[type] || ''

    // 尝试从 Content-Disposition 获取文件名
    let fileName = ''
    const disposition = response.headers.get('content-disposition')
    if (disposition) {
      const match = disposition.match(/filename="?([^";\n]+)"?/i)
      if (match) {
        fileName = this.sanitizeFileName(match[1].trim())
      }
    }
    if (!fileName) {
      fileName = `wecom_${type}_${timestamp}${ext}`
    }

    const tempDir = this.ensureTempDir()
    const localPath = path.join(tempDir, fileName)
    fs.writeFileSync(localPath, buffer)

    log.info(`Downloaded ${type}: ${localPath} (${(buffer.length / 1024).toFixed(1)}KB)`)
    return { type, localPath, fileName }
  }

  // ==================== 工具方法 ====================

  /**
   * 从 XML 字符串中提取指定标签的值
   * 支持 CDATA 和纯文本两种格式
   */
  private extractXmlValue(xml: string, tag: string): string {
    // 匹配 <Tag><![CDATA[value]]></Tag> 或 <Tag>value</Tag>
    const cdataRegex = new RegExp(`<${tag}>[\\s]*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>[\\s]*</${tag}>`)
    const cdataMatch = xml.match(cdataRegex)
    if (cdataMatch) return cdataMatch[1]

    const textRegex = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)
    const textMatch = xml.match(textRegex)
    if (textMatch) return textMatch[1].trim()

    return ''
  }

  private validateFile(filePath: string, maxSize: number): void {
    let stat: fs.Stats
    try {
      stat = fs.statSync(filePath)
    } catch {
      throw new Error(`[WeCom] File not found or not accessible: ${filePath}`)
    }
    if (!stat.isFile()) {
      throw new Error(`[WeCom] Not a regular file: ${filePath}`)
    }
    if (stat.size === 0) {
      throw new Error(`[WeCom] File is empty: ${filePath}`)
    }
    if (stat.size > maxSize) {
      const sizeMB = (stat.size / 1024 / 1024).toFixed(1)
      const limitMB = (maxSize / 1024 / 1024).toFixed(0)
      throw new Error(`[WeCom] File too large: ${sizeMB}MB (limit: ${limitMB}MB)`)
    }
  }

  private async postJson(url: string, body: any): Promise<any> {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`[WeCom] API request failed: ${response.status} ${text}`)
    }

    const result = await response.json() as any
    if (result.errcode && result.errcode !== 0) {
      throw new Error(`[WeCom] API error: ${result.errcode} ${result.errmsg}`)
    }

    return result
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
