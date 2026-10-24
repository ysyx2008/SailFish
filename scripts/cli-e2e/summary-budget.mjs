/**
 * 交接小结的篇幅跟窗口走、被截断时接着写、触发时机跟着变——真进程端到端：
 * 真起命令行 / 后端进程、真走压缩、真写盘，模型换成脚本化的假模型
 * （它回什么、报多少用量、停在哪、报不报错由脚本定）。
 *
 *   node scripts/cli-e2e/summary-budget.mjs        # 全跑
 *   node scripts/cli-e2e/summary-budget.mjs 4 5    # 只跑编号 4、5
 *   E2E_SHOW=1 …                                   # 把压缩相关日志打出来（E2E_ALL=1 全打）
 *   E2E_KEEP=1 …                                   # 跑完保留临时目录
 *
 * 1. 默认窗口：写小结的请求额度在下限与上界之间，提示词字数与额度同比例，小结进了对话
 * 2. 小结停在输出额度上：补写一次，两段拼成整份；补写请求在原请求后面带着已写出的半截
 * 3. 补写之后仍停在额度上：不再追问，用已写出的部分，流程照常结束
 * 4. 窗口大小：额度随窗口单调变大，小窗口不低于下限，超大窗口封顶
 * 5. 触发时机：预留跟着小结额度走——在预留之上不压，在预留之下压（128K 与 1M 两种窗口）
 * 6. 人点名压缩：同一套小结；补充说明写进指令；压完接着说，小结在对话里
 * 7. 模型先去调工具：禁用工具重试，补写沿用同样的禁用
 * 8. 写小结时接口报错：退回固定模板，压缩照常完成，不卡住
 * 9. 一场里连压多次：每次额度合规，后一次的对话里带着前一次的小结
 * 10. 压完重开：新进程接着时，小结还在、原文没整段灌回来
 */
import fs from 'node:fs'
import path from 'node:path'
import { callTool, fail, say, startMockLlm } from './mock-llm.mjs'
import { ROOT, makeChecker, runPlain, sandbox } from './harness.mjs'

const { failures, check } = makeChecker()
const tempDirs = []
const scenarios = []
const scenario = (name, run) => scenarios.push({ name, run })

const COMPACT_RUNNER = path.join(ROOT, 'scripts/cli-e2e/compact-runner.cjs')
const RESUME_RUNNER = path.join(ROOT, 'scripts/cli-e2e/resume-runner.cjs')

const SUMMARY_MARK = '这份小结一次最多输出'
const CONTINUE_MARK = '写到输出上限处被截断了'
const ARCHIVE_MARK = '早期对话已压缩'
const TEMPLATE_MARK = '【系统主动压缩】'
const SIDE_MARKS = ['这一步只更新记忆', '生成侧栏会话短标题']

const MIN_TOKENS = 2048
const CEILING_TOKENS = 16384
const OVERHEAD = 2000
const SAFETY = 1024

const textOf = (message) => (typeof message?.content === 'string' ? message.content : JSON.stringify(message?.content ?? ''))
const requestText = (entry) => JSON.stringify(entry.body.messages)
const inputLimitOf = (contextLength) => contextLength - Math.min(32_768, Math.floor(contextLength / 4)) - SAFETY

/** 记在文件正中间：原文整段在不在，看这一句 */
const bodyMarker = (name) => `BODY_${name}_MIDDLE`
const bodyText = (name) => {
  const line = `${name}-行 内容内容内容内容内容内容内容内容内容内容内容内容\n`
  return `${line.repeat(200)}${bodyMarker(name)}\n${line.repeat(200)}`
}

const kindOf = (entry) => {
  if (entry.lastText.includes(SUMMARY_MARK)) return 'summary'
  if (entry.lastText.includes(CONTINUE_MARK)) return 'continue'
  if (SIDE_MARKS.some((m) => entry.lastText.includes(m))) return 'side'
  return 'main'
}

/**
 * 假模型：
 * - 话里「读X」就读文件 X，工具回来后默认回一句；
 * - 写小结 / 补写的请求按 state.replies 依次回；
 * - state.mainUsage(n)：第 n 个主干请求报多少真实用量（默认第 1 个报 NEAR_FULL）。
 */
