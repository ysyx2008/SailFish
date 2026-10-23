/**
 * 命令行里模型手里有没有「界面上的工具」：真起命令行进程，假模型记下每次请求带来的工具清单。
 * 命令行没有窗口，所以没有产出物面板、没有终端窗格；本机命令、读写文件照旧。
 *
 *   node scripts/cli-e2e/surfaces.mjs
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { say, startMockLlm } from './mock-llm.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const CLI = path.join(ROOT, 'electron/cli/main.js')

const failures = []
const check = (label, pass, detail) => {
  if (pass) console.log(`  OK   ${label}`)
  else {
    failures.push(label)
    console.error(`  FAIL ${label}${detail ? ` — ${String(detail).slice(0, 400)}` : ''}`)
  }
}

const SURFACE_TOOLS = ['list_workbench_artifacts', 'manage_workbench_artifacts', 'manage_pane', 'list_ssh_sessions']

function run(args, env, cwd) {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let err = ''
    child.stderr.on('data', (chunk) => { err += chunk })
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000)
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, err }) })
  })
}

const dirs = []
const llm = await startMockLlm({ onUser: () => say('好的。'), onContinue: () => say('好的。') })
try {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sft-cli-surfaces-'))
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sft-cli-surfaces-cwd-'))
  dirs.push(dataDir, cwd)
  const env = {
    ...process.env,
    SFT_DATA_DIR: dataDir,
    SFT_CLI_NO_BORROW: '1',
    SFT_API_URL: `http://127.0.0.1:${llm.port}/v1`,
    SFT_API_KEY: 'sk-test',
    SFT_MODEL: 'mock',
    NO_COLOR: '1',
    TSX_TSCONFIG_PATH: path.join(ROOT, 'tsconfig.json'),
  }

  console.log('\n▶ 命令行里，模型的工具清单')
  const result = await run(['你好', '--free'], env, cwd)
  check('正常退出', result.code === 0, `exit ${result.code} ${result.err.slice(0, 300)}`)
  const first = llm.mainRequests()[0]
  const names = (first?.body.tools ?? []).map((t) => t.function?.name ?? t.name)
  check('收到了工具清单', names.length > 0, JSON.stringify(names))
  for (const name of SURFACE_TOOLS) check(`没有 ${name}`, !names.includes(name), names.join(','))
  check('本机命令还在', names.includes('exec') || names.includes('execute_command'), names.join(','))
  check('系统说明里不提产出物面板', !JSON.stringify(first?.body.messages).includes('产出物面板'))
} finally {
  await llm.close()
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true })
}

console.log(failures.length ? `\nRESULT FAIL (${failures.length})` : '\nRESULT PASS')
process.exit(failures.length ? 1 : 0)
