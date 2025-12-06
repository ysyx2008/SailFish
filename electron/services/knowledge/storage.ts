/**
 * Orama 向量存储服务
 * 提供向量存储、全文搜索和混合搜索功能
 */
import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import { EventEmitter } from 'events'
import type { 
  OramaRecord, 
  SearchOptions, 
  SearchResult, 
  KnowledgeDocument,
  KnowledgeStats 
} from './types'

// 动态导入 Orama
let orama: any = null

async function loadOrama() {
  if (!orama) {
    orama = await import('@orama/orama')
  }
  return orama
}

export class VectorStorage extends EventEmitter {
  private db: any = null
  private storagePath: string
  private documentsPath: string
  private isInitialized: boolean = false
  // 内存中保存完整记录（包含 embedding），用于持久化
  private recordsCache: Map<string, OramaRecord> = new Map()

  constructor() {
    super()
    this.storagePath = path.join(app.getPath('userData'), 'knowledge')
    this.documentsPath = path.join(this.storagePath, 'documents.json')
    
    this.ensureDirectories()
  }

  /**
   * 确保存储目录存在
   */
  private ensureDirectories(): void {
    if (!fs.existsSync(this.storagePath)) {
      fs.mkdirSync(this.storagePath, { recursive: true })
    }
  }

  /**
   * 初始化数据库
   */
  async initialize(dimensions: number = 384): Promise<void> {
    if (this.isInitialized) {
      return
    }

    const { create, insert } = await loadOrama()

    // 创建数据库 schema
    this.db = await create({
      schema: {
        id: 'string',
        docId: 'string',
        content: 'string',
        embedding: `vector[${dimensions}]`,
        filename: 'string',
        hostId: 'string',
        tags: 'string[]',
        chunkIndex: 'number',
        createdAt: 'number'
      }
    })

    // 加载持久化数据
    await this.loadFromDisk()

    this.isInitialized = true
    this.emit('initialized')
  }

  /**
   * 从磁盘加载数据
   */
  private async loadFromDisk(): Promise<void> {
    const dataPath = path.join(this.storagePath, 'vectors.json')
    
    console.log(`[VectorStorage] Loading from: ${dataPath}`)
    
    if (!fs.existsSync(dataPath)) {
      console.log('[VectorStorage] No vectors.json found')
      return
    }

    try {
      const data = JSON.parse(fs.readFileSync(dataPath, 'utf-8'))
      console.log(`[VectorStorage] Found ${data.records?.length || 0} records in file`)
      
      const { insert } = await loadOrama()

      let insertedCount = 0
      for (const record of data.records || []) {
        // 跳过没有 embedding 的记录
        if (!record.embedding || record.embedding === null) {
          console.warn(`[VectorStorage] Skipping record without embedding: ${record.id}`)
          continue
        }
        try {
          await insert(this.db, record)
          // 同时加入缓存
          this.recordsCache.set(record.id, record)
          insertedCount++
        } catch (e) {
          console.error(`[VectorStorage] Failed to insert record ${record.id}:`, e)
        }
      }
      console.log(`[VectorStorage] Inserted ${insertedCount} records into Orama`)

      // 验证数据库中的记录数
      const { count } = await loadOrama()
      const dbCount = await count(this.db)
      console.log(`[VectorStorage] Loaded ${this.recordsCache.size} records from disk, DB count: ${dbCount}`)
    } catch (error) {
      console.error('[VectorStorage] Failed to load data from disk:', error)
    }
  }

  /**
   * 持久化数据到磁盘
   */
  private async saveToDisk(): Promise<void> {
    if (!this.db) return

    const dataPath = path.join(this.storagePath, 'vectors.json')

    try {
      // 从缓存获取所有记录（包含完整的 embedding）
      const records: OramaRecord[] = Array.from(this.recordsCache.values())

      const data = {
        version: 1,
        lastUpdated: Date.now(),
        recordCount: records.length,
        records: records
      }

      fs.writeFileSync(dataPath, JSON.stringify(data), 'utf-8')
      console.log(`[VectorStorage] Saved ${records.length} records to disk`)
    } catch (error) {
      console.error('[VectorStorage] Failed to save data to disk:', error)
    }
  }

