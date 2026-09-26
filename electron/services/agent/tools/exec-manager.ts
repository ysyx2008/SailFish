/**
 * 后台执行任务管理器
 *
 * 用于支持 exec 工具的"超时转后台"语义。使用 child_process.spawn 启动命令，
 * 挂载 stdout/stderr 监听器持续累积输出到 ring buffer。Agent 后续可以通过
 * await_exec 工具按 task_id 拉取最新输出、等待 pattern 匹配，或主动 kill
 * （`exec("kill <pid>")`）。
 *
 * 关键约束：
 * - 仅供 exec 工具使用（无 PTY 会话），不支持交互式命令
 * - 单个任务输出 ring buffer 上限 1MB（超过截断旧数据）
 * - 任务完成 5 分钟后自动清理（给 Agent 充分时间 await）
 * - max_seconds 到达后 SIGKILL，防止 Agent 启了死循环忘了它
 * - 停一条命令要连它带出来的子进程一起停：POSIX 下每条命令自成进程组，信号发给整组
 */
import { spawn, ChildProcess } from 'child_process'
import { decodeBuffer } from '../../../utils/encoding'
import { resolveDefaultShell, getShellSpawnArgs } from '../../../utils/shell'
import { createLogger } from '../../../utils/logger'

const log = createLogger('ExecManager')

const RING_BUFFER_MAX = 1_048_576           // 1MB / 任务
const KEEP_AFTER_DONE_MS = 5 * 60 * 1000    // 完成后保留 5 分钟
/** Pattern 匹配时只扫描 buffer 尾部这么多字节（ReDoS 防护：限制最坏匹配时间） */
const PATTERN_SCAN_TAIL_BYTES = 100_000
/** Agent 提供的 pattern 长度上限（再叠加 RegExp 自身复杂度限制即可挡住绝大多数灾难性回溯） */
export const MAX_PATTERN_LENGTH = 200

export type ExecStatus = 'running' | 'completed' | 'failed' | 'killed'

/** 对外快照：纯数据，无进程引用 */
export interface BackgroundExecTaskSnapshot {
  taskId: string
  command: string
  pid: number | undefined
  status: ExecStatus
  startedAt: number
  finishedAt?: number
  exitCode: number | null
  signal: NodeJS.Signals | null
  /** 完整输出（stdout/stderr 合并按时序，超 1MB 截断旧的） */
  output: string
}

/**
 * Ring buffer：超过 maxLength 时丢弃最早的 chunk（保留尾部最新输出）。
 *
 * chunk 数组实现：每次 append 只 push（O(1)），超额时 shift 旧 chunk
 * 直到回到上限以下。toString() 才做一次 join——避免高频输出场景下
 * 每次 append 都做 O(n) 字符串拷贝（实测 npm run build 这类高频流式
 * 命令，旧实现会触发巨大 GC 压力）。
 */
class RingBuffer {
  private chunks: string[] = []
  private totalLen = 0
  /** toString 缓存：避免同一 buffer 多次 append/notify 之间反复 join */
  private cachedString: string | undefined
  constructor(private readonly maxLength: number) {}

  append(s: string): void {
    if (!s) return
    this.chunks.push(s)
    this.totalLen += s.length
    this.cachedString = undefined
    while (this.totalLen > this.maxLength && this.chunks.length > 0) {
      const removed = this.chunks.shift()!
      this.totalLen -= removed.length
    }
    // 单 chunk 超过上限：截断它本身，保留尾部
    if (this.totalLen > this.maxLength && this.chunks.length === 1) {
      const overflow = this.totalLen - this.maxLength
      this.chunks[0] = this.chunks[0].slice(overflow)
      this.totalLen = this.maxLength
    }
  }

  toString(): string {
    if (this.cachedString === undefined) {
      this.cachedString = this.chunks.join('')
    }
    return this.cachedString
  }

  /** 返回尾部 N 字节（ReDoS 防护：pattern 匹配时只对尾部扫描） */
  tailString(maxBytes: number): string {
    const full = this.toString()
    if (full.length <= maxBytes) return full
    return full.slice(full.length - maxBytes)
  }

  get length(): number { return this.totalLen }
}

interface InternalTask {
  taskId: string
  command: string
  child: ChildProcess
  buffer: RingBuffer
  startedAt: number
  finishedAt?: number
  status: ExecStatus
  exitCode: number | null
  signal: NodeJS.Signals | null
  killTimer?: NodeJS.Timeout
  cleanupTimer?: NodeJS.Timeout
  /** 等待者通知列表（数据到达 / 任务结束时触发） */
  waiters: Set<() => void>
  /**
   * 用户插话打断了等待：进程结束且没有人在等时，把结果送回那场对话。
   * 有人用 wait 拿到了结束，则 consume，不再另送。
   */
  finishListener?: (snap: BackgroundExecTaskSnapshot) => void
  finishConsumed?: boolean
  /** 结果已交给 listener、正在整理送回，还没 consume */
  finishReporting?: boolean
  reportTimer?: NodeJS.Timeout
  /** 用户按停后，收拾时间到了强制结束 */
  stopTimer?: NodeJS.Timeout
}

