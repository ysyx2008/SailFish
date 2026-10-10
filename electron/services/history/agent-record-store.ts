/**
 * AgentRecordStore —— 会话记录（AgentRecord）的真实存储 + 索引所有者
 *
 * 从 `HistoryService` 抽出的「会话域存储」聚合（docs/conversation-refactor-design.md §4.3）。
 * 拥有：
 * - 主历史树（`agent/`）+ watch 独立历史树（`watch/`）两套「记录正文目录 + 索引文件 + 内存缓存」三元组
 * - 索引机器（读/写/重建/upsert）+ main/watch 路由（`storeForRecord`）
 * - 会话记录的 CRUD / 最近 / 按 agentKey / 搜索 / 摘要
 * - 步骤内联 base64 图片外化到磁盘（`externalizeStepImages`）+ 可重生 canvas content 剥离
 *
 * 不碰：聊天记录（ChatRecord，留 HistoryService）、Token 统计聚合、导入导出、清理策略——
 * 这些跨域/运维职责仍归 HistoryService，本类只通过暴露索引读侧（`getAllIndexEntries` 等）
 * 与 `cleanupOldAgentRecords` / `rebuildAgentIndex` 供其复用。
 *
 * 复用 `@shared/types` 的 `AgentRecord`/`AgentHistorySummary`（红线③：禁止平行类型）。
 */
import * as fs from 'fs'
import * as path from 'path'
import { createLogger } from '../../utils/logger'
import { writeFileAtomic } from '../../utils/atomic-write'
import {
  cleanupExpiredMigratedBackups,
  collectAgentStorageStats,
  getAgentRecordPath,
  getLegacyAgentDayFilePath,
  listAgentDateDirs,
  listLegacyAgentDayFiles,
  readLegacyAgentDayRecords,
} from './agent-storage'
import {
  deleteSessionDir,
  listSessionIdsInDateDir,
  applyRecordReadOptions,
  readSessionRecord,
  readSessionRecordAsync,
  saveSessionRecord,
  updateSessionApproval,
  updateSessionTitle,
  type ReadSessionOptions,
} from './session-persistence'
import { getDateString } from './date-util'
import { AgentIndexLog } from './agent-index-log'
import { throwIfAborted } from '../../utils/abort'
import {
  isWatchAgentKey,
  WAKEUP_AGENT_KEY,
  COMPANION_AGENT_KEY,
  type TerminalType,
  type AgentRecord,
  type AgentHistorySummary,
  type ApprovalMode,
  type TokenUsage
} from '@shared/types'

const log = createLogger('AgentRecordStore')

/**
 * Watch 服务生成的 session ID 前缀：watch_<watchId>_<timestamp>。
 * 仅 Watch 服务使用，未提升到 `@shared/types`（属 watch 域实现细节，非跨端契约）。
 */
const WATCH_SESSION_ID_PREFIX = 'watch_'

/**
 * watch 索引条目里 userTask 的截断长度。watch 的 userTask 是心跳模板展开的长 prompt
 * （平均 ~2.6KB），但索引里只用作审计列表标题，整段存会让 watch-index 重新膨胀。
 * 正文完整保存在 watch 树日文件中，索引只留可读的标题前缀。
 */
const WATCH_INDEX_USERTASK_MAX = 200

/** 索引条目：每条 AgentRecord 的轻量摘要，用于排序和过滤，避免读取完整日期文件 */
export interface AgentIndexEntry {
  id: string
  timestamp: number
  duration: number
  dateStr: string
  userTask: string
  /** 侧栏展示标题；缺省时列表回退 userTask */
  title?: string
  terminalType: TerminalType
  /** Agent 的身份 key，来自 AgentRecord.agentKey（如 '__companion__'、'__watch__'） */
  agentKey?: string
  sshHost?: string
  /** 会话绑定的终端编号；助手会话没有，老索引也没存过（见 AgentHistorySummary.terminalId） */
  terminalId?: string
  status: 'completed' | 'failed' | 'aborted'
  tokenUsage?: TokenUsage
}

/**
 * 一个独立的「记录正文目录 + 索引」二元组。
 * 主索引（agentStore）放用户/联络/终端任务；watch 索引（watchStore）放关切内心独白。
 * 两者结构相同、方法复用，只是目录/索引路径不同。
 */
interface AgentIndexStore {
  /** 记录正文所在目录（history/agent 或 history/watch） */
  dir: string
  /** 索引（追加日志，见 agent-index-log.ts） */
  log: AgentIndexLog<AgentIndexEntry>
  /** 迁移前的旧索引文件（单个 JSON 数组），首次访问时就地转成日志 */
  legacyIndexPath: string
  /** 写索引条目时截断 userTask 的长度（仅 watch 用，避免内心独白长 prompt 撑大索引） */
  userTaskMaxLen?: number
}

export interface SearchAgentRecordsOptions {
  keyword?: string
  limit?: number
  startDate?: string
  endDate?: string
  /** 与 getRecentAgentRecords 的 filter 一致，在关键字/日期匹配后再过滤 */
  filter?: (r: AgentRecord) => boolean
  /** 为 true 时仅匹配 userTask（列表标题），不扫 finalResult/steps，适合实时筛选 */
  titleOnly?: boolean
  /** 换词 / 再搜 / 关搜索时中断全文扫描；未取消时仍扫完全部候选以给出总命中数 */
  signal?: AbortSignal
  /** 每命中一条（且仍在 limit 内）立刻回调，供 UI 边搜边展示；顺序与结果一致（新→旧） */
  onMatch?: (record: AgentRecord) => void
}

export interface SearchAgentRecordsResult {
  records: AgentRecord[]
  totalMatched: number
  hasMore: boolean
}

