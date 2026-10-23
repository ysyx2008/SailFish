/**
 * 伙计被打断后能接着干——真进程端到端：真起命令行进程、真写盘、真杀进程，只是模型换成脚本化的假模型。
 *
 *   node scripts/cli-e2e/sub-agent-persistence.mjs        # 全跑
 *   node scripts/cli-e2e/sub-agent-persistence.mjs 2      # 只跑编号 2
 *   E2E_SHOW=1 …                                          # 把终端里真实出现的内容打出来看
 *   E2E_KEEP=1 …                                          # 跑完保留临时目录（看日志、落盘记录）
 *
 * 1. 终端里按 Ctrl+C 停下，接着在同一场里让伙计接着干
 * 2. 命令行进程被 kill -9：盘上的记录没有坏，换一个新进程接着同一场会话把伙计叫起来
 * 3. 一次派一大批：记录量、耗时、日志里有没有警告
 */
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { callTool, hang, say, startMockLlm } from './mock-llm.mjs'
import { ROOT, Terminal, makeChecker, runPlain, sandbox, sleep, startPlain, until } from './harness.mjs'

const RUNNER = path.join(ROOT, 'scripts/cli-e2e/resume-runner.cjs')
const { failures, check } = makeChecker()
const tempDirs = []
const scenarios = []
const scenario = (name, run) => scenarios.push({ name, run })

// ───────────────────────────────────────────────────────────── 盘上的记录

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return undefined } }
const jsonlLines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [])

/** 伙计记录树：[{ sessionId, dir }]（只有一场会话时就一项） */
function childSessions(dataDir) {
  const root = path.join(dataDir, 'history', 'sub-agents')
  const found = []
  for (const date of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    for (const sessionId of fs.readdirSync(path.join(root, date))) {
      found.push({ date, sessionId, dir: path.join(root, date, sessionId) })
    }
  }
  return found
}

/** 一场会话下每位伙计的记录；顺带检查每个文件都读得出来 */
function readChildren(sessionDir) {
  const result = {}
  const broken = []
  for (const entry of fs.readdirSync(sessionDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === '_openings') continue
    const dir = path.join(sessionDir, entry.name)
    const state = readJson(path.join(dir, 'state.json'))
    if (!state) { broken.push(`${entry.name}/state.json`); continue }
    const meta = readJson(path.join(dir, 'meta.json'))
    if (fs.existsSync(path.join(dir, 'meta.json')) && !meta) broken.push(`${entry.name}/meta.json`)
    const messages = []
    for (const file of ['messages.jsonl', 'steps.jsonl']) {
      for (const line of jsonlLines(path.join(dir, file))) {
        try {
          const parsed = JSON.parse(line)
          if (file === 'messages.jsonl') messages.push(parsed)
        } catch { broken.push(`${entry.name}/${file}`) }
      }
    }
    result[state.name] = { dir, state, meta, messages }
  }
  return { children: result, broken }
}

function dirStats(dir) {
  let files = 0
  let bytes = 0
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name)
      if (entry.isDirectory()) walk(full)
      else { files++; bytes += fs.statSync(full).size }
    }
  }
  if (fs.existsSync(dir)) walk(dir)
  return { files, bytes }
}

/** 日志里和伙计存盘有关的警告 / 错误 */
function recordWarnings(dataDir) {
  const hits = []
  const walk = (d) => {
    for (const entry of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
      const full = path.join(d, entry.name)
      if (entry.isDirectory()) { if (entry.name !== 'history') walk(full) } else if (entry.name.endsWith('.log')) {
        for (const line of fs.readFileSync(full, 'utf8').split('\n')) {
          if (/(SubAgentRecords|Sub-agent (record|state)|Opening save failed)/.test(line) && /(warn|error)/i.test(line)) hits.push(line.slice(0, 300))
        }
      }
    }
  }
  walk(dataDir)
  return hits
}

const toolNames = (messages) => messages.flatMap((m) => (m.tool_calls ?? []).map((t) => t.function?.name))

// ───────────────────────────────────────────────────────────── 假模型

/**
 * 一个小团队：alice 先写文件再跑一条很慢的命令；bob 写文件就做完；carol 一开口模型就不回。
 * 被叫醒的人（话里带「上次的情形」）都说一句做完了。
 */
