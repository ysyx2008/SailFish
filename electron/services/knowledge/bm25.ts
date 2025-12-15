/**
 * BM25 全文搜索索引
 * 使用 jieba-wasm 进行中文分词，自实现 BM25 算法
 */
import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import { EventEmitter } from 'events'

// 动态导入 jieba-wasm
let jiebaModule: any = null

async function loadJieba() {
  if (!jiebaModule) {
    jiebaModule = await import('jieba-wasm')
    // Node.js 版本的 jieba-wasm 在模块加载时自动初始化 WASM，无需手动调用
  }
  return jiebaModule
}

/** BM25 文档记录 */
export interface BM25Document {
  id: string           // chunk ID
  docId: string        // 文档 ID
  content: string      // 原始内容
  tokens: string[]     // 分词结果
  filename: string
  hostId: string
  tags: string
}

/** BM25 搜索结果 */
export interface BM25SearchResult {
  id: string
  docId: string
  content: string
  score: number
  filename: string
  hostId: string
  tags: string
}

/** BM25 索引统计 */
interface IndexStats {
  totalDocuments: number
  avgDocLength: number
  vocabulary: Set<string>
}

/**
 * BM25 索引服务
 */
export class BM25Index extends EventEmitter {
  // BM25 参数
  private k1: number = 1.2      // 词频饱和参数
  private b: number = 0.75      // 文档长度归一化参数

  // 索引数据结构
  private documents: Map<string, BM25Document> = new Map()           // id -> document
  private invertedIndex: Map<string, Map<string, number>> = new Map() // term -> {docId -> tf}
  private docLengths: Map<string, number> = new Map()                // id -> doc length
  private avgDocLength: number = 0
  private totalDocuments: number = 0

  // 持久化路径
  private indexPath: string
  private isInitialized: boolean = false

  constructor() {
    super()
    this.indexPath = path.join(app.getPath('userData'), 'knowledge', 'bm25-index.json')
  }

