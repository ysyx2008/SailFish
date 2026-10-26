/**
 * 伙计在一台真实的已存主机上后台跑命令：命令行真起进程，模型换成脚本化的假模型，
 * 目标是桌面里存的那台「MacBook Air Server」（Linux，开着）。
 *
 *   npx tsx scripts/cli-e2e/remote-real-host.mts
 *   E2E_HOST_NAME='Vmware Fusion' …  # 换目标（按已存会话的名字；默认那台不在同一网络时用）
 * 运维专家这里不作答（假模型回一句不成结论的话），走的是「专家没结论 → 自由模式退回只读判定」；专家的各种结论见 remote-hosts.mts 的 5～8 号场景。
 *   E2E_SHOW=1 …                    # 打出命令行真实输出
 *
 * 只借用这一台的会话设置和凭据（复制到临时目录，不动桌面数据）；只跑只读命令。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// @ts-expect-error 纯 JS 的假模型
import { startMockLlm, callTool, say } from './mock-llm.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const CLI = path.join(ROOT, 'electron/cli/main.js')
const DESKTOP = path.join(os.homedir(), 'Library/Application Support/SailFish')
const HOST_NAME = process.env.E2E_HOST_NAME ?? 'MacBook Air Server'

const failures: string[] = []
const check = (label: string, pass: boolean, detail?: unknown) => {
  if (pass) console.log(`  OK   ${label}`)
  else {
    failures.push(detail ? `${label} — ${detail}` : label)
    console.error(`  FAIL ${label}${detail ? ` — ${String(detail).slice(0, 800)}` : ''}`)
  }
}
const tempDirs: string[] = []

// ───────────────────────── 目标主机 ─────────────────────────

const desktopConfig = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'qiyu-terminal-config.json'), 'utf8')) as {
  sshSessions?: Array<Record<string, unknown>>
}
const session = desktopConfig.sshSessions?.find(s => s.name === HOST_NAME)
if (!session) {
  console.error(`桌面里没有名为「${HOST_NAME}」的已存会话`)
  process.exit(2)
}
const hostId = String(session.id)
console.log(`目标：${HOST_NAME}（${session.username}@${session.host}:${session.port}）`)

// ───────────────────────── 命令行 ─────────────────────────

function sandbox(port: number) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sft-cli-real-'))
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sft-cli-real-cwd-'))
  tempDirs.push(dataDir, cwd)
  // 只带这一台的会话；它的凭据照原样复制过来（只在临时目录里）
  fs.writeFileSync(path.join(dataDir, 'qiyu-terminal-config.json'), JSON.stringify({ sshSessions: [session], sessionGroups: [] }, null, '\t'))
  for (const f of ['credentials.json', 'master.key']) {
    fs.copyFileSync(path.join(DESKTOP, f), path.join(dataDir, f))
    fs.chmodSync(path.join(dataDir, f), 0o600)
  }
  const env = {
    ...process.env,
    SFT_DATA_DIR: dataDir,
    SFT_CLI_NO_BORROW: '1',
    SFT_API_URL: `http://127.0.0.1:${port}/v1`,
    SFT_API_KEY: 'sk-test',
    SFT_MODEL: 'mock',
    NO_COLOR: '1',
    TSX_TSCONFIG_PATH: path.join(ROOT, 'tsconfig.json'),
  }
  return { dataDir, cwd, env }
}

function runCli(args: string[], sb: ReturnType<typeof sandbox>, timeoutMs = 120_000) {
  const child = spawn('node', [CLI, ...args], { env: sb.env, cwd: sb.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', c => { out += c })
  child.stderr.on('data', c => { out += c })
  return new Promise<{ code: number | null; out: string }>(resolve => {
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('close', code => { clearTimeout(timer); resolve({ code, out }) })
  })
}

function findFiles(root: string, name: string): string[] {
  const found: string[] = []
  const walk = (dir: string) => {
    for (const e of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.name === name) found.push(full)
    }
  }
  walk(root)
  return found
}

interface OpEntry { worker: string; hostId: string; command: string; exitCode: number | null; failure?: string; outputFile?: string }
function readOps(dataDir: string): OpEntry[] {
  return findFiles(dataDir, 'remote-ops.jsonl').flatMap(f => fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as OpEntry))
}
const outputOf = (e: OpEntry) => (e.outputFile && fs.existsSync(e.outputFile) ? fs.readFileSync(e.outputFile, 'utf8') : '')

// ───────────────────────── 脚本化的假模型 ─────────────────────────

interface Call { command: string; timeoutSeconds?: number }
interface Plan {
  /** 单上的命令 */
  listed: string[]
  /** 每个伙计依次调用的命令（可以包含单外的） */
  workers: Call[][]
}

