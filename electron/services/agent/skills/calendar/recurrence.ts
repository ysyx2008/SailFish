/**
 * 重复规则（RRULE）的读写。
 * 截止日期含当天；只写日期时，定时日程的截止记到当天结束。
 * 截止日期与次数互斥。
 */

export type RecurrenceFreq = 'daily' | 'weekly' | 'monthly' | 'yearly'

const FREQS = new Set<RecurrenceFreq>(['daily', 'weekly', 'monthly', 'yearly'])

const COUNT_MAX = 5000

export interface UntilInput {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
  /** 用户只写了日期，截止含当天 */
  dateOnly: boolean
}

export interface RecurrencePatch {
  freq?: RecurrenceFreq
  /** null 表示去掉截止日期 */
  until?: UntilInput | null
  /** null 表示去掉次数 */
  count?: number | null
}

export type RecurrenceReadError =
  | 'bound_conflict'
  | 'freq_invalid'
  | 'until_invalid'
  | 'count_invalid'
  | 'freq_required'

export interface RecurrenceView {
  freq: RecurrenceFreq
  /** 给人看的截止日期，如 2027-07-31 或 2027-07-31 18:00 */
  until?: string
  count?: number
}

interface RRulePart {
  key: string
  value: string
}

export function readRecurrencePatch(
  args: Record<string, unknown>,
  mode: 'create' | 'update',
): { ok: true; patch: RecurrencePatch | null } | { ok: false; error: RecurrenceReadError } {
  const freqRaw = args.recurrence
  let freq: RecurrenceFreq | undefined
  if (freqRaw != null && freqRaw !== '') {
    if (typeof freqRaw !== 'string' || !FREQS.has(freqRaw as RecurrenceFreq)) {
      return { ok: false, error: 'freq_invalid' }
    }
    freq = freqRaw as RecurrenceFreq
  }

  let until: UntilInput | null | undefined
  if ('recurrence_until' in args && args.recurrence_until != null) {
    if (typeof args.recurrence_until !== 'string') {
      return { ok: false, error: 'until_invalid' }
    }
    const text = args.recurrence_until.trim()
    if (text === '') {
      if (mode === 'update') until = null
    } else {
      const parsed = parseUntilInput(text)
      if (!parsed) return { ok: false, error: 'until_invalid' }
      until = parsed
    }
  }

  let count: number | null | undefined
  if ('recurrence_count' in args && args.recurrence_count != null && args.recurrence_count !== '') {
    const parsed = parseCount(args.recurrence_count)
    if (parsed === 'invalid') return { ok: false, error: 'count_invalid' }
    if (parsed === 0 && mode === 'update') count = null
    else if (parsed < 1 || parsed > COUNT_MAX) return { ok: false, error: 'count_invalid' }
    else count = parsed
  }

  const hasUntil = until != null
  const hasCount = count != null && count > 0
  if (hasUntil && hasCount) return { ok: false, error: 'bound_conflict' }

  if (mode === 'create' && !freq && (hasUntil || hasCount)) {
    return { ok: false, error: 'freq_required' }
  }

  if (!freq && until === undefined && count === undefined) {
    return { ok: true, patch: null }
  }

  const patch: RecurrencePatch = {}
  if (freq) patch.freq = freq
  if (until !== undefined) patch.until = until
  if (count !== undefined) patch.count = count
  return { ok: true, patch }
}

export function mergeRRule(
  existing: string | undefined,
  patch: RecurrencePatch | null,
  allDay: boolean,
): string | undefined {
  if (!patch) return existing || undefined

  const parts = existing ? splitParts(existing) : []
  const freq = patch.freq ?? freqFromParts(parts)
  if (!freq) return undefined

  const kept = parts.filter(part => part.key !== 'FREQ' && part.key !== 'UNTIL' && part.key !== 'COUNT')
  let untilPart = parts.find(part => part.key === 'UNTIL')
  let countPart = parts.find(part => part.key === 'COUNT')

  if (patch.until) {
    untilPart = { key: 'UNTIL', value: formatUntil(patch.until, allDay) }
    countPart = undefined
  } else if (patch.until === null) {
    untilPart = undefined
  }

  if (patch.count != null && patch.count > 0) {
    countPart = { key: 'COUNT', value: String(patch.count) }
    untilPart = undefined
  } else if (patch.count === null) {
    countPart = undefined
  }

  const out: RRulePart[] = [{ key: 'FREQ', value: freq.toUpperCase() }, ...kept]
  if (untilPart) out.push(untilPart)
  if (countPart) out.push(countPart)
  return out.map(part => `${part.key}=${part.value}`).join(';')
}

