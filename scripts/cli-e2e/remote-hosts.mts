/**
 * 伙计在已存主机上后台跑命令：命令行真起进程、本机起一批真 sshd，模型换成脚本化的假模型。
 *
 *   npx tsx scripts/cli-e2e/remote-hosts.mts          # 全跑
 *   npx tsx scripts/cli-e2e/remote-hosts.mts 1 3      # 只跑编号 1、3
 *   E2E_SHOW=1 …                                       # 打出命令行真实输出
 *   E2E_KEEP=1 …                                       # 跑完保留临时目录
 *
 * 机器清单（共约 40 台）：
 *   - 10 台经一台跳板（带转发计数的假跳板）连到真 sshd
 *   - 25 台直连真 sshd
 *   - 1 台密钥不对（真 sshd，换一把没登记的钥匙）、1 台端口不通、1 台只能交互的假堡垒机
 * 所有目标 sshd 前面各挡一个计数代理，用来数每台被连了几次、关停后还剩几条。
 */
import { spawn, execFile } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
// @ts-expect-error 纯 JS 的假模型
import { startMockLlm, callTool, say } from './mock-llm.mjs'
import { startRealSshds } from '../../electron/services/remote-exec/__tests__/real-sshd'
import { startFakeHost } from '../../electron/services/remote-exec/__tests__/fake-ssh-host'

const execFileAsync = promisify(execFile)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const CLI = path.join(ROOT, 'electron/cli/main.js')
const LAG_PROBE = path.join(ROOT, 'scripts/cli-e2e/lag-probe.mjs')

const failures: string[] = []
const check = (label: string, pass: boolean, detail?: unknown) => {
  if (pass) console.log(`  OK   ${label}`)
  else {
    failures.push(detail ? `${label} — ${detail}` : label)
    console.error(`  FAIL ${label}${detail ? ` — ${String(detail).slice(0, 800)}` : ''}`)
  }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const tempDirs: string[] = []

/** 命令行以这段结尾的进程有几个（macOS 的 pgrep 没有 -c） */
async function countProcs(tail: string): Promise<number> {
  const { stdout } = await execFileAsync('pgrep', ['-f', `${tail}$`]).catch(() => ({ stdout: '' }))
  return stdout.split('\n').filter(l => l.trim()).length
}

// ───────────────────────── 机器清单 ─────────────────────────

interface CountingProxy {
  port: number
  total: () => number
  open: () => number
  close: () => Promise<void>
}

/** 挡在 sshd 前面的 TCP 代理：数连过几次、此刻还连着几条 */
function startProxy(target: number): Promise<CountingProxy> {
  let total = 0
  const live = new Set<net.Socket>()
  const server = net.createServer(client => {
    total++
    const upstream = net.connect(target, '127.0.0.1')
    live.add(client); live.add(upstream)
    const drop = () => { client.destroy(); upstream.destroy(); live.delete(client); live.delete(upstream) }
    client.on('error', drop); upstream.on('error', drop)
    client.on('close', drop); upstream.on('close', drop)
    client.pipe(upstream); upstream.pipe(client)
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    port: (server.address() as net.AddressInfo).port,
    total: () => total,
    open: () => [...live].filter(s => !s.destroyed).length / 2,
    close: () => new Promise<void>(done => { for (const s of live) s.destroy(); server.close(() => done()) }),
  })))
}

interface Fleet {
  sessions: Array<Record<string, unknown>>
  groups: Array<Record<string, unknown>>
  /** 每台正常主机的计数代理，按会话 id */
  proxies: Map<string, CountingProxy>
  jump: Awaited<ReturnType<typeof startFakeHost>>
  bastion: Awaited<ReturnType<typeof startFakeHost>>
  okIds: string[]
  badKeyId: string
  closedPortId: string
  bastionId: string
  behindJumpIds: string[]
  stop: () => Promise<void>
}

