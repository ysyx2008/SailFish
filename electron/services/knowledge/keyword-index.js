/* eslint-env node */
/**
 * 关键词（按字面找）索引：切词 + LanceDB 原生全文索引
 *
 * 同一张向量表里多一列 `tokens`（结巴切好、空格分隔），在它上面建 LanceDB 全文索引
 * （whitespace 分词）。打分、增删都跟着向量那一行走，不再另存一整本词索引。
 *
 * 纯 JS（CJS），两处共用：lancedb-worker.js（桌面端）和 storage.ts 的进程内模式（CLI）。
 * 切词只在这里写一份——写入和查询必须用同一个函数，否则搜不到。
 *
 * 切词规则沿用旧 BM25 实现：结巴精确模式；丢掉空白与标点；丢掉单个数字；转小写。
 */
'use strict'

const TOKEN_COLUMN = 'tokens'
const INDEX_NAME = 'tokens_idx'

/** 回填时一批处理多少行 */
const BACKFILL_BATCH = 2000
/** 带筛选条件的检索，最多取回多少行再筛 */
const MAX_FILTERED_FETCH = 100000
/** 已建好的索引没覆盖到的行数超过这个数，并入一次 */
const UNINDEXED_OPTIMIZE_THRESHOLD = 5000

/** 全是标点 / 空白的词 */
const PUNCTUATION_ONLY = /^[，。！？、；：""''（）【】《》\s.,!?;:'"()[\]{}<>]+$/

/** SQL 字符串字面量 */
function sqlString(value) {
  return "'" + String(value).replace(/'/g, "''") + "'"
}

class KeywordIndex {
  /**
   * @param {{ lancedb: any, log?: { info: Function, warn: Function } }} options
   *   lancedb：已加载的 @lancedb/lancedb 模块（建索引要用它的 Index）
   */
  constructor(options) {
    this.lancedb = options.lancedb
    this.log = options.log || console
    this.jieba = null
    /** 已确认建有全文索引的表名；表被整个丢掉重建时要 reset */
    this.confirmedTables = new Set()
  }

  /** 表被整个丢掉时调用 */
  reset() {
    this.confirmedTables.clear()
  }

  // ────────────────────────── 切词 ──────────────────────────

  loadJieba() {
    if (!this.jieba) {
      // Node 版 jieba-wasm 在 require 时同步初始化 WASM
      this.jieba = require('jieba-wasm')
    }
    return this.jieba
  }

  /** @returns {string[]} */
  tokenize(text) {
    if (!text) return []
    const jieba = this.loadJieba()
    const out = []
    for (const raw of jieba.cut(String(text), false)) {
      const token = raw.trim()
      if (!token) continue
      if (PUNCTUATION_ONLY.test(token)) continue
      if (/^\d+$/.test(token) && token.length < 2) continue
      out.push(token.toLowerCase())
    }
    return out
  }

  /** 写进 tokens 列的形态：空格分隔 */
  tokensText(text) {
    return this.tokenize(text).join(' ')
  }

  /** 给待写入的行补上 tokens 列（已带 tokens 的不重算） */
  withTokens(records) {
    return records.map(record => (
      typeof record.tokens === 'string'
        ? record
        : { ...record, [TOKEN_COLUMN]: this.tokensText(record.content) }
    ))
  }

  // ────────────────────────── 升级与索引 ──────────────────────────

  /**
   * 让一张已有的表具备关键词检索：补列、把还没切词的行补上、建全文索引。
   * 可以随时重跑：补列和建索引都是「有了就跳过」，回填只处理 tokens 还是空的行，
   * 所以中途退出后下次接着做；旧版换回期间新写的行（没有 tokens）也会在这里补上。
   *
   * @returns {Promise<{ addedColumn: boolean, backfilled: number, indexed: boolean }>}
   */
  async prepare(table) {
    const schema = await table.schema()
    const hasColumn = schema.fields.some(field => field.name === TOKEN_COLUMN)
    if (!hasColumn) {
      await table.addColumns([{ name: TOKEN_COLUMN, valueSql: 'cast(NULL as string)' }])
    }

    const backfilled = await this.backfill(table)
    const indexed = await this.ensureIndex(table)
    return { addedColumn: !hasColumn, backfilled, indexed }
  }

  /** 表里出现不止一次的 id（数据里偶有，成因不明）。只在有行等着补词时才扫 */
  async findDuplicateIds(table) {
    const counts = new Map()
    const rows = await table.query().select(['id']).toArray()
    for (const row of rows) counts.set(row.id, (counts.get(row.id) || 0) + 1)
    const duplicates = new Set()
    for (const [id, count] of counts) if (count > 1) duplicates.add(id)
    return duplicates
  }

  /** @returns {Promise<number>} 补了多少行 */
  async backfill(table) {
    if ((await table.countRows(TOKEN_COLUMN + ' IS NULL')) === 0) return 0

    // 合并更新按 id 定位，同 id 的每一行都会被写成同一份词；同 id 而正文不同的行
    // 要按「id + 正文」逐个更新，不然一行的词会落到另一行上
    const duplicateIds = await this.findDuplicateIds(table)

    let total = 0
    let lastFirstId = null
    for (;;) {
      const rows = await table
        .query()
        .where(TOKEN_COLUMN + ' IS NULL')
        .select(['id', 'content'])
        .limit(BACKFILL_BATCH)
        .toArray()
      if (rows.length === 0) break
      // 更新没有生效（同一行又被取出来）就别原地打转
      if (rows[0].id === lastFirstId) {
        throw new Error('关键词索引回填没有生效：同一批行反复出现')
      }
      lastFirstId = rows[0].id

      const seen = new Set()
      const merged = []
      const individually = []
      for (const row of rows) {
        const content = row.content || ''
        if (duplicateIds.has(row.id)) {
          const key = row.id + '\u0000' + content
          if (seen.has(key)) continue
          seen.add(key)
          individually.push({ id: row.id, content })
        } else {
          if (seen.has(row.id)) continue
          seen.add(row.id)
          merged.push({ id: row.id, [TOKEN_COLUMN]: this.tokensText(content) })
        }
      }
      if (merged.length > 0) await table.mergeInsert('id').whenMatchedUpdateAll().execute(merged)
      for (const { id, content } of individually) {
        await table.update({
          where: 'id = ' + sqlString(id) + ' AND content = ' + sqlString(content),
          values: { [TOKEN_COLUMN]: this.tokensText(content) },
        })
      }
      total += rows.length

      // 让出事件循环，worker 内其它消息是串行排队的，这里不阻塞别的进程
      await new Promise(resolve => setImmediate(resolve))
    }
    if (total > 0) this.log.info('[KeywordIndex] 已为 %d 行补上切词', total)
    return total
  }

  /** 表里有数据且还没有全文索引时建一个。@returns 是否已有索引 */
  async ensureIndex(table) {
    if (this.confirmedTables.has(table.name)) return true
    const indices = await table.listIndices()
    if (indices.some(index => index.name === INDEX_NAME)) {
      this.confirmedTables.add(table.name)
      return true
    }
    if ((await table.countRows()) === 0) return false
    const { Index } = this.lancedb
    await table.createIndex(TOKEN_COLUMN, {
      config: Index.fts({
        baseTokenizer: 'whitespace',
        lowercase: true,
        stem: false,
        removeStopWords: false,
        asciiFolding: false,
        withPosition: false,
        maxTokenLength: 1000,
      }),
    })
    this.confirmedTables.add(table.name)
    this.log.info('[KeywordIndex] 全文索引已建好')
    return true
  }

  /** 索引还没覆盖到的行是否多到该并入一次了（并入由调用方的 compact 做） */
  async needsOptimize(table) {
    if (!this.confirmedTables.has(table.name)) return false
    try {
      const stats = await table.indexStats(INDEX_NAME)
      return !!stats && stats.numUnindexedRows >= UNINDEXED_OPTIMIZE_THRESHOLD
    } catch {
      return false
    }
  }

  // ────────────────────────── 检索 ──────────────────────────

  /**
   * 按字面检索，返回按相关度从高到低的片段。
   * hostId：只要通用的（hostId 为空）和这台主机的；tags：命中任意一个即可。
   *
   * 筛选在取回之后做，不交给数据库做前置过滤：试验里 LanceDB 的全文检索带过滤条件时，
   * 查询词里只要有一个词在被滤掉的行里，结果会整个变空（如「nginx 删除」按某一文档筛）。
   * 取回的不够就加大取回量重来，直到够数或已取尽，所以结果和先筛后排一样。
   *
   * @returns {Promise<Array<{id,docId,content,score,filename,hostId,tags}>>}
   */
  async search(table, { query, limit, hostId, tags }) {
    const terms = this.tokenize(query)
    if (terms.length === 0) return []
    if (!(await this.ensureIndex(table))) return []

    const want = limit || 10
    const host = hostId && String(hostId).trim() ? String(hostId) : ''
    const wantedTags = (tags || []).filter(tag => tag)
    const filtered = !!host || wantedTags.length > 0
    const passes = row => {
      if (host && row.hostId && row.hostId !== host) return false
      if (wantedTags.length > 0) {
        const own = row.tags ? row.tags.split(',').filter(tag => tag) : []
        if (!wantedTags.some(tag => own.includes(tag))) return false
      }
      return true
    }

    const queryText = terms.join(' ')
    let fetch = filtered ? Math.max(want * 4, 100) : want
    for (;;) {
      const rows = await table
        .search(queryText, 'fts', TOKEN_COLUMN)
        .select(['id', 'docId', 'content', 'filename', 'hostId', 'tags', '_score'])
        .limit(fetch)
        .toArray()
      const kept = filtered ? rows.filter(passes) : rows
      const exhausted = rows.length < fetch
      if (kept.length >= want || exhausted || fetch >= MAX_FILTERED_FETCH) {
        return kept.slice(0, want).map(row => ({
          id: row.id,
          docId: row.docId,
          content: row.content,
          score: row._score,
          filename: row.filename,
          hostId: row.hostId || '',
          tags: row.tags || '',
        }))
      }
      fetch *= 4
    }
  }
}

module.exports = { KeywordIndex, TOKEN_COLUMN, INDEX_NAME }
