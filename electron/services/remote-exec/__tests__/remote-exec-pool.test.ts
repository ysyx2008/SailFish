/**
 * 后台远程通道：用 ssh2 自带的 Server 起假主机，注入慢握手、拒绝登录、不支持 exec、跳板拒绝转发。
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { JUMP_FORWARDING_REFUSED_MESSAGE, type JumpHostConfig } from '@shared/types'
import { RemoteExecPool, type RemoteExecLimits } from '../remote-exec-pool'
import { RemoteExecRegistry } from '../index'
import type { RemoteHost } from '../remote-host'
import { startFakeHost, type FakeHost, type FakeHostOptions } from './fake-ssh-host'

vi.mock('../../../utils/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))

const hosts: FakeHost[] = []
const pools: RemoteExecPool[] = []

async function fakeHost(opts: FakeHostOptions = {}): Promise<FakeHost> {
  const h = await startFakeHost(opts)
  hosts.push(h)
  return h
}

function pool(limits: Partial<RemoteExecLimits> = {}): RemoteExecPool {
  const p = new RemoteExecPool({ connectTimeoutMs: 5000, ...limits })
  pools.push(p)
  return p
}

function hostSpec(h: FakeHost, extra: Partial<RemoteHost> = {}): RemoteHost {
  return {
    id: `h${h.port}`, name: `host-${h.port}`, host: '127.0.0.1', port: h.port,
    username: 'tester', password: 'secret', encoding: 'utf-8', ...extra,
  }
}

function jumpOf(h: FakeHost, password = 'secret'): JumpHostConfig {
  return { host: '127.0.0.1', port: h.port, username: 'tester', authType: 'password', password }
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('等条件超时')
    await new Promise(r => setTimeout(r, 10))
  }
}

afterEach(async () => {
  for (const p of pools.splice(0)) p.dispose()
  for (const h of hosts.splice(0)) await h.close()
})

const T = { timeoutMs: 5000 }

describe('跑命令', () => {
  it('标准输出、标准错误按到达顺序合在一起，退出码照实返回', async () => {
    const h = await fakeHost()
    const p = pool()
    const ok = await p.exec(hostSpec(h), 'echo hello', T)
    expect(ok).toMatchObject({ exitCode: 0, output: 'hello\n', timedOut: false, aborted: false })
    expect(ok.error).toBeUndefined()
    expect((await p.exec(hostSpec(h), 'err oops', T)).output).toBe('oops\n')
    expect((await p.exec(hostSpec(h), 'exit 3', T)).exitCode).toBe(3)
  })

  it('按会话编码解码：GBK 主机的中文不乱码', async () => {
    const h = await fakeHost()
    const r = await pool().exec(hostSpec(h, { encoding: 'gbk' }), 'gbk', T)
    expect(r.output).toBe('你好')
  })

  it('输出超过上限就丢掉后面的，并且说明', async () => {
    const h = await fakeHost()
    const r = await pool({ maxOutputBytes: 1000 }).exec(hostSpec(h), 'flood', T)
    expect(r.output.length).toBe(1000)
    expect(r.outputTruncated).toBe(true)
  })

  it('这台不支持直接执行命令时，说清楚', async () => {
    const h = await fakeHost({ rejectExec: true })
    const r = await pool().exec(hostSpec(h), 'echo hi', T)
    expect(r.error?.kind).toBe('exec_unsupported')
    expect(r.error?.message).toContain('不支持直接执行命令')
  })
})

describe('连接复用与闲置断开', () => {
  it('同一台主机复用一条连接，并发的命令也共用', async () => {
    const h = await fakeHost()
    const p = pool()
    await p.exec(hostSpec(h), 'echo a', T)
    await Promise.all([p.exec(hostSpec(h), 'echo b', T), p.exec(hostSpec(h), 'echo c', T)])
    expect(h.connections).toBe(1)
    expect(p.stats().openConnections).toBe(1)
  })

  it('闲置一阵自动断开，下一条命令重新连', async () => {
    const h = await fakeHost()
    const p = pool({ idleCloseMs: 80 })
    await p.exec(hostSpec(h), 'echo a', T)
    expect(h.open).toBe(1)
    await until(() => h.open === 0)
    expect(p.stats().openConnections).toBe(0)
    expect((await p.exec(hostSpec(h), 'echo b', T)).output).toBe('b\n')
    expect(h.connections).toBe(2)
  })
})

describe('登录被拒', () => {
  it('密码被拒报清楚原因，同一台主机不重试', async () => {
    const h = await fakeHost()
    const p = pool()
    const spec = hostSpec(h, { password: 'wrong' })
    const first = await p.exec(spec, 'echo hi', T)
    expect(first.error?.kind).toBe('auth_failed')
    expect(first.error?.message).toContain('认证失败')
    const connectionsAfterFirst = h.connections
    const second = await p.exec(spec, 'echo hi', T)
    expect(second.error?.kind).toBe('auth_failed')
    expect(h.connections).toBe(connectionsAfterFirst)
  })

  it('同一组账号连着被 3 台拒绝，后面的主机不再用它登录（连服务器都不碰）', async () => {
    const rejecting = await Promise.all([1, 2, 3].map(() => fakeHost({ users: { tester: 'other' } })))
    const fine = await fakeHost()
    const p = pool()
    for (const h of rejecting) {
      expect((await p.exec(hostSpec(h), 'echo x', T)).error?.kind).toBe('auth_failed')
    }
    const paused = await p.exec(hostSpec(fine), 'echo x', T)
    expect(paused.error?.kind).toBe('credentials_paused')
    expect(paused.error?.message).toBe('这组账号已被 3 台主机拒绝登录，这一批后面不再用它登录。')
    expect(fine.connections).toBe(0)
    // 换一组账号不受影响
    const other = await p.exec(hostSpec(fine, { password: 'secret', username: 'tester' }), 'echo x', T)
    expect(other.error?.kind).toBe('credentials_paused')
  })

  it('成功登录一次就清零，算「连着」被拒', async () => {
    const rejecting = await Promise.all([1, 2].map(() => fakeHost({ users: { tester: 'other' } })))
    const fine = await fakeHost()
    const rejectingLater = await fakeHost({ users: { tester: 'other' } })
    const p = pool()
    for (const h of rejecting) await p.exec(hostSpec(h), 'echo x', T)
    expect((await p.exec(hostSpec(fine), 'echo ok', T)).output).toBe('ok\n')
    expect((await p.exec(hostSpec(rejectingLater), 'echo x', T)).error?.kind).toBe('auth_failed')
  })
})

describe('连不上', () => {
  it('端口不通：说清楚是连接被拒绝', async () => {
    const closed = await fakeHost()
    const port = closed.port
    await closed.close()
    const r = await pool().exec({ ...hostSpec(closed), port }, 'echo hi', T)
    expect(r.error?.kind).toBe('connect_failed')
    expect(r.error?.message).toContain('连接被拒绝')
  })

  it('私钥文件读不了：说清楚', async () => {
    const h = await fakeHost()
    const r = await pool().exec(hostSpec(h, { privateKeyPath: '/no/such/key' }), 'echo hi', T)
    expect(r.error?.kind).toBe('connect_failed')
    expect(r.error?.message).toContain('无法读取私钥文件')
  })
})

describe('握手限流', () => {
  it('全局同时握手不超过上限，多的排队，最后都成功', async () => {
    const targets = await Promise.all(Array.from({ length: 10 }, () => fakeHost({ authDelayMs: 60 })))
    const p = pool({ handshakeLimit: 3 })
    const results = await Promise.all(targets.map(h => p.exec(hostSpec(h), 'echo ok', T)))
    expect(results.every(r => r.output === 'ok\n' && !r.error)).toBe(true)
    expect(p.stats().peakHandshakes).toBeLessThanOrEqual(3)
    // 服务器那边看到的同时握手数也不超（通道自己的计数之外的独立证据）
    expect(Math.max(...targets.map(h => h.peakHandshaking))).toBeLessThanOrEqual(1)
  })
})

describe('跳板', () => {
  it('多台主机共用一条跳板连接，跳板上同时开的转发不超过上限', async () => {
    const jump = await fakeHost({ allowForward: true, authDelayMs: 20 })
    const targets = await Promise.all(Array.from({ length: 8 }, () => fakeHost({ authDelayMs: 40 })))
    const p = pool({ jumpForwardLimit: 3, idleCloseMs: 5000 })
    const results = await Promise.all(
      targets.map(h => p.exec(hostSpec(h, { jumpHost: jumpOf(jump) }), 'echo ok', T)),
    )
    expect(results.every(r => r.output === 'ok\n' && !r.error), JSON.stringify(results.map(r => r.error))).toBe(true)
    expect(jump.connections).toBe(1)
    expect(jump.peakTunnels).toBeLessThanOrEqual(3)
    expect(p.stats().peakForwardsPerJump).toBeLessThanOrEqual(3)
    expect(jump.tunnelRequests).toBe(8)
  })

  it('跳板不让转发：说清楚，后面经它的主机不再去试', async () => {
    const jump = await fakeHost({ allowForward: false })
    const [a, b] = await Promise.all([fakeHost(), fakeHost()])
    const p = pool()
    const first = await p.exec(hostSpec(a, { jumpHost: jumpOf(jump) }), 'echo hi', T)
    expect(first.error?.kind).toBe('forwarding_refused')
    expect(first.error?.message).toBe(JUMP_FORWARDING_REFUSED_MESSAGE)
    const second = await p.exec(hostSpec(b, { jumpHost: jumpOf(jump) }), 'echo hi', T)
    expect(second.error?.kind).toBe('forwarding_refused')
    expect(second.error?.message).toBe(JUMP_FORWARDING_REFUSED_MESSAGE)
    expect(jump.connections).toBe(1)
  })

  it('跳板密码不对：跳板失败，目标机一次都没碰', async () => {
    const jump = await fakeHost({ allowForward: true })
    const target = await fakeHost()
    const p = pool()
    const r = await p.exec(hostSpec(target, { jumpHost: jumpOf(jump, 'wrong') }), 'echo hi', T)
    expect(r.error?.kind).toBe('jump_failed')
    expect(r.error?.message).toContain('跳板')
    expect(target.connections).toBe(0)
  })

  it('跳板名额满了，闲着的连接让位，不会干等闲置超时', async () => {
    const jump = await fakeHost({ allowForward: true })
    const targets = await Promise.all(Array.from({ length: 4 }, () => fakeHost()))
    const p = pool({ jumpForwardLimit: 1, idleCloseMs: 60_000 })
    const started = Date.now()
    for (const h of targets) {
      const r = await p.exec(hostSpec(h, { jumpHost: jumpOf(jump) }), 'echo ok', T)
      expect(r.output).toBe('ok\n')
    }
    expect(Date.now() - started).toBeLessThan(5000)
    expect(jump.peakTunnels).toBe(1)
  })
})

describe('跳板排队时的让位', () => {
  it('让位前留一小会儿：同一台紧接着的下一条命令接着用原连接，不重连', async () => {
    const jump = await fakeHost({ allowForward: true })
    const a = await fakeHost()
    const b = await fakeHost()
    const p = pool({ jumpForwardLimit: 1, idleCloseMs: 60_000, evictGraceMs: 400 })
    await p.exec(hostSpec(a, { jumpHost: jumpOf(jump) }), 'echo a1', T)
    const waiting = p.exec(hostSpec(b, { jumpHost: jumpOf(jump) }), 'echo b1', T)
    await new Promise(r => setTimeout(r, 50))
    const again = await p.exec(hostSpec(a, { jumpHost: jumpOf(jump) }), 'echo a2', T)
    expect(again.output).toBe('a2\n')
    expect((await waiting).output).toBe('b1\n')
    expect(a.connections).toBe(1)
    expect(jump.peakTunnels).toBe(1)
  })
})

describe('超时、按停、断线', () => {
  it('超时先发 KILL 信号：远程进程收到信号后结束，不靠硬关通道', async () => {
    const h = await fakeHost()
    const started = Date.now()
    const r = await pool().exec(hostSpec(h), 'hang', { timeoutMs: 200 })
    expect(r.timedOut).toBe(true)
    expect(r.error).toBeUndefined()
    expect(h.signals).toContain('KILL')
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('远程不理信号时，等一小会儿就把通道关掉，调用方照样拿到结果', async () => {
    const h = await fakeHost({ ignoreSignal: true })
    const started = Date.now()
    const r = await pool({ killGraceMs: 100 }).exec(hostSpec(h), 'hang', { timeoutMs: 200 })
    expect(r.timedOut).toBe(true)
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('主人停下：在跑的命令被终止，连接全部断开，之后不再接活', async () => {
    const h = await fakeHost()
    const p = pool()
    const running = p.exec(hostSpec(h), 'hang', { timeoutMs: 60_000 })
    await until(() => h.commands.includes('hang'))
    p.dispose()
    const r = await running
    expect(r.aborted).toBe(true)
    await until(() => h.open === 0)
    const after = await p.exec(hostSpec(h), 'echo hi', T)
    expect(after.error?.kind).toBe('aborted')
  })

  it('主人停下时排队等握手的也被放弃', async () => {
    const targets = await Promise.all(Array.from({ length: 4 }, () => fakeHost({ authDelayMs: 300 })))
    const p = pool({ handshakeLimit: 1 })
    const running = targets.map(h => p.exec(hostSpec(h), 'echo hi', T))
    await new Promise(r => setTimeout(r, 50))
    p.dispose()
    const results = await Promise.all(running)
    expect(results.every(r => r.error?.kind === 'aborted')).toBe(true)
    expect(p.stats().openConnections).toBe(0)
  })

  it('外部给的中止信号只终止这一条命令', async () => {
    const h = await fakeHost()
    const p = pool()
    const controller = new AbortController()
    const running = p.exec(hostSpec(h), 'hang', { timeoutMs: 60_000, signal: controller.signal })
    await until(() => h.commands.includes('hang'))
    controller.abort()
    expect((await running).aborted).toBe(true)
    expect((await p.exec(hostSpec(h), 'echo still-fine', T)).output).toBe('still-fine\n')
  })

  it('命令跑到一半连接断了：说连接断了，不装成正常结束', async () => {
    const h = await fakeHost()
    const r = await pool().exec(hostSpec(h), 'drop', T)
    expect(r.exitCode).toBeNull()
    expect(r.error?.kind).toBe('connection_lost')
  })
})

describe('按主人分池', () => {
  it('一位主人一个池，停下时只断自己的', async () => {
    const h = await fakeHost()
    const registry = new RemoteExecRegistry({ connectTimeoutMs: 5000 })
    const a = registry.poolFor('owner-a')
    const b = registry.poolFor('owner-b')
    expect(registry.poolFor('owner-a')).toBe(a)
    pools.push(a, b)
    await a.exec(hostSpec(h), 'echo a', T)
    await b.exec(hostSpec(h), 'echo b', T)
    expect(h.open).toBe(2)
    registry.disposeOwner('owner-a')
    await until(() => h.open === 1)
    expect((await b.exec(hostSpec(h), 'echo b2', T)).output).toBe('b2\n')
    expect(registry.hasPool('owner-a')).toBe(false)
    expect(registry.poolFor('owner-a')).not.toBe(a)
  })
})
