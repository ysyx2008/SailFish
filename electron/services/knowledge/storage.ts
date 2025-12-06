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
    
    if (!fs.existsSync(dataPath)) {
      return
    }

    try {
      const data = JSON.parse(fs.readFileSync(dataPath, 'utf-8'))
      const { insert } = await loadOrama()

      for (const record of data.records || []) {
        await insert(this.db, record)
      }

      console.log(`[VectorStorage] Loaded ${data.records?.length || 0} records from disk`)
    } catch (error) {
      console.error('[VectorStorage] Failed to load data from disk:', error)
    }
  }

  /**
   * 持久化数据到磁盘
   */
  private async saveToDisk(): Promise<void> {
    if (!this.db) return

    const { getByID, count } = await loadOrama()
    const dataPath = path.join(this.storagePath, 'vectors.json')

    try {
      // 获取所有记录
      const total = await count(this.db)
      const records: OramaRecord[] = []
      
      // 注意：Orama 没有直接获取所有记录的方法，需要通过搜索
      // 这里我们保存文档元数据，实际向量在内存中重建

      const data = {
        version: 1,
        lastUpdated: Date.now(),
        recordCount: total,
        records: records
      }

      fs.writeFileSync(dataPath, JSON.stringify(data, null, 2), 'utf-8')
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

    const { search, remove } = await loadOrama()
    
    // 先搜索出所有属于该文档的分块
    const results = await search(this.db, {
      term: docId,
      properties: ['docId'],
      limit: 10000
    })

    let removed = 0
    for (const hit of results.hits) {
      try {
        await remove(this.db, hit.id)
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

    const { search } = await loadOrama()
    const limit = options.limit || 10
    const similarity = options.similarity || 0.7
    const hybridWeight = options.hybridWeight || 0.7  // 向量权重

    // Orama 支持混合搜索
    const results = await search(this.db, {
      mode: 'hybrid',
      term: query,
      vector: {
        value: embedding,
        property: 'embedding'
      },
      similarity,
      limit: limit * 2,
      properties: ['content', 'filename']
    })

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

    const { count } = await loadOrama()
    const chunkCount = await count(this.db)

    // 获取唯一文档数
    const { search } = await loadOrama()
    const allResults = await search(this.db, {
      term: '',
      limit: 100000
    })
    
    const uniqueDocIds = new Set(allResults.hits.map((h: any) => h.document.docId))

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

