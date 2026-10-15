/**
 * 知识库主服务
 * 整合 Embedding、向量存储、分块、重排序和 MCP 适配器
 */
import { EventEmitter } from 'events'
import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { app } from 'electron'
import { v4 as uuidv4 } from 'uuid'

import type { 
  KnowledgeSettings,
  KnowledgeDocument,
  SearchOptions,
  SearchResult,
  AddDocumentOptions,
  KnowledgeStats,
  ModelTier,
  ModelInfo,
  ModelStatus,
  MemoryVolatility
} from './types'
import { DEFAULT_KNOWLEDGE_SETTINGS } from './types'

import { getModelManager, ModelManager } from './model-manager'
import { getEmbeddingService, EmbeddingService } from './embedding'
import { getVectorStorage, VectorStorage, VectorRecord } from './storage'
import { getChunker, Chunker } from './chunker'
import { McpKnowledgeAdapter } from './mcp-adapter'
import { deduplicateByEmbeddingCluster as deduplicateMemories } from './memory-utils'
import { createReranker, Reranker } from './reranker'
import { getBM25Index, BM25Index } from './bm25'
import { encrypt, decrypt, isEncrypted } from './crypto'
import { IngestGate } from './ingest-gate'
import {
  createBackup as doCreateBackup,
  saveBackupTo as doSaveBackupTo,
  isKnowledgeSnapshot,
  resolveKnowledgeSnapshot as doResolveKnowledgeSnapshot,
  listBackups as doListBackups,
  restoreBackup as doRestoreBackup,
  deleteBackup as doDeleteBackup,
  hasCorruptionMarker,
  clearCorruptionMarker,
  clearRestoreExhausted,
  isRestoreExhausted,
  type BackupEntry
} from './backup'

import { createLogger } from '../../utils/logger'
import { wrapKnowledgeRefs } from '../agent/message-envelope'
import {
  conversationSessionTag,
  formatRecalledConversations,
  isConversationDocForSession,
  toRecalledConversation,
  type RecalledConversation,
  type RecallingConversation,
} from './conversation-index'

import type { AiService } from '../ai.service'
import type { McpService } from '../mcp.service'
import type { ConfigService } from '../config.service'
import type { ParsedDocument } from '../document-parser.service'

const log = createLogger('Knowledge')

// ==================== 观察日志模型类型 ====================

/** 主机记忆内部条目（去重后带元数据） */
interface HostMemoryItem {
  docId: string
  content: string
  createdAt: number
  vector: number[] | null
  volatility?: MemoryVolatility
  source?: string
}

/** 智能添加记忆的结果 */
export interface SmartMemoryResult {
  success: boolean
  action: string
  message: string
  docId?: string
}

/** 对话索引条目（用于跨会话语义检索） */
export interface ConversationIndexEntry {
  taskId: string
  /** 所属会话 id；删除对话时靠它找回对应条目 */
  sessionId?: string
  hostId: string
  userRequest: string
  finalResult: string
  status: 'success' | 'failed' | 'aborted'
  timestamp: number
}

/** 对话检索结果 */
export interface ConversationSearchResult extends RecalledConversation {
  taskId: string
}

/**
 * RRF 融合分数阈值
 * RRF 分数 = 1/(k+rank+1)，k=60 时：
 * - 单通道第1名 ≈ 0.0164，第2名 ≈ 0.0161
 * - 双通道命中时分数叠加 ≈ 0.032
 * 0.02 表示至少在一个通道排名靠前，或在两个通道都有匹配
 */
import { MIN_RRF_SCORE, AUTO_RECALL_LIMIT, AUTO_RECALL_SIMILARITY } from './recall-params'
import {
  CARD_SIMILARITY,
  EXCERPT_CHARS,
  MAX_EXCERPTS,
  MAX_IMPRESSIONS,
  MAX_KEYWORD_DOCS,
  MIN_KEYWORD_SCORE,
  RECALL_CHAR_BUDGET,
  bestKeywordPerDoc,
  capChunkText,
  formatCatalog,
  fuseByDocument,
  inFolder,
  isLibraryFileType,
  normalizeFolder,
  renderLibraryRecall,
  resolveRecallFolder,
  type ImpressionDoc,
} from './catalog'
import {
  CARD_DAILY_LIMIT,
  CARD_TICK_LIMIT,
  CARD_VECTOR_BACKFILL_PER_TICK,
  buildCardPrompt,
  initialCard,
  isQuietHour,
  onContentReplaced,
  onGenerateFail,
  onGenerateStart,
  onGenerateSuccess,
  onHumanConfirm,
  onHumanEdit,
  pickNextCard,
  resumeInterrupted,
  type CardFields,
} from './card-policy'
import { CardVectorStore } from './card-vectors'
import { CardQuota } from './card-quota'
import { normalizeKnowledgeDocument } from '../../utils/normalize'
import type { AiMessage } from '../ai.service'

export { MIN_RRF_SCORE, AUTO_RECALL_LIMIT, AUTO_RECALL_SIMILARITY }

export class KnowledgeService extends EventEmitter {
  private modelManager: ModelManager
  private embeddingService: EmbeddingService
  private vectorStorage: VectorStorage
  private chunker: Chunker
  private reranker: Reranker | null = null
  private mcpAdapter: McpKnowledgeAdapter | null = null
  private bm25Index: BM25Index
  
  private configService: ConfigService
  private aiService: AiService
  private mcpService: McpService | null = null
  
  private settings: KnowledgeSettings
  private documentsMetaPath: string
  private documentsIndex: Map<string, KnowledgeDocument> = new Map()
  private cardVectors: CardVectorStore
  private cardQuota: CardQuota
  private cardTimer: ReturnType<typeof setInterval> | null = null
  private cardFirstTick: ReturnType<typeof setTimeout> | null = null
  private cardTickRunning = false
  private isInitialized: boolean = false
  /**
   * initialize 完整失败后的闩锁，避免 Agent 每次召回都重跑 initialize → 反复 fork Embedding worker。
   * dispose / 备份恢复后清除。
   */
  private permanentInitError: Error | null = null
  /**
   * 记录最近一次"清空索引"的原因，供 rebuildStarted 事件携带，
   * 让前端区分"模型升级"vs"数据损坏"vs"索引缺失"，避免文案误导。
   * 取值：'dimension_mismatch' | 'data_corrupted' | undefined（未发生过清空）
   */
  private lastClearReason: 'dimension_mismatch' | 'data_corrupted' | undefined
  /** 向量库读不开时跳过启动补建，避免把「枚举失败」当成「库是空的」 */
  private skipStartupVectorRebuild = false

  constructor(
    configService: ConfigService,
    aiService: AiService,
    mcpService?: McpService
  ) {
    super()
    
    this.configService = configService
    this.aiService = aiService
    this.mcpService = mcpService || null
    
    this.settings = configService.getKnowledgeSettings() || DEFAULT_KNOWLEDGE_SETTINGS
    
    // 初始化子服务
    this.modelManager = getModelManager()
    this.embeddingService = getEmbeddingService()
    this.embeddingService.setDevice(this.settings.embeddingDevice)
    this.vectorStorage = getVectorStorage()
    this.chunker = getChunker()
    this.bm25Index = getBM25Index()
    
    // 设置分块选项（maxChunkSize 在初始化后根据模型自动设置）
    this.chunker.setOptions({
      strategy: this.settings.chunkStrategy
    })
    
    // 文档索引存储路径
    this.documentsMetaPath = path.join(app.getPath('userData'), 'knowledge', 'documents.json')
    const knowledgeDir = path.dirname(this.documentsMetaPath)
    this.cardVectors = new CardVectorStore(path.join(knowledgeDir, 'card-vectors.json'))
    this.cardQuota = new CardQuota(path.join(knowledgeDir, 'card-quota.json'))
    
    // 加载文档索引
    this.loadDocumentsIndex()
    
    // 自检：配置存储异常恢复
    // 当配置被重置为默认值（加密密钥变化、文件损坏等），但文档索引仍在磁盘上时，
    // 自动恢复 enabled 和 enableHostMemory 设置，避免用户感知到"知识库突然消失"。
    if (!this.settings.enabled && this.documentsIndex.size > 0) {
      log.warn(
        `配置异常恢复：知识库已禁用但存在 ${this.documentsIndex.size} 个文档，自动启用。` +
        '如果你确实想禁用知识库，请在设置中手动关闭。'
      )
      this.settings.enabled = true
      this.settings.enableHostMemory = true
      this.configService.updateKnowledgeSettings({ enabled: true, enableHostMemory: true })
    }
  }

  /**
   * 初始化知识库服务
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return
    }
    if (this.permanentInitError) {
      throw this.permanentInitError
    }

    // 后台触发自动备份（距上次 > 30min 才真正复制）。
    // 放在 initialize 开头、worker 启动前：此刻磁盘是上次退出时的状态，
    // 文件级复制最安全。已标损坏则跳过，避免把坏库存成最新备份。
    this.scheduleAutoBackup()
    this.skipStartupVectorRebuild = false

    try {
      // 初始化 Embedding 服务
      if (this.settings.embeddingMode === 'local') {
        this.embeddingService.setDevice(this.settings.embeddingDevice)
        const modelId = this.settings.localModel === 'auto' 
          ? undefined 
          : this.settings.localModel
        await this.embeddingService.initialize(modelId)
        
        // 根据模型的 maxTokens 自动设置分块大小
        const currentModel = this.embeddingService.getCurrentModel()
        if (currentModel) {
          this.chunker.setOptions({
            maxChunkSize: currentModel.maxTokens,
            strategy: this.settings.chunkStrategy
          })
        }
      }

      // 初始化向量存储
      const dimensions = this.embeddingService.getDimensions()
      
      // 监听维度变化事件（模型升级时自动清空旧索引）
      this.vectorStorage.once('dimensionMismatch', async ({ old: oldDim, new: newDim }) => {
        log.info(`模型维度变化 ${oldDim} -> ${newDim}，同步清空 BM25 索引...`)
        await this.bm25Index.clear()
        this.lastClearReason = 'dimension_mismatch'
        this.emit('indexCleared', { reason: 'dimension_mismatch', oldDimensions: oldDim, newDimensions: newDim })
      })

      this.vectorStorage.once('indexUnreadable', () => {
        log.warn('向量库暂时无法读取，跳过启动时全量补建')
        this.skipStartupVectorRebuild = true
      })
      
      await this.vectorStorage.initialize(dimensions)

      // 向量表读不开，且手上这批备份已经整个试过一遍都救不回来——恢复手段到此用尽。
      // 再抱着这张表不放，只是让检索一直坏着等人去翻日志：数据确实没丢，功能一直是废的。
      // 只丢向量这一半，BM25 与源文档是另一套数据，随后按差集把向量补回来。
      //
      // 必须以「备份全试过且都失败」为前提，不能只凭「读不开」。读不开不等于坏了：
      // 另一个实例正握着这张表时它也读不开，而那张表是完好的。挨个试过备份才是能
      // 证伪的证据；没有备份可试的时候我们手里什么都没有，猜错就毁掉用户唯一的副本。
      if (this.skipStartupVectorRebuild && isRestoreExhausted()) {
        await this.discardUnrecoverableVectorTable()
      }

      // 初始化 BM25 索引
      await this.bm25Index.initialize()

      // 初始化重排序服务
      if (this.settings.enableRerank) {
        this.reranker = createReranker(this.aiService)
      }

      // MCP 知识库入口已对用户隐藏（功能未完成），不接外部协同搜索

      this.isInitialized = true
      this.permanentInitError = null
      this.emit('initialized')
      this.startCardMaintenance()
      
      // 检查是否需要重建索引（有文档但向量库是空的）
      await this.checkAndRebuildIndex()
      
      // 孤儿 chunk 清理放后台，不阻塞启动
      this.scheduleOrphanCleanupAsync()
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      this.permanentInitError = err
      log.error('Initialization failed（已熔断，后续请求不再重试直至 dispose/恢复）:', error)
      this.emit('error', error)
      throw err
    }
  }
  
  /**
   * 确证救不回来之后，丢掉向量表让后面的差集补建把它重新长出来。
   *
   * 只在「读不开」且「这批备份全试过」同时成立时才走到这里——这与「一发现损坏
   * 就推倒」是相反的处境，界线是有没有确证救不回来（见 SPEC）。
   *
   * 丢表失败就维持原样跳过补建：宁可继续坏着，也不能变成每次启动都重烧一遍。
   */
  private async discardUnrecoverableVectorTable(): Promise<void> {
    log.warn('向量库确证无法恢复（备份已全部试过且都读不开），丢弃向量表并按源文档重建向量侧')
    try {
      await this.vectorStorage.clear()
    } catch (e) {
      log.error('丢弃损坏向量表失败，维持跳过补建以免反复重来:', e)
      return
    }
    // 撤销损坏标记必须排在前面，且必须在丢表成功之后：坏表已经不在了，标记留着会让
    // 下次启动拿旧备份把重建成果盖掉、再重烧一轮。万一进程死在这两行之间，先清标记
    // 的顺序保证残留的是「结论还在」而不是「标记还在」——前者只是少试一次备份，
    // 后者才是那个循环。
    clearCorruptionMarker()
    // 表都换了，「这批备份救不回来」的结论跟着作废，否则会挡住将来真有救时的恢复
    clearRestoreExhausted()
    this.lastClearReason = 'data_corrupted'
    this.skipStartupVectorRebuild = false
    this.emit('indexCleared', { reason: 'data_corrupted' })
  }