export type WaitReason = 'done' | 'pattern' | 'timeout' | 'aborted' | 'user_message'

export interface SpawnOptions {
  command: string
  cwd?: string
  /** 最长允许运行时间（秒），到点 SIGKILL */
  maxSeconds: number
  /** 额外注入的环境变量（合并到 process.env，用于技能 API Key 等敏感配置） */
  env?: Record<string, string>
}

export interface WaitOptions {
  task: InternalTask
  /** 最长等待时长（秒） */
  waitSeconds: number
  /** 命中即返回的正则 */
  pattern?: RegExp
  /** 外部取消信号（约 200ms 检查一次） */
  isAborted?: () => boolean
  /** 用户插了话：马上结束这次等待，进程继续跑 */
  shouldYield?: () => boolean
}

/** 用户插话要尽快让路，不能跟以前的 1 秒轮询一样慢 */
const WAIT_POLL_MS = 200
/** 用户按停：先像 Ctrl+C 那样喊停，给命令这么久收拾，再强制结束 */
const STOP_GRACE_MS = 3000

const IS_WINDOWS = process.platform === 'win32'

/**
 * 给命令和它带出来的子进程发信号。
 * POSIX：命令以独立进程组启动，发给整组；组已不在时退回只发给 shell。
 * Windows：没有进程组信号，强制结束时用 taskkill 连子进程一起结束。
 */
function signalTree(child: ChildProcess, signal: NodeJS.Signals): boolean {
  const pid = child.pid
  if (!pid) return false
  if (IS_WINDOWS) {
    if (signal === 'SIGKILL') {
      try {
        spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
          .on('error', () => { try { child.kill('SIGKILL') } catch { /* ignore */ } })
      } catch {
        try { child.kill('SIGKILL') } catch { /* ignore */ }
      }
      return true
    }
    try { child.kill(signal) } catch { /* ignore */ }
    return true
  }
  try {
    process.kill(-pid, signal)
  } catch {
    try { child.kill(signal) } catch { /* 进程可能已结束 */ }
  }
  return true
}

class BackgroundExecManager {
  private tasks = new Map<string, InternalTask>()
  private nextId = 1

  /**
   * 启动 shell 字符串命令（legacy exec 工具）
   */
  spawn(opts: SpawnOptions): InternalTask {
    // 统一走 utils/shell.ts：Windows 用 PowerShell -NoProfile -Command（而不是 spawn(cmd, {shell})），
    // 避免旧版 Windows 分支直接 spawn(command, {shell}) 导致 cmd.exe 行为不一致、
    // 管道/引号嵌套命令行为与 bash 完全不同的问题。
    const resolved = resolveDefaultShell()
    const spawnEnv = opts.env ? { ...process.env, ...opts.env } : process.env
    const child = spawn(resolved.path, getShellSpawnArgs(resolved.kind, opts.command), {
      cwd: opts.cwd,
      env: spawnEnv,
      // 自成进程组，停的时候才能连子进程一起停；Windows 上 detached 会弹新控制台，不用
      detached: !IS_WINDOWS,
    })

    return this.startTask({
      command: opts.command,
      child,
      cwd: opts.cwd,
      maxSeconds: opts.maxSeconds,
    })
  }

  private startTask(opts: {
    command: string
    child: ChildProcess
    cwd?: string
    maxSeconds: number
  }): InternalTask {
    const taskId = `exec-${this.nextId++}`
    const { child, command, maxSeconds } = opts

    const buffer = new RingBuffer(RING_BUFFER_MAX)
    const task: InternalTask = {
      taskId,
      command,
      child,
      buffer,
      startedAt: Date.now(),
      status: 'running',
      exitCode: null,
      signal: null,
      waiters: new Set(),
    }

    const onData = (chunk: Buffer) => {
      const text = decodeBuffer(chunk, true).content
      buffer.append(text)
      this.notifyWaiters(task)
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)

    child.on('exit', (code, signal) => {
      task.exitCode = code
      task.signal = signal
      task.finishedAt = Date.now()
      if (task.status === 'running') {
        task.status = signal ? 'killed' : (code === 0 ? 'completed' : 'failed')
      }
      if (task.killTimer) {
        clearTimeout(task.killTimer)
        task.killTimer = undefined
      }
      this.notifyWaiters(task)
      this.scheduleCleanup(task)
      this.scheduleFinishReport(task)
    })

    child.on('error', (err) => {
      log.warn(`exec ${taskId} spawn error: ${err.message}`)
      buffer.append(`\n[exec error] ${err.message}\n`)
      if (task.status === 'running') {
        task.status = 'failed'
        task.finishedAt = Date.now()
      }
      this.notifyWaiters(task)
      this.scheduleCleanup(task)
      this.scheduleFinishReport(task)
    })

    task.killTimer = setTimeout(() => {
      if (task.status === 'running') {
        log.info(`exec ${taskId} hit max_seconds (${maxSeconds}s), sending SIGKILL`)
        signalTree(child, 'SIGKILL')
      }
    }, maxSeconds * 1000)

    this.tasks.set(taskId, task)
    log.info(`exec ${taskId} started, pid=${child.pid}, cmd=${command.slice(0, 80)}`)
    return task
  }