  /**
   * 初始化索引
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return

    try {
      // 确保 jieba 已加载
      await loadJieba()

      // 尝试加载已有索引
      await this.loadIndex()

      this.isInitialized = true
    } catch (error) {
      console.error('[BM25] Initialization failed:', error)
      throw error
    }
  }

  /**
   * 中文分词
   */
  async tokenize(text: string): Promise<string[]> {
    const jieba = await loadJieba()
    
    // 使用精确模式分词
    const tokens: string[] = jieba.cut(text, false)
    
    // 过滤停用词和标点
    return tokens.filter(token => {
      const trimmed = token.trim()
      // 过滤空白、单字符标点、纯数字
      if (!trimmed || trimmed.length === 0) return false
      if (/^[，。！？、；：""''（）【】《》\s\.,!?;:'"()\[\]{}<>]+$/.test(trimmed)) return false
      if (/^\d+$/.test(trimmed) && trimmed.length < 2) return false
      return true
    }).map(t => t.toLowerCase())
  }

  /**
   * 添加文档到索引
   */
  async addDocument(doc: Omit<BM25Document, 'tokens'>): Promise<void> {
    if (!this.isInitialized) {
      await this.initialize()
    }

    // 分词
    const tokens = await this.tokenize(doc.content)
    
    const fullDoc: BM25Document = {
      ...doc,
      tokens
    }

    // 如果已存在，先删除旧的
    if (this.documents.has(doc.id)) {
      await this.removeDocument(doc.id)
    }

    // 保存文档
    this.documents.set(doc.id, fullDoc)
    this.docLengths.set(doc.id, tokens.length)

    // 更新倒排索引
    const termFreq = new Map<string, number>()
    for (const token of tokens) {
      termFreq.set(token, (termFreq.get(token) || 0) + 1)
    }

    const termFreqEntries = Array.from(termFreq.entries())
    for (const [term, freq] of termFreqEntries) {
      if (!this.invertedIndex.has(term)) {
        this.invertedIndex.set(term, new Map())
      }
      this.invertedIndex.get(term)!.set(doc.id, freq)
    }

    // 更新统计
    this.totalDocuments++
    this.updateAvgDocLength()
  }

  /**
   * 批量添加文档
   */
  async addDocuments(docs: Omit<BM25Document, 'tokens'>[]): Promise<void> {
    for (const doc of docs) {
      await this.addDocument(doc)
    }
    // 保存索引
    await this.saveIndex()
  }

  /**
   * 删除文档
   */
  async removeDocument(id: string): Promise<boolean> {
    const doc = this.documents.get(id)
    if (!doc) return false

    // 从倒排索引中移除
    const uniqueTokens = Array.from(new Set(doc.tokens))
    for (const token of uniqueTokens) {
      const postings = this.invertedIndex.get(token)
      if (postings) {
        postings.delete(id)
        if (postings.size === 0) {
          this.invertedIndex.delete(token)
        }
      }
    }

    // 删除文档记录
    this.documents.delete(id)
    this.docLengths.delete(id)

    // 更新统计
    this.totalDocuments--
    this.updateAvgDocLength()

    return true
  }

  /**
   * 删除文档的所有分块
   */
  async removeDocumentChunks(docId: string): Promise<number> {
    const idsToRemove: string[] = []
    
    const docEntries = Array.from(this.documents.entries())
    for (const [id, doc] of docEntries) {
      if (doc.docId === docId) {
        idsToRemove.push(id)
      }
    }

    for (const id of idsToRemove) {
      await this.removeDocument(id)
    }

    if (idsToRemove.length > 0) {
      await this.saveIndex()
    }

    return idsToRemove.length
  }

  /**
   * 计算 IDF (Inverse Document Frequency)
   */
  private computeIDF(term: string): number {
    const docFreq = this.invertedIndex.get(term)?.size || 0
    if (docFreq === 0) return 0
    
    // IDF = log((N - df + 0.5) / (df + 0.5))
    return Math.log((this.totalDocuments - docFreq + 0.5) / (docFreq + 0.5) + 1)
  }

  /**
   * BM25 搜索
   */
  async search(query: string, limit: number = 10, options?: { hostId?: string; tags?: string[] }): Promise<BM25SearchResult[]> {
    if (!this.isInitialized) {
      await this.initialize()
    }

    if (this.documents.size === 0) {
      return []
    }

    // 查询分词
    const queryTokens = await this.tokenize(query)
    if (queryTokens.length === 0) {
      return []
    }

    // 计算每个文档的 BM25 分数
    const scores = new Map<string, number>()

    for (const term of queryTokens) {
      const idf = this.computeIDF(term)
      const postings = this.invertedIndex.get(term)
      
      if (!postings) continue

      const postingsEntries = Array.from(postings.entries())
      for (const [docId, tf] of postingsEntries) {
        const docLength = this.docLengths.get(docId) || 0
        
        // BM25 公式
        // score = IDF * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * dl / avgdl))
        const numerator = tf * (this.k1 + 1)
        const denominator = tf + this.k1 * (1 - this.b + this.b * docLength / this.avgDocLength)
        const score = idf * numerator / denominator

        scores.set(docId, (scores.get(docId) || 0) + score)
      }
    }

    // 排序并返回结果
    let results = Array.from(scores.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([id, score]) => {
        const doc = this.documents.get(id)!
        return {
          id: doc.id,
          docId: doc.docId,
          content: doc.content,
          score,
          filename: doc.filename,
          hostId: doc.hostId,
          tags: doc.tags
        }
      })

    // 按主机过滤
    if (options?.hostId && options.hostId.trim()) {
      results = results.filter(r => !r.hostId || r.hostId === options.hostId)
    }

    // 按标签过滤
    if (options?.tags && options.tags.length > 0) {
      results = results.filter(r => {
        const docTags = r.tags ? r.tags.split(',').filter(t => t) : []
        return options.tags!.some(tag => docTags.includes(tag))
      })
    }

    return results.slice(0, limit)
  }

  /**
   * 更新平均文档长度
   */
  private updateAvgDocLength(): void {
    if (this.totalDocuments === 0) {
      this.avgDocLength = 0
      return
    }

    let totalLength = 0
    const lengths = Array.from(this.docLengths.values())
    for (const length of lengths) {
      totalLength += length
    }
    this.avgDocLength = totalLength / this.totalDocuments
  }

  /**
   * 保存索引到磁盘
   */
  async saveIndex(): Promise<void> {
    try {
      const dir = path.dirname(this.indexPath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }

      const data = {
        version: 1,
        k1: this.k1,
        b: this.b,
        avgDocLength: this.avgDocLength,
        totalDocuments: this.totalDocuments,
        documents: Array.from(this.documents.entries()),
        docLengths: Array.from(this.docLengths.entries()),
        invertedIndex: Array.from(this.invertedIndex.entries()).map(([term, postings]) => [
          term,
          Array.from(postings.entries())
        ])
      }

      fs.writeFileSync(this.indexPath, JSON.stringify(data), 'utf-8')
    } catch (error) {
      console.error('[BM25] Failed to save index:', error)
    }
  }

  /**
   * 从磁盘加载索引
   */
  private async loadIndex(): Promise<void> {
    try {
      if (!fs.existsSync(this.indexPath)) {
        return
      }

      const data = JSON.parse(fs.readFileSync(this.indexPath, 'utf-8'))
      
      if (data.version !== 1) {
        console.warn('[BM25] Index version mismatch, starting fresh')
        return
      }

      this.k1 = data.k1 || 1.2
      this.b = data.b || 0.75
      this.avgDocLength = data.avgDocLength || 0
      this.totalDocuments = data.totalDocuments || 0

      this.documents = new Map(data.documents || [])
      this.docLengths = new Map(data.docLengths || [])
      
      this.invertedIndex = new Map()
      for (const [term, postings] of (data.invertedIndex || [])) {
        this.invertedIndex.set(term, new Map(postings))
      }
    } catch (error) {
      console.error('[BM25] Failed to load index:', error)
      // 清空重建
      this.documents.clear()
      this.invertedIndex.clear()
      this.docLengths.clear()
      this.avgDocLength = 0
      this.totalDocuments = 0
    }
  }

  /**
   * 清空索引
   */
  async clear(): Promise<void> {
    this.documents.clear()
    this.invertedIndex.clear()
    this.docLengths.clear()
    this.avgDocLength = 0
    this.totalDocuments = 0

    // 删除索引文件
    if (fs.existsSync(this.indexPath)) {
      fs.unlinkSync(this.indexPath)
    }
  }

  /**
   * 获取统计信息
   */
  getStats(): { documentCount: number; vocabularySize: number; avgDocLength: number } {
    return {
      documentCount: this.documents.size,
      vocabularySize: this.invertedIndex.size,
      avgDocLength: this.avgDocLength
    }
  }

  /**
   * 检查是否就绪
   */
  isReady(): boolean {
    return this.isInitialized
  }
}

// 导出单例
let bm25Index: BM25Index | null = null

export function getBM25Index(): BM25Index {
  if (!bm25Index) {
    bm25Index = new BM25Index()
  }
  return bm25Index
}

