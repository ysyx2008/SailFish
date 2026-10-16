/**
 * LanceDB 向量存储服务
 *
 * 运行模式：
 *   - Worker 模式（Electron 主进程）：通过 utilityProcess（lancedb-worker.js）
 *     代理所有 LanceDB 调用，把 Rust/C++ 原生模块隔离出主线程，消除
 *     Windows 首次启动时 LoadLibrary 阻塞导致 UI 卡死的问题。
 *   - In-process 模式（CLI / worker 启动失败）：直接在当前进程内运行 LanceDB，
 *     与旧版行为完全一致，用于命令行工具和测试。
 */
import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import { EventEmitter } from 'events'
import type {
  SearchOptions,
  SearchResult,
  KnowledgeStats
} from './types'
import { getBM25Index, type BM25SearchResult } from './bm25'
import {
  restoreBackup as doRestoreBackup,
  listBackups,
  hasCorruptionMarker,
  isRestoreExhausted,
  markRestoreExhausted,
  clearRestoreExhausted,
  adoptLegacyBrokenSnapshots,
} from './backup'
import { createLogger } from '../../utils/logger'
import { UtilityWorkerSession, type WorkerSessionOptions } from './worker-session'
import { lanceEquals } from './lance-filter'
import type { NameVectorRecord, NameVectorUpdate } from './name-vectors'

const log = createLogger('KnowledgeStorage')

// LanceDB 记录类型
export interface VectorRecord {
  id: string
  docId: string
  content: string
  vector: number[]
  filename: string
  hostId: string
  tags: string  // 逗号分隔字符串（LanceDB 对空数组类型推断有问题）
  chunkIndex: number
  createdAt: number
}

// 兼容旧接口
export type OramaRecord = VectorRecord

// ────────────────────────── Worker 辅助函数 ──────────────────────────

function getWorkerScriptPath(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { app: electronApp } = require('electron')
    if (electronApp && electronApp.isPackaged) {
      return path.join(
        process.resourcesPath,
        'app.asar.unpacked',
        'dist-electron',
        'services',
        'knowledge',
        'lancedb-worker.js'
      )
    }
  } catch { /* 非 Electron 环境 */ }
  return path.join(process.cwd(), 'electron', 'services', 'knowledge', 'lancedb-worker.js')
}

function getUnpackedNodeModules(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { app: electronApp } = require('electron')
    if (electronApp && electronApp.isPackaged) {
      return path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules')
    }
  } catch { /* 非 Electron 环境 */ }
  return path.join(process.cwd(), 'node_modules')
}

function detectUtilityProcessAvailable(): boolean {
  try {
    if ((process as any).type !== 'browser') return false
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require('electron')
    return !!(electron && electron.utilityProcess && typeof electron.utilityProcess.fork === 'function')
  } catch {
    return false
  }
}

// ────────────────────────── In-process LanceDB 加载 ──────────────────────────

// 只在 in-process 降级路径下使用
let inProcLancedb: any = null

async function loadLanceDBInProc() {
  if (!inProcLancedb) {
    inProcLancedb = await import('@lancedb/lancedb')
  }
  return inProcLancedb
}

// 普通操作 2 分钟，全表扫描操作 5 分钟
const WORKER_TIMEOUT_MS = 2 * 60 * 1000
const WORKER_HEAVY_TIMEOUT_MS = 5 * 60 * 1000

// ────────────────────────── VectorStorage ──────────────────────────

export class VectorStorage extends EventEmitter {
  private storagePath: string
  private isInitialized: boolean = false
  private dimensions: number = 384

  // ── Worker 模式（Electron） ─────────────────────────────────────
  /** 当前在用的 worker 会话；换代时整体替换，旧会话自行清算，不共享请求队列 */
  private session: UtilityWorkerSession | null = null
  /** 当前会话是否已完成建库握手 */
  private workerReady: boolean = false
  /**
   * 本机是否采用 worker 模式。一旦确定就不再改变：worker 掉了要重新拉起，
   * 而不是改用主进程加载向量库（那会把 UI 堵死，也违背隔离设计）。
   */
  private workerMode: boolean = false
  /** 进行中的会话重建，供并发操作共享 */
  private workerReadyPromise: Promise<void> | null = null

  // ── In-process 模式（CLI / worker 启动失败） ────────────────────
  private db: any = null
  private table: any = null
  private nameTable: any = null
  private nameIndexBroken = false
  private corruptionMarkerPath: string
  private deleteCount = 0
  private lastCompactTime = 0

  constructor() {
    super()
    this.storagePath = path.join(app.getPath('userData'), 'knowledge', 'lancedb')
    this.corruptionMarkerPath = path.join(this.storagePath, '.corrupted')
    this.ensureDirectories()
  }

  private ensureDirectories(): void {
    if (!fs.existsSync(this.storagePath)) {
      fs.mkdirSync(this.storagePath, { recursive: true })
    }
  }

  // ────────────────────────── Worker 启停 / RPC ──────────────────────────

  /**
   * 建立 worker 会话的唯一出口。
   * 独立成方法是为了让掉线重建的时序能在没有 Electron 的环境下被验证。
   */
  protected spawnSession(options: WorkerSessionOptions): UtilityWorkerSession {
    return UtilityWorkerSession.spawn(options)
  }