async function setup(prefix, { nearFull = 90_000, afterTool } = {}) {
  const env = sandbox(0, prefix, tempDirs)
  for (const name of ['A', 'B', 'C', 'D']) fs.writeFileSync(path.join(env.cwd, `${name}.txt`), bodyText(name))
  const state = {
    replies: [],
    mainCount: 0,
    mainUsage: (n) => (n === 1 ? nearFull : undefined),
  }
  const llm = await startMockLlm({
    jsonForNonStream: true,
    onUser: (text, _n, entry) => {
      const kind = kindOf(entry)
      if (kind === 'summary') return state.replies.shift() ?? say('默认小结')
      if (kind === 'continue') return state.replies.shift() ?? say('默认补写')
      if (kind === 'side') return say('好')
      // 压缩之后系统补一条提示接着往下走：照常按「工具回来之后」的脚本继续
      if (text.includes('系统已主动压缩')) return afterTool ? afterTool(null, entry, state) : say('读完了')
      const m = text.match(/读([ABCD])/)
      if (m) return callTool('read_file', { path: path.join(env.cwd, `${m[1]}.txt`) })
      return say('好的')
    },
    afterTool: (last, entry) => (afterTool ? afterTool(last, entry, state) : say('读完了')),
    usage: (entry) => {
      if (kindOf(entry) !== 'main') return undefined
      const reported = state.mainUsage(++state.mainCount)
      return reported === undefined ? undefined : { prompt_tokens: reported, completion_tokens: 50 }
    },
  })
  env.env.SFT_API_URL = `http://127.0.0.1:${llm.port}/v1`
  return { env, llm, state }
}

const show = (result) => {
  if (!process.env.E2E_SHOW) return
  const pattern = process.env.E2E_ALL ? /./ : /ompress|ompaction|cut at|continu/
  console.log(`${result.out}\n${result.err}`.split('\n').filter((l) => pattern.test(l)).map((l) => `    | ${l}`).join('\n'))
}

/** 命令行跑一轮（默认窗口 128000） */
async function runCli(env, line = '读A文件') {
  const result = await runPlain([line, '--free'], env, 180_000)
  show(result)
  return result
}

/** 后端进程按脚本跑：可指定窗口大小，可「人点名压缩」 */
async function runSteps(env, steps, { contextLength, maxOutputTokens } = {}) {
  const result = await runPlain([], {
    ...env,
    env: {
      ...env.env,
      STEPS: JSON.stringify(steps),
      ...(contextLength ? { CONTEXT_LENGTH: String(contextLength) } : {}),
      ...(maxOutputTokens ? { MAX_OUTPUT_TOKENS: String(maxOutputTokens) } : {}),
    },
  }, 180_000, COMPACT_RUNNER)
  show(result)
  const compactResults = result.out.split('\n').filter((l) => l.startsWith('COMPACT_RESULT ')).map((l) => JSON.parse(l.slice(15)))
  return { ...result, done: result.out.includes('RUNNER_DONE'), compactResults }
}

const mains = (llm) => llm.mainRequests()
const ofKind = (llm, kind) => mains(llm).filter((r) => kindOf(r) === kind)
const summaryRequests = (llm) => ofKind(llm, 'summary')
const continueRequests = (llm) => ofKind(llm, 'continue')
const charsOf = (entry) => Number(textOf(entry.body.messages.at(-1)).match(/最多输出 (\d+) 字/)?.[1])
const firstArchived = (llm, needle) => mains(llm).find((r) => kindOf(r) === 'main' && requestText(r).includes(ARCHIVE_MARK) && (!needle || requestText(r).includes(needle)))

/** 写小结的请求是否合规：额度在下限与上界之间（给定窗口时再加极小窗口的整窗 1/8 上限），字数与额度同比例 */
function checkSummaryRequest(label, entry, contextLength = 128_000) {
  const maxTokens = entry.body.max_tokens
  const floor = Math.min(MIN_TOKENS, Math.floor(contextLength / 8))
  check(`${label}：额度不低于下限`, maxTokens >= floor, String(maxTokens))
  check(`${label}：额度不超过上界`, maxTokens <= CEILING_TOKENS, String(maxTokens))
  const chars = charsOf(entry)
  check(`${label}：提示词字数不超过额度，且与额度同比例`,
    chars > 0 && chars <= maxTokens && chars === Math.min(maxTokens, Math.max(100, Math.floor((maxTokens * 0.98) / 100) * 100)),
    `chars=${chars} max_tokens=${maxTokens}`)
  return maxTokens
}

