/**
 * 关切数据完整性端到端：真实后端进程、持久化、Gateway、传感器、Agent 和文件工具。
 * 模型为本机脚本服务；HTTP 探针访问本机合成网页，命令只读取临时文件。
 * node scripts/cli-e2e/watch-integrity.mjs；E2E_KEEP=1 保留测试目录。
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { startMockLlm, callTool, say } from './mock-llm.mjs'
import { ROOT, sandbox, runPlain, makeChecker } from './harness.mjs'
const { failures, check } = makeChecker()
const dirs = []
const snapshots = []
const toolResults = []
const longState = { body: '第一行\n'.repeat(1800) + 'LONG_STATE_TAIL' }
const fingerprintTail = 'STATE_TAIL_1437!'
const expectedState = { fingerprint: '指纹'.repeat(720).slice(0, 1437 - fingerprintTail.length) + fingerprintTail, nested: { version: 1 }, items: ['a', 'b'] }
const textOf = m => typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? '')
const readPointer = (text, name) => {
  const match = text.match(/(?:已保存到|saved to): ([^\n]+\.txt)/)
  if (!match) return say('CHECKED')
  const field = name.startsWith('COMMAND_') ? 'output' : name.startsWith('HTTP_') ? 'body' : undefined
  if (field) {
    const lines = fs.readFileSync(match[1], 'utf8').split('\n')
    const line = lines.findIndex(value => value.trimStart().startsWith(`"${field}":`)) + 1
    if (line) return callTool('read_file', { path: match[1], start_line: line, end_line: line })
  }
  return callTool('read_file', { path: match[1], tail_lines: 12 })
}
const llm = await startMockLlm({
  usage: () => ({ prompt_tokens: 1200, completion_tokens: 100 }),
  jsonForNonStream: true,
  onUser(text) {
    const name = text.match(/CASE:([A-Z_]+)/)?.[1] ?? 'OTHER'
    snapshots.push({ name, text })
    if (name === 'STATE_OVERSIZE') return callTool('watch_state_update', { watch_id: text.match(/WATCH_ID:(\S+)/)[1], watch_state: { tooLarge: 'x'.repeat(66000) } })
    if (name === 'STATE_LONG_WRITE') return callTool('watch_state_update', { watch_id: text.match(/WATCH_ID:(\S+)/)[1], watch_state: longState })
    if (name === 'STATE_WRITE') return callTool('watch_state_update', { watch_id: text.match(/WATCH_ID:(\S+)/)[1], watch_state: expectedState })
    return readPointer(text, name)
  },
  afterTool(last, entry) {
    const task = [...entry.body.messages].reverse().find(m => m.role === 'user' && textOf(m).includes('CASE:'))
    const name = textOf(task).match(/CASE:([A-Z_]+)/)?.[1]
    toolResults.push({ name, text: textOf(last) })
    const previousCall = [...entry.body.messages].reverse().find(m => m.tool_calls)?.tool_calls?.[0]
    if (name?.startsWith('COMMAND_') && previousCall?.function?.name === 'read_file') {
      const args = JSON.parse(previousCall.function.arguments)
      const lines = fs.readFileSync(args.path, 'utf8').split('\n')
      const stderrLine = lines.findIndex(value => value.trimStart().startsWith('\"stderr\":')) + 1
      if (stderrLine && args.end_line !== stderrLine) return callTool('read_file', { path: args.path, start_line: stderrLine, end_line: stderrLine })
    }
    return say('CHECKED')
  },
})
let changed = false
let oversized = false
const probeCounts = {}
let restoreCounts = {}
const probe = http.createServer((req, res) => {
  if (req.url === '/oversize') { oversized = true; res.end('ok'); return }
  if (req.url === '/restore') { restoreCounts = { ...probeCounts }; oversized = false; res.end('ok'); return }
  if (req.url === '/first-failure' && !changed) { res.destroy(); return }
  if (req.url === '/slow') { res.writeHead(200); res.flushHeaders(); const timer = setTimeout(() => res.end('late'), 1000); res.once('close', () => clearTimeout(timer)); return }
  if (req.url.startsWith('/body')) probeCounts[req.url] = (probeCounts[req.url] ?? 0) + 1
  if (oversized) { res.end('汉'.repeat(400000)); return }
  if (req.url === '/advance') { changed = true; res.end('ok'); return }
  res.end('x'.repeat(9000) + (changed ? 'TAIL_NEW' : 'TAIL_OLD'))
})
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
const free = http.createServer()
await new Promise(resolve => free.listen(0, '127.0.0.1', resolve))
const gatewayPort = free.address().port
await new Promise(resolve => free.close(resolve))
const env = sandbox(llm.port, 'sft-watch-integrity', dirs)
env.env.PROBE_URL = `http://127.0.0.1:${probe.address().port}`
env.env.GATEWAY_PORT = String(gatewayPort)
fs.writeFileSync(path.join(env.cwd, 'command.txt'), 'x'.repeat(70000) + 'TAIL_OLD')
fs.writeFileSync(path.join(env.cwd, 'emit.cjs'), "process.stdout.write(require('fs').readFileSync(require('path').join(__dirname, 'command.txt'))); process.stderr.write('诊断'.repeat(1000) + 'STDERR_TAIL'); require('fs').appendFileSync(require('path').join(__dirname, 'ticks-' + (process.argv[2] || 'default') + '.txt'), '1')\n")
const runner = path.join(ROOT, 'scripts/cli-e2e/watch-integrity-runner.cjs')
const phase = async name => {
  const r = await runPlain([], { ...env, env: { ...env.env, PHASE: name } }, 120000, runner)
  check(`${name}: 后端正常退出`, r.code === 0, r.err.slice(-1500) + r.out.slice(-1000))
  const line = r.out.split('\n').find(l => l.startsWith('RESULT_PATH '))
  if (process.env.E2E_SHOW) console.log(r.out, r.err)
  if (!line) return {}
  return JSON.parse(fs.readFileSync(line.slice(12), 'utf8'))
}
try {
  check('复现输入的指纹正好 1437 字符', expectedState.fingerprint.length === 1437)
  const seed = await phase('seed')
  check('状态工具保存完整字符串、嵌套对象与数组', JSON.stringify(seed.state) === JSON.stringify(expectedState), String(JSON.stringify(seed.state)).slice(-300))
  check('超限状态明确失败', toolResults.some(r => r.name === 'STATE_OVERSIZE' && r.text.includes('超过') && r.text.includes('未保存')))
  check('导入超限状态明确失败且整份旧数据未变', seed.importRejected === true && seed.importKept === true)
  check('拒绝超限写入后旧状态未变', JSON.stringify(seed.afterRejected) === JSON.stringify(expectedState))
  check('长状态原文保存在持久状态中', JSON.stringify(seed.longState) === JSON.stringify(longState))
  check('长状态经现有 read_file 取回尾部', toolResults.some(r => r.name === 'STATE_LONG_READ' && r.text.includes('LONG_STATE_TAIL')))
  const resumed = await phase('resume')
  check('重启后持久状态逐字一致', JSON.stringify(resumed.state) === JSON.stringify(expectedState))
  const statePrompt = snapshots.find(s => s.name === 'STATE_READ')?.text ?? ''
  check('下一轮模型看到完整状态', statePrompt.includes('STATE_TAIL_1437!') && statePrompt.includes('version') && statePrompt.includes('items'))
  const beforeFault = snapshots.length
  const fault = await phase('faults')
  check('完整快照落盘失败时关切明确失败', fault.failed?.success === false && ['EEXIST', 'ENOTDIR'].includes(fault.failed?.errorCode))
  check('快照失败没有改写持久状态', fault.stateKept === true)
  check('快照失败没有把残文送给模型', !snapshots.slice(beforeFault).some(s => s.name === 'SNAPSHOT_FAILURE'))
  check('磁盘恢复后新的关切可正常读取完整快照', fault.recovered?.success === true && toolResults.some(r => r.name === 'SNAPSHOT_RECOVERED' && r.text.includes('RECOVERED_TAIL')))
  const beforeStop = snapshots.length
  const lifecycle = await phase('lifecycle')
  check('快照写入期间停止后本轮明确跳过', lifecycle.stopped?.skipped === true)
  check('停止后不再向模型发起新执行', !snapshots.slice(beforeStop).some(s => s.name === 'STOP_DURING_SNAPSHOT'))
  check('技能预加载期间停止后本轮明确跳过', lifecycle.preloadStopped?.skipped === true)
  check('预加载完成后也不会迟到启动模型', !snapshots.slice(beforeStop).some(s => s.name === 'STOP_DURING_PRELOAD'))
  const beforeCancel = snapshots.length
  const cancel = await phase('cancel')
  check('单条关切在快照期间取消确实生效', cancel.snapshotAccepted && cancel.snapshotCancelled)
  check('单条关切在技能预加载期间取消确实生效', cancel.preloadAccepted && cancel.preloadCancelled)
  check('单条取消后不再迟到启动模型', !snapshots.slice(beforeCancel).some(s => s.name.startsWith('CANCEL_')))
  const restart = await phase('restart')
  check('旧执行晚到结算不覆盖新一轮 running', restart.oldSkipped && restart.newStillRunning)
  check('旧执行不发出过期完成事件', restart.noOldCompletion === true)
  check('新一轮能正常完成并只发一次完成事件', restart.newCompleted === true)
  check('旧执行仍完整记入审计历史', restart.oldAudited === true)
  const beforeReplacement = snapshots.length
  const probes = await phase('probe-lifecycle')
  check('spawn 与 exec 更换目标后均无旧进程伪事件', probes.replacementEvents?.length === 2 && probes.replacementEvents.every(item => item.count === 0))
  check('更换目标不产生伪关切执行', !snapshots.slice(beforeReplacement).some(s => s.name.startsWith('REPLACED_')))
  check('孙进程持有管道时超限仍明确失败', probes.pipeFailure === true)
  check('孙进程持有管道不会拖住超限收尾', probes.pipeFinalizedPromptly === true)
  const events = await phase('events')
  for (const name of ['HTTP_CHANGED', 'HTTP_REGEX', 'COMMAND_CHANGED', 'COMMAND_SHELL_CHANGED']) {
    check(`${name}: 尾部变化触发真实关切执行`, snapshots.some(s => s.name === name))
  }
  check('HTTP 超容量（按字节）明确报告失败', events.failures?.some(e => e.type === 'http_probe' && e.payload.errorCode === 'OUTPUT_LIMIT_EXCEEDED'))
  for (const kind of ['status', 'firstStatus']) check(`${kind}: HTTP 失败后恢复仍触发状态变化关切`, events.events?.some(e => e.watchId === events.probeIds?.[kind] && !e.payload.checkFailed && e.payload.status === 200))
  check('HTTP 超时覆盖响应体读取', events.events?.some(e => e.type === 'http_probe' && e.payload.url.endsWith('/slow') && e.payload.checkFailed))
  for (const kind of ['command', 'shell']) check(`${kind}: 超容量明确报告失败`, events.failures?.some(e => e.watchId === events.probeIds?.[kind] && e.payload.errorCode === 'OUTPUT_LIMIT_EXCEEDED'))
  check('恢复窗口内两种命令探针确实继续轮询', events.recoveryPolled === true)
  check('恢复窗口内 HTTP 变化探针确实继续轮询', probeCounts['/body-changed'] > (restoreCounts['/body-changed'] ?? Infinity))
  check('超限之前三种变化探针均已建立有效基线并触发', events.establishedChanges === 3)
  check('超容量失败没有污染变化比较基线', events.baselinePreserved === true)
  check('真实 HTTP Webhook 被接收', events.webhookStatus === 200)
  const pointerFiles = [...new Set(snapshots.flatMap(s => [...s.text.matchAll(/(?:已保存到|saved to): ([^\n]+\.txt)/g)].map(m => m[1])))].map(file => JSON.parse(fs.readFileSync(file, 'utf8')))
  check('HTTP 快照保存完整正文', pointerFiles.some(p => p.body === 'x'.repeat(9000) + 'TAIL_NEW'))
  check('命令快照保存完整 stderr', pointerFiles.some(p => p.stderr === '诊断'.repeat(1000) + 'STDERR_TAIL'))
  check('命令快照保存完整正文', pointerFiles.some(p => p.output === 'x'.repeat(70000) + 'TAIL_NEW'))
  check('Webhook 快照保存完整 JSON', pointerFiles.some(p => p.padding === 'x'.repeat(6000) && p.tail === 'WEBHOOK_TAIL'))
  check('批量快照保存全部 25 条事件', pointerFiles.some(p => p.events?.length === 25 && p.events.every((e, i) => e.payload.subject === `EVENT_${i}`)))
  const modelText = name => [...snapshots, ...toolResults].filter(s => s.name === name).map(s => s.text).join('\n')
  check('Webhook 尾部字段进入模型可见内容', modelText('WEBHOOK').includes('WEBHOOK_TAIL'))
  check('第 25 条批量事件进入模型可见内容', modelText('BATCH').includes('EVENT_24'))
  for (const name of ['HTTP_CHANGED', 'HTTP_REGEX', 'COMMAND_CHANGED', 'COMMAND_SHELL_CHANGED']) check(`${name}: 尾部正文可读取`, modelText(name).includes('TAIL_NEW'))
  check('命令 stderr 超过旧上限的尾部可读取', modelText('COMMAND_CHANGED').includes('STDERR_TAIL'))
} finally {
  fs.writeFileSync(path.join(env.dataDir, 'evidence.json'), JSON.stringify({ snapshots, toolResults, failures }, null, 2))
  await llm.close()
  probe.closeAllConnections()
  await new Promise(resolve => probe.close(resolve))
  if (!process.env.E2E_KEEP) for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true })
  else console.log('测试目录：', dirs)
}
if (failures.length) { console.error(`\n${failures.length} 项未通过`); process.exitCode = 1 }
else console.log('\n全部通过')
