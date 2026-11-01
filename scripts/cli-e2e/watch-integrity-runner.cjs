/* eslint-env node */
/** 真后端进程，隔离数据；由 watch-integrity.mjs 驱动。 */
'use strict'
const Module = require('module')
const path = require('path')
const fs = require('fs')
const ROOT = path.resolve(__dirname, '../..')
const originalResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron' || request === 'electron-updater') return path.join(ROOT, 'electron/cli/electron-shim.js')
  return originalResolve.call(this, request, ...rest)
}
process.env.SFT_CLI_MODE = '1'
require('tsx/cjs')
require(path.join(ROOT, 'electron/cli/cli-data.js')).setupCliDataDir({ defaultSandbox: true })
const load = name => require(path.join(ROOT, 'electron/services', name))
const { ConfigService, setConfigServiceInstance } = load('config.service')
const { AiService } = load('ai.service')
const { AgentService } = load('agent')
const { getWatchService } = load('watch/watch.service')
const { getSensorService } = load('sensor')
const { HistoryService } = load('history.service')
const { PtyService } = load('pty.service')
const { HostProfileService } = load('host-profile.service')
const { McpService } = load('mcp.service')
const { SshService } = load('ssh.service')
const { getEventBus } = load('sensor/event-bus')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check, timeout = 20000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (check()) return; await sleep(50) }
  throw new Error('等待真实关切执行超时')
}
async function main() {
  const config = new ConfigService()
  setConfigServiceInstance(config)
  config.setAiProfiles([{ id: 'test', name: 'test', apiUrl: process.env.SFT_API_URL, apiKey: 'sk-test', model: 'mock', contextLength: 128000, maxOutputTokens: 4096 }])
  config.setActiveAiProfile('test')
  const history = new HistoryService()
  const ai = new AiService(config)
  const sensor = getSensorService()
  const pty = new PtyService()
  const agent = new AgentService(ai, pty, new HostProfileService(), new McpService(), config, new SshService())
  agent.setHistoryService(history)
  const watch = getWatchService()
  watch.init({ configService: config, aiService: ai, agentService: agent, sensorService: sensor, historyService: history, mainWindow: null })
  const create = (name, trigger = { type: 'manual' }) => {
    const w = watch.create({ name, prompt: `CASE:${name}`, triggers: [trigger], skills: ['watch'], execution: { type: 'local' }, output: { type: 'silent' } })
    watch.update(w.id, { prompt: `CASE:${name} WATCH_ID:${w.id}` })
    return w.id
  }
  const results = {}
  if (process.env.PHASE === 'seed') {
    const id = create('STATE_WRITE')
    await watch.start()
    { const r = await watch.triggerWatch(id); results.run = { success: r.success, error: r.error } }
    results.state = watch.get(id).state
    watch.update(id, { prompt: `CASE:STATE_OVERSIZE WATCH_ID:${id}` })
    await watch.triggerWatch(id)
    results.afterRejected = watch.get(id).state
    const { getWatchStore } = load('watch/store')
    const store = getWatchStore()
    const beforeImport = store.exportData()
    try {
      store.importData({ ...beforeImport, watches: beforeImport.watches.map(w => w.id === id ? { ...w, state: { tooLarge: 'x'.repeat(66000) } } : w) })
      results.importRejected = false
    } catch { results.importRejected = true }
    results.importKept = JSON.stringify(store.exportData()) === JSON.stringify(beforeImport)
    const big = create('STATE_LONG_WRITE')
    await watch.triggerWatch(big)
    watch.update(big, { prompt: `CASE:STATE_LONG_READ WATCH_ID:${big}` })
    await watch.triggerWatch(big)
    results.longState = watch.get(big).state
    fs.writeFileSync(path.join(process.env.SFT_DATA_DIR, 'test-id.json'), JSON.stringify({ id }))
  } else if (process.env.PHASE === 'resume') {
    const { id } = JSON.parse(fs.readFileSync(path.join(process.env.SFT_DATA_DIR, 'test-id.json'), 'utf8'))
    results.state = watch.get(id).state
    await watch.start()
    watch.update(id, { prompt: `CASE:STATE_READ WATCH_ID:${id}` })
    { const r = await watch.triggerWatch(id); results.run = { success: r.success, error: r.error } }
  } else if (process.env.PHASE === 'faults') {
    const id = create('SNAPSHOT_FAILURE')
    watch.updateWatchState(id, { body: '正文\n'.repeat(2000) + 'RECOVERED_TAIL' })
    await watch.start()
    const { getScratchPath } = load('agent/workspace-paths')
    const outputDir = path.join(getScratchPath(), 'watch-context')
    const backupDir = outputDir + '-test-backup'
    if (fs.existsSync(outputDir)) fs.renameSync(outputDir, backupDir)
    fs.writeFileSync(outputDir, '测试专用阻塞文件')
    const failed = await watch.triggerWatch(id)
    results.failed = { success: failed.success, error: failed.error, errorCode: failed.errorCode }
    results.stateKept = watch.get(id).state.body === '正文\n'.repeat(2000) + 'RECOVERED_TAIL'
    fs.unlinkSync(outputDir)
    if (fs.existsSync(backupDir)) fs.renameSync(backupDir, outputDir)
    // 新关切不受刚才失败的熔断影响，用来验证 IO 恢复后的完整链路。
    const recovered = create('SNAPSHOT_RECOVERED')
    watch.updateWatchState(recovered, { body: '正文\n'.repeat(2000) + 'RECOVERED_TAIL' })
    const good = await watch.triggerWatch(recovered)
    results.recovered = { success: good.success, error: good.error }
  } else if (process.env.PHASE === 'lifecycle') {
    const id = create('STOP_DURING_SNAPSHOT')
    watch.updateWatchState(id, { body: '正文\n'.repeat(2000) + 'STOP_SNAPSHOT_TAIL' })
    await watch.start()
    const writeFile = fs.promises.writeFile
    let entered = false
    let release
    const gate = new Promise(resolve => { release = resolve })
    // 只延迟本次状态快照写入；其余 IO 与后端流程保持真实实现。
    fs.promises.writeFile = async function (...args) {
      if (String(args[0]).includes('watch-state-')) { entered = true; await gate }
      return writeFile.apply(this, args)
    }
    try {
      const pending = watch.triggerWatch(id)
      await until(() => entered)
      watch.stop()
      release()
      const result = await pending
      results.stopped = { success: result.success, skipped: result.skipped, skipReason: result.skipReason }
    } finally {
      release()
      fs.promises.writeFile = writeFile
    }
    await watch.start()
    const preloadId = create('STOP_DURING_PRELOAD')
    const preload = agent.preloadSkills
    let preloading = false
    let releasePreload
    const preloadGate = new Promise(resolve => { releasePreload = resolve })
    agent.preloadSkills = async function (...args) {
      preloading = true
      await preloadGate
      return preload.apply(this, args)
    }
    try {
      const pending = watch.triggerWatch(preloadId)
      await until(() => preloading)
      watch.stop()
      releasePreload()
      const result = await pending
      results.preloadStopped = { success: result.success, skipped: result.skipped }
    } finally {
      releasePreload()
      agent.preloadSkills = preload
    }
  } else if (process.env.PHASE === 'cancel') {
    await watch.start()
    const id = create('CANCEL_SNAPSHOT')
    watch.updateWatchState(id, { body: '取消快照'.repeat(1500) })
    const writeFile = fs.promises.writeFile
    let entered = false
    let release
    const gate = new Promise(resolve => { release = resolve })
    fs.promises.writeFile = async function (...args) {
      if (String(args[0]).includes('watch-state-')) { entered = true; await gate }
      return writeFile.apply(this, args)
    }
    try {
      const pending = watch.triggerWatch(id)
      await until(() => entered)
      results.snapshotAccepted = watch.cancelRunningWatch(id)
      release()
      const r = await pending
      results.snapshotCancelled = r.skipped && r.skipReason === 'cancelled'
    } finally { release(); fs.promises.writeFile = writeFile }
    const preloadId = create('CANCEL_PRELOAD')
    const preload = agent.preloadSkills
    let preloading = false
    let releasePreload
    const preloadGate = new Promise(resolve => { releasePreload = resolve })
    agent.preloadSkills = async function (...args) { preloading = true; await preloadGate; return preload.apply(this, args) }
    try {
      const pending = watch.triggerWatch(preloadId)
      await until(() => preloading)
      results.preloadAccepted = watch.cancelRunningWatch(preloadId)
      releasePreload()
      const r = await pending
      results.preloadCancelled = r.skipped && r.skipReason === 'cancelled'
    } finally { releasePreload(); agent.preloadSkills = preload }
  } else if (process.env.PHASE === 'restart') {
    const completed = []
    watch.setMainWindow({ isDestroyed: () => false, webContents: { send(channel, payload) { if (channel === 'watch:task-completed') completed.push(payload) } } })
    const id = create('RESTART_A')
    watch.updateWatchState(id, { body: '重启快照'.repeat(1500) })
    await watch.start()
    const writeFile = fs.promises.writeFile
    const preload = agent.preloadSkills
    let entered = false, preloading = false
    let release, releasePreload
    const gate = new Promise(resolve => { release = resolve })
    const preloadGate = new Promise(resolve => { releasePreload = resolve })
    fs.promises.writeFile = async function (...args) {
      if (String(args[0]).includes('watch-state-')) { entered = true; await gate }
      return writeFile.apply(this, args)
    }
    try {
      const old = watch.triggerWatch(id)
      await until(() => entered)
      watch.stop()
      watch.update(id, { prompt: `CASE:RESTART_B WATCH_ID:${id}` })
      await watch.start()
      agent.preloadSkills = async function (...args) { preloading = true; await preloadGate; return preload.apply(this, args) }
      const next = watch.triggerWatch(id)
      await until(() => watch.isWatchRunning(id))
      const nextSession = watch.get(id).lastRun.agentSessionId
      release()
      const oldResult = await old
      await until(() => preloading)
      results.oldSkipped = oldResult.skipped === true
      results.newStillRunning = watch.get(id).lastRun.status === 'running' && watch.get(id).lastRun.agentSessionId === nextSession
      results.noOldCompletion = completed.length === 0
      releasePreload()
      const nextResult = await next
      results.newCompleted = nextResult.success && watch.get(id).lastRun.status === 'completed' && completed.length === 1
      results.oldAudited = load('watch/store').getWatchStore().getHistory(id).some(r => r.status === 'skipped')
    } finally { release(); releasePreload(); fs.promises.writeFile = writeFile; agent.preloadSkills = preload }
  } else if (process.env.PHASE === 'probe-lifecycle') {
    const events = []
    getEventBus().on(e => { if (e.type === 'command_probe') events.push({ event: e, at: Date.now() }) })
    fs.writeFileSync(path.join(process.cwd(), 'slow.cjs'), "require('fs').writeFileSync(process.argv[2], 'ready'); process.stdout.write('OLD'); setTimeout(() => process.stdout.write('DONE'), 5000)")
    fs.writeFileSync(path.join(process.cwd(), 'steady.cjs'), "process.stdout.write('NEW')")
    const cases = ['default', 'shell'].map(kind => {
      const marker = path.join(process.cwd(), `ready-${kind}`)
      const shell = kind === 'shell' ? (process.platform === 'win32' ? 'powershell.exe' : '/bin/sh') : undefined
      const trigger = { type: 'command_probe', command: `${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(process.cwd(), 'slow.cjs'))} ${JSON.stringify(marker)}`, shell, interval: 10, triggerOn: 'output_changed' }
      return { id: create(`REPLACED_${kind.toUpperCase()}`, trigger), marker, trigger }
    })
    await watch.start()
    await sensor.start({ heartbeatEnabled: false })
    await until(() => cases.every(item => fs.existsSync(item.marker)))
    for (const item of cases) watch.update(item.id, { triggers: [{ ...item.trigger, command: `${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(process.cwd(), 'steady.cjs'))}` }] })
    // 父进程结束后，孙进程仍暂时持有管道；超限不能无限等 close。
    fs.writeFileSync(path.join(process.cwd(), 'pipe.cjs'), "require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 2500)'], { stdio: 'inherit' }); process.stdout.write('汉'.repeat(400000))")
    const { CommandProbeSensor } = load('sensor/command-probe-sensor')
    const pipeProbe = new CommandProbeSensor(getEventBus())
    pipeProbe.addTarget('pipe-test', { command: `${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(process.cwd(), 'pipe.cjs'))}`, interval: 10, triggerOn: 'output_changed' })
    const began = Date.now()
    await pipeProbe.start()
    await until(() => events.some(item => item.event.watchId === 'pipe-test'), 10000)
    const failure = events.find(item => item.event.watchId === 'pipe-test')
    results.pipeFailure = failure.event.payload.errorCode === 'OUTPUT_LIMIT_EXCEEDED'
    results.pipeFinalizedPromptly = failure.at - began < 2000
    await pipeProbe.stop()
    await sleep(11000)
    results.replacementEvents = cases.map(item => ({ kind: item.id, count: events.filter(e => e.event.watchId === item.id).length }))
    await sensor.stop()
  } else if (process.env.PHASE === 'events') {
    const events = []
    getEventBus().on(e => { if (e.type === 'http_probe' || e.type === 'command_probe') events.push(e) })
    const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(process.cwd(), 'emit.cjs'))}`
    create('HTTP_TIMEOUT', { type: 'http_probe', url: `${process.env.PROBE_URL}/slow`, interval: 10, triggerOn: 'body_changed', timeout: 100 })
    const httpId = create('HTTP_CHANGED', { type: 'http_probe', url: `${process.env.PROBE_URL}/body-changed`, interval: 10, triggerOn: 'body_changed' })
    const statusId = create('HTTP_STATUS_RECOVERED', { type: 'http_probe', url: `${process.env.PROBE_URL}/body-status`, interval: 10, triggerOn: 'status_changed' })
    const firstStatusId = create('HTTP_FIRST_FAILURE_RECOVERED', { type: 'http_probe', url: `${process.env.PROBE_URL}/first-failure`, interval: 10, triggerOn: 'status_changed' })
    const regexId = create('HTTP_REGEX', { type: 'http_probe', url: `${process.env.PROBE_URL}/body-regex`, interval: 10, triggerOn: 'regex_match', pattern: 'TAIL_NEW' })
    const commandId = create('COMMAND_CHANGED', { type: 'command_probe', command: command + ' default', interval: 10, triggerOn: 'output_changed' })
    const shellId = create('COMMAND_SHELL_CHANGED', { type: 'command_probe', command: command + ' shell', shell: process.platform === 'win32' ? 'powershell.exe' : '/bin/sh', interval: 10, triggerOn: 'output_changed' })
    const webhookId = create('WEBHOOK', { type: 'webhook', token: 'integrity-test' })
    const batchId = create('BATCH', { type: 'heartbeat' })
    await watch.start()
    await sensor.start({ heartbeatEnabled: false })
    // 首轮建立基线，第二轮由真实定时器检测尾部变化。
    await sleep(1500)
    fs.writeFileSync(path.join(process.cwd(), 'command.txt'), 'x'.repeat(70000) + 'TAIL_NEW')
    await fetch(`${process.env.PROBE_URL}/advance`, { method: 'POST' })
    await sleep(11000)
    await until(() => !watch.isWatchRunning(httpId) && !watch.isWatchRunning(regexId) && !watch.isWatchRunning(commandId))
    fs.writeFileSync(path.join(process.cwd(), 'command.txt'), '汉'.repeat(400000))
    await fetch(`${process.env.PROBE_URL}/oversize`, { method: 'POST' })
    await sleep(11000)
    results.failures = events.filter(e => e.payload.checkFailed)
    results.probeIds = { http: httpId, command: commandId, shell: shellId, status: statusId, firstStatus: firstStatusId }
    const ticks = () => ['default', 'shell'].map(kind => fs.readFileSync(path.join(process.cwd(), `ticks-${kind}.txt`), 'utf8').length)
    const ticksBefore = ticks()
    const changedBefore = events.filter(e => !e.payload.checkFailed && [httpId, commandId, shellId].includes(e.watchId)).length
    fs.writeFileSync(path.join(process.cwd(), 'command.txt'), 'x'.repeat(70000) + 'TAIL_NEW')
    await fetch(`${process.env.PROBE_URL}/restore`, { method: 'POST' })
    await sleep(11000)
    results.recoveryPolled = ticks().every((value, i) => value > ticksBefore[i])
    results.establishedChanges = changedBefore
    results.baselinePreserved = changedBefore === events.filter(e => !e.payload.checkFailed && [httpId, commandId, shellId].includes(e.watchId)).length
    results.events = events
    results.probeRuns = Object.fromEntries([httpId, regexId, commandId, shellId].map(id => [watch.get(id).name, watch.getHistory(id)]))
    // 长 Webhook 经真实本机 Gateway HTTP 入口、总线、关切、Agent。
    const { GatewayService } = load('gateway.service')
    const gateway = new GatewayService()
    const { WebChatService } = load('web-chat.service')
    gateway.setDependencies({ webChatService: new WebChatService(), mainWindow: null })
    const port = Number(process.env.GATEWAY_PORT)
    const started = await gateway.start({ enabled: true, host: '127.0.0.1', port, apiToken: 'test' })
    if (!started.success) throw new Error(started.error)
    const response = await fetch(`http://127.0.0.1:${port}/hooks/integrity-test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ padding: 'x'.repeat(6000), tail: 'WEBHOOK_TAIL' }) })
    results.webhookStatus = response.status
    await until(() => !watch.isWatchRunning(webhookId) && watch.getHistory(webhookId).some(r => r.status === 'completed'))
    await gateway.stop()
    // 启动收集期结束后，25 条无定向事件经真实 EventPool 攒批。
    await sleep(1000)
    for (let i = 0; i < 25; i++) getEventBus().emit({ id: `mail-${i}`, type: 'email', source: 'synthetic', timestamp: Date.now(), payload: { subject: `EVENT_${i}`, from: 'test' }, priority: 'normal' })
    await sleep(200)
    const before = watch.getHistory(batchId).length
    getEventBus().emit({ id: 'drain', type: 'heartbeat', source: 'synthetic', timestamp: Date.now(), payload: {}, priority: 'normal' })
    await until(() => !watch.isWatchRunning(batchId) && watch.getHistory(batchId).length > before)
    await sensor.stop()
    watch.stop()
    results.batchRuns = watch.getHistory(batchId)
  }
  watch.stop()
  const resultFile = path.join(process.env.SFT_DATA_DIR, `result-${process.env.PHASE}.json`)
  fs.writeFileSync(resultFile, JSON.stringify(results))
  console.log(`RESULT_PATH ${resultFile}`)
}
main().then(() => process.exit(0)).catch(error => { console.error(error.stack); process.exit(1) })
