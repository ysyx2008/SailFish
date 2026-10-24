/**
 * 真实模型走一遍「人点名压缩」：确认接口接受按窗口算出的输出额度、小结真能写出来、
 * 压完之后模型还答得出被收走的细节。会花真实 token（几千），所以不并进 summary-budget.mjs。
 *
 *   node scripts/cli-e2e/summary-budget-real.mjs                 # 用沙箱借来的当前配置
 *   node scripts/cli-e2e/summary-budget-real.mjs <profileId>     # 指定桌面里的某个配置
 *   E2E_MAX_OUTPUT=400 …                                          # 把这个模型的单次输出收紧到这么多 token：小结会真的被截断，走补写
 *   E2E_KEEP=1 …                                                  # 保留临时目录（看落盘的小结）
 *
 * 沙箱借桌面的 AI 配置与凭据，不写桌面真实历史。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ROOT, makeChecker, runPlain } from './harness.mjs'

const { failures, check } = makeChecker()
const profileId = process.argv[2]
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sft-summary-real-'))
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sft-summary-real-cwd-'))

fs.writeFileSync(path.join(cwd, 'A.txt'), [
  '# 部署记录 A',
  '服务名：aurora-gateway',
  '监听端口：48213',
  '配置文件：/etc/aurora/gateway-7f3c.yaml',
  '发布窗口：每周四 02:30',
  ...Array.from({ length: 80 }, (_, i) => `备注 ${i + 1}：这一行是无关的填充内容，用来让文件长一些。`),
].join('\n'))
fs.writeFileSync(path.join(cwd, 'B.txt'), [
  '# 部署记录 B',
  '服务名：borealis-worker',
  '日志目录：/var/log/borealis/run-9e21',
  '并发上限：37',
  '回滚命令：borealis rollback --to previous --keep-data',
  ...Array.from({ length: 80 }, (_, i) => `备注 ${i + 1}：这一行同样是无关的填充内容。`),
].join('\n'))

const env = {
  ...process.env,
  SFT_DATA_DIR: dataDir,
  NO_COLOR: '1',
  TSX_TSCONFIG_PATH: path.join(ROOT, 'tsconfig.json'),
  REAL_MODEL: '1',
  ...(profileId ? { REAL_PROFILE_ID: profileId } : {}),
  ...(process.env.E2E_MAX_OUTPUT ? { MAX_OUTPUT_TOKENS: process.env.E2E_MAX_OUTPUT } : {}),
  STEPS: JSON.stringify([
    { say: `请读 ${path.join(cwd, 'A.txt')} 和 ${path.join(cwd, 'B.txt')}，各用一句话告诉我这两个服务是什么。` },
    { compact: true, hint: '重点留下端口、路径、命令这类具体数值' },
    { say: 'aurora-gateway 监听哪个端口、配置文件路径是什么？borealis-worker 的日志目录和回滚命令呢？只回答这四项具体值。' },
  ]),
}
delete env.SFT_CLI_NO_BORROW

console.log(`数据目录：${dataDir}`)
const started = Date.now()
const result = await runPlain([], { env, cwd }, 600_000, path.join(ROOT, 'scripts/cli-e2e/compact-runner.cjs'))
console.log(`（${((Date.now() - started) / 1000).toFixed(1)}s）`)
if (process.env.E2E_SHOW) console.log(`${result.out}\n${result.err}`.split('\n').filter((l) => /Compaction|ompress|cut at|continu|User compact|FINAL|COMPACT_RESULT|借用/.test(l)).join('\n'))

check('跑完没报错', result.out.includes('RUNNER_DONE'), `${result.out.slice(-300)} ${result.err.slice(-600)}`)
const compact = result.out.split('\n').find((l) => l.startsWith('COMPACT_RESULT '))
const compactResult = compact ? JSON.parse(compact.slice(15)) : undefined
check('人点名压缩成功', compactResult?.ok === true, compact)
if (compactResult?.ok) console.log(`  压缩前后：${compactResult.beforeTokens} → ${compactResult.afterTokens} token（释放 ${compactResult.freedTokens}）`)

// 找落盘的小结：整场会话目录里带「早期对话已压缩」的那条
const sessionRoot = path.join(dataDir, 'history', 'agent')
let summary
const walk = (dir) => {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    if (fs.statSync(p).isDirectory()) walk(p)
    else if (!summary && /\.(json|jsonl)$/.test(name)) {
      const txt = fs.readFileSync(p, 'utf8')
      const at = txt.indexOf('早期对话已压缩')
      if (at >= 0) summary = txt.slice(at, at + 6000)
    }
  }
}
if (fs.existsSync(sessionRoot)) walk(sessionRoot)
check('落盘里找得到压缩后的小结', !!summary)
if (summary) {
  const text = summary.replace(/\\n/g, '\n')
  console.log(`  小结开头：${text.slice(0, 400).replace(/\n/g, ' ⏎ ')}`)
  const facts = ['48213', '/etc/aurora/gateway-7f3c.yaml', '/var/log/borealis/run-9e21', 'borealis rollback --to previous --keep-data']
  const kept = facts.filter((f) => summary.includes(f))
  console.log(`  小结里留下了 ${kept.length}/${facts.length} 项具体值`)
  check('小结没有停在半句话上就被截断（以标点或结束符收尾，或至少有一定长度）', summary.length > 200)
}
const finals = result.out.split('\n').filter((l) => l.startsWith('FINAL '))
const lastFinal = finals.at(-1) ? JSON.parse(finals.at(-1).slice(6)) : ''
console.log(`  压完后的回答：${String(lastFinal).replace(/\n/g, ' ⏎ ').slice(0, 400)}`)
for (const fact of ['48213', '/etc/aurora/gateway-7f3c.yaml', '/var/log/borealis/run-9e21', 'borealis rollback --to previous --keep-data']) {
  check(`压完后仍答得出：${fact}`, String(lastFinal).includes(fact))
}

if (!process.env.E2E_KEEP) for (const d of [dataDir, cwd]) fs.rmSync(d, { recursive: true, force: true })
if (failures.length) {
  console.error(`\n${failures.length} 项没过：`)
  for (const f of failures) console.error(`  - ${f.slice(0, 400)}`)
  process.exit(1)
}
console.log('\n全部通过')
