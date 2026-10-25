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
    expect(!r.ok && r.error).toContain('remote_commands 必须列出')
    expect(confirm).not.toHaveBeenCalled()
  })

  it('写了命令没有伙计带主机：退回', async () => {
    const { gate } = gateWith()
    const r = await gate.authorizeDispatch([{}], ['df -h'])
    expect(!r.ok && r.error).toContain('没有伙计带 hosts')
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

describe('派出：只读判定', () => {
  it('有一条不是只读：整批退回，写明第几条和原因，不问人', async () => {
    const { gate, confirm } = gateWith()
    const r = await gate.authorizeDispatch([{ hosts: ['a1'] }], ['df -h', 'rm -rf /var/log/app'])
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toContain('第 2 条')
    expect(!r.ok && r.error).toContain('rm -rf /var/log/app')
    expect(confirm).not.toHaveBeenCalled()
  })

  it('远程不接受转手执行别的命令的写法', async () => {
    const { gate } = gateWith()
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

  it('补的命令不是只读：退回', async () => {
    const { gate, confirm } = gateWith()
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