  get(taskId: string): InternalTask | undefined {
    return this.tasks.get(taskId)
  }

  /**
   * 等待任务完成、命中 pattern、超时或被取消。
   *
   * 立即检查一次（任务可能已结束、pattern 可能已命中）；否则注册 waiter，
   * 在数据到达或任务结束时被通知。
   *
   * pattern 匹配仅扫描 buffer 尾部 PATTERN_SCAN_TAIL_BYTES（100KB），
   * 防止灾难性回溯 + 限制最坏匹配时间——即使 LLM 给了不太好的 regex 也不会卡死。
   */
  async wait(opts: WaitOptions): Promise<WaitReason> {
    const { task, waitSeconds, pattern, isAborted, shouldYield } = opts

    const matchPattern = (): boolean =>
      pattern ? pattern.test(task.buffer.tailString(PATTERN_SCAN_TAIL_BYTES)) : false

    const claimDone = (): WaitReason => {
      // 有人接到了结束：别再另送一遍结果
      this.consumeFinishReport(task)
      return 'done'
    }

    if (task.status !== 'running') return claimDone()
    if (matchPattern()) return 'pattern'
    if (isAborted?.()) {
      this.consumeFinishReport(task)
      return 'aborted'
    }
    if (shouldYield?.()) return 'user_message'

    return new Promise<WaitReason>((resolve) => {
      let settled = false
      const settle = (reason: WaitReason) => {
        if (settled) return
        settled = true
        task.waiters.delete(notify)
        clearTimeout(timer)
        if (poll) clearInterval(poll)
        if (reason === 'done' || reason === 'aborted') this.consumeFinishReport(task)
        resolve(reason)
      }
      const notify = () => {
        if (task.status !== 'running') return settle('done')
        if (matchPattern()) return settle('pattern')
      }
      task.waiters.add(notify)
      const timer = setTimeout(() => settle('timeout'), waitSeconds * 1000)
      // 取消和用户插话都没有事件源，短轮询。插话要比一秒更快让开对话。
      const poll: NodeJS.Timeout | undefined = (isAborted || shouldYield)
        ? setInterval(() => {
            if (isAborted?.()) return settle('aborted')
            if (shouldYield?.()) return settle('user_message')
          }, WAIT_POLL_MS)
        : undefined

      // TOCTOU 二次检查：进程可能在「立即检查」与「task.waiters.add」之间退出，
      // 那种情况下 exit 事件已经触发过 notifyWaiters，但当时 notify 还没注册，
      // 会一直等到 timer 超时。这里再检查一次状态/pattern，把这个边界关掉。
      if (task.status !== 'running') return settle('done')
      if (matchPattern()) return settle('pattern')
      if (isAborted?.()) return settle('aborted')
      if (shouldYield?.()) return settle('user_message')
    })
  }

  /**
   * 用户打断了等待。进程稍后结束、且没有人再用 wait 拿到结束时，调用 listener。
   * 再次调用会换掉上一个 listener（仍是同一条「结束了要送回」）。
   */
  armFinishReport(task: InternalTask, listener: (snap: BackgroundExecTaskSnapshot) => void): void {
    if (task.status !== 'running') return
    task.finishConsumed = false
    task.finishReporting = false
    task.finishListener = listener
  }

  /** 有人已经拿到结束，或这场被停掉：不要再把结果送回来。 */
  consumeFinishReport(task: InternalTask): void {
    task.finishConsumed = true
    task.finishListener = undefined
    if (task.reportTimer) {
      clearTimeout(task.reportTimer)
      task.reportTimer = undefined
    }
  }

  isFinishReportConsumed(task: InternalTask): boolean {
    return task.finishConsumed === true
  }

  /** 还欠那场对话一个结果：已登记送回、还没送也没人接到、任务还没被清理。 */
  isFinishReportPending(task: InternalTask): boolean {
    return (!!task.finishListener || task.finishReporting === true)
      && task.finishConsumed !== true
      && this.tasks.get(task.taskId) === task
  }

