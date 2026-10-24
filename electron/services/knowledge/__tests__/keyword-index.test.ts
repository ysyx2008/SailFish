import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

/**
 * 关键词索引：真 LanceDB（临时目录）+ 真结巴。
 * 对照的是旧 BM25 实现的公式（k1=1.2、b=0.75），分数要对得上，
 * 这样自动翻阅的门槛和按字面找的筛法才不用重调。
 */

const lancedb: any = await import('@lancedb/lancedb')
const mod: any = await import('../keyword-index.js')
const { KeywordIndex } = mod.default ?? mod

const silent = { info: () => {}, warn: () => {} }
const DIM = 4

interface Row {
  id: string
  docId: string
  content: string
  vector: number[]
  filename: string
  hostId: string
  tags: string
  chunkIndex: number
  createdAt: number
}

function row(id: string, content: string, extra: Partial<Row> = {}): Row {
  return {
    id,
    docId: extra.docId ?? id.split('_')[0],
    content,
    vector: [0.1, 0.2, 0.3, 0.4],
    filename: 'f.md',
    hostId: '',
    tags: '',
    chunkIndex: 0,
    createdAt: 1,
    ...extra,
  }
}

const CORPUS = [
  'nginx 配置反向代理，把请求转发到后端服务',
  '删除对话很慢，原因是每次都整本重写词索引文件',
  '旗鱼是一个私人 AI 助手，可以操作本地和远程服务器',
  'Excel 表格统计：按月份汇总销售额并画折线图',
  'ssh 连接服务器失败时，先检查密钥权限和防火墙',
  '报销发票需要上传 PDF，财务每周三统一处理',
  'docker compose 部署 nginx 和数据库，注意挂载卷',
  '知识库的向量检索与关键词检索融合后排序',
  '周报模板：本周完成、下周计划、风险与阻塞',
  'git 合并分支前先变基，冲突机械的自己解决',
  '服务器磁盘占满，清理日志和旧的备份目录',
  '帮我翻译成英文，保持语气正式',
]

/** 旧实现的公式：对每个查询词累加 idf * tf*(k1+1)/(tf + k1*(1-b+b*dl/avgdl)) */
function referenceBm25(ki: any, docs: Array<{ id: string; content: string }>, query: string) {
  const k1 = 1.2
  const b = 0.75
  const tokenized = docs.map(d => ({ id: d.id, tokens: ki.tokenize(d.content) as string[] }))
  const n = tokenized.length
  const avg = tokenized.reduce((s, d) => s + d.tokens.length, 0) / n
  const scores = new Map<string, number>()
  for (const term of ki.tokenize(query) as string[]) {
    const holders = tokenized.filter(d => d.tokens.includes(term))
    if (holders.length === 0) continue
    const idf = Math.log((n - holders.length + 0.5) / (holders.length + 0.5) + 1)
    for (const d of holders) {
      const tf = d.tokens.filter(t => t === term).length
      const s = (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * d.tokens.length) / avg))
      scores.set(d.id, (scores.get(d.id) || 0) + s)
    }
  }
  return [...scores.entries()].sort((a, b2) => b2[1] - a[1])
}

let dir: string
let db: any
let ki: any

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sailfish-kw-'))
  db = await lancedb.connect(dir)
  ki = new KeywordIndex({ lancedb, log: silent })
})

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('切词', () => {
  it('丢标点和单个数字，英文转小写，保留多位数字', () => {
    const tokens: string[] = ki.tokenize('Nginx 配置，3 个 Server 监听 8080！')
    expect(tokens).toContain('nginx')
    expect(tokens).toContain('server')
    expect(tokens).toContain('8080')
    expect(tokens).not.toContain('3')
    expect(tokens.some(t => /^[，！\s]+$/.test(t))).toBe(false)
  })

  it('空文本没有词', () => {
    expect(ki.tokenize('')).toEqual([])
    expect(ki.tokenize('，。！')).toEqual([])
  })

  it('写入时补 tokens，已有 tokens 的不重算', () => {
    const [a, b] = ki.withTokens([row('a_0', '旗鱼助手'), { ...row('b_0', '旗鱼助手'), tokens: 'x' }])
    expect(a.tokens).toBe(ki.tokensText('旗鱼助手'))
    expect(b.tokens).toBe('x')
  })
})

