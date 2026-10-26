/**
 * 项目组织——真进程端到端：真起命令行进程、真写盘，只是模型换成脚本化的假模型。
 *
 *   node scripts/cli-e2e/organization.mjs        # 全跑
 *   node scripts/cli-e2e/organization.mjs 2      # 只跑编号 2
 *   E2E_KEEP=1 …                                 # 跑完保留临时目录（看日志、落盘记录）
 *
 * 1. 秘书指定一位组长，组长在自己名下派两位伙计，全部做完后一层层交差
 * 2. 组织最多三层：第三层的组长不能再指定组长，组长也不能给手下指定远程主机
 * 3. 组长名下的专家团里有人点名秘书：话直达秘书，秘书点名回应，记进那个群、送到那位专家
 * 4. 进程被 kill -9：新进程接着同一场会话，秘书再交代组长，组长再把他名下的人叫起来
 * 5. 团里有验收人：先打回、改完再通过，结论记进群聊，团停下时交给组长的话里带着最近一次结论
 * 6. 终端里按 Ctrl+C：整个组织一起停下，不留还在干的人，也不留还在跑的命令
 */
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { callTool, say, startMockLlm } from './mock-llm.mjs'
import { ROOT, Terminal, makeChecker, runPlain, sandbox, sleep, startPlain, until } from './harness.mjs'

const RUNNER = path.join(ROOT, 'scripts/cli-e2e/resume-runner.cjs')
const killStrays = (marker) => { try { execSync(`pkill -f '${marker}'`, { stdio: 'ignore' }) } catch { /* 没有残留 */ } }

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
    // 共享工作区：看板和各人的结果文件都在秘书这一轮目录的 org/ 下
    const found = (name) => {
      const hits = []
      const walk = (d) => {
        for (const entry of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
          const full = path.join(d, entry.name)
          if (entry.isDirectory()) walk(full)
          else if (entry.name === name) hits.push(full)
        }
      }
      walk(path.join(env.dataDir, 'agent-workspace'))
      return hits
    }
    const boards = found('board.md')
    check('组织看板写出来了', boards.length === 1, boards.join())
    const board = boards[0] ? fs.readFileSync(boards[0], 'utf8') : ''
    check('看板上有组长和他名下的人，状态是做完', ['研发组长', '甲', '乙'].every((n) => board.includes(n)) && !board.includes('没做完的人 -'), board.slice(0, 600))
    check('看板合计写着 0 人没做完', board.includes('0 人没做完'), board.slice(0, 200))
    const jia = found('甲.md')
    check('组长名下的人的结果文件放在 org/<组长>/ 下', jia.length === 1 && jia[0].includes(`${path.sep}org${path.sep}`), jia.join())
    const secretaryOwn = found('研发组长.md')
    check('组长自己的结果放在秘书这一层，不在 org/ 里', secretaryOwn.length === 1 && !secretaryOwn[0].includes(`${path.sep}org${path.sep}`), secretaryOwn.join())
    const opening = (who) => JSON.stringify(llm.requests.find((r) => r.hasTools && r.who === who)?.body.messages ?? [])
    check('组长、手下的开场里有看板位置，组长另有他名下的目录', opening('研发组长').includes('board.md') && opening('甲').includes('board.md') && opening('研发组长').includes('你是组长'),
      opening('研发组长').slice(0, 300))
    check('秘书的开场不多这一段', !opening('main').includes('项目组织里'))
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

