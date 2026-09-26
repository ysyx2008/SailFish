/**
 * exec-manager.ts 单元测试
 *
 * 覆盖：spawn、wait（done/pattern/timeout/aborted）、kill、自动清理、ring buffer
 *
 * 注：测试直接 spawn shell 命令（echo / sleep / yes），需要 POSIX 环境。
 * Windows CI 上某些 case 会被 skip。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { getExecManager, type BackgroundExecTask } from '../tools/exec-manager'

const isWin = process.platform === 'win32'
const itPosix = isWin ? it.skip : it

describe('BackgroundExecManager', () => {
  let mgr: ReturnType<typeof getExecManager>

  beforeEach(() => {
    mgr = getExecManager()
    mgr._resetForTest()
  })

  afterEach(() => {
    mgr._resetForTest()
  })

  describe('spawn 基础行为', () => {
    itPosix('立即可拿到 task_id 和 pid', () => {
      const task = mgr.spawn({ command: 'sleep 0.1', maxSeconds: 10 })
      expect(task.taskId).toBe('exec-1')
      expect(task.child.pid).toBeGreaterThan(0)
      expect(task.status).toBe('running')
    })

    itPosix('多个 task 自增 ID', () => {
      const t1 = mgr.spawn({ command: 'echo 1', maxSeconds: 10 })
      const t2 = mgr.spawn({ command: 'echo 2', maxSeconds: 10 })
      expect(t1.taskId).toBe('exec-1')
      expect(t2.taskId).toBe('exec-2')
    })
  })

  describe('wait — done', () => {
    itPosix('短命令在 wait 内结束 → done', async () => {
      const task = mgr.spawn({ command: 'echo hello', maxSeconds: 10 })
      const reason = await mgr.wait({ task, waitSeconds: 5 })
      expect(reason).toBe('done')
      const snap = mgr.snapshot(task)
      expect(snap.status).toBe('completed')
      expect(snap.exitCode).toBe(0)
      expect(snap.output).toContain('hello')
    })

    itPosix('exit code 非 0 → status=failed', async () => {
      const task = mgr.spawn({ command: 'exit 42', maxSeconds: 10 })
      await mgr.wait({ task, waitSeconds: 5 })
      const snap = mgr.snapshot(task)
      expect(snap.status).toBe('failed')
      expect(snap.exitCode).toBe(42)
    })
  })

  describe('wait — timeout（转后台）', () => {
    itPosix('超过 wait 仍未结束 → timeout，任务继续运行', async () => {
      const task = mgr.spawn({ command: 'sleep 3', maxSeconds: 10 })
      const reason = await mgr.wait({ task, waitSeconds: 1 })
      expect(reason).toBe('timeout')
      const snap = mgr.snapshot(task)
      expect(snap.status).toBe('running')
      // 后续二次 wait 应能等到结束
      const reason2 = await mgr.wait({ task, waitSeconds: 5 })
      expect(reason2).toBe('done')
    })
  })

  describe('wait — pattern', () => {
    itPosix('pattern 命中即返回，任务继续运行', async () => {
      // 输出"hello"后 sleep 5 秒（task 还在跑）
      const task = mgr.spawn({
        command: 'echo hello && sleep 5',
        maxSeconds: 30,
      })
      const reason = await mgr.wait({
        task,
        waitSeconds: 10,
        pattern: /hello/,
      })
      expect(reason).toBe('pattern')
      const snap = mgr.snapshot(task)
      expect(snap.status).toBe('running')
      expect(snap.output).toContain('hello')
      // 清理：杀掉它，避免拖慢后续测试
      mgr.kill(task.taskId, 'SIGKILL')
    })

    itPosix('立即检查：spawn 后 pattern 已经在初始 buffer 里也能命中', async () => {
      const task = mgr.spawn({ command: 'echo magic && sleep 2', maxSeconds: 10 })
      // 给它 100ms 让 echo 输出到 buffer，然后再 wait
      await new Promise(r => setTimeout(r, 200))
      const reason = await mgr.wait({
        task,
        waitSeconds: 10,
        pattern: /magic/,
      })
      expect(reason).toBe('pattern')
      mgr.kill(task.taskId, 'SIGKILL')
    })
  })

  describe('wait — aborted', () => {
    itPosix('isAborted 触发 → aborted，任务不被杀（继续在后台）', async () => {
      const task = mgr.spawn({ command: 'sleep 3', maxSeconds: 10 })
      let aborted = false
      const waitPromise = mgr.wait({
        task,
        waitSeconds: 10,
        isAborted: () => aborted,
      })
      setTimeout(() => { aborted = true }, 400)
      const reason = await waitPromise
      expect(reason).toBe('aborted')
      // 任务仍在运行（abort 不杀任务）
      expect(mgr.snapshot(task).status).toBe('running')
      mgr.kill(task.taskId, 'SIGKILL')
    })
  })

  describe('kill', () => {
    itPosix('SIGTERM 杀掉运行中任务 → status=killed', async () => {
      const task = mgr.spawn({ command: 'sleep 10', maxSeconds: 30 })
      // 等一下让 spawn 完成
      await new Promise(r => setTimeout(r, 100))
      const ok = mgr.kill(task.taskId)
      expect(ok).toBe(true)
      // 等待 exit 事件传到
      await mgr.wait({ task, waitSeconds: 5 })
      expect(mgr.snapshot(task).status).toBe('killed')
    })

    itPosix('已结束的任务 kill 返回 false', async () => {
      const task = mgr.spawn({ command: 'echo done', maxSeconds: 10 })
      await mgr.wait({ task, waitSeconds: 5 })
      const ok = mgr.kill(task.taskId)
      expect(ok).toBe(false)
    })
  })

  describe('用户按停', () => {
    const groupAlive = (pid: number): boolean => {
      try { process.kill(-pid, 0); return true } catch { return false }
    }

    itPosix('先像 Ctrl+C 喊停让命令收拾，不理的子进程到点整组强制结束；停掉的不再送回', async () => {
      const task = mgr.spawn({
        command: "trap 'echo cleaned; exit 3' INT; sleep 30 & wait",
        maxSeconds: 60,
      })
      await new Promise(r => setTimeout(r, 200))
      const listener = vi.fn()
      mgr.armFinishReport(task, listener)
      const pid = task.child.pid!
      expect(mgr.stop(task, 400)).toBe(true)
      await mgr.wait({ task, waitSeconds: 5 })
      expect(mgr.snapshot(task).output).toContain('cleaned')
      // shell 已退，后台 sleep 不理 Ctrl+C，组还在
      expect(groupAlive(pid)).toBe(true)
      await new Promise(r => setTimeout(r, 700))
      expect(groupAlive(pid)).toBe(false)
      expect(listener).not.toHaveBeenCalled()
    })

    itPosix('已结束的任务 stop 返回 false', async () => {
      const task = mgr.spawn({ command: 'echo done', maxSeconds: 10 })
      await mgr.wait({ task, waitSeconds: 5 })
      expect(mgr.stop(task, 100)).toBe(false)
    })
  })

  describe('max_seconds 安全网', () => {
    itPosix('超过 max_seconds 自动 SIGKILL', async () => {
      const task = mgr.spawn({ command: 'sleep 30', maxSeconds: 1 })
      // wait 长一点，让 max_seconds 触发
      const reason = await mgr.wait({ task, waitSeconds: 5 })
      expect(reason).toBe('done')
      expect(mgr.snapshot(task).status).toBe('killed')
    })
  })

  describe('ring buffer', () => {
    itPosix('大量输出超过 1MB 时只保留尾部', async () => {
      // 生成约 1.5MB 输出（POSIX 通用）
      const cmd = 'yes "x" | head -c 1500000'
      const task = mgr.spawn({ command: cmd, maxSeconds: 30 })
      await mgr.wait({ task, waitSeconds: 10 })
      const snap = mgr.snapshot(task)
      // ring buffer 上限 1MB，输出长度应该 ≤ 1MB
      expect(snap.output.length).toBeLessThanOrEqual(1_048_576)
      expect(snap.output.length).toBeGreaterThan(900_000)
    })
  })

  describe('list / get', () => {
    itPosix('list 返回所有任务快照', async () => {
      mgr.spawn({ command: 'echo a', maxSeconds: 10 })
      mgr.spawn({ command: 'echo b', maxSeconds: 10 })
      const tasks = mgr.list()
      expect(tasks.length).toBe(2)
      expect(tasks.map(t => t.taskId).sort()).toEqual(['exec-1', 'exec-2'])
    })

    itPosix('get 返回不存在的 task → undefined', () => {
      expect(mgr.get('exec-999')).toBeUndefined()
    })
  })

  describe('TOCTOU 竞态防护', () => {
    itPosix('立即结束的命令也能被 wait 捕获到 done（不会卡到 timeout）', async () => {
      // echo 极快结束，wait 调用瞬间命令已经退出。
      // 旧实现可能因为 exit 在 waiter 注册前触发，导致 wait 超时；
      // 修复后的二次检查应该能正确返回 done。
      const task = mgr.spawn({ command: 'echo fast', maxSeconds: 10 })
      // 给 spawn 一点时间让命令真的执行完
      await new Promise(r => setTimeout(r, 50))
      const start = Date.now()
      const reason = await mgr.wait({ task, waitSeconds: 5 })
      const elapsed = Date.now() - start
      expect(reason).toBe('done')
      // 不应该等到 5 秒（如果 TOCTOU 修复没生效，会等到 timer 超时）
      expect(elapsed).toBeLessThan(500)
    })
  })

  describe('并发 wait', () => {
    itPosix('多个 wait 同时等同一个 task，结束时全部收到 done', async () => {
      const task = mgr.spawn({ command: 'sleep 0.5 && echo done', maxSeconds: 10 })
      const [r1, r2, r3] = await Promise.all([
        mgr.wait({ task, waitSeconds: 5 }),
        mgr.wait({ task, waitSeconds: 5 }),
        mgr.wait({ task, waitSeconds: 5 }),
      ])
      expect(r1).toBe('done')
      expect(r2).toBe('done')
      expect(r3).toBe('done')
    })

    itPosix('多个 wait 不同 pattern，各自命中', async () => {
      // 输出 alpha → 1s → beta → 结束
      const task = mgr.spawn({
        command: 'echo alpha && sleep 1 && echo beta',
        maxSeconds: 30,
      })
      const [r1, r2] = await Promise.all([
        mgr.wait({ task, waitSeconds: 10, pattern: /alpha/ }),
        mgr.wait({ task, waitSeconds: 10, pattern: /beta/ }),
      ])
      expect(r1).toBe('pattern')
      expect(r2).toBe('pattern')
    })
  })

  describe('ReDoS 防护：pattern 仅扫描尾部', () => {
    itPosix('1.5MB 输出 + 简单 pattern 仍能命中（pattern 扫描限额不影响正常命中）', async () => {
      // yes 持续输出 'x'，再 echo magic，再 sleep 一会儿
      // 关键：magic 出现在尾部，应该能被 100KB 尾部扫描覆盖
      const task = mgr.spawn({
        command: 'yes "x" | head -c 1000000 && echo magic && sleep 5',
        maxSeconds: 30,
      })
      const reason = await mgr.wait({
        task,
        waitSeconds: 15,
        pattern: /magic/,
      })
      expect(reason).toBe('pattern')
      mgr.kill(task.taskId, 'SIGKILL')
    })
  })

  describe('RingBuffer chunk 数组实现', () => {
    itPosix('append 多次后 toString 应正确拼接', async () => {
      // 通过 spawn 间接验证（chunks 是 private）：连续小输出
      const task = mgr.spawn({
        command: 'for i in 1 2 3 4 5; do echo "line$i"; done',
        maxSeconds: 10,
      })
      await mgr.wait({ task, waitSeconds: 5 })
      const snap = mgr.snapshot(task)
      for (const i of [1, 2, 3, 4, 5]) {
        expect(snap.output).toContain(`line${i}`)
      }
    })

    itPosix('snapshot 多次调用 toString 缓存有效（不应抛错）', async () => {
      const task = mgr.spawn({ command: 'echo cached', maxSeconds: 10 })
      await mgr.wait({ task, waitSeconds: 5 })
      const s1 = mgr.snapshot(task).output
      const s2 = mgr.snapshot(task).output
      expect(s1).toBe(s2)
      expect(s1).toContain('cached')
    })
  })

  describe('wait — 用户插话', () => {
    itPosix('shouldYield 触发 → user_message，任务继续跑', async () => {
      const task = mgr.spawn({ command: 'sleep 3', maxSeconds: 10 })
      let yieldNow = false
      const waitPromise = mgr.wait({
        task,
        waitSeconds: 10,
        shouldYield: () => yieldNow,
      })
      setTimeout(() => { yieldNow = true }, 300)
      const reason = await waitPromise
      expect(reason).toBe('user_message')
      expect(mgr.snapshot(task).status).toBe('running')
      mgr.kill(task.taskId, 'SIGKILL')
    })
  })

  describe('结束送回', () => {
    itPosix('挂上送回且没人在等 → 进程结束后调用', async () => {
      const task = mgr.spawn({ command: 'echo finished-report', maxSeconds: 10 })
      const snap = await new Promise<ReturnType<typeof mgr.snapshot>>((resolve) => {
        mgr.armFinishReport(task, resolve)
      })
      expect(snap.status).toBe('completed')
      expect(snap.output).toContain('finished-report')
      expect(mgr.isFinishReportConsumed(task)).toBe(false)
    })

    itPosix('有人等到结束 → 不再送回', async () => {
      const task = mgr.spawn({ command: 'sleep 0.4', maxSeconds: 10 })
      let called = false
      mgr.armFinishReport(task, () => { called = true })
      const reason = await mgr.wait({ task, waitSeconds: 5 })
      expect(reason).toBe('done')
      await new Promise(r => setTimeout(r, 50))
      expect(called).toBe(false)
      expect(mgr.isFinishReportConsumed(task)).toBe(true)
    })
  })

  describe('snapshot 字段完整性', () => {
    itPosix('结束后 snapshot 包含所有期望字段', async () => {
      const task = mgr.spawn({ command: 'echo test', maxSeconds: 10 })
      await mgr.wait({ task, waitSeconds: 5 })
      const snap: BackgroundExecTask | undefined = mgr.get(task.taskId)
      expect(snap).toBeDefined()
      const s = mgr.snapshot(snap!)
      expect(s.taskId).toBe('exec-1')
      expect(s.command).toBe('echo test')
      expect(s.pid).toBeGreaterThan(0)
      expect(s.status).toBe('completed')
      expect(s.exitCode).toBe(0)
      expect(s.signal).toBeNull()
      expect(s.startedAt).toBeGreaterThan(0)
      expect(s.finishedAt).toBeGreaterThanOrEqual(s.startedAt)
      expect(s.output).toContain('test')
    })
  })
})