function crewLlm(dir, slow) {
  const seen = { aliceExec: false, bobDone: false, carolHung: false }
  const identify = (entry) => {
    const tools = (entry.body.tools ?? []).map((t) => t.function?.name)
    if (tools.includes('dispatch_agents')) return 'main'
    const all = JSON.stringify(entry.body.messages)
    return ['alice', 'bob', 'carol'].find((name) => all.includes(`我是${name}`)) ?? 'unknown'
  }
  const started = startMockLlm({
    onUser: (text, _n, entry) => {
      const who = identify(entry)
      entry.who = who
      if (who === 'alice') {
        return text.includes('[上次的情形]') ? say('alice：接着做完了') : callTool('write_text_file', { path: path.join(dir, 'a.txt'), content: 'a', mode: 'create' })
      }
      if (who === 'bob') return callTool('write_text_file', { path: path.join(dir, 'b.txt'), content: 'b', mode: 'create' })
      if (who === 'carol') {
        if (text.includes('[上次的情形]')) return say('carol：重新做完了')
        seen.carolHung = true
        return hang()
      }
      if (text.includes('[伙计')) return say('收到')
      if (text.includes('派三位')) {
        return callTool('dispatch_agents', {
          tasks: [
            { name: 'alice', description: '写文件再慢慢跑', prompt: '我是alice，写一份文件，然后跑一条很慢的命令' },
            { name: 'bob', description: '写一份文件', prompt: '我是bob，写一份文件就行' },
            { name: 'carol', description: '想很久', prompt: '我是carol，认真想一想再回答' },
          ],
        })
      }
      if (text.includes('让 alice')) return callTool('followup_agent', { name: 'alice', message: '接着做完' })
      return say('好')
    },
    afterTool: (last, entry) => {
      const who = identify(entry)
      entry.who = who
      const content = typeof last.content === 'string' ? last.content : ''
      if (who === 'main') {
        if (content.includes('已派出')) return say('已派出，等他们')
        if (content.includes('已向 alice')) return callTool('followup_agent', { name: 'carol', message: '接着做完' })
        if (content.includes('已向 carol')) return say('都交代了，等他们')
        return say('好')
      }
      if (who === 'alice') {
        const answered = entry.body.messages.filter((m) => m.role === 'tool').length
        if (answered === 1) {
          seen.aliceExec = true
          return callTool('exec', { command: `sleep ${slow}` })
        }
        return say('alice：做完了')
      }
      if (who === 'bob') {
        seen.bobDone = true
        return say('bob：做完了')
      }
      return say('好')
    },
  })
  return started.then((server) => Object.assign(server, { seen }))
}

/** 这一刻谁在说话由 onUser / afterTool 记进 entry.who */
const askedBy = (llm, name) => llm.requests.filter((r) => r.who === name)

const killStrays = (marker) => { try { execSync(`pkill -f '${marker}'`, { stdio: 'ignore' }) } catch { /* 没有残留 */ } }

