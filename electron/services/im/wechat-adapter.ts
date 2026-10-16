// 微信 IM Adapter — 薄壳实现，业务逻辑全部转发到 vendored @tencent-weixin/openclaw-weixin。
// 本文件只承担：QR 登录流程、长轮询编排、IMAdapter 接口适配、附件下载组装。
//
// 注意：vendored 的 session-guard 是模块级状态（按 accountKey 隔离）；本 adapter
// 实例间共享但 SailFish 单 bot 场景下没有冲突。

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import type { WeChatLoginStatus } from '@shared/types'
import type { IMAdapter, IMIncomingMessage, IMPlatform, WeChatConfig, IMAttachment, IMOutboundSessionOptions, IMProgressOutboundCapable } from './types'
import { IM_TEXT_MAX_LENGTH } from './types'
import { createLogger } from '../../utils/logger'

import {
  apiGetFetch,
  getUpdates as vendoredGetUpdates,
  notifyStart as vendoredNotifyStart,
  notifyStop as vendoredNotifyStop,
  sendTyping as vendoredSendTyping,
} from './wechat/api/api'
import type { WeixinApiOptions } from './wechat/api/api'
import { WeixinConfigManager } from './wechat/api/config-cache'
import { TypingStatus } from './wechat/api/types'
import {
  STALE_TOKEN_ERRCODE,
  assertSessionActive,
  pauseSession,
  getRemainingPauseMs,
} from './wechat/api/session-guard'
import { sendMessageWeixin, StreamingMarkdownFilter } from './wechat/messaging/send'
import { sendWeixinMediaFile } from './wechat/messaging/send-media'
import { sendWeixinErrorNotice } from './wechat/messaging/error-notice'
import { WeixinOutboundSession } from './wechat/outbound-session'
import { WechatOutboundProgress } from './wechat/outbound-progress'
import { generateId } from './wechat/util/random'
import {
  setContextToken,
  getContextToken,
  restoreContextTokens,
  clearContextTokensForAccount,
  bodyFromItemList,
} from './wechat/messaging/inbound'
import { resolveStateDir } from './wechat/storage/state-dir'
import { downloadAndDecryptBuffer, downloadPlainCdnBuffer } from './wechat/cdn/pic-decrypt'
import type { WeixinMessage, MessageItem } from './wechat/api/types'
import { MessageItemType } from './wechat/api/types'

const log = createLogger('WeChatAdapter')

const FIXED_BASE_URL = 'https://ilinkai.weixin.qq.com'
const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'
const DEFAULT_TIMEOUT_MS = 40_000
const QR_POLL_INTERVAL_MS = 2_000
const QR_EXPIRE_MS = 180_000
/** 展示期间过期自动换码上限；离开页面会 cancelLogin，不会无限刷 */
const QR_MAX_REFRESH = 20
const RECONNECT_DELAY_MS = 5_000
const MAX_RECONNECT_DELAY_MS = 60_000
const TYPING_KEEPALIVE_MS = 5_000
/** 未配对 endOutboundSession 时的泄漏兜底（正常由 IMService finally 结束） */
const TYPING_KEEPALIVE_LEAK_MS = 3 * 60 * 60 * 1_000
/** 入站附件并发下载上限：挡住长轮询会丢后续消息，但也不能无上限打 CDN */
const INBOUND_DOWNLOAD_CONCURRENCY = 6
/** 单份附件下载超时；裸 fetch 无超时，挂起会拖死整批入站 */
const INBOUND_DOWNLOAD_TIMEOUT_MS = 60_000

async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return []
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i], i)
    }
  }
  const n = Math.min(Math.max(1, concurrency), items.length)
  await Promise.all(Array.from({ length: n }, () => worker()))
  return results
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export interface WeChatReplyContext {
  userId: string
  contextToken?: string
  /** beginOutboundSession 写入，出站 sendmessage 携带 run_id */
  runId?: string
}

export interface WeChatToolProgressEvent {
  phase: 'start' | 'end'
  toolName: string
  toolCallId?: string
  success?: boolean
}

interface QRCodeResp {
  qrcode?: string
  qrcode_img_content?: string
}

interface QRStatusResp {
  status?: 'wait' | 'scaned' | 'confirmed' | 'expired' | 'scaned_but_redirect'
  bot_token?: string
  ilink_bot_id?: string
  baseurl?: string
  redirect_host?: string
}

export class WeChatAdapter implements IMAdapter, IMProgressOutboundCapable {
  readonly platform: IMPlatform = 'wechat'

  onMessage: ((msg: IMIncomingMessage) => void) | null = null
  onConnectionChange: ((connected: boolean) => void) | null = null
  /**
   * 出站软失败（ilink -2）持续时通知一次。用户再发一条进来后清掉，才能再提示。
   * 不抛错，避免过程消息变成未处理拒绝。
   */
  onSoftSendFailure: ((userId: string) => void) | null = null
  /**
   * 扫码确认拿到 bot_token 时触发一次（早于 startPolling / onConnectionChange）。
   * 与连接态解耦：断线重连不会再次触发，避免重复落盘或强行改写 autoConnect。
   */
  onCredentials: ((creds: { token: string; baseUrl: string }) => void) | null = null
  /** 扫码过程状态（出码 / 已扫 / 刷新 / 确认 / 错误），供 UI 内嵌二维码展示 */
  onLoginStatus: ((status: WeChatLoginStatus) => void) | null = null

  private token: string = ''
  private baseUrl: string = FIXED_BASE_URL
  private connected = false
  private polling = false
  private getUpdatesBuf: string = ''
  private abortController: AbortController | null = null
  private reconnectDelay = RECONNECT_DELAY_MS
  private serverTimeoutMs = DEFAULT_TIMEOUT_MS