  private scheduleFinishReport(task: InternalTask): void {
    if (task.finishConsumed || !task.finishListener) return
    if (task.reportTimer) clearTimeout(task.reportTimer)
    // 宏任务：让正在 wait 的调用方先在微任务里 consume，避免和「等到了结束」各送一遍
    task.reportTimer = setTimeout(() => {
      task.reportTimer = undefined
      if (!this.tasks.has(task.taskId)) return
      if (task.finishConsumed || !task.finishListener) return
      const listener = task.finishListener
      task.finishListener = undefined
      task.finishReporting = true
      listener(this.snapshot(task))
    }, 0)
  }

  /**
   * 立刻给运行中的任务（连同子进程）发信号。返回是否实际发出信号。
   * 日常 kill 让 Agent 通过 `exec("kill <pid>")` 完成。
   */
  kill(taskId: string, signal: NodeJS.Signals = 'SIGTERM'): boolean {
    const task = this.tasks.get(taskId)
    if (!task || task.status !== 'running') return false
    return signalTree(task.child, signal)
  }

  /**
   * 用户按停：先像 Ctrl+C 那样喊停，收拾时间到了再强制结束整组。
   * 停掉的不再送回结果。返回是否确实在跑、发出了停止。
   */
  stop(task: InternalTask, graceMs: number = STOP_GRACE_MS): boolean {
    this.consumeFinishReport(task)
    if (task.status !== 'running') return false
    log.info(`exec ${task.taskId} stopped by user (pid=${task.child.pid})`)
    if (IS_WINDOWS) {
      // 没有 Ctrl+C 式的信号；shell 一退父子链就断，taskkill /T 找不到子进程，只能趁现在整树结束
      signalTree(task.child, 'SIGKILL')
      return true
    }
    signalTree(task.child, 'SIGINT')
    if (task.stopTimer) clearTimeout(task.stopTimer)
    // shell 先退了，组里可能还有不理 Ctrl+C 的子进程，到点照样整组强制结束
    task.stopTimer = setTimeout(() => {
      task.stopTimer = undefined
      signalTree(task.child, 'SIGKILL')
    }, graceMs)
    task.stopTimer.unref?.()
    return true
  }

  list(): BackgroundExecTaskSnapshot[] {
    return Array.from(this.tasks.values()).map(t => this.snapshot(t))
  }

  snapshot(task: InternalTask): BackgroundExecTaskSnapshot {
    return {
      taskId: task.taskId,
      command: task.command,
      pid: task.child.pid,
      status: task.status,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
      exitCode: task.exitCode,
      signal: task.signal,
      output: task.buffer.toString(),
    }
  }

  /**
   * 测试用：清掉所有 timer、SIGKILL 所有子进程、清空 Map。生产代码勿用。
   *
   * SIGKILL 是必要的：测试间残留的子进程会污染下一个测试的 PID/输出，
   * 也会让 vitest 整体挂起等不到 worker 退出。
   */
  _resetForTest(): void {
    for (const task of this.tasks.values()) {
      if (task.killTimer) clearTimeout(task.killTimer)
      if (task.cleanupTimer) clearTimeout(task.cleanupTimer)
      if (task.reportTimer) clearTimeout(task.reportTimer)
      if (task.stopTimer) clearTimeout(task.stopTimer)
      task.finishListener = undefined
      task.finishConsumed = true
      signalTree(task.child, 'SIGKILL')
    }
    this.tasks.clear()
    this.nextId = 1
  }

  private notifyWaiters(task: InternalTask): void {
    // 复制一份避免回调里 delete 影响迭代
    const snapshot = Array.from(task.waiters)
    for (const fn of snapshot) fn()
  }

  private scheduleCleanup(task: InternalTask): void {
    if (task.cleanupTimer) clearTimeout(task.cleanupTimer)
    task.cleanupTimer = setTimeout(() => {
      this.tasks.delete(task.taskId)
      log.info(`exec ${task.taskId} cleaned up after ${KEEP_AFTER_DONE_MS / 1000}s`)
    }, KEEP_AFTER_DONE_MS)
    // 让 cleanup timer 不阻塞进程退出
    task.cleanupTimer.unref?.()
  }

  /**
   * 进程退出钩子：杀掉所有运行中任务，避免孤儿。
   */
  killAllOnShutdown(): void {
    for (const task of this.tasks.values()) {
      if (task.status === 'running') signalTree(task.child, 'SIGTERM')
    }
  }
}

let instance: BackgroundExecManager | undefined

export function getExecManager(): BackgroundExecManager {
  if (!instance) {
    instance = new BackgroundExecManager()
    process.once('beforeExit', () => instance?.killAllOnShutdown())
  }
  return instance
}

// 仅导出类型供其他模块使用，不导出 InternalTask
export type { InternalTask as BackgroundExecTask }
