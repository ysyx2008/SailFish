/* eslint-env node */
/**
 * LanceDB Worker（utilityProcess）
 *
 * 把 @lancedb/lancedb（Rust 编译的原生 .node 模块）放到独立 utilityProcess，
 * 彻底避免 Windows 首次启动时 LoadLibrary 同步阻塞主线程（Windows Defender
 * 安全扫描 DLL 可能耗时 5~30 秒），防止 Setup Wizard 界面卡死。
 *
 * 通信协议（主进程 → worker）：
 *   ⇢ { id, type: 'initialize',           data: { storagePath, dimensions } }
 *   ⇢ { id, type: 'addRecord',            data: { record } }
 *   ⇢ { id, type: 'addRecords',           data: { records } }
 *   ⇢ { id, type: 'removeRecord',         data: { id: string } }
 *   ⇢ { id, type: 'removeDocumentChunks', data: { docId, forceCompact? } }
 *   ⇢ { id, type: 'removeDocumentChunksMany', data: { docIds: string[], compact? } }
 *   ⇢ { id, type: 'vectorSearch',         data: { embedding, limit } }
 *   ⇢ { id, type: 'keywordSearch',        data: { query, limit, hostId?, tags? } }
 *   ⇢ { id, type: 'tokenize',             data: { text } }
 *   ⇢ { id, type: 'getRecordsByDocId',    data: { docId } }
 *   ⇢ { id, type: 'getRecordsByDocIds',   data: { docIds: string[] } }
 *   ⇢ { id, type: 'getStats' }
 *   ⇢ { id, type: 'dropTable' }
 *   ⇢ { id, type: 'getValidRecords',      data: { docIds: string[] } }
 *   ⇢ { id, type: 'getAllDocIds' }
 *   ⇢ { id, type: 'compact',              data: { aggressive? } }
 *   ⇢ { id, type: 'nameList' }
 *   ⇢ { id, type: 'nameSearch',           data: { embedding, limit } }
 *   ⇢ { id, type: 'nameApply',            data: { removeIds, updates, inserts } }
 *   ⇢ { id, type: 'ping' }
 *
 * 响应（worker → 主进程）：
 *   ⇠ { id, success: true,  result: any }
 *   ⇠ { id, success: false, error: string, stack?: string }
 *
 *   initialize 的 result 包含额外事件字段：
 *     result.events = [{ name: 'dimensionMismatch'|'indexUnreadable'|'keywordIndexReady', args: any[] }]
 *
 *   向量表的每一行带一列 tokens（结巴切好的词），关键词检索用它的全文索引，见 keyword-index.js。
 *   写入时由 worker 对 content 切词填 tokens，调用方不用管。
 *
 *   vectorSearch 的 result.hits 不含 vector 字段，节省 IPC 带宽。
 *   getValidRecords / getRecordsByDocIds 包含 vector 字段（调用方需要）。
 *
 * 串行化：所有消息排进同一 promise 链，worker 内不并发操作 LanceDB。
 */
'use strict'

const path = require('path')
const fs = require('fs')
const { KeywordIndex } = require('./keyword-index.js')

// LanceDB 实例（延迟加载）
let lancedb = null
let db = null
let table = null
let nameTable = null
let nameBroken = false
const nameTableName = 'knowledge_names'

// 配置（由 initialize 消息写入）
let storagePath = ''
let corruptionMarkerPath = ''
let tableName = 'knowledge_vectors'
let dimensions = 384

// compact 状态
let deleteCount = 0
let lastCompactTime = 0

// 关键词检索（tokens 列 + 全文索引）。升级没做成时 keywordReady 为 false：
// 向量照常用，写入不带 tokens，关键词检索报错而不是返回空
let keyword = null
let keywordReady = false

/** 向量表里「一条记录」的列，不含 tokens：整表扫描时不必把切好的词也读上来 */
const RECORD_COLUMNS = ['id', 'docId', 'content', 'vector', 'filename', 'hostId', 'tags', 'chunkIndex', 'createdAt']

// ────────────────────────── LanceDB 加载 ──────────────────────────