  /**
   * 强制重建所有索引（CLI / 用户手动触发用）。
   *
   * @param force 为 true 时先清空向量库 + BM25，再走完整重建路径；
   *   为 false 时仅在二者缺失时重建（等价于 initialize 路径里的 checkAndRebuildIndex）。
   * @returns 总耗时（ms）和处理的文档数
   */
  async rebuildAllIndices(force: boolean = false): Promise<{
    durationMs: number
    documentCount: number
    forced: boolean
  }> {
    if (!this.isInitialized) {
      await this.initialize()
    }

    if (force) {
      log.info('强制重建：清空向量库和 BM25 索引')
      this.skipStartupVectorRebuild = false
      await this.vectorStorage.clear()
      await this.bm25Index.clear()
    }

    const documentCount = this.documentsIndex.size
    const t0 = Date.now()
    await this.checkAndRebuildIndex()
    const durationMs = Date.now() - t0

    return { durationMs, documentCount, forced: force }
  }

  /**
   * 增量修复索引：只对向量库或 BM25 中缺失的文档重新 embed + 写入，
   * 不清空任何已有数据。适合处理部分损坏而非全量重建的场景。
   *
   * @returns checked 总文档数、added 补充入库的文档数、durationMs 耗时
   */
  async repairIndex(): Promise<{
    checked: number
    added: number
    durationMs: number
  }> {
    if (!this.isInitialized) {
      await this.initialize()
    }

    const t0 = Date.now()
    const allDocs = this.getDocuments()

    if (allDocs.length === 0) {
      return { checked: 0, added: 0, durationMs: Date.now() - t0 }
    }

    // 获取两个索引中已有的 docId 集合
    const [vectorDocIds, bm25DocIds] = await Promise.all([
      this.vectorStorage.getAllDocIds(),
      Promise.resolve(this.bm25Index.getIndexedDocIds()),
    ])

    // 「读不出来」不等于「里面是空的」：枚举失败同样返回空集，照着开工会把整库
    // 判成缺失，然后往一张已经坏掉的表里重新 embed 几个小时——修不好，纯白烧。
    // 表里明明还有 chunk 却枚举不出来时，宁可拒绝并说明原因。
    if (vectorDocIds.size === 0 && allDocs.length >= 50) {
      const chunkCount = await this.vectorStorage.getChunkCount()
      if (chunkCount > 0) {
        throw new Error(
          `向量库有 ${chunkCount} 条数据却枚举不出内容，无法判断缺哪些文档。` +
          `此时修复会把全部 ${allDocs.length} 篇当成缺失重新索引，既修不好也白跑。` +
          `请先重启应用让损坏恢复流程处理。`
        )
      }
    }

    // 找出缺失的文档（在 documentsIndex 里有但索引里没有）
    const missingDocs = allDocs.filter(
      doc => !vectorDocIds.has(doc.id) || !bm25DocIds.has(doc.id)
    )

    log.info(
      `repairIndex: 共 ${allDocs.length} 个文档，` +
      `向量库已索引 ${vectorDocIds.size} 个，BM25 已索引 ${bm25DocIds.size} 个，` +
      `需补充 ${missingDocs.length} 个`
    )

    if (missingDocs.length === 0) {
      // 顺手清理孤儿，不影响速度（通常 O(1) 返回）
      await this.cleanupOrphanData()
      return { checked: allDocs.length, added: 0, durationMs: Date.now() - t0 }
    }

    this.emit('repairStarted', { total: missingDocs.length })

    const EMBED_BATCH_SIZE = this.embeddingService.getMaxBatchSize()

    interface PendingChunk {
      doc: KnowledgeDocument
      chunkId: string
      chunkIndex: number
      text: string
      isHostMemory: boolean
      needVector: boolean
      needBm25: boolean
    }
    let pendingChunks: PendingChunk[] = []

    const flushRepairBatch = async (): Promise<void> => {
      if (pendingChunks.length === 0) return

      const batch = pendingChunks
      pendingChunks = []

      let embeddings: number[][]
      try {
        embeddings = await this.embeddingService.embed(batch.map(p => p.text))
      } catch (err) {
        log.error(`repairIndex: embed 批量失败（${batch.length} 条），跳过此批:`, err)
        return
      }

      const vectorRecords: VectorRecord[] = []
      const bm25Docs: Array<{
        id: string; docId: string; content: string
        filename: string; hostId: string; tags: string
      }> = []

      for (let i = 0; i < batch.length; i++) {
        const p = batch[i]
        const tagsStr = (p.doc.tags || []).join(',')

        if (p.needVector) {
          vectorRecords.push({
            id: p.chunkId,
            docId: p.doc.id,
            content: p.isHostMemory ? encrypt(p.text) : p.text,
            vector: embeddings[i],
            filename: p.doc.filename,
            hostId: p.doc.hostId || '',
            tags: tagsStr,
            chunkIndex: p.chunkIndex,
            createdAt: p.doc.createdAt,
          })
        }

        if (p.needBm25) {
          bm25Docs.push({
            id: p.chunkId,
            docId: p.doc.id,
            content: p.text,
            filename: p.doc.filename,
            hostId: p.doc.hostId || '',
            tags: tagsStr,
          })
        }
      }

      if (vectorRecords.length > 0) {
        try {
          await this.vectorStorage.addRecords(vectorRecords)
        } catch (e) {
          log.error('repairIndex: 向量写入失败，跳过此批:', e)
        }
      }

      if (bm25Docs.length > 0) {
        try {
          await this.bm25Index.addDocuments(bm25Docs, { skipSave: true })
        } catch (e) {
          log.error('repairIndex: BM25 写入失败，跳过此批:', e)
        }
      }

      await new Promise<void>(resolve => setImmediate(resolve))
    }

    // 每处理这么多文档就落盘一次 BM25，实现可中断续传
    const REPAIR_CHECKPOINT_DOCS = 200
    let added = 0

    for (let i = 0; i < missingDocs.length; i++) {
      const doc = missingDocs[i]
      if (!doc.content) continue

      const needVector = !vectorDocIds.has(doc.id)
      const needBm25 = !bm25DocIds.has(doc.id)

      this.emit('repairProgress', {
        current: i + 1,
        total: missingDocs.length,
        filename: doc.filename,
      })

      try {
        let contentForIndex = doc.content
        if (isEncrypted(doc.content)) {
          try {
            contentForIndex = decrypt(doc.content)
          } catch (e) {
            log.warn(`repairIndex: 解密失败，跳过: ${doc.filename}`)
            continue
          }
        }

        const chunks = this.chunker.chunk(contentForIndex, doc.id, {
          filename: doc.filename,
          tags: doc.tags || [],
        })
        const isHostMemory = doc.fileType === 'host-memory'

        for (const chunk of chunks) {
          pendingChunks.push({
            doc,
            chunkId: chunk.id,
            chunkIndex: chunk.chunkIndex,
            text: chunk.content,
            isHostMemory,
            needVector,
            needBm25,
          })
          if (pendingChunks.length >= EMBED_BATCH_SIZE) {
            await flushRepairBatch()
          }
        }
        added++

        // 每 REPAIR_CHECKPOINT_DOCS 个文档落盘 BM25 一次（向量已每批落盘），
        // 保证中途退出可续传，不会丢失已处理进度
        if ((i + 1) % REPAIR_CHECKPOINT_DOCS === 0) {
          await flushRepairBatch()
          try {
            await this.bm25Index.saveIndex()
          } catch (e) {
            log.warn('repairIndex: BM25 saveIndex (checkpoint) 失败:', e)
          }
        }
      } catch (error) {
        log.error(`repairIndex: 处理 ${doc.filename} 失败:`, error)
      }
    }

    await flushRepairBatch()

    try {
      await this.bm25Index.saveIndex()
    } catch (e) {
      log.warn('repairIndex: BM25 saveIndex 失败:', e)
    }

    // 清理孤儿数据（documentsIndex 里没有、但索引里多余的）
    await this.cleanupOrphanData()

    const durationMs = Date.now() - t0
    log.info(`repairIndex 完成：补充了 ${added} 个文档，耗时 ${durationMs}ms`)
    this.emit('repairCompleted', { added, checked: allDocs.length, durationMs })

    return { checked: allDocs.length, added, durationMs }
  }

