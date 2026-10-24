/**
 * 交接小结的篇幅跟窗口走、被截断时接着写——真进程端到端：
 * 真起命令行进程、真走压缩，模型换成脚本化的假模型（它回什么、报多少用量、停在哪由脚本定）。
 *
 *   node scripts/cli-e2e/summary-budget.mjs        # 全跑
 *   node scripts/cli-e2e/summary-budget.mjs 2      # 只跑编号 2
 *   E2E_SHOW=1 …                                   # 把压缩相关日志打出来
 *
 * 1. 触发压缩之后，写小结的那次请求：输出额度落在下限与上界之间，提示词里写的字数与额度一致；小结进了对话
 * 2. 小结停在输出额度上：补写一次，两段拼成完整小结；补写请求在原请求后面带着已写出的半截
 * 3. 补写之后仍停在额度上：不再追问，用已写出的部分，流程照常结束
 */
import fs from 'node:fs'
import path from 'node:path'
import { callTool, say, startMockLlm } from './mock-llm.mjs'
import { makeChecker, runPlain, sandbox } from './harness.mjs'

const { failures, check } = makeChecker()
const tempDirs = []
const scenarios = []
const scenario = (name, run) => scenarios.push({ name, run })

/** 默认窗口 128000：输入上限约 95000。报 90000 → 剩下的不够写小结，发下一次请求前就会压 */
const NEAR_FULL = 90_000
const SUMMARY_MARK = '这份小结一次最多输出'
const CONTINUE_MARK = '写到输出上限处被截断了'
const ARCHIVE_MARK = '早期对话已压缩'

const textOf = (message) => (typeof message?.content === 'string' ? message.content : JSON.stringify(message?.content ?? ''))
const requestText = (entry) => JSON.stringify(entry.body.messages)

async function setup(prefix) {
  const env = sandbox(0, prefix, tempDirs)
  fs.writeFileSync(path.join(env.cwd, 'A.txt'), `${'内容内容内容内容内容内容内容内容内容内容内容内容\n'.repeat(400)}`)
  const state = { replies: [] }
  let requestCount = 0
  const llm = await startMockLlm({
    onUser: (text) => {
      if (text.includes(SUMMARY_MARK)) return state.replies.shift() ?? say('默认小结')
      if (text.includes(CONTINUE_MARK)) return state.replies.shift() ?? say('默认补写')
      return callTool('read_file', { path: path.join(env.cwd, 'A.txt') })
    },
    afterTool: () => say('读完了'),
    // 第一次请求报「快满了」；其余走默认用量
    usage: () => (++requestCount === 1 ? { prompt_tokens: NEAR_FULL, completion_tokens: 50 } : undefined),
  })
  env.env.SFT_API_URL = `http://127.0.0.1:${llm.port}/v1`
  return { env, llm, state }
}

/** 一轮：读文件；第一次请求报「快满了」→ 下一次请求前压缩 */
async function runOnce(env) {
  const result = await runPlain(['读A文件', '--free'], env, 120_000)
  if (process.env.E2E_SHOW) {
    console.log(`${result.out}\n${result.err}`.split('\n').filter((l) => (process.env.E2E_ALL ? /./ : /ompress|ompaction|cut at/).test(l)).map((l) => `    | ${l}`).join('\n'))
  }
  return result
}

const mains = (llm) => llm.mainRequests()
const summaryRequests = (llm) => mains(llm).filter((r) => r.lastText.includes(SUMMARY_MARK))
const continueRequests = (llm) => mains(llm).filter((r) => r.lastText.includes(CONTINUE_MARK))