async function loadLanceDB() {
  if (!lancedb) {
    lancedb = await import('@lancedb/lancedb')
    keyword = new KeywordIndex({ lancedb, log: console })
  }
  return lancedb
}

/** 待写入的行：关键词检索可用时补上 tokens，否则原样（旧表没有这一列，带上会写不进去） */
function forWrite(records) {
  return keywordReady ? keyword.withTokens(records) : records
}

/** 写入之后：补建全文索引；没覆盖到的行多了就并入一次。出错只记日志，不影响写入 */
async function afterWrite() {
  if (!keywordReady || !table) return
  try {
    await keyword.ensureIndex(table)
    if (await keyword.needsOptimize(table)) {
      await compact(false)
    }
  } catch (error) {
    console.warn('[LanceDBWorker] 全文索引维护失败（写入已完成）:', error)
  }
}

// ────────────────────────── 损坏标记 helpers ──────────────────────────

function markCorrupted(reason) {
  try {
    fs.writeFileSync(
      corruptionMarkerPath,
      JSON.stringify({ reason, at: Date.now() }),
      'utf-8'
    )
    console.warn('[LanceDBWorker] 已标记向量表为损坏，将在下次启动时重建:', reason)
  } catch (e) {
    console.warn('[LanceDBWorker] 写入损坏标记失败:', e)
  }
}

function consumeCorruptionMarker() {
  if (!fs.existsSync(corruptionMarkerPath)) return { corrupted: false }
  let reason
  try {
    const data = JSON.parse(fs.readFileSync(corruptionMarkerPath, 'utf-8'))
    reason = data && data.reason
  } catch { /* ignore */ }
  try { fs.unlinkSync(corruptionMarkerPath) } catch { /* ignore */ }
  return { corrupted: true, reason }
}

/** 与 lance-filter.ts 的 lanceEquals / lanceIn 同文，改那边要一起改。 */
function lanceEquals(column, value) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(column)) {
    throw new Error('invalid LanceDB column: ' + column)
  }
  return '`' + column + "` = '" + String(value).replace(/'/g, "''") + "'"
}

const LANCE_IN_BATCH = 200

