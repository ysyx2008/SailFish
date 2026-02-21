/**
 * Email Sensor - 邮件感知器
 *
 * 使用 IMAP IDLE 长连接监听新邮件到达。
 * 复用现有的邮箱凭证体系（credential.service + email skill）。
 *
 * 工作流程：
 *   1. 连接 IMAP 服务器并选中 INBOX
 *   2. 进入 IDLE 模式，等待服务器推送新邮件通知
 *   3. 收到新邮件时，获取邮件头信息，匹配过滤规则
 *   4. 匹配成功则产生 email 事件投入 EventBus
 *   5. 连接断开时自动重连（指数退避）
 */
import type { Sensor, SensorEvent, EventBus } from './types'

interface EmailFilter {
  from?: string
  subject?: string
  unseen?: boolean
}

interface EmailTarget {
  watchId: string
  filter?: EmailFilter
}

interface EmailAccountInfo {
  accountId: string
  email: string
  provider: string
  imapHost: string
  imapPort: number
  rejectUnauthorized?: boolean
}

const MAX_RECONNECT_DELAY_MS = 5 * 60 * 1000
const INITIAL_RECONNECT_DELAY_MS = 5 * 1000
const IDLE_TIMEOUT_MS = 25 * 60 * 1000

let ImapFlowClass: any = null

async function loadImapFlow(): Promise<any> {
  if (!ImapFlowClass) {
    const mod = await import('imapflow')
    ImapFlowClass = mod.ImapFlow
  }
  return ImapFlowClass
}

export class EmailSensor implements Sensor {
  readonly id = 'email'
  readonly name = 'Email (IMAP IDLE)'

  private _running = false
  private eventBus: EventBus
  private targets: Map<string, EmailTarget> = new Map()
  private imapClient: any = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private reconnectDelay = INITIAL_RECONNECT_DELAY_MS
  private idleRefreshTimer: NodeJS.Timeout | null = null
  private accountInfo: EmailAccountInfo | null = null
  private getCredential: (() => Promise<string | null>) | null = null
  private lastSeenUid: number = 0
  private _connected = false

  get running(): boolean {
    return this._running
  }

  get connected(): boolean {
    return this._connected
  }

  constructor(eventBus: EventBus) {
    this.eventBus = eventBus
  }

  configure(account: EmailAccountInfo, getCredential: () => Promise<string | null>): void {
    this.accountInfo = account
    this.getCredential = getCredential
  }

  addTarget(watchId: string, filter?: EmailFilter): void {
    this.targets.set(watchId, { watchId, filter })
  }

  removeTarget(watchId: string): void {
    this.targets.delete(watchId)
  }

  getTargetCount(): number {
    return this.targets.size
  }

  shouldAutoStart(): boolean {
    return this.targets.size > 0 && this.accountInfo !== null && this.getCredential !== null
  }

  async start(): Promise<void> {
    if (this._running) return
    if (!this.accountInfo || !this.getCredential) {
      console.log('[EmailSensor] No account configured, skipping start')
      return
    }
    this._running = true
    await this.connect()
  }

  async stop(): Promise<void> {
    if (!this._running) return
    this._running = false

    this.clearTimers()
    await this.disconnect()

    console.log('[EmailSensor] Stopped')
  }

  private async connect(): Promise<void> {
    if (!this.accountInfo || !this.getCredential) return

    const credential = await this.getCredential()
    if (!credential) {
      console.error('[EmailSensor] Failed to obtain credential')
      return
    }

    try {
      const ImapFlow = await loadImapFlow()

      this.imapClient = new ImapFlow({
        host: this.accountInfo.imapHost,
        port: this.accountInfo.imapPort,
        secure: true,
        auth: {
          user: this.accountInfo.email,
          pass: credential
        },
        logger: false,
        tls: {
          rejectUnauthorized: this.accountInfo.rejectUnauthorized !== false
        }
      })

      this.imapClient.on('close', () => {
        this._connected = false
        console.log('[EmailSensor] IMAP connection closed')
        if (this._running) {
          this.scheduleReconnect()
        }
      })

      this.imapClient.on('error', (err: Error) => {
        console.error('[EmailSensor] IMAP error:', err.message)
      })

      await this.imapClient.connect()
      this._connected = true
      this.reconnectDelay = INITIAL_RECONNECT_DELAY_MS

      console.log(`[EmailSensor] Connected to ${this.accountInfo.email}`)
      await this.startIdleLoop()
    } catch (err) {
      console.error('[EmailSensor] Failed to connect:', err)
      this._connected = false
      if (this._running) {
        this.scheduleReconnect()
      }
    }
  }