// ───────────────────────────────────────────────────────────── 1
scenario('终端里按 Ctrl+C 停下，接着在同一场里让伙计接着干', async () => {
  const env = sandbox(0, 'sft-subpersist-1', tempDirs)
  const llm = await crewLlm(env.cwd, 61)
  env.env.SFT_API_URL = `http://127.0.0.1:${llm.port}/v1`
  const term = new Terminal(['派三位伙计去干活', '--free'], env)
  try {
    check('三位都开了工，alice 在跑慢命令、bob 做完、carol 在想',
      await until(() => llm.seen.aliceExec && llm.seen.bobDone && llm.seen.carolHung, 60_000),
      JSON.stringify(llm.seen))
    await sleep(1200)

    let mark = term.mark()
    term.interrupt()
    check('Ctrl+C：已停下', await term.waitFor('已停下。', { from: mark }), term.since(mark).slice(-400))
    await term.waitFor('›', { from: mark })

    // 盘上：每位的样子
    const sessions = childSessions(env.dataDir)
    check('伙计记录只有一场会话', sessions.length === 1, JSON.stringify(sessions.map((s) => s.sessionId)))
    const sessionDir = sessions[0].dir
    let state = { children: {}, broken: [] }
    await until(() => {
      state = readChildren(sessionDir)
      const c = state.children
      return c.alice?.state.error && c.carol?.state.error
    }, 15_000)
    const { children, broken } = state
    check('三位都记下了', Object.keys(children).sort().join() === 'alice,bob,carol', Object.keys(children).join())
    check('盘上的文件都读得出来', broken.length === 0, broken.join(', '))
    check('bob 做完了', children.bob?.state.status === 'completed', JSON.stringify(children.bob?.state))
    check('alice 被中断', children.alice?.state.status === 'interrupted', JSON.stringify(children.alice?.state))
    check('carol 被中断', children.carol?.state.status === 'interrupted', JSON.stringify(children.carol?.state))
    check('alice 的对话里有写文件和被打断的那条命令', toolNames(children.alice?.messages ?? []).join() === 'write_text_file,exec', toolNames(children.alice?.messages ?? []).join())
    check('carol 还没做完第一轮：记下的只有她的指令和被中止的一句，没有工具调用',
      toolNames(children.carol?.messages ?? []).length === 0 && String(children.carol?.messages?.[0]?.content).includes('我是carol'),
      JSON.stringify(children.carol?.messages))
    check('已经写出的文件还在', fs.existsSync(path.join(env.cwd, 'a.txt')) && fs.existsSync(path.join(env.cwd, 'b.txt')))
    const historyList = await runPlain(['history', 'list'], env)
    const rows = historyList.out.split('\n').filter((l) => l.includes('✓') || l.includes('✗'))
    check('历史列表里只有主会话这一条，伙计不在里面', rows.length === 1 && rows[0].includes('派三位伙计去干活'), historyList.out.slice(-400))

    // 同一场里接着说：让 alice、carol 接着干
    mark = term.mark()
    term.line('让 alice 和 carol 接着做完')
    check('两位都被叫醒、做完',
      await until(() => {
        const c = readChildren(sessionDir).children
        return c.alice?.state.status === 'completed' && c.carol?.state.status === 'completed'
      }, 60_000),
      JSON.stringify(Object.values(readChildren(sessionDir).children).map((c) => [c.state.name, c.state.status])))
    check('终端里收到了结果', await term.waitFor('收到', { from: mark, timeout: 30_000 }), term.since(mark).slice(-400))

    const aliceBack = askedBy(llm, 'alice').find((r) => r.lastText.includes('[上次的情形]'))
    const carolBack = askedBy(llm, 'carol').find((r) => r.lastText.includes('[上次的情形]'))
    check('alice 被叫醒时，请求里有她自己以前的对话',
      !!aliceBack && toolNames(aliceBack.body.messages).join() === 'write_text_file,exec',
      aliceBack ? toolNames(aliceBack.body.messages).join() : '没有收到请求')
    check('alice 开口前被告知上次被中断', !!aliceBack && aliceBack.lastText.includes('被中断') && aliceBack.lastText.includes('接着做完'), aliceBack?.lastText)
    check('每个工具调用在请求里都有结果（没有悬空的）', !!aliceBack && (() => {
      const answered = new Set(aliceBack.body.messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id))
      return aliceBack.body.messages.flatMap((m) => (m.tool_calls ?? []).map((t) => t.id)).every((id) => answered.has(id))
    })())
    check('carol 没有留下对话，从她的指令重新开始，并被告知上次的情形',
      !!carolBack && JSON.stringify(carolBack.body.messages).includes('我是carol，认真想一想') && carolBack.lastText.includes('被中断'),
      carolBack?.lastText)

    const after = readChildren(sessionDir)
    check('接着干之后 alice 的旧对话原样在前', (() => {
      const before = children.alice.messages
      const now = after.children.alice.messages
      return now.length > before.length && JSON.stringify(now.slice(0, before.length)) === JSON.stringify(before)
    })())
    check('盘上的文件接着干之后仍读得出来', after.broken.length === 0, after.broken.join(', '))
    const warnings = recordWarnings(env.dataDir)
    check('日志里没有存盘相关的警告', warnings.length === 0, warnings.slice(0, 3).join('\n'))
    term.line('exit')
  } finally {
    await term.close()
    await llm.close()
    killStrays('sleep 61')
  }
})