// ───────────────────────────────────────────────────────────── 3
scenario('下面一层的团里点名秘书，秘书点名回应', async () => {
  const names = ['研发组', '前端', '后端']
  const env = sandbox(0, 'sft-org-3', tempDirs)
  const seen = { mention: '', reply: false, sayResult: '', main: [] }
  const llm = await startMockLlm({
    onUser: (text, _n, entry) => {
      const who = whoAsks(entry, names)
      entry.who = who
      if (who === 'main') {
        if (text.includes('点名秘书')) {
          seen.mention = text
          return callTool('followup_agent', { name: '前端', message: '范围这样定：只做登录页' })
        }
        if (text.includes('[专家') || text.includes('[伙计')) return say('秘书收到：组织做完了')
        return callTool('dispatch_agents', {
          tasks: [{ name: '研发组', role: '研发组长', lead: true, description: '带研发组做事', prompt: '我是研发组，组一个两人的项目团' }],
        })
      }
      if (who === '研发组') {
        if (text.includes('我是研发组，')) {
          return callTool('dispatch_agents', {
            team: '项目团',
            tasks: [
              { name: '前端', role: '前端专家', description: '前端', prompt: '我是前端，做界面' },
              { name: '后端', role: '后端专家', description: '后端', prompt: '我是后端，做接口' },
            ],
          })
        }
        return say('组长汇总：项目团做完了')
      }
      if (who === '前端') {
        if (text.includes('我是前端，')) return callTool('team_say', { to: ['秘书'], message: '需求范围不清，请秘书定一下' })
        seen.reply = seen.reply || text.includes('范围这样定')
        return say('前端：收到秘书的答复，做完了')
      }
      return say(`${who}：做完了`)
    },
    afterTool: (last, entry) => {
      const who = whoAsks(entry, names)
      entry.who = who
      const content = typeof last.content === 'string' ? last.content : JSON.stringify(last.content)
      if (who === '前端') {
        if (content.includes('秘书会收到')) {
          seen.sayResult = content
          // 手上还有一步没走完，秘书的回应会在这一步走完后送到
          return callTool('exec', { command: 'sleep 3' })
        }
        seen.reply = JSON.stringify(entry.body.messages ?? []).includes('范围这样定')
        return say('前端：收到秘书的答复，做完了')
      }
      if (who === '研发组' || who === 'main') return say('已派出，等他们')
      return say(`${who}：做完了`)
    },
  })
  env.env.SFT_API_URL = `http://127.0.0.1:${llm.port}/v1`
  try {
    const result = await runPlain(['组织研发组做事', '--free'], env, 120_000)
    check('正常退出', result.code === 0, `exit ${result.code} ${result.err.slice(0, 300)}`)
    check('团员点名秘书，工具结果说秘书会收到', seen.sayResult.includes('秘书会收到'), seen.sayResult)
    check('秘书收到敲门，带着原话和团名', seen.mention.includes('需求范围不清') && seen.mention.includes('项目团'), seen.mention.slice(0, 300))
    check('秘书的回应送到了那位专家手上', seen.reply)
    check('最后秘书收到组织的交差', result.out.includes('秘书收到'), result.out.slice(-300))

    const { children } = readOrg(env.dataDir)
    check('专家团成员挂在组长名下', children['前端']?.state.parent === '研发组' && children['后端']?.state.parent === '研发组',
      JSON.stringify(Object.values(children).map((c) => [c.state.name, c.state.parent])))
    const chatRoot = path.join(env.dataDir, 'history', 'expert-teams')
    const chatText = fs.existsSync(chatRoot)
      ? fs.readdirSync(chatRoot, { recursive: true }).filter((f) => String(f).endsWith('.jsonl')).map((f) => fs.readFileSync(path.join(chatRoot, String(f)), 'utf8')).join('\n')
      : ''
    check('群聊记录里有秘书的回应', chatText.includes('范围这样定') && chatText.includes('秘书'), chatText.slice(0, 300))
    const warnings = logWarnings(env.dataDir)
    check('日志里没有相关警告', warnings.length === 0, warnings.slice(0, 3).join('\n'))
  } finally { await llm.close() }
})