  /** 本机是否具备 worker 模式（桌面端）；同样留出口供测试固定该判定 */
  protected isWorkerModeAvailable(): boolean {
    return detectUtilityProcessAvailable()
  }

  private async startWorker(): Promise<void> {
    if (this.session?.isAlive) return

    const unpackedNM = getUnpackedNodeModules()
    const workerEnv: NodeJS.ProcessEnv = { ...process.env }
    workerEnv.NODE_PATH = workerEnv.NODE_PATH
      ? `${unpackedNM}${path.delimiter}${workerEnv.NODE_PATH}`
      : unpackedNM

    // 清掉「进程已退出但引用还在」的上一代残留，避免它的未完成请求悬着
    this.killWorker()

    const session = this.spawnSession({
      scriptPath: getWorkerScriptPath(),
      env: workerEnv,
      label: 'LanceDB',
      defaultTimeoutMs: WORKER_TIMEOUT_MS,
      log
    })
    this.session = session

    session.onExit((code: number | null) => {
      log.info('LanceDB worker 退出，code=%s', code)
      // 只有退出的正是当前会话才清空引用：上一代的死讯不能抹掉新一代，
      // 否则新 worker 活着却再无人持有它，killWorker 也够不到。
      if (this.session === session) {
        this.session = null
        this.workerReady = false
      }
    })
  }

  private killWorker(): void {
    this.discardSession(this.session)
  }

  /**
   * 回收指定的那一代会话。只有它仍是当前会话时才清引用——
   * 否则会误杀别人刚建好的 worker（重建与 forceReinitialize 可能交错）。
   */
  private discardSession(session: UtilityWorkerSession | null): void {
    if (!session) return
    if (this.session === session) {
      this.session = null
      this.workerReady = false
    }
    session.kill()
  }

  private callWorker<T = any>(type: string, data?: any, timeoutMs = WORKER_TIMEOUT_MS): Promise<T> {
    const session = this.session
    if (!session?.isAlive) {
      return Promise.reject(new Error('LanceDB worker 未启动'))
    }
    return session.call<T>(type, data, timeoutMs)
  }

  /**
   * 读写操作的路由判定：worker 模式下顺便确保会话可用。
   *
   * worker 崩溃或被系统回收后，若继续沿用「已初始化」的旧结论，所有读写会落到
   * 没有数据库连接的进程内分支上——写报错、检索返回空，用户只看到「记忆突然搜
   * 不到了」。这里按需重建，重建不成就抛错，绝不静默返回空结果。
   */
  private async useWorkerPath(): Promise<boolean> {
    if (!this.workerMode) return false
    await this.ensureWorkerReady()
    return true
  }

  /** 确保当前有一个完成握手的 worker 会话；并发调用共享同一次重建 */
  private async ensureWorkerReady(): Promise<void> {
    if (this.workerReady && this.session?.isAlive) return

    const inFlight = this.workerReadyPromise
    if (inFlight) return inFlight

    const task = this.rebuildWorkerSession()
    this.workerReadyPromise = task
    try {
      await task
    } finally {
      if (this.workerReadyPromise === task) {
        this.workerReadyPromise = null
      }
    }
  }

  private async rebuildWorkerSession(): Promise<void> {
    log.warn('LanceDB worker 不可用，正在重新拉起...')
    await this.startWorker()

    // 记住自己这一代：清理只能针对它，期间可能有别人（如备份恢复）建起了新的
    const session = this.session

    try {
      const result = await this.callWorker<{
        ok: boolean
        events: Array<{ name: string; args: any[] }>
      }>('initialize', { storagePath: this.storagePath, dimensions: this.dimensions })

      // 等待期间可能已 dispose：这次重建的成果没人要了，别留下进程
      if (!this.workerMode) {
        throw new Error('LanceDB 已释放，本次 worker 重建作废')
      }

      for (const evt of result.events || []) {
        this.emit(evt.name, ...(evt.args || []))
      }

      this.workerReady = true
      log.info('LanceDB worker 已重新就绪（维度=%d）', this.dimensions)
    } catch (error) {
      // 握手失败的进程还活着（worker 只回错误不退出），没有别的路径会回收它
      this.discardSession(session)
      throw error
    }
  }

  // ────────────────────────── 初始化 ──────────────────────────

