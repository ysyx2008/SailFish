/**
 * 知识库关键词索引——桌面应用里的真进程端到端（向量库跑在独立的工作进程里，命令行测不到这条路）。
 * 用桌面知识库的一份只读副本，临时数据目录，窗口不抢前台。
 *
 *   npx vite build && node scripts/ui-e2e/knowledge-keyword-worker.mjs
 *   E2E_KEEP=1 …    # 保留临时目录
 *
 * 1. 第一次启动：旧表升级，每一行都有词、全文索引覆盖全部行
 * 2. 通过应用的检索接口：按字面找得到对话里的内容；放入文档立刻找得到；删除立刻找不到，且删除不卡
 * 3. 退出后再启动：不重复升级，放进去又删掉的文档没有残留
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { launchApp, REPO } from './launch.mjs'

const require = createRequire(path.join(REPO, 'package.json'))
const lancedb = require('@lancedb/lancedb')

const failures = []
const check = (label, pass, detail) => {
  if (pass) console.log(`  OK   ${label}`)
  else {
    failures.push(label)
    console.error(`  FAIL ${label}${detail ? ` — ${String(detail).slice(0, 500)}` : ''}`)
  }
}

const source = path.join(os.homedir(), 'Library/Application Support/SailFish/knowledge')
if (!fs.existsSync(source)) {
  console.log('跳过：没有桌面知识库可以拷贝')
  process.exit(0)
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sft-kw-worker-'))
fs.cpSync(source, path.join(dataDir, 'knowledge'), { recursive: true, mode: fs.constants.COPYFILE_FICLONE })
const lanceDir = path.join(dataDir, 'knowledge', 'lancedb')

async function tableState() {
  const db = await lancedb.connect(lanceDir)
  const table = await db.openTable('knowledge_vectors')
  const rows = await table.countRows()
  const stats = await table.indexStats('tokens_idx')
  return { rows, noTokens: await table.countRows('tokens IS NULL'), stats, table }
}

async function startAndWait() {
  const app = await launchApp(dataDir)
  const page = await app.firstWindow()
  const started = Date.now()
  // 窗口启动时会换几次页面，等到接口出现、调用不被导航打断为止
  const deadline = Date.now() + 240_000 // 等知识库初始化最多 4 分钟
  let ok = 'timeout'
  while (Date.now() < deadline) {
    try {
      ok = await page.evaluate(async () => {
        const api = window.electronAPI
        if (!api?.knowledge) throw new Error('接口还没出现')
        // 临时数据目录是首次启动，要向导完成后才会初始化知识库
        await api.config.setSetupCompleted(true)
        return await api.knowledge.waitInitialized()
      })
      break
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
  return { app, page, ok, seconds: (Date.now() - started) / 1000 }
}

const search = (page, query, limit = 8) =>
  page.evaluate(([q, l]) => window.electronAPI.knowledge.search(q, { limit: l }), [query, limit])

try {
  console.log('\n[1] 第一次启动：旧表升级')
  const before = await (await lancedb.connect(lanceDir)).openTable('knowledge_vectors').then((t) => t.countRows())
  let session = await startAndWait()
  check('知识库初始化完成', session.ok === true, session.ok)
  console.log(`  （等到初始化完成 ${session.seconds.toFixed(1)}s，${before} 行）`)
  let state = await tableState()
  check('行数不变', state.rows === before, `${state.rows} vs ${before}`)
  check('每一行都有词', state.noTokens === 0, state.noTokens)
  check('全文索引覆盖全部行', state.stats?.numIndexedRows === state.rows && state.stats?.numUnindexedRows === 0, JSON.stringify(state.stats))

  console.log('\n[2] 检索、放入、删除')
  const hit = await search(session.page, 'jieba')
  check('按字面找得到对话里的内容', hit.success && hit.results.some((r) => /DolphinDB/.test(r.content)), JSON.stringify(hit).slice(0, 300))

  const marker = '紫藤回廊协议'
  const added = await session.page.evaluate(async (text) => window.electronAPI.knowledge.addDocument({
    filename: 'e2e-wisteria.md',
    fileType: 'md',
    content: text,
    fileSize: text.length,
    parseTime: 1,
  }), `${marker}第三条：周五下午三点由值班同事统一更新台账，逾期未更新者在周会上说明原因。`)
  check('放入文档', added.success && !!added.docId, JSON.stringify(added))
  const found = await search(session.page, `${marker} 台账`)
  check('放入后立刻按字面找得到', found.success && found.results[0]?.metadata?.filename === 'e2e-wisteria.md', JSON.stringify(found).slice(0, 300))

  const t0 = Date.now()
  const removed = await session.page.evaluate((id) => window.electronAPI.knowledge.removeDocument(id), added.docId)
  const removeMs = Date.now() - t0
  check('删除成功', removed.success, JSON.stringify(removed))
  console.log(`  （删除一份文档 ${removeMs}ms）`)
  check('删除不卡（< 3s）', removeMs < 3000, removeMs)
  const gone = await search(session.page, `${marker} 台账`)
  check('删除后按字面找不到', gone.success && !gone.results.some((r) => r.metadata?.filename === 'e2e-wisteria.md'), JSON.stringify(gone).slice(0, 300))
  await session.app.close()

  console.log('\n[3] 退出后再启动')
  session = await startAndWait()
  check('再次初始化完成', session.ok === true, session.ok)
  console.log(`  （等到初始化完成 ${session.seconds.toFixed(1)}s）`)
  state = await tableState()
  check('行数回到原样，没有残留', state.rows === before, `${state.rows} vs ${before}`)
  check('仍然每一行都有词', state.noTokens === 0, state.noTokens)
  const again = await search(session.page, 'jieba')
  check('重启后仍按字面找得到', again.success && again.results.length > 0)
  await session.app.close()
} finally {
  if (!process.env.E2E_KEEP) fs.rmSync(dataDir, { recursive: true, force: true })
  else console.log(`保留：${dataDir}`)
}

if (failures.length) {
  console.error(`\n${failures.length} 项失败：${failures.join('；')}`)
  process.exit(1)
}
console.log('\n全部通过')