  private qrPollBaseUrl: string = FIXED_BASE_URL
  private loginAbort: AbortController | null = null

  /**
   * 上游 monitor.ts 在每条 inbound 上调 ConfigManager.getForUser(userId, msg.context_token)，
   * 既缓存 typing_ticket（24h TTL + 指数退避），又触发服务端 per-user 配置注册。
   * 没这一步，sendmessage 会被服务端持续以 errcode=-2 errmsg=unknown 拒掉。
   */
  private configManager: WeixinConfigManager | null = null
  private contextTokensRestored = false

  /**
   * 追踪每个 user 最近一次调用 getForUser 时使用的 context_token。
   * 若新消息携带不同的 token，说明服务端可能已刷新 session，需要立即 invalidate 缓存
   * 并重新调用 getconfig，否则旧 session 失效后 sendmessage 会持续报 errcode=-2。
   */
  private lastConfigContextToken = new Map<string, string>()

  /**
   * 正在运行的 sendTyping keepalive 定时器（按 userId 隔离）。
   * 对齐上游 process-message.ts 的 createReplyDispatcherWithTyping：整段 Agent 回复期间
   * 保持 keepalive，仅在 endOutboundSession（markDispatchIdle）时停止，不在每条 sendText 时停止。
   *
   * sendTyping 不再解析 body errcode（与官方 SDK 一致），所以无"假活"问题，单条失败仅 log，
   * 由下次 interval 自动重试即可，不需要 consecutiveFailures + restart 那套额外机制。
   */
  private typingKeepalives = new Map<string, {
    timer: ReturnType<typeof setInterval>
    ticket: string
    leakTimer: ReturnType<typeof setTimeout>
  }>()

  /**
   * 进行中的出站会话（按 userId）。对齐上游 createReplyDispatcherWithTyping +
   * WeixinReplyProgressSender 串行 deliver 链。
   */
  private outboundSessions = new Map<string, WeixinOutboundSession>()

  /** 按 userId 的过程消息 digest 缓冲（beginOutboundSession bufferProgress 时创建） */
  private progressByUser = new Map<string, WechatOutboundProgress>()
  /** 已提示过软失败的用户；入站新消息后清除，避免同一轮刷屏 */
  private softFailNotifiedUsers = new Set<string>()

  /** 已拉到、待下载/分发的入站消息。长轮询只入队，不在 poll 里等下载。 */
  private inboundQueue: WeixinMessage[] = []
  private inboundPumpRunning = false
  private mediaSeq = 0;

  constructor(private config: WeChatConfig) {
    this.token = config.token || ''
    this.baseUrl = config.baseUrl || FIXED_BASE_URL
  }

  /** vendored session-guard 用 accountKey 隔离；token 前缀足够避免冲突，未登录则用占位符。 */
  private get accountKey(): string {
    return this.token ? `sf-wechat-${this.token.slice(0, 16)}` : 'sf-wechat-anon'
  }

  private get apiOpts(): WeixinApiOptions {
    return { baseUrl: this.baseUrl, token: this.token }
  }

  /** 获取/惰性创建 ConfigManager 单例（token/baseUrl 变化时重建）。 */
  private getConfigManager(): WeixinConfigManager {
    if (!this.configManager) {
      this.configManager = new WeixinConfigManager(
        { baseUrl: this.baseUrl, token: this.token },
        (msg) => log.debug(msg),
      )
    }
    return this.configManager
  }

  /**
   * 出站发消息时取最新 context_token：优先 store（持久化），缺省再用 replyContext 快照。
   * 上游所有 outbound 路径（channel.ts 的 sendText/sendMedia）都走 getContextToken。
   */
  private resolveContextToken(replyContext: { userId: string; contextToken?: string }): string | undefined {
    return getContextToken(this.accountKey, replyContext.userId) ?? replyContext.contextToken
  }

  /**
   * 包裹 vendored 调用：先 assert 暂停期，HTTP 错误原样抛出。
   *
   * 注意：sendmessage / sendtyping 在服务端 body 返回 `errcode=-2 errmsg=unknown` 时，
   * 官方 SDK 是 silently return（apiPostFetch 只看 HTTP status，不解析 body errcode）。
   * 我们也保持这个语义：调用方视作"已送达"，最多偶尔丢一条，但不会把一次出站失败放大
   * 成整段对话的雪崩。session 级别的 `-14` 由 pollLoop 在 resp.ret 字段统一处理。
   */
  private async guarded<T>(fn: () => Promise<T>): Promise<T> {
    assertSessionActive(this.accountKey)
    return await fn()
  }

  /**
   * 出站发送的统一封装：从持久化 store 取最新 contextToken（缺失则回退到 inbound 时的
   * 快照 seedToken），交给 sendFn 走 sendmessage。失败直接透传 —— 不重试、不识别 errcode：
   * 跟随官方 SDK 的"sendmessage 即发即弃，errcode 不暴露"语义。
   */
  private async runWithContextToken<T>(
    userId: string,
    seedToken: string | undefined,
    sendFn: (contextToken: string | undefined) => Promise<T>,
  ): Promise<T> {
    const contextToken = getContextToken(this.accountKey, userId) ?? seedToken
    return await sendFn(contextToken)
  }

  private getOutboundSession(userId: string): WeixinOutboundSession | undefined {
    return this.outboundSessions.get(userId)
  }