// ───────────────────────────────────────────────────────────── 1
scenario('默认窗口：写小结的请求额度合规，提示词字数与额度同比例，小结进了对话', async () => {
  const { env, llm, state } = await setup('sft-summary-1')
  try {
    state.replies = [say('SUMMARY_BODY 小结正文')]
    const result = await runCli(env)
    check('正常结束', result.code === 0, `exit ${result.code} ${result.err.slice(0, 300)}`)
    const reqs = summaryRequests(llm)
    check('发出了一次写小结的请求', reqs.length === 1, String(reqs.length))
    if (!reqs.length) return
    const maxTokens = checkSummaryRequest('默认窗口', reqs[0])
    check('128K 窗口比下限宽：小结可以写得比以前长', maxTokens > MIN_TOKENS, String(maxTokens))
    check('没有发补写请求', continueRequests(llm).length === 0)
    check('小结进了之后的对话', !!firstArchived(llm, 'SUMMARY_BODY 小结正文'))
    check('写小结的请求带着工具清单（前缀不变，吃得到缓存）', Array.isArray(reqs[0].body.tools) && reqs[0].body.tools.length > 0)
    check('写小结的请求不禁用工具调用', reqs[0].body.tool_choice !== 'none', String(reqs[0].body.tool_choice))
  } finally { await llm.close() }
})

// ───────────────────────────────────────────────────────────── 2
scenario('小结停在输出额度上：补写一次，两段拼成整份', async () => {
  const { env, llm, state } = await setup('sft-summary-2')
  try {
    state.replies = [say('PART_ONE 前半段，', 'length'), say('PART_TWO 后半段。')]
    const result = await runCli(env)
    check('正常结束', result.code === 0, `exit ${result.code} ${result.err.slice(0, 300)}`)
    check('写小结 1 次、补写 1 次', summaryRequests(llm).length === 1 && continueRequests(llm).length === 1, `${summaryRequests(llm).length}/${continueRequests(llm).length}`)
    const cont = continueRequests(llm)[0]
    if (cont) {
      const msgs = cont.body.messages
      check('补写请求 = 原请求 + 已写出的半截 + 接着写的指令',
        textOf(msgs.at(-2)).includes('PART_ONE') && msgs.at(-2).role === 'assistant' && msgs.at(-1).role === 'user')
      check('补写请求前面仍是写小结的那条指令（前缀不变）', textOf(msgs.at(-3)).includes(SUMMARY_MARK))
      check('补写请求同样限制输出额度', cont.body.max_tokens === summaryRequests(llm)[0].body.max_tokens, String(cont.body.max_tokens))
      check('补写请求不禁用工具调用（与首次一致）', cont.body.tool_choice !== 'none')
    }
    check('进对话的是拼好的整份', !!firstArchived(llm, 'PART_ONE 前半段，PART_TWO 后半段。'))
    check('没有把半截小结单独当成完整的用', !mains(llm).some((r) => kindOf(r) === 'main' && requestText(r).includes('PART_ONE 前半段，"') ))
  } finally { await llm.close() }
})

// ───────────────────────────────────────────────────────────── 3
scenario('补写之后仍停在额度上：不再追问，用已写出的部分，流程照常结束', async () => {
  const { env, llm, state } = await setup('sft-summary-3')
  try {
    state.replies = [say('CUT_ONE ', 'length'), say('CUT_TWO', 'length'), say('不该被问到的第三次')]
    const result = await runCli(env)
    check('正常结束', result.code === 0, `exit ${result.code} ${result.err.slice(0, 300)}`)
    check('只补写了一次，没有第三次追问', summaryRequests(llm).length === 1 && continueRequests(llm).length === 1, `${summaryRequests(llm).length}/${continueRequests(llm).length}`)
    check('用了已写出的两段', !!firstArchived(llm, 'CUT_ONE CUT_TWO'))
    check('不该被问到的第三次没有出现在对话里', !mains(llm).some((r) => requestText(r).includes('不该被问到的第三次')))
  } finally { await llm.close() }
})

