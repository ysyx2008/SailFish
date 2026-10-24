/**
 * BM25 全文搜索索引
 * 使用 jieba-wasm 进行中文分词，自实现 BM25 算法
 */
import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import { EventEmitter } from 'events'
import { createLogger } from '../../utils/logger'

const log = createLogger('BM25')

// 动态导入 jieba-wasm
let jiebaModule: any = null

// 模块加载时立即在后台触发 WASM 预热，使 BM25 首次 search 时 jieba 已就绪
// fire-and-forget，不阻塞模块初始化，不影响主线程
let jiebaPreloadPromise: Promise<any> | null = null
if (typeof setImmediate !== 'undefined') {
  setImmediate(() => {
    jiebaPreloadPromise = import('jieba-wasm').then(m => {
      jiebaModule = m
      return m
    }).catch(() => { /* 预加载失败无妨，loadJieba() 会重试 */ })
  })
}

async function loadJieba() {
  if (!jiebaModule) {
    if (jiebaPreloadPromise) {
      jiebaModule = await jiebaPreloadPromise
    } else {
      jiebaModule = await import('jieba-wasm')
      // Node.js 版本的 jieba-wasm 在模块加载时自动初始化 WASM，无需手动调用
    }
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
interface _IndexStats {
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

  constructor(indexPath?: string) {
    super()
    this.indexPath = indexPath ?? path.join(app.getPath('userData'), 'knowledge', 'bm25-index.json')
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
      log.error('Initialization failed:', error)
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
      if (/^[，。！？、；：""''（）【】《》\s.,!?;:'"()[\]{}<>]+$/.test(trimmed)) return false
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
   * @param docs 待添加文档列表
   * @param options.skipSave 跳过 saveIndex 持久化（用于重建场景外层统一保存，
   *   避免每批都序列化整个索引导致 O(N²) 复杂度）
   */
  async addDocuments(
    docs: Omit<BM25Document, 'tokens'>[],
    options?: { skipSave?: boolean }
  ): Promise<void> {
    for (const doc of docs) {
      await this.addDocument(doc)
    }
    if (!options?.skipSave) {
      await this.saveIndex()
    }
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
   * 删除文档的所有分块。
   * skipSave：一次收掉多份时先只改内存，最后统一落盘，避免每份都重写整份索引。
   */
  async removeDocumentChunks(docId: string, options?: { skipSave?: boolean }): Promise<number> {
    return this.removeManyDocumentChunks([docId], options)
  }

  /** 一次收掉多份文档的分块，默认只落盘一次 */
  async removeManyDocumentChunks(docIds: readonly string[], options?: { skipSave?: boolean }): Promise<number> {
    if (docIds.length === 0) return 0
    if (!this.isInitialized) await this.initialize()

    const wanted = new Set(docIds)
    const idsToRemove: string[] = []
    for (const [id, doc] of this.documents) {
      if (wanted.has(doc.docId)) idsToRemove.push(id)
    }

    for (const id of idsToRemove) {
      await this.removeDocument(id)
    }

    if (idsToRemove.length > 0 && !options?.skipSave) {
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
   *
   * 原子写入（temp + rename）：BM25 索引规模可达数十 MB，直接 writeFileSync
   * 在写入中途若进程被 SIGKILL（崩溃 / 自动更新 / OS 收尸 worker 时连带主进程
   * 短暂阻塞）会留下截断的 JSON，下次启动 loadIndex 静默清空 → 触发整库重建，
   * 这是用户感知"经常升级知识库模型"的主要根因之一。
   */
  async saveIndex(): Promise<void> {
    const tempPath = this.indexPath + '.tmp'
    try {
      const dir = path.dirname(this.indexPath)
      await fs.promises.mkdir(dir, { recursive: true })

      const data = {
        version: 2,
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

      // 让出事件循环，避免 JSON.stringify 大索引时阻塞主线程太久
      await new Promise<void>(resolve => setImmediate(resolve))
      const json = JSON.stringify(data)
      await new Promise<void>(resolve => setImmediate(resolve))

      await fs.promises.writeFile(tempPath, json, 'utf-8')
      await fs.promises.rename(tempPath, this.indexPath)
    } catch (error) {
      log.error('Failed to save index:', error)
      try { await fs.promises.unlink(tempPath) } catch { /* ignore */ }
    }
  }

  /**
   * 将解析后的索引 JSON 载入内存
   */
  private applyIndexPayload(data: {
    k1?: number
    b?: number
    avgDocLength?: number
    totalDocuments?: number
    documents?: Array<[string, BM25Document]>
    docLengths?: Array<[string, number]>
    invertedIndex?: Array<[string, Array<[string, number]>]>
  }): void {
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
  }

  /**
   * 从磁盘加载索引
   */
  private async loadIndex(): Promise<void> {
    const tempPath = this.indexPath + '.tmp'

    // 原子写入在 rename 前被中断时，.tmp 往往比主文件更新——优先尝试恢复，勿直接删除
    if (await this.tryRecoverIndexFromTemp(tempPath)) {
      return
    }

    try {
      try {
        await fs.promises.access(this.indexPath)
      } catch {
        return
      }

      const raw = await fs.promises.readFile(this.indexPath, 'utf-8')
      const data = JSON.parse(raw)

      if (data.version !== 2) {
        log.warn('Index version mismatch (v%d → v2), rebuilding', data.version || 1)
        return
      }

      this.applyIndexPayload(data)
    } catch (error) {
      // 损坏的 BM25 索引（半截 JSON / schema 异常）会导致整库重建，
      // 这里 warn 而不是 error，但要明确写出原因供排查。
      log.warn('BM25 索引损坏或无法解析，将清空并触发重建:', error)
      this.documents.clear()
      this.invertedIndex.clear()
      this.docLengths.clear()
      this.avgDocLength = 0
      this.totalDocuments = 0
    }
  }

  /**
   * 从上次未完成的原子写入（.tmp）恢复 BM25 索引。
   * write 完成但 rename 前进程退出时，.tmp 是更新的那份数据。
   */
  private async tryRecoverIndexFromTemp(tempPath: string): Promise<boolean> {
    try {
      await fs.promises.access(tempPath)
    } catch {
      return false
    }

    try {
      const raw = await fs.promises.readFile(tempPath, 'utf-8')
      const data = JSON.parse(raw)
      if (data.version !== 2) {
        log.warn('BM25 临时索引版本不匹配 (v%s)，删除', data.version || 'unknown')
        await fs.promises.unlink(tempPath)
        return false
      }

      this.applyIndexPayload(data)
      await fs.promises.rename(tempPath, this.indexPath)
      log.warn(
        '已从 BM25 临时文件恢复索引（上次写入在 rename 前中断，文档数=%d）',
        this.documents.size
      )
      return true
    } catch (error) {
      log.warn('BM25 临时索引无效，删除:', error)
      try { await fs.promises.unlink(tempPath) } catch { /* ignore */ }
      return false
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

    try { await fs.promises.unlink(this.indexPath) } catch { /* ignore */ }
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
   * 返回当前已索引的文档 ID 集合（docId，非 chunk id）
   */
  getIndexedDocIds(): Set<string> {
    const docIds = new Set<string>()
    for (const doc of this.documents.values()) {
      docIds.add(doc.docId)
    }
    return docIds
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