  /** IMAdapter：Agent 长任务开始时启动出站 lane + typing keepalive */
  async beginOutboundSession(
    replyContext: WeChatReplyContext,
    options?: IMOutboundSessionOptions,
  ): Promise<void> {
    const userId = replyContext.userId
    if (!userId) return
    const contextToken = this.resolveContextToken(replyContext)
    try {
      await this.getConfigManager().getForUser(userId, contextToken)
      if (contextToken) this.lastConfigContextToken.set(userId, contextToken)
    } catch (err) {
      log.warn(`beginOutboundSession getForUser failed: ${String(err)}`)
    }

    const runId = generateId('sf-wechat-run')
    replyContext.runId = runId
    const session = new WeixinOutboundSession({
      userId,
      accountKey: this.accountKey,
      runId,
      apiOpts: this.apiOpts,
      resolveContextToken: () => this.resolveContextToken(replyContext),
      runWithContextToken: (sendFn) => this.runWithContextToken(userId, contextToken, sendFn),
    })
    this.outboundSessions.set(userId, session)

    if (options?.bufferProgress) {
      const ctx = replyContext
      this.progressByUser.set(userId, new WechatOutboundProgress({
        sendDigest: async (text) => {
          try {
            await this.sendText(ctx, text)
          } catch {
            this.reportSoftSendFailure(ctx.userId)
          }
        },
      }))
    }

    await this.startTypingKeepalive(userId, contextToken)
  }

  /**
   * 结构化工具进度（TOOL_CALL_START/RESULT），替代 IM 侧纯文本工具通知刷屏。
   * 对齐上游 WeixinReplyProgressSender + replyProgressMessages。
   */
  notifyToolProgress(replyContext: WeChatReplyContext, event: WeChatToolProgressEvent): void {
    const session = this.getOutboundSession(replyContext.userId)
    if (!session) return
    if (event.phase === 'start') {
      session.progressSender.notifyToolStart(event.toolName, event.toolCallId)
    } else {
      session.progressSender.notifyToolEnd(event.toolName, event.toolCallId, event.success)
    }
  }

  /** IMAdapter：排空出站队列并停止 keepalive */
  async endOutboundSession(replyContext: { userId: string }): Promise<void> {
    const userId = replyContext.userId
    if (!userId) return

    const progress = this.progressByUser.get(userId)
    if (progress) {
      try {
        await progress.dispose()
      } catch (err) {
        log.warn(`endOutboundSession progress dispose failed for ${userId}: ${String(err)}`)
      }
      this.progressByUser.delete(userId)
    }

    const session = this.outboundSessions.get(userId)
    if (session) {
      try {
        await session.drain()
      } catch (err) {
        log.warn(`endOutboundSession drain failed for ${userId}: ${String(err)}`)
      }
      this.outboundSessions.delete(userId)
    }
    this.stopTypingKeepalive(userId)
  }

  /**
   * 发送失败时尝试通知用户（对齐上游 sendWeixinErrorNotice，fire-and-forget）。
   */
  async sendErrorNotice(replyContext: WeChatReplyContext, message: string): Promise<void> {
    const ctx = replyContext
    const contextToken = this.resolveContextToken(ctx)
    await sendWeixinErrorNotice({
      to: ctx.userId,
      contextToken,
      message,
      baseUrl: this.baseUrl,
      token: this.token,
      runId: ctx.runId,
      errLog: (m) => log.warn(m),
    })
  }

  // ==================== QR 登录 ====================

  async login(): Promise<{ qrcodeUrl: string }> {
    this.cancelLogin()
    const abort = new AbortController()
    this.loginAbort = abort

    const qr = await this.fetchQRCode()
    log.info('QR code fetched, polling status...')
    this.emitLoginStatus({ phase: 'qr', qrcodeUrl: qr.qrcodeUrl })
    this.pollQRStatus(qr.qrcode, abort.signal)
    return { qrcodeUrl: qr.qrcodeUrl }
  }

  cancelLogin(): void {
    if (this.loginAbort) {
      this.loginAbort.abort()
      this.loginAbort = null
    }
  }

  private emitLoginStatus(status: WeChatLoginStatus): void {
    try {
      this.onLoginStatus?.(status)
    } catch (err) {
      log.error('onLoginStatus callback failed:', err)
    }
  }

  private async fetchQRCode(): Promise<{ qrcode: string; qrcodeUrl: string }> {
    const raw = await apiGetFetch({
      baseUrl: FIXED_BASE_URL,
      endpoint: 'ilink/bot/get_bot_qrcode?bot_type=3',
      label: 'getBotQRCode',
    })
    const qr = JSON.parse(raw) as QRCodeResp
    if (!qr.qrcode || !qr.qrcode_img_content) {
      throw new Error('Failed to fetch QR code')
    }
    return { qrcode: qr.qrcode, qrcodeUrl: qr.qrcode_img_content }
  }

  /**
   * 过期后重新拉码并通知前端；失败返回 null（已 emit error）。
   */
  private async refreshQRCode(
    signal: AbortSignal,
    refreshCount: number,
  ): Promise<{ qrcode: string; qrcodeUrl: string } | null> {
    if (signal.aborted) return null
    if (refreshCount >= QR_MAX_REFRESH) {
      log.warn(`QR refresh exceeded max (${QR_MAX_REFRESH})`)
      this.emitLoginStatus({ phase: 'error', error: 'QR code expired too many times' })
      this.onConnectionChange?.(false)
      return null
    }
    this.emitLoginStatus({ phase: 'refreshing' })
    try {
      const qr = await this.fetchQRCode()
      if (signal.aborted) return null
      this.qrPollBaseUrl = FIXED_BASE_URL
      this.emitLoginStatus({ phase: 'qr', qrcodeUrl: qr.qrcodeUrl })
      log.info(`QR code refreshed (#${refreshCount + 1})`)
      return qr
    } catch (err: any) {
      if (signal.aborted) return null
      log.error('Failed to refresh QR code:', err)
      this.emitLoginStatus({
        phase: 'error',
        error: err?.message || 'Failed to refresh QR code',
      })
      this.onConnectionChange?.(false)
      return null
    }
  }

