/**
 * 项目组织——真进程端到端：真起命令行进程、真写盘，只是模型换成脚本化的假模型。
 *
 *   node scripts/cli-e2e/organization.mjs        # 全跑
 *   node scripts/cli-e2e/organization.mjs 2      # 只跑编号 2
 *   E2E_KEEP=1 …                                 # 跑完保留临时目录（看日志、落盘记录）
 *
 * 1. 秘书指定一位组长，组长在自己名下派两位伙计，全部做完后一层层交差
 * 2. 组织最多三层：第三层的组长不能再指定组长，组长也不能给手下指定远程主机
 */
import fs from 'node:fs'
import path from 'node:path'
import { callTool, say, startMockLlm } from './mock-llm.mjs'
import { makeChecker, runPlain, sandbox } from './harness.mjs'

const { failures, check } = makeChecker()
const tempDirs = []
const scenarios = []
const scenario = (name, run) => scenarios.push({ name, run })

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return undefined } }
const jsonlLines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [])

/** 盘上的伙计记录：{ 名字: { state, messages } }，和它们所在的主会话目录 */
function readOrg(dataDir) {
  const root = path.join(dataDir, 'history', 'sub-agents')
  const sessions = []
  for (const date of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    for (const id of fs.readdirSync(path.join(root, date))) sessions.push(path.join(root, date, id))
  }
  const children = {}
  for (const sessionDir of sessions) {
    for (const entry of fs.readdirSync(sessionDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === '_openings') continue
      const dir = path.join(sessionDir, entry.name)
      const state = readJson(path.join(dir, 'state.json'))
      if (!state) continue
      children[state.name] = { state, messages: jsonlLines(path.join(dir, 'messages.jsonl')).map((l) => JSON.parse(l)) }
    }
  }
  return { sessions, children }
}

function logWarnings(dataDir) {
  const hits = []
  const walk = (d) => {
    for (const entry of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
      const full = path.join(d, entry.name)
      if (entry.isDirectory()) { if (entry.name !== 'history') walk(full) } else if (entry.name.endsWith('.log')) {
        for (const line of fs.readFileSync(full, 'utf8').split('\n')) {
          if (/(SubAgent|Sub-agent|Organization)/.test(line) && /(warn|error)/i.test(line)) hits.push(line.slice(0, 300))
        }
      }
    }
  }
  walk(dataDir)
  return hits
}

const userText = (m) => (m.role === 'user' ? (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)) : '')

/** 请求属于谁：看对话里最后一条「我是 X」的用户消息；一条都没有的是秘书 */
function whoAsks(entry, names) {
  const messages = entry.body.messages ?? []
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = userText(messages[i])
    const hit = names.find((n) => text.includes(`我是${n}，`))
    if (hit) return hit
  }
  return 'main'
}

const toolNamesOf = (entry) => (entry.body.tools ?? []).map((t) => t.function?.name)

// ───────────────────────────────────────────────────────────── 1
scenario('秘书指定组长，组长在自己名下派人，做完一层层交差', async () => {
  const names = ['研发组长', '甲', '乙']
  const env = sandbox(0, 'sft-org-1', tempDirs)
  const llm = await startMockLlm({
    onUser: (text, _n, entry) => {
      const who = whoAsks(entry, names)
      entry.who = who
      if (who === '研发组长') {
        if (text.includes('我是研发组长，')) {
          return callTool('dispatch_agents', {
            tasks: [
              { name: '甲', description: '写甲文件', prompt: '我是甲，写一份文件' },
              { name: '乙', description: '写乙文件', prompt: '我是乙，写一份文件' },
            ],
          })
        }
        return say('组长汇总：甲乙都做完了')
      }
      if (who === '甲') return callTool('write_text_file', { path: path.join(env.cwd, 'jia.txt'), content: 'a', mode: 'create' })
      if (who === '乙') return callTool('write_text_file', { path: path.join(env.cwd, 'yi.txt'), content: 'b', mode: 'create' })
      if (text.includes('[专家') || text.includes('[伙计')) return say('秘书收到：组织做完了')
      return callTool('dispatch_agents', {
        tasks: [{ name: '研发组长', role: '研发组长', lead: true, description: '带研发组做事', prompt: '我是研发组长，带两位伙计各写一份文件' }],
      })
    },
    afterTool: (last, entry) => {
      const who = whoAsks(entry, names)
      entry.who = who
      if (who === '甲' || who === '乙') return say(`${who}：做完了`)
      return say('已派出，等他们')
    },
  })
  env.env.SFT_API_URL = `http://127.0.0.1:${llm.port}/v1`
  try {
    const result = await runPlain(['组织研发组做事', '--free'], env, 120_000)
    check('正常退出', result.code === 0, `exit ${result.code} ${result.err.slice(0, 300)}`)
    check('秘书最后收到了交差', result.out.includes('秘书收到'), result.out.slice(-400))

    const { sessions, children } = readOrg(env.dataDir)
    check('伙计记录只有一场主会话，组长名下的人也记在它下面', sessions.length === 1, String(sessions.length))
    check('组长、甲、乙都记下了', ['研发组长', '甲', '乙'].every((n) => children[n]), Object.keys(children).join())
    check('组长标着是组长，是秘书直接派的', children['研发组长']?.state.lead === true && !children['研发组长']?.state.parent, JSON.stringify(children['研发组长']?.state))
    check('甲、乙是组长派的', children['甲']?.state.parent === '研发组长' && children['乙']?.state.parent === '研发组长',
      JSON.stringify([children['甲']?.state.parent, children['乙']?.state.parent]))
    check('全部做完', Object.values(children).every((c) => c.state.status === 'completed'),
      Object.values(children).map((c) => `${c.state.name}:${c.state.status}`).join(' '))
    check('甲乙的文件真的写出来了', fs.existsSync(path.join(env.cwd, 'jia.txt')) && fs.existsSync(path.join(env.cwd, 'yi.txt')))

    const askedTools = (who) => llm.requests.find((r) => r.hasTools && r.who === who)
    check('秘书有派人的工具', toolNamesOf(askedTools('main') ?? { body: {} }).includes('dispatch_agents'))
    check('组长也有派人、再交代、等待、打断', (() => {
      const tools = toolNamesOf(askedTools('研发组长') ?? { body: {} })
      return ['dispatch_agents', 'followup_agent', 'wait_agents', 'interrupt_agent'].every((t) => tools.includes(t))
    })(), toolNamesOf(askedTools('研发组长') ?? { body: {} }).join())
    check('伙计没有派人的工具', (() => {
      const tools = toolNamesOf(askedTools('甲') ?? { body: {} })
      return tools.length > 0 && !tools.includes('dispatch_agents')
    })())
    const warnings = logWarnings(env.dataDir)
    check('日志里没有相关警告', warnings.length === 0, warnings.slice(0, 3).join('\n'))
  } finally { await llm.close() }
})