  async initialize(dimensions: number = 384): Promise<void> {
    if (this.isInitialized) return
    this.dimensions = dimensions

    // 老版本把现场散在数据目录根下且从不清理，先收编再走后面的流程
    adoptLegacyBrokenSnapshots()

    // 已标损坏：先从新到旧试备份。读得开才继续；都读不开也不清表。
    // 这批备份上次已经整个试过一遍且都救不回来的话就别再来——每试一份都要复制
    // 几百兆，结论却是注定的（见 SPEC「救不回来的时候，别把磁盘吃掉」）。
    const shouldTryRestore = hasCorruptionMarker() && !isRestoreExhausted()
    if (hasCorruptionMarker() && !shouldTryRestore) {
      log.warn('损坏标记仍在，但现有备份上次已全部试过且都读不开，跳过恢复')
    }
    const backups = shouldTryRestore ? listBackups() : []
    // 不能只把路径传空——restoreBackup 收到 undefined 会自己取最新那份，照跑不误
    let knowledgeIsBackupCopy = shouldTryRestore
      ? await this.tryRestoreFromBackupBeforeInit(backups[0]?.path)
      : false

    if (this.isWorkerModeAvailable()) {
      try {
        let events = await this.connectWorker(dimensions)

        if (this.eventsIndicateUnreadable(events) && backups.length > 1) {
          for (let i = 1; i < backups.length; i++) {
            log.warn(`恢复后仍无法读取，尝试更早的备份: ${backups[i].name}`)
            this.killWorker()
            // 只有确认此刻 knowledge/ 装的是上一份备份的副本才敢不留档；
            // 前面的恢复要是没做成，这里放着的仍是用户原始数据，必须留下来
            const restored = doRestoreBackup(backups[i].path, {
              keepSnapshot: !knowledgeIsBackupCopy,
            })
            if (!restored.success) {
              log.warn(`更早备份恢复失败: ${restored.error}`)
              continue
            }
            knowledgeIsBackupCopy = true
            try {
              events = await this.connectWorker(dimensions)
            } catch (e) {
              log.warn('使用更早备份初始化失败:', e)
              continue
            }
            if (!this.eventsIndicateUnreadable(events)) {
              log.info(`已用更早备份恢复: ${backups[i].path}`)
              clearRestoreExhausted()
              this.emit('restoredFromBackup', { backupPath: backups[i].path, reason: 'older-backup' })
              break
            }
          }
        }

        for (const evt of events) {
          this.emit(evt.name, ...(evt.args || []))
        }

        if (this.eventsIndicateUnreadable(events)) {
          this.markCorrupted('index unreadable after restore attempts')
          // 这批备份整个试过一遍仍读不开，记下来，下次启动不再重来。
          // 只有走到这里才有资格下这个结论——下面的 in-process 路径只试最新一份，
          // 试不成也说明不了「更早的那些也没救」。
          if (backups.length > 0) markRestoreExhausted()
        }

        this.workerMode = true
        this.workerReady = true
        this.isInitialized = true
        this.emit('initialized')
        log.info('LanceDB 已在 worker 进程中初始化（维度=%d）', dimensions)
        return
      } catch (error) {
        this.killWorker()
        const detail = error instanceof Error ? error.message : String(error)
        const err = new Error(
          `LanceDB worker 初始化失败（禁止回退主进程）：${detail}。` +
            `若为打包版，请检查 asarUnpack 是否包含 apache-arrow / reflect-metadata / tslib / flatbuffers。`,
        )
        log.error(err.message, error)
        throw err
      }
    }

    // CLI / shim：utilityProcess 不可用，进程内是唯一模式
    await this.initializeInProcess(dimensions)
  }

  private async connectWorker(dimensions: number): Promise<Array<{ name: string; args: any[] }>> {
    await this.startWorker()
    const result = await this.callWorker<{
      ok: boolean
      events: Array<{ name: string; args: any[] }>
    }>('initialize', { storagePath: this.storagePath, dimensions })
    return result.events || []
  }

  private eventsIndicateUnreadable(events: Array<{ name: string }>): boolean {
    return events.some(evt => evt.name === 'indexUnreadable')
  }

  /**
   * 启动前检查损坏标记：有则先恢复（可指定某一份备份）。
   * 恢复成功后删除标记。恢复失败保留标记，但不再清表。
   *
   * @returns 恢复是否做成了——做成了才意味着 knowledge/ 现在装的是备份副本，
   *          调用方据此决定后续换下来的东西还值不值得留档
   */
  private async tryRestoreFromBackupBeforeInit(backupPath?: string): Promise<boolean> {
    if (!fs.existsSync(this.corruptionMarkerPath)) return false

    let reason = 'unknown'
    try {
      const data = JSON.parse(fs.readFileSync(this.corruptionMarkerPath, 'utf-8'))
      reason = data?.reason || reason
    } catch { /* ignore */ }

    log.warn(`检测到损坏标记 (${reason})，尝试从备份恢复...`)

    try {
      const result = doRestoreBackup(backupPath)
      if (result.success) {
        log.info(`从备份恢复成功: ${result.backupPath}，删除损坏标记`)
        try { fs.unlinkSync(this.corruptionMarkerPath) } catch { /* ignore */ }
        clearRestoreExhausted()
        this.emit('restoredFromBackup', { backupPath: result.backupPath, reason })
        return true
      }
      log.warn(`从备份恢复失败: ${result.error}，保留现有表（不清空）`)
    } catch (e) {
      log.warn('调用 restoreBackup 异常，保留现有表（不清空）:', e)
    }
    return false
  }

  // ────────────────────────── In-process helpers ──────────────────────────

  private markCorrupted(reason: string): void {
    try {
      fs.writeFileSync(
        this.corruptionMarkerPath,
        JSON.stringify({ reason, at: Date.now() }),
        'utf-8'
      )
      log.warn('已标记向量表为损坏，将在下次启动时重建:', reason)
    } catch (e) {
      log.warn('写入损坏标记失败:', e)
    }
  }

  private consumeCorruptionMarker(): { corrupted: boolean; reason?: string } {
    if (!fs.existsSync(this.corruptionMarkerPath)) return { corrupted: false }
    let reason: string | undefined
    try {
      const data = JSON.parse(fs.readFileSync(this.corruptionMarkerPath, 'utf-8'))
      reason = data?.reason
    } catch { /* ignore */ }
    try { fs.unlinkSync(this.corruptionMarkerPath) } catch { /* ignore */ }
    return { corrupted: true, reason }
  }

