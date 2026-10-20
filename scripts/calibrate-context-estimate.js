#!/usr/bin/env node
/* eslint-env node */
/**
 * 上下文估算校准：拿本地估算值和 API 返回的真实 prompt_tokens 对账。
 *
 * 本地 token 估算是所有压缩/缓存判定的共同依据，但它只是估算——唯一能证明它
 * 准不准的办法就是真打一次 API，把真实 prompt_tokens 拿回来比。
 *
 * 用法：node scripts/calibrate-context-estimate.js [--profile <id>]
 * 代价：一次真实 API 调用（max_tokens 极小）。
 */
'use strict'

const Module = require('module')
const path = require('path')

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
const { PromptBuilder } = require(path.join(svcDir, 'agent', 'prompt-builder.ts'))
const { getAgentTools } = require(path.join(svcDir, 'agent', 'tools.ts'))
const { estimateTextTokens } = require(path.join(svcDir, 'agent', 'token-estimate.ts'))
const { stripCompositionMarkers } = require(path.join(svcDir, 'agent', 'context-composition.ts'))
const { ContextWindowManager } = require(path.join(svcDir, 'agent', 'context-window.ts'))

function parseArgs() {
  const argv = process.argv.slice(2)
  const i = argv.indexOf('--profile')
  return {
    profileId: i >= 0 ? argv[i + 1] : undefined,
    /** 跨模型系数对比：每个模型只打 3 次极小请求 */
    coef: argv.includes('--coef'),
  }
}

/**
 * 跨模型测量中文/英文的真实 tok/char 系数。
 * 决定「系数能否硬编码」——各家差异大就必须走自校准。
 */
async function measureCoefficients(ai, config, profiles) {
  const CN = '这是一段用来校准中文系数的文本，包含常见的中文表述与标点。'.repeat(60)
  const EN = JSON.stringify({
    name: 'execute_command',
    description: 'Execute a shell command on the local machine and return its output.',
    parameters: { type: 'object', properties: { command: { type: 'string' } } },
  }).repeat(30)
  const tiny = { role: 'user', content: '嗯' }

  console.log(
    `\n${'模型'.padEnd(28)} ${'中文'.padStart(9)} ${'英文JSON'.padStart(9)}   (真实 tok/char，代码现用 1.5 / 0.5)\n`
  )

  for (const p of profiles) {
    try {
      const probe = async (msgs) => {
        const r = await ai.chatWithTools(msgs, [], p.id)
        if (!r.usage || !r.usage.prompt_tokens) throw new Error('无 usage')
        return r.usage.prompt_tokens
      }
      const base = await probe([tiny])
      const cn = (await probe([{ role: 'user', content: CN }])) - base
      const en = (await probe([{ role: 'user', content: EN }])) - base
      console.log(
        `${p.model.padEnd(28)} ${(cn / CN.length).toFixed(3).padStart(9)} ${(en / EN.length).toFixed(3).padStart(9)}`
      )
    } catch (e) {
      console.log(`${p.model.padEnd(28)} ${'—'.padStart(9)} ${'—'.padStart(9)}   (${e.message})`)
    }
  }
  console.log('')
}

