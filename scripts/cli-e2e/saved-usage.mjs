/**
 * 重开旧会话时用「上次请求的真实用量」判断装不装得下——真进程端到端：
 * 真起命令行进程、真写盘、真杀进程，只是模型换成脚本化的假模型（它报多少真实用量由脚本定）。
 *
 *   node scripts/cli-e2e/saved-usage.mjs        # 全跑
 *   node scripts/cli-e2e/saved-usage.mjs 3      # 只跑编号 3
 *   E2E_KEEP=1 …                                # 跑完保留临时目录（看日志、落盘记录）
 *
 * 判断「这一次有没有采用记下的用量」看两样：新进程输出里的采用记录，和重开后发给模型的第一个请求长什么样。
 *
 * 1. 记下的用量说装不下：重开第一个请求就降级重装；说装得下：照常带原文（对照）
 * 2. 服务商不报用量 / 老记录没有这一项 / 盘上的值是坏的：不采用，照常工作，不报错
 * 3. 用量过期（后来又说了话、没报新用量）：位置对不上，不采用
 * 4. 进程被 kill -9：盘上的记录没坏，新进程接着同一场会话仍然采用
 * 5. 重开后新的用量会覆盖旧的：下一次重开按新的算
 * 6. 另开一场、各场互不串
 * 7. 本进程里先压缩过（用量大到发送前被压），再重开：请求完整、不报错
 */
import fs from 'node:fs'
import path from 'node:path'
import { callTool, hang, say, startMockLlm } from './mock-llm.mjs'
import { ROOT, makeChecker, runPlain, sandbox, startPlain, until } from './harness.mjs'

const RUNNER = path.join(ROOT, 'scripts/cli-e2e/resume-runner.cjs')
const { failures, check } = makeChecker()
const tempDirs = []
const scenarios = []
const scenario = (name, run) => scenarios.push({ name, run })

/** 默认窗口 128000 → 输入上限约 95000：这两个数一个远超、一个远低 */
const BIG = 120_000
const SMALL = 5_000

// ───────────────────────────────────────────────────────────── 盘上的记录

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return undefined } }

/** 主会话目录：[{ id, dir }] */
function mainSessions(dataDir) {
  const root = path.join(dataDir, 'history', 'agent')
  const found = []
  for (const date of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    const dateDir = path.join(root, date)
    if (!fs.statSync(dateDir).isDirectory()) continue
    for (const id of fs.readdirSync(dateDir)) {
      const dir = path.join(dateDir, id)
      if (fs.existsSync(path.join(dir, 'meta.json'))) found.push({ id, dir })
    }
  }
  return found
}

const metaOf = (session) => readJson(path.join(session.dir, 'meta.json'))
const writeMeta = (session, meta) => fs.writeFileSync(path.join(session.dir, 'meta.json'), JSON.stringify(meta))

// ───────────────────────────────────────────────────────────── 假模型

/** 记在文件正中间：降级重装只留头尾，中间这句在，就说明原文整段带回来了 */
const bodyMarker = (name) => `BODY_${name}_MIDDLE`
const bodyText = (name) => {
  const line = `${name}-行 内容内容内容内容内容内容内容内容内容内容内容内容内容内容内容内容\n`
  return `${line.repeat(120)}${bodyMarker(name)}\n${line.repeat(120)}`
}

/** 这一轮用户亲口说的那句（跳过系统代发的提醒），而不是历史里别的轮留下的话 */
const currentAsk = (entry) => {
  const users = (entry.body.messages ?? []).filter((m) => m.role === 'user')
  for (let i = users.length - 1; i >= 0; i--) {
    const text = typeof users[i].content === 'string' ? users[i].content : JSON.stringify(users[i].content)
    if (!text.startsWith('[系统]')) return text
  }
  return ''
}

/**
 * 话里「读X」就读文件 X；带「卡住」的读完文件后一直不回；其余直接回一句话。
 * 接口报多少真实用量由 state.report 定：数字、null（不报）、undefined（用默认）。
 */