// ───────────────────────────────────────────────────────────── 4
scenario('窗口大小：额度随窗口变大，小窗口不低于下限，超大窗口封顶', async () => {
  const windows = [64_000, 128_000, 256_000, 1_000_000]
  const tokens = {}
  for (const contextLength of windows) {
    const inputLimit = inputLimitOf(contextLength)
    const { env, llm, state } = await setup(`sft-summary-4-${contextLength / 1000}k`, { nearFull: inputLimit - 1_500 })
    try {
      state.replies = [say(`SUMMARY_${contextLength}`)]
      const result = await runSteps(env, [{ say: '读A文件' }], { contextLength })
      check(`${contextLength / 1000}K：正常结束`, result.done, `${result.out.slice(-200)} ${result.err.slice(-400)}`)
      const reqs = summaryRequests(llm)
      check(`${contextLength / 1000}K：压缩时发出了写小结的请求`, reqs.length === 1, String(reqs.length))
      if (!reqs.length) continue
      tokens[contextLength] = checkSummaryRequest(`${contextLength / 1000}K`, reqs[0], contextLength)
      check(`${contextLength / 1000}K：小结进了对话`, !!firstArchived(llm, `SUMMARY_${contextLength}`))
    } finally { await llm.close() }
  }
  const seq = windows.map((w) => tokens[w])
  console.log(`  各窗口的小结输出额度（token）：${windows.map((w) => `${w / 1000}K=${tokens[w]}`).join('  ')}`)
  check('额度随窗口单调不减', seq.every((v, i) => v !== undefined && (i === 0 || v >= seq[i - 1])), JSON.stringify(seq))
  check('64K 窗口不低于下限', tokens[64_000] >= MIN_TOKENS, String(tokens[64_000]))
  check('128K 窗口比 64K 宽', tokens[128_000] > tokens[64_000], JSON.stringify(seq))
  check('1M 窗口封顶在上界', tokens[1_000_000] === CEILING_TOKENS, String(tokens[1_000_000]))
})

// ───────────────────────────────────────────────────────────── 5
scenario('触发时机：预留跟着小结额度走——在预留之上不压，在预留之下压', async () => {
  for (const contextLength of [128_000, 1_000_000]) {
    const inputLimit = inputLimitOf(contextLength)
    const k = `${contextLength / 1000}K`
    // 先压一次，从写小结的请求读出这个窗口下的额度，反推预留
    const probe = await setup(`sft-summary-5-${k}-probe`, { nearFull: inputLimit - 1_000 })
    let reserve
    let toolTokens
    try {
      await runSteps(probe.env, [{ say: '读A文件' }], { contextLength })
      const reqs = summaryRequests(probe.llm)
      check(`${k}：探测那次压了`, reqs.length === 1, String(reqs.length))
      if (!reqs.length) continue
      reserve = reqs[0].body.max_tokens + OVERHEAD
      // 判断「剩多少」时含刚回来的工具结果：从写小结的请求里量出它有多大（UTF-8 字节 / 4）
      const toolMsg = reqs[0].body.messages.find((m) => m.role === 'tool')
      toolTokens = Math.ceil(Buffer.byteLength(textOf(toolMsg)) / 4)
    } finally { await probe.llm.close() }

    // 剩余比预留多一截：不压
    const above = await setup(`sft-summary-5-${k}-above`, { nearFull: inputLimit - (reserve + toolTokens + 2_500) })
    try {
      const r = await runSteps(above.env, [{ say: '读A文件' }], { contextLength })
      check(`${k}：（含新工具结果）剩余比预留多 2.5K → 正常结束`, r.done, r.err.slice(-300))
      check(`${k}：（含新工具结果）剩余比预留多 2.5K → 没有写小结`, summaryRequests(above.llm).length === 0, String(summaryRequests(above.llm).length))
    } finally { await above.llm.close() }

    // 剩余比预留少一截：压
    const below = await setup(`sft-summary-5-${k}-below`, { nearFull: inputLimit - (reserve + toolTokens - 1_500) })
    try {
      const r = await runSteps(below.env, [{ say: '读A文件' }], { contextLength })
      check(`${k}：（含新工具结果）剩余比预留少 1.5K → 正常结束`, r.done, r.err.slice(-300))
      check(`${k}：（含新工具结果）剩余比预留少 1.5K → 写了小结`, summaryRequests(below.llm).length === 1, String(summaryRequests(below.llm).length))
    } finally { await below.llm.close() }
  }
})