  private isLanceCorruptionError(error: unknown): boolean {
    const msg = error instanceof Error ? error.message : String(error || '')
    if (!msg) return false
    return msg.includes('LanceError(IO)') && msg.includes('Not found')
  }

  private async ensureTableInProc(sampleRecord?: VectorRecord): Promise<void> {
    if (this.table) return

    try {
      const names = await this.db.tableNames()
      if (names.includes('knowledge_vectors')) {
        this.table = await this.db.openTable('knowledge_vectors')
        return
      }
    } catch (e) {
      log.warn('检查表是否存在失败，继续尝试创建:', e)
    }

    const isPlaceholder = !sampleRecord
    const recordToInsert: VectorRecord = sampleRecord ?? {
      id: '__init__',
      docId: '__init__',
      content: '',
      vector: new Array(this.dimensions).fill(0),
      filename: '',
      hostId: '',
      tags: '',
      chunkIndex: 0,
      createdAt: Date.now()
    }

    try {
      this.table = await this.db.createTable('knowledge_vectors', [recordToInsert])
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      if (msg.includes('already exists')) {
        log.warn('createTable 冲突（磁盘残留表），fallback 到 openTable')
        this.table = await this.db.openTable('knowledge_vectors')
        return
      }
      throw error
    }

    if (isPlaceholder) {
      await this.table.delete(lanceEquals('id', '__init__'))
    }
  }

  private async compactInProc(aggressive: boolean = false): Promise<void> {
    if (!this.table || !this.db) return
    try {
      if (typeof this.table.optimize === 'function') {
        await this.table.optimize(aggressive ? { cleanupOlderThan: new Date() } : undefined)
      } else if (typeof this.table.cleanup === 'function') {
        await this.table.cleanup()
      } else if (typeof this.table.compaction === 'function') {
        await this.table.compaction()
      }
      const names = await this.db.tableNames()
      if (names.includes('knowledge_vectors')) {
        this.table = await this.db.openTable('knowledge_vectors')
      }
    } catch (error) {
      log.error('Compact failed:', error)
    }
  }

  private async initializeInProcess(dimensions: number): Promise<void> {
    try {
      const { connect } = await loadLanceDBInProc()
      this.db = await connect(this.storagePath)

      const events: Array<{ name: string; args: any[] }> = []

      const corruption = this.consumeCorruptionMarker()
      if (corruption.corrupted) {
        log.warn('启动时仍有损坏标记（恢复未成功），保留现有表:', corruption.reason)
      }

      const tableNames = await this.db.tableNames()
      if (tableNames.includes('knowledge_vectors')) {
        this.table = await this.db.openTable('knowledge_vectors')

        // 检查维度
        const mismatch = await this.checkDimensionMismatchInProc(dimensions)
        if (mismatch === 'UNREADABLE') {
          events.push({ name: 'indexUnreadable', args: [] })
          this.markCorrupted('index unreadable after restore attempts')
        } else if (mismatch !== null) {
          log.info(`检测到向量维度变化 (${mismatch} -> ${dimensions})，自动清空旧索引...`)
          await this.db.dropTable('knowledge_vectors')
          this.table = null
          events.push({ name: 'dimensionMismatch', args: [{ old: mismatch, new: dimensions }] })
        }
      } else {
        this.table = null
      }

      for (const evt of events) {
        this.emit(evt.name, ...(evt.args || []))
      }

      this.isInitialized = true
      this.emit('initialized')
      log.info('LanceDB 在主进程内初始化完成（维度=%d，降级模式）', dimensions)
    } catch (error) {
      log.error('In-process LanceDB 初始化失败:', error)
      throw error
    }
  }