  /**
   * 添加记录
   */
  async addRecord(record: OramaRecord): Promise<string> {
    if (!this.db) {
      throw new Error('数据库未初始化')
    }

    const { insert } = await loadOrama()
    await insert(this.db, record)
    
    // 保存到缓存
    this.recordsCache.set(record.id, record)
    
    // 异步保存到磁盘
    this.saveToDisk().catch(console.error)
    
    this.emit('recordAdded', record.id)
    return record.id
  }

  /**
   * 批量添加记录
   */
  async addRecords(records: OramaRecord[]): Promise<string[]> {
    if (!this.db) {
      throw new Error('数据库未初始化')
    }

    const { insertMultiple } = await loadOrama()
    await insertMultiple(this.db, records)
    
    // 保存到缓存
    for (const record of records) {
      this.recordsCache.set(record.id, record)
    }
    
    // 异步保存到磁盘
    this.saveToDisk().catch(console.error)
    
    const ids = records.map(r => r.id)
    this.emit('recordsAdded', ids)
    return ids
  }

  /**
   * 删除记录
   */
  async removeRecord(id: string): Promise<boolean> {
    if (!this.db) {
      throw new Error('数据库未初始化')
    }

    const { remove } = await loadOrama()
    
    try {
      await remove(this.db, id)
      // 从缓存删除
      this.recordsCache.delete(id)
      this.saveToDisk().catch(console.error)
      this.emit('recordRemoved', id)
      return true
    } catch {
      return false
    }
  }

  /**
   * 删除文档的所有分块
   */
  async removeDocumentChunks(docId: string): Promise<number> {
    if (!this.db) {
      throw new Error('数据库未初始化')
    }

    const { remove } = await loadOrama()
    
    // 从缓存中找出所有属于该文档的分块
    const idsToRemove: string[] = []
    Array.from(this.recordsCache.entries()).forEach(([id, record]) => {
      if (record.docId === docId) {
        idsToRemove.push(id)
      }
    })

    let removed = 0
    for (const id of idsToRemove) {
      try {
        await remove(this.db, id)
        this.recordsCache.delete(id)
        removed++
      } catch {
        // 忽略删除失败
      }
    }

    if (removed > 0) {
      this.saveToDisk().catch(console.error)
      this.emit('documentRemoved', { docId, chunksRemoved: removed })
    }

    return removed
  }

  /**
   * 向量搜索
   */
  async searchByVector(
    embedding: number[], 
    options: Partial<SearchOptions> = {}
  ): Promise<SearchResult[]> {
    if (!this.db) {
      throw new Error('数据库未初始化')
    }

    const { search } = await loadOrama()
    const limit = options.limit || 10
    const similarity = options.similarity || 0.7

    const results = await search(this.db, {
      mode: 'vector',
      vector: {
        value: embedding,
        property: 'embedding'
      },
      similarity,
      limit: limit * 2  // 获取更多结果用于后续过滤
    })

    return this.formatResults(results.hits, options)
  }

  /**
   * 全文搜索
   */
  async searchByText(
    query: string, 
    options: Partial<SearchOptions> = {}
  ): Promise<SearchResult[]> {
    if (!this.db) {
      throw new Error('数据库未初始化')
    }

    const { search } = await loadOrama()
    const limit = options.limit || 10

    const results = await search(this.db, {
      term: query,
      properties: ['content', 'filename'],
      limit: limit * 2
    })

    return this.formatResults(results.hits, options)
  }