// ───────────────────────────────────────────────────────────── 2
scenario('命令行进程被 kill -9：盘上的记录没有坏，新进程接着同一场会话把伙计叫起来', async () => {
  const env = sandbox(0, 'sft-subpersist-2', tempDirs)
  const llm1 = await crewLlm(env.cwd, 62)
  env.env.SFT_API_URL = `http://127.0.0.1:${llm1.port}/v1`
  const first = startPlain(['派三位伙计去干活', '--free'], env)
  try {
    check('三位都开了工',
      await until(() => llm1.seen.aliceExec && llm1.seen.bobDone && llm1.seen.carolHung, 60_000),
      JSON.stringify(llm1.seen))
    await sleep(1200)
    first.child.kill('SIGKILL')
    const exit = await first.done
    check('进程是被强杀的', exit.signal === 'SIGKILL', JSON.stringify({ code: exit.code, signal: exit.signal }))
  } finally {
    await llm1.close()
    killStrays('sleep 62')
  }

  const sessions = childSessions(env.dataDir)
  check('盘上有这场会话的伙计记录', sessions.length === 1, JSON.stringify(sessions.map((s) => s.sessionId)))
  if (sessions.length !== 1) return
  const { sessionId, dir: sessionDir } = sessions[0]
  const { children, broken } = readChildren(sessionDir)
  check('强杀之后每个文件都读得出来', broken.length === 0, broken.join(', '))
  check('bob 做完了', children.bob?.state.status === 'completed', JSON.stringify(children.bob?.state))
  check('alice 盘上还写着「在干」（来不及收尾）', children.alice?.state.status === 'running', JSON.stringify(children.alice?.state))
  check('carol 盘上还写着「在干」', children.carol?.state.status === 'running', JSON.stringify(children.carol?.state))
  check('alice 的对话记到了她做完的那一轮（写文件）', toolNames(children.alice?.messages ?? []).join() === 'write_text_file', toolNames(children.alice?.messages ?? []).join())
  const meta = children.alice?.meta
  check('alice 的记录自洽（条数对得上）', !!meta && meta.messageCount === children.alice.messages.length, JSON.stringify(meta))

  // 新进程接着同一场会话
  const llm2 = await crewLlm(env.cwd, 62)
  try {
    const resumed = await runPlain([], {
      ...env,
      env: { ...env.env, SFT_API_URL: `http://127.0.0.1:${llm2.port}/v1`, RESUME_SESSION: sessionId, RESUME_LINE: '让 alice 和 carol 接着做完' },
    }, 90_000, RUNNER)
    check('新进程说完这一轮', resumed.out.includes('RESUME_DONE'), `${resumed.out.slice(-300)} ${resumed.err.slice(-600)}`)
    const aliceBack = askedBy(llm2, 'alice').find((r) => r.lastText.includes('[上次的情形]'))
    const carolBack = askedBy(llm2, 'carol').find((r) => r.lastText.includes('[上次的情形]'))
    check('alice 被叫醒时带着盘上的对话，并被告知程序异常退出',
      !!aliceBack && toolNames(aliceBack.body.messages).join() === 'write_text_file' && aliceBack.lastText.includes('异常退出') && aliceBack.lastText.includes('接着做完'),
      aliceBack?.lastText)
    check('carol 从她的指令重新开始，并被告知异常退出',
      !!carolBack && JSON.stringify(carolBack.body.messages).includes('我是carol，认真想一想') && carolBack.lastText.includes('异常退出'),
      carolBack?.lastText)
    const after = readChildren(sessionDir)
    check('两位都做完了', after.children.alice?.state.status === 'completed' && after.children.carol?.state.status === 'completed',
      JSON.stringify(Object.values(after.children).map((c) => [c.state.name, c.state.status])))
    check('接着干之后 alice 的旧对话原样在前', (() => {
      const before = children.alice.messages
      const now = after.children.alice.messages
      return now.length > before.length && JSON.stringify(now.slice(0, before.length)) === JSON.stringify(before)
    })())
    check('接着干之后文件仍读得出来', after.broken.length === 0, after.broken.join(', '))
    check('没有另起一个日期目录把记录分成两份', childSessions(env.dataDir).length === 1)
    const warnings = recordWarnings(env.dataDir)
    check('日志里没有存盘相关的警告', warnings.length === 0, warnings.slice(0, 3).join('\n'))
  } finally {
    await llm2.close()
  }
})

