import { describe, it, expect } from 'vitest'
import {
  findMismatch,
  organizerIsOther,
  parseUserDateTime,
  readWritePrivilege,
  resolveEnd,
  shiftEnd,
  unverifiedMoments,
  type MismatchLabels
} from '../write-check'
import type { CalendarEvent } from '../types'

const labels: MismatchLabels = {
  moment: (date, allDay) => (allDay ? `D${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}` : date.toISOString()),
  recurrence: rrule => rrule ?? 'none',
  empty: 'none'
}

function event(partial: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    uid: 'u1',
    title: '启动会',
    start: new Date('2026-10-21T06:00:00Z'),
    end: new Date('2026-10-21T09:00:00Z'),
    ...partial
  }
}

describe('findMismatch', () => {
  it('预期全部对上时返回 null，没写进预期的项不核对', () => {
    expect(findMismatch({ allDay: false, title: '启动会' }, event({ location: '随便' }), labels)).toBeNull()
  })

  it('标题对不上，指出是标题', () => {
    const m = findMismatch({ allDay: false, title: '新标题' }, event(), labels)
    expect(m).toMatchObject({ field: 'title', expected: '新标题', actual: '启动会' })
  })

  it('开始时间对不上（服务端仍是旧时间）', () => {
    const m = findMismatch({ allDay: false, start: new Date('2026-10-26T06:30:00Z') }, event(), labels)
    expect(m?.field).toBe('start')
  })

  it('定时日程容忍一分钟内的误差，超过就算对不上', () => {
    const near = new Date('2026-10-21T06:00:30Z')
    const far = new Date('2026-10-21T06:02:00Z')
    expect(findMismatch({ allDay: false, start: near }, event(), labels)).toBeNull()
    expect(findMismatch({ allDay: false, start: far }, event(), labels)?.field).toBe('start')
  })

  it('结束时间也要核对（只改结束时间时不能漏过）', () => {
    const m = findMismatch({ allDay: false, end: new Date('2026-10-21T10:00:00Z') }, event(), labels)
    expect(m?.field).toBe('end')
  })

  it('全天日程按本地日期比，不受时刻与时区影响', () => {
    const stored = event({ allDay: true, start: new Date(2026, 9, 26), end: new Date(2026, 9, 27) })
    // 预期是 26 日的另一个时刻：同一天，算对上
    expect(findMismatch({ allDay: true, start: new Date(2026, 9, 26, 15, 0) }, stored, labels)).toBeNull()
    // 预期是 27 日：不是同一天
    expect(findMismatch({ allDay: true, start: new Date(2026, 9, 27) }, stored, labels)?.field).toBe('start')
  })

  it('地点：清空与「没有」视为相同，不同则指出', () => {
    expect(findMismatch({ allDay: false, location: '' }, event(), labels)).toBeNull()
    expect(findMismatch({ allDay: false, location: '7楼' }, event(), labels)?.field).toBe('location')
  })

  it('描述：忽略空白与换行的差别', () => {
    const stored = event({ description: '第一行\n第二行' })
    expect(findMismatch({ allDay: false, description: '第一行  第二行 ' }, stored, labels)).toBeNull()
    expect(findMismatch({ allDay: false, description: '别的' }, stored, labels)?.field).toBe('description')
  })

  it('回读到的时区认不出来时，不拿估算的时刻判成败，其余项照常核对', () => {
    const stored = event({ timeZoneUnknown: true, title: '启动会' })
    expect(findMismatch({ allDay: false, start: new Date('2026-10-26T06:30:00Z') }, stored, labels)).toBeNull()
    expect(findMismatch({ allDay: false, title: '别的', start: new Date('2026-10-26T06:30:00Z') }, stored, labels)?.field).toBe('title')
  })

  it('全天日程不受时区是否认得出的影响', () => {
    const stored = event({ allDay: true, timeZoneUnknown: true, start: new Date(2026, 9, 26), end: new Date(2026, 9, 27) })
    expect(findMismatch({ allDay: true, start: new Date(2026, 9, 27) }, stored, labels)?.field).toBe('start')
  })

  it('重复规则：参数顺序、写法不同但含义相同算对上', () => {
    const stored = event({ recurrence: 'UNTIL=20270731T235959;FREQ=WEEKLY' })
    expect(findMismatch({ allDay: false, recurrence: 'FREQ=WEEKLY;UNTIL=20270731T235959' }, stored, labels)).toBeNull()
  })

  it('重复规则：预期去掉重复而服务端仍在重复，要指出', () => {
    const stored = event({ recurrence: 'FREQ=WEEKLY' })
    expect(findMismatch({ allDay: false, recurrence: '' }, stored, labels)?.field).toBe('recurrence')
  })

  it('重复规则：截止日期不同要指出', () => {
    const stored = event({ recurrence: 'FREQ=WEEKLY;UNTIL=20270630T235959' })
    expect(findMismatch({ allDay: false, recurrence: 'FREQ=WEEKLY;UNTIL=20270731T235959' }, stored, labels)?.field).toBe('recurrence')
  })
})

