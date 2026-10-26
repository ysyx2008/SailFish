/**
 * 伙计远程范围的授权门：参数、会话类别、已存主机、只读判定、按审批方式确认。
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const mockUserData = path.join(os.tmpdir(), `sft-remote-gate-${Date.now()}`)

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return mockUserData
      throw new Error(`unexpected getPath: ${name}`)
    },
  },
}))

import { ensureAgentWorkspaceDirs } from '../../tools/file'

import { RemoteDispatchGate, MAX_REMOTE_COMMANDS, type RemoteDispatchContext } from '../remote-dispatch-gate'
import { RemoteGrant } from '../remote-grant'

beforeAll(async () => {
  fs.mkdirSync(mockUserData, { recursive: true })
  ensureAgentWorkspaceDirs()
  const { ensureShellAstReady } = await import('../../command-audit/parser')
  await ensureShellAstReady()
})

afterAll(() => {
  fs.rmSync(mockUserData, { recursive: true, force: true })
})

const sessions = [
  { id: 'a1', name: 'web-01', host: '10.0.0.11', port: 22, username: 'deploy', groupId: 'g-prod' },
  { id: 'a2', name: 'web-02', host: '10.0.0.12', port: 2222, username: 'deploy', groupId: 'g-prod' },
  { id: 'b1', name: 'lab', host: '10.0.1.5', port: 22, username: 'root' },
]
const groups = [{ id: 'g-prod', name: '生产' }]

function gateWith(overrides: Partial<RemoteDispatchContext> = {}) {
  const confirm = vi.fn(async () => true)
  const ctx: RemoteDispatchContext = {
    sessions,
    groups,
    executionMode: 'relaxed',
    conversationAllows: true,
    attended: true,
    confirm,
    ...overrides,
  }
  return { gate: new RemoteDispatchGate(ctx), confirm }
}

describe('派出：参数与处境', () => {
  it('没有主机也没有命令：不碰远程，也不问', async () => {
    const { gate, confirm } = gateWith()
    const r = await gate.authorizeDispatch([{}, {}], [])
    expect(r).toEqual({ ok: true, value: [undefined, undefined] })
    expect(confirm).not.toHaveBeenCalled()
  })

  it('写了主机没写命令：退回', async () => {
    const { gate, confirm } = gateWith()
    const r = await gate.authorizeDispatch([{ hosts: ['a1'] }], [])
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toContain('第 1 位伙计写了 hosts')
    expect(confirm).not.toHaveBeenCalled()
  })

  it('写了命令没有伙计带主机：退回', async () => {
    const { gate } = gateWith()
    const r = await gate.authorizeDispatch([{}], ['df -h'])
    expect(!r.ok && r.error).toContain('没有伙计带 hosts')
  })

  it('伙计自己写了命令却没写主机：退回并点名第几位', async () => {
    const { gate, confirm } = gateWith()
    const r = await gate.authorizeDispatch([{ hosts: ['a1'], commands: ['df -h'] }, { commands: ['uptime'] }], [])
    expect(!r.ok && r.error).toContain('第 2 位伙计写了 remote_commands，却没写 hosts')
    expect(confirm).not.toHaveBeenCalled()
  })

  it('有的伙计写了主机、共有和自己的命令都空：退回并点名', async () => {
    const { gate } = gateWith()
    const r = await gate.authorizeDispatch([{ hosts: ['a1'], commands: ['df -h'] }, { hosts: ['a2'] }], [])
    expect(!r.ok && r.error).toContain('第 2 位伙计写了 hosts')
  })

  it('命令条数超过上限：退回', async () => {
    const { gate } = gateWith()
    const commands = Array.from({ length: MAX_REMOTE_COMMANDS + 1 }, (_, i) => `echo ${i}`)
    const r = await gate.authorizeDispatch([{ hosts: ['a1'] }], commands)
    expect(!r.ok && r.error).toContain(String(MAX_REMOTE_COMMANDS))
  })

  it('关切、唤醒这类后台会话：退回，不问', async () => {
    const { gate, confirm } = gateWith({ conversationAllows: false, executionMode: 'free' })
    const r = await gate.authorizeDispatch([{ hosts: ['a1'] }], ['df -h'])
    expect(!r.ok && r.error).toContain('后台执行里不能派')
    expect(confirm).not.toHaveBeenCalled()
  })

  it('主机不是已存会话：退回并点名', async () => {
    const { gate, confirm } = gateWith()
    const r = await gate.authorizeDispatch([{ hosts: ['a1', 'nope'] }], ['df -h'])
    expect(!r.ok && r.error).toContain('nope')
    expect(confirm).not.toHaveBeenCalled()
  })
})

describe('派出：只读判定（自由模式、没有专家可用时的底线）', () => {
  it('有一条不是只读：整批退回，写明第几条和原因，不问人', async () => {
    const { gate, confirm } = gateWith({ executionMode: 'free' })
    const r = await gate.authorizeDispatch([{ hosts: ['a1'] }], ['df -h', 'rm -rf /var/log/app'])
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toContain('第 2 条')
    expect(!r.ok && r.error).toContain('rm -rf /var/log/app')
    expect(confirm).not.toHaveBeenCalled()
  })

  it('远程不接受转手执行别的命令的写法', async () => {
    const { gate } = gateWith({ executionMode: 'free' })
    const r = await gate.authorizeDispatch([{ hosts: ['a1'] }], ['sudo df -h'])
    expect(r.ok).toBe(false)
  })

  it('常见的查看命令都过', async () => {
    const { gate } = gateWith({ executionMode: 'free' })
    const commands = ['df -h', 'free -g', 'systemctl status nginx', 'docker ps', 'journalctl -u nginx -n 50', 'uptime']
    const r = await gate.authorizeDispatch([{ hosts: ['a1'] }], commands)
    expect(r.ok).toBe(true)
  })
})

describe('派出：按这场对话的审批方式确认', () => {
  it('宽松档也要问；卡片带着按分组归好的主机和命令清单', async () => {
    const { gate, confirm } = gateWith({ executionMode: 'relaxed' })
    const r = await gate.authorizeDispatch(
      [{ hosts: ['a1', 'a2'] }, { hosts: ['a2', 'b1'] }, {}],
      ['df -h', 'uptime'],
    )
    expect(r.ok).toBe(true)
    expect(confirm).toHaveBeenCalledTimes(1)
    const [request, toolArgs, displayName, reasons] = confirm.mock.calls[0] as unknown as [
      import('@shared/types').RemoteAccessRequest, Record<string, unknown>, string, string[],
    ]
    expect(request.workerCount).toBe(2)
    expect(request.commands).toEqual(['df -h', 'uptime'])
    expect(request.hosts.map(h => h.id)).toEqual(['a1', 'a2', 'b1'])
    expect(request.hosts[0]).toEqual({ id: 'a1', name: 'web-01', address: 'deploy@10.0.0.11:22', group: '生产' })
    expect(request.hosts[2]).toEqual({ id: 'b1', name: 'lab', address: 'root@10.0.1.5:22' })
    expect(displayName).toContain('2')
    expect(reasons.join('')).toContain('输出会交给模型')
    expect(toolArgs.remote_commands).toEqual(['df -h', 'uptime'])
  })

  it('严格档同样要问', async () => {
    const { gate, confirm } = gateWith({ executionMode: 'strict' })
    await gate.authorizeDispatch([{ hosts: ['a1'] }], ['df -h'])
    expect(confirm).toHaveBeenCalledTimes(1)
  })

  it('自由模式不问，单子照样限定每个伙计的范围', async () => {
    const { gate, confirm } = gateWith({ executionMode: 'free' })
    const r = await gate.authorizeDispatch([{ hosts: ['a1'] }, {}, { hosts: ['b1'] }], ['df -h'])
    expect(confirm).not.toHaveBeenCalled()
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const [first, second, third] = r.value
    expect(first?.hosts.map(h => h.id)).toEqual(['a1'])
    expect(second).toBeUndefined()
    expect(third?.hosts.map(h => h.id)).toEqual(['b1'])
    expect(first?.commands).toEqual(['df -h'])
  })

  it('用户没批准：整批退回', async () => {
    const { gate } = gateWith({ confirm: vi.fn(async () => false) })
    const r = await gate.authorizeDispatch([{ hosts: ['a1'] }], ['df -h'])
    expect(!r.ok && r.error).toContain('用户没有批准')
  })

  it('没人当场回答（没有交互终端的命令行）：非自由模式退回，不挂着等', async () => {
    const { gate, confirm } = gateWith({ attended: false, executionMode: 'relaxed' })
    const r = await gate.authorizeDispatch([{ hosts: ['a1'] }], ['df -h'])
    expect(!r.ok && r.error).toContain('没有人能确认')
    expect(confirm).not.toHaveBeenCalled()
  })

  it('没人当场回答但明确选了自由模式：可以派', async () => {
    const { gate } = gateWith({ attended: false, executionMode: 'free' })
    const r = await gate.authorizeDispatch([{ hosts: ['a1'] }], ['df -h'])
    expect(r.ok).toBe(true)
  })
})

describe('补单', () => {
  const grant = () => new RemoteGrant([{ id: 'a1', name: 'web-01', address: 'deploy@10.0.0.11:22', group: '生产' }], ['df -h'])

  it('没有新命令：直接过', async () => {
    const { gate, confirm } = gateWith()
    expect((await gate.authorizeFollowup('w', grant(), [])).ok).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
  })

  it('没有主机范围的伙计：不能补', async () => {
    const { gate } = gateWith()
    const r = await gate.authorizeFollowup('w', undefined, ['uptime'])
    expect(!r.ok && r.error).toContain('没有远程主机范围')
  })

  it('补的命令不是只读（自由模式、没有专家）：退回', async () => {
    const { gate, confirm } = gateWith({ executionMode: 'free' })
    const r = await gate.authorizeFollowup('w', grant(), ['rm -rf /tmp/x'])
    expect(r.ok).toBe(false)
    expect(confirm).not.toHaveBeenCalled()
  })

  it('按审批方式问；卡片写明补给谁、他的主机', async () => {
    const { gate, confirm } = gateWith()
    const r = await gate.authorizeFollowup('web-worker', grant(), ['uptime'])
    expect(r.ok).toBe(true)
    const request = (confirm.mock.calls[0] as unknown as [import('@shared/types').RemoteAccessRequest])[0]
    expect(request.forWorker).toBe('web-worker')
    expect(request.commands).toEqual(['uptime'])
    expect(request.hosts.map(h => h.id)).toEqual(['a1'])
  })

  it('用户拒绝：退回', async () => {
    const { gate } = gateWith({ confirm: vi.fn(async () => false) })
    const r = await gate.authorizeFollowup('w', grant(), ['uptime'])
    expect(!r.ok && r.error).toContain('没有批准')
  })

  it('后台会话里不能补', async () => {
    const { gate } = gateWith({ conversationAllows: false })
    const r = await gate.authorizeFollowup('w', grant(), ['uptime'])
    expect(r.ok).toBe(false)
  })
})

describe('RemoteGrant', () => {
  it('命令原文去掉首尾空白后一字不差才算在单上', () => {
    const g = new RemoteGrant([], ['df -h'])
    expect(g.permitsCommand('df -h')).toBe(true)
    expect(g.permitsCommand('  df -h \n')).toBe(true)
    expect(g.permitsCommand('df  -h')).toBe(false)
    expect(g.permitsCommand('df -h; id')).toBe(false)
  })

  it('补单只增不重复', () => {
    const g = new RemoteGrant([], ['df -h'])
    expect(g.addCommands(['df -h', 'uptime', ' uptime '])).toBe(1)
    expect(g.commands).toEqual(['df -h', 'uptime'])
  })
})

describe('运维专家的结论怎么落到审批方式', () => {
  type Judge = NonNullable<RemoteDispatchContext['expert']>['judge']
  const allow: Awaited<ReturnType<Judge>> = { kind: 'verdict', verdict: { outcome: 'allow', note: '只是看状态' } }
  const ask: Awaited<ReturnType<Judge>> = { kind: 'verdict', verdict: { outcome: 'ask_user', card: '会重启 nginx' } }
  const refuse: Awaited<ReturnType<Judge>> = { kind: 'verdict', verdict: { outcome: 'refuse', reason: '会格式化磁盘' } }
  const unavailable: Awaited<ReturnType<Judge>> = { kind: 'unavailable', detail: 'timeout' }

  function expertGate(result: Awaited<ReturnType<Judge>>, overrides: Partial<RemoteDispatchContext> = {}) {
    const judge = vi.fn<Judge>(async () => result)
    const onExpertAllowed = vi.fn()
    const onExpertHandedOver = vi.fn()
    const g = gateWith({ expert: { judge }, onExpertAllowed, onExpertHandedOver, ...overrides })
    return { ...g, judge, onExpertAllowed, onExpertHandedOver }
  }
  const run = (gate: RemoteDispatchGate, commands = ['df -h']) => gate.authorizeDispatch([{ hosts: ['a1'] }], commands)

  // 请专家的两档：替我审批、自由。模式 × 结论：是否弹卡、是否放行
  const AUTO: Partial<RemoteDispatchContext> = { executionMode: 'relaxed', autoReview: true }
  const FREE: Partial<RemoteDispatchContext> = { executionMode: 'free' }
  const TABLE: Array<[label: string, ctx: Partial<RemoteDispatchContext>, result: Awaited<ReturnType<Judge>>, outcome: 'pass' | 'rejected', cards: number]> = [
    ['替我审批 · 专家放行', AUTO, allow, 'pass', 0],
    ['替我审批 · 专家问用户', AUTO, ask, 'pass', 1],
    ['替我审批 · 专家拒绝', AUTO, refuse, 'rejected', 0],
    ['自由 · 专家放行', FREE, allow, 'pass', 0],
    ['自由 · 专家问用户', FREE, ask, 'rejected', 0],
    ['自由 · 专家拒绝', FREE, refuse, 'rejected', 0],
  ]

  it.each(TABLE)('%s', async (_label, ctx, result, outcome, cards) => {
    const { gate, confirm } = expertGate(result, ctx)
    const r = await run(gate)
    expect(r.ok).toBe(outcome === 'pass')
    expect(confirm).toHaveBeenCalledTimes(cards)
  })

  it('严格、宽松：每批都由用户看，直接弹卡，不请专家，写操作也不挡', async () => {
    for (const mode of ['strict', 'relaxed'] as const) {
      for (const result of [allow, ask, refuse, unavailable]) {
        const { gate, confirm, judge, onExpertAllowed, onExpertHandedOver } = expertGate(result, { executionMode: mode })
        const r = await run(gate, ['rm -rf /var/log/app'])
        expect(r.ok).toBe(true)
        expect(confirm).toHaveBeenCalledTimes(1)
        expect(judge).not.toHaveBeenCalled()
        expect(onExpertAllowed).not.toHaveBeenCalled()
        expect(onExpertHandedOver).not.toHaveBeenCalled()
      }
    }
  })

  it('替我审批：专家要问时，话留在卡前面', async () => {
    const { gate, onExpertHandedOver } = expertGate(ask, AUTO)
    const r = await run(gate)
    expect(r.ok).toBe(true)
    expect(onExpertHandedOver).toHaveBeenCalledTimes(1)
    expect(onExpertHandedOver.mock.calls[0]![0]).toBe('会重启 nginx')
  })

  it('替我审批：专家没给出结论，先留一行再弹卡', async () => {
    const { gate, confirm, onExpertHandedOver } = expertGate(unavailable, AUTO)
    const r = await run(gate)
    expect(r.ok).toBe(true)
    expect(onExpertHandedOver).toHaveBeenCalledTimes(1)
    expect(onExpertHandedOver.mock.calls[0]![0]).toBeUndefined()
    expect(confirm).toHaveBeenCalledTimes(1)
  })

  it('替我审批：专家放行不弹卡，理由留进过程', async () => {
    const { gate, confirm, onExpertAllowed } = expertGate(allow, AUTO)
    const r = await run(gate)
    expect(r.ok).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
    expect(onExpertAllowed).toHaveBeenCalledTimes(1)
    expect(onExpertAllowed.mock.calls[0]![0]).toBe('只是看状态')
  })

  it('自由：专家放行，理由也留进过程', async () => {
    const free = expertGate(allow, FREE)
    await run(free.gate)
    expect(free.onExpertAllowed).toHaveBeenCalledTimes(1)
    expect(free.onExpertAllowed.mock.calls[0]![0]).toBe('只是看状态')
  })

  it('专家一边写，界面先收到结论，写完再给一次完整的', async () => {
    const live: string[] = []
    const judge = vi.fn<Judge>(async (input) => {
      input.onPartial?.({ outcome: 'allow', text: '' })
      input.onPartial?.({ outcome: 'allow', text: '只是看' })
      return allow
    })
    const { gate } = gateWith({
      expert: { judge },
      executionMode: 'relaxed',
      autoReview: true,
      onExpertLive: (update) => live.push(update.kind === 'writing' ? `writing:${update.partial.text}` : update.kind),
    })
    const r = await run(gate)
    expect(r.ok).toBe(true)
    expect(live).toEqual(['looking', 'writing:', 'writing:只是看', 'settled'])
  })

  it('拒绝：理由原样退给秘书', async () => {
    const { gate } = expertGate(refuse, AUTO)
    const r = await run(gate)
    expect(!r.ok && r.error).toContain('会格式化磁盘')
  })

  it('自由模式下专家要问：不问人，把专家的话退给秘书', async () => {
    const { gate } = expertGate(ask, { executionMode: 'free' })
    const r = await run(gate)
    expect(!r.ok && r.error).toContain('会重启 nginx')
  })

  it('专家没给出结论：自由模式退回只读判定——只读的过，其余退回', async () => {
    const readOnly = expertGate(unavailable, { executionMode: 'free' })
    expect((await run(readOnly.gate, ['df -h'])).ok).toBe(true)
    const write = expertGate(unavailable, { executionMode: 'free' })
    const r = await run(write.gate, ['rm -rf /var/log/app'])
    expect(!r.ok && r.error).toContain('不是只读')
  })

  it('专家取消（整场被停）：退回，不弹卡', async () => {
    const { gate, confirm } = expertGate({ kind: 'cancelled' }, AUTO)
    const r = await run(gate)
    expect(r.ok).toBe(false)
    expect(confirm).not.toHaveBeenCalled()
  })

  it('没有人在场且不是自由：没人能批，不必再问专家', async () => {
    const { gate, judge } = expertGate(allow, { ...AUTO, attended: false })
    const r = await run(gate)
    expect(!r.ok && r.error).toContain('没有人能确认')
    expect(judge).not.toHaveBeenCalled()
  })

  it('没有人在场但自由模式：专家放行就过', async () => {
    const { gate } = expertGate(allow, { attended: false, executionMode: 'free' })
    expect((await run(gate)).ok).toBe(true)
  })

  it('补单走同一套：替我审批下请专家看', async () => {
    const { gate, confirm, judge } = expertGate(ask, AUTO)
    const grant = new RemoteGrant([{ id: 'a1', name: 'web-01', address: 'deploy@10.0.0.11:22' }], ['df -h'])
    const r = await gate.authorizeFollowup('wk', grant, ['uptime'])
    expect(r.ok).toBe(true)
    expect(confirm).toHaveBeenCalledTimes(1)
    expect((judge.mock.calls[0] as unknown as [{ forWorker?: string }])[0].forWorker).toBe('wk')
  })

  it('专家看到的是这一批的主机与命令原文', async () => {
    const { gate, judge } = expertGate(allow, AUTO)
    await gate.authorizeDispatch([{ hosts: ['a1', 'a2'] }], ['df -h', 'uptime'])
    const input = (judge.mock.calls[0] as unknown as [{ hosts: Array<{ name: string; group?: string }>; commands: string[]; approval: string }])[0]
    expect(input.hosts.map(h => h.name)).toEqual(['web-01', 'web-02'])
    expect(input.hosts[0]!.group).toBe('生产')
    expect(input.commands).toEqual(['df -h', 'uptime'])
    expect(input.approval).toBe('autoReview')
  })
})

describe('派出：每个伙计自己的命令清单', () => {
  it('清单不一样：卡上按块分开，每个伙计只拿到共有的加自己的', async () => {
    const { gate, confirm } = gateWith()
    const r = await gate.authorizeDispatch(
      [
        { hosts: ['a1'], commands: ['df -h'] },
        { hosts: ['a2'], commands: ['uptime'] },
        { hosts: ['b1'], commands: ['df -h'] },
      ],
      ['hostname'],
    )
    expect(r.ok).toBe(true)
    const asked = (confirm.mock.calls[0] as unknown as unknown[])[0] as { assignments?: Array<{ workerCount: number; hosts: Array<{ name: string }>; commands: string[] }>; commands: string[]; workerCount: number }
    expect(asked.workerCount).toBe(3)
    expect(asked.commands).toEqual(['hostname', 'df -h', 'uptime'])
    expect(asked.assignments).toHaveLength(2)
    expect(asked.assignments![0]).toMatchObject({ workerCount: 2, commands: ['hostname', 'df -h'] })
    expect(asked.assignments![0]!.hosts.map(h => h.name)).toEqual(['web-01', 'lab'])
    expect(asked.assignments![1]).toMatchObject({ workerCount: 1, commands: ['hostname', 'uptime'] })

    const [g1, g2] = r.ok ? r.value : []
    expect(g1!.permitsCommand('df -h')).toBe(true)
    expect(g1!.permitsCommand('uptime')).toBe(false)
    expect(g2!.permitsCommand('uptime')).toBe(true)
    expect(g2!.permitsCommand('df -h')).toBe(false)
    expect(g2!.permitsCommand('hostname')).toBe(true)
  })

  it('清单都一样：还是一张不分块的卡', async () => {
    const { gate, confirm } = gateWith()
    await gate.authorizeDispatch([{ hosts: ['a1'], commands: ['df -h'] }, { hosts: ['a2'], commands: ['df -h'] }], [])
    const asked = (confirm.mock.calls[0] as unknown as unknown[])[0] as { assignments?: unknown; commands: string[] }
    expect(asked.assignments).toBeUndefined()
    expect(asked.commands).toEqual(['df -h'])
  })
})