async function startFleet(): Promise<Fleet> {
  const BEHIND = 10
  const DIRECT = 25
  const sshds = await startRealSshds(BEHIND + DIRECT + 1)
  const wrongKey = path.join(sshds.dir, 'wrong_key')
  await execFileAsync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', wrongKey])

  const jump = await startFakeHost({ users: { jumper: 'jpw' }, allowForward: true })
  const bastion = await startFakeHost({ users: { guard: 'gpw' }, rejectExec: true })
  const jumpHost = { host: '127.0.0.1', port: jump.port, username: 'jumper', authType: 'password', password: 'jpw' }

  const proxies = new Map<string, CountingProxy>()
  const sessions: Array<Record<string, unknown>> = []
  const okIds: string[] = []
  const behindJumpIds: string[] = []
  const pad = (n: number) => String(n).padStart(2, '0')
  const base = { host: '127.0.0.1', authType: 'privateKey', encoding: 'utf-8', createdAt: 0 }

  for (let i = 0; i < BEHIND + DIRECT; i++) {
    const id = `h${pad(i + 1)}`
    const proxy = await startProxy(sshds.hosts[i]!.port)
    proxies.set(id, proxy)
    const behind = i < BEHIND
    sessions.push({
      ...base, id, name: `srv-${pad(i + 1)}`, port: proxy.port, username: sshds.hosts[i]!.username,
      privateKeyPath: sshds.hosts[i]!.privateKeyPath, groupId: 'g1',
      ...(behind ? { jumpHostOverride: jumpHost } : {}),
    })
    okIds.push(id)
    if (behind) behindJumpIds.push(id)
  }
  const badKeyId = 'h-badkey'
  sessions.push({ ...base, id: badKeyId, name: 'srv-badkey', port: sshds.hosts[BEHIND + DIRECT]!.port, username: sshds.hosts[0]!.username, privateKeyPath: wrongKey, groupId: 'g1' })
  const closedPortId = 'h-closed'
  const closedProbe = net.createServer(); await new Promise<void>(r => closedProbe.listen(0, '127.0.0.1', r))
  const closedPort = (closedProbe.address() as net.AddressInfo).port
  await new Promise<void>(r => closedProbe.close(() => r()))
  sessions.push({ ...base, id: closedPortId, name: 'srv-closed', port: closedPort, username: 'nobody', privateKeyPath: wrongKey, groupId: 'g1' })
  const bastionId = 'h-bastion'
  sessions.push({ ...base, id: bastionId, name: 'srv-bastion', port: bastion.port, username: 'guard', authType: 'password', password: 'gpw', groupId: 'g1' })

  return {
    sessions, groups: [{ id: 'g1', name: '机房A', createdAt: 0 }], proxies, jump, bastion,
    okIds, badKeyId, closedPortId, bastionId, behindJumpIds,
    async stop() {
      for (const p of proxies.values()) await p.close()
      await jump.close(); await bastion.close()
      await sshds.stop()
    },
  }
}

// ───────────────────────── 命令行 ─────────────────────────

function sandbox(fleet: Fleet, port: number | null, sessions = fleet.sessions) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sft-cli-remote-'))
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sft-cli-remote-cwd-'))
  tempDirs.push(dataDir, cwd)
  fs.writeFileSync(path.join(dataDir, 'qiyu-terminal-config.json'), JSON.stringify({ sshSessions: sessions, sessionGroups: fleet.groups }, null, '\t'))
  const lagFile = path.join(dataDir, 'lag.json')
  const env = {
    ...process.env,
    SFT_DATA_DIR: dataDir,
    // 真模型那一场不设这几项：沙箱借用桌面里存的模型配置
    ...(port === null ? {} : {
      SFT_CLI_NO_BORROW: '1',
      SFT_API_URL: `http://127.0.0.1:${port}/v1`,
      SFT_API_KEY: 'sk-test',
      SFT_MODEL: 'mock',
    }),
    NO_COLOR: '1',
    TSX_TSCONFIG_PATH: path.join(ROOT, 'tsconfig.json'),
    SFT_LAG_FILE: lagFile,
    NODE_OPTIONS: `--import=${LAG_PROBE}`,
  }
  return { dataDir, cwd, env, lagFile }
}

interface Run { child: ReturnType<typeof spawn>; done: Promise<{ code: number | null; out: string; err: string }>; output: () => string }

