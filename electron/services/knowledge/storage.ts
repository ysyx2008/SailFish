/**
 * LanceDB 向量存储服务
 * 提供向量存储和语义搜索功能
 * 支持 BM25 + 向量混合搜索 (RRF 融合)
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

// LanceDB 记录类型
export interface VectorRecord {
  id: string
  docId: string
  content: string
  vector: number[]
  filename: string
  hostId: string
  tags: string  // 改为字符串，用逗号分隔（LanceDB 对空数组类型推断有问题）
  chunkIndex: number
  createdAt: number
}

// 兼容旧接口
export type OramaRecord = VectorRecord

// 动态导入 LanceDB
let lancedb: any = null

async function loadLanceDB() {
  if (!lancedb) {
    lancedb = await import('@lancedb/lancedb')
  }
  return lancedb
}

export class VectorStorage extends EventEmitter {
  private db: any = null
  private table: any = null
  private storagePath: string
  private tableName = 'knowledge_vectors'
  private isInitialized: boolean = false
  private dimensions: number = 384

  constructor() {
    super()
    this.storagePath = path.join(app.getPath('userData'), 'knowledge', 'lancedb')
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

    this.dimensions = dimensions
    
    try {
      const { connect } = await loadLanceDB()
      
      this.db = await connect(this.storagePath)
      
      // 检查表是否存在
      const tableNames = await this.db.tableNames()
      
      if (tableNames.includes(this.tableName)) {
        this.table = await this.db.openTable(this.tableName)
      } else {
        // 创建空表（LanceDB 需要至少一条数据来推断 schema）
        // 我们在第一次添加记录时创建表
        this.table = null
      }

      this.isInitialized = true
      this.emit('initialized')
    } catch (error) {
      console.error('[VectorStorage] Initialization failed:', error)
      throw error
    }
  }

  /**
   * 确保表存在
   */
  private async ensureTable(sampleRecord?: VectorRecord): Promise<void> {
    if (this.table) return
    
    if (!sampleRecord) {
      // 创建一个临时记录来初始化表结构
      sampleRecord = {
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
      
      this.table = await this.db.createTable(this.tableName, [sampleRecord])
      await this.table.delete('id = "__init__"')
    } else {
      this.table = await this.db.createTable(this.tableName, [sampleRecord])
    }
  }

  /**
   * 添加记录
   */
  async addRecord(record: VectorRecord): Promise<string> {
    if (!this.db) {
      throw new Error('数据库未初始化')
    }

    await this.ensureTable(record)
    await this.table.add([record])
    
    this.emit('recordAdded', record.id)
    return record.id
  }

  /**
   * 批量添加记录
   */
  async addRecords(records: VectorRecord[]): Promise<string[]> {
    if (!this.db) {
      throw new Error('数据库未初始化')
    }

    if (records.length === 0) return []

    await this.ensureTable(records[0])
    await this.table.add(records)
    
    const ids = records.map(r => r.id)
    this.emit('recordsAdded', ids)
    return ids
  }

  /**
   * 删除记录
   */
  async removeRecord(id: string): Promise<boolean> {
    if (!this.table) return false

    try {
      await this.table.delete(`id = "${id}"`)
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
    if (!this.table) return 0

    try {
      const beforeCount = await this.table.countRows()
      await this.table.delete(`docId = "${docId}"`)
      const afterCount = await this.table.countRows()
      const removed = beforeCount - afterCount
      
      if (removed > 0) {
        this.emit('documentRemoved', { docId, chunksRemoved: removed })
      }
      
      return removed
    } catch (error) {
      console.error('[VectorStorage] Failed to remove chunks:', error)
      return 0
    }
  }

  /**
   * 获取文档的所有记录
   */
  async getRecordsByDocId(docId: string): Promise<VectorRecord[]> {
    if (!this.table) return []

    try {
      // LanceDB 查询：使用 where 子句过滤
      const allRows = await this.table.toArray()
      const filtered = (allRows as VectorRecord[]).filter(r => r.docId === docId)
      return filtered
    } catch (error) {
      console.error('[VectorStorage] Failed to get records by docId:', error)
      return []
    }
  }

  /**
   * 删除文档的所有记录（别名，与 removeDocumentChunks 相同）
   */
  async removeRecordsByDocId(docId: string): Promise<number> {
    return this.removeDocumentChunks(docId)
  }

  /**
   * 向量搜索
   */
  async searchByVector(
    embedding: number[], 
    options: Partial<SearchOptions> = {}
  ): Promise<SearchResult[]> {
    if (!this.table) {
      return []
    }

    const limit = options.limit || 10

    try {
      const results = await this.table
        .vectorSearch(embedding)
        .limit(limit * 2)
        .toArray()

      return this.formatResults(results, options)
    } catch (error) {
      console.error('[VectorStorage] Vector search failed:', error)
      return []
    }
  }

  /**
   * 全文搜索（基于向量相似度）
   * LanceDB 原生支持中文，无需分词
   */
  async searchByText(
    query: string, 
    options: Partial<SearchOptions> = {}
  ): Promise<SearchResult[]> {
    // LanceDB 没有内置全文搜索，使用向量搜索
    // 调用方需要先将 query 转为 embedding
    console.warn('[VectorStorage] searchByText requires embedding, use hybridSearch instead')
    return []
  }

  /**
   * 混合搜索（BM25 + 向量搜索 + RRF 融合）
   */
  async hybridSearch(
    query: string,
    embedding: number[],
    options: Partial<SearchOptions> = {}
  ): Promise<SearchResult[]> {
    const limit = options.limit || 10
    const k = 60  // RRF 参数，经验最优值

    try {
      // 1. 向量搜索
      let vectorResults: SearchResult[] = []
      if (this.table) {
        const vectorHits = await this.table
          .vectorSearch(embedding)
          .limit(limit * 2)  // 多取一些用于融合
          .toArray()
        vectorResults = this.formatResults(vectorHits, options)
      }

      // 2. BM25 搜索
      const bm25Index = getBM25Index()
      let bm25Results: BM25SearchResult[] = []
      if (bm25Index.isReady()) {
        bm25Results = await bm25Index.search(query, limit * 2, {
          hostId: options.hostId,
          tags: options.tags
        })
      }

      // 3. RRF 融合
      const fusedResults = this.rrfFusion(vectorResults, bm25Results, k)

      // 4. 返回前 limit 个结果
      return fusedResults.slice(0, limit)
    } catch (error) {
      console.error('[VectorStorage] Hybrid search failed:', error)
      return []
    }
  }

  /**
   * Reciprocal Rank Fusion (RRF) 融合算法
   * 合并向量搜索和 BM25 搜索结果
   */
  private rrfFusion(
    vectorResults: SearchResult[],
    bm25Results: BM25SearchResult[],
    k: number = 60
  ): SearchResult[] {
    // 分数映射: id -> { score, result }
    const scoreMap = new Map<string, { score: number; result: SearchResult }>()

    // 向量搜索结果贡献分数
    vectorResults.forEach((result, rank) => {
      const rrfScore = 1 / (k + rank + 1)
      scoreMap.set(result.id, {
        score: rrfScore,
        result
      })
    })

    // BM25 结果贡献分数
    bm25Results.forEach((bm25Result, rank) => {
      const rrfScore = 1 / (k + rank + 1)
      
      if (scoreMap.has(bm25Result.id)) {
        // 已存在，累加分数
        const existing = scoreMap.get(bm25Result.id)!
        existing.score += rrfScore
      } else {
        // 新结果，转换为 SearchResult 格式
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

    // 按融合分数排序
    const results = Array.from(scoreMap.values())
      .sort((a, b) => b.score - a.score)
      .map(({ score, result }) => ({
        ...result,
        score  // 使用 RRF 融合分数
      }))

    return results
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

    // 按主机过滤（空 hostId 的记录对所有主机可见）
    if (options.hostId && options.hostId.trim()) {
      results = results.filter(r => !r.metadata.hostId || r.metadata.hostId === options.hostId)
    }

    // 按标签过滤
    if (options.tags && options.tags.length > 0) {
      results = results.filter(r => 
        options.tags!.some(tag => r.metadata.tags.includes(tag))
      )
    }

    const limit = options.limit || 10
    return results.slice(0, limit)
  }

  /**
   * 获取统计信息
   */
  async getStats(): Promise<KnowledgeStats> {
    if (!this.table) {
      return {
        documentCount: 0,
        chunkCount: 0,
        totalSize: 0
      }
    }

    try {
      const chunkCount = await this.table.countRows()
      
      // 获取唯一文档数
      const allRows = await this.table.toArray()
      const uniqueDocIds = new Set(allRows.map((r: any) => r.docId))

      return {
        documentCount: uniqueDocIds.size,
        chunkCount,
        totalSize: 0,
        lastUpdated: Date.now()
      }
    } catch {
      return {
        documentCount: 0,
        chunkCount: 0,
        totalSize: 0
      }
    }
  }

  /**
   * 清空所有数据
   */
  async clear(): Promise<void> {
    if (this.table) {
      await this.db.dropTable(this.tableName)
      this.table = null
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