/** 截止日期不早于首场。只写日期时按天比。 */
export function untilOnOrAfterStart(until: UntilInput, start: Date, allDay: boolean): boolean {
  if (Number.isNaN(start.getTime())) return true
  if (allDay || until.dateOnly) {
    const startDay = new Date(start.getFullYear(), start.getMonth(), start.getDate()).getTime()
    const untilDay = new Date(until.year, until.month - 1, until.day).getTime()
    return untilDay >= startDay
  }
  const untilTime = new Date(until.year, until.month - 1, until.day, until.hour, until.minute, until.second).getTime()
  return untilTime >= start.getTime()
}

export function viewRecurrence(rrule: string | undefined): RecurrenceView | null {
  if (!rrule) return null
  const parts = splitParts(rrule)
  const freq = freqFromParts(parts)
  if (!freq) return null
  const view: RecurrenceView = { freq }
  const until = parts.find(part => part.key === 'UNTIL')?.value
  const countRaw = parts.find(part => part.key === 'COUNT')?.value
  if (until) {
    const label = formatUntilForDisplay(until)
    if (label) view.until = label
  }
  if (countRaw && /^\d+$/.test(countRaw)) view.count = Number(countRaw)
  return view
}

/**
 * 系列在 instant 之前已经结束。
 * 有截止日期时按截止日期。只有次数、且没有「按星期几」这类额外限制时，用首场时间估算最后一场。
 */
export function recurrenceEndedBefore(
  rrule: string,
  instant: Date,
  seriesStart?: Date,
  seriesEnd?: Date,
): boolean {
  const parts = splitParts(rrule)
  const until = parts.find(part => part.key === 'UNTIL')?.value
  if (until) {
    const end = untilTokenToDate(until)
    if (!end) return false
    return end.getTime() < instant.getTime()
  }

  if (!seriesStart || Number.isNaN(seriesStart.getTime())) return false
  if (parts.some(part => part.key.startsWith('BY'))) return false

  const countRaw = parts.find(part => part.key === 'COUNT')?.value
  if (!countRaw || !/^\d+$/.test(countRaw)) return false
  const count = Number(countRaw)
  const freq = freqFromParts(parts)
  if (!freq || count < 1) return false

  const intervalRaw = parts.find(part => part.key === 'INTERVAL')?.value
  const interval = intervalRaw && /^\d+$/.test(intervalRaw) ? Number(intervalRaw) : 1
  if (interval < 1) return false

  const lastStart = addRecurrenceSteps(seriesStart, freq, (count - 1) * interval)
  const duration = seriesEnd && !Number.isNaN(seriesEnd.getTime())
    ? Math.max(0, seriesEnd.getTime() - seriesStart.getTime())
    : 0
  return lastStart.getTime() + duration < instant.getTime()
}

/**
 * 只替换第一条日程里的重复规则，其余行原样保留。
 * 没有规则时插在该日程结束之前；rrule 为空则删掉规则。
 */
export function replaceEventRRule(ical: string, rrule: string | undefined): string {
  const newline = ical.includes('\r\n') ? '\r\n' : '\n'
  const lines = ical.replace(/\r?\n[ \t]/g, '').split(/\r?\n/)
  let inEvent = false
  let done = false
  const out: string[] = []
  for (const line of lines) {
    if (!done && line.startsWith('BEGIN:VEVENT')) {
      inEvent = true
      out.push(line)
      continue
    }
    if (!done && inEvent && line.startsWith('RRULE:')) continue
    if (!done && inEvent && line.startsWith('END:VEVENT')) {
      if (rrule) out.push(`RRULE:${rrule}`)
      out.push(line)
      inEvent = false
      done = true
      continue
    }
    out.push(line)
  }
  return out.join(newline)
}

/** 只取第一个日程里的重复规则，不误拿时区里的规则。 */
export function readRRuleValue(ical: string): string | undefined {
  const unfolded = ical.replace(/\r?\n[ \t]/g, '')
  let inEvent = false
  let sawEvent = false
  let fallback: string | undefined
  for (const line of unfolded.split(/\r?\n/)) {
    if (line.startsWith('BEGIN:VEVENT')) {
      inEvent = true
      sawEvent = true
      continue
    }
    if (line.startsWith('END:VEVENT')) return undefined
    if (!line.startsWith('RRULE:')) continue
    const value = line.slice('RRULE:'.length).trim()
    if (inEvent) return value
    if (!sawEvent && fallback === undefined) fallback = value
  }
  return fallback
}