function lanceIn(column, values) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(column)) {
    throw new Error('invalid LanceDB column: ' + column)
  }
  if (!values || values.length === 0) {
    throw new Error('lanceIn requires at least one value')
  }
  const list = values.map(value => "'" + String(value).replace(/'/g, "''") + "'").join(', ')
  return '`' + column + '` IN (' + list + ')'
}

function isLanceCorruptionError(error) {
  const msg = error instanceof Error ? error.message : String(error || '')
  if (!msg) return false
  return msg.includes('LanceError(IO)') && msg.includes('Not found')
}

// ────────────────────────── 表管理 helpers ──────────────────────────

/**
 * 让当前表具备关键词检索：补列、给还没切词的行切词、建全文索引。
 * 没做成不挡向量这一半：关键词检索暂不可用，下次启动或下一次检索时再试。
 */
async function prepareKeyword() {
  keywordReady = false
  const t0 = Date.now()
  const result = await keyword.prepare(table)
  keywordReady = true
  if (result.addedColumn || result.backfilled > 0) {
    console.log('[LanceDBWorker] 关键词索引已就绪：补列=%s 补切词=%d 行，耗时 %dms',
      result.addedColumn, result.backfilled, Date.now() - t0)
  }
  return result
}

/** 打开一张已经存在的表（另一个进程或旧版建的也可能缺 tokens 列，所以同样过一遍 prepare） */
async function openExistingTable() {
  table = await db.openTable(tableName)
  try {
    await prepareKeyword()
  } catch (error) {
    console.error('[LanceDBWorker] 关键词索引准备失败，关键词检索暂不可用:', error)
  }
}

async function ensureTable(sampleRecord) {
  if (table) return

  try {
    const names = await db.tableNames()
    if (names.includes(tableName)) {
      await openExistingTable()
      return
    }
  } catch (e) {
    console.warn('[LanceDBWorker] 检查表是否存在失败，继续尝试创建:', e)
  }
  // 新建的表从一开始就带 tokens 列
  keywordReady = true

  const isPlaceholder = !sampleRecord
  const recordToInsert = sampleRecord ?? {
    id: '__init__',
    docId: '__init__',
    content: '',
    vector: new Array(dimensions).fill(0),
    filename: '',
    hostId: '',
    tags: '',
    chunkIndex: 0,
    createdAt: Date.now()
  }

  try {
    table = await db.createTable(tableName, keyword.withTokens([recordToInsert]))
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    if (msg.includes('already exists')) {
      console.warn('[LanceDBWorker] createTable 冲突（磁盘残留表），fallback 到 openTable')
      await openExistingTable()
      return
    }
    throw error
  }

  if (isPlaceholder) {
    await table.delete(lanceEquals('id', '__init__'))
  }
}

async function compact(aggressive) {
  if (!table || !db) return
  try {
    if (typeof table.optimize === 'function') {
      const options = aggressive ? { cleanupOlderThan: new Date() } : undefined
      await table.optimize(options)
      console.log('[LanceDBWorker] Compact (optimize%s) completed', aggressive ? ', aggressive' : '')
    } else if (typeof table.cleanup === 'function') {
      await table.cleanup()
      console.log('[LanceDBWorker] Compact (cleanup) completed')
    } else if (typeof table.compaction === 'function') {
      await table.compaction()
      console.log('[LanceDBWorker] Compact (compaction) completed')
    } else {
      console.warn('[LanceDBWorker] No compact method available')
      return
    }
    // 重新打开表以刷新缓存
    const names = await db.tableNames()
    if (names.includes(tableName)) {
      table = await db.openTable(tableName)
      console.log('[LanceDBWorker] Table reopened to refresh cache')
    }
  } catch (error) {
    console.error('[LanceDBWorker] Compact failed:', error)
  }
}

async function compactIfNeeded() {
  const now = Date.now()
  if (deleteCount >= 10 || (now - lastCompactTime) > 5 * 60 * 1000) {
    await compact(false)
    deleteCount = 0
    lastCompactTime = now
  }
}

async function checkDimensionMismatch(expectedDimensions) {
  if (!table) return null
  const maxRetries = 3
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const sample = await table.query().limit(1).toArray()
      if (sample.length === 0) return null
      const vectorLength = sample[0].vector && sample[0].vector.length
      if (vectorLength && vectorLength !== expectedDimensions) {
        return vectorLength
      }
      return null
    } catch (error) {
      console.warn(`[LanceDBWorker] 维度检查第 ${attempt}/${maxRetries} 次查询失败:`, error)
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 500 * attempt))
      }
    }
  }

  // 读不开多半是缺了一块数据文件，不是维度变了。
  // 清空整表会把还能用的索引一起丢掉，启动时被当成「库是空的」去全量重建。
  console.warn('[LanceDBWorker] LanceDB 表数据无法读取，保留现有表（不清空）')
  return 'UNREADABLE'
}

// ────────────────────────── 消息处理函数 ──────────────────────────

async function handleInitialize(data) {
  const { storagePath: sp, dimensions: dim } = data || {}
  if (!sp || !dim) throw new Error('initialize 缺少参数：storagePath, dimensions')

  storagePath = sp
  dimensions = dim
  corruptionMarkerPath = path.join(storagePath, '.corrupted')
  tableName = 'knowledge_vectors'

  const events = []

  const { connect } = await loadLanceDB()
  db = await connect(storagePath)
  keyword.reset()

  // 损坏标记只表示「上次检索发现缺文件」。主进程应已先尝试从备份恢复；
  // 这里若标记还在，说明恢复没做成——保留现有表，绝不因标记清表。
  const corruption = consumeCorruptionMarker()
  if (corruption.corrupted) {
    console.warn('[LanceDBWorker] 启动时仍有损坏标记（恢复未成功），保留现有表:', corruption.reason)
  }

  // 检查表是否存在并验证维度
  const tableNames = await db.tableNames()
  if (tableNames.includes(tableName)) {
    table = await db.openTable(tableName)
    const mismatchResult = await checkDimensionMismatch(dim)
    if (mismatchResult === 'UNREADABLE') {
      events.push({ name: 'indexUnreadable', args: [] })
    } else if (mismatchResult !== null) {
      console.log(`[LanceDBWorker] 检测到向量维度变化 (${mismatchResult} -> ${dim})，清空旧索引`)
      await db.dropTable(tableName)
      table = null
      events.push({ name: 'dimensionMismatch', args: [{ old: mismatchResult, new: dim }] })
    } else {
      // 表读得开：让它具备关键词检索（补列、给还没切词的行切词、建全文索引）。
      // 没做成不挡向量这一半，下次启动再试
      try {
        events.push({ name: 'keywordIndexReady', args: [await prepareKeyword()] })
      } catch (error) {
        console.error('[LanceDBWorker] 关键词索引升级失败，本次启动关键词检索不可用:', error)
      }
    }
  } else {
    table = null
    // 还没有表：第一次写入时带 tokens 列新建
    keywordReady = true
  }

  return { ok: true, events }
}

