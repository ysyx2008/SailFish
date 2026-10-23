#!/usr/bin/env node
/* eslint-env node */
/**
 * 用火山 Deepseek（上下文 110K）把上下文管理整条链路探一遍。
 *
 * 不改磁盘上的模型配置。本地临界判定不打模型；--live 才发真实请求。
 *
 *   node scripts/probe-context-110k.js           # 只跑不花钱的临界
 *   node scripts/probe-context-110k.js --live    # 加上真模型
 */
'use strict'

const Module = require('module')
const path = require('path')
const fs = require('fs')
const os = require('os')

const shimPath = path.join(__dirname, '..', 'electron', 'cli', 'electron-shim.js')
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === 'electron' || request === 'electron-updater') return shimPath
  return origResolve.call(this, request, parent, isMain, options)
}

process.env.SFT_CLI_MODE = '1'
require(path.join(__dirname, '..', 'electron', 'cli', 'cli-data.js')).setupCliDataDir({ defaultSandbox: true })
require('tsx/cjs')

const svcDir = path.join(__dirname, '..', 'electron', 'services')
const { ConfigService } = require(path.join(svcDir, 'config.service.ts'))
const { AiService } = require(path.join(svcDir, 'ai.service.ts'))
const { resolveRequestBudget, SUMMARY_MAX_OUTPUT_TOKENS } = require(path.join(svcDir, 'ai-request-budget.ts'))
const { ContextWindowManager } = require(path.join(svcDir, 'agent', 'context-window.ts'))
const { computeToolOutputBudget } = require(path.join(svcDir, 'agent', 'tool-output-budget.ts'))
const { buildTaskHistoryContext } = require(path.join(svcDir, 'agent', 'context-builder.ts'))
const { TaskMemoryStore } = require(path.join(svcDir, 'agent', 'task-memory.ts'))
const { getAgentTools, stripToolMeta } = require(path.join(svcDir, 'agent', 'tools.ts'))
const { buildContextEconomyRuleText } = require(path.join(svcDir, 'agent', 'prompt-builder.ts'))
const { readFile } = require(path.join(svcDir, 'agent', 'tools', 'file.ts'))
const { t } = require(path.join(svcDir, 'agent', 'i18n.ts'))
const { SUMMARY_OUTPUT_BUDGET_CHARS } = require(path.join(svcDir, 'agent', 'compression-summary.ts'))
const { normalizeProactiveCompact } = require(path.join(__dirname, '..', 'packages', 'shared-types', 'src', 'agent.ts'))

const PROFILE_ID = 'ee386991-760b-499c-9d6b-573d3c7a39fc'
const LIVE = process.argv.includes('--live')
const lines = []

function say(s = '') {
  const text = String(s)
  lines.push(text)
  console.log(text)
}

function passed(ok, name, detail = '') {
  say(`${ok ? '通过' : '失败'}  ${name}${detail ? ' — ' + detail : ''}`)
  return ok
}

function desktopProactiveCompact() {
  const pointer = path.join(os.homedir(), 'Library', 'Application Support', 'SailFish', 'data-location.json')
  let dir = path.join(os.homedir(), 'Library', 'Application Support', 'SailFish')
  try {
    if (fs.existsSync(pointer)) {
      const p = JSON.parse(fs.readFileSync(pointer, 'utf8'))
      if (p && p.dataDir) dir = p.dataDir
    }
  } catch { /* 指针读不到就用默认目录 */ }
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'qiyu-terminal-config.json'), 'utf8'))
  return normalizeProactiveCompact(raw.proactiveCompact)
}

function makeRun(messages) {
  return {
    id: 'probe',
    originalUserRequest: 'probe',
    messages,
    steps: [],
    isRunning: false,
    aborted: false,
    pendingUserMessages: [],
    config: {},
    context: {},
    realtimeOutputBuffer: [],
    executionPhase: 'idle',
    taskMessageLog: [],
  }
}

function roughTokens(text) {
  return Math.ceil(Buffer.byteLength(text || '', 'utf8') / 4)
}

function filler(tokens) {
  const crypto = require('crypto')
  const parts = []
  let est = 0
  let i = 0
  while (est < tokens) {
    const line = `row ${i} ${crypto.randomBytes(24).toString('hex')} ${crypto.randomBytes(24).toString('hex')}`
    parts.push(line)
    est += Math.ceil(Buffer.byteLength(line, 'utf8') / 4)
    i++
  }
  return parts.join('\n')
}

function toolRound(id, output) {
  return [
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id, type: 'function', function: { name: 'exec', arguments: '{"command":"probe"}' } }],
    },
    { role: 'tool', tool_call_id: id, content: output },
  ]
}