describe('从旧表升级', () => {
  it('补列、回填、建索引；行数与向量原样，重复 id 不炸', async () => {
    const legacy = await db.createTable('legacy', CORPUS.map((c, i) => row(`d${i}_c0`, c, { docId: `d${i}` })))
    // 表里偶有重复 id（真实库里见过）
    await legacy.add([row('d0_c0', CORPUS[0], { docId: 'd0' })])
    const before = await legacy.countRows()

    const result = await ki.prepare(legacy)
    expect(result.addedColumn).toBe(true)
    expect(result.backfilled).toBe(before)
    expect(result.indexed).toBe(true)

    expect(await legacy.countRows()).toBe(before)
    expect(await legacy.countRows('tokens IS NULL')).toBe(0)
    expect(await legacy.countRows('content IS NULL OR vector IS NULL')).toBe(0)
    const sample = await legacy.query().where("`id` = 'd1_c0'").toArray()
    expect(Array.from(sample[0].vector as Iterable<number>)).toEqual([
      expect.closeTo(0.1, 5), expect.closeTo(0.2, 5), expect.closeTo(0.3, 5), expect.closeTo(0.4, 5),
    ])
    expect(sample[0].tokens).toBe(ki.tokensText(CORPUS[1]))
  })

  it('重跑什么都不再做；旧版换回期间写的行（没有 tokens）下次补上', async () => {
    const table = await db.openTable('legacy')
    const again = await ki.prepare(table)
    expect(again).toEqual({ addedColumn: false, backfilled: 0, indexed: true })

    // 旧版往带 tokens 列的表里写不带该列的行：不能报错
    await table.add([row('late_c0', '迟到的片段：旗鱼知识库升级', { docId: 'late' })])
    expect(await table.countRows('tokens IS NULL')).toBe(1)

    const fresh = new KeywordIndex({ lancedb, log: silent })
    const resumed = await fresh.prepare(table)
    expect(resumed.backfilled).toBe(1)
    expect(await table.countRows('tokens IS NULL')).toBe(0)
    await table.delete("`id` = 'late_c0'")
  })
})

describe('同 id 而正文不同的行', () => {
  it('各自按自己的正文切词，不串到对方身上', async () => {
    const table = await db.createTable('dupe', [
      row('x_c0', '苹果香蕉'),
      row('x_c0', "橙子葡萄 it's quoted"),
      row('y_c0', '西瓜'),
    ])
    const result = await ki.prepare(table)
    expect(result.backfilled).toBe(3)
    expect(await table.countRows('tokens IS NULL')).toBe(0)

    const apples = await table.query().where("content = '苹果香蕉'").toArray()
    const oranges = await table.query().where("content LIKE '橙子%'").toArray()
    expect(apples).toHaveLength(1)
    expect(oranges).toHaveLength(1)
    expect(apples[0].tokens).toBe(ki.tokensText('苹果香蕉'))
    expect(oranges[0].tokens).toBe(ki.tokensText("橙子葡萄 it's quoted"))

    const hits = await ki.search(table, { query: '橙子', limit: 5 })
    expect(hits.map((h: any) => h.content)).toEqual(["橙子葡萄 it's quoted"])
  })
})