async function handleAddRecord(data) {
  if (!db) throw new Error('数据库未初始化')
  await ensureTable(data.record)
  await table.add(forWrite([data.record]))
  await afterWrite()
  return { id: data.record.id }
}

async function handleAddRecords(data) {
  if (!db) throw new Error('数据库未初始化')
  const { records } = data || {}
  if (!records || records.length === 0) return { ids: [] }
  await ensureTable(records[0])
  await table.add(forWrite(records))
  await afterWrite()
  return { ids: records.map(r => r.id) }
}

async function handleRemoveRecord(data) {
  if (!table) return { removed: false }
  try {
    await table.delete(lanceEquals('id', data.id))
    return { removed: true }
  } catch {
    return { removed: false }
  }
}

async function handleRemoveDocumentChunks(data) {
  if (!table) return { count: 0 }
  const { docId, forceCompact } = data || {}
  try {
    const beforeCount = await table.countRows()
    await table.delete(lanceEquals('docId', docId))
    const afterCount = await table.countRows()
    const removed = beforeCount - afterCount

    if (removed > 0) {
      deleteCount++
      if (forceCompact) {
        await compact(false)
        deleteCount = 0
        lastCompactTime = Date.now()
      } else {
        compactIfNeeded().catch(e => console.warn('[LanceDBWorker] Compact failed:', e))
      }
    }

    return { count: removed }
  } catch (error) {
    console.error('[LanceDBWorker] Failed to remove chunks:', error)
    return { count: 0 }
  }
}

async function handleRemoveDocumentChunksMany(data) {
  if (!table) return { count: 0 }
  const docIds = (data && data.docIds) || []
  if (!Array.isArray(docIds) || docIds.length === 0) return { count: 0 }
  const unique = []
  const seen = new Set()
  for (const id of docIds) {
    if (typeof id !== 'string' || !id || seen.has(id)) continue
    seen.add(id)
    unique.push(id)
  }
  if (unique.length === 0) return { count: 0 }
  try {
    for (let i = 0; i < unique.length; i += LANCE_IN_BATCH) {
      await table.delete(lanceIn('docId', unique.slice(i, i + LANCE_IN_BATCH)))
    }
    if (data && data.compact) {
      await compact(false)
      deleteCount = 0
      lastCompactTime = Date.now()
    }
    return { count: unique.length }
  } catch (error) {
    console.error('[LanceDBWorker] Failed to remove chunks:', error)
    throw error
  }
}

async function handleVectorSearch(data) {
  if (!table) return { hits: [] }
  const { embedding, limit } = data || {}

  const runSearch = async () => {
    const results = await table
      .vectorSearch(embedding)
      .distanceType('cosine')
      .limit(limit || 20)
      .toArray()
    return results.map(r => ({
      id: r.id,
      docId: r.docId,
      content: r.content,
      _distance: r._distance,
      filename: r.filename,
      hostId: r.hostId,
      tags: r.tags
    }))
  }

  try {
    const hits = await runSearch()
    return { hits }
  } catch (error) {
    if (isLanceCorruptionError(error)) {
      console.warn('[LanceDBWorker] vectorSearch IO 错误，aggressive compact 后重试一次:', error.message)
      try {
        await compact(true)
        const hits = await runSearch()
        return { hits }
      } catch (retryErr) {
        markCorrupted(`vectorSearch: ${retryErr.message}`)
      }
    }
    console.error('[LanceDBWorker] vectorSearch failed:', error)
    return { hits: [], error: error.message }
  }
}