  private async checkDimensionMismatchInProc(expectedDimensions: number): Promise<number | 'UNREADABLE' | null> {
    if (!this.table) return null
    const maxRetries = 3
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const sample = await this.table.query().limit(1).toArray()
        if (sample.length === 0) return null
        const vectorLength = sample[0].vector?.length
        if (vectorLength && vectorLength !== expectedDimensions) return vectorLength
        return null
      } catch (error) {
        log.warn(`维度检查第 ${attempt}/${maxRetries} 次查询失败:`, error)
        if (attempt < maxRetries) await new Promise(r => setTimeout(r, 500 * attempt))
      }
    }
    log.warn('LanceDB 表数据无法读取，保留现有表（不清空）')
    return 'UNREADABLE'
  }

  // ────────────────────────── 公开 API（写操作） ──────────────────────────

  async addRecord(record: VectorRecord): Promise<string> {
    if (await this.useWorkerPath()) {
      const { id } = await this.callWorker<{ id: string }>('addRecord', { record })
      this.emit('recordAdded', id)
      return id
    }
    if (!this.db) throw new Error('数据库未初始化')
    await this.ensureTableInProc(record)
    await this.table.add([record])
    this.emit('recordAdded', record.id)
    return record.id
  }

  async addRecords(records: VectorRecord[]): Promise<string[]> {
    if (records.length === 0) return []
    if (await this.useWorkerPath()) {
      const { ids } = await this.callWorker<{ ids: string[] }>('addRecords', { records })
      this.emit('recordsAdded', ids)
      return ids
    }
    if (!this.db) throw new Error('数据库未初始化')
    await this.ensureTableInProc(records[0])
    await this.table!.add(records)
    const ids = records.map(r => r.id)
    this.emit('recordsAdded', ids)
    return ids
  }

  async removeRecord(id: string): Promise<boolean> {
    if (await this.useWorkerPath()) {
      const { removed } = await this.callWorker<{ removed: boolean }>('removeRecord', { id })
      if (removed) this.emit('recordRemoved', id)
      return removed
    }
    if (!this.table) return false
    try {
      await this.table.delete(lanceEquals('id', id))
      this.emit('recordRemoved', id)
      return true
    } catch {
      return false
    }
  }

  async removeDocumentChunks(docId: string, forceCompact: boolean = false): Promise<number> {
    if (await this.useWorkerPath()) {
      const { count } = await this.callWorker<{ count: number }>(
        'removeDocumentChunks', { docId, forceCompact }
      )
      if (count > 0) this.emit('documentRemoved', { docId, chunksRemoved: count })
      return count
    }
    if (!this.table) return 0
    try {
      const beforeCount = await this.table.countRows()
      await this.table.delete(lanceEquals('docId', docId))
      const afterCount = await this.table.countRows()
      const removed = beforeCount - afterCount

      if (removed > 0) {
        this.emit('documentRemoved', { docId, chunksRemoved: removed })
        this.deleteCount++
        if (forceCompact) {
          await this.compactInProc()
          this.deleteCount = 0
          this.lastCompactTime = Date.now()
        } else {
          this.compactIfNeededInProc().catch(e => log.warn('Compact failed:', e))
        }
      }
      return removed
    } catch (error) {
      log.error('Failed to remove chunks:', error)
      return 0
    }
  }

  private async compactIfNeededInProc(): Promise<void> {
    const now = Date.now()
    if (this.deleteCount >= 10 || (now - this.lastCompactTime) > 5 * 60 * 1000) {
      await this.compactInProc()
      this.deleteCount = 0
      this.lastCompactTime = now
    }
  }

  /** 删除文档的所有记录（别名） */
  async removeRecordsByDocId(docId: string): Promise<number> {
    return this.removeDocumentChunks(docId)
  }

  async compact(aggressive: boolean = false): Promise<void> {
    if (await this.useWorkerPath()) {
      await this.callWorker('compact', { aggressive })
      return
    }
    await this.compactInProc(aggressive)
  }

  isNameIndexBroken(): boolean {
    return this.nameIndexBroken
  }

  async listNameMeta(): Promise<{ id: string; kind: 'file' | 'folder'; text: string; folder: string; docId: string }[] | null> {
    if (this.nameIndexBroken) return null
    if (await this.useWorkerPath()) {
      const result = await this.callWorker<{ broken?: boolean; rows: { id: string; kind: 'file' | 'folder'; text: string; folder: string; docId: string }[] }>('nameList')
      if (result.broken) {
        this.nameIndexBroken = true
        return null
      }
      return result.rows || []
    }
    return this.listNameMetaInProc()
  }

  async searchNames(
    embedding: number[],
    limit = 10000,
  ): Promise<{ kind: 'file' | 'folder'; folder: string; docId?: string; score: number }[]> {
    if (this.nameIndexBroken || embedding.length === 0) return []
    if (await this.useWorkerPath()) {
      const result = await this.callWorker<{
        broken?: boolean
        hits: { kind: 'file' | 'folder'; folder: string; docId: string; score: number }[]
      }>('nameSearch', { embedding, limit })
      if (result.broken) {
        this.nameIndexBroken = true
        return []
      }
      return (result.hits || []).map(hit => ({
        kind: hit.kind,
        folder: hit.folder,
        docId: hit.docId || undefined,
        score: hit.score,
      }))
    }
    return this.searchNamesInProc(embedding, limit)
  }

  async applyNameEdits(edit: {
    removeIds: string[]
    updates: NameVectorUpdate[]
    inserts: NameVectorRecord[]
  }): Promise<void> {
    if (this.nameIndexBroken) return
    const inserts = edit.inserts.map(row => ({ ...row, docId: row.docId || '' }))
    if (await this.useWorkerPath()) {
      const result = await this.callWorker<{ broken?: boolean }>('nameApply', {
        removeIds: edit.removeIds,
        updates: edit.updates,
        inserts,
      })
      if (result.broken) this.nameIndexBroken = true
      return
    }
    await this.applyNameEditsInProc({ ...edit, inserts })
  }

  async removeNames(ids: string[]): Promise<void> {
    if (ids.length === 0) return
    await this.applyNameEdits({ removeIds: ids, updates: [], inserts: [] })
  }

  async clear(): Promise<void> {
    // 清库不为了删除先把 worker 拉起来：进程不在时文件句柄已释放，直接删目录即可。
    // （用户来清库往往正是因为库坏了、worker 起不来）
    if (this.workerMode) {
      if (this.workerReady && this.session?.isAlive) {
        await this.callWorker('dropTable')
      }
    } else if (this.db) {
      const names = await this.db.tableNames()
      if (names.includes('knowledge_names')) await this.db.dropTable('knowledge_names')
      if (names.includes('knowledge_vectors')) await this.db.dropTable('knowledge_vectors')
      this.table = null
      this.nameTable = null
      this.nameIndexBroken = false
    }

    // fs.rmSync 在主进程执行（worker 进程的文件句柄在 dropTable 后已释放）
    for (const dirName of ['knowledge_vectors.lance', 'knowledge_names.lance']) {
      const tablePath = path.join(this.storagePath, dirName)
      if (fs.existsSync(tablePath)) {
        fs.rmSync(tablePath, { recursive: true, force: true })
        log.info('已删除 LanceDB 数据目录:', tablePath)
      }
    }

    if (!this.workerMode) this.deleteCount = 0
    this.emit('cleared')
  }

  private markNameIndexBroken(error: unknown): void {
    log.warn('目录和文件名这张表读不开，这次自动翻阅改看正文:', error)
    this.nameIndexBroken = true
    this.nameTable = null
  }

  private async openNameTableInProc(): Promise<any> {
    if (this.nameIndexBroken || !this.db) return null
    if (this.nameTable) return this.nameTable
    let names: string[]
    try {
      names = await this.db.tableNames()
    } catch (error) {
      this.markNameIndexBroken(error)
      return null
    }
    if (!names.includes('knowledge_names')) return null
    try {
      const opened = await this.db.openTable('knowledge_names')
      const sample = await opened.query().select(['vector']).limit(1).toArray()
      const width = sample[0]?.vector?.length
      if (width && width !== this.dimensions) {
        await this.db.dropTable('knowledge_names')
        return null
      }
      this.nameTable = opened
      return this.nameTable
    } catch (error) {
      this.markNameIndexBroken(error)
      return null
    }
  }

  private async listNameMetaInProc() {
    try {
      const opened = await this.openNameTableInProc()
      if (this.nameIndexBroken) return null
      if (!opened) return []
      const rows = await opened.query().select(['id', 'kind', 'text', 'folder', 'docId']).toArray()
      return rows.map((row: { id: string; kind: 'file' | 'folder'; text: string; folder?: string; docId?: string }) => ({
        id: row.id,
        kind: row.kind,
        text: row.text,
        folder: row.folder || '',
        docId: row.docId || '',
      }))
    } catch (error) {
      this.markNameIndexBroken(error)
      return null
    }
  }

  private async searchNamesInProc(embedding: number[], limit: number) {
    try {
      const opened = await this.openNameTableInProc()
      if (this.nameIndexBroken || !opened) return []
      const hits = await opened
        .vectorSearch(embedding)
        .distanceType('cosine')
        .limit(limit)
        .select(['kind', 'folder', 'docId'])
        .toArray()
      return hits.map((row: { kind: 'file' | 'folder'; folder?: string; docId?: string; _distance?: number }) => ({
        kind: row.kind,
        folder: row.folder || '',
        docId: row.docId || undefined,
        score: 1 - (typeof row._distance === 'number' ? row._distance : 0),
      }))
    } catch (error) {
      this.markNameIndexBroken(error)
      return []
    }
  }

  private async applyNameEditsInProc(edit: {
    removeIds: string[]
    updates: NameVectorUpdate[]
    inserts: NameVectorRecord[]
  }): Promise<void> {
    if (!this.db) throw new Error('数据库未初始化')
    try {
      if (edit.inserts.length > 0) {
        let opened = await this.openNameTableInProc()
        if (this.nameIndexBroken) return
        if (!opened) {
          opened = await this.db.createTable('knowledge_names', edit.inserts)
          this.nameTable = opened
          return
        }
        for (const row of edit.inserts) {
          await opened.delete(lanceEquals('id', row.id))
        }
        await opened.add(edit.inserts)
      }
      const opened = await this.openNameTableInProc()
      if (this.nameIndexBroken || !opened) return
      for (const id of edit.removeIds) {
        await opened.delete(lanceEquals('id', id))
      }
      for (const row of edit.updates) {
        await opened.update({
          where: lanceEquals('id', row.id),
          values: {
            kind: row.kind,
            text: row.text,
            folder: row.folder,
            docId: row.docId || '',
          },
        })
      }
    } catch (error) {
      this.markNameIndexBroken(error)
    }
  }

  // ────────────────────────── 公开 API（读操作） ──────────────────────────

  async searchByVector(
    embedding: number[],
    options: Partial<SearchOptions> = {}
  ): Promise<SearchResult[]> {
    const limit = options.limit || 10

    if (await this.useWorkerPath()) {
      const { hits } = await this.callWorker<{ hits: any[] }>(
        'vectorSearch', { embedding, limit: limit * 2 }
      )
      return this.formatResults(hits, options)
    }

    if (!this.table) return []
    try {
      const results = await this.table
        .vectorSearch(embedding)
        .distanceType('cosine')
        .limit(limit * 2)
        .toArray()
      return this.formatResults(results, options)
    } catch (error) {
      log.error('Vector search failed:', error)
      if (this.isLanceCorruptionError(error)) {
        this.markCorrupted(`searchByVector: ${(error as Error).message}`)
      }
      return []
    }
  }

  /** @deprecated LanceDB 没有内置全文搜索，请使用 hybridSearch */
  async searchByText(
    _query: string,
    _options: Partial<SearchOptions> = {}
  ): Promise<SearchResult[]> {
    log.warn('searchByText requires embedding, use hybridSearch instead')
    return []
  }

  async hybridSearch(
    query: string,
    embedding: number[],
    options: Partial<SearchOptions> = {}
  ): Promise<SearchResult[]> {
    const limit = options.limit || 10
    const k = 60  // RRF 参数，经验最优值

    // 路由判定留在 try 之外：worker 拉不起来必须报错传出去，
    // 否则会被下面的兜底吞成空结果，用户看到的是「没搜到」而不是「库起不来了」
    const useWorker = await this.useWorkerPath()

    try {
      // 1. 向量搜索（worker 或 in-process）
      let vectorResults: SearchResult[] = []
      if (useWorker) {
        const { hits } = await this.callWorker<{ hits: any[] }>(
          'vectorSearch', { embedding, limit: limit * 2 }
        )
        vectorResults = this.formatResults(hits, options)
      } else if (this.table) {
        const vectorHits = await this.table
          .vectorSearch(embedding)
          .distanceType('cosine')
          .limit(limit * 2)
          .toArray()
        vectorResults = this.formatResults(vectorHits, options)
      }

      // 2. BM25 搜索（始终在主进程执行，与 LanceDB 无关）
      const bm25Index = getBM25Index()
      let bm25Results: BM25SearchResult[] = []
      if (bm25Index.isReady()) {
        bm25Results = await bm25Index.search(query, limit * 2, {
          hostId: options.hostId,
          tags: options.tags
        })
      }

      // 3. RRF 融合
      return this.rrfFusion(vectorResults, bm25Results, k).slice(0, limit)
    } catch (error) {
      log.error('Hybrid search failed:', error)
      if (!this.workerMode && this.isLanceCorruptionError(error)) {
        this.markCorrupted(`hybridSearch: ${(error as Error).message}`)
      }
      return []
    }
  }

  async getRecordsByDocId(docId: string): Promise<VectorRecord[]> {
    if (await this.useWorkerPath()) {
      const { records } = await this.callWorker<{ records: VectorRecord[] }>(
        'getRecordsByDocId', { docId }, WORKER_HEAVY_TIMEOUT_MS
      )
      return records
    }
    if (!this.table) return []
    try {
      const allRows = await this.table.query().toArray()
      return (allRows as VectorRecord[]).filter(r => r.docId === docId)
    } catch (error) {
      log.error('Failed to get records by docId:', error)
      return []
    }
  }

  async getRecordsByDocIds(docIds: Set<string>): Promise<Map<string, VectorRecord>> {
    if (await this.useWorkerPath()) {
      const { records } = await this.callWorker<{ records: [string, VectorRecord][] }>(
        'getRecordsByDocIds', { docIds: Array.from(docIds) }, WORKER_HEAVY_TIMEOUT_MS
      )
      return new Map(records)
    }
    if (!this.table || docIds.size === 0) return new Map()
    try {
      const allRows = await this.table.query().toArray()
      const result = new Map<string, VectorRecord>()
      for (const row of allRows as VectorRecord[]) {
        if (docIds.has(row.docId) && !result.has(row.docId)) {
          result.set(row.docId, row)
        }
      }
      return result
    } catch (error) {
      log.error('Failed to get records by docIds:', error)
      return new Map()
    }
  }

  async getStats(): Promise<KnowledgeStats> {
    if (await this.useWorkerPath()) {
      const { stats } = await this.callWorker<{ stats: KnowledgeStats }>('getStats')
      return stats
    }
    if (!this.table) {
      return { documentCount: 0, chunkCount: 0, totalSize: 0 }
    }
    try {
      const chunkCount = await this.table.countRows()
      const allRows = await this.table.query().select(['docId']).toArray()
      const uniqueDocIds = new Set(allRows.map((r: any) => r.docId))
      return { documentCount: uniqueDocIds.size, chunkCount, totalSize: 0, lastUpdated: Date.now() }
    } catch (error) {
      if (this.isLanceCorruptionError(error)) {
        this.markCorrupted(`getStats: ${(error as Error).message}`)
      }
      return { documentCount: 0, chunkCount: 0, totalSize: 0 }
    }
  }

  async getValidRecords(validDocIds: Set<string>): Promise<VectorRecord[]> {
    if (await this.useWorkerPath()) {
      const { records } = await this.callWorker<{ records: VectorRecord[] }>(
        'getValidRecords', { docIds: Array.from(validDocIds) }, WORKER_HEAVY_TIMEOUT_MS
      )
      return records
    }
    if (!this.table || validDocIds.size === 0) return []
    try {
      const allRows = await this.table.query().toArray()
      return (allRows as any[])
        .filter(r => validDocIds.has(r.docId))
        .map(r => ({
          id: r.id,
          docId: r.docId,
          content: r.content,
          vector: Array.from(r.vector as Iterable<number>),
          filename: r.filename,
          hostId: r.hostId,
          tags: r.tags,
          chunkIndex: r.chunkIndex,
          createdAt: r.createdAt
        }))
    } catch (error) {
      log.error('Failed to get valid records:', error)
      return []
    }
  }

  async getChunkCount(): Promise<number> {
    if (await this.useWorkerPath()) {
      try {
        const { count } = await this.callWorker<{ count: number }>('getChunkCount')
        return count ?? 0
      } catch (error) {
        log.warn('getChunkCount via worker failed:', error)
        return 0
      }
    }
    if (!this.table) return 0
    try {
      return await this.table.countRows()
    } catch (error) {
      log.warn('getChunkCount failed:', error)
      return 0
    }
  }

  async getAllDocIds(): Promise<Set<string>> {
    if (await this.useWorkerPath()) {
      const { docIds } = await this.callWorker<{ docIds: string[] }>(
        'getAllDocIds', undefined, WORKER_HEAVY_TIMEOUT_MS
      )
      return new Set(docIds)
    }
    if (!this.table) return new Set()
    try {
      const allRows = await this.table.query().select(['docId']).toArray()
      const docIds = new Set<string>()
      for (const row of allRows) {
        if ((row as any).docId) docIds.add((row as any).docId)
      }
      return docIds
    } catch (error) {
      log.error('Failed to get all docIds:', error)
      if (this.isLanceCorruptionError(error)) {
        this.markCorrupted(`getAllDocIds: ${(error as Error).message}`)
      }
      return new Set()
    }
  }

  // ────────────────────────── 状态查询 ──────────────────────────

  isReady(): boolean {
    // worker 模式下即使当前进程掉了也算就绪：下一次读写会把它重新拉起来
    return this.isInitialized && (this.workerMode || this.db !== null)
  }

  getStoragePath(): string {
    return this.storagePath
  }

  /**
   * 强制重新初始化：用于从备份恢复后，丢弃内存中的 worker / db 句柄，
   * 下次 initialize() 会重新连接磁盘上恢复后的数据。
   */
  async forceReinitialize(): Promise<void> {
    try {
      await this.disposeAsync(1000)
    } catch (e) {
      log.warn('forceReinitialize: disposeAsync 失败:', e)
    }
    this.isInitialized = false
    this.workerReady = false
    this.workerMode = false
    this.db = null
    this.table = null
    this.nameTable = null
    this.nameIndexBroken = false
  }

  /**
   * 优雅释放 LanceDB worker：先 compact 落盘，再结束子进程。
   * 供主进程 quit / SIGTERM 路径调用，降低 transaction 半截退出导致损坏的概率。
   */
  async disposeAsync(timeoutMs: number = 500): Promise<void> {
    try {
      // 退出路径只跟活着的会话打交道，不为了收尾再把 worker 拉起来
      if (this.workerReady && this.session?.isAlive) {
        await this.callWorker('compact', { aggressive: false }, timeoutMs).catch(err => {
          log.warn('LanceDB dispose compact 失败或超时:', err)
        })
      } else if (this.table) {
        await this.compactInProc()
      }
    } finally {
      this.killWorker()
      this.isInitialized = false
      // 释放之后不该再有人把 worker 拉起来；下次 initialize 会重新判定模式
      this.workerMode = false
      this.workerReadyPromise = null
    }
  }

  // ────────────────────────── 搜索结果处理（本地纯计算） ──────────────────────────

  private formatResults(
    hits: any[],
    options: Partial<SearchOptions>
  ): SearchResult[] {
    const similarityThreshold = options.similarity || 0.3

    let results: SearchResult[] = hits.map(hit => ({
      id: hit.id,
      docId: hit.docId,
      content: hit.content,
      score: hit._distance ? 1 - hit._distance : 1,
      metadata: {
        filename: hit.filename,
        hostId: hit.hostId || '',
        tags: hit.tags ? hit.tags.split(',').filter((t: string) => t) : [],
        startOffset: 0,
        endOffset: hit.content?.length || 0
      },
      source: 'local' as const
    }))

    results = results.filter(r => r.score >= similarityThreshold)

    if (options.hostId && options.hostId.trim()) {
      results = results.filter(r => !r.metadata.hostId || r.metadata.hostId === options.hostId)
    }

    if (options.tags && options.tags.length > 0) {
      results = results.filter(r =>
        options.tags!.some(tag => r.metadata.tags.includes(tag))
      )
    }

    return results.slice(0, options.limit || 10)
  }

  private rrfFusion(
    vectorResults: SearchResult[],
    bm25Results: BM25SearchResult[],
    k: number = 60
  ): SearchResult[] {
    const scoreMap = new Map<string, { score: number; result: SearchResult }>()

    vectorResults.forEach((result, rank) => {
      scoreMap.set(result.id, { score: 1 / (k + rank + 1), result })
    })

    bm25Results.forEach((bm25Result, rank) => {
      const rrfScore = 1 / (k + rank + 1)
      if (scoreMap.has(bm25Result.id)) {
        scoreMap.get(bm25Result.id)!.score += rrfScore
      } else {
        scoreMap.set(bm25Result.id, {
          score: rrfScore,
          result: {
            id: bm25Result.id,
            docId: bm25Result.docId,
            content: bm25Result.content,
            score: bm25Result.score,
            metadata: {
              filename: bm25Result.filename,
              hostId: bm25Result.hostId || '',
              tags: bm25Result.tags ? bm25Result.tags.split(',').filter(t => t) : [],
              startOffset: 0,
              endOffset: bm25Result.content?.length || 0
            },
            source: 'local' as const
          }
        })
      }
    })

    return Array.from(scoreMap.values())
      .sort((a, b) => b.score - a.score)
      .map(({ score, result }) => ({ ...result, score }))
  }
}

// ────────────────────────── 单例 ──────────────────────────

let vectorStorage: VectorStorage | null = null

export function getVectorStorage(): VectorStorage {
  if (!vectorStorage) {
    vectorStorage = new VectorStorage()
  }
  return vectorStorage
}