describe('检索', () => {
  let table: any
  const docs = CORPUS.map((content, i) => ({ id: `s${i}_c0`, content }))

  beforeAll(async () => {
    table = await db.createTable('fresh', ki.withTokens(docs.map(d => row(d.id, d.content, {
      docId: d.id.split('_')[0],
      hostId: d.id === 's0_c0' ? 'host-a' : d.id === 's6_c0' ? 'host-b' : '',
      tags: d.id === 's0_c0' ? 'host-memory,host-a' : d.id === 's1_c0' ? 'conversation' : '',
    }))))
    await ki.ensureIndex(table)
  })

  it('结果、先后、分数与旧 BM25 公式一致', async () => {
    for (const query of ['nginx 配置反向代理', '删除对话很慢', '服务器 备份', '知识库 检索', '报销 发票']) {
      const expected = referenceBm25(ki, docs, query).slice(0, 10)
      const hits = await ki.search(table, { query, limit: 10 })
      expect(hits.map((h: any) => h.id)).toEqual(expected.map(e => e[0]))
      hits.forEach((hit: any, i: number) => expect(hit.score).toBeCloseTo(expected[i][1], 3))
    }
  })

  it('筛选之后不够数，会加大取回量再筛（不能因为前几名都被筛掉就空手而归）', async () => {
    // 「nginx」命中的两篇都不是这台主机的，「删除」命中的那篇是通用的
    const hits = await ki.search(table, { query: 'nginx 删除', limit: 1, hostId: 'host-z' })
    expect(hits.map((h: any) => h.id)).toEqual(['s1_c0'])
    const byTag = await ki.search(table, { query: 'nginx 删除', limit: 1, tags: ['conversation'] })
    expect(byTag.map((h: any) => h.id)).toEqual(['s1_c0'])
  })

  it('没有切出词、或没有命中，返回空', async () => {
    expect(await ki.search(table, { query: '，。', limit: 5 })).toEqual([])
    expect(await ki.search(table, { query: 'zzzzqqqq', limit: 5 })).toEqual([])
  })

  it('按主机筛：通用的和这台的，别台的不要', async () => {
    const hits = await ki.search(table, { query: 'nginx', limit: 10, hostId: 'host-b' })
    const ids = hits.map((h: any) => h.id)
    expect(ids).toContain('s6_c0')
    expect(ids).not.toContain('s0_c0')
    const all = await ki.search(table, { query: 'nginx', limit: 10 })
    expect(all.map((h: any) => h.id)).toContain('s0_c0')
  })

  it('按标签筛：任一命中；标签整词匹配', async () => {
    const hit = await ki.search(table, { query: '删除 对话 nginx', limit: 10, tags: ['conversation'] })
    expect(hit.map((h: any) => h.id)).toEqual(['s1_c0'])
    const partial = await ki.search(table, { query: '删除 对话 nginx', limit: 10, tags: ['convers'] })
    expect(partial).toEqual([])
    const either = await ki.search(table, { query: 'nginx 删除', limit: 10, tags: ['host-memory', 'conversation'] })
    expect(either.map((h: any) => h.id).sort()).toEqual(['s0_c0', 's1_c0'])
  })

  it('带单引号的主机名、标签不会破坏查询', async () => {
    const hits = await ki.search(table, { query: 'nginx', limit: 5, hostId: "o'brien", tags: ["a'b"] })
    expect(hits).toEqual([])
  })

  it('新写入的行索引还没覆盖到也搜得到；删掉就搜不到', async () => {
    await table.add(ki.withTokens([row('new_c0', '独一无二的测试词汇旗鱼飞跃', { docId: 'new' })]))
    const found = await ki.search(table, { query: '独一无二', limit: 3 })
    expect(found.map((h: any) => h.id)).toContain('new_c0')

    await table.delete("`docId` = 'new'")
    const gone = await ki.search(table, { query: '独一无二', limit: 3 })
    expect(gone.map((h: any) => h.id)).not.toContain('new_c0')
  })

  it('没覆盖到的行不多，不要求并入', async () => {
    expect(await ki.needsOptimize(table)).toBe(false)
  })
})
