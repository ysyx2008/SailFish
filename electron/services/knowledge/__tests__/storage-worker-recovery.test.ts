import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import * as os from 'os'
import * as path from 'path'
import type { WorkerProcessLike, WorkerSessionOptions } from '../worker-session'
import { UtilityWorkerSession } from '../worker-session'

/**
 * 向量库 worker 掉线后的自愈：曾经掉一次就「记忆突然什么都搜不到」，
 * 且没有任何提示，只能重启应用。
 */

const tmpDir = path.join(os.tmpdir(), 'sailfish-storage-test')

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => tmpDir },
  utilityProcess: { fork: () => null }
}))

const { VectorStorage } = await import('../storage')

class FakeWorker implements WorkerProcessLike {
  killed = false
  exited = false
  failInitialize = false
  /** 收到的请求类型，用来确认请求真的发到了 worker */
  received: string[] = []
  private messageListeners: Array<(m: any) => void> = []
  private exitListeners: Array<(code: number | null) => void> = []

  get alive(): boolean {
    return !this.killed && !this.exited
  }

  postMessage(message: any): void {
    this.received.push(message.type)
    queueMicrotask(() => {
      if (!this.alive) return
      if (message.type === 'initialize') {
        this.reply(message.id, this.failInitialize
          ? { success: false, error: '建库失败' }
          : { success: true, result: { ok: true, events: [] } })
      } else if (message.type === 'getStats') {
        this.reply(message.id, {
          success: true,
          result: { stats: { documentCount: 1, chunkCount: 2, totalSize: null, lastUpdated: 0 } }
        })
      } else if (message.type === 'addRecord') {
        this.reply(message.id, { success: true, result: { id: 'rec-1' } })
      } else {
        this.reply(message.id, { success: true, result: {} })
      }
    })
  }

  kill(): void {
    this.killed = true
    setTimeout(() => this.emitExit(0), 0)
  }

  on(event: 'message' | 'exit', listener: any): void {
    if (event === 'message') this.messageListeners.push(listener)
    else this.exitListeners.push(listener)
  }

  emitExit(code: number | null): void {
    this.exited = true
    for (const l of this.exitListeners) l(code)
  }

  private reply(id: number, payload: Record<string, unknown>): void {
    for (const l of this.messageListeners) l({ id, ...payload })
  }
}

class TestVectorStorage extends VectorStorage {
  readonly spawned: FakeWorker[] = []
  nextInitializeFails = false

  protected isWorkerModeAvailable(): boolean {
    return true
  }

  protected spawnSession(options: WorkerSessionOptions): UtilityWorkerSession {
    const proc = new FakeWorker()
    proc.failInitialize = this.nextInitializeFails
    this.spawned.push(proc)
    return UtilityWorkerSession.spawn({
      ...options,
      scriptPath: process.cwd(),
      fork: () => proc
    })
  }

  get liveWorkers(): FakeWorker[] {
    return this.spawned.filter(p => p.alive)
  }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 5))

describe('VectorStorage worker 掉线自愈', () => {
  let originalProcessType: unknown

  beforeAll(() => {
    originalProcessType = (process as any).type
    ;(process as any).type = 'browser'
  })

  afterAll(() => {
    ;(process as any).type = originalProcessType
  })

  let storage: TestVectorStorage

  beforeEach(async () => {
    storage = new TestVectorStorage()
    await storage.initialize(384)
  })

  it('worker 掉线后下一次读写自动把它拉回来', async () => {
    storage.spawned[0].emitExit(1)
    await flush()

    const stats = await storage.getStats()

    expect(stats.chunkCount).toBe(2)
    expect(storage.spawned).toHaveLength(2)
    expect(storage.liveWorkers).toHaveLength(1)
  })

  it('掉线后写操作同样自愈，不再报「数据库未初始化」', async () => {
    storage.spawned[0].emitExit(1)
    await flush()

    await expect(
      storage.addRecord({
        id: 'r1', docId: 'd1', content: 'x', vector: [0.1],
        filename: 'f', hostId: 'h', tags: '', chunkIndex: 0, createdAt: 0
      })
    ).resolves.toBe('rec-1')
  })

  it('多路并发发现掉线时只重建一次', async () => {
    storage.spawned[0].emitExit(1)
    await flush()

    await Promise.all([
      storage.getStats(),
      storage.getStats(),
      storage.getStats(),
      storage.getAllDocIds(),
      storage.getChunkCount()
    ])

    expect(storage.spawned).toHaveLength(2)
    expect(storage.liveWorkers).toHaveLength(1)
  })

  it('重建失败时明确报错，不静默返回空结果', async () => {
    storage.spawned[0].emitExit(1)
    storage.nextInitializeFails = true
    await flush()

    await expect(storage.getStats()).rejects.toThrow()
    // 失败的半成品进程不许留着占内存
    expect(storage.liveWorkers).toHaveLength(0)
  })

  it('检索时 worker 拉不起来要报错，不能拿空结果冒充「没搜到」', async () => {
    storage.spawned[0].emitExit(1)
    storage.nextInitializeFails = true
    await flush()

    // 混合检索内部有兜底 catch，重建失败必须绕过它抛到调用方
    await expect(storage.hybridSearch('查询', [0.1, 0.2])).rejects.toThrow()
  })

  it('清库时 worker 不在就直接删，不为了删库先把它拉起来', async () => {
    storage.spawned[0].emitExit(1)
    await flush()

    await storage.clear()

    expect(storage.spawned).toHaveLength(1)
  })

  it('worker 掉线不影响就绪状态判断——它是可自愈的', async () => {
    expect(storage.isReady()).toBe(true)

    storage.spawned[0].emitExit(1)
    await flush()

    expect(storage.isReady()).toBe(true)
  })

  it('释放之后不再有人把 worker 拉起来', async () => {
    await storage.disposeAsync(10)
    await flush()

    expect(storage.liveWorkers).toHaveLength(0)

    // dispose 后的调用走进程内分支（无连接），不该悄悄 fork 新进程
    await storage.getStats().catch(() => {/* 预期失败或空结果 */})
    expect(storage.spawned).toHaveLength(1)
  })
})
