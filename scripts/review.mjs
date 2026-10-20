#!/usr/bin/env node
// npm run review           列出每一路走到哪一步
// npm run review <名字>    在那一路的工作树里起开发进程（名字是分支名或工作树目录名的一部分）
// npm run review:cli <名字> [一句话]   在那一路的工作树里跑命令行，后面的话原样交给命令行
// node scripts/review.mjs --install   装短命令：之后 review / review <名字> / review --cli <名字> 即可
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { laneOf } from './review-lane.mjs'

const INTEGRATION = 'develop'
const DEV_PORT = 5173
const LOCK_STAMP = '.review-lock-sha256'
const SHORTCUT = path.join(os.homedir(), '.local/bin/review')
const [command, cliCommand] = fs.existsSync(SHORTCUT) ? ['review', 'review --cli'] : ['npm run review', 'npm run review:cli']
const HERE = path.dirname(fileURLToPath(import.meta.url))

/** 失败返回 null，和「输出为空」区分开 */
function git(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

function fail(message) {
  console.error(message)
  process.exit(1)
}

const commonDir = git(path.join(HERE, '..'), ['rev-parse', '--git-common-dir'])
if (commonDir === null) fail('这里不是 Git 仓库，没法盘点工作树。')
const mainRepo = path.dirname(path.resolve(HERE, '..', commonDir))
if (git(mainRepo, ['rev-parse', '--verify', '--quiet', `${INTEGRATION}^{commit}`]) === null) {
  fail(`找不到 ${INTEGRATION} 分支，没法比较每一路领先落后多少。`)
}

function count(range) {
  const out = git(mainRepo, ['rev-list', '--count', range])
  return out === null ? null : Number(out)
}

function listWorktrees() {
  const out = git(mainRepo, ['worktree', 'list', '--porcelain'])
  if (out === null) fail('读不出工作树列表（git worktree list 失败）。')
  const trees = []
  let cur = null
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice(9) }
      trees.push(cur)
    } else if (cur && line.startsWith('branch ')) {
      cur.branch = line.slice(7).replace(/^refs\/heads\//, '')
    } else if (cur && line === 'detached') {
      cur.detached = true
    }
  }
  return trees.filter((t) => path.resolve(t.path) !== path.resolve(mainRepo) && fs.existsSync(t.path))
}

function ago(unixSeconds) {
  const minutes = Math.max(0, Math.round((Date.now() / 1000 - Number(unixSeconds)) / 60))
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.round(hours / 24)
  if (days < 14) return `${days} 天前`
  return `${Math.round(days / 7)} 周前`
}

function describe(tree) {
  const branch = laneOf(tree.path)?.branch ?? tree.branch ?? '（未知）'
  const tip = git(tree.path, ['rev-parse', '--verify', '--quiet', 'HEAD'])
  const ahead = tip ? count(`${INTEGRATION}..${tip}`) : null
  const behind = tip ? count(`${tip}..${INTEGRATION}`) : null
  const status = git(tree.path, ['status', '--porcelain'])
  const dirty = status === null ? null : status.split('\n').filter(Boolean).length
  const [committedAt, subject] = (tip && git(tree.path, ['log', '-1', '--format=%ct\t%s'])?.split('\t')) || []
  const note = (tree.branch && git(mainRepo, ['config', `branch.${tree.branch}.description`])) || ''
  return { ...tree, branch, tip, ahead, behind, dirty, when: committedAt ? ago(committedAt) : '', subject, note }
}

function facts(l) {
  if (!l.tip) return ['还没有任何提交']
  const out = []
  if (l.ahead === null || l.behind === null) out.push('⚠ 没算出和 develop 差多少')
  else if (l.ahead > 0) out.push(`有 ${l.ahead} 个提交还没合进 develop`)
  else if (l.dirty === 0) out.push(l.behind > 0 ? '提交都已经在 develop 里，工作树可以拆了' : '刚开，还没有改动')
  if (l.behind > 0 && (l.ahead > 0 || l.dirty !== 0)) out.push(`develop 已经又往前走了 ${l.behind} 个提交`)
  if (l.dirty === null) out.push('⚠ 读不出有没有没提交的改动')
  else if (l.dirty > 0) out.push(`⚠ 有 ${l.dirty} 处改动还没提交`)
  if (l.detached) out.push('⚠ 没挂在分支上')
  return out
}

function printList() {
  const lanes = listWorktrees().map(describe)
  if (lanes.length === 0) console.log('现在没有在做的工作树。')
  for (const l of lanes) {
    console.log(`\n■ ${l.branch}`)
    if (l.note) console.log(`  状态：${l.note.split('\n')[0]}`)
    console.log(`  ${facts(l).join('；')}`)
    if (l.subject) console.log(`  最近一次提交：${l.when}，${l.subject}`)
    console.log(`  位置：${l.path}`)
    console.log(`  起来看：${command} ${l.branch}　　命令行：${cliCommand} ${l.branch}`)
  }
  console.log('')
}

