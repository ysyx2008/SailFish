import { describe, it, expect } from 'vitest'
import {
  addICalDuration,
  findMasterEventRange,
  parseICalDuration,
  readCalAddress,
  readReportResource,
  zonedToUtc
} from '../ical-util'

describe('zonedToUtc', () => {
  it('固定偏移的时区：上海 14:30 是 06:30Z', () => {
    expect(zonedToUtc(2026, 10, 26, 14, 30, 0, 'Asia/Shanghai')?.toISOString()).toBe('2026-10-26T06:30:00.000Z')
  })

  it('夏令时：柏林 10 月 20 日仍是夏令时（+2），10 月 26 日已回到冬令时（+1）', () => {
    expect(zonedToUtc(2026, 10, 20, 10, 0, 0, 'Europe/Berlin')?.toISOString()).toBe('2026-10-20T08:00:00.000Z')
    expect(zonedToUtc(2026, 10, 26, 10, 0, 0, 'Europe/Berlin')?.toISOString()).toBe('2026-10-26T09:00:00.000Z')
  })

  it('美东 7 月是夏令时（-4），不是固定的 -5', () => {
    expect(zonedToUtc(2026, 7, 1, 9, 0, 0, 'America/New_York')?.toISOString()).toBe('2026-07-01T13:00:00.000Z')
    expect(zonedToUtc(2026, 1, 15, 9, 0, 0, 'America/New_York')?.toISOString()).toBe('2026-01-15T14:00:00.000Z')
  })

  it('跨日换算正确', () => {
    expect(zonedToUtc(2026, 10, 26, 1, 0, 0, 'Asia/Shanghai')?.toISOString()).toBe('2026-10-25T17:00:00.000Z')
  })

  it('不是标准时区名（如企业微信的 TZ08）时返回 null', () => {
    expect(zonedToUtc(2026, 10, 26, 14, 30, 0, 'TZ08')).toBeNull()
    expect(zonedToUtc(2026, 10, 26, 14, 30, 0, 'Custom/Nowhere')).toBeNull()
  })
})

describe('parseICalDuration', () => {
  it('读时分秒', () => {
    expect(parseICalDuration('PT1H30M')).toEqual({ days: 0, ms: 90 * 60 * 1000 })
    expect(parseICalDuration('PT45S')).toEqual({ days: 0, ms: 45 * 1000 })
  })

  it('读天与周', () => {
    expect(parseICalDuration('P1D')).toEqual({ days: 1, ms: 0 })
    expect(parseICalDuration('P2W')).toEqual({ days: 14, ms: 0 })
    expect(parseICalDuration('P1DT2H')).toEqual({ days: 1, ms: 2 * 3600 * 1000 })
  })

  it('不合规或为负时返回 null', () => {
    expect(parseICalDuration('')).toBeNull()
    expect(parseICalDuration('P')).toBeNull()
    expect(parseICalDuration('-PT1H')).toBeNull()
    expect(parseICalDuration('一小时')).toBeNull()
  })
})

describe('addICalDuration', () => {
  it('定时日程按毫秒加', () => {
    const end = addICalDuration(new Date('2026-10-21T06:00:00Z'), { days: 0, ms: 3 * 3600 * 1000 }, false)
    expect(end.toISOString()).toBe('2026-10-21T09:00:00.000Z')
  })

  it('全天日程只按天加', () => {
    const end = addICalDuration(new Date(2026, 9, 21), { days: 2, ms: 5000 }, true)
    expect([end.getMonth(), end.getDate(), end.getHours()]).toEqual([9, 23, 0])
  })
})

describe('readCalAddress', () => {
  it('取参数之后的邮箱，转小写', () => {
    expect(readCalAddress('ORGANIZER;CN=柏金鑫:mailto:BaiJinXin@gyzq.wecom.work')).toBe('baijinxin@gyzq.wecom.work')
  })

  it('参数里引号包着的代理人地址不算发起人本人', () => {
    expect(readCalAddress('ORGANIZER;SENT-BY="mailto:assistant@x.com":mailto:boss@x.com')).toBe('boss@x.com')
    expect(readCalAddress('ATTENDEE;MEMBER="mailto:group@x.com":mailto:user@x.com')).toBe('user@x.com')
  })

  it('没有 mailto 前缀也能读', () => {
    expect(readCalAddress('ATTENDEE:user@x.com')).toBe('user@x.com')
  })

  it('没有值时返回空', () => {
    expect(readCalAddress('ORGANIZER')).toBe('')
  })
})