/** 全文搜索命中：会话标题、最终结果、用户消息/追加（含附件标题）、主动找人。 */
function recordMatchesSearchKeyword(record: AgentRecord, lowerKeyword: string): boolean {
  if (record.userTask?.toLowerCase().includes(lowerKeyword)) return true
  if (record.finalResult?.toLowerCase().includes(lowerKeyword)) return true
  return record.steps?.some(step => {
    if (step.type === 'user_task' || step.type === 'user_supplement') {
      if (step.content?.toLowerCase().includes(lowerKeyword)) return true
      if (step.attachments?.some(a => a.filename?.toLowerCase().includes(lowerKeyword))) return true
    }
    if (step.toolName === 'talk_to_user') {
      const message = (step.toolArgs as Record<string, unknown> | undefined)?.message
      if (message?.toString().toLowerCase().includes(lowerKeyword)) return true
    }
    return false
  }) ?? false
}

export class AgentRecordStore {
  private readonly historyDir: string
  private readonly agentDir: string
  private readonly watchDir: string
  private readonly imagesDir: string
  private readonly agentStore: AgentIndexStore
  private readonly watchStore: AgentIndexStore

  constructor(historyDir: string) {
    this.historyDir = historyDir
    this.agentDir = path.join(historyDir, 'agent')
    this.watchDir = path.join(historyDir, 'watch')
    this.imagesDir = path.join(historyDir, 'images')

    this.agentStore = {
      dir: this.agentDir,
      log: new AgentIndexLog<AgentIndexEntry>(path.join(historyDir, 'agent-index.jsonl')),
      legacyIndexPath: path.join(historyDir, 'agent-index.json'),
    }
    this.watchStore = {
      dir: this.watchDir,
      log: new AgentIndexLog<AgentIndexEntry>(path.join(historyDir, 'watch-index.jsonl')),
      legacyIndexPath: path.join(historyDir, 'watch-index.json'),
      userTaskMaxLen: WATCH_INDEX_USERTASK_MAX,
    }

    this.ensureDirectories()
    cleanupExpiredMigratedBackups(this.agentDir)
  }

  /** 主历史树目录（任务/联络记录正文）。供 HistoryService 存储统计复用。 */
  get agentDirectory(): string { return this.agentDir }
  /** watch 独立历史树目录（关切内心独白正文）。供 HistoryService 存储统计复用。 */
  get watchDirectory(): string { return this.watchDir }

