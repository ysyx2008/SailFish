/**
 * Calendar Sensor - 日历事件感知器（CalDAV + 本地 .ics 双模式）
 *
 * 优先使用 CalDAV 轮询已配置的日历账户获取事件，
 * 无账户时回退到扫描本地 .ics 文件。
 *
 * 产生两类事件：
 * - upcoming：日历事件即将开始（在 beforeMinutes 窗口内）
 * - changed：检测到新增或取消的日历事件
 *
 * 设计原则：纯确定性逻辑，不消耗 AI 资源。
 */
import * as fs from 'fs'
import * as path from 'path'
import type { Sensor, SensorEvent, EventBus } from './types'
import { createLogger } from '../../utils/logger'

const log = createLogger('CalendarSensor')

interface CalendarEvent {
  uid: string
  summary: string
  description?: string
  location?: string
  dtstart: Date
  dtend?: Date
  account?: string
}

interface CalendarTarget {
  watchId: string
  icsPath?: string
  beforeMinutes: number
}

export interface CalendarAccountInfo {
  accountId: string
  name: string
  provider: string
  username: string
  serverUrl?: string
}

export type CalendarCredentialGetter = (accountId: string) => Promise<string | null>

interface AccountState {
  account: CalendarAccountInfo
  client: any
  calendars: any[]
  lastKnownUids: Set<string>
  connected: boolean
}

const CHECK_INTERVAL_MS = 5 * 60 * 1000
const ALREADY_NOTIFIED_TTL_MS = 24 * 60 * 60 * 1000
const LOOKAHEAD_MS = 24 * 60 * 60 * 1000

let tsdavModule: typeof import('tsdav') | null = null

async function loadTsdav(): Promise<typeof import('tsdav')> {
  if (!tsdavModule) {
    tsdavModule = await import('tsdav')
  }
  return tsdavModule
}

export class CalendarSensor implements Sensor {
  readonly id = 'calendar'
  readonly name = 'Calendar'

  private _running = false
  private eventBus: EventBus
  private targets: Map<string, CalendarTarget> = new Map()
  private checkTimer: NodeJS.Timeout | null = null
  private notifiedEvents: Map<string, number> = new Map()

  private accounts: CalendarAccountInfo[] = []
  private getCredential: CalendarCredentialGetter | null = null
  private accountStates: Map<string, AccountState> = new Map()

  get running(): boolean {
    return this._running
  }

  constructor(eventBus: EventBus) {
    this.eventBus = eventBus
  }

  /**
   * 配置日历账户列表（CalDAV）。
   * 如果 Sensor 已运行，会热更新连接。
   */
  async configureAccounts(accounts: CalendarAccountInfo[], getCredential: CalendarCredentialGetter): Promise<void> {
    this.getCredential = getCredential

    const oldIds = new Set(this.accounts.map(a => a.accountId))
    const newIds = new Set(accounts.map(a => a.accountId))

    const removed = this.accounts.filter(a => !newIds.has(a.accountId))
    const added = accounts.filter(a => !oldIds.has(a.accountId))

    this.accounts = accounts

    if (this._running) {
      for (const acct of removed) {
        this.disconnectAccount(acct.accountId)
      }
      for (const acct of added) {
        await this.connectAccount(acct)
      }
    }

    log.info(`Configured ${accounts.length} account(s) (added=${added.length}, removed=${removed.length})`)
  }

  addTarget(watchId: string, target: Omit<CalendarTarget, 'watchId'>): void {
    this.targets.set(watchId, { ...target, watchId })
  }

  removeTarget(watchId: string): void {
    this.targets.delete(watchId)
  }

  getTargetCount(): number {
    return this.targets.size
  }

  shouldAutoStart(): boolean {
    return this.targets.size > 0 || this.accounts.length > 0
  }

  async start(): Promise<void> {
    if (this._running) return
    this._running = true

    // 连接所有已配置的 CalDAV 账户
    for (const acct of this.accounts) {
      await this.connectAccount(acct)
    }

    this.checkTimer = setInterval(() => this.checkUpcomingEvents(), CHECK_INTERVAL_MS)
    await this.checkUpcomingEvents()

    log.info(`Started with ${this.accounts.length} CalDAV account(s), ${this.targets.size} target(s)`)
  }

  async stop(): Promise<void> {
    if (!this._running) return
    this._running = false

    if (this.checkTimer) {
      clearInterval(this.checkTimer)
      this.checkTimer = null
    }

    for (const id of this.accountStates.keys()) {
      this.disconnectAccount(id)
    }

    log.info('Stopped')
  }