async function main() {
  const { profileId, coef } = parseArgs()
  const config = new ConfigService()
  const ai = new AiService(config)

  const profiles = config.getAiProfiles()
  if (!profiles.length) {
    console.error('没有配置任何 AI Profile，无法校准。')
    process.exit(1)
  }
  const targetId = profileId || config.getActiveAiProfile() || profiles[0].id
  const profile = profiles.find(p => p.id === targetId) || profiles[0]

  if (coef) {
    // 跨主流厂商各测一个，覆盖 DeepSeek / Moonshot / 阿里 / 火山 / Anthropic
    const wanted = ['deepseek-flash', 'kimi-k2.6', 'qwen3.8-27b', 'doubao-seed-2-1-turbo-260628', 'claude-opus-4-8']
    const picked = wanted
      .map(m => profiles.find(p => p.model === m))
      .filter(Boolean)
    await measureCoefficients(ai, config, picked)
    return
  }

  // —— 构造一次「典型」请求：真实 system prompt + 真实工具集 + 一段对话 ——
  const context = {
    ptyId: 'calibrate',
    terminalOutput: [],
    systemInfo: { os: process.platform, shell: process.env.SHELL || '/bin/zsh' },
    terminalType: 'local',
  }
  const systemPrompt = stripCompositionMarkers(
    new PromptBuilder({ context, executionMode: 'relaxed' }).build()
  )
  const tools = getAgentTools(undefined, { mode: 'local', includeContextTools: true }, undefined)

  const tinyUser = { role: 'user', content: '嗯' }
  const chineseBody = '这是一段用来校准中文系数的文本，包含常见的中文表述与标点。'.repeat(60)

  console.log(`\nmodel : ${profile.model}`)
  console.log(`正在分项校准（4 次极小请求）...\n`)

  async function probe(label, messages, toolList) {
    const r = await ai.chatWithTools(messages, toolList, profile.id)
    const real = r.usage && r.usage.prompt_tokens
    if (!real) throw new Error(`${label}: API 未返回 usage.prompt_tokens`)
    return real
  }

  // 1) 空载：只有一条极短消息、无工具 → 协议固定开销
  const baseline = await probe('baseline', [tinyUser], [])
  // 2) 加工具：差值 = 工具清单的真实 token
  const withTools = await probe('tools', [tinyUser], tools)
  // 3) 加 system prompt（无工具）：差值 = system prompt 的真实 token
  const withSystem = await probe('system', [{ role: 'system', content: systemPrompt }, tinyUser], [])
  // 4) 纯中文正文：差值 = 中文的真实系数
  const withChinese = await probe('chinese', [{ role: 'user', content: chineseBody }], [])

  const realTools = withTools - baseline
  const realSystem = withSystem - baseline
  const realChinese = withChinese - baseline

  const toolsChars = JSON.stringify(tools).length
  const systemChars = systemPrompt.length
  const chineseChars = chineseBody.length

  /** Codex 口径：UTF-8 字节数 / 4 */
  const byteEstimate = (text) => Math.ceil(Buffer.byteLength(text, 'utf8') / 4)

  const row = (label, text, real) => {
    const chars = text.length
    const cur = estimateTextTokens(text)
    const byteBased = byteEstimate(text)
    const pct = (v) => `${(((v - real) / real) * 100).toFixed(1)}%`.padStart(8)
    return (
      `${label.padEnd(14)} ${String(chars).padStart(6)}c/${String(Buffer.byteLength(text, 'utf8')).padStart(6)}b  ` +
      `真实 ${String(real).padStart(5)}  |  现字符法 ${String(cur).padStart(6)} ${pct(cur)}  |  ` +
      `字节法 ${String(byteBased).padStart(6)} ${pct(byteBased)}`
    )
  }

  console.log(`协议基线（空载）: ${baseline} tokens\n`)
  console.log(row('tools schema', JSON.stringify(tools), realTools))
  console.log(row('system prompt', systemPrompt, realSystem))
  console.log(row('中文正文', chineseBody, realChinese))

  // —— 整体：当前实现的端到端偏差 ——
  const messages = [{ role: 'system', content: systemPrompt }, tinyUser]
  const cwm = new ContextWindowManager({
    config,
    getProfileId: () => profile.id,
    getLastPromptTokens: () => undefined,
    getLastCacheHitRate: () => undefined,
    reportUsage: () => {},
    getTools: () => tools,
  })
  const estimated = cwm.estimateTotalTokens(messages)
  const real = await probe('full', messages, tools)
  const drift = ((estimated - real) / real) * 100

  console.log(`\n端到端（system + tools + 短消息）`)
  console.log(`  真实 prompt_tokens : ${real}`)
  console.log(`  本地估算           : ${estimated}`)
  console.log(`  偏差               : ${drift >= 0 ? '+' : ''}${drift.toFixed(1)}%   ${Math.abs(drift) < 15 ? 'OK' : '>>> 偏差过大'}\n`)
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('校准失败:', err && err.message ? err.message : err)
    process.exit(1)
  })