// ───────────────────────────────────────────────────────────── 4
scenario('进程被 kill -9：新进程接着同一场会话，秘书叫醒组长，组长叫醒他名下的人', async () => {
  const names = ['研发组', '小甲', '小乙']
  const env = sandbox(0, 'sft-org-4', tempDirs)
  const makeLlm = (marker) => {
    const seen = { jiaExec: false, yiDone: false }
    return startMockLlm({
      onUser: (text, _n, entry) => {
        const who = whoAsks(entry, names)
        entry.who = who
        if (who === 'main') {
          if (text.includes('让研发组')) return callTool('followup_agent', { name: '研发组', message: '接着做完' })
          if (text.includes('[专家') || text.includes('[伙计')) return say('秘书收到：组织做完了')
          return callTool('dispatch_agents', {
            tasks: [{ name: '研发组', role: '研发组长', lead: true, description: '带研发组做事', prompt: '我是研发组，带小甲、小乙做事' }],
          })
        }
        if (who === '研发组') {
          if (text.includes('我是研发组，')) {
            return callTool('dispatch_agents', {
              tasks: [
                { name: '小甲', description: '写文件再慢慢跑', prompt: '我是小甲，写一份文件，然后跑一条很慢的命令' },
                { name: '小乙', description: '写一份文件', prompt: '我是小乙，写一份文件就行' },
              ],
            })
          }
          if (text.includes('[上次的情形]')) return callTool('followup_agent', { name: '小甲', message: '接着做完' })
          return say('组长汇总：都做完了')
        }
        if (who === '小甲') {
          if (text.includes('我是小甲，')) return callTool('write_text_file', { path: path.join(env.cwd, 'jia.txt'), content: 'a', mode: 'create' })
          return say('小甲：接着做完了')
        }
        if (who === '小乙') return callTool('write_text_file', { path: path.join(env.cwd, 'yi.txt'), content: 'b', mode: 'create' })
        return say('好')
      },
      afterTool: (last, entry) => {
        const who = whoAsks(entry, names)
        entry.who = who
        const content = typeof last.content === 'string' ? last.content : ''
        if (who === '小甲') {
          if (entry.body.messages.filter((m) => m.role === 'tool').length === 1) { seen.jiaExec = true; return callTool('exec', { command: `sleep ${marker}` }) }
          return say('小甲：做完了')
        }
        if (who === '小乙') { seen.yiDone = true; return say('小乙：做完了') }
        if (who === '研发组' && content.includes('已向')) return say('组长：已交代，等他')
        if (who === '研发组' || who === 'main') return say('已派出，等他们')
        return say('好')
      },
    }).then((server) => Object.assign(server, { seen }))
  }

  const llm1 = await makeLlm(64)
  env.env.SFT_API_URL = `http://127.0.0.1:${llm1.port}/v1`
  const first = startPlain(['组织研发组做事', '--free'], env)
  try {
    check('小甲开了工、小乙做完了', await until(() => llm1.seen.jiaExec && llm1.seen.yiDone, 60_000), JSON.stringify(llm1.seen))
    await sleep(1200)
    first.child.kill('SIGKILL')
    const exit = await first.done
    check('进程是被强杀的', exit.signal === 'SIGKILL', JSON.stringify({ code: exit.code, signal: exit.signal }))
  } finally {
    await llm1.close()
    killStrays('sleep 64')
  }

  const before = readOrg(env.dataDir)
  check('盘上只有一场主会话，组织里三个人都记下了', before.sessions.length === 1 && ['研发组', '小甲', '小乙'].every((n) => before.children[n]),
    `${before.sessions.length} ${Object.keys(before.children).join()}`)
  check('小甲、小乙记着是研发组派的，研发组是组长', before.children['小甲']?.state.parent === '研发组' && before.children['小乙']?.state.parent === '研发组' && before.children['研发组']?.state.lead === true,
    JSON.stringify(Object.values(before.children).map((c) => [c.state.name, c.state.parent, c.state.lead])))
  check('小甲盘上还写着「在干」', before.children['小甲']?.state.status === 'running', JSON.stringify(before.children['小甲']?.state))
  const sessionId = path.basename(before.sessions[0])

  const llm2 = await makeLlm(65)
  try {
    const resumed = await runPlain([], {
      ...env,
      env: { ...env.env, SFT_API_URL: `http://127.0.0.1:${llm2.port}/v1`, RESUME_SESSION: sessionId, RESUME_LINE: '让研发组接着做完' },
    }, 90_000, RUNNER)
    check('新进程说完这一轮', resumed.out.includes('RESUME_DONE'), `${resumed.out.slice(-300)} ${resumed.err.slice(-600)}`)
    const leadBack = llm2.requests.find((r) => r.who === '研发组' && r.lastText.includes('[上次的情形]'))
    check('组长被叫醒时带着盘上的对话，并被告知异常退出', !!leadBack && leadBack.lastText.includes('异常退出') && leadBack.lastText.includes('接着做完'), leadBack?.lastText)
    const jiaBack = llm2.requests.find((r) => r.who === '小甲' && r.lastText.includes('[上次的情形]'))
    check('组长再把他名下的小甲叫醒，小甲带着盘上的对话', !!jiaBack && jiaBack.lastText.includes('异常退出') && jiaBack.lastText.includes('接着做完'), jiaBack?.lastText)
    const after = readOrg(env.dataDir)
    check('全部做完', Object.values(after.children).every((c) => c.state.status === 'completed'),
      Object.values(after.children).map((c) => `${c.state.name}:${c.state.status}`).join(' '))
    check('没有另起一个日期目录把记录分成两份', after.sessions.length === 1)
    check('小甲仍记着是研发组派的', after.children['小甲']?.state.parent === '研发组', JSON.stringify(after.children['小甲']?.state))
    const warnings = logWarnings(env.dataDir)
    check('日志里没有相关警告', warnings.length === 0, warnings.slice(0, 3).join('\n'))
  } finally {
    await llm2.close()
    killStrays('sleep 65')
  }
})