async function startLlm(dir) {
  /** queue 里有数就先按顺序用（一次一个），用完再按 report */
  const state = { report: undefined, queue: [] }
  for (const name of ['A', 'B', 'C', 'D']) fs.writeFileSync(path.join(dir, `${name}.txt`), bodyText(name))
  const llm = await startMockLlm({
    onUser: (text) => {
      const m = text.match(/读([ABCD])/)
      if (m) return callTool('read_file', { path: path.join(dir, `${m[1]}.txt`) })
      return say('好的')
    },
    afterTool: (_last, entry) => (currentAsk(entry).includes('卡住') ? hang() : say('读完了')),
    usage: () => {
      if (state.queue.length) return { prompt_tokens: state.queue.shift(), completion_tokens: 50 }
      if (state.report === undefined) return undefined
      if (state.report === null) return null
      return { prompt_tokens: state.report, completion_tokens: 50 }
    },
  })
  return Object.assign(llm, { state })
}

/** 重开后发给模型的第一个主干请求：从第 from 个主干请求之后数 */
const firstMainAfter = (llm, from) => llm.mainRequests()[from]
const requestText = (entry) => (entry ? JSON.stringify(entry.body.messages) : '')

const cliRun = (env, line, timeoutMs = 90_000) => runPlain([line, '--free'], env, timeoutMs)
const resumeEnv = (env, llm, sessionId, line) => ({
  ...env,
  env: { ...env.env, SFT_API_URL: `http://127.0.0.1:${llm.port}/v1`, RESUME_SESSION: sessionId, RESUME_LINE: line },
})
const resume = (env, llm, sessionId, line, timeoutMs = 90_000) => runPlain([], resumeEnv(env, llm, sessionId, line), timeoutMs, RUNNER)

/** 开一场：第一轮用命令行说（读 A，报 firstReport），返回会话 */
async function openSession(env, llm, firstReport, line = '读A文件') {
  llm.state.report = firstReport
  const first = await cliRun(env, line)
  check('第一轮正常结束', first.code === 0, `exit ${first.code} ${first.err.slice(0, 300)}`)
  const sessions = mainSessions(env.dataDir)
  check('盘上有这场会话', sessions.length === 1, String(sessions.length))
  return sessions[0]
}

async function resumeOnce(env, llm, session, line, report) {
  llm.state.report = report
  const before = llm.mainRequests().length
  const result = await resume(env, llm, session.id, line)
  if (process.env.E2E_SHOW) console.log(`${result.out}\n${result.err}`.split('\n').filter((l) => process.env.E2E_ALL || /Cache|anchor|Cold|Compress|compress/.test(l)).map((l) => `    | ${l}`).join('\n'))
  check(`重开说「${line}」正常结束`, result.out.includes('RESUME_DONE'), `${result.out.slice(-200)} ${result.err.slice(-500)}`)
  return {
    first: firstMainAfter(llm, before),
    adopted: `${result.out}\n${result.err}`.includes('anchored on saved prompt usage'),
    result,
  }
}

// ───────────────────────────────────────────────────────────── 1
scenario('记下的用量说装不下：重开第一个请求就降级重装；说装得下：照常带原文', async () => {
  for (const [label, report, expectDegraded] of [['说装不下', BIG, true], ['说装得下（对照）', SMALL, false]]) {
    const env = sandbox(0, 'sft-savedusage-1', tempDirs)
    const llm = await startLlm(env.cwd)
    env.env.SFT_API_URL = `http://127.0.0.1:${llm.port}/v1`
    try {
      const session = await openSession(env, llm, SMALL)
      // 第二轮只说话（不读文件，免得本进程里就先压缩）：它最后一次请求的实报，就是之后记下的那个数
      await resumeOnce(env, llm, session, '随便聊聊', report)
      check(`${label}：盘上记下了这个数`, metaOf(session)?.lastPromptUsage?.promptTokens === report, JSON.stringify(metaOf(session)?.lastPromptUsage))

      const third = await resumeOnce(env, llm, session, '读C文件', SMALL)
      check(`${label}：重开采用了记下的用量`, third.adopted === true)
      const text = requestText(third.first)
      check(`${label}：请求以这一句收尾`, third.first?.lastText?.includes('读C文件'), third.first?.lastText?.slice(0, 120))
      if (expectDegraded) {
        check('降级重装：第一次读的文件原文没有整段带回', !text.includes(bodyMarker('A')), '原文还在')
      } else {
        check('照常带原文：第一次读的文件原文还在', text.includes(bodyMarker('A')), '原文不见了')
      }
      check('每件事的原话都在', text.includes('读A文件') && text.includes('随便聊聊'))
    } finally { await llm.close() }
  }
})