function model(plan: Plan) {
  let dispatched = false
  return startMockLlm({
    respond(body: { tools?: Array<{ function: { name: string } }>; messages?: Array<{ role: string; content?: unknown }> }) {
      const tools = (body.tools ?? []).map(t => t.function.name)
      const messages = body.messages ?? []
      if (tools.includes('dispatch_agents')) {
        if (dispatched) return say('完成，结果见各伙计回报。')
        dispatched = true
        return callTool('dispatch_agents', {
          tasks: plan.workers.map((_, i) => ({ name: `w${i + 1}`, description: `在 ${HOST_NAME} 上跑命令`, prompt: `编号 W${i + 1}。依次跑你的命令，最后一句话汇报。`, hosts: [hostId] })),
          remote_commands: plan.listed,
        })
      }
      // 伙计：任务里写着自己的编号，按编号取自己的那一串
      const text = messages.map(m => String(m.content ?? '')).join('\n')
      const me = Number(/编号 W(\d+)/.exec(text)?.[1] ?? 1) - 1
      const calls = plan.workers[Math.min(Math.max(me, 0), plan.workers.length - 1)]!
      const done = messages.filter(m => m.role === 'tool').length
      if (done < calls.length) {
        const c = calls[done]!
        return callTool('remote_exec', { host: hostId, command: c.command, ...(c.timeoutSeconds ? { timeout_seconds: c.timeoutSeconds } : {}) })
      }
      return say(`跑完 ${calls.length} 条。`)
    },
  })
}

async function run(plan: Plan, extraArgs: string[] = ['--free'], timeoutMs = 120_000) {
  const llm = await model(plan)
  const sb = sandbox(llm.port)
  const result = await runCli(['agent:run', '在已存主机上跑命令', ...extraArgs, '--once'], sb, timeoutMs)
  if (process.env.E2E_SHOW) console.log(result.out.split('\n').map(l => `    | ${l}`).join('\n'))
  const seen = JSON.stringify(llm.requests.map((q: { body: unknown }) => q.body))
  await llm.close()
  return { ...result, seen, sb, ops: readOps(sb.dataDir) }
}

// ───────────────────────── 场景 ─────────────────────────

async function scenarioBasic() {
  console.log('\n[1] 两个伙计在真机上各跑几条只读命令（自由模式）')
  const listed = ['uname -s', 'uptime', 'df -h', 'free -h']
  const r = await run({ listed, workers: [listed.slice(0, 2).map(command => ({ command })), listed.slice(2).map(command => ({ command }))] })
  check('命令行正常收工', r.code === 0, `exit=${r.code}\n${r.out.slice(-1200)}`)
  check(`4 条命令各一条记录（${r.ops.length}）`, r.ops.length === 4, JSON.stringify(r.ops))
  check('全部退出码 0', r.ops.every(e => e.exitCode === 0), r.ops.map(e => `${e.command}:${e.exitCode}/${e.failure ?? ''}`).join(' '))
  const uname = r.ops.find(e => e.command === 'uname -s')
  check('uname -s 的输出是 Linux', !!uname && outputOf(uname).trim() === 'Linux', uname ? outputOf(uname) : '没记录')
  const df = r.ops.find(e => e.command === 'df -h')
  check('df -h 的输出像样（有表头 Filesystem）', !!df && /Filesystem/.test(outputOf(df)), df ? outputOf(df).slice(0, 200) : '没记录')
  const free = r.ops.find(e => e.command === 'free -h')
  check('free -h 的输出有 Mem 行', !!free && /Mem:/.test(outputOf(free)), free ? outputOf(free).slice(0, 200) : '没记录')
  check('留痕里的主机是这台', r.ops.every(e => e.hostId === hostId))
}

