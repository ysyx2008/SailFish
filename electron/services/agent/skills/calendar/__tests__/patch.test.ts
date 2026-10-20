import { describe, it, expect } from 'vitest'
import { patchICalEvent, parseICalEvent, foldICalLine, buildICalEvent } from '../executor'

// 他人发起的会议邀请：含 ORGANIZER、ATTENDEE、SEQUENCE
const INVITED_ICS = `BEGIN:VCALENDAR\r
VERSION:2.0\r
PRODID:-//WeCom//Calendar//CN\r
BEGIN:VEVENT\r
UID:5fe52c86dd3d2243ef46d9a6b22f527cevjqrmoi\r
DTSTAMP:20261015T080000Z\r
DTSTART:20261021T060000Z\r
DTEND:20261021T090000Z\r
SUMMARY:AI点金APP项目启动会\r
ORGANIZER;CN=柏金鑫:mailto:baijinxin@gyzq.wecom.work\r
ATTENDEE;CN=于申:mailto:yushen@gyzq.wecom.work\r
ATTENDEE;CN=张三:mailto:zhangsan@gyzq.wecom.work\r
SEQUENCE:0\r
END:VEVENT\r
END:VCALENDAR`

describe('patchICalEvent', () => {
  it('改时间时保留组织者与参会人，并递增 SEQUENCE', () => {
    const patched = patchICalEvent(INVITED_ICS, {
      start: new Date('2026-10-26T14:30:00+08:00'),
      end: new Date('2026-10-26T17:30:00+08:00')
    })

    expect(patched).toContain('ORGANIZER;CN=柏金鑫:mailto:baijinxin@gyzq.wecom.work')
    expect(patched).toContain('ATTENDEE;CN=于申:mailto:yushen@gyzq.wecom.work')
    expect(patched).toContain('ATTENDEE;CN=张三:mailto:zhangsan@gyzq.wecom.work')
    expect(patched).toContain('SEQUENCE:1')
    // 14:30 +08:00 => 06:30Z，定时事件一律用 UTC 带 Z，避免浮动时间漂移
    expect(patched).toContain('DTSTART:20261026T063000Z')
    expect(patched).toContain('DTEND:20261026T093000Z')
  })

  it('改标题并清空描述时删掉 DESCRIPTION 行', () => {
    const withDesc = INVITED_ICS.replace(
      'SUMMARY:AI点金APP项目启动会\r',
      'SUMMARY:AI点金APP项目启动会\r\nDESCRIPTION:原描述\r'
    )
    const patched = patchICalEvent(withDesc, { title: '新标题', description: '' })

    expect(patched).toContain('SUMMARY:新标题')
    expect(patched).not.toContain('DESCRIPTION')
    expect(patched).toContain('ORGANIZER')
  })

  it('原事件没有的字段补在 END:VEVENT 之前', () => {
    const patched = patchICalEvent(INVITED_ICS, { location: '7楼8号会议室' })
    const locationIdx = patched.indexOf('LOCATION:7楼8号会议室')
    const endIdx = patched.indexOf('END:VEVENT')

    expect(locationIdx).toBeGreaterThan(-1)
    expect(locationIdx).toBeLessThan(endIdx)
  })

  it('全天事件用本地日期，不做 UTC 换算', () => {
    const patched = patchICalEvent(INVITED_ICS, {
      allDay: true,
      start: new Date(2026, 9, 22),
      end: new Date(2026, 9, 23)
    })

    expect(patched).toContain('DTSTART;VALUE=DATE:20261022')
    expect(patched).toContain('DTEND;VALUE=DATE:20261023')
  })

  it('没有 SEQUENCE 时补 1，并刷新 DTSTAMP', () => {
    const noSeq = INVITED_ICS.replace('SEQUENCE:0\r\n', '')
    const patched = patchICalEvent(noSeq, { title: '改个名' })

    expect(patched).toContain('SEQUENCE:1')
    expect(patched).not.toContain('DTSTAMP:20261015T080000Z')
  })
})

describe('parseICalEvent 解析组织者与参会人', () => {
  it('取出 ORGANIZER 与 ATTENDEE 的邮箱', () => {
    const parsed = parseICalEvent(INVITED_ICS)

    expect(parsed).not.toBeNull()
    expect(parsed?.organizer).toBe('baijinxin@gyzq.wecom.work')
    expect(parsed?.attendees).toEqual(['yushen@gyzq.wecom.work', 'zhangsan@gyzq.wecom.work'])
  })
})