// ───────────────────────────────────────────────────────────── 5
scenario('团里有验收人：先打回、改完再通过，结论带到组长手上', async () => {
  const names = ['研发组', '前端', '评审']
  const env = sandbox(0, 'sft-org-5', tempDirs)
  const seen = { verdicts: [], leadText: '', reviewerOpening: '' }
  const llm = await startMockLlm({
    onUser: (text, _n, entry) => {
      const who = whoAsks(entry, names)
      entry.who = who
      if (who === 'main') {
        if (text.includes('[专家') || text.includes('[伙计')) return say('秘书收到：组织做完了')
        return callTool('dispatch_agents', {
          tasks: [{ name: '研发组', role: '研发组长', lead: true, description: '带研发组做事', prompt: '我是研发组，组一个前端加评审的团' }],
        })
      }
      if (who === '研发组') {
        if (text.includes('我是研发组，')) {
          return callTool('dispatch_agents', {
            team: '项目团',
            tasks: [
              { name: '前端', role: '前端专家', description: '写登录页', prompt: '我是前端，写登录页' },
              { name: '评审', role: '评审专家', reviewer: true, description: '验收登录页', prompt: '我是评审，等前端交活后验收' },
            ],
          })
        }
        if (text.includes('验收')) seen.leadText = text
        return say('组长汇总：验收通过，做完了')
      }
      if (who === '前端') {
        if (text.includes('我是前端，')) return callTool('write_text_file', { path: path.join(env.cwd, 'login.txt'), content: 'v1', mode: 'create' })
        if (text.includes('少了错误处理')) return callTool('team_say', { to: ['评审'], message: '已补上错误处理，请再验' })
        return say('前端：好')
      }
      if (who === '评审') {
        if (text.includes('我是评审，')) { seen.reviewerOpening = text; return say('评审：等前端交活') }
        if (text.includes('请验收')) { seen.verdicts.push('reject'); return callTool('team_say', { to: ['前端'], message: '少了错误处理', verdict: 'reject' }) }
        if (text.includes('已补上')) { seen.verdicts.push('pass'); return callTool('team_say', { to: ['前端'], message: '这版可以', verdict: 'pass' }) }
        return say('评审：好')
      }
      return say('好')
    },
    afterTool: (last, entry) => {
      const who = whoAsks(entry, names)
      entry.who = who
      if (who === '前端') {
        const toolCount = entry.body.messages.filter((m) => m.role === 'tool').length
        if (toolCount === 1) return callTool('team_say', { to: ['评审'], message: '登录页做好了，请验收' })
        return say('前端：做完了')
      }
      if (who === '评审') return say('评审：已给结论')
      if (who === '研发组' || who === 'main') return say('已派出，等他们')
      return say('好')
    },
  })
  env.env.SFT_API_URL = `http://127.0.0.1:${llm.port}/v1`
  try {
    const result = await runPlain(['组织研发组做事', '--free'], env, 120_000)
    check('正常退出', result.code === 0, `exit ${result.code} ${result.err.slice(0, 300)}`)
    check('评审先打回、再通过', seen.verdicts.join() === 'reject,pass', seen.verdicts.join())
    check('评审的开场里写着他是验收人', seen.reviewerOpening.includes('验收人'), seen.reviewerOpening.slice(0, 300))
    check('团停下时交给组长的话里带着最近一次结论「通过」', seen.leadText.includes('验收') && seen.leadText.includes('通过'), seen.leadText.slice(-400))
    const chatRoot = path.join(env.dataDir, 'history', 'expert-teams')
    const chatText = fs.existsSync(chatRoot)
      ? fs.readdirSync(chatRoot, { recursive: true }).filter((f) => String(f).endsWith('.jsonl')).map((f) => fs.readFileSync(path.join(chatRoot, String(f)), 'utf8')).join('\n')
      : ''
    check('群聊记录里两次结论都在', chatText.includes('"verdict":"reject"') && chatText.includes('"verdict":"pass"'), chatText.slice(0, 400))
    const board = (() => {
      const hits = []
      const walk = (d) => { for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (e.name === 'board.md') hits.push(f) } }
      walk(path.join(env.dataDir, 'agent-workspace'))
      return hits[0] ? fs.readFileSync(hits[0], 'utf8') : ''
    })()
    check('看板上团的验收状态是「通过」', board.includes('项目团') && board.includes('通过'), board.slice(0, 500))
    const warnings = logWarnings(env.dataDir)
    check('日志里没有相关警告', warnings.length === 0, warnings.slice(0, 3).join('\n'))
  } finally { await llm.close() }
})

