/**
 * Calendar Sensor - 日历事件感知器
 *
 * 扫描 .ics 文件，在日历事件即将开始时产生 calendar 事件。
 * 支持标准 iCalendar 格式，可监控多个 .ics 文件或目录。
 *
 * 设计原则：纯确定性逻辑，不消耗 AI 资源。
 */
import * as fs from 'fs'
import * as path from 'path'
import type { Sensor, SensorEvent, EventBus } from './types'

interface CalendarEvent {
  uid: string
  summary: string
  description?: string
  location?: string
  dtstart: Date
  dtend?: Date
  rrule?: string
}

interface CalendarTarget {
  watchId: string
  icsPath?: string
  beforeMinutes: number
}

const CHECK_INTERVAL_MS = 60 * 1000
const ALREADY_NOTIFIED_TTL_MS = 24 * 60 * 60 * 1000

export class CalendarSensor implements Sensor {
  readonly id = 'calendar'
  readonly name = 'Calendar'

  private _running = false
  private eventBus: EventBus
  private targets: Map<string, CalendarTarget> = new Map()
  private checkTimer: NodeJS.Timeout | null = null
  private notifiedEvents: Map<string, number> = new Map() // uid -> notified timestamp

  get running(): boolean {
    return this._running
  }

  constructor(eventBus: EventBus) {
    this.eventBus = eventBus
  }

  async start(): Promise<void> {
    if (this._running) return
    this._running = true

    this.checkTimer = setInterval(() => this.checkUpcomingEvents(), CHECK_INTERVAL_MS)
    await this.checkUpcomingEvents()

    console.log(`[CalendarSensor] Started with ${this.targets.size} targets`)
  }

  async stop(): Promise<void> {
    if (!this._running) return
    this._running = false

    if (this.checkTimer) {
      clearInterval(this.checkTimer)
      this.checkTimer = null
    }

    console.log('[CalendarSensor] Stopped')
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
    return this.targets.size > 0
  }

  private async checkUpcomingEvents(): Promise<void> {
    this.cleanupOldNotifications()

    for (const [watchId, target] of this.targets) {
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
                  icsFile
                },
                priority: timeDiff <= 5 * 60 * 1000 ? 'high' : 'normal'
              }

              console.log(`[CalendarSensor] Upcoming: "${calEvent.summary}" in ${Math.round(timeDiff / 60000)}min`)
              this.eventBus.emit(event)
            }
          }
        }
      } catch (err) {
        console.error(`[CalendarSensor] Error checking watch ${watchId}:`, err)
      }
    }
  }

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

  /**
   * 简易 iCalendar 解析器
   * 只提取 VEVENT 中的关键字段，不依赖外部库
   */
  private parseIcsFile(filePath: string): CalendarEvent[] {
    const events: CalendarEvent[] = []

    try {
      const content = fs.readFileSync(filePath, 'utf-8')
      const veventBlocks = content.split('BEGIN:VEVENT')

      for (let i = 1; i < veventBlocks.length; i++) {
        const block = veventBlocks[i].split('END:VEVENT')[0]
        if (!block) continue

        const uid = this.extractField(block, 'UID')
        const summary = this.extractField(block, 'SUMMARY')
        const dtstart = this.parseIcsDate(this.extractField(block, 'DTSTART'))

        if (!uid || !summary || !dtstart) continue

        const now = new Date()
        const dayFromNow = new Date(now.getTime() + 24 * 60 * 60 * 1000)
        if (dtstart < now || dtstart > dayFromNow) continue

        events.push({
          uid,
          summary,
          description: this.extractField(block, 'DESCRIPTION'),
          location: this.extractField(block, 'LOCATION'),
          dtstart,
          dtend: this.parseIcsDate(this.extractField(block, 'DTEND')),
          rrule: this.extractField(block, 'RRULE')
        })
      }
    } catch (err) {
      console.error(`[CalendarSensor] Failed to parse ${filePath}:`, err)
    }

    return events
  }

  private extractField(block: string, fieldName: string): string | undefined {
    // iCalendar 字段可能有参数，如 DTSTART;TZID=Asia/Shanghai:20250101T090000
    const regex = new RegExp(`^${fieldName}(?:;[^:]*)?:(.+)$`, 'm')
    const match = block.match(regex)
    return match?.[1]?.trim()
  }

  private parseIcsDate(value?: string): Date | undefined {
    if (!value) return undefined

    // 格式：20250101T090000Z 或 20250101T090000
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
