/**
 * 命令行里 `/goal` 的端到端检查：真起命令行进程、真走后端的目标推进，只是模型换成脚本化的假模型。
 *
 *   node scripts/cli-e2e/goal.mjs            # 全跑
 *   node scripts/cli-e2e/goal.mjs 3 5        # 只跑编号 3、5
 *   E2E_SHOW=1 …                              # 把终端里真实出现的内容打出来看
 *   E2E_KEEP=1 …                              # 跑完保留临时目录（看日志、落盘记录）
 *
 * 一次性（管道）场景用普通子进程；要按 Ctrl+C、答 y/N、进同一屏的，用伪终端坐在命令行前面。
 * 每个场景一个临时数据目录，不碰桌面真实数据，也不借用桌面的模型配置。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { callTool, hang, say, startMockLlm } from './mock-llm.mjs'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const CLI = path.join(ROOT, 'electron/cli/main.js')

const failures = []
const check = (label, pass, detail) => {
  if (pass) console.log(`  OK   ${label}`)
  else {
    failures.push(detail ? `${label} — ${detail}` : label)
    console.error(`  FAIL ${label}${detail ? ` — ${String(detail).slice(0, 600)}` : ''}`)
  }
}

const clean = (raw) => raw
  .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
  .replace(/\x1b\][^\x07]*\x07/g, '')
  .replace(/\r/g, '')

function sandbox(port) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sft-cli-goal-'))
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sft-cli-goal-cwd-'))
  tempDirs.push(dataDir, cwd)
  const env = {
    ...process.env,
    SFT_DATA_DIR: dataDir,
    SFT_CLI_NO_BORROW: '1',
    SFT_API_URL: `http://127.0.0.1:${port}/v1`,
    SFT_API_KEY: 'sk-test',
    SFT_MODEL: 'mock',
    NO_COLOR: '1',
    // 在临时目录里敲命令（和人一样站在别处），但 tsx 要从仓库找路径别名
    TSX_TSCONFIG_PATH: path.join(ROOT, 'tsconfig.json'),
  }
  return { dataDir, cwd, env }
}

/** 没有终端的一次性运行（管道、脚本里的样子） */
function runPlain(args, { env, cwd }, timeoutMs = 120_000) {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', (chunk) => { err += chunk })
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, out: clean(out), err })
    })
  })
}

/** 伪终端：像人坐在终端前那样敲字、按 Ctrl+C */
class Terminal {
  constructor(args, { env, cwd, cols = 120, rows = 40 }) {
    const pty = require('node-pty')
    this.raw = ''
    this.exitCode = undefined
    this.term = pty.spawn('node', [CLI, ...args], { name: 'xterm-256color', cols, rows, cwd, env })
    this.term.onData((data) => { this.raw += data })
    this.exited = new Promise((resolve) => this.term.onExit(({ exitCode }) => { this.exitCode = exitCode; resolve(exitCode) }))
  }

  /** 此刻之后新出现的内容从这里数 */
  mark() { return this.raw.length }

  since(mark = 0) { return clean(this.raw.slice(mark)) }

  async waitFor(needle, { from = 0, timeout = 60_000 } = {}) {
    const deadline = Date.now() + timeout
    const found = () => (needle instanceof RegExp ? needle.test(this.since(from)) : this.since(from).includes(needle))
    while (Date.now() < deadline) {
      if (found()) return true
      if (this.exitCode !== undefined) return found()
      await new Promise((r) => setTimeout(r, 100))
    }
    return found()
  }

  type(text) { this.term.write(text) }
  line(text) { this.term.write(`${text}\r`) }
  interrupt() { this.term.write('\x03') }

  async close() {
    if (process.env.E2E_SHOW) console.log(this.since(0).split('\n').map((l) => `    | ${l}`).join('\n'))
    if (this.exitCode === undefined) {
      try { this.term.kill() } catch { /* 已经走了 */ }
      await Promise.race([this.exited, new Promise((r) => setTimeout(r, 3000))])
    }
  }
}

/** 找出落盘记录里记下的目标 */
function storedGoals(dataDir) {
  const found = []
  const walk = (dir) => {
    for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.json')) {
        try {
          const record = JSON.parse(fs.readFileSync(full, 'utf8'))
          if (record?.goal?.goalId) found.push(record.goal)
        } catch { /* 不是记录文件 */ }
      }
    }
  }
  walk(path.join(dataDir, 'history'))
  return found
}