// ───────────────────────────────────────────────────────────── 6
scenario('Ctrl+C：整个组织一起停下，不留还在干的人和还在跑的命令', async () => {
  const names = ['研发组', '小甲', '小乙']
  const env = sandbox(0, 'sft-org-6', tempDirs)
  const seen = { jiaExec: false, yiDone: false }
  const llm = await startMockLlm({
    onUser: (text, _n, entry) => {
      const who = whoAsks(entry, names)
      entry.who = who
      if (who === 'main') {
        return callTool('dispatch_agents', {
          tasks: [{ name: '研发组', role: '研发组长', lead: true, description: '带研发组做事', prompt: '我是研发组，带小甲、小乙做事' }],
        })
      }
      if (who === '研发组') {
        return callTool('dispatch_agents', {
          tasks: [
            { name: '小甲', description: '跑一条很慢的命令', prompt: '我是小甲，跑一条很慢的命令' },
            { name: '小乙', description: '写一份文件', prompt: '我是小乙，写一份文件' },
          ],
        })
      }
      if (who === '小甲') return callTool('exec', { command: 'sleep 66' })
      if (who === '小乙') return callTool('write_text_file', { path: path.join(env.cwd, 'yi.txt'), content: 'b', mode: 'create' })
      return say('好')
    },
    afterTool: (last, entry) => {
      const who = whoAsks(entry, names)
      entry.who = who
      if (who === '小甲') { seen.jiaExec = true; return say('小甲：做完了') }
      if (who === '小乙') { seen.yiDone = true; return say('小乙：做完了') }
      return say('已派出，等他们')
    },
  })
  env.env.SFT_API_URL = `http://127.0.0.1:${llm.port}/v1`
  const term = new Terminal(['组织研发组做事', '--free'], env)
  try {
    check('小甲在跑慢命令、小乙做完了', await until(() => seen.jiaExec || seen.yiDone, 60_000) && await until(() => readOrg(env.dataDir).children['小乙']?.state.status === 'completed', 30_000),
      JSON.stringify(Object.values(readOrg(env.dataDir).children).map((c) => [c.state.name, c.state.status])))
    await sleep(1500)
    const mark = term.mark()
    term.interrupt()
    check('Ctrl+C：已停下', await term.waitFor('已停下。', { from: mark }), term.since(mark).slice(-400))
    let children = {}
    await until(() => {
      children = readOrg(env.dataDir).children
      return !Object.values(children).some((c) => c.state.status === 'running' || c.state.status === 'pending')
    }, 15_000)
    check('组长、小甲、小乙都记下了，没有一个还写着「在干」', ['研发组', '小甲', '小乙'].every((n) => children[n]) && !Object.values(children).some((c) => c.state.status === 'running'),
      JSON.stringify(Object.values(children).map((c) => [c.state.name, c.state.status])))
    check('小甲被中断，小乙做完的仍是做完', children['小甲']?.state.status === 'interrupted' && children['小乙']?.state.status === 'completed',
      JSON.stringify([children['小甲']?.state.status, children['小乙']?.state.status]))
    await sleep(500)
    let leftover = ''
    try { leftover = execSync("pgrep -f 'sleep 66' || true").toString().trim() } catch { /* 没有 */ }
    check('那条慢命令没有留在后台', leftover === '', leftover)
  } finally {
    await term.close()
    killStrays('sleep 66')
  }
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