function readCachedTokens(usage) {
  if (!usage) return null
  const raw = usage.raw || usage
  const details = raw.prompt_tokens_details || raw.input_tokens_details
  if (details && typeof details.cached_tokens === 'number') return details.cached_tokens
  if (typeof raw.cached_tokens === 'number') return raw.cached_tokens
  if (typeof raw.cache_read_input_tokens === 'number') return raw.cache_read_input_tokens
  if (typeof usage.cache_hit_tokens === 'number') return usage.cache_hit_tokens
  return null
}

function callsOf(res) {
  const calls = (res && (res.tool_calls || res.toolCalls)) || []
  return calls.map((c) => ({
    name: c.function && c.function.name,
    args: c.function && c.function.arguments,
  }))
}

function wantsCompress(calls) {
  return calls.some((c) => {
    if (c.name !== 'context') return false
    try {
      const args = JSON.parse(c.args || '{}')
      return String(args.action || '').toLowerCase() === 'compress' || !!args.summary
    } catch {
      return /compress/.test(c.args || '')
    }
  })
}

function snapshot(manager, run) {
  const tokens = manager.estimateCurrentPromptTokens(run.messages)
  const inputLimit = manager.getInputLimit()
  const remaining = inputLimit - tokens
  return {
    tokens,
    inputLimit,
    remaining,
    percent: Math.round((tokens / inputLimit) * 100),
    proactive: manager.shouldProactiveCompress(run),
    over: manager.needsRequestCompaction(run),
    reserve: manager.getCompactionReserveTokens(),
  }
}

function makeManager(profile, opts) {
  const nudge = opts.nudge !== false
  let anchor = opts.anchor
  return new ContextWindowManager({
    config: {
      getAiProfiles: () => [profile],
      getActiveAiProfile: () => profile.id,
    },
    getProfileId: () => profile.id,
    getLastPromptTokens: () => anchor,
    getLastCacheHitRate: () => undefined,
    reportUsage: () => {},
    invalidateTokenAnchor: () => { anchor = undefined },
    getTools: () => opts.tools || [],
    shouldNudgeModelToCompact: () => nudge,
    minProactiveRangeTokens: opts.minRange,
    summarizeMessages: opts.summarizeMessages,
  })
}

function pressureConversation(systemPrompt) {
  const early = [
    '根分区 99%。清理失败的原因只写在这里：用户 deploy 不在 sudoers，不能删 /var/log/app-2024。',
    '进度只写在这里：大文件共 57 个，已处理 30 个。核对码 KITE-7741。主机 db-07。',
    '清单路径必须原样保留：/tmp/big-logs.txt',
  ].join('\n')
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: '帮我看看这台机器磁盘为什么满了，先别下结论。' },
    ...toolRound('c1', early),
    { role: 'assistant', content: '根分区满了，主要是日志。' },
    { role: 'user', content: '继续把超过 1G 的日志清单写出来。后面还要再查很多台。' },
    ...toolRound('c2', '这一轮只是铺量，结论都在更早的工具输出里。\n' + filler(400)),
    ...toolRound('c3', '批次甲完成，没有新的关键事实。'),
    ...toolRound('c4', '批次乙完成，没有新的关键事实。'),
  ]
  return messages
}

function setPad(messages, tokens) {
  const tool = messages.find((m) => m.tool_call_id === 'c2')
  tool.content = '这一轮只是铺量，结论都在更早的工具输出里。\n' + filler(tokens)
}