// ───────────────────────────────────────────────────────────── 2
scenario('服务商不报用量 / 老记录没有这一项 / 盘上的值是坏的：不采用，照常工作', async () => {
  const env = sandbox(0, 'sft-savedusage-2', tempDirs)
  const llm = await startLlm(env.cwd)
  env.env.SFT_API_URL = `http://127.0.0.1:${llm.port}/v1`
  try {
    const session = await openSession(env, llm, null)
    check('服务商没报用量：记录里没有这一项', metaOf(session)?.lastPromptUsage === undefined, JSON.stringify(metaOf(session)?.lastPromptUsage))
    const r1 = await resumeOnce(env, llm, session, '随便聊聊', null)
    check('没报用量：不采用，照常带原文', !r1.adopted && requestText(r1.first).includes(bodyMarker('A')))

    // 老记录：盘上本来就没有这一项（上面就是），换成「有但是坏的」各种样子
    const bads = [
      { promptTokens: 'x', messageCount: 3 },
      { promptTokens: -5, messageCount: 3 },
      { promptTokens: 9000, messageCount: 0 },
      { promptTokens: 9000, messageCount: 2.5 },
      { promptTokens: 9000 },
      'garbage',
      null,
    ]
    for (const bad of bads) {
      const meta = metaOf(session)
      writeMeta(session, { ...meta, lastPromptUsage: bad })
      const r = await resumeOnce(env, llm, session, '随便聊聊', null)
      check(`盘上的值是 ${JSON.stringify(bad)}：不采用、不报错、照常带原文`, !r.adopted && requestText(r.first).includes(bodyMarker('A')))
    }
  } finally { await llm.close() }
})

// ───────────────────────────────────────────────────────────── 3
scenario('用量过期：后来又说了话、没报新用量，位置对不上，不再采用', async () => {
  const env = sandbox(0, 'sft-savedusage-3', tempDirs)
  const llm = await startLlm(env.cwd)
  env.env.SFT_API_URL = `http://127.0.0.1:${llm.port}/v1`
  try {
    // 第一轮只聊天，实报 BIG：记下 {BIG, 2}
    const session = await openSession(env, llm, BIG, '随便聊聊')
    check('第一轮记下了', metaOf(session)?.lastPromptUsage?.promptTokens === BIG, JSON.stringify(metaOf(session)?.lastPromptUsage))
    const stale = metaOf(session).lastPromptUsage

    // 第二轮：采用 BIG，装不下 → 降级；这一轮服务商不报用量，记下的仍是旧的
    const r2 = await resumeOnce(env, llm, session, '随便聊聊', null)
    check('第二轮采用了记下的用量', r2.adopted)
    check('旧的用量原样留在盘上', JSON.stringify(metaOf(session)?.lastPromptUsage) === JSON.stringify(stale), JSON.stringify(metaOf(session)?.lastPromptUsage))

    // 第三轮：历史已经比记下用量时多了两轮，位置对不上
    const r3 = await resumeOnce(env, llm, session, '读C文件', null)
    check('第三轮：位置对不上，不采用', !r3.adopted)
    check('第三轮照常带原文（没有被旧用量误伤）', requestText(r3.first).includes('随便聊聊') && r3.first?.lastText?.includes('读C文件'))
  } finally { await llm.close() }
})