  private async pollQRStatus(qrcode: string, signal: AbortSignal): Promise<void> {
    this.qrPollBaseUrl = FIXED_BASE_URL
    let currentQrcode = qrcode
    let startTime = Date.now()
    let refreshCount = 0
    let scannedEmitted = false

    while (!signal.aborted) {
      if (Date.now() - startTime > QR_EXPIRE_MS) {
        log.warn('QR code expired (client timeout), refreshing...')
        const next = await this.refreshQRCode(signal, refreshCount++)
        if (!next) return
        currentQrcode = next.qrcode
        startTime = Date.now()
        scannedEmitted = false
        continue
      }

      let status: QRStatusResp
      try {
        const raw = await apiGetFetch({
          baseUrl: this.qrPollBaseUrl,
          endpoint: `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(currentQrcode)}`,
          label: 'getQRCodeStatus',
          timeoutMs: 35_000,
        })
        status = JSON.parse(raw) as QRStatusResp
      } catch (err: any) {
        if (signal.aborted) return
        if (err?.name === 'AbortError') {
          log.debug('QR status poll timeout, retrying...')
          continue
        }
        log.warn('QR status poll error, retrying...', err)
        await this.sleep(QR_POLL_INTERVAL_MS, signal)
        continue
      }

      if (signal.aborted) return

      switch (status.status) {
        case 'confirmed': {
          if (!status.bot_token) {
            log.error('QR confirmed but no bot_token received')
            this.emitLoginStatus({ phase: 'error', error: 'No bot_token received' })
            this.onConnectionChange?.(false)
            return
          }
          this.token = status.bot_token
          this.baseUrl = status.baseurl || FIXED_BASE_URL
          log.info(`Login confirmed, botId=${status.ilink_bot_id || 'unknown'}`)
          this.loginAbort = null
          // 凭证先于长轮询发出，保证落盘不依赖 connected 事件
          try {
            this.onCredentials?.({ token: this.token, baseUrl: this.baseUrl })
          } catch (err) {
            log.error('onCredentials callback failed:', err)
          }
          this.emitLoginStatus({ phase: 'confirmed' })
          await this.startPolling()
          return
        }
        case 'expired': {
          log.warn('QR code expired (server), refreshing...')
          const next = await this.refreshQRCode(signal, refreshCount++)
          if (!next) return
          currentQrcode = next.qrcode
          startTime = Date.now()
          scannedEmitted = false
          continue
        }
        case 'scaned':
          if (!scannedEmitted) {
            scannedEmitted = true
            log.debug('QR scanned, waiting confirmation...')
            this.emitLoginStatus({ phase: 'scanned' })
          }
          break
        case 'scaned_but_redirect': {
          if (status.redirect_host) {
            this.qrPollBaseUrl = `https://${status.redirect_host}`
            log.info(`IDC redirect, switching QR poll host to ${status.redirect_host}`)
          } else {
            log.warn('scaned_but_redirect but redirect_host is missing')
          }
          break
        }
        default:
          break
      }

      await this.sleep(QR_POLL_INTERVAL_MS, signal)
    }
  }

  // ==================== IMAdapter 接口 ====================

  async start(): Promise<void> {
    if (!this.token) {
      throw new Error('No token available. Please login first.')
    }
    await this.startPolling()
  }

  async stop(): Promise<void> {
    this.cancelLogin()
    await this.stopPolling()
    this.onCredentials = null
    this.onLoginStatus = null
    this.connected = false
    this.onConnectionChange?.(false)
    // 清理 context tokens（内存 + 磁盘），避免 stop/重新登录 后旧 token 污染新会话。
    if (this.token) {
      try {
        clearContextTokensForAccount(this.accountKey)
      } catch (err) {
        log.warn(`clearContextTokensForAccount failed (ignored): ${String(err)}`)
      }
    }
    this.contextTokensRestored = false
    this.lastConfigContextToken.clear()
    this.configManager = null
    // 与上游 channel.ts 的 stopAccount 对齐：通知服务端"客户端下线"，失败仅 warn。
    if (this.token) {
      try {
        const resp = await vendoredNotifyStop(this.apiOpts)
        if (resp.ret !== undefined && resp.ret !== 0) {
          log.warn(`notifyStop: ret=${resp.ret} errmsg=${resp.errmsg ?? ''}`)
        }
      } catch (err) {
        log.warn(`notifyStop failed during shutdown (ignored): ${String(err)}`)
      }
    }
    log.info('Stopped')
  }

  isConnected(): boolean {
    return this.connected
  }

  getCredentials(): { token: string; baseUrl: string } {
    return { token: this.token, baseUrl: this.baseUrl }
  }

