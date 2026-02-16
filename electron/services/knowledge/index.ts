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

import type { AiService } from '../ai.service'
import type { McpService } from '../mcp.service'
import type { ConfigService } from '../config.service'
import type { ParsedDocument } from '../document-parser.service'

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

/**
 * RRF 融合分数阈值
 * RRF 分数 = 1/(k+rank+1)，k=60 时：
 * - 单通道第1名 ≈ 0.0164，第2名 ≈ 0.0161
 * - 双通道命中时分数叠加 ≈ 0.032
 * 0.02 表示至少在一个通道排名靠前，或在两个通道都有匹配
 */
const MIN_RRF_SCORE = 0.02

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
  private isInitialized: boolean = false

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
    this.vectorStorage = getVectorStorage()
    this.chunker = getChunker()
    this.bm25Index = getBM25Index()
    
    // 设置分块选项（maxChunkSize 在初始化后根据模型自动设置）
    this.chunker.setOptions({
      strategy: this.settings.chunkStrategy
    })
    
    // 文档索引存储路径
    this.documentsMetaPath = path.join(app.getPath('userData'), 'knowledge', 'documents.json')
    
    // 加载文档索引
    this.loadDocumentsIndex()
    
    // 自检：配置存储异常恢复
    // 当配置被重置为默认值（加密密钥变化、文件损坏等），但文档索引仍在磁盘上时，
    // 自动恢复 enabled 和 enableHostMemory 设置，避免用户感知到"知识库突然消失"。
    if (!this.settings.enabled && this.documentsIndex.size > 0) {
      console.warn(
        `[KnowledgeService] 配置异常恢复：知识库已禁用但存在 ${this.documentsIndex.size} 个文档，自动启用。` +
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

    try {
      // 初始化 Embedding 服务
      if (this.settings.embeddingMode === 'local') {
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
        console.log(`[KnowledgeService] 模型维度变化 ${oldDim} -> ${newDim}，同步清空 BM25 索引...`)
        await this.bm25Index.clear()
        this.emit('indexCleared', { reason: 'dimension_mismatch', oldDimensions: oldDim, newDimensions: newDim })
      })
      
      await this.vectorStorage.initialize(dimensions)

      // 初始化 BM25 索引
      await this.bm25Index.initialize()

      // 初始化重排序服务
      if (this.settings.enableRerank) {
        this.reranker = createReranker(this.aiService)
      }

      // 初始化 MCP 适配器
      if (this.mcpService && this.settings.mcpKnowledgeServerId) {
        this.mcpAdapter = new McpKnowledgeAdapter(
          this.mcpService, 
          this.settings.mcpKnowledgeServerId
        )
      }

      this.isInitialized = true
      this.emit('initialized')
      
      // 检查是否需要重建索引（有文档但向量库是空的）
      await this.checkAndRebuildIndex()
      
      // 清理孤儿数据（向量库和 BM25 中存在但 documentsIndex 中不存在的数据）
      await this.cleanupOrphanData()
    } catch (error) {
      console.error('[KnowledgeService] Initialization failed:', error)
      this.emit('error', error)
      throw error
    }
  }
  
  /**
   * 检查并重建索引
   */
  private async checkAndRebuildIndex(): Promise<void> {
    const docs = this.getDocuments()
    if (docs.length === 0) return
    
    const stats = await this.vectorStorage.getStats()
    const bm25Stats = this.bm25Index.getStats()
    
    // 如果向量库和 BM25 索引都有数据，跳过重建
    if (stats.chunkCount > 0 && bm25Stats.documentCount > 0) return
    
    console.log(`[KnowledgeService] 开始重建索引，共 ${docs.length} 个文档...`)
    
    for (let i = 0; i < docs.length; i++) {
      const doc = docs[i]
      if (!doc.content) continue
      
      // 发送重建进度
      this.emit('rebuildProgress', { 
        current: i + 1, 
        total: docs.length, 
        filename: doc.filename 
      })
      
      try {
        // 对加密内容（host-memory）先解密，确保分词和 embedding 基于原文
        let contentForIndex = doc.content
        if (isEncrypted(doc.content)) {
          try {
            contentForIndex = decrypt(doc.content)
          } catch (e) {
            console.warn(`[KnowledgeService] 解密失败，跳过: ${doc.filename}`)
            continue
          }
        }

        // 重新分块
        const chunks = this.chunker.chunk(contentForIndex, doc.id, { filename: doc.filename, tags: doc.tags || [] })
        
        // 生成 embedding
        const texts = chunks.map(c => c.content)
        const embeddings = await this.embeddingService.embed(texts)
        
        // 创建向量记录（host-memory 重新加密存储，普通文档保持原样）
        const isHostMemory = doc.fileType === 'host-memory'
        const records: VectorRecord[] = chunks.map((chunk, index) => ({
          id: chunk.id,
          docId: doc.id,
          content: isHostMemory ? encrypt(chunk.content) : chunk.content,
          vector: embeddings[index],
          filename: doc.filename,
          hostId: doc.hostId || '',
          tags: (doc.tags || []).join(','),
          chunkIndex: chunk.chunkIndex,
          createdAt: doc.createdAt
        }))
        
        // 添加到向量存储（仅当向量库为空时）
        if (stats.chunkCount === 0) {
          await this.vectorStorage.addRecords(records)
        }
        
        // 添加到 BM25 索引（仅当 BM25 索引为空时，使用原文确保关键词搜索有效）
        if (bm25Stats.documentCount === 0) {
          const bm25Docs = chunks.map((chunk, index) => ({
            id: records[index].id,
            docId: doc.id,
            content: chunk.content,
            filename: doc.filename,
            hostId: doc.hostId || '',
            tags: (doc.tags || []).join(',')
          }))
          await this.bm25Index.addDocuments(bm25Docs)
        }
        
        console.log(`[KnowledgeService] 已重建 ${i + 1}/${docs.length}: ${doc.filename}`)
      } catch (error) {
        console.error(`[KnowledgeService] Failed to rebuild index for ${doc.filename}:`, error)
      }
    }
    
    console.log('[KnowledgeService] 索引重建完成')
  }

  /**
   * 清理孤儿数据（向量库和 BM25 中存在但 documentsIndex 中不存在的数据）
   */
  private async cleanupOrphanData(): Promise<void> {
    try {
      const validDocIds = new Set(this.documentsIndex.keys())
      let cleanedCount = 0

      // 统计当前状态
      const memoryCount = Array.from(this.documentsIndex.values())
        .filter(doc => doc.fileType === 'host-memory').length
      console.log(`[KnowledgeService] 当前 documentsIndex 中有 ${this.documentsIndex.size} 个文档，其中 ${memoryCount} 个是主机记忆`)

      // 获取向量存储中的所有 docIds
      const stats = await this.vectorStorage.getStats()
      console.log(`[KnowledgeService] 向量存储中有 ${stats.chunkCount} 个分块`)
      
      if (stats.chunkCount > 0) {
        // 遍历向量存储，找出孤儿 docIds
        const allDocIds = await this.vectorStorage.getAllDocIds()
        const docIdArray = Array.from(allDocIds)
        console.log(`[KnowledgeService] 向量存储中有 ${docIdArray.length} 个唯一文档`)
        
        for (const docId of docIdArray) {
          if (!validDocIds.has(docId)) {
            await this.vectorStorage.removeDocumentChunks(docId)
            await this.bm25Index.removeDocumentChunks(docId)
            cleanedCount++
            console.log('[KnowledgeService] 清理孤儿数据:', docId)
          }
        }
      }

      if (cleanedCount > 0) {
        console.log(`[KnowledgeService] 清理了 ${cleanedCount} 个孤儿文档`)
      } else {
        console.log('[KnowledgeService] 没有发现孤儿数据')
      }
    } catch (error) {
      console.error('[KnowledgeService] 清理孤儿数据失败:', error)
    }
  }

  /**
   * 加载文档索引
   */
  private loadDocumentsIndex(): void {
    try {
      if (fs.existsSync(this.documentsMetaPath)) {
        const data = JSON.parse(fs.readFileSync(this.documentsMetaPath, 'utf-8'))
        for (const doc of data.documents || []) {
          this.documentsIndex.set(doc.id, doc)
        }
      }
    } catch (error) {
      console.error('[KnowledgeService] Failed to load documents index:', error)
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
      console.error('[KnowledgeService] Failed to save documents index:', error)
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

    // 检查重复
    const contentHash = this.computeContentHash(doc.content)
    const duplicateCheck = this.isDuplicate(doc.content)
    
    if (duplicateCheck.isDuplicate && duplicateCheck.existingDoc) {
      console.log(`[KnowledgeService] 文档重复，已跳过: ${doc.filename} (与 ${duplicateCheck.existingDoc.filename} 相同)`)
      // 返回已存在文档的 ID，不重复添加
      return duplicateCheck.existingDoc.id
    }

    const docId = uuidv4()
    const now = Date.now()

    // 创建文档记录
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
      chunkCount: 0
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
    const total = docIds.length

    for (let i = 0; i < docIds.length; i++) {
      const docId = docIds[i]
      const isLast = i === total - 1
      try {
        // 最后一个文档删除时强制 compact，批量删除时跳过中间保存
        const result = await this.removeDocument(docId, isLast, true)
        if (result) {
          success++
        } else {
          failed++
        }
      } catch (error) {
        console.error(`[KnowledgeService] Failed to remove document ${docId}:`, error)
        failed++
      }
    }

    // 批量删除完成后统一保存一次
    if (success > 0) {
      const saved = this.saveDocumentsIndex()
      if (!saved) {
        console.error('[KnowledgeService] 批量删除后保存索引失败！')
        // 保存失败时，将所有已删除的标记为失败
        failed += success
        success = 0
      } else {
        console.log(`[KnowledgeService] 批量删除完成: ${success} 成功, ${failed} 失败，已执行 compact 并保存索引`)
      }
    }

    return { success, failed }
  }

  /**
   * 搜索知识库
   */
  async search(query: string, options?: Partial<SearchOptions>): Promise<SearchResult[]> {
    if (!this.isInitialized) {
      await this.initialize()
    }

    const searchOptions: SearchOptions = {
      query,
      limit: options?.limit || this.settings.searchTopK,
      hostId: options?.hostId,
      tags: options?.tags,
      similarity: options?.similarity || 0.7,
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
        console.warn('[KnowledgeService] MCP search failed:', error)
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
        console.log('[KnowledgeService] 过滤孤儿数据:', result.docId)
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
          console.warn('[KnowledgeService] 解密失败:', e)
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
    options?: { hostId?: string; maxTokens?: number }
  ): Promise<string> {
    // 使用较高的相似度阈值，确保召回的内容确实相关
    const results = await this.search(query, {
      hostId: options?.hostId,
      limit: 5,
      similarity: 0.6  // 提高阈值，过滤低相关性内容
    })

    if (results.length === 0) {
      return ''
    }

    // 二次过滤：确保只保留高相关性结果（search 已做过滤，这里是双重保障）
    const relevantResults = results.filter(r => r.score >= MIN_RRF_SCORE)

    if (relevantResults.length === 0) {
      console.log('[KnowledgeService] 知识库搜索结果相关性不足，跳过召回')
      return ''
    }

    const parts: string[] = ['## 相关知识库内容\n']
    
    for (const result of relevantResults) {
      parts.push(`### ${result.metadata.filename}`)
      // 清理内容中的特殊字符
      parts.push(this.sanitizeText(result.content))
      parts.push('')
    }

    return parts.join('\n')
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

    // 更新 MCP 适配器
    if (settings.mcpKnowledgeServerId !== undefined) {
      if (settings.mcpKnowledgeServerId && this.mcpService) {
        this.mcpAdapter = new McpKnowledgeAdapter(
          this.mcpService,
          settings.mcpKnowledgeServerId
        )
      } else {
        this.mcpAdapter = null
      }
    }

    // 更新重排序
    if (settings.enableRerank !== undefined) {
      if (settings.enableRerank && !this.reranker) {
        this.reranker = createReranker(this.aiService)
      } else if (!settings.enableRerank) {
        this.reranker = null
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
    
    if (this.settings.mcpKnowledgeServerId) {
      this.mcpAdapter = new McpKnowledgeAdapter(
        mcpService,
        this.settings.mcpKnowledgeServerId
      )
    }
  }

  /**
   * 清空知识库
   */
  async clear(): Promise<void> {
    await this.vectorStorage.clear()
    await this.bm25Index.clear()
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
    this.emit('disposed')
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
      console.error('[KnowledgeService] 保存主机记忆失败:', error)
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
      console.error('[KnowledgeService] 搜索主机记忆失败:', error)
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
      // 向量获取失败，继续但跳过聚类去重
      console.warn('[KnowledgeService] 向量批量获取失败，跳过聚类去重:', error)
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
      0.80,
      EmbeddingService.cosineSimilarity
    )
    
    // 如果有上下文提示，按相关性排序
    if (contextHint && this.embeddingService.isReady()) {
      try {
        const queryEmbedding = await this.embeddingService.embedSingle(contextHint)
        // 计算每条记忆与上下文的相关度，使用临时数组避免 as any
        const scored = deduplicated.map(item => ({
          item,
          relevance: item.vector
            ? EmbeddingService.cosineSimilarity(queryEmbedding, item.vector)
            : 0
        }))
        scored.sort((a, b) => b.relevance - a.relevance)
        return scored.slice(0, maxMemories).map(s => s.item)
      } catch {
        // 排序失败，按时间排序（最新在前）
        deduplicated.sort((a, b) => b.createdAt - a.createdAt)
      }
    } else {
      // 无上下文提示，按时间排序（最新在前）
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
      console.error('[KnowledgeService] 获取主机记忆失败:', error)
      return []
    }
  }

  /**
   * 获取主机记忆（带元数据，用于 prompt 时效标注）
   * 返回 HostMemoryEntry[] 格式，包含 createdAt、volatility、source
   * 
   * 直接复用 getHostMemoriesInternal 的去重结果，无需重复解密
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
      console.error('[KnowledgeService] getHostMemoriesWithMetadata 失败:', error)
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
    
    let deleted = 0
    const total = memoryDocs.length
    for (let i = 0; i < memoryDocs.length; i++) {
      const doc = memoryDocs[i]
      const isLast = i === total - 1
      // 最后一个删除时强制 compact
      const success = await this.removeDocument(doc.id, isLast)
      if (success) deleted++
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
      console.error('[KnowledgeService] 智能添加记忆失败:', error)
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
export { getModelManager } from './model-manager'
export { getEmbeddingService } from './embedding'
export { getVectorStorage } from './storage'
export { getChunker, createChunker } from './chunker'
export { McpKnowledgeAdapter } from './mcp-adapter'
export { createReranker } from './reranker'
export { getBM25Index } from './bm25'