  getAccountStatuses(): Array<{ accountId: string; name: string; connected: boolean }> {
    return this.accounts.map(a => ({
      accountId: a.accountId,
      name: a.name,
      connected: this.accountStates.get(a.accountId)?.connected ?? false
    }))
  }

  // ==================== CalDAV 账户管理 ====================

  private async connectAccount(account: CalendarAccountInfo): Promise<void> {
    if (!this.getCredential) return
    if (this.accountStates.has(account.accountId)) return

    const credential = await this.getCredential(account.accountId)
    if (!credential) {
      log.error(`No credential for ${account.name}`)
      return
    }

    try {
      const tsdav = await loadTsdav()

      const serverUrl = this.resolveServerUrl(account)
      if (!serverUrl) {
        // 配置缺失时跳过该账户，避免持续输出 error 干扰终端
        log.warn(`Skip account without server URL: ${account.name} (provider=${account.provider})`)
        return
      }

      const client = new tsdav.DAVClient({
        serverUrl,
        credentials: {
          username: account.username,
          password: credential
        },
        authMethod: 'Basic',
        defaultAccountType: 'caldav'
      })

      await client.login()
      const calendars = await client.fetchCalendars()

      this.accountStates.set(account.accountId, {
        account,
        client,
        calendars,
        lastKnownUids: new Set(),
        connected: true
      })

      log.info(`Connected to ${account.name} (${calendars.length} calendars)`)
    } catch (err) {
      log.error(`Failed to connect ${account.name}:`, err)
    }
  }

  private disconnectAccount(accountId: string): void {
    this.accountStates.delete(accountId)
  }

  private resolveServerUrl(account: CalendarAccountInfo): string {
    if (account.serverUrl) return account.serverUrl

    const configs: Record<string, string> = {
      google: 'https://apidata.googleusercontent.com/caldav/v2',
      icloud: 'https://caldav.icloud.com',
      outlook: 'https://outlook.office365.com/caldav',
      wecom: 'https://caldav.wecom.work',
      fastmail: 'https://caldav.fastmail.com/dav'
    }
    return configs[account.provider] || ''
  }

  // ==================== 事件检查 ====================

  private async checkUpcomingEvents(): Promise<void> {
    this.cleanupOldNotifications()

    // CalDAV 模式
    if (this.accountStates.size > 0) {
      await this.checkCalDAVEvents()
    }

    // 本地 .ics 模式（Watch target 指定了 icsPath 的情况）
    await this.checkLocalIcsEvents()
  }

  private async checkCalDAVEvents(): Promise<void> {
    const now = new Date()
    const timeMin = now.toISOString()
    const timeMax = new Date(now.getTime() + LOOKAHEAD_MS).toISOString()

    for (const [accountId, state] of this.accountStates) {
      try {
        const events = await this.fetchCalDAVEvents(state, timeMin, timeMax)
        const currentUids = new Set(events.map(e => e.uid))

        // 检测新增事件
        for (const evt of events) {
          if (!state.lastKnownUids.has(evt.uid)) {
            this.emitChangedEvent(evt, 'added', accountId)
          }
        }

        // 检测取消事件
        for (const uid of state.lastKnownUids) {
          if (!currentUids.has(uid)) {
            this.emitChangedEvent({ uid, summary: '(removed)', dtstart: now }, 'removed', accountId)
          }
        }

        // 检测即将开始的事件
        for (const evt of events) {
          this.checkAndEmitUpcoming(evt, accountId)
        }

        state.lastKnownUids = currentUids
      } catch (err) {
        log.error(`CalDAV poll error (${state.account.name}):`, err)
        state.connected = false
        // 尝试重连
        this.accountStates.delete(accountId)
        await this.connectAccount(state.account)
      }
    }
  }

  private async fetchCalDAVEvents(state: AccountState, timeMin: string, timeMax: string): Promise<CalendarEvent[]> {
    const tsdav = await loadTsdav()
    const events: CalendarEvent[] = []

    for (const calendar of state.calendars) {
      try {
        const objects = await tsdav.fetchCalendarObjects({
          calendar: calendar as any,
          timeRange: { start: timeMin, end: timeMax },
          headers: (state.client as any).authHeaders
        })

        for (const obj of objects) {
          const parsed = this.parseVCalendarData(obj.data, state.account.name)
          events.push(...parsed)
        }
      } catch (err) {
        log.warn(`Failed to fetch calendar objects:`, err instanceof Error ? err.message : err)
      }
    }

    return events
  }

