#!/usr/bin/env node
/* eslint-env node */
/**
 * 压缩调用探针：验证「小结指令追加在当前对话末尾」这条路真的走得通。
 *
 * 新方案把压缩指令当成一条 user 消息接在对话后面发出去，而不是另起一次调用把
 * 对话拍平成转录文本。两个假设需要真实 API 才能验证：
 *   1. 前缀逐字未变 → provider 的前缀缓存应当命中，压缩这一步几乎不额外花钱
 *   2. 模型在原本语境里读得懂这份「只描述处境、不列清单」的指令，写得出可用的交接
 *
 * 做法：先发一次带长对话的请求建立缓存，再把压缩指令追加到同一段对话后面发第二次，
 * 比对第二次的 cached_tokens 与小结正文。
 *
 * 用法：node scripts/probe-compaction.js [--profile <id>]
 * 代价：两次真实 API 调用。
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
const { stripCompositionMarkers } = require(path.join(svcDir, 'agent', 'context-composition.ts'))
const { t } = require(path.join(svcDir, 'agent', 'i18n.ts'))
const { resolveSummaryBudget } = require(path.join(svcDir, 'ai-request-budget.ts'))
// 探针不跑真实窗口，按下限那一档写小结
const SUMMARY_BUDGET = resolveSummaryBudget(0, 128000)

function parseArgs() {
  const argv = process.argv.slice(2)
  const i = argv.indexOf('--profile')
  return { profileId: i >= 0 ? argv[i + 1] : undefined }
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

/**
 * 模拟一段跑了一阵子的运维会话：多个已结束任务 + 一个进行中的任务，
 * 中间过程里塞进只有工具输出里才有、最终答复里没有的事实，用来检验
 * 小结会不会把它们捞出来。
 */