describe('organizerIsOther', () => {
  it('发起人就是当前账户（忽略大小写）时不算他人', () => {
    expect(organizerIsOther('Yushen@Gyzq.wecom.work', 'yushen@gyzq.wecom.work')).toBe(false)
  })

  it('发起人是别人', () => {
    expect(organizerIsOther('baijinxin@gyzq.wecom.work', 'yushen@gyzq.wecom.work')).toBe(true)
  })

  it('账户只写了账号时，只比账号部分', () => {
    expect(organizerIsOther('yushen@gyzq.wecom.work', 'yushen')).toBe(false)
    expect(organizerIsOther('baijinxin@gyzq.wecom.work', 'yushen')).toBe(true)
  })

  it('一个名字恰好包含另一个，不算同一人', () => {
    expect(organizerIsOther('ali@x.com', 'li@x.com')).toBe(true)
  })

  it('信息不足时不下判断', () => {
    expect(organizerIsOther(undefined, 'yushen@x.com')).toBe(false)
    expect(organizerIsOther('a@x.com', undefined)).toBe(false)
    expect(organizerIsOther('', '')).toBe(false)
  })
})

describe('readWritePrivilege', () => {
  const wrap = (privileges: string) => `<?xml version="1.0"?>
<D:multistatus xmlns:D="DAV:"><D:response><D:propstat><D:prop>
<D:current-user-privilege-set>${privileges}</D:current-user-privilege-set>
</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>`

  it('列出写权限时判定可写', () => {
    expect(readWritePrivilege(wrap('<D:privilege><D:read/></D:privilege><D:privilege><D:write-content/></D:privilege>'))).toBe('write')
    expect(readWritePrivilege(wrap('<D:privilege><D:all/></D:privilege>'))).toBe('write')
  })

  it('只列出读权限时判定只读', () => {
    expect(readWritePrivilege(wrap('<D:privilege><D:read/></D:privilege>'))).toBe('read-only')
  })

  it('不认名字里碰巧带 write / read 的其它节点', () => {
    expect(readWritePrivilege(wrap('<D:privilege><D:read-acl/></D:privilege><D:privilege><D:write-acl/></D:privilege>'))).toBe('unknown')
  })

  it('服务端不支持这项属性（404 的返回）时判定为未知', () => {
    const unsupported = `<D:multistatus xmlns:D="DAV:"><D:response><D:propstat><D:prop>
<D:current-user-privilege-set/></D:prop><D:status>HTTP/1.1 404 Not Found</D:status></D:propstat></D:response></D:multistatus>`
    expect(readWritePrivilege(unsupported)).toBe('unknown')
    expect(readWritePrivilege('')).toBe('unknown')
  })

  it('不带命名空间前缀的写法也认', () => {
    expect(readWritePrivilege('<privilege><write/></privilege>')).toBe('write')
  })
})

describe('readWritePrivilege 按操作区分', () => {
  const wrap = (privileges: string) =>
    `<D:multistatus xmlns:D="DAV:"><D:response><D:propstat><D:prop><D:current-user-privilege-set>${privileges}</D:current-user-privilege-set></D:prop></D:propstat></D:response></D:multistatus>`
  const only = (...names: string[]) => wrap(names.map(n => `<D:privilege><D:${n}/></D:privilege>`).join(''))

  it('删除需要「移出」权限：只有改内容的权限时说不准，不冤枉成只读，也不断言有权删', () => {
    expect(readWritePrivilege(only('read', 'write-content'), 'delete')).toBe('unknown')
    expect(readWritePrivilege(only('read', 'unbind'), 'delete')).toBe('write')
  })

  it('新建需要「放入」权限；修改需要改内容的权限', () => {
    expect(readWritePrivilege(only('read', 'write-content'), 'create')).toBe('unknown')
    expect(readWritePrivilege(only('read', 'bind'), 'create')).toBe('write')
    expect(readWritePrivilege(only('read', 'bind'), 'update')).toBe('unknown')
    expect(readWritePrivilege(only('read', 'write-content'), 'update')).toBe('write')
  })

  it('总的写权限或全部权限，对哪种操作都算有权', () => {
    expect(readWritePrivilege(only('read', 'write'), 'delete')).toBe('write')
    expect(readWritePrivilege(only('all'), 'create')).toBe('write')
  })

  it('只有读权限时，对哪种操作都是只读', () => {
    expect(readWritePrivilege(only('read'), 'delete')).toBe('read-only')
    expect(readWritePrivilege(only('read'), 'create')).toBe('read-only')
  })
})

