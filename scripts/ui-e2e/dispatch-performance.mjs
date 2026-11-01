/** 真实200人派工链路：本地假模型、静默临时窗口，图和名单均不展开。 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { launchApp } from './launch.mjs'
import { startMockLlm, callTool, say } from '../cli-e2e/mock-llm.mjs'

const count = 200
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'sft-dispatch-performance-'))
let dispatched = false
let children = 0
const check = (label, pass) => { if (!pass) throw Error(label); console.log(`OK ${label}`) }
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const llm = await startMockLlm({ respond(body) {
  if (!body.tools?.some(tool => tool.function?.name === 'dispatch_agents')) {
    children++
    const task = [...body.messages].reverse().find(message => message.role === 'user')?.content ?? ''
    const n = Number(/N=(\d+)/.exec(String(task))?.[1])
    return say(`编号=${n}\n结果=${n * 3 + 7}`)
  }
  if (dispatched) return say('全部成员已完成。')
  dispatched = true
  return callTool('dispatch_agents', { batch: { instruction: '计算N*3+7，返回编号和结果两行，不使用工具。', items: Array.from({ length: count }, (_, i) => ({ name: `calc-${i}`, description: '计算', input: `N=${1001 + i}` })) } })
} })
const app = await launchApp(data)
const page = await app.firstWindow()
page.setDefaultTimeout(20000)
try {
  await page.waitForFunction(() => window.electronAPI?.config)
  await page.evaluate(async port => {
    await window.electronAPI.config.setSetupCompleted(true)
    await window.electronAPI.config.setAiProfiles([{ id: 'fixture', name: 'fixture', apiUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'x', model: 'fixture', contextLength: 128000 }])
    await window.electronAPI.config.setActiveAiProfile('fixture')
  }, llm.port)
  await page.reload()
  await page.waitForFunction(() => document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('terminal'))
  await page.evaluate(() => {
    const store = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('terminal')
    const id = store.createAssistantTab({ title: '200人真实派工性能验证' })
    store.markAssistantSkipOnboarding(id)
    store.focusHubConversation(id)
    // 覆盖已有多队历史的会话，不依赖用户真实数据。
    const steps = []
    for (let i = 0; i < 8; i++) {
      steps.push({ id: `history-task-${i}`, type: 'user_task', content: '已完成的历史任务', timestamp: Date.now() })
      const members = Array.from({ length: 8 }, (_, j) => ({ id: `old-${i}-${j}`, name: `旧成员${i}-${j}`, teamId: `old-${i}`, description: '历史计算', status: 'completed' }))
      steps.push({ id: `history-dispatch-${i}`, type: 'tool_call', toolName: 'dispatch_agents', content: '历史派工', timestamp: Date.now(), subAgents: members, organization: { teamId: `old-${i}`, members, teams: [], total: 8, live: 0 } })
    }
    store.restoreAgentHistory(id, { id: 'perf-history', timestamp: Date.now(), userTask: '历史任务', steps, duration: 1, status: 'completed' })
    window.__dispatchPerf = { store, id, events: 0, frames: [], longTasks: [], bulkUpdates: 0 }
  })
  await pause(1500)
  for (let i = 0; i < 4; i++) { const dialog = page.locator('.confirm-overlay button:visible').last(); if (await dialog.count()) await dialog.click({ force: true, timeout: 1000 }).catch(() => {}); await pause(100) }
  await page.evaluate(() => {
    const p = window.__dispatchPerf
    let last = performance.now()
    const frame = now => { p.frames.push(now - last); last = now; p.raf = requestAnimationFrame(frame) }
    p.raf = requestAnimationFrame(frame)
    p.observer = new PerformanceObserver(entries => p.longTasks.push(...entries.getEntries().map(entry => entry.duration)))
    p.observer.observe({ entryTypes: ['longtask'] })
    p.off = window.electronAPI.agent.onStep(({ step }) => {
      p.events++
      if (step.subAgents?.length === 200) { p.bulkUpdates++; p.latest = step.subAgents }
    })
  })
  await app.evaluate(() => { const delay = process.getBuiltinModule('node:perf_hooks').monitorEventLoopDelay({ resolution: 10 }); delay.enable(); globalThis.__dispatchPerfDelay = delay })
  const started = performance.now()
  await page.evaluate(data => {
    const p = window.__dispatchPerf
    const tab = p.store.tabs.find(tab => tab.id === p.id)
    p.promise = window.electronAPI.agent.say({ agentKey: tab.agentId, surface: 'assistant', message: '同时派出200人计算', context: { terminalOutput: [], systemInfo: { os: 'darwin', shell: '/bin/zsh' }, terminalType: 'assistant', cwd: data }, config: { executionMode: 'free', maxSteps: 30 } }).then(result => { p.result = result }).catch(error => { p.error = String(error) })
  }, data)
  await page.waitForFunction(() => window.__dispatchPerf.bulkUpdates > 0)
  const input = page.locator('.assistant-chat [contenteditable="true"]').first()
  const inputStarted = performance.now()
  await input.fill('派工期间的未发送草稿')
  const inputRoundTripMs = performance.now() - inputStarted
  await page.waitForFunction(() => {
    const p = window.__dispatchPerf
    return p.error || (p.result && !p.store.tabs.find(tab => tab.id === p.id)?.agentState?.isRunning && p.latest?.every(member => member.status === 'completed'))
  }, undefined, { timeout: 60000 })
  const elapsedMs = performance.now() - started
  const main = await app.evaluate(() => { const delay = globalThis.__dispatchPerfDelay; delay.disable(); return { maxMs: delay.max / 1e6, p99Ms: delay.percentile(99) / 1e6 } })
  const stats = await page.evaluate(() => { const p = window.__dispatchPerf; cancelAnimationFrame(p.raf); p.observer.disconnect(); p.off(); return { events: p.events, frames: p.frames, longTasks: p.longTasks, bulkUpdates: p.bulkUpdates, result: p.result, error: p.error } })
  const records = []
  const root = path.join(data, 'history', 'sub-agents')
  for (const date of fs.readdirSync(root)) for (const session of fs.readdirSync(path.join(root, date))) for (const member of fs.readdirSync(path.join(root, date, session))) {
    const file = path.join(root, date, session, member, 'state.json')
    if (fs.existsSync(file)) records.push(JSON.parse(fs.readFileSync(file, 'utf8')))
  }
  check('200人全部真实请求并写下完成状态', children === count && records.length === count && records.every(record => record.status === 'completed'))
  check('各人的两行计算结果准确', records.every(record => { const n = 1001 + Number(record.name.slice('calc-'.length)); return record.result === `编号=${n}\n结果=${n * 3 + 7}` }))
  check('图和名单关闭时不挂载成员内容', await page.locator('.org-node, .tmt-member').count() === 0)
  check('进度更新期间输入的草稿完整保留', await input.innerText() === '派工期间的未发送草稿')
  check('完成更新受时间窗口约束，不逐人推送整队', stats.bulkUpdates <= Math.ceil(elapsedMs / 250) + 5)
  check('主人正常收到结果并收工', !stats.error && stats.result?.success)
  const p95 = values => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1] : 0
  console.log('PERF ' + JSON.stringify({ count, elapsedMs: Math.round(elapsedMs), ipcEvents: stats.events, bulkUpdates: stats.bulkUpdates, inputRoundTripMs: Math.round(inputRoundTripMs), mainMaxMs: Math.round(main.maxMs), mainP99Ms: Math.round(main.p99Ms), frameP95Ms: Math.round(p95(stats.frames)), frameMaxMs: Math.round(Math.max(0, ...stats.frames)), rendererLongTasks: stats.longTasks.length }))
  console.log('RESULT PASS')
} finally {
  await llm.close()
  const timer = setTimeout(() => app.process()?.kill('SIGKILL'), 5000)
  try { await app.close().catch(() => {}) } finally { clearTimeout(timer) }
  fs.rmSync(data, { recursive: true, force: true })
}