  /** 从 VCALENDAR data 字符串中提取 VEVENT */
  private parseVCalendarData(data: string, accountName?: string): CalendarEvent[] {
    if (!data) return []

    const events: CalendarEvent[] = []
    const now = new Date()
    const maxTime = new Date(now.getTime() + LOOKAHEAD_MS)
    const blocks = data.split('BEGIN:VEVENT')

    for (let i = 1; i < blocks.length; i++) {
      const block = blocks[i].split('END:VEVENT')[0]
      if (!block) continue

      const uid = this.extractField(block, 'UID')
      const summary = this.extractField(block, 'SUMMARY')
      const dtstart = this.parseIcsDate(this.extractField(block, 'DTSTART'))

      if (!uid || !summary || !dtstart) continue
      if (dtstart < now || dtstart > maxTime) continue

      events.push({
        uid,
        summary,
        description: this.extractField(block, 'DESCRIPTION'),
        location: this.extractField(block, 'LOCATION'),
        dtstart,
        dtend: this.parseIcsDate(this.extractField(block, 'DTEND')),
        account: accountName
      })
    }

    return events
  }

  private checkAndEmitUpcoming(evt: CalendarEvent, _accountId: string): void {
    const now = new Date()
    const DEFAULT_BEFORE_MIN = 15

    // 有 Watch target 时按各自配置发送；无 target 时用默认窗口发给唤醒 batch
    const entries: Array<{ watchId?: string; beforeMinutes: number }> =
      this.targets.size > 0
        ? Array.from(this.targets.entries()).map(([wid, t]) => ({ watchId: wid, beforeMinutes: t.beforeMinutes || DEFAULT_BEFORE_MIN }))
        : [{ beforeMinutes: DEFAULT_BEFORE_MIN }]

    for (const { watchId, beforeMinutes } of entries) {
      const timeDiff = evt.dtstart.getTime() - now.getTime()
      const notifyKey = `${watchId ?? 'global'}:${evt.uid}:${evt.dtstart.getTime()}`

      if (timeDiff > 0 && timeDiff <= beforeMinutes * 60 * 1000 && !this.notifiedEvents.has(notifyKey)) {
        this.notifiedEvents.set(notifyKey, Date.now())

        const event: SensorEvent = {
          id: `cal-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 6)}`,
          type: 'calendar',
          source: this.id,
          timestamp: Date.now(),
          watchId,
          payload: {
            uid: evt.uid,
            summary: evt.summary,
            description: evt.description,
            location: evt.location,
            startsAt: evt.dtstart.toISOString(),
            endsAt: evt.dtend?.toISOString(),
            minutesUntilStart: Math.round(timeDiff / 60000),
            account: evt.account,
            eventType: 'upcoming'
          },
          priority: timeDiff <= 5 * 60 * 1000 ? 'high' : 'normal'
        }

        if (watchId) {
          log.info(`Upcoming: "${evt.summary}" in ${Math.round(timeDiff / 60000)}min`)
        }
        this.eventBus.emit(event)
      }
    }
  }

  private emitChangedEvent(evt: CalendarEvent, changeType: 'added' | 'removed', accountId: string): void {
    const event: SensorEvent = {
      id: `cal-chg-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 6)}`,
      type: 'calendar',
      source: this.id,
      timestamp: Date.now(),
      payload: {
        uid: evt.uid,
        summary: evt.summary,
        description: evt.description,
        location: evt.location,
        startsAt: evt.dtstart.toISOString(),
        endsAt: evt.dtend?.toISOString(),
        account: evt.account || accountId,
        eventType: 'changed',
        changeType
      },
      priority: 'normal'
    }

    log.info(`Event ${changeType}: "${evt.summary}"`)
    this.eventBus.emit(event)
  }

  // ==================== 本地 .ics 回退 ====================