function pick(query) {
  const q = query.toLowerCase()
  const lanes = listWorktrees().map(describe)
  const exact = lanes.filter((l) => l.branch.toLowerCase() === q || path.basename(path.dirname(l.path)).toLowerCase() === q)
  if (exact.length === 1) return exact[0]
  const hits = lanes.filter((l) => l.branch.toLowerCase().includes(q) || l.path.toLowerCase().includes(q))
  if (hits.length === 1) return hits[0]
  console.error(hits.length === 0 ? `没有找到「${query}」。现在的工作树：` : `「${query}」对上了不止一路，写得再具体一点：`)
  for (const l of hits.length ? hits : lanes) console.error(`  ${l.branch}`)
  process.exit(1)
}

function listening(host) {
  return new Promise((resolve) => {
    const socket = net.connect({ port: DEV_PORT, host })
    socket.setTimeout(1000, () => { socket.destroy(); resolve(false) })
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', () => resolve(false))
  })
}

// vite 默认监听 localhost，在 macOS 上可能只落在 ::1
async function refuseIfDevRunning() {
  const hits = await Promise.all(['127.0.0.1', '::1'].map(listening))
  if (hits.some(Boolean)) fail(`${DEV_PORT} 端口上已经有一个开发进程在跑（多半是主目录那个）。先在它的终端里按 Ctrl+C 关掉，再起这一路。`)
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function run(cmd, args, cwd, env = process.env) {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', env, shell: process.platform === 'win32' })
  if (r.status !== 0) process.exit(r.status ?? 1)
}

function prepareDeps(lane) {
  const modules = path.join(lane.path, 'node_modules')
  if (!fs.existsSync(modules)) {
    const setup = [lane.path, mainRepo].map((d) => path.join(d, '.cursor/setup-worktree-unix.sh')).find((p) => fs.existsSync(p))
    if (!setup || process.platform === 'win32') fail(`这棵树还没装依赖，请先在 ${lane.path} 里跑 npm install。`)
    console.log('这棵树还没备好依赖，先初始化……')
    run('bash', [setup], lane.path, { ...process.env, ROOT_WORKTREE_PATH: mainRepo })
    return
  }
  // 记下上次确认过的依赖清单；没有记录的当作现状就是对的，只补记
  const lock = path.join(lane.path, 'package-lock.json')
  if (!fs.existsSync(lock)) return
  const stamp = path.join(modules, LOCK_STAMP)
  const current = createHash('sha256').update(fs.readFileSync(lock)).digest('hex')
  const known = fs.existsSync(stamp) ? fs.readFileSync(stamp, 'utf8').trim() : current
  if (known !== current) {
    console.log('这一路的依赖有变动，先在这棵树里重新安装……')
    run(npm, ['install'], lane.path)
  }
  fs.writeFileSync(stamp, `${current}\n`)
}

function follow(child) {
  const forward = (sig) => child.kill(sig)
  process.on('SIGINT', forward)
  process.on('SIGTERM', forward)
  child.on('exit', (code) => process.exit(code ?? 0))
}

function warnDirty(lane) {
  if (lane.dirty > 0) console.log(`注意：这一路有 ${lane.dirty} 处改动还没提交，起来的版本包含它们。`)
}

async function startApp(query) {
  const lane = pick(query)
  await refuseIfDevRunning()
  prepareDeps(lane)
  await refuseIfDevRunning()
  warnDirty(lane)
  console.log(`起这一路：${lane.branch}（Ctrl+C 退出）`)
  follow(spawn(npm, ['run', 'dev'], { cwd: lane.path, stdio: 'inherit', shell: process.platform === 'win32' }))
}

// 命令行不占开发端口，和开着的开发版并存；从仓库跑默认进沙箱，不写桌面那份历史
function startCli(query, args) {
  const lane = pick(query)
  prepareDeps(lane)
  warnDirty(lane)
  console.log(`这一路的命令行：${lane.branch}\n`)
  follow(spawn(process.execPath, [path.join(lane.path, 'electron/cli/main.js'), ...args], { cwd: lane.path, stdio: 'inherit' }))
}

// 装一个不带 npm run 的短命令，指向主目录这份脚本，在哪个目录下敲都一样
function installShortcut() {
  if (process.platform === 'win32') fail('Windows 上先用 npm run review。')
  const dir = path.join(os.homedir(), '.local/bin')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(SHORTCUT, `#!/bin/sh\nexec node "${path.join(mainRepo, 'scripts/review.mjs')}" "$@"\n`, { mode: 0o755 })
  const onPath = (process.env.PATH ?? '').split(path.delimiter).includes(dir)
  console.log(`装好了：${SHORTCUT}`)
  console.log(onPath ? '以后直接敲 review、review <名字>、review --cli <名字>。' : `${dir} 不在 PATH 里，加进去之后才能直接敲 review。`)
}

const argv = process.argv.slice(2)
if (argv[0] === '--install') {
  installShortcut()
  process.exit(0)
}
const cliMode = argv[0] === '--cli'
const [name, ...rest] = cliMode ? argv.slice(1) : argv
if (!name) {
  if (cliMode) fail(`要说验哪一路：${cliCommand} <名字> [一句话]`)
  printList()
} else if (cliMode) startCli(name, rest)
else await startApp(name)