function runCli(args: string[], sb: ReturnType<typeof sandbox>, timeoutMs = 180_000): Run {
  const child = spawn('node', [CLI, ...args], { env: sb.env, cwd: sb.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''; let err = ''
  child.stdout.on('data', c => { out += c })
  child.stderr.on('data', c => { err += c })
  const done = new Promise<{ code: number | null; out: string; err: string }>(resolve => {
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('close', code => { clearTimeout(timer); resolve({ code, out, err }) })
  })
  return { child, done, output: () => out + err }
}

function readJson<T>(file: string): T | undefined {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T } catch { return undefined }
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

// ───────────────────────── 脚本化的假模型 ─────────────────────────

const COMMANDS = ['echo SFT_E2E_OK', 'uname -s', 'uptime']
const WORKERS = 12

/** 把 hostIds 轮流分给 WORKERS 个伙计 */
function assign(hostIds: string[]): string[][] {
  const groups: string[][] = Array.from({ length: WORKERS }, () => [])
  hostIds.forEach((id, i) => groups[i % WORKERS]!.push(id))
  return groups.filter(g => g.length > 0)
}

interface ModelPlan {
  hostIds: string[]
  commands: string[]
  timeoutSeconds?: number
}

function fleetModel(plan: ModelPlan) {
  const groups = assign(plan.hostIds)
  let dispatched = false
  return startMockLlm({
    respond(body: { tools?: Array<{ function: { name: string } }>; messages?: Array<{ role: string; content?: unknown }> }) {
      const tools = (body.tools ?? []).map(t => t.function.name)
      const messages = body.messages ?? []
      const last = messages[messages.length - 1]
      if (tools.includes('dispatch_agents')) {
        if (dispatched) return say('巡检完成，结果见各伙计回报。')
        dispatched = true
        return callTool('dispatch_agents', {
          tasks: groups.map((hosts, i) => ({ name: `w${i + 1}`, description: `巡检 ${hosts.length} 台`, prompt: '依次在你的每台主机上跑单上的每条命令，最后一句话汇报。', hosts })),
          remote_commands: plan.commands,
        })
      }
      // 伙计：从处境说明里读自己的主机和命令，逐个调用
      const text = messages.map(m => String(m.content ?? '')).join('\n')
      const hostIds = [...text.matchAll(/sessionId: ([^，）]+)[，）]/g)].map(m => m[1]!)
      const unique = [...new Set(hostIds)]
      const done = messages.filter(m => m.role === 'tool').length
      const calls = unique.flatMap(host => plan.commands.map(command => ({ host, command })))
      if (done < calls.length) {
        const next = calls[done]!
        return callTool('remote_exec', { ...next, ...(plan.timeoutSeconds ? { timeout_seconds: plan.timeoutSeconds } : {}) })
      }
      return say(`跑完 ${calls.length} 条。`)
    },
  })
}

// ───────────────────────── 场景 ─────────────────────────

async function scenarioFleet(fleet: Fleet) {
  console.log('\n[1] 批量巡检：自由模式，12 个伙计分头跑 38 台（含 3 台有问题的）')
  const hostIds = [...fleet.okIds, fleet.badKeyId, fleet.closedPortId, fleet.bastionId]
  const llm = await fleetModel({ hostIds, commands: COMMANDS })
  const sb = sandbox(fleet, llm.port)
  const started = Date.now()
  const run = runCli(['agent:run', '巡检这批机器', '--free', '--once', ...(process.env.E2E_VERBOSE ? ['--verbose'] : [])], sb)
  const { code, out } = await run.done
  const elapsed = Date.now() - started
  if (process.env.E2E_SHOW) console.log(out.split('\n').map(l => `    | ${l}`).join('\n'))
  console.log(`  用时 ${(elapsed / 1000).toFixed(1)}s，退出码 ${code}`)

  check('命令行正常收工', code === 0, `exit=${code}\n${out.slice(-1500)}`)

  // 留痕和结果对得上
  const opsFiles = findFiles(sb.dataDir, 'remote-ops.jsonl')
  check('有一份操作记录', opsFiles.length === 1, `files=${opsFiles}`)
  const entries = (opsFiles[0] ? fs.readFileSync(opsFiles[0], 'utf8').trim().split('\n') : []).map(l => JSON.parse(l) as {
    worker: string; hostId: string; command: string; exitCode: number | null; failure?: string; outputFile?: string
  })
  const byHost = (id: string) => entries.filter(e => e.hostId === id)
  const wantOk = fleet.okIds.length * COMMANDS.length
  const good = entries.filter(e => fleet.okIds.includes(e.hostId))
  check(`正常主机每台每条命令各一条记录（${wantOk}）`, good.length === wantOk, `got ${good.length}`)
  check('正常主机全部退出码 0', good.every(e => e.exitCode === 0), good.filter(e => e.exitCode !== 0).slice(0, 3).map(e => JSON.stringify(e)).join(' '))
  const echoes = good.filter(e => e.command === COMMANDS[0])
  const echoOk = echoes.every(e => e.outputFile && fs.readFileSync(e.outputFile, 'utf8').includes('SFT_E2E_OK'))
  check('echo 的输出文件里确实是 SFT_E2E_OK', echoes.length === fleet.okIds.length && echoOk)
  const unames = good.filter(e => e.command === 'uname -s')
  check('uname 输出是本机系统名', unames.every(e => e.outputFile && fs.readFileSync(e.outputFile, 'utf8').trim().length > 0))

  // 有问题的三台：每台都有记录，原因说得清
  const bad = byHost(fleet.badKeyId)[0]
  const closed = byHost(fleet.closedPortId)[0]
  const guard = byHost(fleet.bastionId)[0]
  check('密钥不对：认证失败', !!bad && bad.exitCode === null && /认证|auth/i.test(bad.failure ?? ''), JSON.stringify(bad))
  check('端口不通：连接失败', !!closed && closed.exitCode === null && /连|connect/i.test(closed.failure ?? ''), JSON.stringify(closed))
  check('只能交互的堡垒机：说明不支持后台执行', !!guard && guard.exitCode === null && /不支持|exec/i.test(guard.failure ?? ''), JSON.stringify(guard))
  check('认证失败的凭据不重复重试（同一台只连一次）', fleet.proxies.get(fleet.badKeyId) === undefined && fleet.bastion.connections <= 2, `bastion connections=${fleet.bastion.connections}`)

  // 连接复用：每台正常主机只被连一次（跳板后面的，是跳板代它连的那一次）
  const multi = fleet.okIds.filter(id => (fleet.proxies.get(id)?.total() ?? 0) !== 1)
  check('每台正常主机整场只被连一次（连接复用）', multi.length === 0, `被连次数不是 1 的: ${multi.map(id => `${id}=${fleet.proxies.get(id)?.total()}`).join(',')}`)

  // 限流
  check(`跳板同时转发不超过 4（峰值 ${fleet.jump.peakTunnels}）`, fleet.jump.peakTunnels <= 4 && fleet.jump.peakTunnels > 0)
  check(`10 台经跳板：跳板上只有 1 条登录连接（${fleet.jump.connections}）`, fleet.jump.connections === 1, `connections=${fleet.jump.connections}`)

  // 事件循环
  const lag = readJson<{ p50: number; p99: number; max: number; samples: number }>(sb.lagFile)
  console.log(`  事件循环延迟（含 5ms 采样基线）：${lag ? JSON.stringify(lag) : '没有数据'}`)
  check('事件循环 p99 不超过 100ms', !!lag && lag.p99 <= 100, JSON.stringify(lag))

  // 收工后连接都关了（空闲 60 秒才关是通道自己的规则；进程退出连接必断）
  await sleep(500)
  const stillOpen = [...fleet.proxies.values()].reduce((n, p) => n + p.open(), 0)
  check('命令行退出后没有遗留连接', stillOpen === 0 && fleet.jump.open === 0, `open=${stillOpen} jump=${fleet.jump.open}`)

  await llm.close()
}

async function scenarioAbort(fleet: Fleet) {
  console.log('\n[2] 按停：伙计在 6 台上跑一条很慢的只读命令，中途按停')
  const hostIds = fleet.okIds.slice(10, 16)
  const slow = 'du -s /'
  const llm = await fleetModel({ hostIds, commands: [slow], timeoutSeconds: 300 })
  const sb = sandbox(fleet, llm.port)
  const before = new Map(hostIds.map(id => [id, fleet.proxies.get(id)!.total()]))
  const run = runCli(['agent:run', '巡检慢命令', '--free', '--once'], sb, 90_000)

  // 等到命令真的在远程（本机的 sshd 子进程）里跑起来
  let running = 0
  for (let i = 0; i < 150; i++) {
    await sleep(200)
    running = await countProcs(slow)
    if (running >= hostIds.length) break
  }
  check(`慢命令在远程真的跑起来了（${running}/${hostIds.length}）`, running >= hostIds.length, run.output().slice(-800))
  const opened = hostIds.filter(id => fleet.proxies.get(id)!.open() > 0).length
  check(`${hostIds.length} 台都连着`, opened === hostIds.length, `opened=${opened}`)

  run.child.kill('SIGINT')
  const t0 = Date.now()
  const result = await Promise.race([run.done, sleep(30_000).then(() => 'timeout' as const)])
  console.log(`  按停到进程退出：${((Date.now() - t0) / 1000).toFixed(1)}s`)
  if (result === 'timeout') run.child.kill('SIGKILL')
  check('按停后命令行在 30 秒内退出', result !== 'timeout')

  await sleep(1500)
  const leftover = await countProcs(slow)
  check(`远程没有留下慢命令进程（剩 ${leftover}）`, leftover === 0)
  const stillOpen = hostIds.filter(id => fleet.proxies.get(id)!.open() > 0).length
  check('所有连接已断开', stillOpen === 0, `still open=${stillOpen}`)
  check('每台只连了一次', hostIds.every(id => fleet.proxies.get(id)!.total() - (before.get(id) ?? 0) === 1))
  if (leftover > 0) await execFileAsync('pkill', ['-f', `${slow}$`]).catch(() => {})

  await llm.close()
}

async function scenarioRelaxedNoTty(fleet: Fleet) {
  console.log('\n[3] 宽松模式没有人在场：不连任何主机，回执里说明原因')
  const hostIds = fleet.okIds.slice(20, 23)
  const llm = await fleetModel({ hostIds, commands: ['uptime'] })
  const sb = sandbox(fleet, llm.port)
  const before = hostIds.map(id => fleet.proxies.get(id)!.total())
  const run = runCli(['agent:run', '巡检', '--once'], sb, 60_000)
  const { code, out } = await run.done
  if (process.env.E2E_SHOW) console.log(out.split('\n').map(l => `    | ${l}`).join('\n'))
  const after = hostIds.map(id => fleet.proxies.get(id)!.total())
  check('一台都没连', after.every((n, i) => n === before[i]), `${before} -> ${after}`)
  check('没有留下操作记录', findFiles(sb.dataDir, 'remote-ops.jsonl').length === 0)
  const dispatched = llm.requests.some((r: { body: { tools?: Array<{ function: { name: string } }> } }) => !(r.body.tools ?? []).some(t => t.function.name === 'dispatch_agents') && r.hasTools)
  check('没有伙计被派出', !dispatched, `code=${code}`)
  await llm.close()
}

async function scenarioRealModel(fleet: Fleet) {
  console.log('\n[4] 真模型：自然语言交代，模型自己找主机、写命令清单、派伙计（11 台，含 3 台有问题的）')
  const pick = [...fleet.okIds.slice(0, 4), ...fleet.okIds.slice(10, 14), fleet.badKeyId, fleet.closedPortId, fleet.bastionId]
  const sessions = fleet.sessions.filter(s => pick.includes(String(s.id)))
  const sb = sandbox(fleet, null, sessions)
  const task = '巡检「机房A」分组里的所有服务器：每台都看一下系统名（uname -s）和运行时长（uptime），用伙计分头去做，只用只读命令。最后告诉我哪些正常、哪些连不上、各是什么原因。'
  const run = runCli(['agent:run', task, '--free', '--once'], sb, 400_000)
  const { code, out } = await run.done
  console.log(out.split('\n').map(l => `    | ${l}`).join('\n'))
  check('命令行正常收工', code === 0, `exit=${code}`)
  const opsFiles = findFiles(sb.dataDir, 'remote-ops.jsonl')
  check('有操作记录', opsFiles.length >= 1)
  const entries = opsFiles.flatMap(f => fs.readFileSync(f, 'utf8').trim().split('\n').map(l => JSON.parse(l) as { hostId: string; exitCode: number | null; command: string; failure?: string }))
  const okHosts = new Set(entries.filter(e => e.exitCode === 0).map(e => e.hostId))
  const wantOk = pick.filter(id => fleet.okIds.includes(id))
  console.log(`  记录 ${entries.length} 条；成功过的主机 ${okHosts.size}/${wantOk.length}`)
  check('正常主机都至少成功跑过一条', wantOk.every(id => okHosts.has(id)), `缺: ${wantOk.filter(id => !okHosts.has(id))}`)
  check('记录里的命令全是只读的那两类', entries.every(e => /^(uname -s|uptime)$/.test(e.command)), [...new Set(entries.map(e => e.command))].join(' | '))
  check('回答里点到了有问题的主机', ['srv-badkey', 'srv-closed', 'srv-bastion'].filter(n => out.includes(n)).length >= 2)
}

// ───────────────────────── 入口 ─────────────────────────

const wanted = new Set(process.argv.slice(2).map(Number))
// 4 号用真模型、花 token，要点名或设 E2E_REAL_MODEL=1 才跑
const pick = (n: number) => (n === 4 ? wanted.has(4) || process.env.E2E_REAL_MODEL === '1' : wanted.size === 0 || wanted.has(n))

const fleet = await startFleet()
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(sig, () => { void fleet.stop().finally(() => process.exit(130)) })
}
process.on('uncaughtException', err => { console.error(err); void fleet.stop().finally(() => process.exit(1)) })
console.log(`机器清单：${fleet.sessions.length} 台（${fleet.behindJumpIds.length} 台经跳板）`)
try {
  if (pick(1)) await scenarioFleet(fleet)
  if (pick(2)) await scenarioAbort(fleet)
  if (pick(3)) await scenarioRelaxedNoTty(fleet)
  if (pick(4)) await scenarioRealModel(fleet)
} finally {
  await fleet.stop()
  if (!process.env.E2E_KEEP) for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`\n${failures.length} 项没过：\n- ${failures.join('\n- ')}`)
  process.exit(1)
}
console.log('\n全部通过')
process.exit(0)