describe('findMasterEventRange', () => {
  const lines = (text: string) => text.trim().split('\n')

  it('单个日程：返回它的起止行', () => {
    const l = lines(`BEGIN:VCALENDAR
BEGIN:VEVENT
UID:a
END:VEVENT
END:VCALENDAR`)
    expect(findMasterEventRange(l)).toEqual([1, 3])
  })

  it('单独改过的场次排在前面时，仍选主日程', () => {
    const l = lines(`BEGIN:VCALENDAR
BEGIN:VEVENT
UID:a
RECURRENCE-ID:20261028T060000Z
END:VEVENT
BEGIN:VEVENT
UID:a
RRULE:FREQ=WEEKLY
END:VEVENT
END:VCALENDAR`)
    expect(findMasterEventRange(l)).toEqual([5, 8])
  })

  it('只有单独改过的场次时，退回第一个', () => {
    const l = lines(`BEGIN:VEVENT
RECURRENCE-ID:20261028T060000Z
END:VEVENT`)
    expect(findMasterEventRange(l)).toEqual([0, 2])
  })

  it('提醒子块的结束行不会被当成日程结束', () => {
    const l = lines(`BEGIN:VEVENT
UID:a
BEGIN:VALARM
ACTION:DISPLAY
END:VALARM
SUMMARY:x
END:VEVENT`)
    expect(findMasterEventRange(l)).toEqual([0, 6])
  })

  it('没有日程时返回 null', () => {
    expect(findMasterEventRange(lines('BEGIN:VCALENDAR\nEND:VCALENDAR'))).toBeNull()
  })
})

describe('readReportResource', () => {
  const BASE = 'https://cal.example.com/dav/user/cal/'
  const data = (uid: string, component = 'VEVENT') =>
    `BEGIN:VCALENDAR\nBEGIN:${component}\nUID:${uid}\nEND:${component}\nEND:VCALENDAR`
  const response = (href: string | null, etag: string | null, body: string, wrap = true) =>
    `<D:response>${href ? `<D:href>${href}</D:href>` : ''}<D:propstat><D:prop>`
    + `${etag ? `<D:getetag>${etag}</D:getetag>` : ''}`
    + `<C:calendar-data>${wrap ? body.replace(/</g, '&lt;').replace(/>/g, '&gt;') : body}</C:calendar-data>`
    + `</D:prop></D:propstat></D:response>`
  const wrapAll = (...parts: string[]) =>
    `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">${parts.join('')}</D:multistatus>`

  it('取出地址、版本标记（保留引号）与内容', () => {
    const xml = wrapAll(response('/dav/user/cal/a.ics', '&quot;v7&quot;', data('a')))
    const found = readReportResource(xml, BASE, 'VEVENT')

    expect(found?.url).toBe('https://cal.example.com/dav/user/cal/a.ics')
    expect(found?.etag).toBe('"v7"')
    expect(found?.data).toContain('UID:a')
  })

  it('地址、版本标记、内容取自同一条响应：前一条没有日历内容时不串用它的地址', () => {
    const xml = wrapAll(
      '<D:response><D:href>/dav/user/cal/</D:href><D:propstat><D:status>HTTP/1.1 404 Not Found</D:status></D:propstat></D:response>',
      response('/dav/user/cal/b.ics', '"b1"', data('b'))
    )
    const found = readReportResource(xml, BASE, 'VEVENT')

    expect(found?.url).toBe('https://cal.example.com/dav/user/cal/b.ics')
    expect(found?.etag).toBe('"b1"')
  })

  it('响应里带日历内容却没有地址：返回 null，不用日历集合的地址顶替', () => {
    expect(readReportResource(wrapAll(response(null, '"v1"', data('a'))), BASE, 'VEVENT')).toBeNull()
  })

  it('要的是待办时，只有日程内容的响应不算', () => {
    const xml = wrapAll(response('/dav/user/cal/a.ics', '"v1"', data('a')))

    expect(readReportResource(xml, BASE, 'VTODO')).toBeNull()
    expect(readReportResource(wrapAll(response('/dav/user/cal/t.ics', '"t1"', data('t', 'VTODO'))), BASE, 'VTODO')?.url)
      .toBe('https://cal.example.com/dav/user/cal/t.ics')
  })

  it('用 CDATA 包着的内容原样取出，不当成转义文字再解一遍', () => {
    const body = data('a').replace('UID:a', 'UID:a\nDESCRIPTION:A &amp; B')
    const xml = wrapAll(response('/dav/user/cal/a.ics', '"v1"', `<![CDATA[${body}]]>`, false))

    expect(readReportResource(xml, BASE, 'VEVENT')?.data).toContain('DESCRIPTION:A &amp; B')
  })

  it('没有任何响应时返回 null', () => {
    expect(readReportResource(wrapAll(), BASE, 'VEVENT')).toBeNull()
  })
})
