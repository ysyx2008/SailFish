/**
 * iCalendar 文本里的几个纯函数小工具：时区换算、时长、地址、主日程定位。
 * 不碰网络，不依赖界面语言。
 */

/**
 * 把某个时区的墙上时间换算成绝对时刻（含夏令时）。
 * 时区名不是标准的 IANA 名称（如企业微信的 TZ08）时返回 null。
 */
export function zonedToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string
): Date | null {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric'
    })
    const offsetAt = (instant: number): number => {
      const parts = formatter.formatToParts(new Date(instant))
      const read = (type: string) => Number(parts.find(part => part.type === type)?.value)
      const shown = Date.UTC(read('year'), read('month') - 1, read('day'), read('hour') % 24, read('minute'), read('second'))
      return shown - Math.floor(instant / 1000) * 1000
    }
    const wall = Date.UTC(year, month - 1, day, hour, minute, second)
    // 先按墙上时间估一次偏移，再按估出的时刻修正一次，夏令时切换点附近也站得住
    const estimated = wall - offsetAt(wall)
    const corrected = wall - offsetAt(estimated)
    return new Date(corrected)
  } catch {
    return null
  }
}

/** 日程时长：按天（含周）计的部分与按时分秒计的部分分开，全天日程只用前者 */
export interface ICalDuration {
  days: number
  ms: number
}

/** 读 iCalendar 时长，如 PT1H30M、P1D、P2W；不合规或为负时返回 null */
export function parseICalDuration(text: string): ICalDuration | null {
  const match = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(text.trim())
  if (!match || match[1] === '-') return null
  const [, , weeks, days, hours, minutes, seconds] = match
  const total = (weeks ? Number(weeks) * 7 : 0) + (days ? Number(days) : 0)
  const ms = ((hours ? Number(hours) : 0) * 3600 + (minutes ? Number(minutes) : 0) * 60 + (seconds ? Number(seconds) : 0)) * 1000
  if (total === 0 && ms === 0 && !/\d/.test(text)) return null
  return { days: total, ms }
}

/** 开始时间加上时长；全天日程只按天算 */
export function addICalDuration(start: Date, duration: ICalDuration, allDay: boolean): Date {
  const end = new Date(start.getTime())
  end.setDate(end.getDate() + duration.days)
  return allDay ? end : new Date(end.getTime() + duration.ms)
}

/**
 * 读 ORGANIZER / ATTENDEE 这类行里的邮箱。
 * 属性参数里可以带引号包着的地址（SENT-BY、MEMBER 等），那不是本人，所以只看参数之后的值。
 */
export function readCalAddress(line: string): string {
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') inQuotes = !inQuotes
    else if (ch === ':' && !inQuotes) {
      return line.slice(i + 1).trim().replace(/^mailto:/i, '').trim().toLowerCase()
    }
  }
  return ''
}

/**
 * 在逐行展开的 iCalendar 里找主日程所在的行范围（含 BEGIN / END 两行）。
 * 重复日程里单独改过的场次带 RECURRENCE-ID，不是主日程；没有主日程时退回第一个日程。
 */
export function findMasterEventRange(lines: string[]): [number, number] | null {
  const blocks: Array<{ start: number; end: number; override: boolean }> = []
  let start = -1
  let depth = 0
  let override = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (start < 0) {
      if (line.startsWith('BEGIN:VEVENT')) {
        start = i
        depth = 0
        override = false
      }
      continue
    }
    if (line.startsWith('BEGIN:')) {
      depth++
    } else if (line.startsWith('END:VEVENT') && depth === 0) {
      blocks.push({ start, end: i, override })
      start = -1
    } else if (line.startsWith('END:')) {
      depth = Math.max(0, depth - 1)
    } else if (depth === 0 && /^RECURRENCE-ID[;:]/i.test(line)) {
      override = true
    }
  }
  const master = blocks.find(block => !block.override) ?? blocks[0]
  return master ? [master.start, master.end] : null
}

/** REPORT 查询读到的一个资源 */
export interface ReportResource {
  url: string
  etag?: string
  data: string
}

/**
 * 从 REPORT 返回的多状态响应里取出第一个带有目标日历数据的资源。
 * 地址、版本标记、内容必须来自同一条响应；没有地址时返回 null，
 * 绝不退回用日历集合的地址顶替——后面的修改、删除会直接用它。
 */
export function readReportResource(
  xml: string,
  baseUrl: string,
  component: 'VEVENT' | 'VTODO'
): ReportResource | null {
  const responses = xml.matchAll(/<(?:[\w.-]+:)?response(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w.-]+:)?response\s*>/gi)
  for (const response of responses) {
    const body = response[1]
    const dataMatch = /<(?:[\w.-]+:)?calendar-data(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w.-]+:)?calendar-data\s*>/i.exec(body)
    if (!dataMatch) continue

    let data = dataMatch[1].trim()
    if (data.startsWith('<![CDATA[')) {
      data = data.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '')
    } else {
      data = data.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    }
    if (!new RegExp(`BEGIN:${component}`, 'i').test(data)) continue

    const hrefMatch = /<(?:[\w.-]+:)?href(?:\s[^>]*)?>([^<]+)<\/(?:[\w.-]+:)?href\s*>/i.exec(body)
    if (!hrefMatch) return null
    const href = hrefMatch[1].trim()
    let url: string
    try {
      url = /^https?:/i.test(href) ? href : new URL(href, baseUrl).href
    } catch {
      return null
    }

    const etagMatch = /<(?:[\w.-]+:)?getetag(?:\s[^>]*)?>([^<]+)<\/(?:[\w.-]+:)?getetag\s*>/i.exec(body)
    // 保留引号：If-Match 要求带引号的标准写法，去掉后写入会被当成版本不符
    const etag = etagMatch ? etagMatch[1].replace(/&quot;/g, '"').trim() : undefined
    return { url, etag, data }
  }
  return null
}