// ───────────────────────────────────────────────────────────── 4
scenario('进程被 kill -9（停在一轮中间）：记录没有坏，新进程接着说请求完整；这一次回到估算，下一次又用上', async () => {
  const env = sandbox(0, 'sft-savedusage-4', tempDirs)
  const llm = await startLlm(env.cwd)
  env.env.SFT_API_URL = `http://127.0.0.1:${llm.port}/v1`
  try {
    const session = await openSession(env, llm, SMALL)

    // 第二轮：读完文件之后模型不回（卡住），在这之前已经有一次请求报了较大的用量（不到上限，本进程里不压缩）
    llm.state.report = 70_000
    const before = llm.mainRequests().length
    const run = startPlain([], resumeEnv(env, llm, session.id, '读B文件然后卡住'), RUNNER)
    check('读完文件、第二次请求已经发出（正在等回复）', await until(() => llm.mainRequests().length >= before + 2, 60_000), String(llm.mainRequests().length - before))
    run.child.kill('SIGKILL')
    const exit = await run.done
    check('进程是被强杀的', exit.signal === 'SIGKILL', JSON.stringify({ code: exit.code, signal: exit.signal }))

    const meta = metaOf(session)
    check('强杀之后记录读得出来', !!meta && Number.isInteger(meta.messageCount), JSON.stringify(meta)?.slice(0, 200))
    const usage = meta?.lastPromptUsage
    check('盘上记下了被强杀前那次请求的实报', usage?.promptTokens === 70_000, JSON.stringify(usage))
    if (process.env.E2E_SHOW) {
      const rows = fs.readFileSync(path.join(session.dir, 'messages.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
      console.log(`    | 强杀后盘上 usage=${JSON.stringify(usage)} 消息=${rows.map((m, i) => `${i + 1}:${m.role}${m.tool_calls ? '(tc)' : ''}`).join(' ')}`)
    }

    // 新进程接着说：被打断的那一轮尾巴上会补一句「本轮没有留下交代」，位置和记下的对不上，
    // 这一次不采用（回到估算），但请求是完整的：读 B 的结果在，没有悬空的工具调用
    const r = await resumeOnce(env, llm, session, '随便聊聊', 70_000)
    const messages = r.first?.body?.messages ?? []
    const answered = new Set(messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id))
    check('请求里每个工具调用都有结果（没有悬空的）', messages.flatMap((m) => (m.tool_calls ?? []).map((t) => t.id)).every((id) => answered.has(id)))
    check('请求里有被打断那一轮读到的内容', requestText(r.first).includes(bodyMarker('B')))
    check('请求以这一句收尾', currentAsk(r.first).includes('随便聊聊'), currentAsk(r.first).slice(0, 120))
    check('被打断的尾巴对不上位置：这一次不采用，回到估算', !r.adopted)
    check('这一轮报了新的用量，盘上换成它', metaOf(session)?.lastPromptUsage?.promptTokens === 70_000 && metaOf(session)?.lastPromptUsage?.messageCount !== usage?.messageCount, JSON.stringify(metaOf(session)?.lastPromptUsage))

    // 再重开一次：这回记下的是完整一轮之后的，采用
    const again = await resumeOnce(env, llm, session, '读C文件', SMALL)
    check('下一次重开又用上了记下的用量', again.adopted)
    check('请求完整、以这一句收尾', currentAsk(again.first).includes('读C文件'))
  } finally { await llm.close() }
})

// ───────────────────────────────────────────────────────────── 5
scenario('新的用量覆盖旧的：下一次重开按新的算；重开后没发出请求就被杀，旧的仍在', async () => {
  const env = sandbox(0, 'sft-savedusage-5', tempDirs)
  const llm = await startLlm(env.cwd)
  env.env.SFT_API_URL = `http://127.0.0.1:${llm.port}/v1`
  try {
    const session = await openSession(env, llm, SMALL)
    await resumeOnce(env, llm, session, '读B文件', SMALL)
    // 这一轮报大数
    await resumeOnce(env, llm, session, '随便聊聊', BIG)
    check('盘上换成了新的大数', metaOf(session)?.lastPromptUsage?.promptTokens === BIG, JSON.stringify(metaOf(session)?.lastPromptUsage))

    // 重开后模型一直不回就被杀：没有新的用量，旧的仍在
    llm.state.report = SMALL
    const before = llm.mainRequests().length
    const hungLlm = llm
    const hungRun = startPlain([], resumeEnv(env, hungLlm, session.id, '读D文件然后卡住'), RUNNER)
    check('已经发出请求', await until(() => llm.mainRequests().length >= before + 2, 60_000))
    hungRun.child.kill('SIGKILL')
    await hungRun.done
    check('被杀后盘上的用量仍可读', Number.isFinite(metaOf(session)?.lastPromptUsage?.promptTokens), JSON.stringify(metaOf(session)?.lastPromptUsage))

    // 再来一次：这一轮报小数，覆盖掉
    const r = await resumeOnce(env, llm, session, '随便聊聊', SMALL)
    check('又重开了一次，正常结束', !!r.first)
    check('盘上换成新的小数', metaOf(session)?.lastPromptUsage?.promptTokens === SMALL, JSON.stringify(metaOf(session)?.lastPromptUsage))

    // 最后一次重开：旧的大数早就被覆盖，不该再降级
    const last = await resumeOnce(env, llm, session, '读C文件', SMALL)
    check('最后一次重开：照常带原文（没有被早先的大数误伤）', requestText(last.first).includes(bodyMarker('B')), '原文不见了')
  } finally { await llm.close() }
})

// ───────────────────────────────────────────────────────────── 6
scenario('另开一场、各场互不串：每场只认自己记下的用量', async () => {
  const env = sandbox(0, 'sft-savedusage-6', tempDirs)
  const llm = await startLlm(env.cwd)
  env.env.SFT_API_URL = `http://127.0.0.1:${llm.port}/v1`
  try {
    const a = await openSession(env, llm, BIG, '随便聊聊')
    llm.state.report = SMALL
    const second = await cliRun(env, '读B文件')
    check('另开一场正常结束', second.code === 0, second.err.slice(0, 300))
    const sessions = mainSessions(env.dataDir)
    check('盘上有两场', sessions.length === 2, String(sessions.length))
    const b = sessions.find((s) => s.id !== a.id)

    check('A 场记下的是大数', metaOf(a)?.lastPromptUsage?.promptTokens === BIG, JSON.stringify(metaOf(a)?.lastPromptUsage))
    check('B 场记下的是小数', metaOf(b)?.lastPromptUsage?.promptTokens === SMALL, JSON.stringify(metaOf(b)?.lastPromptUsage))

    const rb = await resumeOnce(env, llm, b, '随便聊聊', SMALL)
    check('重开 B：照常带原文，没有被 A 的大数误伤', requestText(rb.first).includes(bodyMarker('B')) && !requestText(rb.first).includes('随便聊聊') === false || requestText(rb.first).includes(bodyMarker('B')), requestText(rb.first).slice(0, 200))
    const ra = await resumeOnce(env, llm, a, '随便聊聊', SMALL)
    check('重开 A：采用自己记下的大数', ra.adopted)
  } finally { await llm.close() }
})

// ───────────────────────────────────────────────────────────── 7
scenario('本进程里先压缩过，再重开：请求完整、不报错；压缩前的用量不会留着误导', async () => {
  const env = sandbox(0, 'sft-savedusage-7', tempDirs)
  const llm = await startLlm(env.cwd)
  env.env.SFT_API_URL = `http://127.0.0.1:${llm.port}/v1`
  try {
    // 第一轮：读文件，第一次请求就报大数 → 发第二次请求前被压缩；压缩后第二次请求报小数
    llm.state.queue = [BIG, SMALL]
    const first = await cliRun(env, '读A文件')
    check('第一轮正常结束', first.code === 0, `exit ${first.code} ${first.err.slice(0, 300)}`)
    const session = mainSessions(env.dataDir)[0]
    const meta = metaOf(session)
    check('盘上记下的是压缩之后那次请求的用量，不是压缩前的大数',
      !!meta?.lastPromptUsage && meta.lastPromptUsage.promptTokens !== BIG, JSON.stringify(meta?.lastPromptUsage))
    check('这场做过压缩（带交接检查点）', Array.isArray(meta?.workingContext) && meta.workingContext.length > 0, `workingContext ${meta?.workingContext?.length}`)

    // 重开：直接接着压缩后的那份
    const r = await resumeOnce(env, llm, session, '随便聊聊', SMALL)
    const messages = r.first?.body?.messages ?? []
    const answered = new Set(messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id))
    check('请求里每个工具调用都有结果', messages.flatMap((m) => (m.tool_calls ?? []).map((t) => t.id)).every((id) => answered.has(id)))
    check('请求以这一句收尾', currentAsk(r.first).includes('随便聊聊'), currentAsk(r.first).slice(0, 120))
    check('接着压缩后的那份重开时，对得上位置、采用了记下的用量', r.adopted)

    // 再重开一次，仍正常
    const again = await resumeOnce(env, llm, session, '读C文件', SMALL)
    check('再重开一次请求完整', currentAsk(again.first).includes('读C文件'))
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
