/**
 * 压缩归档取回——真进程端到端：真起后端进程、真读文件、真压缩、真走 recall 工具，
 * 模型换成脚本化的假模型。
 *
 *   node scripts/cli-e2e/recall-archive.mjs
 *   E2E_SHOW=1 …     # 把取回的结果打出来
 *   E2E_KEEP=1 …     # 保留临时目录
 *
 * 1. 压完后 recall(archive_id) 一览：长内容只露开头，写明总长和取全文的办法
 * 2. 沿着一览里给的办法 recall(archive_id, message_index)：写文件的长入参从头到结尾一字不缺
 * 3. 超过一页的 offset 接着读，拼起来和当时写下的入参逐字相同
 *
 * 读文件 / 命令的输出在进对话时就按各自的上限截过（读文件会提示分段读），归档里存的是模型当时看到的，
 * 所以这里用「模型自己写出来的长入参」做被取回的那一条。
 * 4. 序号越界：报错并说明条数，不崩
 */
import fs from 'node:fs'
import path from 'node:path'
import { callTool, say, startMockLlm } from './mock-llm.mjs'
import { ROOT, makeChecker, runPlain, sandbox } from './harness.mjs'

const { failures, check } = makeChecker()
const tempDirs = []
const COMPACT_RUNNER = path.join(ROOT, 'scripts/cli-e2e/compact-runner.cjs')

const SUMMARY_MARK = '这份小结一次最多输出'
const SIDE_MARKS = ['这一步只更新记忆', '生成侧栏会话短标题']
const textOf = (message) => (typeof message?.content === 'string' ? message.content : JSON.stringify(message?.content ?? ''))

// 一份比一页（20000 字符）长的文件，每 100 行埋一个刻度，末尾一个结尾标记
const LINES = 900
const fileBody = [
  ...Array.from({ length: LINES }, (_, i) => `L${String(i).padStart(4, '0')} ${'内容'.repeat(14)}${i % 100 === 0 ? ` SCALE_${i}` : ''}`),
  'TAIL_MARKER_ZZZ',
].join('\n')

const env = sandbox(0, 'sft-recall-archive', tempDirs)
const WRITE_ARGS = { path: path.join(env.cwd, 'A.txt'), content: fileBody, mode: 'create' }
const EXPECTED = `**Tool Call**: write_text_file\n**Args**: ${JSON.stringify(WRITE_ARGS)}`

const recallResults = []
const llm = await startMockLlm({
  jsonForNonStream: true,
  onUser: (text, _n, entry) => {
    if (entry.lastText.includes(SUMMARY_MARK)) return say('小结：读过 A.txt')
    if (SIDE_MARKS.some((m) => entry.lastText.includes(m))) return say('好')
    if (text.includes('写A')) return callTool('write_text_file', WRITE_ARGS)
    if (text.includes('取回')) return callTool('recall', { archive_id: 'ca-1' })
    return say('好的')
  },
  afterTool: (last) => {
    const out = textOf(last)
    if (!/Compressed Archive|归档 ca-1/.test(out)) return say('写好了') // 写文件的结果
    if (out.includes('Compressed Archive: ca-1') && !out.includes('**Message ')) {
      // 一览：沿着读文件那一条给的办法单取
      recallResults.push({ kind: 'overview', out })
      const m = out.match(/write_text_file[\s\S]*?message_index: (\d+)/)
      return m ? callTool('recall', { archive_id: 'ca-1', message_index: Number(m[1]) }) : say('一览里没有给取全文的办法')
    }
    if (out.includes('**Message ')) {
      recallResults.push({ kind: 'page', out })
      const next = out.match(/offset: (\d+)\)/)
      const index = Number(out.match(/\*\*Message (\d+) \//)[1])
      return next ? callTool('recall', { archive_id: 'ca-1', message_index: index, offset: Number(next[1]) }) : callTool('recall', { archive_id: 'ca-1', message_index: 999 })
    }
    recallResults.push({ kind: 'other', out })
    return say('取完了')
  },
})
env.env.SFT_API_URL = `http://127.0.0.1:${llm.port}/v1`

try {
  const result = await runPlain([], {
    ...env,
    env: { ...env.env, STEPS: JSON.stringify([{ say: '写A文件' }, { compact: true }, { say: '取回 ca-1 看看' }]) },
  }, 180_000, COMPACT_RUNNER)
  if (process.env.E2E_SHOW) console.log(recallResults.map((r) => `---- ${r.kind}\n${r.out.slice(0, 1500)}`).join('\n'))

  check('跑完没报错', result.out.includes('RUNNER_DONE'), `${result.out.slice(-300)} ${result.err.slice(-500)}`)
  const compact = JSON.parse(result.out.split('\n').find((l) => l.startsWith('COMPACT_RESULT '))?.slice(15) ?? '{}')
  check('压缩成功', compact.ok === true, JSON.stringify(compact))

  const overview = recallResults.find((r) => r.kind === 'overview')
  check('1. 取回了一览', !!overview)
  if (overview) {
    check('1. 一览里写文件的入参只露开头（看不到结尾标记）', !overview.out.includes('TAIL_MARKER_ZZZ'))
    check('1. 一览写明了入参总长', overview.out.includes(`[Args total ${JSON.stringify(WRITE_ARGS).length} chars]`))
    check('1. 一览写明了取全文的办法', /message_index: \d+/.test(overview.out))
  }

  const pages = recallResults.filter((r) => r.kind === 'page')
  check('2. 按一览给的办法取到了单条', pages.length >= 1)
  check('3. 比一页长的文件分了不止一页', pages.length >= 2, String(pages.length))
  const joined = pages.map((p) => /### \d+\. [^\n]*\n([\s\S]*?)\n\.\.\. \[chars \d+–\d+ of \d+\]/.exec(p.out)?.[1] ?? '').join('')
  check('3. 最后一页带着结尾标记', pages.at(-1)?.out.includes('TAIL_MARKER_ZZZ') === true)
  if (process.env.E2E_SHOW && joined !== EXPECTED) { let k = 0; while (joined[k] === EXPECTED[k]) k++; console.log(`首个差异 @${k}: ${JSON.stringify(joined.slice(k - 20, k + 30))} vs ${JSON.stringify(EXPECTED.slice(k - 20, k + 30))}`) }
  check('3. 页与页拼起来和当时写下的入参逐字相同', joined === EXPECTED, `joined=${joined.length} expected=${EXPECTED.length}`)

  const other = recallResults.find((r) => r.kind === 'other')
  check('4. 序号越界：报错并说明条数', !!other && /共 \d+ 条/.test(other.out), other?.out.slice(0, 200))
} finally {
  await llm.close()
}

if (!process.env.E2E_KEEP) for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
if (failures.length) {
  console.error(`\n${failures.length} 项没过：`)
  for (const f of failures) console.error(`  - ${f.slice(0, 400)}`)
  process.exit(1)
}
console.log('\n全部通过')