async function main() {
  const config = new ConfigService()
  const profiles = config.getAiProfiles()
  const profile = profiles.find((p) => p.id === PROFILE_ID)
    || profiles.find((p) => p.contextLength === 110000 && /deepseek/i.test(p.model || ''))
  if (!profile || !profile.apiKey) {
    say('没有找到带密钥的火山 Deepseek 110K 配置，探测停在这里。')
    return
  }
  const compactStyle = desktopProactiveCompact()
  const nudgeOn = compactStyle !== 'off'
  const budget = resolveRequestBudget(profile)
  const tools = stripToolMeta(getAgentTools(undefined, { mode: 'assistant', includeContextTools: true }, undefined))
  const economy = buildContextEconomyRuleText(compactStyle)
  const systemPrompt = [
    economy,
    '你是旗鱼里的助手，正在一场还没做完的运维任务里。查看或压缩上下文用 context 工具。',
  ].filter(Boolean).join('\n\n')

  say('模型')
  say(`  名称 ${profile.name}    模型 ${profile.model}`)
  say(`  上下文 ${budget.contextLength}    预留输出 ${budget.outputTokens}    能发出去的输入 ${budget.inputLimit}`)
  say(`  主动压缩档位 ${compactStyle}（${nudgeOn ? '快满时会催它自己压' : '不催它自己压，快满仍由系统压'}）`)
  say(`  工具 ${tools.length} 个，估算 ${roughTokens(JSON.stringify(tools))} tokens`)
  say('')

  const results = []
  const check = (ok, name, detail) => {
    results.push(ok)
    passed(ok, name, detail)
  }

  say('—— 临界判定（不打模型，用这份 110K 配置）——')

  const base = makeManager(profile, { tools, nudge: nudgeOn })
  const under = makeRun(pressureConversation(systemPrompt))
  setPad(under.messages, 200)
  base.updatePressure(under)
  const underSnap = snapshot(base, under)
  const underWarned = under.messages.some((m) => String(m.content || '').includes('上下文用量告警'))
  check(!underWarned && underSnap.percent < 85, '还很空时不告警、不催压缩', `估算 ${underSnap.percent}%`)

  const at = makeManager(profile, { tools, nudge: nudgeOn, anchor: Math.floor(budget.inputLimit * 0.86) })
  const atRun = makeRun(pressureConversation(systemPrompt))
  at.updatePressure(atRun)
  const atSnap = snapshot(at, atRun)
  const atWarned = atRun.messages.some((m) => String(m.content || '').includes('上下文用量告警'))
  check(nudgeOn ? atWarned : !atWarned, nudgeOn ? '过了八成五会催它调用压缩' : '不主动压缩时过了八成五也不催', `估算 ${atSnap.percent}%`)

  const off = makeManager(profile, { tools, nudge: false, anchor: Math.floor(budget.inputLimit * 0.9) })
  const offRun = makeRun(pressureConversation(systemPrompt))
  off.updatePressure(offRun)
  check(
    !offRun.messages.some((m) => String(m.content || '').includes('上下文用量告警')),
    '关掉催促后，告警不会塞进对话'
  )

  const near = makeManager(profile, { tools, nudge: nudgeOn, anchor: budget.inputLimit - 12000 })
  const nearRun = makeRun(pressureConversation(systemPrompt))
  const beforeFile = snapshot(near, nearRun)
  nearRun.messages.push(...toolRound('big', filler(11000)))
  const afterFile = snapshot(near, nearRun)
  check(
    !beforeFile.proactive && afterFile.proactive,
    '突然塞进一大段工具输出后，系统会在发送前主动压缩',
    `剩余 ${beforeFile.remaining} → ${afterFile.remaining}（预留 ${afterFile.reserve}）`
  )

  const tiny = makeManager(profile, { tools, anchor: budget.inputLimit - 1000 })
  const tinyRun = makeRun([
    { role: 'system', content: 'x' },
    { role: 'user', content: '只问一句' },
    { role: 'assistant', content: '好' },
  ])
  const tinyResult = await tiny.proactiveCompress(tinyRun)
  check(tinyResult == null, '可压的内容太少时跳过主动压缩，避免越压越大')

  // 重开旧会话：记下的真实用量对得上历史时，以它为准（填充是随机十六进制，本地估算会少估一半）。
  // 没有记下的用量时只能靠估算，这时发现不了「估算 9 万、实际 15 万」——已知缺口，由第一次回复后的真实用量补上。
  const coldOver = makeManager(profile, { tools, nudge: nudgeOn, anchor: budget.inputLimit + 20000 })
  const coldRun = makeRun(pressureConversation(systemPrompt))
  setPad(coldRun.messages, 70000)
  check(coldOver.needsRequestCompaction(coldRun), '冷启动时记下的真实用量说已超限，发送前会发现装不下')
  const coldCompressed = coldOver.emergencyCompress(coldRun)
  check(
    !!coldCompressed && !coldOver.needsRequestCompaction(coldRun),
    '冷启动装不下时，发送前的紧急压缩能把它压回限额以内',
    coldCompressed ? `释放 ${coldCompressed.freedTokens}，留下最近 ${coldCompressed.keepRecent} 轮` : '没有压成'
  )

  const pasted = makeRun([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: '刚才的结论先放着。\n' + filler(30000) },
    ...toolRound('p1', '短结果'),
    { role: 'assistant', content: '看完了。' },
    { role: 'user', content: '这是我刚粘进来的整份日志，请从里面找核对码。\n' + filler(90000) },
  ])
  const pastedMgr = makeManager(profile, { tools })
  const pastedBefore = pastedMgr.needsRequestCompaction(pasted)
  pastedMgr.emergencyCompress(pasted)
  const pastedAfter = pastedMgr.needsRequestCompaction(pasted)
  const pasteKept = pasted.messages.some((m) => m.role === 'user' && String(m.content || '').includes('刚粘进来'))
  check(pastedBefore && pastedAfter && pasteKept, '用户刚粘进来的超大原文，压缩不会把它删掉，发送前会拒绝发出去')

  const onlyHuge = makeRun([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: '读一下这个日志' },
    ...toolRound('only', filler(90000)),
  ])
  const onlyMgr = makeManager(profile, { tools, anchor: 1000 })
  const onlyBefore = onlyMgr.needsRequestCompaction(onlyHuge)
  const onlyCompressed = onlyMgr.emergencyCompress(onlyHuge)
  const onlyStillHuge = onlyHuge.messages.some((m) => String(m.content || '').length > 20000)
  check(
    onlyBefore && !!onlyCompressed && !onlyMgr.needsRequestCompaction(onlyHuge) && !onlyStillHuge,
    '最近这一轮只有一大段、前面没有可留的轮次时，紧急压缩会把这整段归档，请求重新装得下',
    onlyCompressed ? `释放 ${onlyCompressed.freedTokens}` : '没有压成'
  )

  say('')
  say('—— 突然读进一个大文件（真实的读取上限，仍不打模型）——')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-ctx-'))
  const bigPath = path.join(tmp, 'huge.log')
  const headMark = 'HEADMARK-db-07'
  const midMark = 'MIDMARK-KITE-SHOULD-DROP'
  const tailMark = 'TAILMARK-end'
  const body = Array.from({ length: 200 }, (_, i) => {
    if (i === 0) return headMark + ' ' + 'h'.repeat(400)
    if (i === 100) return midMark + ' ' + 'm'.repeat(400)
    if (i === 199) return tailMark + ' ' + 't'.repeat(400)
    return `line ${i} ${'z'.repeat(400)}`
  }).join('\n')
  fs.writeFileSync(bigPath, body)
  const tooBigPath = path.join(tmp, 'too-big.log')
  fs.writeFileSync(tooBigPath, 'OVERSIZE-SECRET\n' + 'q'.repeat(520 * 1024))

  async function readWithTokens(currentTokens) {
    const b = computeToolOutputBudget({ contextLength: budget.contextLength, currentTokens })
    const executor = {
      terminalService: {},
      addStep: () => ({ id: 's', timestamp: Date.now() }),
      updateStep: () => {},
      waitForConfirmation: async () => true,
      requestSecureInput: async () => null,
      isAborted: () => false,
      getHostId: () => undefined,
      hasPendingUserMessage: () => false,
      peekPendingUserMessage: () => undefined,
      consumePendingUserMessage: () => undefined,
      getRealtimeTerminalOutput: () => [],
      getCurrentPlan: () => undefined,
      setCurrentPlan: () => {},
      getTaskMemory: () => undefined,
      getToolOutputBudget: () => b,
    }
    const result = await readFile('probe', { path: bigPath }, {}, executor)
    return { budget: b, output: result.output || result.error || '' }
  }

  const low = await readWithTokens(1000)
  check(
    low.output.includes(headMark) && low.output.includes(tailMark) && !low.output.includes(midMark) && low.output.length < body.length / 2,
    '行数还没到上限时，大文件只带回头尾，中间不进对话',
    `上限 ${low.budget.maxChars} 字，实际 ${low.output.length} 字`
  )
  const refused = await readFile('probe', { path: tooBigPath }, {}, {
    terminalService: {},
    addStep: () => ({ id: 's', timestamp: Date.now() }),
    updateStep: () => {},
    waitForConfirmation: async () => true,
    requestSecureInput: async () => null,
    isAborted: () => false,
    getHostId: () => undefined,
    hasPendingUserMessage: () => false,
    getToolOutputBudget: () => computeToolOutputBudget({ contextLength: budget.contextLength, currentTokens: 1000 }),
  })
  check(
    refused.success === false && !String(refused.error || '').includes('OVERSIZE-SECRET'),
    '超过读取体积上限的文件整份不进对话'
  )
  const highTokens = Math.floor(budget.contextLength * 0.9)
  const high = await readWithTokens(highTokens)
  check(
    high.budget.maxChars === 0 && !high.output.includes(midMark) && high.output.length < 2000,
    '窗口已经很满时，大文件不再塞进对话，只告诉它先腾地方',
    `用量 ${high.budget.usagePercent}%`
  )

  say('')
  say('—— 冷启动：历史比 110K 大，看装进去的是什么 ——')
  const memory = new TaskMemoryStore()
  const newestFact = '最新口令 ORANGE-19'
  const oldestFact = '旧库密码 VAULT-1900'
  for (let i = 0; i < 8; i++) {
    const secret = i === 0 ? oldestFact : `任务${i}的过程噪声`
    memory.saveTask(
      `t${i}`,
      i === 7 ? `请记住${newestFact}，这是最新一件事` : `第 ${i} 件旧事，用户只说了这句`,
      [],
      'success',
      i === 7 ? `已经记下 ${newestFact}` : '做完了',
      [
        { role: 'user', content: i === 7 ? `请记住${newestFact}` : `第 ${i} 件旧事` },
        ...toolRound(`h${i}`, secret + '\n' + filler(12000)),
        { role: 'assistant', content: i === 7 ? `已经记下 ${newestFact}` : '做完了' },
      ]
    )
  }
  const fixedPrefix = base.getFixedPrefixTokens()
  const built = buildTaskHistoryContext(memory, budget.contextLength, '继续', { fixedPrefixTokens: fixedPrefix })
  const builtText = built.recentTaskMessages.map((m) => m.content || '').join('\n')
  const builtTokens = base.estimateMessagesTokens(built.recentTaskMessages)
  check(builtText.includes(newestFact), '冷启动优先留下最近一件事的原文', `装了 ${built.stats.level0Count}/${built.stats.totalTasks} 件，约 ${builtTokens} tokens，预算 ${built.stats.budget}`)
  check(!builtText.includes(oldestFact), '装不下的更早过程不进正文（只留在可回想的名单里）')
  check(builtTokens + fixedPrefix <= budget.contextLength, '冷启动装好的历史加上固定开销，不超过这扇 110K 窗口', `${builtTokens}+${fixedPrefix}`)

  const oneFat = new TaskMemoryStore()
  oneFat.saveTask('fat', '这份日志太大了', [], 'success', '看完了', [
    { role: 'user', content: '这份日志太大了' },
    ...toolRound('fat1', 'HEAD-ORANGE\n' + filler(80000) + '\nTAIL-ORANGE'),
    { role: 'assistant', content: '看完了' },
  ])
  const fatBuilt = buildTaskHistoryContext(oneFat, budget.contextLength, '继续', { fixedPrefixTokens: fixedPrefix })
  const fatText = fatBuilt.recentTaskMessages.map((m) => m.content || '').join('\n')
  check(
    fatText.includes('HEAD-ORANGE') && fatText.includes('TAIL-ORANGE') && base.estimateMessagesTokens(fatBuilt.recentTaskMessages) <= built.stats.budget + 500,
    '冷启动时最近这一件自己就超过窗口，会把头尾留下、把中间收掉',
    `约 ${base.estimateMessagesTokens(fatBuilt.recentTaskMessages)} tokens`
  )

  const companion = new TaskMemoryStore()
  companion.saveTask('c', '问过端口', [], 'success', '端口是 8088', [
    { role: 'user', content: 'nginx 端口是多少' },
    ...toolRound('cc', '过程里才有的临时值 TEMP-55，最终答复不会写它\n' + filler(8000)),
    { role: 'assistant', content: '端口是 8088' },
  ])
  const companionBuilt = buildTaskHistoryContext(companion, budget.contextLength, '继续刚才的', {
    processLevels: true,
    fixedPrefixTokens: budget.contextLength - 400,
  })
  const companionText = companionBuilt.recentTaskMessages.map((m) => m.content || '').join('\n')
  check(
    companionText.includes('8088') && !companionText.includes('TEMP-55'),
    '联络冷启动地方不够时，问答还在，过程收掉',
    `档位 ${companionBuilt.stats.level4Count ? '只剩问答' : '仍带过程'}`
  )

  if (!LIVE) {
    say('')
    say('本地临界做完了。真模型那几段还没跑：它自己会不会压、交接写得好不好、压缩后的请求接口收不收。')
    say('要接着打模型：node scripts/probe-context-110k.js --live')
    finishReport(results)
    return
  }

  say('')
  say('—— 真模型 ——')
  const ai = new AiService(config)

  say('先看它在还装得下、但后面明显还要继续时，会不会自己动手压。')
  const controlMessages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: '查完 db-01 的磁盘了，过程在上面。后面还要同样再查三十台，db-01 的过程后面用不上。请开始 db-02。' },
    ...toolRound('ctl', 'db-01 根分区 99%，日志在 /var/log/app。这台已经结束。'),
    { role: 'assistant', content: 'db-01 查完了。' },
    { role: 'user', content: '开始 db-02。后面每台都一样，查完就进入下一台。' },
  ]
  const control = await ai.chatWithTools(controlMessages, tools, profile.id, undefined, { maxOutputTokens: 600 })
  const controlCalls = callsOf(control)
  const controlCompress = wantsCompress(controlCalls)
  say(`  它的选择：${controlCalls.length ? controlCalls.map((c) => `${c.name} ${c.args || ''}`).join(' | ') : '没有调用工具，直接写了字'}`)
  if (!controlCompress && control.content) say('  开头：' + String(control.content).replace(/\s+/g, ' ').slice(0, 180))
  if (nudgeOn) {
    say(controlCompress
      ? '  观察：还没满，它已经自己选择压缩。'
      : '  观察：还没满，它选择继续干活。这一档允许它先继续。')
  } else {
    check(!controlCompress, '不主动压缩时，它没有自己去压')
  }

  say('再把对话堆到八成五以上、但还没到系统强制压缩的那一档，看告警出现后它听不听。')
  const sample = pressureConversation(systemPrompt)
  setPad(sample, 1500)
  const sampleMgr = makeManager(profile, { tools, nudge: nudgeOn })
  const sampleEst = sampleMgr.estimateTotalTokens(sample)
  const sampleRes = await ai.chatWithTools(sample, tools, profile.id, undefined, { maxOutputTokens: 32 })
  const sampleReal = sampleRes.usage && sampleRes.usage.prompt_tokens
  if (!sampleReal) {
    say('校准请求没有返回用量，后面的大请求无法对准八成五，停在这里。')
    finishReport(results)
    return
  }
  const ratio = sampleReal / sampleEst
  say(`  估算 ${sampleEst}，接口实报 ${sampleReal}，倍率 ${ratio.toFixed(3)}`)

  const targetEst = Math.floor(budget.inputLimit * 0.88)
  const toolAndSystem = sampleEst - sampleMgr.estimateMessagesTokens(sample.filter((m) => m.tool_call_id === 'c2'))
  let padTokens = Math.max(500, Math.floor(targetEst - toolAndSystem))
  const liveMessages = pressureConversation(systemPrompt)
  for (let n = 0; n < 8; n++) {
    setPad(liveMessages, padTokens)
    const est = sampleMgr.estimateTotalTokens(liveMessages)
    if (est > budget.inputLimit * 0.91) padTokens = Math.floor(padTokens * 0.94)
    else if (est < budget.inputLimit * 0.86) padTokens = Math.floor(padTokens * 1.05)
    else break
  }
  setPad(liveMessages, padTokens)
  const liveRun = makeRun(liveMessages.map((m) => ({ ...m })))
  const liveMgr = makeManager(profile, { tools, nudge: nudgeOn })
  liveMgr.updatePressure(liveRun)
  const warned = liveRun.messages.some((m) => String(m.content || '').includes('上下文用量告警'))
  const predicted = Math.round(liveMgr.estimateTotalTokens(liveRun.messages) * ratio)
  const sentChars = liveRun.messages.reduce((n, m) => n + String(m.content || '').length, 0)
  say(`  发出去的正文 ${sentChars} 字，预计实占 ${predicted} / 输入上限 ${budget.inputLimit}（${Math.round(predicted / budget.inputLimit * 100)}%），告警${warned ? '已放进对话' : '没放'}，系统主动压缩 ${liveMgr.shouldProactiveCompress(liveRun) ? '会' : '不会'}先动手`)
  check(nudgeOn ? warned : !warned, nudgeOn ? '这一档会先催它，而不是系统抢先压缩' : '不催的档位这一档没有告警')

  const choice = await ai.chatWithTools(liveRun.messages, tools, profile.id, undefined, { maxOutputTokens: 700 })
  const choiceUsage = choice.usage || {}
  const choiceCalls = callsOf(choice)
  const choiceCompress = wantsCompress(choiceCalls)
  say(`  实报 prompt=${choiceUsage.prompt_tokens} 缓存=${readCachedTokens(choiceUsage) ?? '-'} 占输入上限 ${Math.round((choiceUsage.prompt_tokens || 0) / budget.inputLimit * 100)}%`)
  const realBand = Math.round((choiceUsage.prompt_tokens || 0) / budget.inputLimit * 100)
  check(warned, '按我们自己的估算过了八成五，告警会放进对话')
  say(`  同一份正文，估算约 ${predicted}，接口实报 ${choiceUsage.prompt_tokens}（${realBand}%）。差得越多，告警就越不准。`)
  say(`  它的选择：${choiceCalls.length ? choiceCalls.map((c) => `${c.name} ${c.args || ''}`).join(' | ') : '没有调用工具'}`)
  if (!choiceCompress && choice.content) say('  开头：' + String(choice.content).replace(/\s+/g, ' ').slice(0, 220))
  check(
    nudgeOn ? choiceCompress : !choiceCompress,
    nudgeOn ? '快满并被催之后，它自己调用了压缩' : '不催时，快满它也没有自己去压'
  )

  say('然后模拟这一步真的读回一个顶格的大文件，看系统会不会在下一次发送前压住。')
  const anchored = makeManager(profile, {
    tools,
    nudge: nudgeOn,
    anchor: choiceUsage.prompt_tokens,
    summarizeMessages: async (opts) => writeHandoff(ai, profile, tools, opts),
  })
  const afterChoice = makeRun(liveRun.messages.map((m) => ({ ...m })))
  const reply = { role: 'assistant', content: choice.content || '继续。' }
  if (choiceCalls.length) {
    reply.content = choice.content || ''
    reply.tool_calls = choiceCalls.map((c, i) => ({
      id: `m${i}`,
      type: 'function',
      function: { name: c.name, arguments: c.args || '{}' },
    }))
  }
  afterChoice.messages.push(reply)
  const fileNow = await readWithTokens(anchored.estimateCurrentPromptTokens(afterChoice.messages))
  afterChoice.messages.push(...toolRound('sudden', fileNow.output))
  const fileSnap = snapshot(anchored, afterChoice)
  say(`  读回 ${fileNow.output.length} 字（上限 ${fileNow.budget.maxChars}），之后估算剩余 ${fileSnap.remaining}，主动压缩 ${fileSnap.proactive ? '触发' : '未触发'}，已经超出发送上限 ${fileSnap.over ? '是' : '否'}`)
  check(fileNow.output.length <= Math.max(fileNow.budget.maxChars, 2500) + 800, '读进来的大文件没有超过这一刻允许的上限')

  let handoffMessages = null
  if (fileSnap.proactive || fileSnap.over) {
    if (anchored.shouldProactiveCompress(afterChoice)) {
      const compressed = await anchored.proactiveCompress(afterChoice)
      check(!!compressed && compressed.freedTokens > 500, '系统主动交接真的放出了空间', compressed ? `释放 ${compressed.freedTokens}，留下 ${compressed.keepRecent} 轮` : '没有压成')
      handoffMessages = afterChoice.messages
    }
    if (anchored.needsRequestCompaction(afterChoice)) {
      const emergency = anchored.emergencyCompress(afterChoice)
      check(!!emergency && !anchored.needsRequestCompaction(afterChoice), '主动交接之后若仍超限，发送前的紧急压缩能兜住', emergency ? `再释放 ${emergency.freedTokens}` : '没有压成')
      handoffMessages = afterChoice.messages
    }
  } else {
    say('  这一次顶格读取还没把剩余空间吃到交接线以下。改用一份不守读取上限的超大输出，看兜底。')
    const raw = makeRun(afterChoice.messages.map((m) => ({ ...m })))
    raw.messages.push(...toolRound('rawbig', filler(20000)))
    const rawSnap = snapshot(anchored, raw)
    check(rawSnap.proactive || rawSnap.over, '不守上限的超大输出会被发送前的压缩接住', `剩余 ${rawSnap.remaining}`)
    if (anchored.shouldProactiveCompress(raw)) {
      const compressed = await anchored.proactiveCompress(raw)
      check(!!compressed, '交接写完了', compressed ? `释放 ${compressed.freedTokens}` : '')
      handoffMessages = raw.messages
    }
  }

  if (handoffMessages) {
    const summaryText = handoffMessages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n')
    const facts = [
      ['核对码 KITE-7741', /KITE-7741/],
      ['deploy 没有 sudo', /sudo|deploy/],
      ['57 个里完成了 30 个', /57/],
      ['清单路径 /tmp/big-logs.txt', /\/tmp\/big-logs\.txt/],
      ['主机 db-07', /db-07/],
    ]
    say('  交接正文里：')
    for (const [label, re] of facts) {
      const ok = re.test(summaryText)
      check(ok, `交接留住了「${label}」`)
    }
    say('  拿压缩后的对话再问一次，看它还答不答得上来。')
    const follow = await ai.chatWithTools(
      [...handoffMessages, { role: 'user', content: '先别做新的事。用一句话分别回答：核对码是什么？清理失败是因为谁没有权限？57 个里完成了多少？清单写到哪？哪台主机？' }],
      tools,
      profile.id,
      undefined,
      { maxOutputTokens: 500 }
    )
    const answer = follow.content || ''
    say('  回答：' + answer.replace(/\s+/g, ' ').slice(0, 500))
    const followUsage = follow.usage || {}
    say(`  这次 prompt=${followUsage.prompt_tokens} 缓存=${readCachedTokens(followUsage) ?? '-'}`)
    check(/KITE-7741/.test(answer), '压缩后还答得出核对码')
    check(/30/.test(answer) && /57/.test(answer), '压缩后还答得出 30/57')
    check(/\/tmp\/big-logs\.txt/.test(answer), '压缩后还答得出清单路径')
    check(followUsage.prompt_tokens < budget.inputLimit, '压缩后的请求落在输入上限以内', `${followUsage.prompt_tokens} < ${budget.inputLimit}`)
  }

  say('冷启动装好的历史，发给这个模型，看接口接不接受、最近的事还在不在。')
  const coldMessages = [
    { role: 'system', content: systemPrompt },
    ...built.recentTaskMessages,
    { role: 'user', content: '只回答最新那件事情里的口令，不要展开旧事。' },
  ]
  const coldMgr = makeManager(profile, { tools })
  const coldSend = makeRun(coldMessages)
  const coldSnap = snapshot(coldMgr, coldSend)
  say(`  冷启动估算 ${coldSnap.tokens}，占输入上限 ${coldSnap.percent}% ，发送前还要再压：${coldSnap.over ? '要' : '不要'}`)
  if (coldSnap.over) {
    const saved = coldMgr.emergencyCompress(coldSend)
    const after = snapshot(coldMgr, coldSend)
    check(!!saved && !after.over, '冷启动装完超过能发送的输入时，紧急压缩能把它压回去', saved ? `释放 ${saved.freedTokens}，之后 ${after.percent}%` : '没有压成')
  }
  if (!coldMgr.needsRequestCompaction(coldSend)) {
    const kept = coldSend.messages.map((m) => String(m.content || '')).join('\n')
    say(`  压完之后，最近的口令${kept.includes('ORANGE-19') ? '还在眼前' : '已经不在眼前'}，旧密码${kept.includes('VAULT-1900') ? '还在' : '不在'}`)
    const coldRes = await ai.chatWithTools(coldSend.messages, tools, profile.id, undefined, { maxOutputTokens: 2048 })
    const coldAnswer = coldRes.content || ''
    const coldUsage = coldRes.usage || {}
    say(`  实报 prompt=${coldUsage.prompt_tokens} 结束原因 ${coldRes.finish_reason || '-'}`)
    say('  回答：' + (coldAnswer || '（没有正文）').replace(/\s+/g, ' ').slice(0, 300))
    check((coldUsage.prompt_tokens || 0) <= budget.contextLength, '冷启动请求没有超过模型窗口', `${coldUsage.prompt_tokens}`)
    check(/ORANGE-19/.test(coldAnswer), '冷启动后它说得出最近留下的口令')
    check(!/VAULT-1900/.test(coldAnswer), '冷启动没有把已经装不下的旧密码带出来')
  }

  fs.rmSync(tmp, { recursive: true, force: true })
  say('')
  finishReport(results)
}

