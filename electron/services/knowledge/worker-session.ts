/**
 * utilityProcess RPC 会话
 *
 * 一个实例代表一个 worker 进程的完整生命周期：进程句柄、请求队列、消息 id
 * 都属于实例自身。因此「上一代进程退出」只会清算它自己的账，不会把刚拉起的
 * 新一代的引用抹成 null、也不会把新一代正在进行的请求判成失败。
 *
 * 这一点是硬要求而非风格问题：utilityProcess 的 kill 是异步生效的，旧进程的
 * exit 事件常常在新进程已经建立之后才到达。若进程句柄与请求队列由服务对象
 * 单槽共享，旧进程的死讯会让新进程失去唯一引用——它还活着、还占着几百 MB，
 * 但再也无法被回收，只能等应用内存耗尽。
 */
import * as fs from 'fs'
import { ChunkTextDecoder } from '../../utils/encoding'

export interface WorkerProcessLike {
  postMessage(message: unknown): void
  kill(): boolean | void
  on(event: 'message', listener: (message: any) => void): void
  on(event: 'exit', listener: (code: number | null) => void): void
  stdout?: { on(event: 'data', listener: (chunk: Buffer) => void): void } | null
  stderr?: { on(event: 'data', listener: (chunk: Buffer) => void): void } | null
}

export type WorkerForkFn = (
  scriptPath: string,
  env: NodeJS.ProcessEnv
) => WorkerProcessLike | null

export interface WorkerSessionLogger {
  info: (...args: any[]) => void
  warn: (...args: any[]) => void
}

export interface WorkerSessionOptions {
  scriptPath: string
  env: NodeJS.ProcessEnv
  /** 日志与错误信息里用于区分 worker 种类，如 Embedding / LanceDB */
  label: string
  defaultTimeoutMs: number
  log: WorkerSessionLogger
  /** 测试注入用；缺省走 electron 的 utilityProcess.fork */
  fork?: WorkerForkFn
}

interface PendingCall {
  resolve: (value: any) => void
  reject: (reason: Error) => void
  timer: NodeJS.Timeout
}

export function forkUtilityProcess(
  scriptPath: string,
  env: NodeJS.ProcessEnv
): WorkerProcessLike | null {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { utilityProcess } = require('electron')
  return utilityProcess.fork(scriptPath, [], { env, stdio: 'pipe' })
}

export class UtilityWorkerSession {
  private static generationSeq = 0

  /** 递增世代号，仅用于日志排查「谁杀了谁」 */
  readonly generation: number
  private readonly label: string
  private readonly defaultTimeoutMs: number
  private readonly log: WorkerSessionLogger

  private proc: WorkerProcessLike | null
  private readonly pending = new Map<number, PendingCall>()
  private nextMessageId = 0
  private readonly exitListeners: Array<(code: number | null) => void> = []

  private constructor(proc: WorkerProcessLike, options: WorkerSessionOptions) {
    this.generation = ++UtilityWorkerSession.generationSeq
    this.label = options.label
    this.defaultTimeoutMs = options.defaultTimeoutMs
    this.log = options.log
    this.proc = proc

    proc.on('message', (message: any) => this.onMessage(message))

    const stdoutText = new ChunkTextDecoder('utf-8')
    const stderrText = new ChunkTextDecoder('utf-8')
    const writeLog = (decoder: ChunkTextDecoder, chunk: Buffer | undefined, warn: boolean) => {
      const text = (chunk ? decoder.push(chunk) : decoder.end()).trim()
      if (!text) return
      if (warn) this.log.warn('[worker]', text)
      else this.log.info('[worker]', text)
    }
    proc.stdout?.on('data', (chunk: Buffer) => writeLog(stdoutText, chunk, false))
    proc.stderr?.on('data', (chunk: Buffer) => writeLog(stderrText, chunk, true))

    proc.on('exit', (code: number | null) => {
      writeLog(stdoutText, undefined, false)
      writeLog(stderrText, undefined, true)
      this.proc = null
      this.rejectAllPending(new Error(`${this.label} worker exited with code ${code}`))
      for (const listener of this.exitListeners) {
        try {
          listener(code)
        } catch (e) {
          this.log.warn(`${this.label} worker exit 回调异常：`, e)
        }
      }
    })
  }

  /**
   * fork 一个新 worker 进程并建立会话。
   * 脚本缺失或 fork 不可用（CLI / 测试环境返回 null）时抛错，由调用方决定降级。
   */
  static spawn(options: WorkerSessionOptions): UtilityWorkerSession {
    if (!fs.existsSync(options.scriptPath)) {
      throw new Error(`${options.label} worker 脚本不存在：${options.scriptPath}`)
    }

    const fork = options.fork ?? forkUtilityProcess
    const proc = fork(options.scriptPath, options.env)
    if (!proc) {
      throw new Error(
        `utilityProcess.fork 返回 null（可能运行在 CLI/测试环境）`
      )
    }

    return new UtilityWorkerSession(proc, options)
  }

  get isAlive(): boolean {
    return this.proc !== null
  }

  /** 注册退出通知。调用方需自行判断退出的是否仍是它当前持有的会话。 */
  onExit(listener: (code: number | null) => void): void {
    this.exitListeners.push(listener)
  }

  call<T = any>(type: string, data?: any, timeoutMs?: number): Promise<T> {
    const proc = this.proc
    if (!proc) {
      return Promise.reject(new Error(`${this.label} worker 未启动`))
    }

    const id = ++this.nextMessageId
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`${this.label} worker 调用超时（type=${type}）`))
        }
      }, timeoutMs ?? this.defaultTimeoutMs)

      this.pending.set(id, { resolve, reject, timer })

      try {
        proc.postMessage({ id, type, data })
      } catch (e) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })
  }

  /** 杀掉本会话的进程，并让本会话未完成的请求立即失败。 */
  kill(): void {
    const proc = this.proc
    this.proc = null
    if (proc) {
      try {
        proc.kill()
      } catch (e) {
        this.log.warn(`kill ${this.label} worker 失败：`, e)
      }
    }
    this.rejectAllPending(new Error(`${this.label} worker terminated`))
  }

  private onMessage(message: any): void {
    if (!message || typeof message.id !== 'number') return
    const call = this.pending.get(message.id)
    if (!call) return
    this.pending.delete(message.id)
    clearTimeout(call.timer)

    if (message.success) {
      call.resolve(message.result)
    } else {
      const err = new Error(message.error || `${this.label} worker error`)
      if (message.stack) (err as any).workerStack = message.stack
      call.reject(err)
    }
  }

  private rejectAllPending(error: Error): void {
    if (this.pending.size === 0) return
    for (const [, call] of this.pending) {
      clearTimeout(call.timer)
      call.reject(error)
    }
    this.pending.clear()
  }
}