async function scenarioRefusals() {
  console.log('\n[2] 单外命令：伙计试了没发出去，只留一条拒绝记录')
  const r = await run({ listed: ['uptime'], workers: [[{ command: 'uptime' }, { command: 'cat /etc/passwd' }]] })
  check('命令行正常收工', r.code === 0, `exit=${r.code}\n${r.out.slice(-800)}`)
  const ok = r.ops.filter(e => e.command === 'uptime')
  const refused = r.ops.filter(e => e.command === 'cat /etc/passwd')
  check('单上的命令跑了', ok.length === 1 && ok[0]!.exitCode === 0, JSON.stringify(r.ops))
  check('单外的命令留了拒绝记录、没有退出码', refused.length === 1 && refused[0]!.exitCode === null && !!refused[0]!.failure, JSON.stringify(refused))
  check('拒绝的命令没有输出文件（没发出去）', refused.every(e => !e.outputFile))
}

async function scenarioNotReadOnly() {
  console.log('\n[3] 清单里有会改东西的命令：整批退回，没连主机，没有留痕')
  const marker = `/tmp/sft-e2e-should-not-exist-${process.pid}`
  const r = await run({ listed: ['uptime', `touch ${marker}`], workers: [[{ command: 'uptime' }]] })
  check('没有留下操作记录', r.ops.length === 0, JSON.stringify(r.ops))
  check('退回给模型的回执里说明了不是只读、点到那条命令', /只读/.test(r.seen) && r.seen.includes(`touch ${marker}`), r.out.slice(-600))
}

async function scenarioTimeoutKillsRemote() {
  console.log('\n[4] 慢命令超时：远程那条命令跟着停，不留进程')
  const slow = 'sleep 30'
  const ps = 'ps -ef'
  // 同一个伙计：先让 du 在 1 秒后超时，紧接着在同一条连接上看远程进程表
  const r = await run({ listed: [slow, ps], workers: [[{ command: slow, timeoutSeconds: 1 }, { command: ps }]] })
  const e = r.ops.find(o => o.command === slow)
  check('记录里是超时', !!e && e.exitCode === null && /没有结束|超时|timeout/i.test(e.failure ?? ''), JSON.stringify(e))
  const p = r.ops.find(o => o.command === ps)
  const text = p ? outputOf(p) : ''
  check('ps -ef 跑成功了且看得到远程进程表（有 sshd）', !!p && p.exitCode === 0 && /sshd/.test(text), JSON.stringify(p))
  const leftover = text.split('\n').filter(l => /\bsleep 30\s*$/.test(l.trim()))
  check(`超时之后远程没有留下 sleep 30 进程（剩 ${leftover.length}）`, leftover.length === 0, leftover.join('\n'))
}

async function scenarioRealModel() {
  console.log('\n[5] 真模型：自然语言交代，模型自己找主机、写命令清单、派伙计')
  const llm = await startMockLlm({ respond: () => say('unused') }) // 只为拿到沙箱；真模型走借用的配置
  const sb = sandbox(llm.port)
  await llm.close()
  const env = { ...sb.env }
  for (const k of ['SFT_CLI_NO_BORROW', 'SFT_API_URL', 'SFT_API_KEY', 'SFT_MODEL']) delete (env as Record<string, unknown>)[k]
  const task = `用伙计去「${HOST_NAME}」这台已存主机上看一下系统名（uname -s）和运行时长（uptime），只用只读命令，最后告诉我结果。`
  const result = await runCli(['agent:run', task, '--free', '--once'], { ...sb, env }, 300_000)
  console.log(result.out.split('\n').map(l => `    | ${l}`).join('\n'))
  const ops = readOps(sb.dataDir)
  check('命令行正常收工', result.code === 0, `exit=${result.code}`)
  check('有成功的远程记录', ops.some(e => e.exitCode === 0), JSON.stringify(ops))
  check('记录里的命令都是只读的那两类', ops.every(e => /^(uname -s|uptime)$/.test(e.command)), [...new Set(ops.map(e => e.command))].join(' | '))
  check('回答里有 Linux', /Linux/.test(result.out))
}

try {
  if (process.env.E2E_REAL_MODEL === '1') await scenarioRealModel()
  await scenarioBasic()
  await scenarioRefusals()
  await scenarioNotReadOnly()
  await scenarioTimeoutKillsRemote()
} finally {
  if (!process.env.E2E_KEEP) for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`\n${failures.length} 项没过：\n- ${failures.join('\n- ')}`)
  process.exit(1)
}
console.log('\n全部通过')
process.exit(0)