  private ensureDirectories(): void {
    const dirs = [this.historyDir, this.agentDir, this.watchDir, this.imagesDir]
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
    }
  }

  private onCorruptRecord(corruptPath: string | null, error: unknown): void {
    log.error(`损坏记录已隔离: ${corruptPath ?? '(rename failed)'}`, error)
  }

  // ==================== 索引管理 ====================

  /** 选择记录归属的索引存储：watch/wakeup 内心独白进独立索引，其余进主索引 */
  private storeForRecord(record: AgentRecord): AgentIndexStore {
    // `__watch__` / `__watch__:${watchId}` / `__wakeup__` → watch 树
    if (isWatchAgentKey(record.agentKey) || record.agentKey === WAKEUP_AGENT_KEY) return this.watchStore
    // 兜底：Watch 服务生成的 session ID 格式固定为 watch_<watchId>_<timestamp>，
    // 若 agentKey 因异常未正确设置，前缀检测仍能路由到 watchStore。
    // 前提假设：非 Watch 记录的 ID 不会以 "watch_" 开头（系统内无其他代码使用此前缀）。
    if (record.id.startsWith(WATCH_SESSION_ID_PREFIX)) return this.watchStore
    return this.agentStore
  }

  /**
   * 旧索引（单个 JSON 数组）就地转成追加日志。
   *
   * 做成惰性转换而不是启动迁移：索引是可从正文重建的派生数据，不需要迁移框架的备份
   * 保障；而桌面、CLI、测试都会经过这里，转换一次即可，不必每个入口各记一遍。
   */
  private migrateLegacyIndex(store: AgentIndexStore): void {
    if (!fs.existsSync(store.legacyIndexPath)) return
    // 已经转过了（或本进程之前重建过）：旧文件留着只会每次多探一次盘，归档掉
    if (store.log.exists()) {
      this.archiveLegacyIndex(store, 'migrated')
      return
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(store.legacyIndexPath, 'utf-8'))
      if (!Array.isArray(parsed)) throw new Error('旧索引不是数组')
      store.log.initializeIfAbsent(parsed as AgentIndexEntry[])
      this.archiveLegacyIndex(store, 'migrated')
      log.info(`索引已转为追加日志 (${path.basename(store.log.path)})，共 ${parsed.length} 条`)
    } catch (e) {
      // 旧索引读不出来就地作废，交给 ensureIndex 从正文重建；不改名的话下次还会再撞一次，
      // 而且写路径会误以为"没有索引"，凭一条新记录建出个只剩它自己的索引
      log.warn(`旧索引损坏，改从正文重建 (${path.basename(store.legacyIndexPath)}):`, e)
      this.archiveLegacyIndex(store, 'corrupt')
    }
  }

  private archiveLegacyIndex(store: AgentIndexStore, suffix: 'migrated' | 'corrupt'): void {
    try {
      fs.renameSync(store.legacyIndexPath, `${store.legacyIndexPath}.${suffix}`)
    } catch { /* 他进程已经改过名了 */ }
  }

  /**
   * 保证索引可用后再操作它。
   *
   * 索引缺失时必须从正文重建，读写路径都要过这一关：只在读路径兜底的话，一次"先写后读"
   * 就会拿新记录建出一份只有它自己的索引，而正文里那几千条会一直看不见——正文还在，
   * 但用户看到的就是历史没了。
   */
  private ensureIndex(store: AgentIndexStore): void {
    this.migrateLegacyIndex(store)
    if (!store.log.exists()) this.rebuildIndexFor(store)
  }

  private getIndexFor(store: AgentIndexStore): AgentIndexEntry[] {
    this.ensureIndex(store)
    return store.log.entries()
  }

  /** 按 id 取单条索引条目。O(1)，不构造整个数组 */
  private getIndexEntry(store: AgentIndexStore, id: string): AgentIndexEntry | undefined {
    this.ensureIndex(store)
    return store.log.get(id)
  }

  private writeIndexFor(store: AgentIndexStore, entries: AgentIndexEntry[]): void {
    store.log.replaceAll(entries)
  }

  /** 从某个存储的所有会话文件重建其索引 */
  private rebuildIndexFor(store: AgentIndexStore): AgentIndexEntry[] {
    const entries: AgentIndexEntry[] = []

    for (const dateStr of listAgentDateDirs(store.dir)) {
      for (const recordId of listSessionIdsInDateDir(store.dir, dateStr)) {
        const record = readSessionRecord(
          store.dir,
          dateStr,
          recordId,
          (p, e) => this.onCorruptRecord(p, e),
          { omitCanvasData: true }
        )
        if (record) entries.push(this.toIndexEntry(record, dateStr, store.userTaskMaxLen))
      }
    }

    // 旧格式日文件只可能出现在主 agent 目录（v5 之前）；watch 目录由 v6 拆分得来，无旧日文件
    for (const file of listLegacyAgentDayFiles(store.dir)) {
      const dateStr = file.replace('.json', '')
      const records = readLegacyAgentDayRecords(
        path.join(store.dir, file),
        (p, e) => this.onCorruptRecord(p, e)
      )
      for (const r of records) {
        applyRecordReadOptions(r, { omitCanvasData: true })
        entries.push(this.toIndexEntry(r, dateStr, store.userTaskMaxLen))
      }
    }

    this.writeIndexFor(store, entries)
    log.info(`索引已重建 (${path.basename(store.log.path)})，共 ${entries.length} 条记录`)
    return entries
  }

  /** 兼容旧调用：默认作用于主 agent 索引 */
  private getIndex(): AgentIndexEntry[] {
    return this.getIndexFor(this.agentStore)
  }

  /** 从磁盘重建全部索引（主 + watch）。首次升级、索引损坏或 v6 迁移后触发 */
  rebuildAgentIndex(): void {
    this.agentStore.log.invalidate()
    this.watchStore.log.invalidate()
    this.rebuildIndexFor(this.agentStore)
    this.rebuildIndexFor(this.watchStore)
  }

  private toIndexEntry(record: AgentRecord, dateStr: string, userTaskMaxLen?: number): AgentIndexEntry {
    const userTask = userTaskMaxLen && record.userTask.length > userTaskMaxLen
      ? record.userTask.slice(0, userTaskMaxLen)
      : record.userTask
    const entry: AgentIndexEntry = {
      id: record.id,
      timestamp: record.timestamp,
      duration: record.duration,
      dateStr,
      userTask,
      terminalType: record.terminalType,
      agentKey: record.agentKey,
      sshHost: record.sshHost,
      status: record.status,
    }
    const title = record.title?.trim()
    if (title) entry.title = title
    if (record.terminalId) entry.terminalId = record.terminalId
    if (record.tokenUsage) {
      entry.tokenUsage = record.tokenUsage
    }
    return entry
  }

  private updateIndexEntryFor(store: AgentIndexStore, record: AgentRecord): void {
    this.ensureIndex(store)
    const dateStr = getDateString(record.timestamp)
    // 追加一行即可：同 id 后写的胜出，也不会覆盖他进程刚写的别的条目，
    // 所以不再需要"写前把整个索引读回来合并"那套防覆盖补丁
    store.log.put(this.toIndexEntry(record, dateStr, store.userTaskMaxLen))
  }

  // ==================== 读侧索引暴露（供 HistoryService 的 Token 统计 / 存储统计复用） ====================

  /** 主历史树索引条目（任务/联络，不含 watch 内心独白）。 */
  getMainIndex(): AgentIndexEntry[] {
    return this.getIndexFor(this.agentStore)
  }

  /** watch 独立历史树索引条目。 */
  getWatchIndex(): AgentIndexEntry[] {
    return this.getIndexFor(this.watchStore)
  }

  /** 主 + watch 合并索引条目（Token 统计需合并两棵树，watch 也消耗 token）。 */
  getAllIndexEntries(): AgentIndexEntry[] {
    return [...this.getIndexFor(this.agentStore), ...this.getIndexFor(this.watchStore)]
  }

  // ==================== 图片外化 / canvas 剥离 ====================

  /**
   * 把 AgentRecord 里所有步骤中内联的 base64 图片写到磁盘，替换为 file:// 路径。
   * 解决长会话（大量截图）IPC 传输超大对象导致渲染进程崩溃的问题。
   * @returns true 表示发生了替换（调用方需要回写记录文件）
   */
  private externalizeStepImages(record: AgentRecord): boolean {
    let anyChanged = false
    const dateStr = getDateString(record.timestamp)
    const sessionImagesDir = path.join(this.imagesDir, dateStr, record.id)

    for (const step of record.steps) {
      if (!step.images || step.images.length === 0) continue

      let stepChanged = false
      const newImages: string[] = []
      for (let i = 0; i < step.images.length; i++) {
        const img = step.images[i]

        // 把旧的 file:// 绝对路径（上一版写入的格式）转为 sft-local:// 协议 URL
        if (img.startsWith('file://')) {
          const absPath = img.slice('file://'.length)
          if (absPath.startsWith(this.imagesDir)) {
            const relPath = path.relative(this.imagesDir, absPath).replace(/\\/g, '/')
            newImages.push(`sft-local://history-image/${relPath}`)
            stepChanged = true
            continue
          }
          newImages.push(img)
          continue
        }

        // 已是 sft-local:// 格式，直接保留
        if (img.startsWith('sft-local://')) {
          newImages.push(img)
          continue
        }

        // 内联 base64 data URL：写出到磁盘，替换为 sft-local:// 路径
        const match = img.match(/^data:(image\/(\w+));base64,(.+)$/)
        if (!match) {
          newImages.push(img)
          continue
        }
        const [, , ext, base64Data] = match
        // 确保 session 图片目录存在（懒建）
        if (!fs.existsSync(sessionImagesDir)) {
          fs.mkdirSync(sessionImagesDir, { recursive: true })
        }
        const filename = `${step.id}-${i}.${ext}`
        const filePath = path.join(sessionImagesDir, filename)
        if (!fs.existsSync(filePath)) {
          fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'))
        }
        const relPath = path.relative(this.imagesDir, filePath).replace(/\\/g, '/')
        newImages.push(`sft-local://history-image/${relPath}`)
        stepChanged = true
      }
      if (stepChanged) {
        step.images = newImages
        anyChanged = true
      }
    }

    return anyChanged
  }

  /**
   * 剥离 `canvasData.content` 中可从 `filePath` 磁盘文件重生的内容（`contentFromFile`）。
   * 仅作用于待写盘的 record 副本：克隆 canvasData 后删除 content，绝不改动调用方
   * （Agent 的 `_sessionSteps`）持有的共享对象，避免破坏正在进行会话的实时预览。
   * 恢复时由前端按 `filePath` 读盘回填（见 artifact store hydrate）。
   */
  private stripRederivableCanvasContent(record: AgentRecord): void {
    record.steps = record.steps.map((step) => {
      const cd = step.canvasData
      if (!cd?.contentFromFile || !cd.filePath || cd.content === undefined) {
        return step
      }
      return { ...step, canvasData: { ...cd, content: undefined } }
    })
  }

  private finishLoadedRecord(
    found: AgentRecord,
    dateStr: string,
    options?: ReadSessionOptions
  ): AgentRecord {
    // 裁过字段的记录绝不能回写，否则会把产出物快照从磁盘抹掉
    if (options?.omitCanvasData) return found
    return this.maybeExternalizeAndSaveRecord(found, dateStr)
  }

  private maybeExternalizeAndSaveRecord(found: AgentRecord, _dateStr: string): AgentRecord {
    const changed = this.externalizeStepImages(found)
    if (changed) {
      const store = this.storeForRecord(found)
      // 步骤内容原地改写，必须全量重写 jsonl，不能走 append
      saveSessionRecord(store.dir, found, { forceRewrite: true })
      this.updateIndexEntryFor(store, found)
      log.info(`Externalized inline images for record ${found.id}, saved back to session file`)
    }
    return found
  }

  // ==================== Agent 记录 CRUD ====================

  /**
   * 尚未落盘的会话标题暂存：LLM/手动改名可能早于首次 checkpoint。
   * 下次 saveAgentRecord 时并入正文并清除。
   */
  private pendingTitles = new Map<string, { title: string; locked?: boolean }>()

  /**
   * 仅更新会话展示标题。标题未变化时不写盘（锁定状态变化除外）。
   * 记录尚不存在时写入 pending，等首次 save 并入。
   * @returns 是否已生效（含 pending / 已是目标值）
   */
  updateTitle(id: string, title: string, opts?: { locked?: boolean }): boolean {
    const trimmed = title.trim()
    if (!id || !trimmed) return false
    const lock = opts?.locked === true

    const record = this.getAgentRecordById(id)
    if (!record) {
      const prev = this.pendingTitles.get(id)
      if (prev?.locked) {
        this.pendingTitles.set(id, prev)
        return false
      }
      this.pendingTitles.set(id, { title: trimmed, locked: lock || prev?.locked })
      return true
    }
    if (record.titleLocked && !lock) return false
    if (record.title?.trim() === trimmed && (!lock || record.titleLocked)) return true

    record.title = trimmed
    if (lock) record.titleLocked = true
    const store = this.storeForRecord(record)
    const dateStr = getDateString(record.timestamp)
    // 目录格式：只改 meta.json；旧 .json 则走 save 并迁入目录格式
    if (!updateSessionTitle(store.dir, dateStr, id, trimmed, record.titleLocked)) {
      saveSessionRecord(store.dir, record)
    }
    this.updateIndexEntryFor(store, record)
    return true
  }

  /**
   * 仅更新一场对话的审批方式。记录还没落盘时返回 false（会话里记着，首次保存时一起写下）。
   */
  updateApproval(id: string, approval: ApprovalMode): boolean {
    const record = id ? this.getAgentRecordById(id) : undefined
    if (!record) return false
    if (record.approval === approval) return true
    record.approval = approval
    const store = this.storeForRecord(record)
    // 目录格式：只改 meta.json；旧 .json 则走 save 并迁入目录格式
    if (!updateSessionApproval(store.dir, getDateString(record.timestamp), id, approval)) {
      saveSessionRecord(store.dir, record)
    }
    return true
  }

  /**
   * 保存 Agent 记录（支持更新：如果 id 相同则更新，否则追加）
   */
  saveAgentRecord(record: AgentRecord): void {
    // pending 标题优先（生成早于首次 checkpoint）
    const pending = this.pendingTitles.get(record.id)
    if (pending) {
      if (pending.locked) {
        record.title = pending.title
        record.titleLocked = true
      } else if (!record.title?.trim()) {
        record.title = pending.title
      }
      this.pendingTitles.delete(record.id)
    }
    // checkpoint 未带 title 时保留磁盘/索引上已有标题，避免覆盖丢失
    if (!record.title?.trim()) {
      const store = this.storeForRecord(record)
      const entry = this.getIndexEntry(store, record.id)
      if (entry?.title?.trim()) record.title = entry.title.trim()
    }

    // 写入前把内联 base64 图片外化到磁盘，避免 JSON 文件膨胀和 IPC 传输超大对象
    this.externalizeStepImages(record)
    // 剥离可从磁盘重生的 Canvas content（md/html 文件），避免大文件撑爆历史记录
    this.stripRederivableCanvasContent(record)

    const store = this.storeForRecord(record)
    saveSessionRecord(store.dir, record)
    this.updateIndexEntryFor(store, record)
  }

  /**
   * 保存（或更新）产出物面板清单到指定记录。
   * 自动剥离 contentFromFile 的 content（可从磁盘重生），避免大文件撑爆历史记录。
   */
  saveArtifacts(recordId: string, artifacts: import('@shared/types').CanvasArtifact[]): void {
    const record = this.getAgentRecordById(recordId)
    if (!record) return
    record.artifacts = artifacts.map(a => {
      if (a.contentFromFile) return { ...a, content: '' }
      return a
    })
    this.saveAgentRecord(record)
  }

  private readAgentRecordFromDisk(
    dateStr: string,
    id: string,
    options?: ReadSessionOptions
  ): AgentRecord | undefined {
    // 先查主 agent 树，再查 watch 树（watch 记录已拆分到独立目录）
    for (const dir of [this.agentDir, this.watchDir]) {
      const record = readSessionRecord(dir, dateStr, id, (p, e) => this.onCorruptRecord(p, e), options)
      if (record) return record
    }

    return this.findLegacyRecord(dateStr, id, options)
  }

  private async readAgentRecordFromDiskAsync(
    dateStr: string,
    id: string,
    options?: ReadSessionOptions
  ): Promise<AgentRecord | undefined> {
    for (const dir of [this.agentDir, this.watchDir]) {
      const record = await readSessionRecordAsync(
        dir,
        dateStr,
        id,
        (p, e) => this.onCorruptRecord(p, e),
        options
      )
      if (record) return record
    }

    return this.findLegacyRecord(dateStr, id, options)
  }

  private findLegacyRecord(
    dateStr: string,
    id: string,
    options?: ReadSessionOptions
  ): AgentRecord | undefined {
    const legacyRecords = readLegacyAgentDayRecords(
      getLegacyAgentDayFilePath(this.agentDir, dateStr),
      (p, e) => this.onCorruptRecord(p, e)
    )
    const found = legacyRecords.find(r => r.id === id)
    return applyRecordReadOptions(found ?? null, options) ?? undefined
  }

  /**
   * 获取指定日期范围的 Agent 记录
   */
  getAgentRecords(startDate?: string, endDate?: string): AgentRecord[] {
    const records: AgentRecord[] = []

    for (const dir of [this.agentDir, this.watchDir]) {
      for (const dateStr of listAgentDateDirs(dir)) {
        if (startDate && dateStr < startDate) continue
        if (endDate && dateStr > endDate) continue

        for (const recordId of listSessionIdsInDateDir(dir, dateStr)) {
          const record = readSessionRecord(
            dir,
            dateStr,
            recordId,
            (p, e) => this.onCorruptRecord(p, e)
          )
          if (record) records.push(record)
        }
      }
    }

    // 旧日文件只可能出现在主 agent 树
    for (const file of listLegacyAgentDayFiles(this.agentDir)) {
      const dateStr = file.replace('.json', '')
      if (startDate && dateStr < startDate) continue
      if (endDate && dateStr > endDate) continue
      records.push(...readLegacyAgentDayRecords(
        path.join(this.agentDir, file),
        (p, e) => this.onCorruptRecord(p, e)
      ))
    }

    return records.sort((a, b) => a.timestamp - b.timestamp)
  }

  /**
   * 按 ID 查找 Agent 记录（跨日期文件查找）。
   * 对存量记录中内联的 base64 图片做 lazy 外化：首次访问时写到磁盘并回写 JSON，
   * 后续访问直接读 file:// 路径，IPC 传输体积从几十 MB 降到几百 KB。
   */
  getAgentRecordById(id: string, options?: ReadSessionOptions): AgentRecord | undefined {
    // 主索引优先，未命中再查 watch 索引（watch 记录在独立索引中）
    const entry = this.getIndex().find(e => e.id === id)
      ?? this.getIndexFor(this.watchStore).find(e => e.id === id)
    if (entry) {
      const found = this.readAgentRecordFromDisk(entry.dateStr, id, options)
      if (found) return this.finishLoadedRecord(found, entry.dateStr, options)
      // 索引有条目但正文不在 dateStr（陈旧/错位）→ 不直接失败，走全盘扫描
      log.warn(
        `Index hit for ${id} at ${entry.dateStr} but body missing; falling back to full scan`
      )
    }

    // 兜底全盘扫描：合并两棵树的日期目录，按日期倒序找
    const dateDirs = new Set<string>([
      ...listAgentDateDirs(this.agentDir),
      ...listAgentDateDirs(this.watchDir),
    ])
    for (const dateStr of [...dateDirs].sort().reverse()) {
      const found = this.readAgentRecordFromDisk(dateStr, id, options)
      if (found) return this.finishLoadedRecord(found, dateStr, options)
    }

    for (const file of [...listLegacyAgentDayFiles(this.agentDir)].reverse()) {
      const dateStr = file.replace('.json', '')
      const found = this.readAgentRecordFromDisk(dateStr, id, options)
      if (found) return this.finishLoadedRecord(found, dateStr, options)
    }

    return undefined
  }

  /**
   * 按 ID 删除单条 Agent 记录（日文件、索引、关联截图目录）。
   * @returns 是否成功删除（记录不存在时返回 false）
   */
  deleteAgentRecord(id: string): boolean {
    this.pendingTitles.delete(id)
    let store = this.agentStore
    let entry = this.getIndexEntry(store, id)
    if (!entry) {
      store = this.watchStore
      entry = this.getIndexEntry(store, id)
    }
    if (!entry) {
      // 索引已无条目时仍尝试按正文扫到并删目录（正文才是真相源，索引可能滞后）
      const orphan = this.getAgentRecordById(id)
      if (!orphan) return false
      store = this.storeForRecord(orphan)
      entry = {
        id: orphan.id,
        timestamp: orphan.timestamp,
        duration: orphan.duration,
        dateStr: getDateString(orphan.timestamp),
        userTask: orphan.userTask,
        terminalType: orphan.terminalType,
        agentKey: orphan.agentKey,
        sshHost: orphan.sshHost,
        status: orphan.status,
      }
    }

    const deletedDir = deleteSessionDir(store.dir, entry.dateStr, id)
    const sessionPath = getAgentRecordPath(store.dir, entry.dateStr, id)
    if (!deletedDir && fs.existsSync(sessionPath)) {
      fs.unlinkSync(sessionPath)
    } else if (!deletedDir) {
      // 兼容尚未迁移的旧日文件：从数组中剔除该条记录（仅主 agent 树可能有旧日文件）
      const legacyPath = getLegacyAgentDayFilePath(store.dir, entry.dateStr)
      if (fs.existsSync(legacyPath)) {
        const legacyRecords = readLegacyAgentDayRecords(legacyPath, (p, e) => this.onCorruptRecord(p, e))
        const filtered = legacyRecords.filter(r => r.id !== id)
        if (filtered.length !== legacyRecords.length) {
          if (filtered.length === 0) {
            fs.unlinkSync(legacyPath)
          } else {
            writeFileAtomic(legacyPath, JSON.stringify(filtered, null, 2))
          }
        }
      }
    }

    // 索引 dateStr 错位或孤儿目录：按日期扫正文再删，避免只摘索引留目录
    if (!deletedDir) {
      for (const dateStr of listAgentDateDirs(store.dir)) {
        if (dateStr === entry.dateStr) continue
        if (deleteSessionDir(store.dir, dateStr, id)) {
          const leftover = path.join(store.dir, dateStr)
          if (fs.existsSync(leftover) && fs.readdirSync(leftover).length === 0) {
            fs.rmdirSync(leftover)
          }
          break
        }
        const altPath = getAgentRecordPath(store.dir, dateStr, id)
        if (fs.existsSync(altPath)) {
          fs.unlinkSync(altPath)
          break
        }
      }
    }

    const dateDir = path.join(store.dir, entry.dateStr)
    if (fs.existsSync(dateDir) && fs.readdirSync(dateDir).length === 0) {
      fs.rmdirSync(dateDir)
    }

    store.log.delete(id)

    const sessionImagesDir = path.join(this.imagesDir, entry.dateStr, id)
    if (fs.existsSync(sessionImagesDir)) {
      fs.rmSync(sessionImagesDir, { recursive: true, force: true })
    }

    log.info(`已删除 Agent 历史记录: ${id}`)
    return true
  }

  /**
   * 获取最近的 N 条 Agent 记录，按最后更新时间（timestamp + duration）倒序排列。
   * 基于轻量级索引选出 top N，再只读取必要的日期文件获取完整记录。
   */
  getRecentAgentRecords(limit: number = 5, filter?: (r: AgentRecord) => boolean): AgentRecord[] {
    const index = this.getIndex()

    // 索引条目包含 filter 所需字段（userTask 等），用 cast 适配现有签名
    let candidates = filter
      ? index.filter(e => filter(e as unknown as AgentRecord))
      : index

    candidates = candidates
      .sort((a, b) => (b.timestamp + b.duration) - (a.timestamp + a.duration))
      .slice(0, limit)

    if (candidates.length === 0) return []

    // 按 dateStr 分组，最小化文件读取次数
    const results: AgentRecord[] = []
    for (const entry of candidates) {
      const record = this.readAgentRecordFromDisk(entry.dateStr, entry.id)
      if (record) results.push(record)
    }

    return results.sort((a, b) => (b.timestamp + b.duration) - (a.timestamp + a.duration))
  }

  /**
   * 取某个 agentKey（如 '__companion__'）最近的一条完整会话记录。
   * 用于联络常驻 tab 打开/重启后恢复上次对话。无匹配返回 undefined。
   */
  getLatestRecordByAgentKey(agentKey: string): AgentRecord | undefined {
    return this.getRecentAgentRecords(1, r => r.agentKey === agentKey)[0]
  }

  /**
   * 取某个 agentKey 最近的 N 条完整会话记录（按最后活跃时间倒序）。
   * 联络常驻 tab 恢复时合并展示，避免重启后只看到最后一条会话。
   */
  getRecentRecordsByAgentKey(agentKey: string, limit: number = 10): AgentRecord[] {
    return this.getRecentAgentRecords(limit, r => r.agentKey === agentKey)
  }

  /**
   * 取最近 N 条 watch（关切）执行记录，按最后活跃时间倒序。
   * 数据源是独立的 watch 索引/树（与主历史隔离），供关切执行审计使用，不进主历史列表。
   */
  getRecentWatchRecords(limit: number = 20, filter?: (r: AgentRecord) => boolean): AgentRecord[] {
    let candidates = this.getIndexFor(this.watchStore)
    if (filter) {
      candidates = candidates.filter(e => filter(e as unknown as AgentRecord))
    }
    const top = [...candidates]
      .sort((a, b) => (b.timestamp + b.duration) - (a.timestamp + a.duration))
      .slice(0, limit)

    const records: AgentRecord[] = []
    for (const entry of top) {
      const record = this.readAgentRecordFromDisk(entry.dateStr, entry.id)
      if (record) records.push(record)
    }
    return records
  }

  /**
   * 列出全部 Agent 历史的轻量摘要（来自 agent-index.json，不读各日 JSON）。
   * 按「最后活跃时间」timestamp + duration 倒序。
   */
  listAgentHistorySummaries(excludeWakeup?: boolean): AgentHistorySummary[] {
    const index = this.getIndex()
    let entries = [...index]
    if (excludeWakeup) {
      // 主索引已通过 storeForRecord 隔离 watch/wakeup 数据到独立 watchStore，此处为防御兜底：
      // 同时过滤三类不应出现在任务侧栏的记录：
      // 1. watch 关切（`__watch__` / `__watch__:${id}`）：正常走 watchStore，此处二次防御
      // 2. wakeup 心跳（agentKey='__wakeup__'）：同源 watch 树，此处二次防御
      // 3. 联络会话（agentKey='__companion__'）：有独立的联络 tab，不进任务侧栏
      // 4. watch session ID 前缀（'watch_'）：agentKey 未正确设置时的最终兜底
      entries = entries.filter(e =>
        !isWatchAgentKey(e.agentKey) &&
        e.agentKey !== WAKEUP_AGENT_KEY &&
        e.agentKey !== COMPANION_AGENT_KEY &&
        !e.id.startsWith(WATCH_SESSION_ID_PREFIX)
      )
    }
    entries.sort((a, b) => (b.timestamp + b.duration) - (a.timestamp + a.duration))
    return entries.map(e => ({
      id: e.id,
      timestamp: e.timestamp,
      duration: e.duration,
      userTask: e.userTask,
      title: e.title,
      terminalType: e.terminalType,
      agentKey: e.agentKey,
      sshHost: e.sshHost,
      terminalId: e.terminalId,
      status: e.status,
    }))
  }

  // ==================== 搜索 ====================

  /**
   * 关键字搜索 Agent 历史记录
   * 搜索范围：userTask、finalResult、用户消息/追加（含附件标题）、主动找人
   */
  async searchAgentRecords(keyword: string, limit: number = 10): Promise<AgentRecord[]> {
    return (await this.searchAgentRecordsAdvanced({ keyword, limit })).records
  }

  /**
   * 高级搜索 Agent 历史记录
   * 支持关键字搜索、时间范围过滤，以及 hasMore 提示。
   * `titleOnly: true` 时仅匹配 userTask，不扫描 finalResult / steps，适合高频实时筛选。
   *
   * 性能：先用内存索引（含 userTask/timestamp 等）筛出候选，再按需异步读取日期文件。
   * - titleOnly：关键字匹配在索引层完成，仅为前 limit 条命中读回完整记录，零全量扫描；
   * - full：关键字可能命中 finalResult/steps 正文/附件标题，须读完整记录二次匹配，但仅读「时间窗 +
   *   filter 命中」的候选所在文件，且逐文件 `await`（fs.promises）让出事件循环，避免历史量大时
   *   同步遍历阻塞主进程导致界面冻结。
   *
   * 索引为搜索唯一候选来源，与 `getRecentAgentRecords` / `listAgentHistorySummaries` 的假设一致
   * （索引在 saveAgentRecord 时同步更新，缺失时 rebuildIndex 全量重建）。`filter` 直接作用于索引
   * 条目（cast），与 `getRecentAgentRecords` 同款——现有 filter（excludeWakeup）仅依赖 userTask。
   */
  async searchAgentRecordsAdvanced(options: SearchAgentRecordsOptions): Promise<SearchAgentRecordsResult> {
    const keyword = options.keyword?.trim() ?? ''
    if (!keyword && !options.startDate && !options.endDate) {
      return { records: [], totalMatched: 0, hasMore: false }
    }

    const lowerKeyword = keyword.toLowerCase()
    const hasKeyword = lowerKeyword.length > 0
    const limit = Math.max(1, options.limit ?? 10)
    const titleOnly = options.titleOnly === true
    const startTs = this.parseDateBoundary(options.startDate, 'start')
    const endTs = this.parseDateBoundary(options.endDate, 'end')

    // ── 候选筛选（零文件读）：时间窗 + filter；titleOnly 时关键字匹配也在此完成 ──
    const candidates = [...this.getIndex()]
      .sort((a, b) => b.timestamp - a.timestamp) // 最近优先，与旧实现的「最新日期 + 逆序记录」一致
      .filter(e => {
        const ts = e.timestamp || 0
        if (startTs !== undefined && ts < startTs) return false
        if (endTs !== undefined && ts > endTs) return false
        if (options.filter && !options.filter(e as unknown as AgentRecord)) return false
        if (titleOnly && hasKeyword && !e.userTask?.toLowerCase().includes(lowerKeyword)) return false
        return true
      })

    // titleOnly：候选即命中集合，仅需为展示读回前 limit 条完整记录
    if (titleOnly) {
      throwIfAborted(options.signal)
      const totalMatched = candidates.length
      const records = await this.materializeRecords(candidates.slice(0, limit), options.signal)
      return { records, totalMatched, hasMore: totalMatched > records.length }
    }

    // full：候选已按时间倒序（最新优先），逐条异步读回完整记录做正文关键字匹配。
    // 每条单文件存储，按候选顺序逐个读即可；fs.promises 逐文件 await 让出事件循环，
    // 避免历史量大时同步遍历阻塞主进程导致界面冻结。
    // 凑满 limit 后仍继续扫完，才能给出准确的总命中数；只有用户取消才中途停。
    const results: AgentRecord[] = []
    let totalMatched = 0

    for (const entry of candidates) {
      throwIfAborted(options.signal)
      const r = await this.readAgentRecordFromDiskAsync(entry.dateStr, entry.id, { omitCanvasData: true })
      if (!r) continue
      const matchedByKeyword = !hasKeyword || recordMatchesSearchKeyword(r, lowerKeyword)
      if (matchedByKeyword) {
        totalMatched++
        if (results.length < limit) {
          results.push(r)
          options.onMatch?.(r)
        }
      }
    }

    return {
      records: results,
      totalMatched,
      hasMore: totalMatched > results.length
    }
  }

  /**
   * 把索引条目还原为完整 AgentRecord，按 dateStr 分组异步读取，保持入参顺序。
   */
  private async materializeRecords(entries: AgentIndexEntry[], signal?: AbortSignal): Promise<AgentRecord[]> {
    if (entries.length === 0) return []

    const idsByDate = new Map<string, Set<string>>()
    for (const e of entries) {
      let idSet = idsByDate.get(e.dateStr)
      if (!idSet) {
        idSet = new Set()
        idsByDate.set(e.dateStr, idSet)
      }
      idSet.add(e.id)
    }

    const recordById = new Map<string, AgentRecord>()
    for (const [dateStr, idSet] of idsByDate) {
      for (const id of idSet) {
        throwIfAborted(signal)
        const record = await this.readAgentRecordFromDiskAsync(dateStr, id, { omitCanvasData: true })
        if (record) recordById.set(id, record)
      }
    }

    const out: AgentRecord[] = []
    for (const e of entries) {
      const r = recordById.get(e.id)
      if (r) out.push(r)
    }
    return out
  }

  private parseDateBoundary(value: string | undefined, type: 'start' | 'end'): number | undefined {
    if (!value) return undefined
    const text = value.trim()
    if (!text) return undefined

    const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
    if (dateMatch) {
      const [_, y, m, d] = dateMatch
      return this.createLocalDateMs(
        Number(y),
        Number(m),
        Number(d),
        type === 'start' ? 0 : 23,
        type === 'start' ? 0 : 59,
        type === 'start' ? 0 : 59,
        type === 'start' ? 0 : 999
      )
    }

    const hourMatch = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2})$/.exec(text)
    if (hourMatch) {
      const [_, y, m, d, hh] = hourMatch
      return this.createLocalDateMs(
        Number(y),
        Number(m),
        Number(d),
        Number(hh),
        type === 'start' ? 0 : 59,
        type === 'start' ? 0 : 59,
        type === 'start' ? 0 : 999
      )
    }

    const minuteMatch = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(text)
    if (minuteMatch) {
      const [_, y, m, d, hh, mm] = minuteMatch
      return this.createLocalDateMs(
        Number(y),
        Number(m),
        Number(d),
        Number(hh),
        Number(mm),
        type === 'start' ? 0 : 59,
        type === 'start' ? 0 : 999
      )
    }

    // ISO 时间仅接受带时区的格式，避免环境差异导致的歧义
    if (/T/.test(text) && (/[zZ]$/.test(text) || /[+-]\d{2}:\d{2}$/.test(text))) {
      const parsed = new Date(text)
      return Number.isNaN(parsed.getTime()) ? undefined : parsed.getTime()
    }

    return undefined
  }

  private createLocalDateMs(
    year: number,
    month: number,
    day: number,
    hour: number,
    minute: number,
    second: number,
    millisecond: number
  ): number | undefined {
    const date = new Date(year, month - 1, day, hour, minute, second, millisecond)
    if (
      date.getFullYear() !== year ||
      date.getMonth() !== month - 1 ||
      date.getDate() !== day ||
      date.getHours() !== hour ||
      date.getMinutes() !== minute ||
      date.getSeconds() !== second ||
      date.getMilliseconds() !== millisecond
    ) {
      return undefined
    }
    return date.getTime()
  }

  // ==================== 清理（供 HistoryService 的 cleanupOldRecords 复用 agent 部分） ====================

  /**
   * 清理指定天数之前的 Agent 记录（主树 + watch 树的会话文件 + 旧日文件 + 日期目录）。
   * `daysToKeep = 0` 表示清空全部。返回删除的条目数。调用方负责事后 `rebuildAgentIndex`。
   */
  cleanupOldAgentRecords(daysToKeep: number = 90): number {
    let agentDeleted = 0

    if (daysToKeep === 0) {
      for (const dir of [this.agentDir, this.watchDir]) {
        if (!fs.existsSync(dir)) continue
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const entryPath = path.join(dir, entry.name)
          if (entry.isDirectory()) {
            fs.rmSync(entryPath, { recursive: true, force: true })
            agentDeleted++
          } else if (entry.isFile() && entry.name.endsWith('.json')) {
            fs.unlinkSync(entryPath)
            agentDeleted++
          }
        }
      }
    } else {
      const cutoffDate = new Date()
      cutoffDate.setDate(cutoffDate.getDate() - daysToKeep)
      const cutoffStr = getDateString(cutoffDate.getTime())

      for (const dir of [this.agentDir, this.watchDir]) {
        for (const dateStr of listAgentDateDirs(dir)) {
          if (dateStr < cutoffStr) {
            fs.rmSync(path.join(dir, dateStr), { recursive: true, force: true })
            agentDeleted++
          }
        }
        for (const file of listLegacyAgentDayFiles(dir)) {
          const dateStr = file.replace('.json', '')
          if (dateStr < cutoffStr) {
            fs.unlinkSync(path.join(dir, file))
            agentDeleted++
          }
        }
      }
    }

    return agentDeleted
  }

  // ==================== 存储统计（供 HistoryService.getStorageStats 复用） ====================

  /** 主树 + watch 树的会话文件总数（=索引条目数）。 */
  get totalSessionCount(): number {
    return this.getIndexFor(this.agentStore).length + this.getIndexFor(this.watchStore).length
  }

  /** 主树 + watch 树的存储统计（文件数 / 旧日文件数 / 总体积 / 日期标签）。 */
  getStorageStatsForBoth(): {
    agentStats: ReturnType<typeof collectAgentStorageStats>
    watchStats: ReturnType<typeof collectAgentStorageStats>
  } {
    return {
      agentStats: collectAgentStorageStats(this.agentDir),
      watchStats: collectAgentStorageStats(this.watchDir),
    }
  }
}