describe('foldICalLine', () => {
  it('超长行按 75 字节折叠，续行以空格开头', () => {
    const folded = foldICalLine(`DESCRIPTION:${'a'.repeat(200)}`)
    const lines = folded.split('\r\n')

    expect(lines.length).toBeGreaterThan(1)
    for (const line of lines) {
      expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75)
    }
    expect(lines.slice(1).every(line => line.startsWith(' '))).toBe(true)
  })
})

describe('buildICalEvent 时区', () => {
  it('定时事件的 DTSTART/DTEND 写成 UTC 带 Z', () => {
    const ics = buildICalEvent({
      uid: 'u1@sfterminal',
      title: '测试会',
      start: new Date('2026-10-22T09:00:00+08:00'),
      end: new Date('2026-10-22T11:00:00+08:00'),
      allDay: false
    })

    expect(ics).toContain('DTSTART:20261022T010000Z')
    expect(ics).toContain('DTEND:20261022T030000Z')
    expect(ics).toContain('DTSTAMP:')
  })
})

// 带提醒（VALARM）的日程：提醒里也有 DESCRIPTION，但那不是日程的描述
const ALARM_ICS = `BEGIN:VCALENDAR\r
VERSION:2.0\r
BEGIN:VEVENT\r
UID:alarm-1@sfterminal\r
DTSTAMP:20261015T080000Z\r
DTSTART:20261021T060000Z\r
DTEND:20261021T090000Z\r
SUMMARY:带提醒的会\r
BEGIN:VALARM\r
TRIGGER:-PT15M\r
ACTION:DISPLAY\r
DESCRIPTION:Reminder\r
END:VALARM\r
END:VEVENT\r
END:VCALENDAR\r
`

// 重复日程：主日程之外还有一场单独改过的
const SERIES_ICS = `BEGIN:VCALENDAR\r
VERSION:2.0\r
BEGIN:VEVENT\r
UID:series-1\r
DTSTAMP:20261015T080000Z\r
DTSTART:20261021T060000Z\r
DTEND:20261021T090000Z\r
SUMMARY:每周例会\r
RRULE:FREQ=WEEKLY\r
SEQUENCE:2\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:series-1\r
RECURRENCE-ID:20261028T060000Z\r
DTSTAMP:20261015T080000Z\r
DTSTART:20261028T070000Z\r
DTEND:20261028T100000Z\r
SUMMARY:每周例会（本周挪后一小时）\r
SEQUENCE:5\r
END:VEVENT\r
END:VCALENDAR\r
`

describe('patchICalEvent 只动传入的项', () => {
  it('只改标题时，开始、结束时间原样不动（包括带时区的写法）', () => {
    const zoned = INVITED_ICS
      .replace('DTSTART:20261021T060000Z', 'DTSTART;TZID=Asia/Shanghai:20261021T140000')
      .replace('DTEND:20261021T090000Z', 'DTEND;TZID=Asia/Shanghai:20261021T170000')
    const patched = patchICalEvent(zoned, { title: '改个名' })

    expect(patched).toContain('DTSTART;TZID=Asia/Shanghai:20261021T140000')
    expect(patched).toContain('DTEND;TZID=Asia/Shanghai:20261021T170000')
    expect(patched).toContain('SUMMARY:改个名')
  })

  it('写入结束时间时去掉原来的时长，两者不能并存', () => {
    const withDuration = INVITED_ICS
      .replace('DTEND:20261021T090000Z\r\n', 'DURATION:PT3H\r\n')
    const patched = patchICalEvent(withDuration, { end: new Date('2026-10-21T10:00:00Z') })

    expect(patched).not.toContain('DURATION')
    expect(patched).toContain('DTEND:20261021T100000Z')
  })

  it('同名属性重复出现时只写一处', () => {
    const twice = INVITED_ICS.replace('SEQUENCE:0\r\n', 'LOCATION:甲\r\nLOCATION:乙\r\nSEQUENCE:0\r\n')
    const patched = patchICalEvent(twice, { location: '丙' })

    expect(patched.match(/LOCATION:/g)).toHaveLength(1)
    expect(patched).toContain('LOCATION:丙')
  })

  it('只改重复规则也递增 SEQUENCE', () => {
    const patched = patchICalEvent(SERIES_ICS, { rrule: 'FREQ=WEEKLY;COUNT=10' })

    expect(patched).toContain('RRULE:FREQ=WEEKLY;COUNT=10')
    expect(patched).not.toContain('RRULE:FREQ=WEEKLY\r\n')
    expect(patched).toContain('SEQUENCE:3')
  })

  it('每行以回车换行结尾，整份以换行收尾', () => {
    const patched = patchICalEvent(INVITED_ICS, { title: 'x' })

    expect(patched.endsWith('END:VCALENDAR\r\n')).toBe(true)
    expect(patched.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/)
  })
})

