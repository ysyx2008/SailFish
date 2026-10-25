/**
 * 用本机真 sshd 验证：超时 / 按停之后，远程进程到底有没有消失。
 * 假主机验证不了这件事。需要本机有 /usr/sbin/sshd；默认不跑，设 SFT_REAL_SSHD=1 才跑。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { RemoteExecPool } from '../remote-exec-pool'
import type { RemoteHost } from '../remote-host'
import { hasRealSshd, localProcessExists, startRealSshds, type RealSshdFleet } from './real-sshd'

vi.mock('../../../utils/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))

const enabled = process.env.SFT_REAL_SSHD === '1' && hasRealSshd()

async function until(cond: () => Promise<boolean>, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await cond()) return true
    await new Promise(r => setTimeout(r, 100))
  }
  return cond()
}

describe.skipIf(!enabled)('真 sshd：终止后远程进程是否消失', () => {
  let fleet: RealSshdFleet
  let host: RemoteHost

  beforeAll(async () => {
    fleet = await startRealSshds(1)
    const h = fleet.hosts[0]!
    host = {
      id: 'real', name: 'real', host: '127.0.0.1', port: h.port, username: h.username,
      privateKeyPath: h.privateKeyPath, encoding: 'utf-8',
    }
  })

  afterAll(async () => {
    await fleet?.stop()
  })

  // 标记放在 sleep 的秒数里（每条用例各用一个独特的数），pgrep 才不会匹配到测试自己
  const cases: Array<[string, string, string]> = [
    ['单个进程', 'sleep 31701', 'sleep 31701'],
    ['shell 里带子进程', 'sh -c "sleep 31702; echo done"', 'sleep 31702'],
    ['管道里的进程', 'sleep 31703 | cat', 'sleep 31703'],
    ['后台起的进程', 'sleep 31704 & wait', 'sleep 31704'],
  ]

  for (const pty of [false, true]) {
    for (const [label, command, marker] of cases) {
      const tag = pty ? '带伪终端' : '不带伪终端'
      it(`超时后：${label}（${tag}）`, async () => {
        const unique = `${marker}${pty ? '1' : '0'}`
        const cmd = command.replace(marker, unique)
        const pool = new RemoteExecPool({ connectTimeoutMs: 5000 })
        try {
          const started = Date.now()
          const r = await pool.exec(host, cmd, { timeoutMs: 800, pty })
          expect(r.timedOut).toBe(true)
          expect(Date.now() - started).toBeLessThan(5000)
          const gone = await until(async () => !(await localProcessExists(unique)))
          // 把结果写进断言信息，方便按实测决定要不要默认带伪终端
          expect(gone, `${label}（${tag}）超时后远程进程${gone ? '已消失' : '仍在'}`).toBe(true)
        } finally {
          pool.dispose()
          await new Promise(r => setTimeout(r, 100))
        }
      }, 15_000)
    }
  }

  it('按停：dispose 之后远程进程消失', async () => {
    const pool = new RemoteExecPool({ connectTimeoutMs: 5000 })
    const running = pool.exec(host, 'sleep 31799', { timeoutMs: 60_000 })
    expect(await until(() => localProcessExists('sleep 31799'))).toBe(true)
    pool.dispose()
    expect((await running).aborted).toBe(true)
    expect(await until(async () => !(await localProcessExists('sleep 31799')))).toBe(true)
  }, 15_000)
})
