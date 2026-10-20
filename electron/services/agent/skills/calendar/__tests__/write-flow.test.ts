/**
 * 写入链路的端到端测试：本地起一个假的 CalDAV 服务端，配真实的 tsdav 与真实的 fetch，
 * 整条路径从工具入口走到服务端再读回来。
 *
 * 单测只能证明「在我理解的模型下实现是对的」；这里模拟的是线上真出过的情形——
 * 服务端回了成功却什么都没改、删了日程还在、拒绝写入且说不清原因。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCalendarObject, deleteCalendarObject, updateCalendarObject } from 'tsdav'
import type { DAVClient } from 'tsdav'

vi.mock('../../../../credential.service', () => ({
  getCalendarCredential: vi.fn(async () => 'secret')
}))

import { executeCalendarTool, verifyTiming } from '../executor'
import { closeAllSessions, createSession } from '../session'
import type { AgentConfig, ToolResult } from '../../../types'
import type { ToolExecutorConfig } from '../../../tool-executor'

type WriteMode = 'apply' | 'ignore' | 'forbid' | 'conflict'

interface RecordedRequest {
  method: string
  path: string
  headers: http.IncomingHttpHeaders
  body: string
}

/** 假的 CalDAV 服务端：行为由测试摆布 */
class FakeCalDav {
  files = new Map<string, string>()
  versions = new Map<string, number>()
  putMode: WriteMode = 'apply'
  deleteMode: WriteMode = 'apply'
  /** 单独指定「回成功但不删」的资源 */
  deleteIgnored = new Set<string>()
  privilege: 'write' | 'read' | 'unsupported' = 'unsupported'
  /** 删除请求到过之后，读取一律出错——模拟「删了但回读时服务端抽风」 */
  failGetAfterDelete = false
  /** 删除请求到过之后，读取回 200 但内容是网页（登录页、网关提示页） */
  htmlGetAfterDelete = false
  /** REPORT 的回答：空 / 带地址的资源 / 缺地址的资源 */
  reportMode: 'empty' | 'files' | 'no-href' = 'empty'
  /** 服务端存下来之前对内容做的加工（改时区写法、丢字段等） */
  storeTransform: ((body: string) => string) | null = null
  requests: RecordedRequest[] = []
  baseUrl = ''