/** 等假模型收到某一类请求（按它的编号），免得 Ctrl+C 抢在请求发出之前 */
async function waitForRequest(llm, phase, timeout = 30_000) {
  for (let waited = 0; waited < timeout; waited += 50) {
    if (llm.mainRequests().some((r) => r.phase === phase)) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return false
}

const tempDirs = []
const scenarios = []
const scenario = (name, run) => scenarios.push({ name, run })

// ───────────────────────────────────────────────────────────── 1
scenario('一句话挂目标，没有终端也自己推到达成', async () => {
  const llm = await startMockLlm({
    onUser: () => say('第一步做完了，还差核对。'),
    onContinue: () => callTool('update_goal', { status: 'complete', reason: 'a.txt 已核对，内容与要求一致' }),
    afterTool: () => say('目标做完了，证据都在上面。'),
  })
  try {
    const env = sandbox(llm.port)
    const result = await runPlain(['/goal 把 a.txt 做出来并核对', '--free'], env)
    console.log(result.out.split('\n').map((l) => `    | ${l}`).join('\n'))
    check('正常退出', result.code === 0, `exit ${result.code} ${result.err.slice(0, 300)}`)
    check('第一轮的话打出来了', result.out.includes('第一步做完了'))
    check('续跑的那一轮留了一行', result.out.includes('· 继续推进目标'))
    check('续跑那一轮的话打出来了', result.out.includes('目标做完了，证据都在上面。'))
    check('第一轮的话只打一遍（收尾不重复）', result.out.split('第一步做完了').length === 2, result.out)
    check('收工一句：已达成 + 用时 + 用量', /目标已达成 · 用时 \d+s · [\d.]+K tokens/.test(result.out), result.out.slice(-300))
    check('没有交互终端：不写下一步怎么敲', !result.out.includes('/goal resume'))
    check('不出现桌面口吻（点继续）', !result.out.includes('点继续'))

    const main = llm.mainRequests()
    const first = main[0]
    check('模型第一句收到的是 /goal 开头的原话', first?.lastText.includes('/goal 把 a.txt 做出来并核对'), first?.lastText)
    check('模型的上下文里带着目标', JSON.stringify(first?.body.messages).includes('把 a.txt 做出来并核对') && JSON.stringify(first?.body.messages).includes('goal_objective'))
    const continued = main.filter((r) => r.phase?.startsWith('continue'))
    check('只续跑了一次（达成后不再续）', continued.length === 1, `续跑 ${continued.length} 次`)
    check('续跑那一句是系统口吻，不冒充用户', continued[0]?.lastText.includes('用户没有新消息'))

    const goals = storedGoals(env.dataDir)
    check('落盘记录里目标已达成，且记了用量', goals.length === 1 && goals[0].status === 'achieved' && goals[0].tokensUsed > 0, JSON.stringify(goals))
  } finally { await llm.close() }
})

// ───────────────────────────────────────────────────────────── 2
scenario('卡住了：说清状态，没有终端不写下一步', async () => {
  const llm = await startMockLlm({
    onUser: () => say('先看一下情况。'),
    onContinue: () => callTool('update_goal', { status: 'blocked', reason: '缺少部署权限，连续三轮都过不去' }),
    afterTool: () => say('卡在部署权限上，需要你处理。'),
  })
  try {
    const env = sandbox(llm.port)
    const result = await runPlain(['/goal 把服务部署到测试机', '--free'], env)
    check('正常退出', result.code === 0, `exit ${result.code}`)
    check('收工一句：停滞', /目标停滞了，需要你看一眼 · 用时 \d+s/.test(result.out), result.out.slice(-300))
    check('没有交互终端：不写下一步怎么敲', !result.out.includes('/goal resume'))
    const goals = storedGoals(env.dataDir)
    check('落盘记录里目标是停滞', goals[0]?.status === 'blocked', JSON.stringify(goals))
  } finally { await llm.close() }
})

// ───────────────────────────────────────────────────────────── 3
scenario('没有目标时的管理命令：说清楚，不惊动模型', async () => {
  const llm = await startMockLlm({ onUser: () => say('不该被问到'), onContinue: () => say('不该被问到') })
  try {
    const env = sandbox(llm.port)
    const status = await runPlain(['/goal'], env)
    check('/goal 看状态：还没有目标 + 用法', status.out.includes('这场还没有目标') && status.out.includes('用法：/goal'), status.out)
    const pause = await runPlain(['/goal pause'], env)
    check('/goal pause：还没有目标', pause.out.includes('这场还没有目标'), pause.out)
    const clear = await runPlain(['/goal clear'], env)
    check('/goal clear：还没有目标', clear.out.includes('这场还没有目标'), clear.out)
    const edit = await runPlain(['/goal edit'], env)
    check('/goal edit 不带正文：提示怎么写', edit.out.includes('需要写新的正文'), edit.out)
    check('这些都没有去问模型', llm.requests.length === 0, `${llm.requests.length} 次请求`)
  } finally { await llm.close() }
})

// ───────────────────────────────────────────────────────────── 4
scenario('终端里接着说：Ctrl+C 暂停、看状态、改、继续、清除、换', async () => {
  const llm = await startMockLlm({
    onUser: (text) => say(text.includes('另一个目标') ? '收到，我来推进另一个目标。' : '第一轮做完了。'),
    onContinue: (n) => (n === 2 ? callTool('update_goal', { status: 'complete', reason: '改过的要求也都核对了' }) : hang()),
    afterTool: () => say('这回做完了。'),
  })
  const env = sandbox(llm.port)
  const term = new Terminal(['/goal 做完一件要反复推进的事', '--free'], env)
  try {
    // 续跑的第一轮挂着不回，按 Ctrl+C
    check('续跑那一轮开始了', await term.waitFor('· 继续推进目标'))
    // 等模型那头真的收到了请求、正在「想」，再按 Ctrl+C（人按的时候也是在等回复）
    await waitForRequest(llm, 'continue-1')
    let mark = term.mark()
    term.interrupt()
    check('Ctrl+C：已停下', await term.waitFor('已停下。', { from: mark }))
    check('Ctrl+C：目标是暂停，不是清除，并告诉怎么接着推', await term.waitFor('/goal resume 接着推进', { from: mark }), term.since(mark))
    check('回到可以接着说的状态', await term.waitFor('›', { from: mark }))

    mark = term.mark()
    term.line('/goal')
    check('/goal 看状态：已暂停', await term.waitFor('状态：已暂停', { from: mark }), term.since(mark))

    mark = term.mark()
    term.line('/goal edit 做完一件要反复推进的事，并核对结果')
    check('/goal edit：改了正文', await term.waitFor('已改目标：做完一件要反复推进的事，并核对结果', { from: mark }), term.since(mark))

    mark = term.mark()
    term.line('/goal resume')
    check('/goal resume：续跑后达成', await term.waitFor(/目标已达成 · 用时/, { from: mark, timeout: 90_000 }), term.since(mark))
    const lastContinue = llm.mainRequests().filter((r) => r.phase?.startsWith('continue')).pop()
    check('续跑带的是改过的正文', lastContinue?.lastText.includes('并核对结果'), lastContinue?.lastText)

    mark = term.mark()
    term.line('/goal clear')
    check('已达成的目标：清除不再问', await term.waitFor('已清除目标。', { from: mark }) && !term.since(mark).includes('[y/N]'), term.since(mark))

    // 新目标，再被 Ctrl+C 停下
    mark = term.mark()
    term.line('/goal 另一个目标')
    check('挂上新目标', await term.waitFor('已挂上目标：另一个目标', { from: mark }), term.since(mark))
    check('新目标的续跑开始了', await term.waitFor('· 继续推进目标', { from: mark, timeout: 90_000 }), term.since(mark))
    await waitForRequest(llm, 'continue-3')
    term.interrupt()
    check('再次暂停', await term.waitFor('目标已暂停', { from: mark }))
    await term.waitFor('›', { from: mark })

    // 没做完的目标上再挂新的：先问，答 n 保持原样
    mark = term.mark()
    term.line('/goal 第三个目标')
    check('换目标先问一句', await term.waitFor('要换成新的吗？[y/N]', { from: mark }), term.since(mark))
    term.line('n')
    check('答 n：没换', await term.waitFor('没换，目标还是原来的。', { from: mark }), term.since(mark))

    mark = term.mark()
    term.line('/goal')
    check('目标还是「另一个目标」', await term.waitFor('目标：另一个目标', { from: mark }), term.since(mark))

    // 清除没做完的：先问，答 y 才清
    mark = term.mark()
    term.line('/goal clear')
    check('清除没做完的目标先问一句', await term.waitFor('清除这个目标？续跑也会停。[y/N]', { from: mark }), term.since(mark))
    term.line('y')
    check('答 y：清掉了', await term.waitFor('已清除目标。', { from: mark }), term.since(mark))

    term.line('exit')
    const code = await Promise.race([term.exited, new Promise((r) => setTimeout(() => r('timeout'), 30_000))])
    check('exit 正常退出', code === 0, String(code))
  } finally {
    await term.close()
    await llm.close()
  }
})

// ───────────────────────────────────────────────────────────── 5
scenario('同一屏里：挂目标、看状态、离开', async () => {
  const llm = await startMockLlm({
    onUser: () => say('屏上第一轮做完了。'),
    onContinue: () => callTool('update_goal', { status: 'complete', reason: '屏上的要求都核对了' }),
    afterTool: () => say('屏上做完了。'),
  })
  const env = sandbox(llm.port)
  const term = new Terminal(['--free'], env, { cols: 110, rows: 32 })
  try {
    check('进了同一屏，提示里有 /goal', await term.waitFor('/goal 目标', { timeout: 90_000 }))
    let mark = term.mark()
    term.line('/goal 屏上挂一个目标')
    check('屏上：挂上并推到达成', await term.waitFor(/目标已达成 · 用时/, { from: mark, timeout: 90_000 }), term.since(mark).slice(-600))
    check('屏上：续跑留了一行', term.since(mark).includes('继续推进目标'))
    mark = term.mark()
    term.line('/goal')
    check('屏上：看状态', await term.waitFor('状态：已达成', { from: mark }), term.since(mark).slice(-400))
    term.line('/exit')
    const code = await Promise.race([term.exited, new Promise((r) => setTimeout(() => r('timeout'), 30_000))])
    check('屏上：/exit 正常离开', code === 0, String(code))
    const goals = storedGoals(env.dataDir)
    check('屏上：落盘记录里目标已达成', goals[0]?.status === 'achieved', JSON.stringify(goals))
  } finally {
    await term.close()
    await llm.close()
  }
})

// ───────────────────────────────────────────────────────────── 6
scenario('同一屏里这一轮还在跑：不借屏上那一行问换/清，停下后照常问', async () => {
  const llm = await startMockLlm({
    onUser: () => say('屏上第一轮做完了。'),
    onContinue: () => hang(),
    afterTool: () => say('好。'),
  })
  const env = sandbox(llm.port)
  const term = new Terminal(['--free'], env, { cols: 110, rows: 32 })
  try {
    check('进了同一屏', await term.waitFor('/goal 目标', { timeout: 90_000 }))
    term.line('/goal 屏上要推很久的目标')
    check('续跑那一轮开始了', await term.waitFor('继续推进目标', { timeout: 90_000 }))
    await waitForRequest(llm, 'continue-1')

    let mark = term.mark()
    term.line('/goal clear')
    check('还在跑：清除不借屏上那一行问', await term.waitFor('这一轮还在跑，先按 Ctrl+C 停下', { from: mark }), term.since(mark).slice(-400))
    check('还在跑：没清除', await term.waitFor('没清除。', { from: mark }), term.since(mark).slice(-400))
    check('还在跑：没有挂着一个问句', !term.since(mark).includes('[y/N]'), term.since(mark).slice(-400))

    mark = term.mark()
    term.line('/goal 另一个目标')
    check('还在跑：换目标也不问', await term.waitFor('没换，目标还是原来的。', { from: mark }), term.since(mark).slice(-400))

    mark = term.mark()
    term.interrupt()
    check('Ctrl+C：目标停在暂停', await term.waitFor('目标已暂停', { from: mark }), term.since(mark).slice(-400))

    mark = term.mark()
    term.line('/goal clear')
    check('停下之后：清除照常先问', await term.waitFor('清除这个目标？续跑也会停。[y/N]', { from: mark }), term.since(mark).slice(-400))
    term.line('y')
    check('答 y：清掉了', await term.waitFor('已清除目标。', { from: mark }), term.since(mark).slice(-400))

    term.line('/exit')
    const code = await Promise.race([term.exited, new Promise((r) => setTimeout(() => r('timeout'), 30_000))])
    check('/exit 正常离开', code === 0, String(code))
  } finally {
    await term.close()
    await llm.close()
  }
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

console.log(failures.length ? `\nRESULT FAIL (${failures.length})\n${failures.map((f) => `  - ${f}`).join('\n')}` : '\nRESULT PASS')
process.exit(failures.length ? 1 : 0)
