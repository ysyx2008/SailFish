/**
 * 压缩不蒸发内容——真进程端到端：每一条压缩前说过的话，压完之后要么还在窗口里，要么在归档里，
 * 不能两头都找不到。模型换成脚本化的假模型，压缩由「模型自己调 context 压缩」触发（和线上同一条路）。
 *
 *   node scripts/cli-e2e/compress-no-loss.mjs
 *   E2E_SHOW=1 …     # 打印每个场景压完后第一个请求里的消息概况
 *   E2E_KEEP=1 …     # 保留临时目录
 *
 * 1. 上一轮助手写的一大段正文（最终答复）：压完后原文仍在窗口里，用户原话也逐字在
 * 2. 上一轮先读文件再写正文：同上
 * 3. 这一轮助手一条消息里既有正文又带压缩调用：正文压完仍在窗口里（不会被收进小结就没了）
 * 4. 多轮、含「先说一段再调工具」的中间消息，小窗口与大窗口各一次：每一条要么在窗口里，要么在归档里
 */
import fs from 'node:fs'
import path from 'node:path'
import { callTool, say, startMockLlm } from './mock-llm.mjs'
import { ROOT, makeChecker, runPlain, sandbox } from './harness.mjs'

const { failures, check } = makeChecker()
const tempDirs = []
const scenarios = []
const scenario = (name, run) => scenarios.push({ name, run })
const COMPACT_RUNNER = path.join(ROOT, 'scripts/cli-e2e/compact-runner.cjs')

const SUMMARY_MARK = '这份小结一次最多输出'
const SIDE_MARKS = ['这一步只更新记忆', '生成侧栏会话短标题']
const textOf = (message) => (typeof message?.content === 'string' ? message.content : JSON.stringify(message?.content ?? ''))

/** 带刻度和结尾标记的长正文：压完要原样找得到 */
const longText = (name) => `${Array.from({ length: 12 }, (_, i) => `${name}_F${(i + 1) * 100}:${'字'.repeat(95)}`).join('')}${name}_TAIL`
const userLine = (name) => `请你${name}`

async function run(prefix, onUser, steps, { contextLength } = {}) {
  const env = sandbox(0, prefix, tempDirs)
  fs.writeFileSync(path.join(env.cwd, 'A.txt'), '一份很短的文件\n')
  const llm = await startMockLlm({
    jsonForNonStream: true,
    onUser: (text, n, entry) => {
      if (entry.lastText.includes(SUMMARY_MARK)) return say('小结：压缩前的交接')
      if (SIDE_MARKS.some((m) => entry.lastText.includes(m))) return say('好')
      return onUser(text, env)
    },
    afterTool: (last) => {
      const out = textOf(last)
      if (/上下文已压缩|压缩前|没有可压缩的内容|Nothing to compress/i.test(out)) return say('压好了')
      return say(longText('READ'))
    },
  })
  env.env.SFT_API_URL = `http://127.0.0.1:${llm.port}/v1`
  try {
    const result = await runPlain([], {
      ...env,
      env: { ...env.env, STEPS: JSON.stringify(steps), ...(contextLength ? { CONTEXT_LENGTH: String(contextLength) } : {}) },
    }, 180_000, COMPACT_RUNNER)
    return { env, llm, result }
  } catch (error) {
    await llm.close()
    throw error
  }
}

/** 压完之后发出的第一个主干请求（压缩那次工具调用的结果送回去的那次） */
function afterCompressRequest(llm) {
  const mains = llm.mainRequests().filter((r) => !r.lastText.includes(SUMMARY_MARK))
  const at = mains.findIndex((r) => r.lastRole === 'tool' && /上下文已压缩|压缩前|没有可压缩的内容|Nothing to compress/i.test(r.lastText))
  return at >= 0 ? mains[at] : undefined
}
const windowText = (entry) => JSON.stringify(entry.body.messages)

/** 盘上这场会话里的归档原文 */
function archivedText(dataDir) {
  let found = ''
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name)
      if (fs.statSync(p).isDirectory()) walk(p)
      else if (/\.(json|jsonl)$/.test(name)) {
        const txt = fs.readFileSync(p, 'utf8')
        if (txt.includes('compressedArchives')) found += txt
      }
    }
  }
  walk(path.join(dataDir, 'history'))
  return found
}

const dataDirOf = (env) => env.env.SFT_DATA_DIR

// ───────────────────────────────────────────────────────────── 1
scenario('上一轮的长正文（最终答复）：压完后原文与用户原话都还在窗口里', async () => {
  const { env, llm, result } = await run('sft-noloss-1', (text) => {
    if (text.includes('写长文A')) return say(longText('A'))
    if (text.includes('压缩一下')) return callTool('context', { action: 'compress' })
    return say('好的')
  }, [{ say: userLine('写长文A') }, { say: '请压缩一下' }])
  try {
    check('跑完没报错', result.out.includes('RUNNER_DONE'), `${result.out.slice(-200)} ${result.err.slice(-400)}`)
    const req = afterCompressRequest(llm)
    check('压缩之后发出了请求', !!req)
    if (!req) return
    if (process.env.E2E_SHOW) console.log(req.body.messages.map((m, i) => `    ${i} ${m.role} ${textOf(m).slice(0, 60).replace(/\n/g, ' ')} (${textOf(m).length})`).join('\n'))
    check('长正文逐字在窗口里（含结尾）', windowText(req).includes('A_TAIL') && windowText(req).includes('A_F600'))
    check('用户原话逐字在窗口里', windowText(req).includes(userLine('写长文A')) && windowText(req).includes('请压缩一下'))
  } finally { await llm.close() }
})