// ───────────────────────────────────────────────────────────── 1
scenario('压缩时写小结的请求：额度在下限与上界之间，提示词字数与额度一致，小结进了对话', async () => {
  const { env, llm, state } = await setup('sft-summary-1')
  try {
    state.replies = [say('SUMMARY_BODY 小结正文')]
    const result = await runOnce(env)
    check('正常结束', result.code === 0, `exit ${result.code} ${result.err.slice(0, 300)}`)
    const reqs = summaryRequests(llm)
    check('发出了一次写小结的请求', reqs.length === 1, String(reqs.length))
    if (!reqs.length) return
    const maxTokens = reqs[0].body.max_tokens
    check('输出额度不低于 2048', maxTokens >= 2048, String(maxTokens))
    check('输出额度不超过 16384', maxTokens <= 16384, String(maxTokens))
    const chars = Number(textOf(reqs[0].body.messages.at(-1)).match(/最多输出 (\d+) 字/)?.[1])
    check('提示词里的字数 ≤ 额度，且与额度同一比例', chars > 0 && chars <= maxTokens && chars === Math.floor((maxTokens * 0.98) / 100) * 100, `chars=${chars} max_tokens=${maxTokens}`)
    check('没有发补写请求', continueRequests(llm).length === 0)
    const archived = mains(llm).find((r) => requestText(r).includes(ARCHIVE_MARK))
    check('小结进了之后的对话', !!archived && requestText(archived).includes('SUMMARY_BODY 小结正文'))
  } finally { await llm.close() }
})

// ───────────────────────────────────────────────────────────── 2
scenario('小结停在输出额度上：补写一次，两段拼成完整小结', async () => {
  const { env, llm, state } = await setup('sft-summary-2')
  try {
    state.replies = [say('PART_ONE 前半段，', 'length'), say('PART_TWO 后半段。')]
    const result = await runOnce(env)
    check('正常结束', result.code === 0, `exit ${result.code} ${result.err.slice(0, 300)}`)
    check('写小结 1 次、补写 1 次', summaryRequests(llm).length === 1 && continueRequests(llm).length === 1, `${summaryRequests(llm).length}/${continueRequests(llm).length}`)
    const cont = continueRequests(llm)[0]
    if (cont) {
      const msgs = cont.body.messages
      check('补写请求 = 原请求 + 已写出的半截 + 接着写的指令',
        textOf(msgs.at(-2)).includes('PART_ONE') && msgs.at(-2).role === 'assistant' && msgs.at(-1).role === 'user')
      check('补写请求前面仍是写小结的那条指令（前缀不变）', textOf(msgs.at(-3)).includes(SUMMARY_MARK))
    }
    const archived = mains(llm).find((r) => requestText(r).includes(ARCHIVE_MARK))
    check('进对话的是拼好的整份', !!archived && requestText(archived).includes('PART_ONE 前半段，PART_TWO 后半段。'))
  } finally { await llm.close() }
})

// ───────────────────────────────────────────────────────────── 3
scenario('补写后仍停在额度上：不再追问，用已写出的部分，流程照常结束', async () => {
  const { env, llm, state } = await setup('sft-summary-3')
  try {
    state.replies = [say('CUT_ONE ', 'length'), say('CUT_TWO', 'length')]
    const result = await runOnce(env)
    check('正常结束', result.code === 0, `exit ${result.code} ${result.err.slice(0, 300)}`)
    check('只补写了一次', summaryRequests(llm).length === 1 && continueRequests(llm).length === 1)
    const archived = mains(llm).find((r) => requestText(r).includes(ARCHIVE_MARK))
    check('用了已写出的两段', !!archived && requestText(archived).includes('CUT_ONE CUT_TWO'))
  } finally { await llm.close() }
})

// ─────────────────────────────────────────────────────────────
const only = process.argv.slice(2).map(Number).filter(Boolean)
for (const [index, item] of scenarios.entries()) {
  if (only.length && !only.includes(index + 1)) continue
  console.log(`\n▶ ${index + 1}. ${item.name}`)
  const started = Date.now()
  try {
    await item.run()
  } catch (error) {
    failures.push(`${item.name} — 脚本出错：${error?.stack || error}`)
    console.error(`  FAIL 脚本出错：${error?.stack || error}`)
  }
  console.log(`  （${((Date.now() - started) / 1000).toFixed(1)}s）`)
}

if (!process.env.E2E_KEEP) for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })

if (failures.length) {
  console.error(`\n${failures.length} 项没过：`)
  for (const f of failures) console.error(`  - ${f.slice(0, 400)}`)
  process.exit(1)
}
console.log('\n全部通过')