  private async disconnect(): Promise<void> {
    if (this.imapClient) {
      try {
        await this.imapClient.logout()
      } catch { /* already closed */ }
      this.imapClient = null
      this._connected = false
    }
  }

  private async startIdleLoop(): Promise<void> {
    if (!this.imapClient || !this._running) return

    try {
      const lock = await this.imapClient.getMailboxLock('INBOX')
      try {
        const status = await this.imapClient.status('INBOX', { uidNext: true })
        this.lastSeenUid = (status.uidNext || 1) - 1

        this.scheduleIdleRefresh()
        await this.idleAndWait()
      } finally {
        lock.release()
      }
    } catch (err) {
      console.error('[EmailSensor] IDLE loop error:', err)
      if (this._running) {
        this.scheduleReconnect()
      }
    }
  }

  private async idleAndWait(): Promise<void> {
    while (this._running && this.imapClient?.usable) {
      try {
        await this.imapClient.idle()
        await this.checkNewMail()
      } catch (err: any) {
        if (err?.code === 'ECONNRESET' || err?.message?.includes('closed')) {
          break
        }
        console.error('[EmailSensor] IDLE error:', err)
        break
      }
    }
  }

  private async checkNewMail(): Promise<void> {
    if (!this.imapClient?.usable) return

    try {
      const messages: Array<{
        uid: number
        envelope: {
          from?: Array<{ name?: string; address?: string }>
          subject?: string
          date?: Date
        }
      }> = []

      for await (const msg of this.imapClient.fetch(
        { uid: `${this.lastSeenUid + 1}:*` },
        { envelope: true, uid: true }
      )) {
        if (msg.uid > this.lastSeenUid) {
          messages.push(msg)
        }
      }

      for (const msg of messages) {
        this.lastSeenUid = Math.max(this.lastSeenUid, msg.uid)

        const from = msg.envelope?.from?.[0]
        const fromAddr = from?.address || ''
        const fromName = from?.name || ''
        const subject = msg.envelope?.subject || ''

        for (const [watchId, target] of this.targets) {
          if (this.matchesFilter(target.filter, fromAddr, subject)) {
            const event: SensorEvent = {
              id: `em-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 6)}`,
              type: 'email',
              source: this.id,
              timestamp: Date.now(),
              watchId,
              payload: {
                uid: msg.uid,
                from: fromAddr,
                fromName,
                subject,
                date: msg.envelope?.date?.toISOString(),
                account: this.accountInfo!.email
              },
              priority: 'normal'
            }

            console.log(`[EmailSensor] New email from ${fromAddr}: ${subject}`)
            this.eventBus.emit(event)
          }
        }
      }
    } catch (err) {
      console.error('[EmailSensor] Check new mail error:', err)
    }
  }

  private matchesFilter(filter: EmailFilter | undefined, from: string, subject: string): boolean {
    if (!filter) return true

    if (filter.from && !from.toLowerCase().includes(filter.from.toLowerCase())) {
      return false
    }
    if (filter.subject && !subject.toLowerCase().includes(filter.subject.toLowerCase())) {
      return false
    }

    return true
  }

  private scheduleReconnect(): void {
    this.clearTimers()

    const delay = Math.min(this.reconnectDelay, MAX_RECONNECT_DELAY_MS)
    console.log(`[EmailSensor] Reconnecting in ${delay / 1000}s...`)

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null
      if (this._running) {
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS)
        await this.disconnect()
        await this.connect()
      }
    }, delay)
  }

  private scheduleIdleRefresh(): void {
    if (this.idleRefreshTimer) {
      clearInterval(this.idleRefreshTimer)
    }
    this.idleRefreshTimer = setInterval(async () => {
      if (this.imapClient?.usable) {
        try {
          await this.imapClient.noop()
          console.log('[EmailSensor] IDLE keepalive sent')
        } catch {
          console.log('[EmailSensor] IDLE keepalive failed, will reconnect')
        }
      }
    }, IDLE_TIMEOUT_MS)
  }

  private clearTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.idleRefreshTimer) {
      clearInterval(this.idleRefreshTimer)
      this.idleRefreshTimer = null
    }
  }
}