  async sendText(replyContext: any, text: string): Promise<void> {
    const ctx = replyContext as WeChatReplyContext
    const contextToken = this.resolveContextToken(ctx)
    const f = new StreamingMarkdownFilter()
    const filtered = f.feed(text) + f.flush()
    const truncated = filtered.length > IM_TEXT_MAX_LENGTH
      ? filtered.substring(0, IM_TEXT_MAX_LENGTH - 20) + '\n...(已截断)'
      : filtered

    const session = this.getOutboundSession(ctx.userId)
    if (session) {
      const result = await this.guarded(() => session.sendText(truncated))
      if (result.softFailed) this.reportSoftSendFailure(ctx.userId)
      return
    }

    const result = await this.runWithContextToken(ctx.userId, contextToken, (token) =>
      this.guarded(() => sendMessageWeixin({
        to: ctx.userId,
        text: truncated,
        opts: { ...this.apiOpts, contextToken: token, runId: ctx.runId },
      })),
    )
    if (result.softFailed) this.reportSoftSendFailure(ctx.userId)
  }

  /** 开始等用户回复：过程消息不再定时攒，已经攒下的马上发。 */
  beginUserWait(replyContext: WeChatReplyContext): void {
    this.progressByUser.get(replyContext.userId)?.beginUserWait()
  }

  /** 用户已经回复，过程消息恢复节流。 */
  endUserWait(replyContext: WeChatReplyContext): void {
    this.progressByUser.get(replyContext.userId)?.endUserWait()
  }

  private reportSoftSendFailure(userId: string): void {
    if (!userId || this.softFailNotifiedUsers.has(userId)) return
    this.softFailNotifiedUsers.add(userId)
    this.onSoftSendFailure?.(userId)
  }

  async sendMarkdown(replyContext: any, _title: string, content: string): Promise<void> {
    await this.sendText(replyContext, content)
  }

  /** @see IMProgressOutboundCapable */
  async sendProgressText(replyContext: WeChatReplyContext, text: string): Promise<void> {
    const progress = this.progressByUser.get(replyContext.userId)
    if (progress) {
      progress.push(text)
      return
    }
    await this.sendText(replyContext, text)
  }

  /** @see IMProgressOutboundCapable */
  async sendProgressMarkdown(replyContext: WeChatReplyContext, _title: string, content: string): Promise<void> {
    const progress = this.progressByUser.get(replyContext.userId)
    if (progress) {
      progress.pushBody(content)
      return
    }
    await this.sendMarkdown(replyContext, _title, content)
  }

  /** @see IMProgressOutboundCapable */
  async flushProgress(replyContext: WeChatReplyContext): Promise<void> {
    const progress = this.progressByUser.get(replyContext.userId)
    if (progress) {
      await progress.flush()
    }
  }

  async sendImage(replyContext: any, filePath: string): Promise<void> {
    const ctx = replyContext as WeChatReplyContext
    const contextToken = this.resolveContextToken(ctx)
    log.info(`sendImage: file=${path.basename(filePath)} userId=${ctx.userId} hasToken=${!!contextToken}`)
    const send = () =>
      this.runWithContextToken(ctx.userId, contextToken, (token) =>
        this.guarded(() => sendWeixinMediaFile({
          filePath,
          to: ctx.userId,
          text: '',
          opts: { ...this.apiOpts, contextToken: token, runId: ctx.runId },
          cdnBaseUrl: CDN_BASE_URL,
        })),
      )
    const session = this.getOutboundSession(ctx.userId)
    const result = session ? await session.enqueue(() => send()) : await send()
    if (result.softFailed) this.reportSoftSendFailure(ctx.userId)
  }

  async sendFile(replyContext: any, filePath: string, fileName?: string): Promise<void> {
    const ctx = replyContext as WeChatReplyContext
    const contextToken = this.resolveContextToken(ctx)
    log.info(`sendFile: file=${fileName || path.basename(filePath)} userId=${ctx.userId} hasToken=${!!contextToken}`)
    const send = () =>
      this.runWithContextToken(ctx.userId, contextToken, (token) =>
        this.guarded(() => sendWeixinMediaFile({
          filePath,
          to: ctx.userId,
          text: '',
          opts: { ...this.apiOpts, contextToken: token, runId: ctx.runId },
          cdnBaseUrl: CDN_BASE_URL,
        })),
      )
    const session = this.getOutboundSession(ctx.userId)
    const result = session ? await session.enqueue(() => send()) : await send()
    if (result.softFailed) this.reportSoftSendFailure(ctx.userId)
  }

  // ==================== 长轮询 ====================

  // ---------------------------------------------------------------------------
  // getUpdatesBuf 磁盘持久化：进程重启后不丢失游标，避免漏消息或重复拉历史。
  // 对应上游 storage/sync-buf.ts 的 loadGetUpdatesBuf / saveGetUpdatesBuf。
  // ---------------------------------------------------------------------------

  private getSyncBufPath(): string {
    return path.join(
      resolveStateDir(),
      'openclaw-weixin',
      'accounts',
      `${this.accountKey}.sync.json`,
    )
  }

  private loadSyncBuf(): string {
    try {
      const raw = fs.readFileSync(this.getSyncBufPath(), 'utf-8')
      const data = JSON.parse(raw) as { get_updates_buf?: string }
      if (typeof data.get_updates_buf === 'string') {
        log.info(`loadSyncBuf: restored ${data.get_updates_buf.length} bytes for account=${this.accountKey}`)
        return data.get_updates_buf
      }
    } catch {
      // 文件不存在或格式异常，从头拉取
    }
    return ''
  }