async function writeHandoff(ai, profile, tools, opts) {
  if (!ai || !profile) return null
  const instruction = [
    t('agent.compress_summary_prompt', {
      budget: SUMMARY_OUTPUT_BUDGET_CHARS,
      keepRecent: opts.keepRecent,
    }),
    opts.userHint ? t('agent.compress_summary_user_hint', { hint: opts.userHint }) : '',
  ].filter(Boolean).join('\n\n')
  const messages = [...opts.conversation, { role: 'user', content: instruction }]
  const first = await ai.chatWithTools(messages, tools, profile.id, undefined, { maxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS })
  if (first && first.content && first.content.trim() && !first.thinkingOnly) return first.content.trim()
  const second = await ai.chatWithTools(messages, tools, profile.id, undefined, {
    maxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS,
    toolChoice: 'none',
  })
  return (second && second.content && second.content.trim()) || null
}

function finishReport(results) {
  const ok = results.filter(Boolean).length
  say(`合计 ${ok}/${results.length} 项通过`)
  const out = path.join(os.tmpdir(), 'sf-context-110k-report.txt')
  fs.writeFileSync(out, lines.join('\n'))
  say(`全文写在 ${out}`)
}

main().catch((e) => {
  console.error(e && e.stack ? e.stack : e)
  try {
    fs.writeFileSync(path.join(os.tmpdir(), 'sf-context-110k-report.txt'), lines.join('\n'))
  } catch { /* 报告写失败也不再掩盖原来的错误 */ }
  process.exit(1)
})