  private server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk as Buffer))
    req.on('end', () => this.handle(req, res, Buffer.concat(chunks).toString('utf8')))
  })

  get calendarUrl(): string {
    return `${this.baseUrl}/cal/`
  }

  async start(): Promise<void> {
    await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve))
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
  }

  async stop(): Promise<void> {
    await new Promise<void>(resolve => this.server.close(() => resolve()))
  }

  reset(): void {
    this.files.clear()
    this.versions.clear()
    this.putMode = 'apply'
    this.deleteMode = 'apply'
    this.deleteIgnored.clear()
    this.privilege = 'unsupported'
    this.failGetAfterDelete = false
    this.htmlGetAfterDelete = false
    this.reportMode = 'empty'
    this.storeTransform = null
    this.requests = []
  }

  seed(name: string, ics: string): string {
    const path = `/cal/${name}.ics`
    this.files.set(path, ics)
    this.versions.set(path, 1)
    return path
  }

  stored(name: string): string | undefined {
    return this.files.get(`/cal/${name}.ics`)
  }

  requestsOf(method: string): RecordedRequest[] {
    return this.requests.filter(r => r.method === method)
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse, body: string): void {
    const path = new URL(req.url || '/', 'http://x').pathname
    const method = req.method || 'GET'
    this.requests.push({ method, path, headers: req.headers, body })
    const send = (status: number, text = '', headers: Record<string, string> = {}) => {
      res.writeHead(status, headers)
      res.end(text)
    }
    const etagOf = (p: string) => `"v${this.versions.get(p) ?? 0}"`

    if (method === 'GET') {
      const deleted = this.requests.some(r => r.method === 'DELETE')
      if (this.failGetAfterDelete && deleted) return send(500)
      if (this.htmlGetAfterDelete && deleted) return send(200, '<html><body>请登录</body></html>', { 'content-type': 'text/html' })
      const file = this.files.get(path)
      if (!file) return send(404)
      return send(200, file, { 'content-type': 'text/calendar', etag: etagOf(path) })
    }

    if (method === 'PUT') {
      const exists = this.files.has(path)
      if (req.headers['if-none-match'] === '*' && exists) return send(412)
      const ifMatch = req.headers['if-match']
      if (ifMatch && ifMatch !== etagOf(path)) return send(412)
      if (this.putMode === 'forbid') return send(403)
      if (this.putMode === 'conflict') return send(412)
      if (this.putMode === 'apply') {
        this.files.set(path, this.storeTransform ? this.storeTransform(body) : body)
        this.versions.set(path, (this.versions.get(path) ?? 0) + 1)
      }
      return send(exists ? 204 : 201)
    }

    if (method === 'DELETE') {
      if (this.deleteMode === 'forbid') return send(403)
      if (this.deleteMode === 'conflict') return send(412)
      if (this.deleteMode === 'apply' && !this.deleteIgnored.has(path)) {
        this.files.delete(path)
      }
      return send(204)
    }

    if (method === 'PROPFIND') {
      const privileges = this.privilege === 'write'
        ? '<D:privilege><D:read/></D:privilege><D:privilege><D:write-content/></D:privilege>'
        : '<D:privilege><D:read/></D:privilege>'
      const text = this.privilege === 'unsupported'
        ? '<D:multistatus xmlns:D="DAV:"><D:response><D:propstat><D:prop><D:current-user-privilege-set/></D:prop><D:status>HTTP/1.1 404 Not Found</D:status></D:propstat></D:response></D:multistatus>'
        : `<D:multistatus xmlns:D="DAV:"><D:response><D:propstat><D:prop><D:current-user-privilege-set>${privileges}</D:current-user-privilege-set></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>`
      return send(207, text, { 'content-type': 'application/xml' })
    }

    if (method === 'REPORT') {
      const uid = /<C:text-match[^>]*>([^<]+)<\/C:text-match>/.exec(body)?.[1] ?? ''
      const responses = this.reportMode === 'empty' ? [] : [...this.files.entries()]
        .filter(([, text]) => uid && text.includes(`UID:${uid}`))
        .map(([filePath, text]) => {
          const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          const href = this.reportMode === 'no-href' ? '' : `<D:href>${filePath}</D:href>`
          return `<D:response>${href}<D:propstat><D:prop><D:getetag>${etagOf(filePath).replace(/"/g, '&quot;')}</D:getetag><C:calendar-data>${escaped}</C:calendar-data></D:prop></D:propstat></D:response>`
        })
      const xml = `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">${responses.join('')}</D:multistatus>`
      return send(207, xml, { 'content-type': 'application/xml' })
    }

    return send(405)
  }
}

const ORGANIZER = 'baijinxin@gyzq.wecom.work'
const ME = 'yushen@gyzq.wecom.work'
const UID = '5fe52c86dd3d2243ef46d9a6b22f527cevjqrmoi'

/** 别人发起的会议：编号无 @sfterminal 后缀，带发起人、参会人 */
const INVITED_ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  `UID:${UID}`,
  'DTSTAMP:20261015T080000Z',
  'DTSTART:20261021T060000Z',
  'DTEND:20261021T090000Z',
  'SUMMARY:AI点金APP项目启动会',
  `ORGANIZER;CN=柏金鑫:mailto:${ORGANIZER}`,
  `ATTENDEE;CN=于申:mailto:${ME}`,
  'SEQUENCE:0',
  'END:VEVENT',
  'END:VCALENDAR',
  ''
].join('\r\n')

const server = new FakeCalDav()
const executor = {
  addStep: vi.fn(),
  waitForConfirmation: vi.fn(async () => true)
} as unknown as ToolExecutorConfig
const config = { executionMode: 'free' } as unknown as AgentConfig

