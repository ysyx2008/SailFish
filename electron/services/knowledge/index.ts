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
  ModelStatus
} from './types'
import { DEFAULT_KNOWLEDGE_SETTINGS } from './types'

import { getModelManager, ModelManager } from './model-manager'
import { getEmbeddingService, EmbeddingService } from './embedding'
import { getVectorStorage, VectorStorage, VectorRecord } from './storage'
import { getChunker, Chunker } from './chunker'
import { McpKnowledgeAdapter } from './mcp-adapter'
import { createReranker, Reranker } from './reranker'
import { getBM25Index, BM25Index } from './bm25'
import { encrypt, decrypt, isEncrypted } from './crypto'

import type { AiService } from '../ai.service'
import type { McpService } from '../mcp.service'
import type { ConfigService } from '../config.service'
import type { ParsedDocument } from '../document-parser.service'

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
    
    // 设置分块选项
    this.chunker.setOptions({
      maxChunkSize: this.settings.maxChunkSize,
      strategy: this.settings.chunkStrategy
    })
    
    // 文档索引存储路径
    this.documentsMetaPath = path.join(app.getPath('userData'), 'knowledge', 'documents.json')
    
    // 加载文档索引
    this.loadDocumentsIndex()
  }

  /**
   * 初始化知识库服务
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return
    }

    console.log('[KnowledgeService] Initializing...')

    try {
      // 初始化 Embedding 服务
      if (this.settings.embeddingMode === 'local') {
        const modelId = this.settings.localModel === 'auto' 
          ? undefined 
          : this.settings.localModel
        await this.embeddingService.initialize(modelId)
      }

      // 初始化向量存储
      const dimensions = this.embeddingService.getDimensions()
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
      console.log('[KnowledgeService] Initialized successfully')
      
      // 检查是否需要重建索引（有文档但向量库是空的）
      await this.checkAndRebuildIndex()
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
    
    console.log(`[KnowledgeService] Found ${docs.length} documents, rebuilding index...`)
    
    for (const doc of docs) {
      if (!doc.content) continue
      
      try {
        // 重新分块
        const chunks = this.chunker.chunk(doc.content, doc.id, { filename: doc.filename, tags: doc.tags || [] })
        
        // 生成 embedding
        const texts = chunks.map(c => c.content)
        const embeddings = await this.embeddingService.embed(texts)
        
        // 创建向量记录
        const records: VectorRecord[] = chunks.map((chunk, index) => ({
          id: chunk.id,
          docId: doc.id,
          content: chunk.content,
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
        
        // 添加到 BM25 索引（仅当 BM25 索引为空时）
        if (bm25Stats.documentCount === 0) {
          const bm25Docs = records.map(record => ({
            id: record.id,
            docId: record.docId,
            content: record.content,
            filename: record.filename,
            hostId: record.hostId,
            tags: record.tags
          }))
          await this.bm25Index.addDocuments(bm25Docs)
        }
        
        console.log(`[KnowledgeService] Rebuilt index for: ${doc.filename} (${chunks.length} chunks)`)
      } catch (error) {
        console.error(`[KnowledgeService] Failed to rebuild index for ${doc.filename}:`, error)
      }
    }
    
    console.log('[KnowledgeService] Index rebuild complete')
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
        console.log(`[KnowledgeService] Loaded ${this.documentsIndex.size} documents`)
      }
    } catch (error) {
      console.error('[KnowledgeService] Failed to load documents index:', error)
    }
  }

  /**
   * 保存文档索引
   */
  private saveDocumentsIndex(): void {
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
      
      fs.writeFileSync(this.documentsMetaPath, JSON.stringify(data, null, 2), 'utf-8')
    } catch (error) {
      console.error('[KnowledgeService] Failed to save documents index:', error)
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
    console.log(`[KnowledgeService] Added document: ${doc.filename} (${chunks.length} chunks)`)

    return docId
  }

  /**
   * 删除文档
   */
  async removeDocument(docId: string): Promise<boolean> {
    if (!this.documentsIndex.has(docId)) {
      return false
    }

    // 删除向量记录
    await this.vectorStorage.removeDocumentChunks(docId)

    // 删除 BM25 索引记录
    await this.bm25Index.removeDocumentChunks(docId)

    // 删除文档索引
    this.documentsIndex.delete(docId)
    this.saveDocumentsIndex()

    this.emit('documentRemoved', docId)
    return true
  }

  /**
   * 批量删除文档
   */
  async removeDocuments(docIds: string[]): Promise<{ success: number; failed: number }> {
    let success = 0
    let failed = 0

    for (const docId of docIds) {
      try {
        const result = await this.removeDocument(docId)
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
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
      // 确保反斜杠被正确处理
      .replace(/\\/g, '\\\\')
  }

  /**
   * 构建 AI 上下文
   */
  async buildContext(
    query: string, 
    options?: { hostId?: string; maxTokens?: number }
  ): Promise<string> {
    const results = await this.search(query, {
      hostId: options?.hostId,
      limit: 5
    })

    if (results.length === 0) {
      return ''
    }

    const parts: string[] = ['## 相关知识库内容\n']
    
    for (const result of results) {
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
   */
  getSettings(): KnowledgeSettings {
    // 从配置服务获取最新设置
    const currentSettings = this.configService.getKnowledgeSettings()
    this.settings = currentSettings
    return { ...currentSettings }
  }

  /**
   * 更新设置
   */
  async updateSettings(settings: Partial<KnowledgeSettings>): Promise<void> {
    this.settings = { ...this.settings, ...settings }
    this.configService.setKnowledgeSettings(this.settings)

    // 更新分块选项
    if (settings.maxChunkSize || settings.chunkStrategy) {
      this.chunker.setOptions({
        maxChunkSize: this.settings.maxChunkSize,
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
    this.saveDocumentsIndex()
    this.emit('cleared')
  }

  /**
   * 导出知识库数据
   */
  async exportData(exportPath: string): Promise<{ success: boolean; error?: string }> {
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
      
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : '导出失败' }
    }
  }

  /**
   * 导入知识库数据
   */
  async importData(importPath: string): Promise<{ success: boolean; error?: string; imported?: number }> {
    try {
      const fs = await import('fs')
      const pathModule = await import('path')
      
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
      
      return { success: true, imported: importedCount }
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
   */
  async addHostMemory(hostId: string, memory: string): Promise<string | null> {
    if (!hostId || !memory) {
      return null
    }

    try {
      if (!this.isInitialized) {
        await this.initialize()
      }

      // 检查是否已存在相同的记忆（避免重复）
      const existingCheck = this.isDuplicate(memory)
      if (existingCheck.isDuplicate) {
        console.log(`[KnowledgeService] 主机记忆已存在，跳过: ${memory.slice(0, 50)}...`)
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
        chunkCount: 1  // 记忆通常很短，只有一个 chunk
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

      // 添加到 BM25 索引
      await this.bm25Index.addDocuments([{
        id: record.id,
        docId: record.docId,
        content: record.content,
        filename: record.filename,
        hostId: record.hostId,
        tags: record.tags
      }])

      // 保存文档索引
      this.documentsIndex.set(docId, document)
      this.saveDocumentsIndex()

      console.log(`[KnowledgeService] 已保存主机记忆: ${memory.slice(0, 50)}...`)
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
   * 获取主机的所有记忆（用于构建 prompt）
   * 优先返回与当前上下文相关的记忆
   */
  async getHostMemoriesForPrompt(
    hostId: string, 
    contextHint?: string,
    maxMemories: number = 15
  ): Promise<string[]> {
    try {
      let memories: SearchResult[] = []

      if (contextHint) {
        // 如果有上下文提示，先搜索相关记忆
        memories = await this.searchHostMemories(hostId, contextHint, maxMemories)
      }

      // 如果搜索结果不足，补充最近的记忆
      if (memories.length < maxMemories) {
        const recentMemories = await this.searchHostMemories(hostId, undefined, maxMemories - memories.length)
        // 合并并去重
        const existingIds = new Set(memories.map(m => m.docId))
        for (const m of recentMemories) {
          if (!existingIds.has(m.docId)) {
            memories.push(m)
          }
        }
      }

      return memories.map(m => m.content)
    } catch (error) {
      console.error('[KnowledgeService] 获取主机记忆失败:', error)
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
    for (const doc of memoryDocs) {
      const success = await this.removeDocument(doc.id)
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
    console.log(`[KnowledgeService] 迁移了 ${migrated}/${notes.length} 条主机记忆`)
    return migrated
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

