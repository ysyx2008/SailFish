/**
 * 知识库关键词索引——真进程端到端：真起命令行进程、真写向量表、真重启，
 * 不用假模型（嵌入走仓库自带的轻量模型）。每个场景一个临时数据目录，不碰桌面真实数据。
 *
 *   node scripts/cli-e2e/knowledge-keyword.mjs
 *   node scripts/cli-e2e/knowledge-keyword.mjs --real   # 再拿一份桌面知识库副本（只读复制）走一遍升级
 *   E2E_KEEP=1 …                                         # 保留临时目录
 *
 * 1. 放进去的文档按字面能找到，删掉之后找不到；词和向量在同一行里，没有整本词索引文件
 * 2. 旧版往已升级的表里写了没有词的行（换回旧版用过的样子）：下次启动补上，之后能按字面找到
 * 3. 补完再启动一次，不再有待补的行（可重复启动）
 * 4. 旧的整本词索引文件：刚写过的留着，闲置超过 7 天的清掉
 * 5. （--real）真实知识库副本：升级后每一行都有词、全文索引覆盖全部行、按字面能找到对话里的内容
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { ROOT, makeChecker, runPlain, sandbox } from './harness.mjs'

const require = createRequire(path.join(ROOT, 'package.json'))
const lancedb = require('@lancedb/lancedb')
const { KeywordIndex } = require(path.join(ROOT, 'electron/services/knowledge/keyword-index.js'))
// 和产品里同一份切词与检索，直接对表查，绕开嵌入与融合
const keyword = new KeywordIndex({ lancedb, log: console })

const { failures, check } = makeChecker()
const tempDirs = []
const withReal = process.argv.includes('--real')

const knowledgeDir = (env) => path.join(env.dataDir, 'knowledge')
const lanceDir = (env) => path.join(knowledgeDir(env), 'lancedb')
const cli = (env, ...args) => runPlain(args, env, 180_000)

async function openTable(env) {
  const db = await lancedb.connect(lanceDir(env))
  return db.openTable('knowledge_vectors')
}

function listDocuments(env) {
  const file = path.join(knowledgeDir(env), 'documents.json')
  return JSON.parse(fs.readFileSync(file, 'utf8')).documents ?? []
}

function writeDoc(env, name, text) {
  const file = path.join(env.cwd, name)
  fs.writeFileSync(file, text)
  return file
}

/** 命令行搜索输出里「命中了哪些文件名」 */
const hitFiles = (out) => [...out.matchAll(/Doc: (.+?)\s+\|/g)].map((m) => m[1])

async function scenarioBasic() {
  console.log('\n[1] 放进去能按字面找到，删掉就没了')
  const env = sandbox(0, 'sft-kw-basic', tempDirs)
  const a = writeDoc(env, 'snow-leopard.md', '雪豹协议第七条规定：夜间巡检必须两人同行，并在黎明前提交巡检记录。')
  const b = writeDoc(env, 'plain.md', '这是一份关于食堂菜单和班车时刻的普通通知，与巡检无关。')
  for (const file of [a, b]) {
    const added = await cli(env, 'knowledge:add', file)
    check(`放入 ${path.basename(file)}`, added.code === 0, added.out + added.err)
  }

  const found = await cli(env, 'knowledge:search', '雪豹协议 夜间巡检')
  check('按字面找得到', hitFiles(found.out)[0] === 'snow-leopard.md', found.out.slice(0, 400))

  const table = await openTable(env)
  const rows = await table.query().select(['id', 'docId', 'tokens']).toArray()
  check('词和向量在同一行里', rows.length > 0 && rows.every((r) => typeof r.tokens === 'string' && r.tokens.length > 0))
  const indexNames = (await table.listIndices()).map((i) => i.name)
  check('全文索引已建', indexNames.includes('tokens_idx'), indexNames.join(','))
  check('没有整本词索引文件', !fs.existsSync(path.join(knowledgeDir(env), 'bm25-index.json')))

  const doc = listDocuments(env).find((d) => d.filename === 'snow-leopard.md')
  const removed = await cli(env, 'knowledge:remove', doc.id, '--yes')
  check('删除成功', removed.code === 0 && /已删除/.test(removed.out), removed.out + removed.err)
  const after = await cli(env, 'knowledge:search', '雪豹协议 夜间巡检')
  check('删掉之后按字面找不到', !hitFiles(after.out).includes('snow-leopard.md'), after.out.slice(0, 400))
  return env
}