  /**
   * 检查并（增量）重建索引。
   *
   * 原实现：只要任一索引完全为空，就对全部文档重新 embed + 写入。
   * 新实现：先做差集比对，只处理在向量库或 BM25 中缺失的文档。
   *   - 正常启动（索引完整）：仅做两次 O(N) 集合查询，毫秒级返回，不再触发进度条。
   *   - 首次启用 / 模型升级 / 数据损坏（大量文档缺失）：只补缺失的文档，
   *     进度条只反映真正需要处理的文档数，不含已有索引的文档。
   *
   * 可中断续传：向量库每批落盘、BM25 每 CHECKPOINT_DOCS 个文档落盘一次，
   *   进程中途退出时已处理的文档不会丢失，下次启动只补剩余差集；补全后
   *   差集归零，后续启动不再重建。这一点对 conversation（L3 对话记录，
   *   数量可能上千）尤其关键——否则中途退出会让 BM25 进度全丢，导致每次
   *   启动都重复重建。
   */
  private async checkAndRebuildIndex(): Promise<void> {
    if (this.skipStartupVectorRebuild) {
      log.warn('启动时跳过索引补全：向量库当前无法安全读取，避免误触发全量重建')
      return
    }

    const docs = this.getDocuments()
    if (docs.length === 0) return

    // 并行获取两个索引的当前 docId 集合
    const [vectorDocIdsInitial, bm25DocIds] = await Promise.all([
      this.vectorStorage.getAllDocIds(),
      Promise.resolve(this.bm25Index.getIndexedDocIds()),
    ])
    let vectorDocIds = vectorDocIdsInitial

    // 防护：getAllDocIds 查询失败会返回空集，勿把「全库 5606 篇都缺失」误判为需全量补建
    if (vectorDocIds.size === 0 && docs.length >= 50) {
      const chunkCount = await this.vectorStorage.getChunkCount()
      if (chunkCount > 0) {
        log.warn(
          `向量库仍有 ${chunkCount} 条 chunk 但 getAllDocIds 返回空，1s 后重试`
        )
        await new Promise(resolve => setTimeout(resolve, 1000))
        vectorDocIds = await this.vectorStorage.getAllDocIds()
        if (vectorDocIds.size === 0) {
          log.error(
            `向量库有 ${chunkCount} 条 chunk 但无法枚举 docId，` +
            `跳过启动时索引补全（避免误触发接近全量的重建）`
          )
          return
        }
      }
    }

    // 找出各自缺失的文档（per-doc 粒度，而非整库空/非空判断）
    const missingDocs = docs.filter(doc => !vectorDocIds.has(doc.id) || !bm25DocIds.has(doc.id))

    if (missingDocs.length === 0) {
      // 索引完整，清掉上次遗留的 cause 标记，跳过重建
      this.lastClearReason = undefined
      return
    }

    // 统计各自需要补充的数量（用于日志和事件 reason）
    const missingVector = missingDocs.filter(d => !vectorDocIds.has(d.id))
    const missingBm25  = missingDocs.filter(d => !bm25DocIds.has(d.id))

    let needRebuildVector = missingVector.length > 0
    const needRebuildBM25  = missingBm25.length > 0

    log.info(
      `开始增量重建索引：文库共 ${docs.length} 篇，` +
      `本次需补充 ${missingDocs.length} 篇（vector=${missingVector.length} bm25=${missingBm25.length}）` +
      ` (cause=${this.lastClearReason || 'missing'})`
    )

    // 通知前端显示进度条，语义与原来一致
    const rebuildReason: 'vector' | 'bm25' | 'both' =
      needRebuildVector && needRebuildBM25 ? 'both'
      : needRebuildVector ? 'vector'
      : 'bm25'
    // cause 区分了"为什么会触发重建"：
    //   - 'dimension_mismatch': 真正的模型升级
    //   - 'data_corrupted'    : LanceDB 表损坏 / 物理 .lance 文件丢失
    //   - 'missing'           : 索引文件缺失（首次启用 / 用户删过 lancedb 目录 / BM25 .json 丢失）
    const cause = this.lastClearReason || 'missing'
    this.emit('rebuildStarted', {
      total: missingDocs.length,
      libraryTotal: docs.length,
      reason: rebuildReason,
      cause,
    })
    this.lastClearReason = undefined

    // 跨文档 embedding 攒批
    const EMBED_BATCH_SIZE = this.embeddingService.getMaxBatchSize()
    const VECTOR_BATCH_SIZE = 200
    let pendingVectorRecords: VectorRecord[] = []

    interface PendingChunk {
      doc: KnowledgeDocument
      chunkId: string
      chunkIndex: number
      text: string
      isHostMemory: boolean
      needVector: boolean
      needBm25: boolean
    }
    let pendingChunks: PendingChunk[] = []

    const flushEmbedBatch = async (): Promise<void> => {
      if (pendingChunks.length === 0) return

      const batch = pendingChunks
      pendingChunks = []

      let embeddings: number[][]
      try {
        embeddings = await this.embeddingService.embed(batch.map(p => p.text))
      } catch (err) {
        log.error(`embed 批量失败（${batch.length} 条），跳过此批:`, err)
        return
      }

      const batchRecords: VectorRecord[] = []
      const batchBm25Docs: Array<{
        id: string; docId: string; content: string
        filename: string; hostId: string; tags: string
      }> = []

      for (let i = 0; i < batch.length; i++) {
        const p = batch[i]
        const tagsStr = (p.doc.tags || []).join(',')
        if (p.needVector) {
          batchRecords.push({
            id: p.chunkId,
            docId: p.doc.id,
            content: p.isHostMemory ? encrypt(p.text) : p.text,
            vector: embeddings[i],
            filename: p.doc.filename,
            hostId: p.doc.hostId || '',
            tags: tagsStr,
            chunkIndex: p.chunkIndex,
            createdAt: p.doc.createdAt
          })
        }
        if (p.needBm25) {
          batchBm25Docs.push({
            id: p.chunkId,
            docId: p.doc.id,
            content: p.text,
            filename: p.doc.filename,
            hostId: p.doc.hostId || '',
            tags: tagsStr
          })
        }
      }

      if (needRebuildVector && batchRecords.length > 0) {
        pendingVectorRecords.push(...batchRecords)
        if (pendingVectorRecords.length >= VECTOR_BATCH_SIZE) {
          try {
            await this.vectorStorage.addRecords(pendingVectorRecords)
          } catch (batchError) {
            log.error('向量批量写入失败，停止向量重建（BM25 继续）:', batchError)
            needRebuildVector = false
          } finally {
            pendingVectorRecords = []
          }
        }
      }

      if (needRebuildBM25 && batchBm25Docs.length > 0) {
        try {
          await this.bm25Index.addDocuments(batchBm25Docs, { skipSave: true })
        } catch (e) {
          log.error('BM25 批量写入失败，跳过此批:', e)
        }
      }

      await new Promise<void>(resolve => setImmediate(resolve))
    }

    // 检查点：把内存中已处理但未持久化的数据落盘，实现可中断续传。
    // 向量库 addRecords 本就每批落盘，这里负责强制刷出攒批的剩余向量
    // 并触发 BM25 saveIndex（BM25 平时用 skipSave 只进内存，不落盘）。
    const CHECKPOINT_DOCS = 200
    const persistCheckpoint = async (): Promise<void> => {
      await flushEmbedBatch()
      if (needRebuildVector && pendingVectorRecords.length > 0) {
        try {
          await this.vectorStorage.addRecords(pendingVectorRecords)
        } catch (e) {
          log.error('向量批量写入失败（checkpoint）:', e)
          needRebuildVector = false
        } finally {
          pendingVectorRecords = []
        }
      }
      if (needRebuildBM25) {
        try {
          await this.bm25Index.saveIndex()
        } catch (e) {
          log.warn('BM25 saveIndex (checkpoint) 失败:', e)
        }
      }
    }

    for (let i = 0; i < missingDocs.length; i++) {
      const doc = missingDocs[i]
      if (!doc.content) continue

      const needVector = !vectorDocIds.has(doc.id)
      const needBm25   = !bm25DocIds.has(doc.id)

      this.emit('rebuildProgress', {
        current: i + 1,
        total: missingDocs.length,
        libraryTotal: docs.length,
        filename: doc.filename
      })

      try {
        let contentForIndex = doc.content
        if (isEncrypted(doc.content)) {
          try {
            contentForIndex = decrypt(doc.content)
          } catch (e) {
            log.warn(`解密失败，跳过: ${doc.filename}`)
            continue
          }
        }

        const chunks = this.chunker.chunk(contentForIndex, doc.id, {
          filename: doc.filename,
          tags: doc.tags || []
        })
        const isHostMemory = doc.fileType === 'host-memory'

        for (const chunk of chunks) {
          pendingChunks.push({
            doc,
            chunkId: chunk.id,
            chunkIndex: chunk.chunkIndex,
            text: chunk.content,
            isHostMemory,
            needVector,
            needBm25,
          })
          if (pendingChunks.length >= EMBED_BATCH_SIZE) {
            await flushEmbedBatch()
          }
        }

        if ((i + 1) % 100 === 0 || i === missingDocs.length - 1) {
          log.info(`已重建 ${i + 1}/${missingDocs.length}: ${doc.filename}`)
        }

        // 每 CHECKPOINT_DOCS 个文档落盘一次，保证中途退出可续传
        if ((i + 1) % CHECKPOINT_DOCS === 0) {
          await persistCheckpoint()
        }
      } catch (error) {
        log.error(`Failed to rebuild index for ${doc.filename}:`, error)
      }
    }

    // 最后一次 checkpoint：刷出剩余 chunks/向量 + 保存 BM25
    await persistCheckpoint()

    if (needRebuildVector) {
      try {
        log.info('增量重建完成，执行 compact...')
        await this.vectorStorage.compact(true)
      } catch (e) {
        log.warn('Compact failed after rebuild:', e)
      }
    }

    log.info(`索引增量重建完成，补充了 ${missingDocs.length} 个文档`)
  }

  /** 整表重建进行中时，检索需等待或短暂让路，避免 clear 与 search 并发 */
  private vectorRebuildPromise: Promise<void> | null = null

  /** 入库与孤儿清理的让路闸：入库优先，清理让路后补做 */
  private readonly ingestGate = new IngestGate(() => this.scheduleOrphanCleanupAsync())

  /**
   * 后台清理孤儿 chunk（索引里有、documents.json 里没有的 docId）。
   */
  scheduleOrphanCleanupAsync(): void {
    setImmediate(() => {
      this.cleanupOrphanData().catch(err => {
        log.warn('后台孤儿 chunk 清理失败:', err)
      })
    })
  }

  /** 软删除后仍查得到时，才考虑整表重建的孤儿 docId 数量下限 */
  private static readonly ORPHAN_FULL_TABLE_REBUILD_THRESHOLD = 50

  /** 定向删除 + compact 的最大重试轮数 */
  private static readonly ORPHAN_DELETE_MAX_RETRIES = 3

  /**
   * 清理孤儿数据（向量库和 BM25 中存在但 documentsIndex 中不存在的数据）
   *
   * LanceDB 的 delete() 仅创建 deletion vector（软删除标记），数据文件并未立即清除。
   * 优先对每个孤儿 docId 定向 removeDocumentChunks；仅当残留很多且多轮删除无效时
   * 才 fallback 到 rebuildVectorTable，避免为个位数孤儿 risk 整表 drop+写回。
   */
  private async cleanupOrphanData(): Promise<void> {
    // 有写入正在进行就让路：孤儿不占用户看得见的东西，晚点清都来得及，
    // 而删除 + compact 撞上写入会毁掉刚存进去的内容。让路会登记待办，
    // 等写入收尾时补做
    const ran = await this.ingestGate.cleanup(() => this.runOrphanCleanup())
    if (!ran && this.ingestGate.ingesting) {
      log.info('有内容正在入库，孤儿清理让路，入库结束后补做')
    }
  }

  private async runOrphanCleanup(): Promise<void> {
    try {
      // 清理在后台跑，期间用户可能正在入库。documentsIndex 必须每次现取：
      // 拿开头那一份快照去判定，会把清理期间新入库的文档当成孤儿删掉——
      // 文档列表里还在，chunk 已经没了，表现为「看得见搜不到」
      const currentValidDocIds = () => new Set(this.documentsIndex.keys())

      const orphanDocIds = await this.findOrphanDocIds(currentValidDocIds())
      if (orphanDocIds.length === 0) {
        return
      }

      // 删除目标在这里锁定。重试只负责确认这批删干净，不收编期间新出现的 docId
      // （那种 docId 更可能是正在入库、documents.json 还没落盘的正常文档）
      const targets = new Set(orphanDocIds)

      log.info(`发现 ${orphanDocIds.length} 个孤儿 docId（索引有 chunk、documents.json 无对应文档），开始定向清理...`)

      /** @returns 是否删完了；false 表示有写入插了进来，已让路 */
      const purgeOrphans = async (docIds: string[], aggressiveCompact: boolean): Promise<boolean> => {
        // 动手前的最后一道门：扫描到这里隔着好几次 await，期间可能有内容刚写完
        // 向量、还没登记进 documents.json，那种不是孤儿
        if (this.ingestGate.shouldYield()) {
          log.info('入库插了进来，孤儿清理让路，入库结束后补做')
          return false
        }
        for (const docId of docIds) {
          await this.vectorStorage.removeDocumentChunks(docId, false)
          await this.bm25Index.removeDocumentChunks(docId)
        }
        await this.vectorStorage.compact(aggressiveCompact)
        return true
      }

      const findRemainingTargets = async (): Promise<string[]> => {
        const valid = currentValidDocIds()
        // 期间被重新入库的（已回到 documents.json）也不再算残留
        return (await this.findOrphanDocIds(valid)).filter(docId => targets.has(docId))
      }

      // 首轮也先复核一遍，别拿首次扫描的名单直接删
      let remaining = await findRemainingTargets()
      for (let round = 0; round <= KnowledgeService.ORPHAN_DELETE_MAX_RETRIES && remaining.length > 0; round++) {
        if (round > 0) {
          log.info(`孤儿 chunk 残留 ${remaining.length} 个，定向删除重试 ${round}/${KnowledgeService.ORPHAN_DELETE_MAX_RETRIES}...`)
        }
        if (!await purgeOrphans(remaining, true)) {
          return
        }
        remaining = await findRemainingTargets()
      }

      if (remaining.length === 0) {
        log.info(`已清理 ${orphanDocIds.length} 个孤儿 docId 的索引 chunk`)
        return
      }

      if (remaining.length >= KnowledgeService.ORPHAN_FULL_TABLE_REBUILD_THRESHOLD) {
        // 整表重建是 drop + 全量写回，大库上耗时可观，期间入库都得等着
        if (this.ingestGate.shouldYield()) {
          log.info('入库插了进来，整表重建推迟到入库结束后')
          return
        }
        log.warn(
          `软删除后仍有 ${remaining.length} 个孤儿 docId 残留，` +
          '将重建向量表彻底清除...'
        )
        // 整表重建按当下的 documents.json 保留有效记录，否则会连带丢掉清理期间入库的文档
        await this.rebuildVectorTable(currentValidDocIds())
        log.info('向量表重建完成，孤儿数据已彻底清除')
        return
      }

      log.warn(
        `仍有 ${remaining.length} 个孤儿 docId 的 chunk 残留，跳过整表重建（不影响正常文档检索与补建）`
      )
    } catch (error) {
      log.error('清理孤儿数据失败:', error)
    }
  }

  /**
   * 查找向量存储中存在但 documentsIndex 中不存在的孤儿 docId
   */
  private async findOrphanDocIds(validDocIds: Set<string>): Promise<string[]> {
    const stats = await this.vectorStorage.getStats()
    if (stats.chunkCount === 0) return []

    const allDocIds = await this.vectorStorage.getAllDocIds()
    return Array.from(allDocIds).filter(docId => !validDocIds.has(docId))
  }

  /**
   * 从向量表中读取有效数据，drop 后重建，彻底清除孤儿数据
   */
  private async rebuildVectorTable(validDocIds: Set<string>): Promise<void> {
    if (this.vectorRebuildPromise) {
      await this.vectorRebuildPromise
      return
    }

    this.vectorRebuildPromise = (async () => {
      const validRecords = await this.vectorStorage.getValidRecords(validDocIds)
      await this.vectorStorage.clear()
      if (validRecords.length > 0) {
        const dimensions = this.embeddingService.getDimensions()
        await this.vectorStorage.initialize(dimensions)
        await this.vectorStorage.addRecords(validRecords)
      }
    })()

    try {
      await this.vectorRebuildPromise
    } finally {
      this.vectorRebuildPromise = null
    }
  }