// ───────────────────────────────────────────────────────────── 3
scenario('一次派一大批：记录量、耗时、日志里没有警告', async () => {
  const COUNT = Number(process.env.E2E_BATCH || 40)
  const ROUNDS = 3
  const fixture = path.join(sandbox(0, 'sft-subpersist-3-fixture', tempDirs).cwd, 'data.txt')
  fs.writeFileSync(fixture, 'hello\n')
  const names = Array.from({ length: COUNT }, (_, i) => `w${String(i + 1).padStart(2, '0')}`)
  const nameOf = (entry) => {
    const all = JSON.stringify(entry.body.messages)
    return names.find((n) => all.includes(`我是${n}，`))
  }
  const llm = await startMockLlm({
    onUser: (text, _n, entry) => {
      const who = nameOf(entry)
      if (who) return callTool('read_file', { path: fixture })
      if (text.includes('[伙计')) return say('收到')
      return callTool('dispatch_agents', {
        tasks: names.map((n) => ({ name: n, description: `读文件 ${n}`, prompt: `我是${n}，把文件读 ${ROUNDS} 遍再回报` })),
      })
    },
    afterTool: (last, entry) => {
      const who = nameOf(entry)
      if (!who) return say('已派出，等他们')
      const answered = entry.body.messages.filter((m) => m.role === 'tool').length
      return answered < ROUNDS ? callTool('read_file', { path: fixture }) : say(`${who}：读完了`)
    },
  })
  try {
    const env = sandbox(llm.port, 'sft-subpersist-3', tempDirs)
    const startedAt = Date.now()
    const result = await runPlain([`派 ${COUNT} 位去读文件`, '--free'], env, 240_000)
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)
    check('正常退出', result.code === 0, `exit ${result.code} ${result.err.slice(0, 300)}`)
    const sessions = childSessions(env.dataDir)
    check('伙计记录只有一场会话', sessions.length === 1)
    const { children, broken } = readChildren(sessions[0].dir)
    check(`${COUNT} 位都记下了`, Object.keys(children).length === COUNT, String(Object.keys(children).length))
    check('全部做完', Object.values(children).every((c) => c.state.status === 'completed'),
      Object.values(children).filter((c) => c.state.status !== 'completed').map((c) => `${c.state.name}:${c.state.status}`).join(' '))
    check('每位的对话都记全了（读文件往返 + 最后一句）',
      Object.values(children).every((c) => toolNames(c.messages).length === ROUNDS && c.messages.at(-1)?.role === 'assistant'))
    check('文件都读得出来', broken.length === 0, broken.slice(0, 5).join(', '))
    const openings = fs.readdirSync(path.join(sessions[0].dir, '_openings'))
    check('相同开局只存了很少几份，不是每人一份', openings.length > 0 && openings.length <= 3, `${openings.length} 份`)
    const stats = dirStats(sessions[0].dir)
    console.log(`    | ${COUNT} 位 × ${ROUNDS} 轮：${stats.files} 个文件，${(stats.bytes / 1024).toFixed(0)} KB，整个命令 ${seconds}s`)
    const main = readdirCount(path.join(env.dataDir, 'history', 'agent'))
    check('主历史里仍然只有主会话这一条', main === 1, `${main} 条`)
    const warnings = recordWarnings(env.dataDir)
    check('日志里没有存盘相关的警告', warnings.length === 0, warnings.slice(0, 3).join('\n'))
  } finally { await llm.close() }
})

function readdirCount(root) {
  let n = 0
  for (const date of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    const dir = path.join(root, date)
    if (fs.statSync(dir).isDirectory()) n += fs.readdirSync(dir).filter((f) => !f.startsWith('.')).length
  }
  return n
}

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

console.log(failures.length ? `\nRESULT FAIL (${failures.length})\n${failures.map((f) => `  - ${f}`).join('\n')}` : '\nRESULT PASS')
process.exit(failures.length ? 1 : 0)