// ───────────────────────────────────────────────────────────── 6
scenario('人点名压缩：同一套小结；补充说明写进指令；压完接着说，小结在对话里', async () => {
  const { env, llm, state } = await setup('sft-summary-6', { nearFull: 20_000 })
  try {
    state.mainUsage = () => 20_000
    state.replies = [say('USER_COMPACT_SUMMARY 小结正文')]
    const hint = '重点留下部署步骤'
    const result = await runSteps(env, [{ say: '读A文件' }, { compact: true, hint }, { say: '接着聊聊' }])
    check('正常结束', result.done, `${result.out.slice(-200)} ${result.err.slice(-400)}`)
    check('压缩成功', result.compactResults[0]?.ok === true, JSON.stringify(result.compactResults))
    const reqs = summaryRequests(llm)
    check('写小结 1 次', reqs.length === 1, String(reqs.length))
    if (!reqs.length) return
    checkSummaryRequest('人点名压缩', reqs[0])
    check('人写的补充说明进了指令', textOf(reqs[0].body.messages.at(-1)).includes(hint))
    const after = mains(llm).filter((r) => kindOf(r) === 'main').at(-1)
    check('压完接着说：请求里有小结', !!after && requestText(after).includes('USER_COMPACT_SUMMARY 小结正文'))
    check('压完接着说：读文件的原文没有整段带回', !!after && !requestText(after).includes(bodyMarker('A')))
  } finally { await llm.close() }
})

// ───────────────────────────────────────────────────────────── 7
scenario('模型先去调工具：禁用工具重试，补写沿用同样的禁用', async () => {
  const { env, llm, state } = await setup('sft-summary-7', { nearFull: 20_000 })
  try {
    state.mainUsage = () => 20_000
    state.replies = [
      callTool('read_file', { path: path.join(env.cwd, 'B.txt') }),
      say('TOOLS_P1 前半，', 'length'),
      say('TOOLS_P2 后半。'),
    ]
    const result = await runSteps(env, [{ say: '读A文件' }, { compact: true }, { say: '接着聊聊' }])
    check('正常结束', result.done, `${result.out.slice(-200)} ${result.err.slice(-400)}`)
    const sums = summaryRequests(llm)
    check('写小结先后问了两次（第二次是禁用工具的重试）', sums.length === 2, String(sums.length))
    if (sums.length === 2) {
      check('第一次不禁用工具调用', sums[0].body.tool_choice !== 'none', String(sums[0].body.tool_choice))
      check('重试禁用了工具调用', sums[1].body.tool_choice === 'none', String(sums[1].body.tool_choice))
    }
    const cont = continueRequests(llm)
    check('被截断后补写了一次', cont.length === 1, String(cont.length))
    if (cont.length) check('补写沿用禁用工具调用', cont[0].body.tool_choice === 'none', String(cont[0].body.tool_choice))
    const after = mains(llm).filter((r) => kindOf(r) === 'main').at(-1)
    check('进对话的是拼好的整份', !!after && requestText(after).includes('TOOLS_P1 前半，TOOLS_P2 后半。'))
  } finally { await llm.close() }
})