function formatUntil(until: UntilInput, allDay: boolean): string {
  const ymd = `${until.year}${pad(until.month)}${pad(until.day)}`
  if (allDay) return ymd
  if (until.dateOnly) return `${ymd}T235959`
  return `${ymd}T${pad(until.hour)}${pad(until.minute)}${pad(until.second)}`
}

function formatUntilForDisplay(token: string): string | undefined {
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(token)
  if (dateOnly) return `${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}`

  const zoned = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(token)
  if (zoned) {
    const date = new Date(Date.UTC(+zoned[1], +zoned[2] - 1, +zoned[3], +zoned[4], +zoned[5], +zoned[6]))
    return formatWallClock(date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds())
  }

  const local = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(token)
  if (!local) return undefined
  return formatWallClock(+local[1], +local[2], +local[3], +local[4], +local[5], +local[6])
}

function formatWallClock(year: number, month: number, day: number, hour: number, minute: number, second: number): string {
  const ymd = `${year}-${pad(month)}-${pad(day)}`
  if (hour === 23 && minute === 59 && second === 59) return ymd
  if (second === 0) return `${ymd} ${pad(hour)}:${pad(minute)}`
  return `${ymd} ${pad(hour)}:${pad(minute)}:${pad(second)}`
}

function untilTokenToDate(token: string): Date | null {
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(token)
  if (dateOnly) return new Date(+dateOnly[1], +dateOnly[2] - 1, +dateOnly[3], 23, 59, 59)
  const zoned = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(token)
  if (zoned) return new Date(Date.UTC(+zoned[1], +zoned[2] - 1, +zoned[3], +zoned[4], +zoned[5], +zoned[6]))
  const local = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(token)
  if (!local) return null
  return new Date(+local[1], +local[2] - 1, +local[3], +local[4], +local[5], +local[6])
}

function parseUntilInput(text: string): UntilInput | null {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (dateOnly) {
    const year = Number(dateOnly[1])
    const month = Number(dateOnly[2])
    const day = Number(dateOnly[3])
    if (!isRealDate(year, month, day)) return null
    return { year, month, day, hour: 23, minute: 59, second: 59, dateOnly: true }
  }

  const local = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text)
  if (local) {
    const year = Number(local[1])
    const month = Number(local[2])
    const day = Number(local[3])
    const hour = Number(local[4])
    const minute = Number(local[5])
    const second = local[6] != null ? Number(local[6]) : 0
    if (!isRealDate(year, month, day) || hour > 23 || minute > 59 || second > 59) return null
    return { year, month, day, hour, minute, second, dateOnly: false }
  }

  if (/[zZ]|[+-]\d{2}:\d{2}$/.test(text)) {
    const date = new Date(text)
    if (Number.isNaN(date.getTime())) return null
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
      second: date.getSeconds(),
      dateOnly: false,
    }
  }

  return null
}

function parseCount(value: unknown): number | 'invalid' {
  if (typeof value === 'number' && Number.isInteger(value)) return value
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value.trim())
  return 'invalid'
}

function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false
  const date = new Date(year, month - 1, day)
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
}

function splitParts(rrule: string): RRulePart[] {
  return rrule.split(';').map(part => part.trim()).filter(Boolean).map(part => {
    const index = part.indexOf('=')
    if (index < 0) return { key: part.toUpperCase(), value: '' }
    return { key: part.slice(0, index).toUpperCase(), value: part.slice(index + 1) }
  })
}

function freqFromParts(parts: RRulePart[]): RecurrenceFreq | undefined {
  const raw = parts.find(part => part.key === 'FREQ')?.value.toLowerCase()
  if (raw && FREQS.has(raw as RecurrenceFreq)) return raw as RecurrenceFreq
  return undefined
}

function addRecurrenceSteps(start: Date, freq: RecurrenceFreq, steps: number): Date {
  const date = new Date(start.getTime())
  if (freq === 'daily') date.setDate(date.getDate() + steps)
  else if (freq === 'weekly') date.setDate(date.getDate() + steps * 7)
  else if (freq === 'monthly') date.setMonth(date.getMonth() + steps)
  else date.setFullYear(date.getFullYear() + steps)
  return date
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}