describe('patchICalEvent 提醒与重复日程', () => {
  it('改描述不会动到提醒里的说明文字', () => {
    const patched = patchICalEvent(ALARM_ICS, { description: '议程：评审' })
    const alarm = patched.slice(patched.indexOf('BEGIN:VALARM'), patched.indexOf('END:VALARM'))

    expect(alarm).toContain('DESCRIPTION:Reminder')
    expect(patched).toContain('DESCRIPTION:议程：评审')
    expect(patched.match(/DESCRIPTION:/g)).toHaveLength(2)
  })

  it('清空描述不会把提醒的说明文字删掉', () => {
    const patched = patchICalEvent(ALARM_ICS, { description: '' })

    expect(patched).toContain('DESCRIPTION:Reminder')
    expect(patched).toContain('BEGIN:VALARM')
  })

  it('重复日程只改第一个日程，单独改过的那一场原样不动', () => {
    const patched = patchICalEvent(SERIES_ICS, {
      title: '每周例会（新名）',
      start: new Date('2026-10-21T07:00:00Z'),
      end: new Date('2026-10-21T10:00:00Z')
    })

    expect(patched).toContain('SUMMARY:每周例会（新名）')
    expect(patched).toContain('SUMMARY:每周例会（本周挪后一小时）')
    expect(patched).toContain('RECURRENCE-ID:20261028T060000Z')
    expect(patched).toContain('DTSTART:20261028T070000Z')
    // 第一个日程递增，单独改过的那一场保持原来的版本号
    expect(patched).toContain('SEQUENCE:3')
    expect(patched).toContain('SEQUENCE:5')
  })

  it('没有 SEQUENCE 与 DTSTAMP 时补在第一个日程里', () => {
    const bare = SERIES_ICS
      .replace('SEQUENCE:2\r\n', '')
      .replace('DTSTAMP:20261015T080000Z\r\nDTSTART:20261021T060000Z', 'DTSTART:20261021T060000Z')
    const patched = patchICalEvent(bare, { title: 'x' })
    const firstEvent = patched.slice(patched.indexOf('BEGIN:VEVENT'), patched.indexOf('END:VEVENT'))

    expect(firstEvent).toContain('SEQUENCE:1')
    expect(firstEvent).toContain('DTSTAMP:')
  })
})

describe('parseICalEvent 不把提醒的说明当成日程的描述', () => {
  it('没有写描述的日程，描述为空', () => {
    const parsed = parseICalEvent(ALARM_ICS)

    expect(parsed?.title).toBe('带提醒的会')
    expect(parsed?.description).toBeUndefined()
    expect(parsed?.alarmBlock).toContain('BEGIN:VALARM')
  })
})

describe('buildICalEvent 折行与换行', () => {
  it('长描述、长地点折到 75 字节以内，整份用回车换行', () => {
    const ics = buildICalEvent({
      uid: 'long@sfterminal',
      title: '长内容',
      start: new Date('2026-10-22T09:00:00+08:00'),
      end: new Date('2026-10-22T11:00:00+08:00'),
      allDay: false,
      location: '北京市朝阳区某某路某某大厦'.repeat(6),
      description: '会议材料说明'.repeat(30)
    })

    for (const line of ics.split('\r\n')) {
      expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75)
    }
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true)
    // 折叠后读回来，内容完整
    const parsed = parseICalEvent(ics)
    expect(parsed?.description).toBe('会议材料说明'.repeat(30))
    expect(parsed?.location).toBe('北京市朝阳区某某路某某大厦'.repeat(6))
  })
})