  private async checkLocalIcsEvents(): Promise<void> {
    for (const [watchId, target] of this.targets) {
      if (!target.icsPath && this.accountStates.size > 0) continue

      try {
        const icsFiles = this.findIcsFiles(target.icsPath)
        const now = new Date()
        const windowMs = target.beforeMinutes * 60 * 1000

        for (const icsFile of icsFiles) {
          const events = this.parseIcsFile(icsFile)

          for (const calEvent of events) {
            const timeDiff = calEvent.dtstart.getTime() - now.getTime()
            const notifyKey = `${watchId}:${calEvent.uid}:${calEvent.dtstart.getTime()}`

            if (timeDiff > 0 && timeDiff <= windowMs && !this.notifiedEvents.has(notifyKey)) {
              this.notifiedEvents.set(notifyKey, Date.now())

              const event: SensorEvent = {
                id: `cal-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 6)}`,
                type: 'calendar',
                source: this.id,
                timestamp: Date.now(),
                watchId,
                payload: {
                  uid: calEvent.uid,
                  summary: calEvent.summary,
                  description: calEvent.description,
                  location: calEvent.location,
                  startsAt: calEvent.dtstart.toISOString(),
                  endsAt: calEvent.dtend?.toISOString(),
                  minutesUntilStart: Math.round(timeDiff / 60000),
                  icsFile,
                  eventType: 'upcoming'
                },
                priority: timeDiff <= 5 * 60 * 1000 ? 'high' : 'normal'
              }

              this.eventBus.emit(event)
            }
          }
        }
      } catch (err) {
        log.error(`Error checking local ICS for watch ${watchId}:`, err)
      }
    }
  }

  // ==================== .ics 文件解析 ====================

  private findIcsFiles(icsPath?: string): string[] {
    if (!icsPath) {
      return this.findSystemCalendarFiles()
    }

    try {
      const resolved = path.resolve(icsPath)
      const stat = fs.statSync(resolved)

      if (stat.isFile() && resolved.endsWith('.ics')) {
        return [resolved]
      }

      if (stat.isDirectory()) {
        return fs.readdirSync(resolved)
          .filter(f => f.endsWith('.ics'))
          .map(f => path.join(resolved, f))
      }
    } catch {
      // path doesn't exist
    }

    return []
  }

  private findSystemCalendarFiles(): string[] {
    const home = process.env.HOME || process.env.USERPROFILE || ''
    const candidates: string[] = []

    if (process.platform === 'darwin') {
      const calDir = path.join(home, 'Library', 'Calendars')
      if (fs.existsSync(calDir)) {
        this.walkDir(calDir, candidates, '.ics', 3)
      }
    }

    return candidates
  }

  private walkDir(dir: string, result: string[], ext: string, maxDepth: number): void {
    if (maxDepth <= 0) return
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue
        const fullPath = path.join(dir, entry.name)
        if (entry.isFile() && entry.name.endsWith(ext)) {
          result.push(fullPath)
          if (result.length >= 200) return
        } else if (entry.isDirectory() && !entry.name.startsWith('.')) {
          this.walkDir(fullPath, result, ext, maxDepth - 1)
        }
      }
    } catch { /* permission denied etc. */ }
  }

  private parseIcsFile(filePath: string): CalendarEvent[] {
    try {
      const content = fs.readFileSync(filePath, 'utf-8')
      return this.parseVCalendarData(content)
    } catch (err) {
      log.error(`Failed to parse ${filePath}:`, err)
      return []
    }
  }

  // ==================== 工具方法 ====================

  private extractField(block: string, fieldName: string): string | undefined {
    const regex = new RegExp(`^${fieldName}(?:;[^:]*)?:(.+)$`, 'm')
    const match = block.match(regex)
    return match?.[1]?.trim()
  }

  private parseIcsDate(value?: string): Date | undefined {
    if (!value) return undefined

    const cleaned = value.replace(/[^0-9TZ]/g, '')

    if (cleaned.length >= 15) {
      const year = parseInt(cleaned.substring(0, 4))
      const month = parseInt(cleaned.substring(4, 6)) - 1
      const day = parseInt(cleaned.substring(6, 8))
      const hour = parseInt(cleaned.substring(9, 11))
      const minute = parseInt(cleaned.substring(11, 13))
      const second = parseInt(cleaned.substring(13, 15))

      if (cleaned.endsWith('Z')) {
        return new Date(Date.UTC(year, month, day, hour, minute, second))
      }
      return new Date(year, month, day, hour, minute, second)
    }

    if (cleaned.length >= 8) {
      const year = parseInt(cleaned.substring(0, 4))
      const month = parseInt(cleaned.substring(4, 6)) - 1
      const day = parseInt(cleaned.substring(6, 8))
      return new Date(year, month, day)
    }

    return undefined
  }

  private cleanupOldNotifications(): void {
    const now = Date.now()
    for (const [key, timestamp] of this.notifiedEvents) {
      if (now - timestamp > ALREADY_NOTIFIED_TTL_MS) {
        this.notifiedEvents.delete(key)
      }
    }
  }
}