describe('unverifiedMoments', () => {
  const when = new Date('2026-10-26T06:30:00Z')

  it('时区认得出时，没有未核对的时刻', () => {
    expect(unverifiedMoments({ allDay: false, start: when, end: when }, event())).toEqual([])
  })

  it('时区认不出时，预期里有的时刻都算未核对', () => {
    const stored = event({ timeZoneUnknown: true })
    expect(unverifiedMoments({ allDay: false, start: when, end: when }, stored)).toEqual(['start', 'end'])
    expect(unverifiedMoments({ allDay: false, start: when }, stored)).toEqual(['start'])
    expect(unverifiedMoments({ allDay: false, title: '只改标题' }, stored)).toEqual([])
  })

  it('全天日程不受影响', () => {
    expect(unverifiedMoments({ allDay: true, start: when }, event({ timeZoneUnknown: true }))).toEqual([])
  })
})

describe('parseUserDateTime', () => {
  it('只写日期时按本机当天零点理解，不是 UTC 零点', () => {
    const d = parseUserDateTime('2026-10-26')
    expect(d).not.toBeNull()
    expect([d!.getFullYear(), d!.getMonth(), d!.getDate(), d!.getHours(), d!.getMinutes()]).toEqual([2026, 9, 26, 0, 0])
  })

  it('全天日程只认文字里写的那一天，带了时刻或偏移也不换算', () => {
    const d = parseUserDateTime('2026-10-27T00:00:00+08:00', true)
    expect([d!.getFullYear(), d!.getMonth(), d!.getDate(), d!.getHours()]).toEqual([2026, 9, 27, 0])
    const e = parseUserDateTime('2026-10-27T23:30:00-08:00', true)
    expect([e!.getMonth(), e!.getDate()]).toEqual([9, 27])
  })

  it('不是文字时无法识别，不抛异常', () => {
    expect(parseUserDateTime(undefined)).toBeNull()
    expect(parseUserDateTime(20261026)).toBeNull()
  })

  it('不存在的日期、乱写的文字无法识别', () => {
    expect(parseUserDateTime('2026-02-30')).toBeNull()
    expect(parseUserDateTime('下周一')).toBeNull()
    expect(parseUserDateTime('')).toBeNull()
  })

  it('带时区偏移的时刻按绝对时刻读', () => {
    expect(parseUserDateTime('2026-10-26T14:30:00+08:00')?.toISOString()).toBe('2026-10-26T06:30:00.000Z')
  })

  it('不带偏移的日期时间按本机时间读', () => {
    const d = parseUserDateTime('2026-10-26T14:30:00')
    expect([d!.getHours(), d!.getMinutes()]).toEqual([14, 30])
  })
})

describe('resolveEnd', () => {
  const start = new Date(2026, 9, 26, 14, 0)

  it('结束晚于开始时原样返回', () => {
    const end = new Date(2026, 9, 26, 15, 0)
    expect(resolveEnd(start, end, false)).toBe(end)
  })

  it('定时日程结束不晚于开始时返回 null', () => {
    expect(resolveEnd(start, start, false)).toBeNull()
    expect(resolveEnd(start, new Date(2026, 9, 26, 13, 0), false)).toBeNull()
  })

  it('全天日程结束不晚于开始时按一天算', () => {
    const day = new Date(2026, 9, 26)
    const resolved = resolveEnd(day, day, true)
    expect([resolved!.getFullYear(), resolved!.getMonth(), resolved!.getDate()]).toEqual([2026, 9, 27])
  })
})

describe('shiftEnd', () => {
  it('定时日程：时长不变', () => {
    const end = shiftEnd(
      new Date('2026-10-21T06:00:00Z'),
      new Date('2026-10-21T09:00:00Z'),
      new Date('2026-10-26T06:30:00Z'),
      false
    )
    expect(end.toISOString()).toBe('2026-10-26T09:30:00.000Z')
  })

  it('全天日程：天数不变，跨月也对', () => {
    const end = shiftEnd(new Date(2026, 9, 21), new Date(2026, 9, 24), new Date(2026, 9, 30), true)
    expect([end.getMonth(), end.getDate()]).toEqual([10, 2])
  })

  it('全天日程：原来结束日期异常时至少算一天', () => {
    const end = shiftEnd(new Date(2026, 9, 21), new Date(2026, 9, 21), new Date(2026, 9, 26), true)
    expect([end.getMonth(), end.getDate()]).toEqual([9, 27])
  })
})