function buildConversation(systemPrompt) {
  const bigOutput = (label, n) =>
    Array.from({ length: n }, (_, i) => `${label} line ${i}: ${'x'.repeat(60)}`).join('\n')

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: '帮我看看这台机器磁盘为什么满了' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'exec', arguments: '{"command":"df -h"}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: `Filesystem  Size Used Avail Use%\n/dev/sda1   200G 190G  2G   99% /\n${bigOutput('df', 40)}` },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'exec', arguments: '{"command":"du -sh /var/*"}' } }] },
    { role: 'tool', tool_call_id: 'c2', content: `120G /var/log/app-2024\n30G /var/lib/docker\n${bigOutput('du', 40)}` },
    { role: 'assistant', content: '根分区 99% 已满，主要是 /var/log/app-2024 占了 120G。' },
    { role: 'user', content: '那清理一下旧日志' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c3', type: 'function', function: { name: 'exec', arguments: '{"command":"rm -rf /var/log/app-2024/2023*"}' } }] },
    { role: 'tool', tool_call_id: 'c3', content: 'rm: cannot remove: Operation not permitted (需要 sudo，当前用户 deploy 不在 sudoers)' },
    { role: 'assistant', content: '清理失败：当前用户 deploy 没有权限，需要你用有 sudo 的账号执行。' },
    { role: 'user', content: '好，那你先把所有超过 1G 的日志文件列个清单给我，写到 /tmp/big-logs.txt' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c4', type: 'function', function: { name: 'exec', arguments: '{"command":"find /var/log -size +1G"}' } }] },
    { role: 'tool', tool_call_id: 'c4', content: `/var/log/app-2024/access.log\n/var/log/app-2024/error.log\n${bigOutput('find', 30)}\n共 57 个文件` },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c5', type: 'function', function: { name: 'exec', arguments: '{"command":"stat ..."}' } }] },
    { role: 'tool', tool_call_id: 'c5', content: `已处理 30/57 个文件，当前写入 /tmp/big-logs.txt（部分完成）\n${bigOutput('stat', 30)}` },
    // 再跑几轮无关紧要的过程，把上面那些关键事实推进「会被归档」的区段。
    // 保留最近 2 轮之后它们就不在眼前了，追问答得上来才说明交接真管用。
    ...[6, 7, 8, 9].flatMap((n) => [
      {
        role: 'assistant', content: '',
        tool_calls: [{ id: `c${n}`, type: 'function', function: { name: 'exec', arguments: `{"command":"stat batch-${n}"}` } }],
      },
      { role: 'tool', tool_call_id: `c${n}`, content: `批次 ${n} 完成\n${bigOutput('stat', 150)}` },
    ]),
  ]
}

async function main() {
  const { profileId } = parseArgs()
  const config = new ConfigService()
  const ai = new AiService(config)
  const profiles = config.getAiProfiles().filter((p) => p.apiKey)
  const profile = profiles.find((p) => p.id === (profileId || config.getActiveAiProfile())) || profiles[0]
  if (!profile) {
    console.log('没有可用的 AI 配置（缺 apiKey）')
    return
  }

  const context = {
    terminalType: 'assistant',
    workingDirectory: '/tmp',
    hostId: 'local',
    systemInfo: { os: process.platform, shell: 'zsh' },
  }
  const systemPrompt = stripCompositionMarkers(new PromptBuilder({ context, executionMode: 'relaxed' }).build())
  const tools = getAgentTools(undefined, { mode: 'assistant', includeContextTools: true }, undefined)
  const conversation = buildConversation(systemPrompt)

  console.log(`\n模型：${profile.model}`)
  console.log(`对话规模：${conversation.length} 条消息 + ${tools.length} 个工具\n`)

  // 第 1 次：正常一轮，建立前缀缓存
  const warm = await ai.chatWithTools(conversation, tools, profile.id)
  const warmUsage = warm.usage || {}
  console.log(`第 1 次（正常一轮）  prompt=${warmUsage.prompt_tokens}  cached=${readCachedTokens(warmUsage) ?? '-'}`)

  await new Promise((r) => setTimeout(r, 1500))

  // 第 2 次：同一段对话末尾追加压缩指令
  const instruction = t('agent.compress_summary_prompt', {
    budget: SUMMARY_BUDGET.chars,
    keepRecent: 2,
  })
  // 带上与平时同样的 tools：缓存按前缀逐字匹配，平时每轮都带 tools schema，
  // 压缩这次若不带，前缀就变了，缓存必然落空。代价是模型可能返回 tool_calls 而非
  // 文本小结——这里一并验证它到底会不会。
  const compactRes = await ai.chatWithTools(
    [...conversation, { role: 'user', content: instruction }],
    tools,
    profile.id
  )
  const usage = compactRes.usage || {}
  const cached = readCachedTokens(usage)
  const rate = cached && usage.prompt_tokens ? Math.round((cached / usage.prompt_tokens) * 100) : 0
  console.log(`第 2 次（追加压缩指令）prompt=${usage.prompt_tokens}  cached=${cached ?? '-'}  命中 ${rate}%`)
  const calls = compactRes.tool_calls || compactRes.toolCalls || []
  console.log(
    `             返回形态：${calls.length ? `⚠️ tool_calls(${calls.map((c) => c.function?.name).join(',')})` : '✅ 文本'}`
  )
  const summary = compactRes.content

  console.log('\n────────── 小结正文 ──────────')
  console.log(summary)
  console.log('──────────────────────────────\n')

  // 只做机械的存在性检查，质量由人读
  const checks = [
    ['提到 deploy 用户没有 sudo（失败原因，只在工具输出里）', /sudo|权限|deploy/],
    ['提到 30/57 这个进度（只在中间过程里）', /30\s*\/\s*57|30 个|57/],
    ['保留了 /tmp/big-logs.txt 路径原样', /\/tmp\/big-logs\.txt/],
  ]
  console.log('机械检查（仅看有没有，写得好不好要人读）：')
  for (const [label, re] of checks) {
    console.log(`  ${re.test(summary || '') ? '✅' : '❌'} ${label}`)
  }
  console.log()

  await probeHandoff({ ai, profile, tools, conversation, warmUsage })
}

/**
 * 交接是否真的管用：走完整压缩流程拿到压缩产物，再拿它去问几件
 * 「只有看过被归档内容才答得上来」的事。
 *
 * 前两步只证明小结写得出来，这一步才证明压完还能接着干活——压缩产物既要是
 * API 收得下的合法序列，也要让模型答得出被归档掉的关键事实。
 */
async function probeHandoff({ ai, profile, tools, conversation, warmUsage }) {
  const { ContextWindowManager } = require(path.join(svcDir, 'agent', 'context-window.ts'))

  const run = {
    id: 'probe', originalUserRequest: 'probe', messages: [...conversation], steps: [],
    isRunning: false, aborted: false, pendingUserMessages: [], config: {}, context: {},
    realtimeOutputBuffer: [], executionPhase: 'idle', taskMessageLog: [],
  }

  const manager = new ContextWindowManager({
    // 窗口在这里临时按小的算：真机 profile 是 1M，跑不到压缩线。
    // 不改磁盘配置——模型列表同步会用 API 报告的窗口覆盖本地值。
    config: {
      getAiProfiles: () => [{ ...profile, contextLength: 24000 }],
      getActiveAiProfile: () => profile.id,
    },
    getProfileId: () => profile.id,
    getLastPromptTokens: () => warmUsage.prompt_tokens,
    getLastCacheHitRate: () => undefined,
    reportUsage: () => {},
    getTools: () => tools,
    summarizeMessages: async (opts) => {
      const res = await ai.chatWithTools(
        [...opts.conversation, {
          role: 'user',
          content: t('agent.compress_summary_prompt', {
            budget: SUMMARY_BUDGET.chars,
            keepRecent: opts.keepRecent,
          }),
        }],
        tools,
        profile.id
      )
      return res.content
    },
  })

  const result = await manager.proactiveCompress(run)
  if (!result) {
    console.log('压缩未执行（可压缩范围不足），跳过交接验证\n')
    return
  }
  console.log(
    `压缩执行：${conversation.length} 条 → ${run.messages.length} 条，` +
    `释放 ${result.freedTokens} tokens，保留最近 ${result.keepRecent} 轮\n`
  )

  // 问的三件事全在被归档的中间过程里，压缩产物里只剩交接小结提到的部分
  const question =
    '接着之前的事继续。先用一句话分别回答：(1) 大文件清单一共多少个文件、已处理多少个？' +
    '(2) 上次清理日志失败的具体原因是什么？(3) 清单要写到哪个路径？'
  const followUp = await ai.chatWithTools(
    [...run.messages, { role: 'user', content: question }],
    tools,
    profile.id
  )
  const answer = followUp.content || ''
  console.log('────────── 压缩后追问的回答 ──────────')
  console.log(answer || '(模型未返回文本)')
  console.log('──────────────────────────────────────\n')

  const handoffChecks = [
    ['答出 57 个文件 / 已处理 30 个', /57/.test(answer) && /30/.test(answer)],
    ['答出失败原因是权限（sudo / deploy）', /sudo|权限|sudoers|deploy/.test(answer)],
    ['答出输出路径 /tmp/big-logs.txt', /\/tmp\/big-logs\.txt/.test(answer)],
  ]
  console.log('交接有效性（压缩后模型还知不知道这些事）：')
  for (const [label, ok] of handoffChecks) console.log(`  ${ok ? '✅' : '❌'} ${label}`)
  console.log()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