  /**
   * 加载文档索引
   */
  private loadDocumentsIndex(): void {
    try {
      if (fs.existsSync(this.documentsMetaPath)) {
        const data = JSON.parse(fs.readFileSync(this.documentsMetaPath, 'utf-8'))
        let dirty = false
        for (const doc of data.documents || []) {
          const normalized = normalizeKnowledgeDocument(doc)
          if (isLibraryFileType(doc.fileType) && (doc.folder === undefined || doc.addedBy === undefined || doc.cardStatus === undefined)) {
            dirty = true
          }
          this.documentsIndex.set(normalized.id, normalized)
        }
        if (dirty) this.saveDocumentsIndex()
      }
    } catch (error) {
      log.error('Failed to load documents index:', error)
    }
  }

  /**
   * 保存文档索引
   * @returns 是否保存成功
   */
  private saveDocumentsIndex(): boolean {
    try {
      const dir = path.dirname(this.documentsMetaPath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
      
      const data = {
        version: 1,
        lastUpdated: Date.now(),
        documents: Array.from(this.documentsIndex.values())
      }
      
      // 先写入临时文件，再重命名，确保原子性
      const tempPath = this.documentsMetaPath + '.tmp'
      fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf-8')
      fs.renameSync(tempPath, this.documentsMetaPath)
      return true
    } catch (error) {
      log.error('Failed to save documents index:', error)
      return false
    }
  }

  /**
   * 计算内容哈希
   */
  private computeContentHash(content: string): string {
    return crypto.createHash('md5').update(content).digest('hex')
  }

  /**
   * 检查文档是否重复
   */
  isDuplicate(content: string): { isDuplicate: boolean; existingDoc?: KnowledgeDocument } {
    const hash = this.computeContentHash(content)
    
    const docs = Array.from(this.documentsIndex.values())
    for (const doc of docs) {
      if (doc.contentHash === hash) {
        return { isDuplicate: true, existingDoc: doc }
      }
    }
    
    return { isDuplicate: false }
  }

  /**
   * 添加文档到知识库
   */
  async addDocument(
    doc: ParsedDocument,
    options?: AddDocumentOptions
  ): Promise<string> {
    if (!this.isInitialized) {
      await this.initialize()
    }

    return this.ingestGate.ingest(() => this.ingestDocument(doc, options))
  }

  private async ingestDocument(
    doc: ParsedDocument,
    options?: AddDocumentOptions
  ): Promise<string> {
    const folder = isLibraryFileType(doc.fileType) ? normalizeFolder(options?.folder || '') : ''
    const contentHash = this.computeContentHash(doc.content)

    if (isLibraryFileType(doc.fileType)) {
      const samePath = this.findLibraryByPath(folder, doc.filename)
      if (samePath) {
        if (samePath.contentHash === contentHash) return samePath.id
        return this.replaceLibraryContent(samePath, doc, options, contentHash, folder)
      }
    }

    const duplicateCheck = this.isDuplicate(doc.content)
    if (duplicateCheck.isDuplicate && duplicateCheck.existingDoc) {
      log.info(`文档重复，已跳过: ${doc.filename} (与 ${duplicateCheck.existingDoc.filename} 相同)`)
      return duplicateCheck.existingDoc.id
    }

    const docId = uuidv4()
    const now = Date.now()
    const library = isLibraryFileType(doc.fileType)

    const document: KnowledgeDocument = {
      id: docId,
      filename: doc.filename,
      content: doc.content,
      fileSize: doc.fileSize,
      fileType: doc.fileType,
      contentHash,
      hostId: options?.hostId,
      tags: options?.tags || [],
      createdAt: now,
      updatedAt: now,
      chunkCount: 0,
      ...(library
        ? {
            folder,
            addedBy: options?.addedBy === 'agent' ? 'agent' as const : 'user' as const,
            ...initialCard(),
          }
        : {}),
    }

    // 分块
    const chunkOptions = options?.chunkOptions || {}
    this.chunker.setOptions({
      ...this.chunker.getOptions(),
      ...chunkOptions
    })

    const chunks = this.chunker.chunk(doc.content, docId, {
      filename: doc.filename,
      hostId: options?.hostId,
      tags: options?.tags || []
    })

    document.chunkCount = chunks.length

    // 生成 embedding
    const texts = chunks.map(c => c.content)
    const embeddings = await this.embeddingService.embed(texts)

    // 创建向量记录
    const records: VectorRecord[] = chunks.map((chunk, index) => ({
      id: chunk.id,
      docId,
      content: chunk.content,
      vector: embeddings[index],
      filename: doc.filename,
      hostId: options?.hostId || '',
      tags: (options?.tags || []).join(','),
      chunkIndex: chunk.chunkIndex,
      createdAt: now
    }))

    // 添加到向量存储
    await this.vectorStorage.addRecords(records)

    // 添加到 BM25 索引
    const bm25Docs = records.map(record => ({
      id: record.id,
      docId: record.docId,
      content: record.content,
      filename: record.filename,
      hostId: record.hostId,
      tags: record.tags
    }))
    await this.bm25Index.addDocuments(bm25Docs)

    // 保存文档索引
    this.documentsIndex.set(docId, document)
    this.saveDocumentsIndex()

    this.emit('documentAdded', document)

    return docId
  }

  /**
   * 删除文档
   * @param docId 文档 ID
   * @param forceCompact 是否强制执行 LanceDB compact（清理已删除数据）
   * @param skipSave 是否跳过保存（批量删除时使用，最后统一保存）
   */
  async removeDocument(docId: string, forceCompact: boolean = false, skipSave: boolean = false): Promise<boolean> {
    if (!this.documentsIndex.has(docId)) {
      return false
    }

    // 删除向量记录（传递 forceCompact 参数）
    await this.vectorStorage.removeDocumentChunks(docId, forceCompact)

    // 删除 BM25 索引记录
    await this.bm25Index.removeDocumentChunks(docId)
    this.cardVectors.remove(docId)

    // 删除文档索引
    this.documentsIndex.delete(docId)
    
    // 如果不是批量删除，立即保存
    if (!skipSave) {
      this.saveDocumentsIndex()
    }

    this.emit('documentRemoved', docId)
    return true
  }

  /**
   * 批量删除文档
   * 最后一个文档删除后会强制执行 compact 以确保数据完全清理
   */
  async removeDocuments(docIds: string[]): Promise<{ success: number; failed: number }> {
    let success = 0
    let failed = 0

    for (const docId of docIds) {
      try {
        // 批量删除：跳过中间 compact 和保存
        const result = await this.removeDocument(docId, false, true)
        if (result) {
          success++
        } else {
          failed++
        }
      } catch (error) {
        log.error(`Failed to remove document ${docId}:`, error)
        failed++
      }
    }

    if (success > 0) {
      const saved = this.saveDocumentsIndex()
      if (!saved) {
        log.error('批量删除后保存索引失败！')
        failed += success
        success = 0
      } else {
        // aggressive compact 立即清理旧版本数据文件
        await this.vectorStorage.compact(true)
        log.info(`批量删除完成: ${success} 成功, ${failed} 失败`)
      }
    }

    return { success, failed }
  }

  /**
   * 整表重建进行中时短暂等待，避免 search 与 clear 并发。
   */
  private async awaitVectorRebuildIfNeeded(): Promise<void> {
    if (!this.vectorRebuildPromise) return
    await Promise.race([
      this.vectorRebuildPromise,
      new Promise<void>(resolve => setTimeout(resolve, 30_000)),
    ])
  }

  /**
   * 搜索知识库
   */
  async search(query: string, options?: Partial<SearchOptions>): Promise<SearchResult[]> {
    if (!this.isInitialized) {
      await this.initialize()
    }

    await this.awaitVectorRebuildIfNeeded()

    const searchOptions: SearchOptions = {
      query,
      limit: options?.limit || this.settings.searchTopK,
      hostId: options?.hostId,
      tags: options?.tags,
      similarity: options?.similarity || 0.3,
      enableRerank: options?.enableRerank ?? this.settings.enableRerank,
      hybridWeight: options?.hybridWeight || 0.7
    }

    let results: SearchResult[] = []

    // 本地向量搜索
    if (this.settings.embeddingMode === 'local') {
      const queryEmbedding = await this.embeddingService.embedSingle(query)
      const localResults = await this.vectorStorage.hybridSearch(
        query,
        queryEmbedding,
        searchOptions
      )
      results.push(...localResults)
    }

    // MCP 知识库搜索
    if (this.mcpAdapter && this.mcpAdapter.isConnected()) {
      try {
        const mcpResults = await this.mcpAdapter.search(query, searchOptions)
        results.push(...mcpResults)
      } catch (error) {
        log.warn('MCP search failed:', error)
      }
    }

    // 去重（按内容相似度）
    results = this.deduplicateResults(results)

    // 重排序
    if (searchOptions.enableRerank && this.reranker && results.length > 0) {
      results = await this.reranker.rerank(query, results, searchOptions.limit!)
    }

    // 过滤掉已删除但残留在索引中的孤儿数据
    results = results.filter(result => {
      if (result.docId && !this.documentsIndex.has(result.docId)) {
        log.info('过滤孤儿数据:', result.docId)
        return false
      }
      return true
    })

    // 解密加密的内容（主机记忆等）
    results = results.map(result => {
      if (isEncrypted(result.content)) {
        try {
          return {
            ...result,
            content: decrypt(result.content)
          }
        } catch (e) {
          // 解密失败，保持原样（可能是密码未设置或错误）
          log.warn('解密失败:', e)
          return result
        }
      }
      return result
    })

    // 过滤低相关性结果（RRF 融合分数阈值）
    results = results.filter(r => r.score >= MIN_RRF_SCORE)

    return results.slice(0, searchOptions.limit)
  }

  /**
   * 结果去重
   */
  private deduplicateResults(results: SearchResult[]): SearchResult[] {
    const seen = new Set<string>()
    const unique: SearchResult[] = []

    for (const result of results) {
      // 使用内容的前 100 个字符作为去重键
      const key = result.content.slice(0, 100).trim()
      if (!seen.has(key)) {
        seen.add(key)
        unique.push(result)
      }
    }

    return unique
  }

  /**
   * 获取主机相关知识
   */
  async getHostKnowledge(hostId: string): Promise<SearchResult[]> {
    return this.search('', { hostId, limit: 20 })
  }

  /**
   * 清理文本中的无效转义序列，确保可以安全序列化为 JSON
   */
  private sanitizeText(text: string): string {
    if (!text) return ''
    return text
      // 移除无效的 hex escape 序列（如 \x 后面不是有效的十六进制）
      .replace(/\\x[^0-9a-fA-F]/g, ' ')
      .replace(/\\x[0-9a-fA-F](?![0-9a-fA-F])/g, ' ')
      // 移除其他可能导致 JSON 解析问题的控制字符
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
      // 确保反斜杠被正确处理
      .replace(/\\/g, '\\\\')
  }

  /**
   * 构建 AI 上下文
   * 只返回高相关性的知识库内容，避免召回不相关内容
   */
  async buildContext(
    query: string,
    options?: {
      hostId?: string
      maxTokens?: number
      recallingConversation?: RecallingConversation
      /** false：过往对话另有入口给出，这里只给文档 */
      includeConversations?: boolean
      /**
       * 这场对话的档案范围。undefined 表示用设置里的；
       * 空字符串表示这场明确要看全库。
       */
      pathPrefix?: string
    }
  ): Promise<string> {
    if (!this.isInitialized) await this.initialize()
    const folder = resolveRecallFolder(options?.pathPrefix, this.getSettings().recallFolder)
    try {
      if (await this.cardsUsable(folder)) {
        return await this.buildImpressionContext(query, { ...options, pathPrefix: folder })
      }
    } catch (error) {
      log.warn('目录印象召回失败，改用正文片段:', error)
    }
    return this.buildChunkContext(query, { ...options, pathPrefix: folder })
  }

  private libraryDocs(folder: string): KnowledgeDocument[] {
    return this.getDocuments().filter(doc =>
      isLibraryFileType(doc.fileType) && inFolder(doc.folder || '', folder)
    )
  }

  private async cardsUsable(folder: string): Promise<boolean> {
    if (this.cardVectors.isBroken()) return false
    const ready = this.libraryDocs(folder).filter(doc =>
      (doc.cardStatus === 'ready' || doc.cardStatus === 'stale') && !!doc.cardSummary
    )
    if (ready.length === 0) return false
    return ready.some(doc => this.cardVectors.has(doc.id))
  }

  private plainChunk(content: string): string | undefined {
    if (!isEncrypted(content)) return content
    try {
      return decrypt(content)
    } catch {
      return undefined
    }
  }

  private impressionDoc(doc: KnowledgeDocument): ImpressionDoc {
    return {
      id: doc.id,
      filename: doc.filename,
      folder: doc.folder || '',
      cardStatus: doc.cardStatus,
      cardSummary: doc.cardSummary,
    }
  }

  private async buildImpressionContext(
    query: string,
    options?: {
      hostId?: string
      recallingConversation?: RecallingConversation
      includeConversations?: boolean
      pathPrefix?: string
    }
  ): Promise<string> {
    const folder = options?.pathPrefix || ''
    const scoped = new Map(this.libraryDocs(folder).map(doc => [doc.id, doc]))
    const embedding = await this.embeddingService.embedSingle(query)

    const cardHits = this.cardVectors.search(embedding, MAX_IMPRESSIONS * 2)
      .filter(hit => hit.score >= CARD_SIMILARITY && scoped.has(hit.docId))
      .slice(0, MAX_IMPRESSIONS)

    let keyword: { docId: string; score: number; excerpt: string }[] = []
    if (this.bm25Index.isReady()) {
      const raw = await this.bm25Index.search(query, 30, { hostId: options?.hostId })
      keyword = bestKeywordPerDoc(
        raw
          .filter(hit => scoped.has(hit.docId))
          .map(hit => ({ docId: hit.docId, score: hit.score, excerpt: hit.content })),
        MIN_KEYWORD_SCORE,
        MAX_KEYWORD_DOCS
      )
    }

    const fused = fuseByDocument(cardHits.map(hit => hit.docId), keyword)
    const docs = new Map([...scoped.values()].map(doc => [doc.id, this.impressionDoc(doc)]))

    const hybrid = await this.vectorStorage.hybridSearch(query, embedding, {
      query,
      limit: AUTO_RECALL_LIMIT,
      similarity: AUTO_RECALL_SIMILARITY,
      hostId: options?.hostId,
    })
    const excerpts: { docId: string; text: string }[] = []
    for (const hit of hybrid) {
      if (!scoped.has(hit.docId) || hit.score < MIN_RRF_SCORE) continue
      if (!fused.some(row => row.docId === hit.docId)) {
        fused.push({
          docId: hit.docId,
          score: 0,
          fromCard: false,
          fromKeyword: true,
          excerpt: hit.content,
        })
      }
      if (excerpts.length >= MAX_EXCERPTS) continue
      const plain = this.plainChunk(hit.content)
      if (!plain) continue
      excerpts.push({
        docId: hit.docId,
        text: capChunkText(this.sanitizeText(plain), EXCERPT_CHARS),
      })
    }

    const memoryParts: string[] = []
    for (const hit of hybrid) {
      const doc = this.documentsIndex.get(hit.docId)
      if (doc?.fileType !== 'host-memory' || hit.score < MIN_RRF_SCORE) continue
      const plain = this.plainChunk(hit.content)
      if (!plain) continue
      memoryParts.push(`### ${hit.metadata.filename}`)
      memoryParts.push(capChunkText(this.sanitizeText(plain), EXCERPT_CHARS))
      memoryParts.push('')
    }

    this.noteCardTouches(fused.map(hit => hit.docId))

    const body = renderLibraryRecall({ fused, docs, excerpts })
    const parts: string[] = []
    if (body) parts.push(body)
    if (memoryParts.length > 0) parts.push(memoryParts.join('\n'))

    if (options?.includeConversations !== false) {
      const conversations = await this.recallConversations(query, embedding, options?.hostId, options?.recallingConversation)
      const recalled = formatRecalledConversations(conversations)
      if (recalled) parts.push(recalled)
    }

    return wrapKnowledgeRefs(parts.join('\n\n'))
  }

  private async recallConversations(
    query: string,
    embedding: number[],
    hostId: string | undefined,
    recalling: RecallingConversation | undefined
  ): Promise<RecalledConversation[]> {
    const hits = await this.vectorStorage.hybridSearch(query, embedding, {
      query,
      limit: AUTO_RECALL_LIMIT,
      similarity: AUTO_RECALL_SIMILARITY,
      hostId,
      tags: ['conversation'],
    })
    const conversations: RecalledConversation[] = []
    for (const hit of hits) {
      if (hit.score < MIN_RRF_SCORE) continue
      const doc = this.documentsIndex.get(hit.docId)
      if (!doc || doc.fileType !== 'conversation') continue
      conversations.push(toRecalledConversation(doc, hit.content, hit.score, recalling))
    }
    return conversations
  }

  private noteCardTouches(docIds: string[]): void {
    const now = Date.now()
    let dirty = false
    for (const docId of docIds) {
      const doc = this.documentsIndex.get(docId)
      if (!doc) continue
      if (doc.cardStatus !== 'pending' && doc.cardStatus !== 'failed') continue
      if (doc.cardTouchedAt && now - doc.cardTouchedAt < 60_000) continue
      doc.cardTouchedAt = now
      dirty = true
    }
    if (dirty) this.saveDocumentsIndex()
  }

  /** 说明还没就绪时的旧路：正文片段。补上字数上限。 */
  private async buildChunkContext(
    query: string,
    options?: {
      hostId?: string
      recallingConversation?: RecallingConversation
      includeConversations?: boolean
      pathPrefix?: string
    }
  ): Promise<string> {
    const results = await this.search(query, {
      hostId: options?.hostId,
      limit: AUTO_RECALL_LIMIT,
      similarity: AUTO_RECALL_SIMILARITY,
    })
    const relevantResults = results.filter(r => r.score >= MIN_RRF_SCORE)
    if (relevantResults.length === 0) return ''

    const parts: string[] = []
    const conversations: RecalledConversation[] = []
    let used = 0

    for (const result of relevantResults) {
      const doc = result.docId ? this.documentsIndex.get(result.docId) : undefined
      if (doc?.fileType === 'conversation') {
        if (options?.includeConversations !== false) {
          conversations.push(toRecalledConversation(doc, result.content, result.score, options?.recallingConversation))
        }
        continue
      }
      if (doc && isLibraryFileType(doc.fileType) && !inFolder(doc.folder || '', options?.pathPrefix || '')) {
        continue
      }
      const header = `### ${result.metadata.filename}`
      const room = RECALL_CHAR_BUDGET - used - header.length - 2
      if (room < 80) break
      const text = capChunkText(this.sanitizeText(result.content), Math.min(room, EXCERPT_CHARS))
      parts.push(header)
      parts.push(text)
      parts.push('')
      used += header.length + text.length + 2
    }

    const recalled = formatRecalledConversations(conversations)
    if (recalled) parts.push(recalled)
    if (parts.length === 0) return ''
    return wrapKnowledgeRefs(parts.join('\n'))
  }

  private findLibraryByPath(folder: string, filename: string): KnowledgeDocument | undefined {
    for (const doc of this.documentsIndex.values()) {
      if (!isLibraryFileType(doc.fileType)) continue
      if ((doc.folder || '') === folder && doc.filename === filename) return doc
    }
    return undefined
  }

  private cardOf(doc: KnowledgeDocument): CardFields {
    return {
      cardStatus: doc.cardStatus || 'pending',
      cardSummary: doc.cardSummary,
      cardSourceHash: doc.cardSourceHash,
      cardHumanEdited: doc.cardHumanEdited,
      cardTouchedAt: doc.cardTouchedAt,
      cardError: doc.cardError,
    }
  }

  private applyCard(doc: KnowledgeDocument, fields: CardFields): void {
    doc.cardStatus = fields.cardStatus
    doc.cardSummary = fields.cardSummary
    doc.cardSourceHash = fields.cardSourceHash
    doc.cardHumanEdited = fields.cardHumanEdited
    doc.cardTouchedAt = fields.cardTouchedAt
    doc.cardError = fields.cardError
  }

  private async replaceLibraryContent(
    existing: KnowledgeDocument,
    doc: ParsedDocument,
    options: AddDocumentOptions | undefined,
    contentHash: string,
    folder: string
  ): Promise<string> {
    const now = Date.now()
    const nextCard = onContentReplaced(this.cardOf(existing))
    if (nextCard.cardStatus === 'pending') this.cardVectors.remove(existing.id)

    const oldRecords = await this.vectorStorage.getRecordsByDocId(existing.id)
    const oldIds = oldRecords.map(record => record.id)
    let chunkCount: number
    try {
      chunkCount = await this.writeLibraryChunks(existing.id, doc, {
        ...options,
        tags: options?.tags ?? existing.tags,
        hostId: options?.hostId ?? existing.hostId,
      }, now)
    } catch (error) {
      log.warn(`换版写入失败，保留上一版索引: ${existing.filename}`, error)
      throw error
    }
    existing.content = doc.content
    existing.fileSize = doc.fileSize
    existing.fileType = doc.fileType
    existing.contentHash = contentHash
    existing.folder = folder
    existing.updatedAt = now
    existing.chunkCount = chunkCount
    if (options?.tags) existing.tags = options.tags
    if (options?.hostId !== undefined) existing.hostId = options.hostId
    this.applyCard(existing, nextCard)
    this.documentsIndex.set(existing.id, existing)
    this.saveDocumentsIndex()
    try {
      for (const id of oldIds) {
        await this.vectorStorage.removeRecord(id)
        await this.bm25Index.removeDocument(id)
      }
      if (oldIds.length > 0) await this.bm25Index.saveIndex()
    } catch (error) {
      log.warn(`换版后上一版片段没清干净: ${existing.filename}`, error)
    }
    this.emit('documentAdded', existing)
    return existing.id
  }

  private async writeLibraryChunks(
    docId: string,
    doc: ParsedDocument,
    options: AddDocumentOptions | undefined,
    now: number
  ): Promise<number> {
    const chunks = this.chunker.chunk(doc.content, docId, {
      filename: doc.filename,
      hostId: options?.hostId,
      tags: options?.tags || [],
    })
    if (chunks.length === 0) return 0
    const embeddings = await this.embeddingService.embed(chunks.map(chunk => chunk.content))
    const records: VectorRecord[] = chunks.map((chunk, index) => ({
      id: chunk.id,
      docId,
      content: chunk.content,
      vector: embeddings[index],
      filename: doc.filename,
      hostId: options?.hostId || '',
      tags: (options?.tags || []).join(','),
      chunkIndex: chunk.chunkIndex,
      createdAt: now,
    }))
    await this.vectorStorage.addRecords(records)
    await this.bm25Index.addDocuments(records.map(record => ({
      id: record.id,
      docId: record.docId,
      content: record.content,
      filename: record.filename,
      hostId: record.hostId,
      tags: record.tags,
    })))
    return chunks.length
  }

  /** 列出档案（不含主机记忆和过往对话）。只含路径、标题和一行说明。 */
  listCatalog(folder = ''): string {
    const prefix = folder ? normalizeFolder(folder) : ''
    return formatCatalog(this.libraryDocs(prefix).map(doc => this.impressionDoc(doc)), prefix)
  }

  listLibraryDocuments(): KnowledgeDocument[] {
    return this.getDocuments().filter(doc => isLibraryFileType(doc.fileType))
  }

  async updateCardText(docId: string, summary: string): Promise<boolean> {
    const doc = this.documentsIndex.get(docId)
    if (!doc || !isLibraryFileType(doc.fileType)) return false
    const next = onHumanEdit(this.cardOf(doc), summary, doc.contentHash)
    if (!next.cardSummary) return false
    this.applyCard(doc, next)
    this.documentsIndex.set(docId, doc)
    this.saveDocumentsIndex()
    await this.embedCardSummary(doc)
    return true
  }

  async confirmCardCurrent(docId: string): Promise<boolean> {
    const doc = this.documentsIndex.get(docId)
    if (!doc || !isLibraryFileType(doc.fileType) || !doc.cardSummary || !doc.contentHash) return false
    this.applyCard(doc, onHumanConfirm(this.cardOf(doc), doc.contentHash))
    this.documentsIndex.set(docId, doc)
    this.saveDocumentsIndex()
    return true
  }

  async moveLibraryDocument(docId: string, folder: string): Promise<boolean> {
    const doc = this.documentsIndex.get(docId)
    if (!doc || !isLibraryFileType(doc.fileType)) return false
    const next = normalizeFolder(folder || '')
    const clash = this.findLibraryByPath(next, doc.filename)
    if (clash && clash.id !== doc.id) return false
    doc.folder = next
    doc.updatedAt = Date.now()
    this.documentsIndex.set(docId, doc)
    this.saveDocumentsIndex()
    return true
  }

  cardProgress(): { pending: number; generating: number; ready: number; failed: number; stale: number } {
    const counts = { pending: 0, generating: 0, ready: 0, failed: 0, stale: 0 }
    for (const doc of this.listLibraryDocuments()) {
      const status = doc.cardStatus || 'pending'
      counts[status] += 1
    }
    return counts
  }

  /**
   * 秘书删档案。自己放的直接删；用户放的要先征得同意（由调用方完成）。
   * 返回需要确认时不删。
   */
  libraryDeleteNeedsConfirm(docId: string): boolean {
    const doc = this.documentsIndex.get(docId)
    if (!doc || !isLibraryFileType(doc.fileType)) return false
    return doc.addedBy !== 'agent'
  }

  private async embedCardSummary(doc: KnowledgeDocument): Promise<void> {
    if (!doc.cardSummary) return
    if (!this.isInitialized) return
    try {
      const vector = await this.embeddingService.embedSingle(doc.cardSummary)
      this.cardVectors.upsert(doc.id, vector)
    } catch (error) {
      log.warn(`检索说明的向量没写上: ${doc.filename}`, error)
    }
  }

  private startCardMaintenance(): void {
    this.resumeCardQueue()
    if (this.cardTimer) return
    this.cardFirstTick = setTimeout(() => {
      void this.runCardTick()
    }, 60_000)
    this.cardFirstTick.unref?.()
    this.cardTimer = setInterval(() => {
      void this.runCardTick()
    }, 10 * 60 * 1000)
    this.cardTimer.unref?.()
  }

  private resumeCardQueue(): void {
    let dirty = false
    for (const doc of this.listLibraryDocuments()) {
      const next = resumeInterrupted(this.cardOf(doc))
      if (next.cardStatus === doc.cardStatus) continue
      this.applyCard(doc, next)
      dirty = true
    }
    if (dirty) this.saveDocumentsIndex()
  }

  private async runCardTick(): Promise<void> {
    if (this.cardTickRunning || !this.isInitialized) return
    const quiet = this.configService.get('watchQuietHours')
    if (isQuietHour(new Date(), quiet)) return
    this.cardTickRunning = true
    try {
      await this.backfillCardVectors()
      const profileId = this.getSettings().cardProfileId?.trim()
      if (!profileId) return
      const now = new Date()
      if (this.cardQuota.usedToday(now) >= CARD_DAILY_LIMIT) return
      const next = pickNextCard(
        this.listLibraryDocuments().map(doc => ({
          id: doc.id,
          cardStatus: doc.cardStatus || 'pending',
          cardTouchedAt: doc.cardTouchedAt,
          createdAt: doc.createdAt,
        })),
        { remainingToday: CARD_DAILY_LIMIT - this.cardQuota.usedToday(now), remainingThisTick: CARD_TICK_LIMIT }
      )
      if (!next) return
      if (!this.cardQuota.take(now, CARD_DAILY_LIMIT)) return
      await this.generateOneCard(next.id, profileId)
    } catch (error) {
      log.warn('检索说明这一轮没写成:', error)
    } finally {
      this.cardTickRunning = false
    }
  }

  private async backfillCardVectors(): Promise<void> {
    let filled = 0
    for (const doc of this.listLibraryDocuments()) {
      if (filled >= CARD_VECTOR_BACKFILL_PER_TICK) break
      if (doc.cardStatus !== 'ready' && doc.cardStatus !== 'stale') continue
      if (!doc.cardSummary || this.cardVectors.has(doc.id)) continue
      await this.embedCardSummary(doc)
      filled++
    }
  }

  private async generateOneCard(docId: string, profileId: string): Promise<void> {
    const doc = this.documentsIndex.get(docId)
    if (!doc || !isLibraryFileType(doc.fileType)) return
    const hashAtStart = doc.contentHash || ''
    this.applyCard(doc, onGenerateStart(this.cardOf(doc)))
    this.saveDocumentsIndex()
    try {
      let plain = doc.content
      if (isEncrypted(plain)) plain = decrypt(plain)
      const messages: AiMessage[] = [{
        role: 'user',
        content: buildCardPrompt(doc.filename, doc.folder || '', plain),
      }]
      const summary = await this.aiService.chat(messages, profileId)
      const current = this.documentsIndex.get(docId)
      if (!current) return
      const next = onGenerateSuccess(this.cardOf(current), summary, hashAtStart, current.contentHash || '')
      this.applyCard(current, next)
      this.saveDocumentsIndex()
      if (next.cardStatus === 'ready') await this.embedCardSummary(current)
    } catch (error) {
      const current = this.documentsIndex.get(docId)
      if (!current) return
      const message = error instanceof Error ? error.message : String(error)
      this.applyCard(current, onGenerateFail(this.cardOf(current), message))
      this.saveDocumentsIndex()
    }
  }

  // ==================== 文档管理 ====================

  /**
   * 获取所有文档
   */
  getDocuments(): KnowledgeDocument[] {
    return Array.from(this.documentsIndex.values())
  }

  /**
   * 获取指定文档
   */
  getDocument(docId: string): KnowledgeDocument | undefined {
    return this.documentsIndex.get(docId)
  }

  /**
   * 按主机获取文档
   */
  getDocumentsByHost(hostId: string): KnowledgeDocument[] {
    return Array.from(this.documentsIndex.values())
      .filter(doc => doc.hostId === hostId)
  }

  /**
   * 按标签获取文档
   */
  getDocumentsByTag(tag: string): KnowledgeDocument[] {
    return Array.from(this.documentsIndex.values())
      .filter(doc => doc.tags.includes(tag))
  }

  // ==================== 模型管理 ====================

  /**
   * 获取所有模型
   */
  getModels(): ModelInfo[] {
    return this.modelManager.getModels()
  }

  /**
   * 获取模型状态
   */
  getModelStatuses(): ModelStatus[] {
    return this.modelManager.getModelStatuses()
  }

  /**
   * 下载模型
   */
  async downloadModel(
    modelId: ModelTier, 
    onProgress?: (percent: number, downloaded: number, total: number) => void
  ): Promise<void> {
    await this.modelManager.downloadModel(modelId, onProgress)
  }

  /**
   * 切换模型
   */
  async switchModel(modelId: ModelTier): Promise<void> {
    // 用户主动换模型：允许 Knowledge 层重新 initialize（与 Embedding 熔断清除对齐）
    this.permanentInitError = null
    await this.embeddingService.switchModel(modelId)
    
    // 更新设置
    this.settings.localModel = modelId
    this.configService.updateKnowledgeSettings({ localModel: modelId })
  }

  // ==================== 设置管理 ====================

  /**
   * 获取当前设置（始终从配置服务读取最新值）
   * 注意：此方法不会更新内部 this.settings 缓存，
   * this.settings 仅通过 constructor 和 updateSettings() 更新，
   * 避免配置存储异常时意外覆盖运行时状态。
   */
  getSettings(): KnowledgeSettings {
    return this.configService.getKnowledgeSettings()
  }

  /**
   * 更新设置
   */
  async updateSettings(settings: Partial<KnowledgeSettings>): Promise<void> {
    this.settings = { ...this.settings, ...settings }
    this.configService.setKnowledgeSettings(this.settings)

    // 更新分块策略（maxChunkSize 由模型自动决定）
    if (settings.chunkStrategy) {
      this.chunker.setOptions({
        strategy: this.settings.chunkStrategy
      })
    }

    // 更新重排序
    if (settings.enableRerank !== undefined) {
      if (settings.enableRerank && !this.reranker) {
        this.reranker = createReranker(this.aiService)
      } else if (!settings.enableRerank) {
        this.reranker = null
      }
    }

    if (settings.embeddingDevice !== undefined) {
      this.permanentInitError = null
      this.embeddingService.setDevice(this.settings.embeddingDevice)
      if (this.isInitialized && this.settings.embeddingMode === 'local') {
        const modelId = this.settings.localModel === 'auto'
          ? undefined
          : this.settings.localModel
        await this.embeddingService.initialize(modelId as ModelTier | undefined)
      }
    }

    this.emit('settingsUpdated', this.settings)
  }

  // ==================== 统计信息 ====================

  /**
   * 获取统计信息
   */
  async getStats(): Promise<KnowledgeStats> {
    const storageStats = await this.vectorStorage.getStats()
    
    return {
      documentCount: this.documentsIndex.size,
      chunkCount: storageStats.chunkCount,
      totalSize: Array.from(this.documentsIndex.values())
        .reduce((sum, doc) => sum + doc.fileSize, 0),
      lastUpdated: storageStats.lastUpdated
    }
  }

  // ==================== 服务状态 ====================

  /**
   * 检查服务是否就绪
   */
  isReady(): boolean {
    return this.isInitialized && this.embeddingService.isReady()
  }

  /**
   * 检查服务是否启用
   */
  isEnabled(): boolean {
    return this.settings.enabled
  }

  /**
   * 设置 MCP 服务
   */
  setMcpService(mcpService: McpService): void {
    this.mcpService = mcpService
  }

  /**
   * 清空知识库
   */
  async clear(): Promise<void> {
    await this.vectorStorage.clear()
    await this.bm25Index.clear()
    this.cardVectors.clear()
    this.documentsIndex.clear()
    const saved = this.saveDocumentsIndex()
    if (!saved) {
      throw new Error('清空知识库后保存索引失败')
    }
    this.emit('cleared')
  }

  /**
   * 导出知识库数据
   */
  async exportData(exportPath: string): Promise<{ success: boolean; error?: string; hasPassword?: boolean }> {
    try {
      const fs = await import('fs')
      const pathModule = await import('path')
      
      // 确保目录存在
      if (!fs.existsSync(exportPath)) {
        fs.mkdirSync(exportPath, { recursive: true })
      }
      
      // 1. 导出文档元数据
      const documents = this.getDocuments()
      const metaPath = pathModule.join(exportPath, 'knowledge-documents.json')
      fs.writeFileSync(metaPath, JSON.stringify(documents, null, 2), 'utf-8')
      
      // 2. 导出设置
      const settings = this.getSettings()
      const settingsPath = pathModule.join(exportPath, 'knowledge-settings.json')
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8')
      
      // 3. 复制 LanceDB 数据目录
      const lancedbSrc = pathModule.join(app.getPath('userData'), 'knowledge', 'lancedb')
      const lancedbDst = pathModule.join(exportPath, 'lancedb')
      if (fs.existsSync(lancedbSrc)) {
        this.copyDirectory(lancedbSrc, lancedbDst)
      }
      
      // 4. 导出密码验证文件（如果存在）
      const passwordSrc = pathModule.join(app.getPath('userData'), 'knowledge', '.password')
      const passwordDst = pathModule.join(exportPath, '.password')
      let hasPassword = false
      if (fs.existsSync(passwordSrc)) {
        fs.copyFileSync(passwordSrc, passwordDst)
        hasPassword = true
      }
      
      return { success: true, hasPassword }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : '导出失败' }
    }
  }