function openSession(): void {
  const auth = { Authorization: `Basic ${Buffer.from(`${ME}:secret`).toString('base64')}` }
  // 真实的 tsdav 写入函数，只是把认证头带上；不改它「不校验状态码」的原样
  const client = {
    createCalendarObject: (p: Parameters<typeof createCalendarObject>[0]) => createCalendarObject({ ...p, headers: auth }),
    updateCalendarObject: (p: Parameters<typeof updateCalendarObject>[0]) => updateCalendarObject({ ...p, headers: auth }),
    deleteCalendarObject: (p: Parameters<typeof deleteCalendarObject>[0]) => deleteCalendarObject({ ...p, headers: auth })
  } as unknown as DAVClient
  createSession('acc-1', '企业微信', ME, client, [], [])
}

function run(tool: string, args: Record<string, unknown>): Promise<ToolResult> {
  return executeCalendarTool(tool, 'pty-1', { calendar_id: server.calendarUrl, ...args }, 'tc-1', config, executor)
}

beforeAll(async () => {
  verifyTiming.retryDelayMs = 5
  await server.start()
})

afterAll(async () => {
  await server.stop()
})

beforeEach(() => {
  server.reset()
  openSession()
})

afterEach(async () => {
  await closeAllSessions()
})

describe('修改日程', () => {
  it('服务端正常应用时报成功，且发起人、参会人原样保留、版本号递增', async () => {
    server.seed(UID, INVITED_ICS)

    const result = await run('calendar_update', {
      event_id: UID,
      start: '2026-10-26T14:30:00+08:00',
      end: '2026-10-26T17:30:00+08:00'
    })

    expect(result.success).toBe(true)
    const stored = server.stored(UID)!
    expect(stored).toContain(`ORGANIZER;CN=柏金鑫:mailto:${ORGANIZER}`)
    expect(stored).toContain(`ATTENDEE;CN=于申:mailto:${ME}`)
    expect(stored).toContain('DTSTART:20261026T063000Z')
    expect(stored).toContain('SEQUENCE:1')
  })

  it('请求带上了读到的版本标记（写入前提）', async () => {
    server.seed(UID, INVITED_ICS)

    await run('calendar_update', { event_id: UID, title: '改个名' })

    expect(server.requestsOf('PUT')[0].headers['if-match']).toBe('"v1"')
  })

  it('服务端回成功却没改开始时间：不能报成功（线上出过的事故）', async () => {
    server.seed(UID, INVITED_ICS)
    server.putMode = 'ignore'

    const result = await run('calendar_update', { event_id: UID, start: '2026-10-26T14:35:00+08:00' })

    expect(result.success).toBe(false)
    expect(result.error).toContain('回读与预期不一致')
    expect(result.error).toContain('开始')
    expect(server.stored(UID)).toBe(INVITED_ICS)
  })

  it('服务端回成功却没改地点：只比开始时间的老办法发现不了，现在要发现', async () => {
    server.seed(UID, INVITED_ICS)
    server.putMode = 'ignore'

    const result = await run('calendar_update', { event_id: UID, location: '7楼8号会议室' })

    expect(result.success).toBe(false)
    expect(result.error).toContain('地点')
  })

  it('服务端回成功却没改重复规则：同样要发现', async () => {
    server.seed(UID, INVITED_ICS)
    server.putMode = 'ignore'

    const result = await run('calendar_update', { event_id: UID, recurrence: 'weekly' })

    expect(result.success).toBe(false)
    expect(result.error).toContain('重复')
  })

  it('只改标题时，开始、结束时间不被重写（带时区写法的日程不被改成别的写法）', async () => {
    server.seed(UID, INVITED_ICS
      .replace('DTSTART:20261021T060000Z', 'DTSTART;TZID=Asia/Shanghai:20261021T140000')
      .replace('DTEND:20261021T090000Z', 'DTEND;TZID=Asia/Shanghai:20261021T170000'))

    const result = await run('calendar_update', { event_id: UID, title: '新标题' })

    expect(result.success).toBe(true)
    const stored = server.stored(UID)!
    expect(stored).toContain('SUMMARY:新标题')
    expect(stored).toContain('DTSTART;TZID=Asia/Shanghai:20261021T140000')
    expect(stored).toContain('DTEND;TZID=Asia/Shanghai:20261021T170000')
  })

  it('只改开始时间时，会议时长不变，结束时间跟着后移', async () => {
    server.seed(UID, INVITED_ICS)

    const result = await run('calendar_update', { event_id: UID, start: '2026-10-26T14:30:00+08:00' })

    expect(result.success).toBe(true)
    const stored = server.stored(UID)!
    expect(stored).toContain('DTSTART:20261026T063000Z')
    expect(stored).toContain('DTEND:20261026T093000Z')
  })

  it('结束时间不晚于开始时间：直接报错，不发请求', async () => {
    server.seed(UID, INVITED_ICS)

    const result = await run('calendar_update', {
      event_id: UID,
      start: '2026-10-26T14:30:00+08:00',
      end: '2026-10-26T14:00:00+08:00'
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain('结束时间必须晚于开始时间')
    expect(server.requestsOf('PUT')).toHaveLength(0)
  })

  it('时间写得无法识别：直接报错，不把乱码写进日历', async () => {
    server.seed(UID, INVITED_ICS)

    const result = await run('calendar_update', { event_id: UID, start: '下周一' })

    expect(result.success).toBe(false)
    expect(result.error).toContain('下周一')
    expect(server.requestsOf('PUT')).toHaveLength(0)
  })

  it('全天日程只写日期改期：成功写入，不被误判成没生效', async () => {
    const allDay = INVITED_ICS
      .replace('DTSTART:20261021T060000Z', 'DTSTART;VALUE=DATE:20261021')
      .replace('DTEND:20261021T090000Z', 'DTEND;VALUE=DATE:20261022')
    server.seed(UID, allDay)

    const result = await run('calendar_update', { event_id: UID, start: '2026-10-26' })

    expect(result.success).toBe(true)
    const stored = server.stored(UID)!
    expect(stored).toContain('DTSTART;VALUE=DATE:20261026')
    expect(stored).toContain('DTEND;VALUE=DATE:20261027')
  })

  it('改标题不动日程自带提醒的说明，也不把它当成描述', async () => {
    const withAlarm = INVITED_ICS.replace(
      'SEQUENCE:0\r\n',
      'SEQUENCE:0\r\nBEGIN:VALARM\r\nTRIGGER:-PT15M\r\nACTION:DISPLAY\r\nDESCRIPTION:Reminder\r\nEND:VALARM\r\n'
    )
    server.seed(UID, withAlarm)

    const result = await run('calendar_update', { event_id: UID, title: '新标题' })

    expect(result.success).toBe(true)
    const stored = server.stored(UID)!
    expect(stored.match(/DESCRIPTION:/g)).toHaveLength(1)
    expect(stored).toContain('DESCRIPTION:Reminder')
  })

  it('确认信息里先提示这是他人发起的会议', async () => {
    server.seed(UID, INVITED_ICS)

    await run('calendar_update', { event_id: UID, title: '新标题' })

    const confirm = (executor.addStep as ReturnType<typeof vi.fn>).mock.calls
      .map(call => call[0] as { content?: string })
      .find(step => step.content?.includes('注意'))
    expect(confirm?.content).toContain(ORGANIZER)
  })
})

describe('服务端拒绝写入', () => {
  it('403 且权限查询显示只读：按查到的事实说，并带上日程里写的发起人', async () => {
    server.seed(UID, INVITED_ICS)
    server.putMode = 'forbid'
    server.privilege = 'read'

    const result = await run('calendar_update', { event_id: UID, title: '新标题' })

    expect(result.success).toBe(false)
    expect(result.error).toContain('HTTP 403')
    expect(result.error).toContain('只有读权限')
    expect(result.error).toContain(`由 ${ORGANIZER} 发起`)
  })

  it('403 且权限查询显示有写权限：如实说「仍被拒绝」，不再说成没权限', async () => {
    server.seed(UID, INVITED_ICS)
    server.putMode = 'forbid'
    server.privilege = 'write'

    const result = await run('calendar_update', { event_id: UID, title: '新标题' })

    expect(result.error).toContain('具备写权限')
    expect(result.error).not.toContain('只有读权限')
  })

  it('403 且服务端不支持权限查询：列出几种可能，不下断言', async () => {
    server.seed(UID, INVITED_ICS)
    server.putMode = 'forbid'
    server.privilege = 'unsupported'

    const result = await run('calendar_update', { event_id: UID, title: '新标题' })

    expect(result.success).toBe(false)
    expect(result.error).toContain('常见原因')
    expect(result.error).toContain(`由 ${ORGANIZER} 发起`)
  })

  it('412：说成可能的版本冲突，不断言「已被他人修改」', async () => {
    server.seed(UID, INVITED_ICS)
    server.putMode = 'conflict'

    const result = await run('calendar_update', { event_id: UID, title: '新标题' })

    expect(result.success).toBe(false)
    expect(result.error).toContain('HTTP 412')
    expect(result.error).toContain('可能')
  })
})

describe('删除日程', () => {
  it('服务端正常删除：报成功，日程确实没了', async () => {
    server.seed(UID, INVITED_ICS)

    const result = await run('calendar_delete', { event_ids: [UID] })

    expect(result.success).toBe(true)
    expect(server.stored(UID)).toBeUndefined()
  })

  it('服务端回成功但日程还在：不能报已删除', async () => {
    server.seed(UID, INVITED_ICS)
    server.deleteMode = 'ignore'

    const result = await run('calendar_delete', { event_ids: [UID] })

    expect(result.success).toBe(false)
    expect(result.error).toContain('仍然存在')
    expect(server.stored(UID)).toBeDefined()
  })

  it('服务端拒绝删除：如实报失败', async () => {
    server.seed(UID, INVITED_ICS)
    server.deleteMode = 'forbid'

    const result = await run('calendar_delete', { event_ids: [UID] })

    expect(result.success).toBe(false)
    expect(result.error).toContain('HTTP 403')
  })

  it('一次删两个、只删掉一个：整体不报成功，已删的与没删的分别说清', async () => {
    const other = 'other-event@sfterminal'
    server.seed(UID, INVITED_ICS)
    const otherPath = server.seed(other, INVITED_ICS.replace(UID, other).replace('AI点金APP项目启动会', '周会'))
    server.deleteIgnored.add(otherPath)

    const result = await run('calendar_delete', { event_ids: [UID, other] })

    expect(result.success).toBe(false)
    expect(result.error).toContain('已删除 1 项（AI点金APP项目启动会）')
    expect(result.error).toContain('周会')
    expect(result.error).toContain('仍然存在')
    expect(server.stored(UID)).toBeUndefined()
    expect(server.stored(other)).toBeDefined()
  })

  it('删除后回读时服务端出错：不报已删除，也不说没删掉，如实说结果未知', async () => {
    server.seed(UID, INVITED_ICS)
    server.failGetAfterDelete = true

    const result = await run('calendar_delete', { event_ids: [UID] })

    expect(result.success).toBe(false)
    expect(result.error).toContain('结果未知')
    expect(result.error).not.toContain('仍然存在')
  })

  it('删除后回读拿到的是登录页之类的网页（不是日历内容）：不能当成已删掉', async () => {
    server.seed(UID, INVITED_ICS)
    server.htmlGetAfterDelete = true

    const result = await run('calendar_delete', { event_ids: [UID] })

    expect(result.success).toBe(false)
    expect(result.error).toContain('结果未知')
  })
})

describe('创建日程', () => {
  it('服务端正常保存：报成功', async () => {
    const result = await run('calendar_create', { title: '新会议', start: '2026-10-27T10:00:00+08:00' })

    expect(result.success).toBe(true)
    const names = [...server.files.keys()]
    expect(names).toHaveLength(1)
    const stored = server.files.get(names[0])!
    expect(stored).toContain('SUMMARY:新会议')
    expect(stored).toContain('DTSTART:20261027T020000Z')
  })

  it('服务端拒绝创建：如实报失败，不说已创建', async () => {
    server.putMode = 'forbid'

    const result = await run('calendar_create', { title: '新会议', start: '2026-10-27T10:00:00+08:00' })

    expect(result.success).toBe(false)
    expect(result.error).toContain('HTTP 403')
  })

  it('服务端回成功却读不到该日程：说结果未知，并提醒重复创建可能出现两份', async () => {
    server.putMode = 'ignore'

    const result = await run('calendar_create', { title: '新会议', start: '2026-10-27T10:00:00+08:00' })

    expect(result.success).toBe(false)
    expect(result.error).toContain('结果未知')
    expect(result.error).toContain('两份')
  })

  it('服务端存了，但丢了地点：不报成功，说明该内容已存在、重复创建会出现两份', async () => {
    server.storeTransform = body => body.replace(/^LOCATION:.*\r?\n/m, '')

    const result = await run('calendar_create', {
      title: '新会议',
      start: '2026-10-27T10:00:00+08:00',
      location: '7楼8号会议室'
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain('7楼8号会议室')
    expect(result.error).toContain('两份')
    expect(server.files.size).toBe(1)
  })

  it('全天日程只写日期：结束日期按一天算（次日），而不是与开始同一天', async () => {
    const result = await run('calendar_create', { title: '休假', start: '2026-10-27', all_day: true })

    expect(result.success).toBe(true)
    const stored = [...server.files.values()][0]
    expect(stored).toContain('DTSTART;VALUE=DATE:20261027')
    expect(stored).toContain('DTEND;VALUE=DATE:20261028')
  })
})

describe('服务端换了时间写法或时区', () => {
  /** 服务端把存下的 UTC 时间改写成柏林本地时间（带时区名），这是很常见的存法 */
  const toBerlin = (body: string) => body
    .replace(/^DTSTART:(\d{8})T(\d{2})(\d{2})(\d{2})Z/m, (_m, d, h, mi, se) =>
      `DTSTART;TZID=Europe/Berlin:${d}T${String(Number(h) + 1).padStart(2, '0')}${mi}${se}`)
    .replace(/^DTEND:(\d{8})T(\d{2})(\d{2})(\d{2})Z/m, (_m, d, h, mi, se) =>
      `DTEND;TZID=Europe/Berlin:${d}T${String(Number(h) + 1).padStart(2, '0')}${mi}${se}`)

  it('服务端把时间改写成带时区名的本地时间：只要是同一时刻就算对上', async () => {
    server.seed(UID, INVITED_ICS)
    server.storeTransform = toBerlin

    const result = await run('calendar_update', {
      event_id: UID,
      start: '2026-10-26T14:30:00+08:00',
      end: '2026-10-26T17:30:00+08:00'
    })

    expect(result.success).toBe(true)
    expect(server.stored(UID)).toContain('DTSTART;TZID=Europe/Berlin:20261026T073000')
  })

  const toUnknownZone = (body: string) => body
    .replace(/^DTSTART:(\d{8}T\d{6})Z/m, 'DTSTART;TZID=Custom/Nowhere:$1')
    .replace(/^DTEND:(\d{8}T\d{6})Z/m, 'DTEND;TZID=Custom/Nowhere:$1')

  it('时区认不出来、这次又只改了时间：没有任何可核对的项，说「无法核对」，不报成功', async () => {
    server.seed(UID, INVITED_ICS)
    server.storeTransform = toUnknownZone

    const result = await run('calendar_update', {
      event_id: UID,
      start: '2026-10-26T14:30:00+08:00',
      end: '2026-10-26T17:30:00+08:00'
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain('无法识别的时区')
  })

  it('时区认不出来、同时改了标题：标题照常核对，成功时照实附上「时间无法核对」', async () => {
    server.seed(UID, INVITED_ICS)
    server.storeTransform = toUnknownZone

    const result = await run('calendar_update', {
      event_id: UID,
      title: '新标题',
      start: '2026-10-26T14:30:00+08:00',
      end: '2026-10-26T17:30:00+08:00'
    })

    expect(result.success).toBe(true)
    expect(result.output).toContain('无法识别的时区')
  })

  it('时区认不出来时，标题被服务端丢了照样要抓出来', async () => {
    server.seed(UID, INVITED_ICS)
    server.storeTransform = body => toUnknownZone(body).replace(/^SUMMARY:.*$/m, 'SUMMARY:被改掉的标题')

    const result = await run('calendar_update', {
      event_id: UID,
      title: '新标题',
      start: '2026-10-26T14:30:00+08:00'
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain('新标题')
  })
})

describe('按编号直接读不到、改走查询', () => {
  it('查询返回的地址、版本标记取自同一条响应，改动写到那个地址', async () => {
    const path = server.seed('renamed-file', INVITED_ICS)
    server.reportMode = 'files'

    const result = await run('calendar_update', { event_id: UID, title: '改个名' })

    expect(result.success).toBe(true)
    expect(server.requestsOf('PUT').map(r => r.path)).toEqual([path])
    expect(server.requestsOf('PUT')[0].headers['if-match']).toBe('"v1"')
    expect(server.stored('renamed-file')).toContain('SUMMARY:改个名')
  })

  it('查询返回里没有地址：不能拿日历集合的地址顶替，修改不发出任何写请求', async () => {
    server.seed('renamed-file', INVITED_ICS)
    server.reportMode = 'no-href'

    const result = await run('calendar_update', { event_id: UID, title: '改个名' })

    expect(result.success).toBe(false)
    expect(server.requestsOf('PUT')).toHaveLength(0)
  })

  it('查询返回里没有地址：删除也不能对日历集合发出删除请求', async () => {
    server.seed('renamed-file', INVITED_ICS)
    server.reportMode = 'no-href'

    const result = await run('calendar_delete', { event_ids: [UID] })

    expect(result.success).toBe(false)
    expect(server.requestsOf('DELETE')).toHaveLength(0)
    expect(server.stored('renamed-file')).toBeDefined()
  })
})

describe('特殊结构的日程', () => {
  const SERIES_OVERRIDE_FIRST = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    `UID:${UID}`,
    'RECURRENCE-ID:20261028T060000Z',
    'DTSTART:20261028T070000Z',
    'DTEND:20261028T100000Z',
    'SUMMARY:本周挪后一小时',
    'END:VEVENT',
    'BEGIN:VEVENT',
    `UID:${UID}`,
    'DTSTART:20261021T060000Z',
    'DTEND:20261021T090000Z',
    'SUMMARY:每周例会',
    'RRULE:FREQ=WEEKLY',
    `ORGANIZER;CN=柏金鑫:mailto:${ORGANIZER}`,
    'END:VEVENT',
    'END:VCALENDAR',
    ''
  ].join('\r\n')

  it('单独改过的场次排在前面：改的是主日程，那一场原样不动，重复规则也不丢', async () => {
    server.seed(UID, SERIES_OVERRIDE_FIRST)

    const result = await run('calendar_update', { event_id: UID, title: '每周例会（新名）' })

    expect(result.success).toBe(true)
    const stored = server.stored(UID)!
    expect(stored).toContain('SUMMARY:每周例会（新名）')
    expect(stored).toContain('SUMMARY:本周挪后一小时')
    expect(stored).toContain('RRULE:FREQ=WEEKLY')
  })

  it('用时长表示长度的日程：只改地点时不凭空多出结束时间', async () => {
    server.seed(UID, INVITED_ICS.replace('DTEND:20261021T090000Z', 'DURATION:PT3H'))

    const result = await run('calendar_update', { event_id: UID, location: '7楼8号会议室' })

    expect(result.success).toBe(true)
    const stored = server.stored(UID)!
    expect(stored).toContain('DURATION:PT3H')
    expect(stored).not.toContain('DTEND')
  })

  it('用时长表示长度的日程：只改开始时间，长度保持三小时，结束时间写成明确的时刻', async () => {
    server.seed(UID, INVITED_ICS.replace('DTEND:20261021T090000Z', 'DURATION:PT3H'))

    const result = await run('calendar_update', { event_id: UID, start: '2026-10-26T14:30:00+08:00' })

    expect(result.success).toBe(true)
    const stored = server.stored(UID)!
    expect(stored).toContain('DTSTART:20261026T063000Z')
    expect(stored).toContain('DTEND:20261026T093000Z')
    expect(stored).not.toContain('DURATION')
  })
})

describe('待办', () => {
  const TODO_UID = 'todo-1@sfterminal'
  const TODO_ICS = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VTODO',
    `UID:${TODO_UID}`,
    'DTSTAMP:20261015T080000Z',
    'SUMMARY:写周报',
    'STATUS:NEEDS-ACTION',
    'END:VTODO',
    'END:VCALENDAR',
    ''
  ].join('\r\n')

  it('创建：服务端正常保存时报成功', async () => {
    const result = await run('calendar_todo_create', { title: '买咖啡' })

    expect(result.success).toBe(true)
    expect([...server.files.values()][0]).toContain('SUMMARY:买咖啡')
  })

  it('创建：服务端拒绝时如实报失败', async () => {
    server.putMode = 'forbid'

    const result = await run('calendar_todo_create', { title: '买咖啡' })

    expect(result.success).toBe(false)
    expect(result.error).toContain('HTTP 403')
  })

  it('创建：服务端回成功却读不到：说结果未知', async () => {
    server.putMode = 'ignore'

    const result = await run('calendar_todo_create', { title: '买咖啡' })

    expect(result.success).toBe(false)
    expect(result.error).toContain('结果未知')
  })

  it('标记完成：服务端正常应用时报成功', async () => {
    server.seed(TODO_UID, TODO_ICS)

    const result = await run('calendar_todo_update', { todo_id: TODO_UID, status: 'completed' })

    expect(result.success).toBe(true)
    expect(server.stored(TODO_UID)).toContain('STATUS:COMPLETED')
  })

  it('标记完成：服务端回成功但状态没变：不报已完成', async () => {
    server.seed(TODO_UID, TODO_ICS)
    server.putMode = 'ignore'

    const result = await run('calendar_todo_update', { todo_id: TODO_UID, status: 'completed' })

    expect(result.success).toBe(false)
    expect(result.error).toContain('服务端可能没有应用')
    expect(server.stored(TODO_UID)).toContain('STATUS:NEEDS-ACTION')
  })

  it('删除：服务端回成功但待办还在：不报已删除', async () => {
    server.seed(TODO_UID, TODO_ICS)
    server.deleteMode = 'ignore'

    const result = await run('calendar_todo_delete', { todo_ids: [TODO_UID] })

    expect(result.success).toBe(false)
    expect(result.error).toContain('仍然存在')
  })

  it('删除：服务端拒绝时如实报失败', async () => {
    server.seed(TODO_UID, TODO_ICS)
    server.deleteMode = 'forbid'

    const result = await run('calendar_todo_delete', { todo_ids: [TODO_UID] })

    expect(result.success).toBe(false)
    expect(result.error).toContain('HTTP 403')
  })

  it('删除：服务端正常删除时报成功', async () => {
    server.seed(TODO_UID, TODO_ICS)

    const result = await run('calendar_todo_delete', { todo_ids: [TODO_UID] })

    expect(result.success).toBe(true)
    expect(server.stored(TODO_UID)).toBeUndefined()
  })
})