describe('parseICalEvent 时区与时长', () => {
  const withZone = (dtstart: string, dtend: string) => INVITED_ICS
    .replace('DTSTART:20261021T060000Z', dtstart)
    .replace('DTEND:20261021T090000Z', dtend)

  it('认标准时区名：柏林冬令时 07:30 就是 06:30Z', () => {
    const parsed = parseICalEvent(withZone(
      'DTSTART;TZID=Europe/Berlin:20261026T073000',
      'DTEND;TZID=Europe/Berlin:20261026T103000'
    ))

    expect(parsed?.start.toISOString()).toBe('2026-10-26T06:30:00.000Z')
    expect(parsed?.end.toISOString()).toBe('2026-10-26T09:30:00.000Z')
    expect(parsed?.timeZoneUnknown).toBeUndefined()
  })

  it('时区名带引号也认', () => {
    const parsed = parseICalEvent(withZone(
      'DTSTART;TZID="Asia/Shanghai":20261026T143000',
      'DTEND;TZID="Asia/Shanghai":20261026T173000'
    ))

    expect(parsed?.start.toISOString()).toBe('2026-10-26T06:30:00.000Z')
  })

  it('企业微信的 TZ08 写法照旧认', () => {
    const parsed = parseICalEvent(withZone(
      'DTSTART;TZID=TZ08:20261026T143000',
      'DTEND;TZID=TZ08:20261026T173000'
    ))

    expect(parsed?.start.toISOString()).toBe('2026-10-26T06:30:00.000Z')
    expect(parsed?.timeZoneUnknown).toBeUndefined()
  })

  it('认不出的时区：如实标明时刻不可信', () => {
    const parsed = parseICalEvent(withZone(
      'DTSTART;TZID=Custom/Nowhere:20261026T143000',
      'DTEND;TZID=Custom/Nowhere:20261026T173000'
    ))

    expect(parsed?.timeZoneUnknown).toBe(true)
  })

  it('没有结束时间、用时长表示的日程：结束 = 开始 + 时长', () => {
    const parsed = parseICalEvent(INVITED_ICS.replace('DTEND:20261021T090000Z', 'DURATION:PT3H'))

    expect(parsed?.end.toISOString()).toBe('2026-10-21T09:00:00.000Z')
  })

  it('全天日程没有结束日期：按一天算', () => {
    const parsed = parseICalEvent(INVITED_ICS
      .replace('DTSTART:20261021T060000Z', 'DTSTART;VALUE=DATE:20261021')
      .replace('DTEND:20261021T090000Z\r\n', ''))

    expect([parsed?.end.getMonth(), parsed?.end.getDate()]).toEqual([9, 22])
  })
})

describe('parseICalEvent 主日程与文字转义', () => {
  it('单独改过的场次排在前面时，读的是主日程', () => {
    const overrideFirst = `BEGIN:VCALENDAR\r
BEGIN:VEVENT\r
UID:series-1\r
RECURRENCE-ID:20261028T060000Z\r
DTSTART:20261028T070000Z\r
DTEND:20261028T100000Z\r
SUMMARY:改过的一场\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:series-1\r
DTSTART:20261021T060000Z\r
DTEND:20261021T090000Z\r
SUMMARY:每周例会\r
RRULE:FREQ=WEEKLY\r
END:VEVENT\r
END:VCALENDAR\r
`
    const parsed = parseICalEvent(overrideFirst)

    expect(parsed?.title).toBe('每周例会')
    expect(parsed?.recurrence).toBe('FREQ=WEEKLY')
  })

  it('改重复日程时改的是主日程，不是排在前面的单独场次', () => {
    const overrideFirst = SERIES_ICS.split('BEGIN:VEVENT\r\n').filter(Boolean)
    // 把两个日程调换顺序：单独改过的场次放前面
    const swapped = `${overrideFirst[0]}BEGIN:VEVENT\r\n${overrideFirst[2].replace('END:VCALENDAR\r\n', '')}BEGIN:VEVENT\r\n${overrideFirst[1]}END:VCALENDAR\r\n`
    const patched = patchICalEvent(swapped, { title: '每周例会（新名）' })

    expect(patched).toContain('SUMMARY:每周例会（新名）')
    expect(patched).toContain('SUMMARY:每周例会（本周挪后一小时）')
  })

  it('发起人行里带代理人地址时，发起人取本人', () => {
    const parsed = parseICalEvent(INVITED_ICS.replace(
      `ORGANIZER;CN=柏金鑫:mailto:baijinxin@gyzq.wecom.work`,
      'ORGANIZER;SENT-BY="mailto:assistant@gyzq.wecom.work":mailto:baijinxin@gyzq.wecom.work'
    ))

    expect(parsed?.organizer).toBe('baijinxin@gyzq.wecom.work')
  })

  it('描述里的「反斜杠 + n」（如 C:\\new）写进去再读回来不变，不被当成换行', () => {
    const description = '路径 C:\\new 与 a;b,c'
    const patched = patchICalEvent(INVITED_ICS, { description })
    const parsed = parseICalEvent(patched)

    expect(parsed?.description).toBe(description)
  })

  it('真正的换行仍然读成换行', () => {
    const patched = patchICalEvent(INVITED_ICS, { description: '第一行\n第二行' })

    expect(parseICalEvent(patched)?.description).toBe('第一行\n第二行')
  })
})