  /**
   * 混合搜索（向量 + 全文）
   */
  async hybridSearch(
    query: string,
    embedding: number[],
    options: Partial<SearchOptions> = {}
  ): Promise<SearchResult[]> {
    if (!this.db) {
      throw new Error('数据库未初始化')
    }

    console.log(`[VectorStorage] hybridSearch: query="${query}", cache size=${this.recordsCache.size}`)

    const { search } = await loadOrama()
    const limit = options.limit || 10
    const similarity = options.similarity || 0.5  // 降低相似度阈值
    
    // 向量搜索（语义搜索，不受分词影响）
    let results: any = { hits: [] }
    
    try {
      // 尝试多个相似度阈值
      for (const sim of [0.3, 0.2, 0.1, 0]) {
        results = await search(this.db, {
          mode: 'vector',
          vector: {
            value: embedding,
            property: 'embedding'
          },
          similarity: sim,
          limit: limit * 2
        })
        console.log(`[VectorStorage] vector search (sim=${sim}): ${results.hits?.length || 0} hits`)
        if (results.hits.length > 0) break
      }
    } catch (e) {
      console.error('[VectorStorage] Vector search error:', e)
    }
    
    console.log(`[VectorStorage] final results: ${results.hits?.length || 0} hits`)

    return this.formatResults(results.hits, options)
  }

  /**
   * 格式化搜索结果
   */
  private formatResults(
    hits: any[], 
    options: Partial<SearchOptions>
  ): SearchResult[] {
    let results: SearchResult[] = hits.map(hit => ({
      id: hit.id,
      docId: hit.document.docId,
      content: hit.document.content,
      score: hit.score,
      metadata: {
        filename: hit.document.filename,
        hostId: hit.document.hostId,
        tags: hit.document.tags || [],
        startOffset: 0,
        endOffset: hit.document.content.length
      },
      source: 'local' as const
    }))

    // 按主机过滤
    if (options.hostId) {
      results = results.filter(r => r.metadata.hostId === options.hostId)
    }

    // 按标签过滤
    if (options.tags && options.tags.length > 0) {
      results = results.filter(r => 
        options.tags!.some(tag => r.metadata.tags.includes(tag))
      )
    }

    // 限制结果数量
    const limit = options.limit || 10
    return results.slice(0, limit)
  }

  /**
   * 获取统计信息
   */
  async getStats(): Promise<KnowledgeStats> {
    if (!this.db) {
      return {
        documentCount: 0,
        chunkCount: 0,
        totalSize: 0
      }
    }

    // 从缓存获取统计信息
    const chunkCount = this.recordsCache.size
    const uniqueDocIds = new Set<string>()
    
    Array.from(this.recordsCache.values()).forEach(record => {
      uniqueDocIds.add(record.docId)
    })

    return {
      documentCount: uniqueDocIds.size,
      chunkCount,
      totalSize: 0,  // TODO: 计算实际大小
      lastUpdated: Date.now()
    }
  }

  /**
   * 清空所有数据
   */
  async clear(): Promise<void> {
    const { create } = await loadOrama()
    
    // 清空缓存
    this.recordsCache.clear()
    
    // 重新创建空数据库
    const dimensions = 384  // 使用默认维度
    this.db = await create({
      schema: {
        id: 'string',
        docId: 'string',
        content: 'string',
        embedding: `vector[${dimensions}]`,
        filename: 'string',
        hostId: 'string',
        tags: 'string[]',
        chunkIndex: 'number',
        createdAt: 'number'
      }
    })

    // 清除磁盘数据
    const dataPath = path.join(this.storagePath, 'vectors.json')
    if (fs.existsSync(dataPath)) {
      fs.unlinkSync(dataPath)
    }

    this.emit('cleared')
  }

  /**
   * 检查是否已初始化
   */
  isReady(): boolean {
    return this.isInitialized && this.db !== null
  }

  /**
   * 获取存储路径
   */
  getStoragePath(): string {
    return this.storagePath
  }
}

// 导出单例
let vectorStorage: VectorStorage | null = null

export function getVectorStorage(): VectorStorage {
  if (!vectorStorage) {
    vectorStorage = new VectorStorage()
  }
  return vectorStorage
}