async function handleGetRecordsByDocId(data) {
  if (!table) return { records: [] }
  try {
    const allRows = await table.query().select(RECORD_COLUMNS).toArray()
    const records = allRows
      .filter(r => r.docId === data.docId)
      .map(r => ({
        id: r.id,
        docId: r.docId,
        content: r.content,
        vector: Array.from(r.vector),
        filename: r.filename,
        hostId: r.hostId,
        tags: r.tags,
        chunkIndex: r.chunkIndex,
        createdAt: r.createdAt
      }))
    return { records }
  } catch (error) {
    console.error('[LanceDBWorker] getRecordsByDocId failed:', error)
    return { records: [] }
  }
}

async function handleGetRecordsByDocIds(data) {
  if (!table) return { records: [] }
  const { docIds } = data || {}
  if (!docIds || docIds.length === 0) return { records: [] }
  const docIdSet = new Set(docIds)
  try {
    const allRows = await table.query().select(RECORD_COLUMNS).toArray()
    const seen = new Set()
    const records = []
    for (const r of allRows) {
      if (docIdSet.has(r.docId) && !seen.has(r.docId)) {
        seen.add(r.docId)
        records.push([r.docId, {
          id: r.id,
          docId: r.docId,
          content: r.content,
          vector: Array.from(r.vector),
          filename: r.filename,
          hostId: r.hostId,
          tags: r.tags,
          chunkIndex: r.chunkIndex,
          createdAt: r.createdAt
        }])
      }
    }
    return { records }
  } catch (error) {
    console.error('[LanceDBWorker] getRecordsByDocIds failed:', error)
    return { records: [] }
  }
}

async function handleGetStats() {
  if (!table) return { stats: { documentCount: 0, chunkCount: 0, totalSize: 0 } }
  try {
    const chunkCount = await table.countRows()
    const allRows = await table.query().select(['docId']).toArray()
    const uniqueDocIds = new Set(allRows.map(r => r.docId))
    return {
      stats: {
        documentCount: uniqueDocIds.size,
        chunkCount,
        totalSize: 0,
        lastUpdated: Date.now()
      }
    }
  } catch (error) {
    if (isLanceCorruptionError(error)) {
      markCorrupted(`getStats: ${error.message}`)
    }
    console.error('[LanceDBWorker] getStats failed:', error)
    return { stats: { documentCount: 0, chunkCount: 0, totalSize: 0 } }
  }
}

async function handleDropTable() {
  if (!db) return { ok: true }
  try {
    const names = await db.tableNames()
    if (names.includes(nameTableName)) {
      await db.dropTable(nameTableName)
    }
    nameTable = null
    nameBroken = false
    if (table || names.includes(tableName)) {
      await db.dropTable(tableName)
      table = null
    }
    keyword.reset()
    keywordReady = true
    deleteCount = 0
    return { ok: true }
  } catch (error) {
    console.error('[LanceDBWorker] dropTable failed:', error)
    throw error
  }
}

async function openNameTable() {
  if (nameBroken || !db) return null
  if (nameTable) return nameTable
  let names
  try {
    names = await db.tableNames()
  } catch (error) {
    console.error('[LanceDBWorker] 目录表列不出来:', error)
    nameBroken = true
    return null
  }
  if (!names.includes(nameTableName)) return null
  try {
    const opened = await db.openTable(nameTableName)
    const sample = await opened.query().select(['vector']).limit(1).toArray()
    const width = sample[0] && sample[0].vector && sample[0].vector.length
    if (width && width !== dimensions) {
      await db.dropTable(nameTableName)
      return null
    }
    nameTable = opened
    return nameTable
  } catch (error) {
    console.error('[LanceDBWorker] 目录和文件名这张表读不开:', error)
    nameBroken = true
    nameTable = null
    return null
  }
}