async function scenarioOldBuildRows(env) {
  console.log('\n[2][3] 旧版写进来没有词的行：下次启动补上，可重复启动')
  const table = await openTable(env)
  const [template] = await table.query().limit(1).toArray()
  const row = {
    id: 'oldbuild-chunk-0',
    docId: template.docId,
    content: '旧版写入的片段：蓝鳍金枪鱼拍卖行情周报，包含竞价与冷链运输安排。',
    vector: Array.from(template.vector),
    filename: template.filename,
    hostId: template.hostId,
    tags: template.tags,
    chunkIndex: 99,
    createdAt: Date.now(),
  }
  await table.add([row]) // 没有 tokens 列：换回旧版时它就是这么写的
  check('旧版写入后确有待补的行', (await table.countRows('tokens IS NULL')) === 1)

  const run = await cli(env, 'knowledge:stats')
  check('启动成功', run.code === 0, run.err.slice(0, 400))
  const reopened = await openTable(env)
  check('待补的行已补上词', (await reopened.countRows('tokens IS NULL')) === 0)
  const hits = await keyword.search(reopened, { query: '蓝鳍金枪鱼 冷链', limit: 5 })
  check('补上之后按字面找得到', hits.some((h) => h.id === 'oldbuild-chunk-0'), JSON.stringify(hits))

  const again = await cli(env, 'knowledge:stats')
  check('再启动一次也正常', again.code === 0, again.err.slice(0, 400))
  const third = await openTable(env)
  check('重复启动没有重复补写', (await third.countRows('tokens IS NULL')) === 0 && (await third.countRows("id = 'oldbuild-chunk-0'")) === 1)
}

async function scenarioLegacyFile() {
  console.log('\n[4] 旧的整本词索引文件：新近写过的留着，闲置超过 7 天的清掉')
  const env = sandbox(0, 'sft-kw-legacy', tempDirs)
  const file = writeDoc(env, 'seed.md', '用来建表的一份文档。')
  await cli(env, 'knowledge:add', file)

  const legacy = path.join(knowledgeDir(env), 'bm25-index.json')
  fs.writeFileSync(legacy, '{}')
  await cli(env, 'knowledge:stats')
  check('刚写过的留着', fs.existsSync(legacy))

  const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
  fs.utimesSync(legacy, old, old)
  await cli(env, 'knowledge:stats')
  check('闲置超过 7 天的清掉', !fs.existsSync(legacy))
}

async function scenarioReal() {
  console.log('\n[5] 桌面知识库副本：升级后每一行都有词、全文索引覆盖全部行')
  const source = path.join(os.homedir(), 'Library/Application Support/SailFish/knowledge')
  if (!fs.existsSync(source)) {
    console.log('  跳过：没有桌面知识库')
    return
  }
  const env = sandbox(0, 'sft-kw-real', tempDirs)
  fs.cpSync(source, knowledgeDir(env), { recursive: true, mode: fs.constants.COPYFILE_FICLONE })
  const before = await (await openTable(env)).countRows()

  const started = Date.now()
  const run = await cli(env, 'knowledge:stats')
  check('升级后启动成功', run.code === 0, run.err.slice(0, 400))
  console.log(`  （首次启动 ${((Date.now() - started) / 1000).toFixed(1)}s，${before} 行）`)

  const table = await openTable(env)
  check('行数不变', (await table.countRows()) === before)
  check('每一行都有词', (await table.countRows('tokens IS NULL')) === 0)
  const stats = await table.indexStats('tokens_idx')
  check('全文索引覆盖全部行', stats?.numIndexedRows === before && stats?.numUnindexedRows === 0, JSON.stringify(stats))
  const hits = await keyword.search(table, { query: '配置', limit: 5 })
  check('按字面能找到内容', hits.length > 0)
}

try {
  const env = await scenarioBasic()
  await scenarioOldBuildRows(env)
  await scenarioLegacyFile()
  if (withReal) await scenarioReal()
} finally {
  if (!process.env.E2E_KEEP) for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
}

if (failures.length) {
  console.error(`\n${failures.length} 项失败`)
  process.exit(1)
}
console.log('\n全部通过')