// ───────────────────────────────────────────────────────────── 2
scenario('组织最多三层，组长不能给手下指定远程主机', async () => {
  const names = ['组长一', '组长二', '组长三']
  const env = sandbox(0, 'sft-org-2', tempDirs)
  const seen = { depthError: '', remoteError: '' }
  const next = { 组长一: '组长二', 组长二: '组长三' }
  const llm = await startMockLlm({
    onUser: (text, _n, entry) => {
      const who = whoAsks(entry, names)
      entry.who = who
      if (who === 'main') {
        if (text.includes('[专家') || text.includes('[伙计')) return say('秘书收到：一路做完了')
        return callTool('dispatch_agents', {
          tasks: [{ name: '组长一', role: '一层组长', lead: true, description: '第一层', prompt: '我是组长一，再指定一位组长' }],
        })
      }
      if (text.includes(`我是${who}，`)) {
        if (next[who]) {
          return callTool('dispatch_agents', {
            tasks: [{ name: next[who], role: `${next[who]}负责人`, lead: true, description: `下一层 ${next[who]}`, prompt: `我是${next[who]}，再指定一位组长` }],
          })
        }
        // 第三层：先试着再指定组长，再试着给手下指定远程主机
        return callTool('dispatch_agents', {
          tasks: [{ name: '第四层', role: '四层负责人', lead: true, description: '超出层数', prompt: '我是第四层，随便' }],
        })
      }
      return say(`${who}：做完了`)
    },
    afterTool: (last, entry) => {
      const who = whoAsks(entry, names)
      entry.who = who
      const content = typeof last.content === 'string' ? last.content : JSON.stringify(last.content)
      if (who === '组长三') {
        if (content.includes('最多 3 层')) {
          seen.depthError = content
          return callTool('dispatch_agents', {
            tasks: [{ name: '干活的', description: '连主机', prompt: '我是干活的，随便', hosts: ['sess-1'], remote_commands: ['ls'] }],
          })
        }
        if (content.includes('不能给名下的人指定远程主机')) {
          seen.remoteError = content
          return say('组长三：两个都被拒了')
        }
      }
      if (who === 'main' || next[who]) return say('已派出，等他们')
      return say(`${who}：做完了`)
    },
  })
  env.env.SFT_API_URL = `http://127.0.0.1:${llm.port}/v1`
  try {
    const result = await runPlain(['搭三层组织', '--free'], env, 120_000)
    check('正常退出', result.code === 0, `exit ${result.code} ${result.err.slice(0, 300)}`)
    check('第三层的组长再指定组长被退回，说明是层数', seen.depthError.includes('最多 3 层'), seen.depthError)
    check('组长指定远程主机被退回，说明由秘书授权', seen.remoteError.includes('只有秘书能给'), seen.remoteError)
    const { children } = readOrg(env.dataDir)
    check('三位组长按层挂着', children['组长二']?.state.parent === '组长一' && children['组长三']?.state.parent === '组长二' && !children['组长一']?.state.parent,
      JSON.stringify(Object.values(children).map((c) => [c.state.name, c.state.parent])))
    check('被退回的没有进名册', !children['第四层'] && !children['干活的'], Object.keys(children).join())
    check('全部做完，秘书收到交差', Object.values(children).every((c) => c.state.status === 'completed') && result.out.includes('秘书收到'),
      Object.values(children).map((c) => `${c.state.name}:${c.state.status}`).join(' ') + ' | ' + result.out.slice(-300))
    const warnings = logWarnings(env.dataDir)
    check('日志里没有相关警告', warnings.length === 0, warnings.slice(0, 3).join('\n'))
  } finally { await llm.close() }
})

// ─────────────────────────────────────────────────────────────
const only = process.argv.slice(2).map(Number).filter(Boolean)
for (const [index, item] of scenarios.entries()) {
  if (only.length && !only.includes(index + 1)) continue
  console.log(`\n▶ ${index + 1}. ${item.name}`)
  const started = Date.now()
  try {
    await item.run()
  } catch (error) {
    failures.push(`${item.name} — 脚本出错：${error?.stack || error}`)
    console.error(`  FAIL 脚本出错：${error?.stack || error}`)
  }
  console.log(`  （${((Date.now() - started) / 1000).toFixed(1)}s）`)
}

if (!process.env.E2E_KEEP) for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })

console.log(failures.length ? `\nRESULT FAIL (${failures.length})\n${failures.map((f) => `  - ${f}`).join('\n')}` : '\nRESULT PASS')
process.exit(failures.length ? 1 : 0)