async function ensureNameTable(sample) {
  const existing = await openNameTable()
  if (nameBroken) return null
  if (existing) return existing
  nameTable = await db.createTable(nameTableName, [sample])
  return nameTable
}

async function handleNameList() {
  if (nameBroken) return { broken: true, rows: [] }
  try {
    const opened = await openNameTable()
    if (nameBroken) return { broken: true, rows: [] }
    if (!opened) return { rows: [] }
    const rows = await opened.query().select(['id', 'kind', 'text', 'folder', 'docId']).toArray()
    return {
      rows: rows.map(row => ({
        id: row.id,
        kind: row.kind,
        text: row.text,
        folder: row.folder || '',
        docId: row.docId || '',
      })),
    }
  } catch (error) {
    console.error('[LanceDBWorker] nameList failed:', error)
    nameBroken = true
    nameTable = null
    return { broken: true, rows: [] }
  }
}

async function handleNameSearch(data) {
  if (nameBroken) return { broken: true, hits: [] }
  try {
    const opened = await openNameTable()
    if (nameBroken) return { broken: true, hits: [] }
    if (!opened) return { hits: [] }
    const limit = (data && data.limit) || 10000
    const hits = await opened
      .vectorSearch(data.embedding)
      .distanceType('cosine')
      .limit(limit)
      .select(['kind', 'folder', 'docId'])
      .toArray()
    return {
      hits: hits.map(row => {
        const distance = typeof row._distance === 'number' ? row._distance : 0
        return {
          kind: row.kind,
          folder: row.folder || '',
          docId: row.docId || '',
          score: 1 - distance,
        }
      }),
    }
  } catch (error) {
    console.error('[LanceDBWorker] nameSearch failed:', error)
    nameBroken = true
    nameTable = null
    return { broken: true, hits: [] }
  }
}

async function handleNameApply(data) {
  if (!db) throw new Error('数据库未初始化')
  if (nameBroken) return { ok: false, broken: true }
  const removeIds = (data && data.removeIds) || []
  const updates = (data && data.updates) || []
  const inserts = (data && data.inserts) || []
  try {
    if (inserts.length > 0) {
      const opened = await ensureNameTable(inserts[0])
      if (!opened) return { ok: false, broken: true }
      for (const row of inserts) {
        await opened.delete(lanceEquals('id', row.id))
      }
      await opened.add(inserts)
    }
    const opened = await openNameTable()
    if (nameBroken) return { ok: false, broken: true }
    if (!opened) return { ok: true }
    for (const id of removeIds) {
      await opened.delete(lanceEquals('id', id))
    }
    for (const row of updates) {
      await opened.update({
        where: lanceEquals('id', row.id),
        values: {
          kind: row.kind,
          text: row.text,
          folder: row.folder,
          docId: row.docId || '',
        },
      })
    }
    return { ok: true }
  } catch (error) {
    console.error('[LanceDBWorker] nameApply failed:', error)
    nameBroken = true
    nameTable = null
    return { ok: false, broken: true }
  }
}

async function handleKeywordSearch(data) {
  if (!table) return { hits: [] }
  if (!keywordReady) {
    // 启动时没准备成：这一次再试，不必等下次重启
    try {
      await prepareKeyword()
    } catch (error) {
      console.error('[LanceDBWorker] 关键词索引准备失败:', error)
      return { hits: [], error: '关键词索引尚未就绪' }
    }
  }
  const { query, limit, hostId, tags } = data || {}
  const run = () => keyword.search(table, { query, limit, hostId, tags })
  try {
    return { hits: await run() }
  } catch (error) {
    if (isLanceCorruptionError(error)) {
      console.warn('[LanceDBWorker] keywordSearch IO 错误，aggressive compact 后重试一次:', error.message)
      try {
        await compact(true)
        return { hits: await run() }
      } catch (retryErr) {
        markCorrupted(`keywordSearch: ${retryErr.message}`)
      }
    }
    console.error('[LanceDBWorker] keywordSearch failed:', error)
    return { hits: [], error: error.message }
  }
}

async function handleTokenize(data) {
  await loadLanceDB()
  return { tokens: keyword.tokenize((data && data.text) || '') }
}

