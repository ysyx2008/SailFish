import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { WorkerProcessLike, WorkerSessionOptions } from '../worker-session'
import { UtilityWorkerSession } from '../worker-session'

/**
 * 最新备份也读不开时，必须改试更早的备份，且不得发 dataCorrupted（那会触发全量重建）。
 */

const tmpDir = path.join(os.tmpdir(), 'sailfish-storage-restore-test')

const restoreCalls: Array<string | undefined> = []
const restoreOptions: Array<{ keepSnapshot?: boolean } | undefined> = []
const exhaustedMarks: number[] = []
/** 依次决定每次 restoreBackup 的成败；用完或为空时默认成功 */
const restoreOutcomes: boolean[] = []
const state = { exhausted: false }

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => tmpDir },
  utilityProcess: { fork: () => null }
}))

vi.mock('../backup', () => ({
  hasCorruptionMarker: () => true,
  isRestoreExhausted: () => state.exhausted,
  markRestoreExhausted: () => { exhaustedMarks.push(Date.now()) },
  clearRestoreExhausted: () => {},
  adoptLegacyBrokenSnapshots: () => {},
  listBackups: () => [
    { name: 'auto-newer', path: '/backups/newer', createdAt: 2, sizeBytes: 1, automatic: true },
    { name: 'auto-older', path: '/backups/older', createdAt: 1, sizeBytes: 1, automatic: true }
  ],
  restoreBackup: (backupPath?: string, options?: { keepSnapshot?: boolean }) => {
    restoreCalls.push(backupPath)
    restoreOptions.push(options)
    const ok = restoreOutcomes.length ? restoreOutcomes.shift() : true
    return ok
      ? { success: true, backupPath: backupPath || '/backups/newer' }
      : { success: false, error: '备份内容不完整' }
  }
}))

const { VectorStorage } = await import('../storage')

class FakeWorker implements WorkerProcessLike {
  killed = false
  exited = false
  initializeEvents: Array<{ name: string; args: any[] }> = []
  private messageListeners: Array<(m: any) => void> = []
  private exitListeners: Array<(code: number | null) => void> = []

  get alive(): boolean {
    return !this.killed && !this.exited
  }

  postMessage(message: any): void {
    queueMicrotask(() => {
      if (!this.alive) return
      if (message.type === 'initialize') {
        this.reply(message.id, {
          success: true,
          result: { ok: true, events: this.initializeEvents }
        })
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
  private eventQueue: Array<Array<{ name: string; args: any[] }>> = []

  queueInitializeEvents(events: Array<{ name: string; args: any[] }>): void {
    this.eventQueue.push(events)
  }

  protected isWorkerModeAvailable(): boolean {
    return true
  }

  protected spawnSession(options: WorkerSessionOptions): UtilityWorkerSession {
    const proc = new FakeWorker()
    proc.initializeEvents = this.eventQueue.shift() ?? []
    this.spawned.push(proc)
    return UtilityWorkerSession.spawn({
      ...options,
      scriptPath: process.cwd(),
      fork: () => proc
    })
  }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 10))

describe('VectorStorage 恢复读不开时改试更早备份', () => {
  let originalProcessType: unknown

  beforeAll(() => {
    originalProcessType = (process as any).type
    ;(process as any).type = 'browser'
  })

  afterAll(() => {
    ;(process as any).type = originalProcessType
  })

  beforeEach(() => {
    restoreCalls.length = 0
    restoreOptions.length = 0
    exhaustedMarks.length = 0
    restoreOutcomes.length = 0
    state.exhausted = false
    const markerDir = path.join(tmpDir, 'knowledge', 'lancedb')
    fs.mkdirSync(markerDir, { recursive: true })
    fs.writeFileSync(path.join(markerDir, '.corrupted'), '{"reason":"test"}')
  })

  it('最新备份读不开则改用更早的，且不发 dataCorrupted', async () => {
    const storage = new TestVectorStorage()
    storage.queueInitializeEvents([{ name: 'indexUnreadable', args: [] }])
    storage.queueInitializeEvents([])

    const corrupted: string[] = []
    const unreadable: string[] = []
    storage.on('dataCorrupted', () => corrupted.push('yes'))
    storage.on('indexUnreadable', () => unreadable.push('yes'))

    await storage.initialize(384)
    await flush()

    expect(restoreCalls).toContain('/backups/newer')
    expect(restoreCalls).toContain('/backups/older')
    expect(corrupted).toHaveLength(0)
    expect(unreadable).toHaveLength(0)
    expect(storage.spawned).toHaveLength(2)
  })

  it('试更早的备份时不再留现场——换下来的是上一份备份的副本', async () => {
    const storage = new TestVectorStorage()
    storage.queueInitializeEvents([{ name: 'indexUnreadable', args: [] }])
    storage.queueInitializeEvents([])

    await storage.initialize(384)
    await flush()

    const olderCall = restoreCalls.indexOf('/backups/older')
    expect(restoreOptions[olderCall]?.keepSnapshot).toBe(false)
  })

  it('上次已判定这批备份都救不回来时，这次启动一份都不碰', async () => {
    state.exhausted = true
    const storage = new TestVectorStorage()
    storage.queueInitializeEvents([{ name: 'indexUnreadable', args: [] }])

    await storage.initialize(384)
    await flush()

    expect(restoreCalls).toHaveLength(0)
  })

  it('最新那份没恢复成时，接着试更早的仍要留档——那还是用户原始数据', async () => {
    restoreOutcomes.push(false)
    const storage = new TestVectorStorage()
    storage.queueInitializeEvents([{ name: 'indexUnreadable', args: [] }])
    storage.queueInitializeEvents([])

    await storage.initialize(384)
    await flush()

    const olderCall = restoreCalls.indexOf('/backups/older')
    expect(olderCall).toBeGreaterThanOrEqual(0)
    expect(restoreOptions[olderCall]?.keepSnapshot).toBe(true)
  })

  it('一份都救不回来时记下结论，供下次启动跳过', async () => {
    const storage = new TestVectorStorage()
    storage.queueInitializeEvents([{ name: 'indexUnreadable', args: [] }])
    storage.queueInitializeEvents([{ name: 'indexUnreadable', args: [] }])

    await storage.initialize(384)
    await flush()

    expect(exhaustedMarks).toHaveLength(1)
  })

  it('所有备份都读不开时发 indexUnreadable，仍不清表', async () => {
    const storage = new TestVectorStorage()
    storage.queueInitializeEvents([{ name: 'indexUnreadable', args: [] }])
    storage.queueInitializeEvents([{ name: 'indexUnreadable', args: [] }])

    const corrupted: string[] = []
    const unreadable: string[] = []
    storage.on('dataCorrupted', () => corrupted.push('yes'))
    storage.on('indexUnreadable', () => unreadable.push('yes'))

    await storage.initialize(384)
    await flush()

    expect(corrupted).toHaveLength(0)
    expect(unreadable).toHaveLength(1)
    expect(fs.existsSync(path.join(tmpDir, 'knowledge', 'lancedb', '.corrupted'))).toBe(true)
  })
})