  /**
   * 检查导入数据是否包含加密内容
   */
  async checkImportData(importPath: string): Promise<{ hasPassword: boolean; hasEncryptedData: boolean }> {
    try {
      const fs = await import('fs')
      const pathModule = await import('path')
      
      // 检查是否有密码文件
      const passwordPath = pathModule.join(importPath, '.password')
      const hasPassword = fs.existsSync(passwordPath)
      
      // 检查文档中是否有加密数据
      let hasEncryptedData = false
      const metaPath = pathModule.join(importPath, 'knowledge-documents.json')
      if (fs.existsSync(metaPath)) {
        const documents = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
        for (const doc of documents) {
          if (doc.content?.startsWith('ENC:v1:')) {
            hasEncryptedData = true
            break
          }
        }
      }
      
      return { hasPassword, hasEncryptedData }
    } catch (error) {
      return { hasPassword: false, hasEncryptedData: false }
    }
  }

  /**
   * 导入知识库数据
   */
  async importData(importPath: string): Promise<{ success: boolean; error?: string; imported?: number; needsPassword?: boolean }> {
    try {
      const fs = await import('fs')
      const pathModule = await import('path')
      
      // 0. 检查并导入密码文件
      const passwordSrc = pathModule.join(importPath, '.password')
      const passwordDst = pathModule.join(app.getPath('userData'), 'knowledge', '.password')
      if (fs.existsSync(passwordSrc)) {
        // 确保目录存在
        const passwordDir = pathModule.dirname(passwordDst)
        if (!fs.existsSync(passwordDir)) {
          fs.mkdirSync(passwordDir, { recursive: true })
        }
        fs.copyFileSync(passwordSrc, passwordDst)
      }
      
      // 1. 导入设置
      const settingsPath = pathModule.join(importPath, 'knowledge-settings.json')
      if (fs.existsSync(settingsPath)) {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
        await this.updateSettings(settings)
      }
      
      // 2. 复制 LanceDB 数据
      const lancedbSrc = pathModule.join(importPath, 'lancedb')
      const lancedbDst = pathModule.join(app.getPath('userData'), 'knowledge', 'lancedb')
      if (fs.existsSync(lancedbSrc)) {
        // 先清空现有数据
        if (fs.existsSync(lancedbDst)) {
          fs.rmSync(lancedbDst, { recursive: true, force: true })
        }
        this.copyDirectory(lancedbSrc, lancedbDst)
      }
      
      // 3. 导入文档元数据
      const metaPath = pathModule.join(importPath, 'knowledge-documents.json')
      let importedCount = 0
      if (fs.existsSync(metaPath)) {
        const documents = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
        this.documentsIndex.clear()
        for (const doc of documents) {
          this.documentsIndex.set(doc.id, doc)
          importedCount++
        }
        this.saveDocumentsIndex()
      }
      
      // 重新初始化存储
      await this.vectorStorage.initialize()
      
      // 检查是否需要密码解锁
      const { hasPassword } = require('./crypto')
      const needsPassword = hasPassword()
      
      return { success: true, imported: importedCount, needsPassword }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : '导入失败' }
    }
  }

  /**
   * 复制目录
   */
  private copyDirectory(src: string, dst: string): void {
    const fs = require('fs')
    const path = require('path')
    
    if (!fs.existsSync(dst)) {
      fs.mkdirSync(dst, { recursive: true })
    }
    
    const entries = fs.readdirSync(src, { withFileTypes: true })
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name)
      const dstPath = path.join(dst, entry.name)
      
      if (entry.isDirectory()) {
        this.copyDirectory(srcPath, dstPath)
      } else {
        fs.copyFileSync(srcPath, dstPath)
      }
    }
  }

  /**
   * 释放资源
   */
  dispose(): void {
    this.embeddingService.dispose()
    this.isInitialized = false
    this.permanentInitError = null
    this.ingestGate.reset()
    this.emit('disposed')
  }

  /**
   * 优雅释放（主进程 quit 路径）：在 SIGTERM 之前给 worker 一段时间
   * 处理 dispose 消息，减少 ORT session 被强制中断带来的副作用。
   *
   * 注意：自动备份不在退出时做（同步文件复制会阻塞退出），而是放到
   * 下次 initialize() 时后台异步执行——见 initialize() 中的 scheduleAutoBackup。
   */
  async disposeAsync(timeoutMs: number = 500): Promise<void> {
    if (this.cardTimer) clearInterval(this.cardTimer)
    if (this.cardFirstTick) clearTimeout(this.cardFirstTick)
    this.cardTimer = null
    this.cardFirstTick = null
    try {
      await Promise.all([
        this.embeddingService.disposeAsync(timeoutMs),
        this.vectorStorage.disposeAsync(timeoutMs),
      ])
    } finally {
      this.isInitialized = false
      this.permanentInitError = null
      this.ingestGate.reset()
      this.emit('disposed')
    }
  }

  /**
   * 后台调度自动备份。
   *
   * 时机：initialize() 开头调用，此刻 worker 尚未启动、LanceDB 未连接，
   *      磁盘上是上次退出时的状态，文件级复制安全。
   * 频率：受 MIN_BACKUP_INTERVAL_MS（30min）限制，dev 频繁热重载时不会每次都复制。
   * 阻塞：完全不阻塞启动，setImmediate 推到下一个 tick。
   */
  private scheduleAutoBackup(): void {
    if (hasCorruptionMarker()) {
      log.info('自动备份跳过：已有损坏标记，先恢复、不备份坏库')
      return
    }
    setImmediate(() => {
      this.emit('backupStarted', { automatic: true })
      try {
        const result = doCreateBackup(true)
        // 自动备份被时间间隔跳过时 backupPath 为 undefined，不当作错误
        this.emit('backupCompleted', {
          success: result.success,
          backupPath: result.backupPath,
          error: result.backupPath === undefined ? undefined : result.error,
          skipped: result.backupPath === undefined,
        })
      } catch (e) {
        log.warn('自动备份失败:', e)
        this.emit('backupCompleted', {
          success: false,
          error: e instanceof Error ? e.message : String(e),
        })
      }
    })
  }

  // ==================== 备份 / 恢复 ====================

  /**
   * 创建一份知识库备份（手动触发，不受时间间隔限制）
   */
  async createBackup(): Promise<{ success: boolean; backupPath?: string; error?: string }> {
    this.emit('backupStarted', { automatic: false })
    try {
      const result = doCreateBackup(false)
      this.emit('backupCompleted', { success: result.success, backupPath: result.backupPath, error: result.error })
      return result
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      this.emit('backupCompleted', { success: false, error })
      throw e
    }
  }

  /**
   * 把当前知识库整包存到用户选的目录（与本机备份同一份格式，不进轮转）
   */
  async saveBackupTo(destParent: string): Promise<{ success: boolean; backupPath?: string; error?: string }> {
    this.emit('backupStarted', { automatic: false })
    try {
      const result = doSaveBackupTo(destParent)
      this.emit('backupCompleted', { success: result.success, backupPath: result.backupPath, error: result.error })
      return result
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      this.emit('backupCompleted', { success: false, error })
      throw e
    }
  }

  /**
   * 列出所有备份
   */
  listBackups(): BackupEntry[] {
    return doListBackups()
  }

  /** 用户选的文件夹是不是一份完整快照 */
  isKnowledgeSnapshot(dir: string): boolean {
    return isKnowledgeSnapshot(dir)
  }

  /** 自己是快照，或里面恰好只有一份 */
  resolveKnowledgeSnapshot(dir: string): string | null {
    return doResolveKnowledgeSnapshot(dir)
  }

  /**
   * 从备份恢复
   *
   * 恢复流程：
   * 1. 调 backup.restoreBackup 把磁盘文件换回来（保留损坏现场到 knowledge.broken-{ts}）
   * 2. 强制 vectorStorage 和 embeddingService 丢弃内存中的 worker / db 句柄
   * 3. 重新 initialize（会触发 tryRestoreFromBackupBeforeInit 但已无 .corrupted 标记，跳过）
   * 4. checkAndRebuildIndex 自动比对 docIds 差集，增量补建缺失文档
   *
   * 这样即便备份比当前旧几天，也只需补差集，不用全量重建。
   */
  async restoreBackup(backupPath?: string): Promise<{ success: boolean; backupPath?: string; error?: string }> {
    this.emit('restoreStarted', { backupPath })
    // 用户主动来恢复，之前「这批备份都救不回来」的结论作废，重新给机会
    clearRestoreExhausted()
    const result = doRestoreBackup(backupPath)
    if (!result.success) {
      this.emit('restoreCompleted', { success: false, error: result.error })
      return result
    }

    try {
      // 重新加载文档元数据（documents.json 已被备份覆盖）
      this.loadDocumentsIndex()

      // 强制 vectorStorage 和 embeddingService 重新初始化
      // embeddingService 必须先 dispose：initialize() 会重新 startWorker，
      // 不 dispose 的话旧 worker 还在跑、isDisposing 标记会拦截新调用
      await this.vectorStorage.forceReinitialize()
      try {
        await this.embeddingService.disposeAsync(1000)
      } catch (e) {
        log.warn('恢复时 dispose embeddingService 失败:', e)
      }
      this.isInitialized = false
      this.permanentInitError = null

      // 重新 initialize（含 checkAndRebuildIndex 增量补差集）
      await this.initialize()

      log.info('从备份恢复并增量补建完成')
      this.emit('restoreCompleted', { success: true, backupPath: result.backupPath })
    } catch (e) {
      log.error('恢复后重新初始化失败:', e)
      const error = `恢复成功但重新初始化失败: ${e instanceof Error ? e.message : String(e)}`
      this.emit('restoreCompleted', { success: false, error })
      return {
        success: false,
        backupPath: result.backupPath,
        error,
      }
    }

    return result
  }

  /**
   * 删除指定备份
   */
  deleteBackup(backupPath: string): boolean {
    return doDeleteBackup(backupPath)
  }

  // ==================== 主机记忆功能 ====================

  /**
   * 添加主机记忆
   * 将记忆信息保存到知识库，支持语义搜索
   * @param hostId 主机 ID
   * @param memory 记忆内容
   * @param options 可选的元数据（volatility、source）
   */
  async addHostMemory(
    hostId: string,
    memory: string,
    options?: { volatility?: MemoryVolatility; source?: string }
  ): Promise<string | null> {
    if (!hostId || !memory) {
      return null
    }

    // 和文档入库同一条路：先写向量再登记清单，中间那段窗口不能让孤儿清理动手
    return this.ingestGate.ingest(() => this.writeHostMemory(hostId, memory, options))
  }

  private async writeHostMemory(
    hostId: string,
    memory: string,
    options?: { volatility?: MemoryVolatility; source?: string }
  ): Promise<string | null> {
    try {
      if (!this.isInitialized) {
        await this.initialize()
      }

      // 检查是否已存在相同的记忆（精确哈希去重）
      const existingCheck = this.isDuplicate(memory)
      if (existingCheck.isDuplicate) {
        return existingCheck.existingDoc?.id || null
      }

      const docId = uuidv4()
      const now = Date.now()
      
      // 加密记忆内容
      const encryptedMemory = encrypt(memory)

      // 创建记忆文档（存储加密内容）
      const document: KnowledgeDocument = {
        id: docId,
        filename: `memory_${hostId}_${now}`,
        content: encryptedMemory,  // 存储加密后的内容
        fileSize: Buffer.from(memory).length,
        fileType: 'host-memory',  // 特殊类型标记
        contentHash: this.computeContentHash(memory),  // 使用原文计算哈希（用于去重）
        hostId: hostId,
        tags: ['host-memory', hostId],
        createdAt: now,
        updatedAt: now,
        chunkCount: 1,  // 记忆通常很短，只有一个 chunk
        // 观察日志模型新字段
        volatility: options?.volatility,
        source: options?.source
      }

      // 生成 embedding（使用原文生成，确保语义搜索正常工作）
      const embedding = await this.embeddingService.embedSingle(memory)

      // 创建向量记录（存储加密内容）
      const record: VectorRecord = {
        id: uuidv4(),
        docId,
        content: encryptedMemory,  // 存储加密后的内容
        vector: embedding,
        filename: document.filename,
        hostId: hostId,
        tags: document.tags.join(','),
        chunkIndex: 0,
        createdAt: now
      }

      // 添加到向量存储
      await this.vectorStorage.addRecords([record])

      // 添加到 BM25 索引（使用原文，而非加密内容，确保关键词搜索正常工作）
      await this.bm25Index.addDocuments([{
        id: record.id,
        docId: record.docId,
        content: memory,
        filename: record.filename,
        hostId: record.hostId,
        tags: record.tags
      }])

      // 保存文档索引
      this.documentsIndex.set(docId, document)
      this.saveDocumentsIndex()

      return docId
    } catch (error) {
      log.error('保存主机记忆失败:', error)
      return null
    }
  }

  /**
   * 搜索主机记忆
   * 返回与查询相关的主机记忆
   */
  async searchHostMemories(
    hostId: string, 
    query?: string, 
    limit: number = 10
  ): Promise<SearchResult[]> {
    // 检查主机记忆功能是否启用
    if (this.settings.enableHostMemory === false) {
      return []
    }

    if (!this.isInitialized) {
      await this.initialize()
    }

    await this.awaitVectorRebuildIfNeeded()

    try {
      // 如果没有 query，返回该主机的最近记忆
      if (!query) {
        // 获取该主机的所有记忆文档
        const hostDocs = this.getDocumentsByHost(hostId)
          .filter(doc => doc.fileType === 'host-memory')
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(0, limit)

        return hostDocs.map(doc => {
          // 解密内容
          const decryptedContent = decrypt(doc.content)
          return {
            id: doc.id,
            docId: doc.id,
            content: decryptedContent,
            score: 1.0,
            metadata: {
              filename: doc.filename,
              hostId: doc.hostId,
              tags: doc.tags,
              startOffset: 0,
              endOffset: decryptedContent.length
            },
            source: 'local' as const
          }
        })
      }

      // 使用语义搜索
      const queryEmbedding = await this.embeddingService.embedSingle(query)
      const results = await this.vectorStorage.hybridSearch(
        query,
        queryEmbedding,
        {
          query,
          limit,
          hostId,
          tags: ['host-memory'],
          similarity: 0.5  // 较低的阈值，确保能找到相关记忆
        }
      )

      // 解密搜索结果中的内容
      return results.map(result => ({
        ...result,
        content: decrypt(result.content)
      }))
    } catch (error) {
      log.error('搜索主机记忆失败:', error)
      return []
    }
  }

  /**
   * 内部方法：获取去重后的主机记忆（带元数据）
   * 
   * 核心改进：读时去重（Observation Ledger 模型）
   * 1. 获取该主机的所有记忆文档
   * 2. 一次性获取全部向量记录（避免 N+1 查询）
   * 3. 用 embedding 余弦相似度聚类（同一主题的观察归为一组）
   * 4. 每个聚类只取最新的一条（最新观察胜出）
   * 5. 按相关度/时间排序后返回
   */
  private async getHostMemoriesInternal(
    hostId: string,
    contextHint?: string,
    maxMemories: number = 15
  ): Promise<HostMemoryItem[]> {
    // 获取该主机的全部记忆文档
    const hostDocs = this.getDocumentsByHost(hostId)
      .filter(doc => doc.fileType === 'host-memory')

    if (hostDocs.length === 0) return []

    // 一次性批量获取向量记录（避免 N+1 查询）
    const docIds = new Set(hostDocs.map(d => d.id))
    let vectorMap = new Map<string, number[]>()
    try {
      const recordsMap = await this.vectorStorage.getRecordsByDocIds(docIds)
      for (const [docId, record] of recordsMap) {
        if (record.vector?.length > 0) {
          vectorMap.set(docId, record.vector)
        }
      }
    } catch (error) {
      log.warn('向量批量获取失败，跳过聚类去重:', error)
      vectorMap = new Map()
    }

    // 解密所有记忆并组装
    const memoryItems: HostMemoryItem[] = []

    for (const doc of hostDocs) {
      try {
        const decryptedContent = decrypt(doc.content)
        memoryItems.push({
          docId: doc.id,
          content: decryptedContent,
          createdAt: doc.createdAt,
          vector: vectorMap.get(doc.id) || null,
          volatility: doc.volatility,
          source: doc.source
        })
      } catch {
        // 解密失败，跳过
      }
    }

    if (memoryItems.length === 0) return []

    // 读时去重：embedding 聚类，每个聚类只取最新
    const deduplicated = deduplicateMemories(
      memoryItems,
      0.75,
      EmbeddingService.cosineSimilarity
    )
    
    // 如果有上下文提示，按相关性排序
    if (contextHint && this.embeddingService.isReady()) {
      try {
        const queryEmbedding = await this.embeddingService.embedSingle(contextHint)
        const scored = deduplicated.map(item => ({
          item,
          relevance: item.vector
            ? EmbeddingService.cosineSimilarity(queryEmbedding, item.vector)
            : 0
        }))
        scored.sort((a, b) => b.relevance - a.relevance)
        return scored.slice(0, maxMemories).map(s => s.item)
      } catch {
        deduplicated.sort((a, b) => b.createdAt - a.createdAt)
      }
    } else {
      deduplicated.sort((a, b) => b.createdAt - a.createdAt)
    }

    return deduplicated.slice(0, maxMemories)
  }

  /**
   * 获取主机的所有记忆（用于构建 prompt）
   * 返回去重后的记忆内容字符串数组
   */
  async getHostMemoriesForPrompt(
    hostId: string, 
    contextHint?: string,
    maxMemories: number = 15
  ): Promise<string[]> {
    if (this.settings.enableHostMemory === false) {
      return []
    }

    try {
      const items = await this.getHostMemoriesInternal(hostId, contextHint, maxMemories)
      return items.map(m => m.content)
    } catch (error) {
      log.error('获取主机记忆失败:', error)
      return []
    }
  }

  /**
   * 获取主机记忆（带元数据，用于 prompt 时效标注）
   * 返回 HostMemoryEntry[] 格式，包含 createdAt、volatility、source
   * 
   */
  async getHostMemoriesWithMetadata(
    hostId: string,
    contextHint?: string,
    maxMemories: number = 15
  ): Promise<Array<{ content: string; createdAt: number; volatility?: MemoryVolatility; source?: string }>> {
    if (this.settings.enableHostMemory === false) {
      return []
    }

    try {
      const items = await this.getHostMemoriesInternal(hostId, contextHint, maxMemories)
      return items.map(item => ({
        content: item.content,
        createdAt: item.createdAt,
        volatility: item.volatility,
        source: item.source
      }))
    } catch (error) {
      log.error('getHostMemoriesWithMetadata 失败:', error)
      return []
    }
  }

  /**
   * 获取主机记忆数量
   */
  getHostMemoryCount(hostId: string): number {
    return this.getDocumentsByHost(hostId)
      .filter(doc => doc.fileType === 'host-memory')
      .length
  }

  /**
   * 删除主机的所有记忆
   */
  async clearHostMemories(hostId: string): Promise<number> {
    const memoryDocs = this.getDocumentsByHost(hostId)
      .filter(doc => doc.fileType === 'host-memory')
    
    if (memoryDocs.length === 0) return 0

    let deleted = 0
    for (const doc of memoryDocs) {
      // 批量删除时跳过中间 compact 和保存
      const success = await this.removeDocument(doc.id, false, true)
      if (success) deleted++
    }

    if (deleted > 0) {
      this.saveDocumentsIndex()
      // aggressive compact 立即清理旧版本数据文件，避免重启后出现孤儿
      await this.vectorStorage.compact(true)
    }

    return deleted
  }

  /**
   * 迁移旧的 notes 到知识库
   * 用于从 HostProfile.notes 迁移到知识库
   */
  async migrateNotesToKnowledge(hostId: string, notes: string[]): Promise<number> {
    let migrated = 0
    for (const note of notes) {
      const result = await this.addHostMemory(hostId, note)
      if (result) migrated++
    }
    return migrated
  }

  /**
   * 智能添加记忆（观察日志模型：append-only + 读时去重）
   * 
   * 写入路径极简：只做精确哈希去重，通过就直接 append。
   * 冲突解决推迟到读取时（getHostMemoriesForPrompt），
   * 通过 embedding 聚类 + "最新观察胜出" 规则自动处理。
   */
  async addHostMemorySmart(
    hostId: string,
    memory: string,
    options?: { volatility?: MemoryVolatility; source?: string }
  ): Promise<SmartMemoryResult> {
    if (!hostId || !memory) {
      return { success: false, action: 'error', message: '参数无效' }
    }

    // 检查主机记忆功能是否启用
    if (this.settings.enableHostMemory === false) {
      return { success: false, action: 'disabled', message: '主机记忆功能已禁用' }
    }

    try {
      // 精确哈希去重（内容完全相同则跳过）
      const existingCheck = this.isDuplicate(memory)
      if (existingCheck.isDuplicate) {
        return { success: true, action: 'skip', message: '记忆已存在，跳过保存' }
      }

      // Append-only：直接写入，带上元数据
      const docId = await this.addHostMemory(hostId, memory, options)
      if (docId) {
        return { success: true, action: 'save', message: '记忆已保存', docId }
      }
      return { success: false, action: 'error', message: '保存失败' }
    } catch (error) {
      log.error('智能添加记忆失败:', error)
      // 出错时尝试普通保存
      const docId = await this.addHostMemory(hostId, memory, options)
      return {
        success: !!docId,
        action: 'save',
        message: '检测失败，已直接保存',
        docId: docId || undefined
      }
    }
  }

  // ==================== 对话索引（跨会话语义检索）====================

  /**
   * 索引一次对话摘要，用于未来的跨会话语义检索。
   * 不调用 LLM，仅将 userRequest + finalResult 写入向量库。
   */
  async indexConversation(entry: ConversationIndexEntry): Promise<string | null> {
    if (!entry.userRequest || !entry.hostId) return null

    return this.ingestGate.ingest(() => this.writeConversationIndex(entry))
  }

  private async writeConversationIndex(entry: ConversationIndexEntry): Promise<string | null> {
    try {
      if (!this.isInitialized) {
        await this.initialize()
      }

      const indexText = entry.finalResult
        ? `${entry.userRequest}\n${entry.finalResult}`
        : entry.userRequest

      // 以 taskId 作为去重依据，同一任务不重复索引
      const contentHash = this.computeContentHash(`conv:${entry.taskId}`)
      const existing = Array.from(this.documentsIndex.values()).find(
        d => d.fileType === 'conversation' && d.contentHash === contentHash
      )
      if (existing) return existing.id

      const docId = uuidv4()
      const now = entry.timestamp || Date.now()
      const tags = ['conversation', entry.hostId]
      if (entry.sessionId) tags.push(conversationSessionTag(entry.sessionId))

      const document: KnowledgeDocument = {
        id: docId,
        filename: `conv_${entry.hostId}_${entry.taskId}`,
        content: indexText,
        fileSize: Buffer.from(indexText).length,
        fileType: 'conversation',
        contentHash,
        hostId: entry.hostId,
        tags,
        createdAt: now,
        updatedAt: now,
        chunkCount: 1,
        source: entry.status
      }

      const embedding = await this.embeddingService.embedSingle(indexText)

      const record: VectorRecord = {
        id: uuidv4(),
        docId,
        content: indexText,
        vector: embedding,
        filename: document.filename,
        hostId: entry.hostId,
        tags: document.tags.join(','),
        chunkIndex: 0,
        createdAt: now
      }

      await this.vectorStorage.addRecords([record])
      await this.bm25Index.addDocuments([{
        id: record.id,
        docId: record.docId,
        content: indexText,
        filename: record.filename,
        hostId: record.hostId,
        tags: record.tags
      }])

      this.documentsIndex.set(docId, document)
      this.saveDocumentsIndex()

      return docId
    } catch (error) {
      log.error('对话索引失败:', error)
      return null
    }
  }

  /**
   * 删除指定会话对应的对话检索条目（向量 + 关键词索引 + 文档清单）。
   * 只删对得上号的；对不上的旧条目不动。
   */
  async removeConversation(sessionId: string): Promise<number> {
    if (!sessionId.trim()) return 0

    try {
      if (!this.isInitialized) {
        if (!this.isEnabled()) return 0
        await this.initialize()
      }

      const sessionContentHash = this.computeContentHash(`conv:${sessionId}`)
      const docs = Array.from(this.documentsIndex.values()).filter(doc =>
        isConversationDocForSession(doc, sessionId, sessionContentHash)
      )
      if (docs.length === 0) return 0

      let deleted = 0
      for (const doc of docs) {
        try {
          const ok = await this.removeDocument(doc.id, false, true)
          if (ok) deleted++
        } catch (error) {
          log.warn(`删除对话索引条目失败: ${doc.id}`, error)
        }
      }
      if (deleted > 0) {
        this.saveDocumentsIndex()
      }
      return deleted
    } catch (error) {
      log.warn('删除对话索引失败:', error)
      return 0
    }
  }

  /**
   * 语义检索相关历史对话。
   * 返回与当前查询最相关的历史对话摘要（按相关度排序）。
   */
  async searchConversations(
    query: string,
    hostId?: string,
    limit: number = 5,
    recallingConversation?: RecallingConversation
  ): Promise<ConversationSearchResult[]> {
    try {
      if (!this.isInitialized) {
        await this.initialize()
      }

      await this.awaitVectorRebuildIfNeeded()

      const queryEmbedding = await this.embeddingService.embedSingle(query)
      const results = await this.vectorStorage.hybridSearch(
        query,
        queryEmbedding,
        {
          query,
          limit: limit * 2,
          hostId,
          tags: ['conversation'],
          similarity: 0.35
        }
      )

      if (results.length === 0) return []

      const conversationResults: ConversationSearchResult[] = []

      for (const r of results) {
        const doc = this.documentsIndex.get(r.docId)
        if (!doc || doc.fileType !== 'conversation') continue

        conversationResults.push({
          taskId: doc.filename.replace(`conv_${doc.hostId}_`, ''),
          ...toRecalledConversation(doc, r.content, r.score, recallingConversation),
        })
      }

      return conversationResults.slice(0, limit)
    } catch (error) {
      log.error('对话检索失败:', error)
      return []
    }
  }

  /**
   * 批量回填历史对话到向量索引。
   * 在后台逐条索引已有的 AgentRecord，跳过已索引的记录（通过 contentHash 去重）。
   */
  async backfillConversationIndex(
    records: Array<{
      id: string
      userTask?: string
      finalResult?: string
      status?: string
      timestamp: number
      hostId?: string
    }>
  ): Promise<{ indexed: number; skipped: number; failed: number }> {
    let indexed = 0
    let skipped = 0
    let failed = 0

    for (const record of records) {
      if (!record.userTask?.trim()) {
        skipped++
        continue
      }

      try {
        const docId = await this.indexConversation({
          taskId: record.id,
          sessionId: record.id,
          hostId: record.hostId || 'personal',
          userRequest: record.userTask,
          finalResult: record.finalResult || '',
          status: record.status === 'completed' ? 'success'
            : record.status === 'failed' ? 'failed'
            : 'aborted',
          timestamp: record.timestamp
        })

        if (docId) {
          indexed++
        } else {
          skipped++
        }
      } catch {
        failed++
      }
    }

    log.info(`对话索引回填完成: indexed=${indexed}, skipped=${skipped}, failed=${failed}`)
    return { indexed, skipped, failed }
  }
}

// 导出单例
let knowledgeService: KnowledgeService | null = null

export function getKnowledgeService(
  configService?: ConfigService,
  aiService?: AiService,
  mcpService?: McpService
): KnowledgeService | null {
  if (!knowledgeService && configService && aiService) {
    knowledgeService = new KnowledgeService(configService, aiService, mcpService)
  }
  return knowledgeService
}

// 导出类型和子模块
export * from './types'
export {
  conversationSessionTag,
  isConversationDocForSession,
  formatRecalledConversations,
  type RecalledConversation,
  type RecallingConversation,
} from './conversation-index'
export { getModelManager } from './model-manager'
export { getEmbeddingService } from './embedding'
export { getVectorStorage } from './storage'
export { getChunker, createChunker } from './chunker'
export { McpKnowledgeAdapter } from './mcp-adapter'
export { createReranker } from './reranker'
export { getBM25Index } from './bm25'