async function handleGetValidRecords(data) {
  if (!table) return { records: [] }
  const { docIds } = data || {}
  const validDocIds = new Set(docIds || [])
  if (validDocIds.size === 0) return { records: [] }
  try {
    const allRows = await table.query().select(RECORD_COLUMNS).toArray()
    const records = allRows
      .filter(r => validDocIds.has(r.docId))
      .map(r => ({
        id: r.id,
        docId: r.docId,
        content: r.content,
        vector: Array.from(r.vector),
        filename: r.filename,
        hostId: r.hostId,
        tags: r.tags,
        chunkIndex: r.chunkIndex,
        createdAt: r.createdAt
      }))
    return { records }
  } catch (error) {
    console.error('[LanceDBWorker] getValidRecords failed:', error)
    return { records: [] }
  }
}

async function handleGetChunkCount() {
  if (!table) return { count: 0 }
  try {
    return { count: await table.countRows() }
  } catch (error) {
    console.error('[LanceDBWorker] getChunkCount failed:', error)
    return { count: 0 }
  }
}

async function handleGetAllDocIds() {
  if (!table) return { docIds: [] }
  try {
    const allRows = await table.query().select(['docId']).toArray()
    const seen = new Set()
    const docIds = []
    for (const row of allRows) {
      if (row.docId && !seen.has(row.docId)) {
        seen.add(row.docId)
        docIds.push(row.docId)
      }
    }
    return { docIds }
  } catch (error) {
    if (isLanceCorruptionError(error)) {
      markCorrupted(`getAllDocIds: ${error.message}`)
    }
    console.error('[LanceDBWorker] getAllDocIds failed:', error)
    return { docIds: [] }
  }
}

async function handleCompact(data) {
  await compact(data && data.aggressive)
  return { ok: true }
}

// ────────────────────────── 消息分发 ──────────────────────────

async function dispatch(message) {
  const { id, type, data } = message || {}
  try {
    let result
    switch (type) {
      case 'initialize':           result = await handleInitialize(data);           break
      case 'addRecord':            result = await handleAddRecord(data);            break
      case 'addRecords':           result = await handleAddRecords(data);           break
      case 'removeRecord':         result = await handleRemoveRecord(data);         break
      case 'removeDocumentChunks': result = await handleRemoveDocumentChunks(data); break
      case 'removeDocumentChunksMany': result = await handleRemoveDocumentChunksMany(data); break
      case 'vectorSearch':         result = await handleVectorSearch(data);         break
      case 'keywordSearch':        result = await handleKeywordSearch(data);        break
      case 'tokenize':             result = await handleTokenize(data);             break
      case 'getRecordsByDocId':    result = await handleGetRecordsByDocId(data);    break
      case 'getRecordsByDocIds':   result = await handleGetRecordsByDocIds(data);   break
      case 'getStats':             result = await handleGetStats();                 break
      case 'dropTable':            result = await handleDropTable();                break
      case 'getValidRecords':      result = await handleGetValidRecords(data);      break
      case 'getAllDocIds':          result = await handleGetAllDocIds();             break
      case 'getChunkCount':         result = await handleGetChunkCount();            break
      case 'compact':              result = await handleCompact(data);              break
      case 'nameList':             result = await handleNameList();                 break
      case 'nameSearch':           result = await handleNameSearch(data);           break
      case 'nameApply':            result = await handleNameApply(data);            break
      case 'ping':                 result = { ok: true };                           break
      default:
        throw new Error(`未知消息类型：${type}`)
    }
    process.parentPort.postMessage({ id, success: true, result })
  } catch (err) {
    const errMsg = err && err.message ? err.message : String(err)
    const stack = err && err.stack ? err.stack : null
    process.parentPort.postMessage({ id, success: false, error: errMsg, stack })
  }
}

// 串行化：所有消息按到达顺序排进同一 promise 链，worker 内不并发操作 LanceDB
let queue = Promise.resolve()
process.parentPort.on('message', (e) => {
  queue = queue.then(() => dispatch(e && e.data))
})

console.log('[LanceDBWorker] started, pid=%d, node=%s', process.pid, process.version)