// ───────────────────────────────────────────────────────────── 8
scenario('写小结时接口报错：退回固定模板，压缩照常完成，不卡住', async () => {
  const { env, llm, state } = await setup('sft-summary-8')
  try {
    state.replies = [fail('summary backend down')]
    const result = await runCli(env)
    check('正常结束（不因小结失败而失败）', result.code === 0, `exit ${result.code} ${result.err.slice(0, 300)}`)
    check('写过小结的请求', summaryRequests(llm).length >= 1, String(summaryRequests(llm).length))
    check('没有进补写', continueRequests(llm).length === 0)
    check('压缩照常完成，对话里是固定模板', !!firstArchived(llm, TEMPLATE_MARK))
    check('任务最后照常收尾', result.out.includes('读完了'), result.out.slice(-200))
  } finally { await llm.close() }
})

// ───────────────────────────────────────────────────────────── 9
scenario('一场里连压多次：每次额度合规，后一次的对话里带着前一次的小结', async () => {
  // 读完 A 之后依次再读 B、C、D（压缩会把前面读到的收走，所以按次数数，不看对话里还剩什么）
  let reads = 0
  let cwd
  const { env, llm, state } = await setup('sft-summary-9', {
    afterTool: () => {
      const next = ['B', 'C', 'D'][reads++]
      return next ? callTool('read_file', { path: path.join(cwd, `${next}.txt`) }) : say('全读完了')
    },
  })
  cwd = env.cwd
  try {
    // 每个主干请求都报「快满了」
    state.mainUsage = () => 90_000
    state.replies = [say('ROUND_ONE_SUMMARY'), say('ROUND_TWO_SUMMARY'), say('ROUND_THREE_SUMMARY'), say('ROUND_FOUR_SUMMARY')]
    const result = await runCli(env)
    check('正常结束', result.code === 0, `exit ${result.code} ${result.err.slice(0, 300)}`)
    const sums = summaryRequests(llm)
    console.log(`  这一场压了 ${sums.length} 次`)
    check('一场里压了不止一次', sums.length >= 2, String(sums.length))
    sums.forEach((req, i) => checkSummaryRequest(`第 ${i + 1} 次`, req))
    if (sums.length >= 2) {
      check('第二次写小结时，对话里带着第一次的小结', requestText(sums[1]).includes('ROUND_ONE_SUMMARY'))
    }
    check('最终收尾', result.out.includes('全读完了'), result.out.slice(-200))
  } finally { await llm.close() }
})

// ───────────────────────────────────────────────────────────── 10
scenario('压完重开：新进程接着时，小结还在、原文没整段灌回来', async () => {
  const { env, llm, state } = await setup('sft-summary-10')
  try {
    state.replies = [say('REOPEN_SUMMARY 重开也要在')]
    const first = await runCli(env)
    check('第一轮正常结束', first.code === 0, `exit ${first.code} ${first.err.slice(0, 300)}`)
    check('第一轮压过', !!firstArchived(llm, 'REOPEN_SUMMARY 重开也要在'))

    const root = path.join(env.dataDir, 'history', 'agent')
    const sessions = []
    for (const date of fs.existsSync(root) ? fs.readdirSync(root) : []) {
      for (const id of fs.readdirSync(path.join(root, date))) {
        if (fs.existsSync(path.join(root, date, id, 'meta.json'))) sessions.push(id)
      }
    }
    check('盘上有这场会话', sessions.length === 1, String(sessions.length))
    if (sessions.length !== 1) return

    state.mainCount = 0
    state.mainUsage = () => 20_000
    const before = mains(llm).length
    const r = await runPlain([], {
      ...env,
      env: { ...env.env, RESUME_SESSION: sessions[0], RESUME_LINE: '随便聊聊' },
    }, 120_000, RESUME_RUNNER)
    show(r)
    check('重开后正常结束', r.out.includes('RESUME_DONE'), `${r.out.slice(-200)} ${r.err.slice(-400)}`)
    const resumed = mains(llm).slice(before).find((x) => kindOf(x) === 'main')
    check('重开后的第一个请求里有小结', !!resumed && requestText(resumed).includes('REOPEN_SUMMARY 重开也要在'))
    check('重开后读文件的原文没有整段灌回来', !!resumed && !requestText(resumed).includes(bodyMarker('A')))
    check('重开后请求以这一句收尾', !!resumed && resumed.lastText.includes('随便聊聊'), resumed?.lastText.slice(0, 120))
    check('重开后没有再压一次', summaryRequests(llm).length === 1, String(summaryRequests(llm).length))
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
