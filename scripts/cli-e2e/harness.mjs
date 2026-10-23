/**
 * 命令行端到端共用的小工具：临时数据目录、真起命令行进程、伪终端。
 * 每个场景一个临时数据目录，不碰桌面真实数据，也不借用桌面的模型配置。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const CLI = path.join(ROOT, 'electron/cli/main.js')

export const clean = (raw) => raw
  .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
  .replace(/\x1b\][^\x07]*\x07/g, '')
  .replace(/\r/g, '')

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 等到 check() 成立；超时返回 false */
export async function until(check, timeout = 30_000, step = 50) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return true
    await sleep(step)
  }
  return !!(await check())
}

/** 结果记账：通过打 OK，不通过记进 failures */
export function makeChecker() {
  const failures = []
  const check = (label, pass, detail) => {
    if (pass) console.log(`  OK   ${label}`)
    else {
      failures.push(detail ? `${label} — ${detail}` : label)
      console.error(`  FAIL ${label}${detail ? ` — ${String(detail).slice(0, 600)}` : ''}`)
    }
  }
  return { failures, check }
}

/** 一个场景一个临时数据目录和工作目录；环境指向假模型 */
export function sandbox(port, prefix, tempDirs) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`))
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-cwd-`))
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

/** 没有终端的一次性运行（管道、脚本里的样子）。返回的 child 可以拿去强杀 */
export function startPlain(args, { env, cwd }, file = CLI) {
  const child = spawn('node', [file, ...args], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  let err = ''
  child.stdout.on('data', (chunk) => { out += chunk })
  child.stderr.on('data', (chunk) => { err += chunk })
  const done = new Promise((resolve) => {
    child.on('close', (code, signal) => resolve({ code, signal, out: clean(out), err }))
  })
  return { child, done, output: () => clean(out) }
}

export function runPlain(args, sandboxInfo, timeoutMs = 120_000, file = CLI) {
  const run = startPlain(args, sandboxInfo, file)
  const timer = setTimeout(() => run.child.kill('SIGKILL'), timeoutMs)
  return run.done.finally(() => clearTimeout(timer))
}

/** 伪终端：像人坐在终端前那样敲字、按 Ctrl+C */
export class Terminal {
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
    const found = () => (needle instanceof RegExp ? needle.test(this.since(from)) : this.since(from).includes(needle))
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (found()) return true
      if (this.exitCode !== undefined) return found()
      await sleep(100)
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
      await Promise.race([this.exited, sleep(3000)])
    }
  }
}