// ───────────────────────────────────────────────────────────── 2
scenario('上一轮先读文件再写正文：压完后原文仍在', async () => {
  const { env, llm, result } = await run('sft-noloss-2', (text, e) => {
    if (text.includes('读写长文B')) return callTool('read_file', { path: path.join(e.cwd, 'A.txt') })
    if (text.includes('压缩一下')) return callTool('context', { action: 'compress' })
    return say('好的')
  }, [{ say: userLine('读写长文B') }, { say: '请压缩一下' }])
  try {
    check('跑完没报错', result.out.includes('RUNNER_DONE'), `${result.out.slice(-200)} ${result.err.slice(-400)}`)
    const req = afterCompressRequest(llm)
    check('压缩之后发出了请求', !!req)
    if (!req) return
    check('长正文逐字在窗口里（含结尾）', windowText(req).includes('READ_TAIL'))
    check('用户原话逐字在窗口里', windowText(req).includes(userLine('读写长文B')))
  } finally { await llm.close() }
})

// ───────────────────────────────────────────────────────────── 3
scenario('这一轮：助手一条消息里既有长正文又带压缩调用，压完正文仍在窗口里', async () => {
  const { llm, result } = await run('sft-noloss-3', (text) => {
    if (text.includes('说完就压')) return callTool('context', { action: 'compress' }, longText('G'))
    return say('好的')
  }, [{ say: userLine('说完就压') }])
  try {
    check('跑完没报错', result.out.includes('RUNNER_DONE'), `${result.out.slice(-200)} ${result.err.slice(-400)}`)
    const req = afterCompressRequest(llm)
    check('压缩之后发出了请求', !!req)
    if (!req) return
    check('同一条消息里的长正文逐字在窗口里（含结尾）', windowText(req).includes('G_TAIL') && windowText(req).includes('G_F600'))
    check('用户原话逐字在窗口里', windowText(req).includes(userLine('说完就压')))
  } finally { await llm.close() }
})

// ───────────────────────────────────────────────────────────── 4
for (const contextLength of [40_000, 128_000]) {
  scenario(`多轮（含「先说一段再调工具」的中间消息）压缩，窗口 ${contextLength}：每条要么在窗口要么在归档`, async () => {
    const plain = ['C', 'E']
    const { env, llm, result } = await run(`sft-noloss-4-${contextLength}`, (text, e) => {
      for (const n of plain) if (text.includes(`写长文${n}`)) return say(longText(n))
      if (text.includes('说一段再读')) return callTool('read_file', { path: path.join(e.cwd, 'A.txt') }, longText('H'))
      if (text.includes('压缩一下')) return callTool('context', { action: 'compress' })
      return say('好的')
    }, [
      { say: userLine('写长文C') },
      { say: userLine('说一段再读') },
      { say: userLine('写长文E') },
      { say: '请压缩一下' },
    ], { contextLength })
    try {
      check('跑完没报错', result.out.includes('RUNNER_DONE'), `${result.out.slice(-200)} ${result.err.slice(-400)}`)
      const req = afterCompressRequest(llm)
      check('压缩之后发出了请求', !!req)
      if (!req) return
      const inWindow = windowText(req)
      const archived = archivedText(dataDirOf(env))
      if (process.env.E2E_SHOW) console.log(req.body.messages.map((m, i) => `    ${i} ${m.role} ${textOf(m).slice(0, 50).replace(/\n/g, ' ')} (${textOf(m).length})`).join('\n'))
      const where = (needle) => (inWindow.includes(needle) ? '窗口' : archived.includes(needle) ? '归档' : '两头都没有')
      for (const [label, needle] of [
        ['长正文 C', 'C_TAIL'], ['中间消息里的长正文 H', 'H_TAIL'], ['读文件后的长正文 READ', 'READ_TAIL'], ['长正文 E', 'E_TAIL'],
        ['用户原话 C', userLine('写长文C')], ['用户原话 说一段再读', userLine('说一段再读')], ['用户原话 E', userLine('写长文E')], ['用户原话 压缩', '请压缩一下'],
      ]) {
        const w = where(needle)
        check(`${label}：压完后在窗口或归档里（${w}）`, w !== '两头都没有')
      }
    } finally { await llm.close() }
  })
}

// ─────────────────────────────────────────────────────────────
for (const [index, item] of scenarios.entries()) {
  console.log(`\n▶ ${index + 1}. ${item.name}`)
  try { await item.run() } catch (error) {
    failures.push(`${item.name} — 脚本出错：${error?.stack || error}`)
    console.error(`  FAIL 脚本出错：${error?.stack || error}`)
  }
}
if (!process.env.E2E_KEEP) for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
if (failures.length) {
  console.error(`\n${failures.length} 项没过：`)
  for (const f of failures) console.error(`  - ${f.slice(0, 400)}`)
  process.exit(1)
}
console.log('\n全部通过')