  private saveSyncBuf(buf: string): void {
    try {
      const p = this.getSyncBufPath()
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, JSON.stringify({ get_updates_buf: buf }), 'utf-8')
    } catch (err) {
      log.warn(`saveSyncBuf: failed: ${String(err)}`)
    }
  }

  // ---------------------------------------------------------------------------

  private async startPolling(): Promise<void> {
    if (this.polling) return
    this.polling = true
    this.abortController = new AbortController()
    this.reconnectDelay = RECONNECT_DELAY_MS

    // restoreContextTokens 把磁盘上的 contextTokenStore 加载回内存（重启后还能 proactive 推送）。
    if (!this.contextTokensRestored) {
      try {
        restoreContextTokens(this.accountKey)
      } catch (err) {
        log.warn(`restoreContextTokens failed (ignored): ${String(err)}`)
      }
      this.contextTokensRestored = true
    }

    // 恢复 getUpdatesBuf 游标（对应上游 monitor.ts 的 loadGetUpdatesBuf）。
    this.getUpdatesBuf = this.loadSyncBuf()

    // poll loop 立即启动，不等待 notifyStart——防止 notifyStart 慢/挂导致长时间收不到消息。
    // 对应上游 monitor.ts：monitorWeixinProvider 在 notifyStart 之后才启动，但 channel.ts 的
    // startAccount 是顺序的；而我们本地 startPolling 由于没有独立进程隔离，必须先启动 loop。
    this.setConnected(true)
    this.pollLoop(this.abortController.signal)

    // notifyStart 在后台并发执行——通知服务端"客户端上线"，失败仅 warn，不阻断接收。
    // 注意：不 await，让 start() 调用方立即返回。
    void (async () => {
      try {
        const resp = await vendoredNotifyStart(this.apiOpts)
        if (resp.ret !== undefined && resp.ret !== 0) {
          log.warn(`notifyStart: ret=${resp.ret} errmsg=${resp.errmsg ?? ''}`)
        }
      } catch (err) {
        log.warn(`notifyStart failed during startup (ignored): ${String(err)}`)
      }
    })()
  }

  private async stopPolling(): Promise<void> {
    this.polling = false
    this.abortController?.abort()
    this.abortController = null
    // endOutboundSession 是异步的：会 drain 发送队列。关闭时必须等待其完成，
    // 否则 fire-and-forget 可能在适配器关停前未跑完，导致待发消息丢失。
    await Promise.all(
      [...this.outboundSessions.keys()].map(userId =>
        this.endOutboundSession({ userId }).catch(err =>
          log.warn(`endOutboundSession failed during stop for ${userId}: ${String(err)}`)
        )
      )
    )
    for (const userId of [...this.typingKeepalives.keys()]) {
      this.stopTypingKeepalive(userId)
    }
    // 只丢掉未开始的批次；已在下的附件不在此等待，避免 CDN 挂起拖死 stop。
    this.inboundQueue = []
  }

  private async pollLoop(signal: AbortSignal): Promise<void> {
    while (this.polling && !signal.aborted) {
      try {
        assertSessionActive(this.accountKey)
        const resp = await vendoredGetUpdates({
          baseUrl: this.baseUrl,
          token: this.token,
          get_updates_buf: this.getUpdatesBuf,
          timeoutMs: this.serverTimeoutMs,
        })
        if (signal.aborted) break

        const code = resp.ret ?? resp.errcode
        if (code === STALE_TOKEN_ERRCODE) {
          // 上游 monitor.ts：sleep(pauseMs) → continue，session pause 到期后自动恢复。
          // 原先 this.polling = false + break 会导致 loop 永久停止，需要重启才能恢复接收。
          pauseSession(this.accountKey)
          const pauseMs = getRemainingPauseMs(this.accountKey)
          log.warn(`Stale token (errcode=${STALE_TOKEN_ERRCODE}), pausing ${Math.ceil(pauseMs / 60_000)} min then resuming`)
          this.setConnected(false)
          await this.sleep(pauseMs, signal)
          if (!signal.aborted) this.setConnected(true)
          continue
        }
        if (code !== undefined && code !== 0) {
          log.warn(`getUpdates error: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg || ''}`)
          await this.reconnectBackoff(signal)
          continue
        }

        this.reconnectDelay = RECONNECT_DELAY_MS
        if (!this.connected) this.setConnected(true)

        if (resp.get_updates_buf) {
          this.getUpdatesBuf = resp.get_updates_buf
          this.saveSyncBuf(this.getUpdatesBuf)
        }
        if (resp.longpolling_timeout_ms && resp.longpolling_timeout_ms > 0) {
          this.serverTimeoutMs = resp.longpolling_timeout_ms + 5_000
        }

        if (resp.msgs?.length) {
          this.enqueueInbound(resp.msgs)
        }
      } catch (err: any) {
        if (signal.aborted) break
        // session 过期（-14）走的是上面 resp.ret 字段分支；getUpdates 在 HTTP 错误时
        // 不解析 body errcode，与官方 monitor.ts 保持一致，全部按通用网络异常处理。
        log.error('Poll error:', err)
        if (this.connected) this.setConnected(false)
        await this.reconnectBackoff(signal)
      }
    }
  }

  // ==================== 消息分发 ====================

  private enqueueInbound(msgs: WeixinMessage[]): void {
    this.inboundQueue.push(...msgs)
    if (!this.inboundPumpRunning) {
      void this.pumpInbound()
    }
  }

  private async pumpInbound(): Promise<void> {
    this.inboundPumpRunning = true
    try {
      while (this.inboundQueue.length > 0) {
        const batch = this.inboundQueue.splice(0)
        await this.processInboundBatch(batch)
      }
    } catch (err) {
      log.error('Inbound pump error:', err)
    } finally {
      this.inboundPumpRunning = false
      if (this.inboundQueue.length > 0) {
        void this.pumpInbound()
      }
    }
  }

  /**
   * 先并行下附件（图/文件/视频/语音），再按到达顺序一条条分发。
   * 长轮询只负责入队，不在这里等待。
   */
  private async processInboundBatch(batch: WeixinMessage[]): Promise<void> {
    const usable: WeixinMessage[] = []
    for (const msg of batch) {
      if (!msg.from_user_id) continue
      this.rememberInboundSession(msg)
      usable.push(msg)
    }

    const prepared = await mapPool(usable, INBOUND_DOWNLOAD_CONCURRENCY, async (msg) => {
      try {
        return { msg, attachments: await this.downloadAttachments(msg.item_list) }
      } catch (err) {
        log.error('Inbound media download failed:', err)
        return { msg, attachments: [] as IMAttachment[] }
      }
    })

    for (const { msg, attachments } of prepared) {
      try {
        await this.dispatchInbound(msg, attachments)
      } catch (err) {
        log.error('Inbound dispatch error:', err)
      }
    }
  }

  /** 立刻记下 context_token，出站回信用；不挡下载、不挡下一轮拉取。 */
  private rememberInboundSession(msg: WeixinMessage): void {
    const userId = msg.from_user_id || ''
    if (!userId || !msg.context_token) return
    try {
      setContextToken(this.accountKey, userId, msg.context_token)
    } catch (err) {
      log.warn(`setContextToken failed (ignored): ${String(err)}`)
    }
  }

  /**
   * 与上游 monitor.ts + process-message.ts 对齐：每条 inbound 都要 getconfig 注册
   * user 端会话，否则出站 sendmessage 会被服务端拒掉（errcode=-2）。
   */
  private async registerInboundSession(msg: WeixinMessage, userId: string): Promise<void> {
    if (msg.context_token) {
      const prevToken = this.lastConfigContextToken.get(userId)
      if (prevToken !== msg.context_token) {
        this.lastConfigContextToken.set(userId, msg.context_token)
        this.getConfigManager().invalidateUser(userId)
        log.debug(`context_token changed for ${userId}, invalidating config cache`)
      }
    }

    const inboundToken = msg.context_token ?? getContextToken(this.accountKey, userId)
    if (!inboundToken) return
    try {
      await this.getConfigManager().getForUser(userId, inboundToken)
      this.lastConfigContextToken.set(userId, inboundToken)
    } catch (err) {
      log.warn(`registerInboundSession getForUser failed (ignored): ${String(err)}`)
    }
  }

  private async dispatchInbound(msg: WeixinMessage, attachments: IMAttachment[]): Promise<void> {
    const userId = msg.from_user_id || ''
    if (!userId) return

    await this.registerInboundSession(msg, userId)

    const text = bodyFromItemList(msg.item_list)
    if (!text && attachments.length === 0) {
      log.debug(`Skipping empty message from ${userId}`)
      return
    }
    this.softFailNotifiedUsers.delete(userId)

    const incoming: IMIncomingMessage = {
      platform: 'wechat',
      userId,
      userName: (msg as any).from_user_name || userId,
      text,
      chatType: 'single',
      replyContext: {
        userId,
        // 仅作 fallback 种子；实际发送时 resolveContextToken 优先取 store 里的最新值
        contextToken: msg.context_token,
      },
      ...(attachments.length > 0 ? { attachments } : {}),
    }

    try {
      this.onMessage?.(incoming)
    } catch (err) {
      log.error('onMessage handler error:', err)
    }
  }

  // ==================== 附件下载 ====================

  private ensureTempDir(): string {
    const dir = path.join(os.tmpdir(), 'sf-terminal-im', 'wechat')
    fs.mkdirSync(dir, { recursive: true })
    return dir
  }

  private async downloadAttachments(items?: MessageItem[]): Promise<IMAttachment[]> {
    if (!items?.length) return []

    const hasMedia = (m: any) => m?.encrypt_query_param || m?.full_url
    const target =
      items.find(i => i.type === MessageItemType.IMAGE && hasMedia(i.image_item?.media))
      ?? items.find(i => i.type === MessageItemType.VIDEO && hasMedia(i.video_item?.media))
      ?? items.find(i => i.type === MessageItemType.FILE && hasMedia(i.file_item?.media))
      ?? items.find(i => i.type === MessageItemType.VOICE && hasMedia(i.voice_item?.media) && !i.voice_item?.text)

    if (!target) return []

    try {
      const att = await this.downloadOneItem(target)
      return att ? [att] : []
    } catch (err) {
      log.error(`Media download failed (type=${target.type}):`, err)
      return []
    }
  }

  private nextMediaStamp(): string {
    return `${Date.now()}_${++this.mediaSeq}`
  }

  private async downloadOneItem(item: MessageItem): Promise<IMAttachment | null> {
    const stamp = this.nextMediaStamp()
    const tempDir = this.ensureTempDir()

    // vendored downloadAndDecryptBuffer / downloadPlainCdnBuffer 用位置参数：
    //   (encryptedQueryParam, [aesKeyBase64], cdnBaseUrl, label, fullUrl?)
    // 之前误用对象参数，全部 attachment 下载都直接走到 catch 被静默吞掉。
    const fetchBuf = async (media: any, aeskeyHex?: string): Promise<Buffer> => {
      const aesKeyBase64: string | undefined = aeskeyHex
        ? Buffer.from(aeskeyHex, 'hex').toString('base64')
        : media?.aes_key
      const encryptedQueryParam: string = media?.encrypt_query_param ?? ''
      const fullUrl: string | undefined = media?.full_url
      if (aesKeyBase64) {
        return await withTimeout(
          downloadAndDecryptBuffer(
            encryptedQueryParam,
            aesKeyBase64,
            CDN_BASE_URL,
            'wechat-attachment',
            fullUrl,
          ),
          INBOUND_DOWNLOAD_TIMEOUT_MS,
          'wechat-attachment decrypt',
        )
      }
      return await withTimeout(
        downloadPlainCdnBuffer(
          encryptedQueryParam,
          CDN_BASE_URL,
          'wechat-attachment',
          fullUrl,
        ),
        INBOUND_DOWNLOAD_TIMEOUT_MS,
        'wechat-attachment',
      )
    }

    if (item.type === MessageItemType.IMAGE) {
      const img = item.image_item
      if (!img?.media) return null
      const buf = await fetchBuf(img.media, (img as any).aeskey)
      const fileName = `wechat_image_${stamp}.jpg`
      const localPath = path.join(tempDir, fileName)
      fs.writeFileSync(localPath, buf)
      log.info(`Image saved: ${localPath} (${(buf.length / 1024).toFixed(1)}KB)`)
      return { type: 'image', localPath, fileName }
    }
    if (item.type === MessageItemType.VIDEO) {
      const v = item.video_item
      if (!v?.media?.aes_key) return null
      const buf = await fetchBuf(v.media)
      const fileName = `wechat_video_${stamp}.mp4`
      const localPath = path.join(tempDir, fileName)
      fs.writeFileSync(localPath, buf)
      log.info(`Video saved: ${localPath} (${(buf.length / 1024).toFixed(1)}KB)`)
      return { type: 'video', localPath, fileName }
    }
    if (item.type === MessageItemType.FILE) {
      const f = item.file_item
      if (!f?.media?.aes_key) return null
      const buf = await fetchBuf(f.media)
      const fileName = (f as any).file_name || `wechat_file_${stamp}`
      const localPath = path.join(tempDir, fileName)
      fs.writeFileSync(localPath, buf)
      log.info(`File saved: ${localPath} (${(buf.length / 1024).toFixed(1)}KB)`)
      return { type: 'file', localPath, fileName }
    }
    if (item.type === MessageItemType.VOICE) {
      const voice = item.voice_item
      if (!voice?.media?.aes_key) return null
      const buf = await fetchBuf(voice.media)
      const fileName = `wechat_voice_${stamp}.silk`
      const localPath = path.join(tempDir, fileName)
      fs.writeFileSync(localPath, buf)
      log.info(`Voice saved: ${localPath} (${(buf.length / 1024).toFixed(1)}KB)`)
      return { type: 'audio', localPath, fileName }
    }
    return null
  }

  // ==================== Typing Keepalive ====================

  /**
   * 启动 sendTyping keepalive（由 beginOutboundSession 调用）。
   * 每 5 秒发一次 sendtyping，保持 context_token session 存活直至 endOutboundSession。
   */
  private async startTypingKeepalive(userId: string, contextToken?: string): Promise<void> {
    let cachedConfig: Awaited<ReturnType<WeixinConfigManager['getForUser']>>
    try {
      cachedConfig = await this.getConfigManager().getForUser(userId, contextToken)
    } catch (err) {
      log.warn(`startTypingKeepalive: getForUser failed (ignored): ${String(err)}`)
      return
    }
    const ticket = cachedConfig.typingTicket
    if (!ticket) {
      log.debug(`startTypingKeepalive: no typingTicket for ${userId}, skip`)
      return
    }

    this.stopTypingKeepalive(userId)

    const fire = () => {
      void vendoredSendTyping({
        ...this.apiOpts,
        body: { ilink_user_id: userId, typing_ticket: ticket, status: TypingStatus.TYPING },
      }).catch((err: unknown) => {
        log.warn(`sendTyping keepalive failed for ${userId}: ${String(err)}`)
      })
    }

    const timer = setInterval(fire, TYPING_KEEPALIVE_MS)
    const leakTimer = setTimeout(() => {
      if (this.typingKeepalives.has(userId)) {
        log.warn(`Typing keepalive leak guard: auto-stopped after ${TYPING_KEEPALIVE_LEAK_MS / 3_600_000}h for ${userId}`)
        this.stopTypingKeepalive(userId)
      }
    }, TYPING_KEEPALIVE_LEAK_MS)
    this.typingKeepalives.set(userId, { timer, ticket, leakTimer })
    fire()
    log.debug(`Started typing keepalive for ${userId}`)
  }

  /** 结束出站会话：停止 keepalive 并发送 sendtyping(CANCEL)。 */
  private stopTypingKeepalive(userId: string): void {
    const existing = this.typingKeepalives.get(userId)
    if (!existing) return
    clearInterval(existing.timer)
    clearTimeout(existing.leakTimer)
    this.typingKeepalives.delete(userId)
    void vendoredSendTyping({
      ...this.apiOpts,
      body: { ilink_user_id: userId, typing_ticket: existing.ticket, status: TypingStatus.CANCEL },
    }).catch((err: unknown) => log.debug(`sendTyping cancel error (ignored): ${String(err)}`))
    log.debug(`Stopped typing keepalive for ${userId}`)
  }

  // ==================== 工具方法 ====================

  private setConnected(value: boolean): void {
    if (this.connected === value) return
    this.connected = value
    this.onConnectionChange?.(value)
  }

  private async reconnectBackoff(signal: AbortSignal): Promise<void> {
    const delay = this.reconnectDelay
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS)
    log.info(`Reconnecting in ${delay}ms...`)
    await this.sleep(delay, signal)
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal?.aborted) { resolve(); return }
      const timer = setTimeout(resolve, ms)
      signal?.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
    })
  }
}
