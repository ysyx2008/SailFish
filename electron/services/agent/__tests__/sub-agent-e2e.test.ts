/**
 * 功能完整子智能体端到端：真实 SailFish.run() + 真实写盘 + 脚本化模型。
 * 测的是整条链路，不是花名册桩。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { ConversationManager, ConversationStore } from '../../conversation'
import { foldProcessSteps } from '../../../../src/utils/process-fold'
import type { ToolDefinition } from '../../ai.service'
import type { AgentContext, AgentServices, AgentStep } from '../types'

let tmpDir: string
let fixtureFile: string
const victims: string[] = []

const FIXTURE = 'NGINX_LISTEN_8848'

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpDir,
    getName: () => 'SailFish',
    getVersion: () => '1.0.0',
    isPackaged: false
  },
  BrowserWindow: vi.fn(),
  ipcMain: { on: vi.fn(), handle: vi.fn() }
}))

vi.mock('../../im/im.service', () => ({
  getIMService: vi.fn().mockReturnValue(null)
}))

vi.mock('../../knowledge', () => ({
  getKnowledgeService: () => ({
    isEnabled: () => false,
    searchConversations: async () => [],
    buildContext: async () => '',
  })
}))

import { SailFish } from '../sailfish'
import { HistoryService } from '../../history.service'
import { AgentService } from '../index'
import { assessCommandRisk } from '../risk-assessor'

type LlmResponse = {
  content?: string
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
}

let llmCalls: Array<{ tools: string[]; messages: unknown[] }> = []
let reviewPrompts: string[] = []
/** 替我审批的脚本：看准了才放行，用来确认评审读的是主人这场里用户的话 */
let reviewSeesUserWords: ((text: string) => boolean) | null = null

function toolNames(tools: ToolDefinition[]): string[] {
  return tools.map(t => t.function.name)
}

function isChildCall(tools: ToolDefinition[]): boolean {
  return !toolNames(tools).includes('dispatch_agents')
}

function lastUserText(messages: Array<{ role?: string; content?: string }>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return String(messages[i].content || '')
  }
  return ''
}

function allMessageText(messages: Array<{ role?: string; content?: unknown }>): string {
  return messages.map(m => String(m.content ?? '')).join('\n')
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function makeServices(responder: (args: {
  isChild: boolean
  callIndex: number
  childIndex: number
  parentIndex: number
  messages: Array<{ role?: string; content?: unknown; tool_calls?: unknown }>
  tools: ToolDefinition[]
}) => LlmResponse | Promise<LlmResponse>): AgentServices {
  let callIndex = 0
  let childIndex = 0
  let parentIndex = 0
  const inflight = new Set<() => void>()
  return {
    aiService: {
      chat: vi.fn().mockResolvedValue(''),
      chatWithTools: vi.fn(async (messages: Array<{ content?: unknown }>) => {
        const text = messages.map(m => String(m.content ?? '')).join('\n')
        reviewPrompts.push(text)
        const allow = reviewSeesUserWords?.(text) === true
        const content = allow
          ? '{"risk_level":"high","user_authorization":"high","outcome":"allow","rationale":"用户在这场里明确交代了删这份草稿"}'
          : '{"risk_level":"high","user_authorization":"unknown","outcome":"ask_user","rationale":"看不出用户授权"}'
        return { content, tool_calls: [] }
      }),
      chatWithToolsStream: vi.fn(async (
        messages: Array<{ role?: string; content?: unknown; tool_calls?: unknown }>,
        tools: ToolDefinition[],
        onChunk: (s: string) => void,
        _onToolCall: unknown,
        onDone: (r: unknown) => void,
        onError?: (e: string) => void
      ) => {
        const child = isChildCall(tools)
        const idx = child ? childIndex++ : parentIndex++
        llmCalls.push({ tools: toolNames(tools), messages: JSON.parse(JSON.stringify(messages)) })
        let cancelled = false
        const cancel = () => { cancelled = true }
        inflight.add(cancel)
        try {
          const r = await responder({
            isChild: child,
            callIndex: callIndex++,
            childIndex: idx,
            parentIndex: idx,
            messages,
            tools,
          })
          if (cancelled) {
            onError?.('aborted')
            return
          }
          const content = r.content ?? ''
          if (content) onChunk(content)
          onDone({ content, tool_calls: r.tool_calls })
        } finally {
          inflight.delete(cancel)
        }
      }),
      abort: vi.fn(() => {
        for (const cancel of inflight) cancel()
        inflight.clear()
      })
    } as any,
    ptyService: { onData: vi.fn().mockReturnValue(() => {}), write: vi.fn() } as any,
    configService: {
      get: vi.fn().mockReturnValue(undefined),
      getAgentMbti: vi.fn().mockReturnValue(null),
      getAiRules: vi.fn().mockReturnValue(''),
      getAgentPersonalityText: vi.fn().mockReturnValue(''),
      getAgentName: vi.fn().mockReturnValue(''),
      getLanguage: vi.fn().mockReturnValue('zh-CN'),
      getAiProfiles: vi.fn().mockReturnValue([{ id: 'test', contextLength: 128000 }]),
      getActiveAiProfile: vi.fn().mockReturnValue('test'),
      getAgentOnboardingCompleted: vi.fn().mockReturnValue(true),
      hasVisionCapability: vi.fn().mockReturnValue(true),
      getCommandRiskPolicy: vi.fn().mockReturnValue(undefined),
      isAutoApprovalReviewEnabled: vi.fn().mockReturnValue(false)
    } as any,
    hostProfileService: {
      generateHostContext: vi.fn().mockReturnValue(''),
      addNote: vi.fn(),
      getProfile: vi.fn().mockReturnValue(null)
    } as any,
    historyService: undefined,
    conversationManager: undefined
  }
}

function attachHistory(services: AgentServices, history: HistoryService): void {
  services.historyService = history as any
  services.conversationManager = new ConversationManager(new ConversationStore(history.getAgentRecordStore()))
}

function ctx(): AgentContext {
  return {
    terminalOutput: [],
    systemInfo: { os: 'darwin', shell: '/bin/zsh' },
    terminalType: 'assistant',
    cwd: tmpDir,
  }
}

/** 家目录里的一份草稿：删它算高风险，但真删了也只删这份测试文件 */
function makeVictim(label: string): string {
  const file = path.join(os.homedir(), `.sailfish-e2e-${label}-${process.pid}-${Date.now()}`)
  fs.writeFileSync(file, 'draft\n', 'utf-8')
  victims.push(file)
  return file
}

function tc(name: string, args: Record<string, unknown>, id = `tc-${name}`): NonNullable<LlmResponse['tool_calls']>[0] {
  return {
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) }
  }
}

describe('子智能体端到端（真实 SailFish.run）', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-subagent-e2e-'))
    fixtureFile = path.join(tmpDir, 'nginx.conf')
    fs.writeFileSync(fixtureFile, `listen ${FIXTURE};\n`, 'utf-8')
    llmCalls = []
    reviewPrompts = []
    reviewSeesUserWords = null
    for (const file of victims.splice(0)) fs.rmSync(file, { force: true })
  })
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    for (const file of victims.splice(0)) fs.rmSync(file, { force: true })
  })

  it('派出后主人先收不了工；伙计读真文件敲门；不进最近对话', async () => {
    const history = new HistoryService()
    const services = makeServices(({ isChild, parentIndex, childIndex, messages }) => {
      if (isChild) {
        if (childIndex === 0) {
          return { content: '', tool_calls: [tc('read_file', { path: fixtureFile })] }
        }
        return { content: `配置里写着 ${FIXTURE}` }
      }
      const text = lastUserText(messages as Array<{ role?: string; content?: string }>)
      if (parentIndex === 0) {
        return {
          content: '我派人去读',
          tool_calls: [tc('dispatch_agents', {
            tasks: [{ name: 'alice', description: '读 nginx 配置', prompt: `去读 ${fixtureFile}，回报监听端口` }]
          })]
        }
      }
      if (text.includes(FIXTURE) || text.includes('alice')) {
        return { content: `主人汇总：伙计读到了 ${FIXTURE}` }
      }
      return { content: '先等他们' }
    })
    attachHistory(services, history)

    const agentService = new AgentService(services.aiService as any, services.ptyService as any, services.hostProfileService as any, undefined, services.configService as any)
    agentService.setHistoryService(history)
    const parent = agentService.createAssistantAgent('e2e-parent')
    ;(parent as any).services = services
    parent.updateConfig({ executionMode: 'free' })

    const steps: AgentStep[] = []
    const result = await parent.run('查 nginx 监听端口', ctx(), {
      callbacks: { onStep: (_id, step) => { steps.push({ ...step, subAgents: step.subAgents }) } }
    })

    expect(result).toContain(FIXTURE)

    const childCalls = llmCalls.filter(c => !c.tools.includes('dispatch_agents'))
    expect(childCalls.length).toBeGreaterThanOrEqual(1)
    const opening = childCalls[0].messages as Array<{ role?: string; tool_calls?: unknown; content?: string }>
    expect(opening.some(m => m.tool_calls)).toBe(false)
    expect(opening.some(m => m.role === 'user' && String(m.content).includes('查 nginx'))).toBe(true)
    expect(childCalls[0].tools).toContain('read_file')
    expect(childCalls[0].tools).toContain('exec')
    expect(childCalls[0].tools).not.toContain('ask_user')
    expect(childCalls[0].tools).not.toContain('dispatch_agents')
    expect(childCalls[0].tools).not.toContain('talk_to_user')

    const records = history.getAgentRecords()
    expect(records.some(r => r.agentKey === 'e2e-parent')).toBe(true)
    expect(records.some(r => (r.agentKey || '').includes(':sub:') || (r.agentKey || '').includes('alice'))).toBe(false)
    expect(agentService.getAgent('e2e-parent')).toBeTruthy()
    const liveKeys = [...((agentService as any).agents as Map<string, unknown>).keys()]
    expect(liveKeys.filter(k => k.includes('sub'))).toEqual([])

    const alice = steps.flatMap(s => s.subAgents || []).filter(a => a.name === 'alice')
    expect(alice.length).toBeGreaterThan(0)
    expect(alice.some(a => a.status === 'pending' || a.status === 'running' || a.status === 'completed')).toBe(true)

    const folded = foldProcessSteps(steps, { enabled: true })
    expect(folded.length).toBeGreaterThan(0)
    expect(alice[0].name).toBe('alice')
  })

  it('伙计调仅主人能用的工具会被拦，再如实汇报', async () => {
    const history = new HistoryService()
    const services = makeServices(({ isChild, childIndex, parentIndex, messages }) => {
      if (isChild) {
        if (childIndex === 0) {
          return { content: '', tool_calls: [tc('ask_user', { question: '端口是多少？' })] }
        }
        return { content: '提问被拦了，交给主人' }
      }
      if (parentIndex === 0) {
        return {
          tool_calls: [tc('dispatch_agents', {
            tasks: [{ name: 'bob', description: '乱提问', prompt: '去问用户端口' }]
          })]
        }
      }
      const text = lastUserText(messages as Array<{ role?: string; content?: string }>)
      if (text.includes('bob') || text.includes('拦') || text.includes('主人')) {
        return { content: '好，伙计问不了用户，我自己来' }
      }
      return { content: '先等他们' }
    })
    attachHistory(services, history)
    const parent = new SailFish(services)
    parent.setAgentId('e2e-deny')
    parent.updateConfig({ executionMode: 'free' })

    const result = await parent.run('让伙计去问用户', ctx())
    const toolOutputs = llmCalls
      .flatMap(c => c.messages as Array<{ role?: string; content?: string }>)
      .map(m => String(m.content || ''))
      .join('\n')
    expect(toolOutputs.includes('仅主人') || toolOutputs.includes('提问被拦') || result.includes('问不了')).toBe(true)
    const childToolLists = llmCalls.filter(c => !c.tools.includes('dispatch_agents'))
    expect(childToolLists.length).toBeGreaterThan(0)
    expect(childToolLists.every(c => !c.tools.includes('ask_user'))).toBe(true)
  })

  it('做完后再交代，同一条线继续，主人接到第二轮结果', async () => {
    const history = new HistoryService()
    let childTurns = 0
    const services = makeServices(({ isChild, parentIndex, messages }) => {
      if (isChild) {
        childTurns++
        return { content: childTurns === 1 ? '第一轮：只看到目录' : '第二轮：端口是 8848' }
      }
      const text = lastUserText(messages as Array<{ role?: string; content?: string }>)
      if (parentIndex === 0) {
        return {
          tool_calls: [tc('dispatch_agents', {
            tasks: [{ name: 'carol', description: '读配置', prompt: '先看目录' }]
          })]
        }
      }
      if (text.includes('第一轮') && !text.includes('8848')) {
        return { tool_calls: [tc('followup_agent', { name: 'carol', message: '再看一眼端口' })] }
      }
      if (text.includes('8848')) {
        return { content: '主人汇总：8848' }
      }
      return { content: '先等他们' }
    })
    attachHistory(services, history)
    const parent = new SailFish(services)
    parent.setAgentId('e2e-followup')
    parent.updateConfig({ executionMode: 'free' })

    const result = await parent.run('先派再交代', ctx())
    expect(result).toContain('8848')
    expect(childTurns).toBeGreaterThanOrEqual(2)
  })

  it('打断进行中的伙计，主人仍接到敲门', async () => {
    const history = new HistoryService()
    const services = makeServices(async ({ isChild, parentIndex, messages }) => {
      if (isChild) {
        await new Promise(r => setTimeout(r, 400))
        return { content: '不该看到的完成汇报' }
      }
      const text = lastUserText(messages as Array<{ role?: string; content?: string }>)
      if (parentIndex === 0) {
        return {
          tool_calls: [tc('dispatch_agents', {
            tasks: [{ name: 'erin', description: '慢任务', prompt: '慢慢做' }]
          })]
        }
      }
      if (text.includes('打断') || text.includes('interrupted') || text.includes('已打断')) {
        return { content: '好，已停' }
      }
      if (parentIndex === 1) {
        return { tool_calls: [tc('interrupt_agent', { name: 'erin' })] }
      }
      return { content: '先等' }
    })
    attachHistory(services, history)
    const parent = new SailFish(services)
    parent.setAgentId('e2e-interrupt')
    parent.updateConfig({ executionMode: 'free' })

    const result = await parent.run('派出后叫停', ctx())
    expect(result).toMatch(/已停|打断/)
    expect(result).not.toContain('不该看到的完成汇报')
  })

  it('用户停止会级联打断还在跑的伙计', async () => {
    const history = new HistoryService()
    const steps: AgentStep[] = []
    const services = makeServices(async ({ isChild, parentIndex }) => {
      if (isChild) {
        await new Promise(r => setTimeout(r, 400))
        return { content: '不该看到' }
      }
      if (parentIndex === 0) {
        return {
          tool_calls: [tc('dispatch_agents', {
            tasks: [{ name: 'dave', description: '长任务', prompt: '一直做' }]
          })]
        }
      }
      return { content: '先等他们' }
    })
    attachHistory(services, history)
    const parent = new SailFish(services)
    parent.setAgentId('e2e-abort')
    parent.updateConfig({ executionMode: 'free' })

    const runP = parent.run('派出后我点停止', ctx(), {
      callbacks: { onStep: (_id, step) => { steps.push(step) } }
    })
    await vi.waitFor(() => {
      expect(steps.some(s => s.toolName === 'dispatch_agents' && s.success === true)).toBe(true)
    }, { timeout: 3000 })
    parent.abort()
    await runP.catch(() => {})
    expect(parent.isRunning()).toBe(false)
    const records = history.getAgentRecords()
    expect(records.some(r => (r.agentKey || '').includes(':sub:'))).toBe(false)
  }, 10000)

  it('两人并行、主人真调等齐、再交代；第一次敲门只有各自的活', async () => {
    const pkgPath = path.join(tmpDir, 'package.json')
    const readmePath = path.join(tmpDir, 'README.md')
    fs.writeFileSync(pkgPath, JSON.stringify({
      name: 'SailFish',
      version: '11.7.0',
      scripts: { test: 'vitest', 'test:ui': 'vitest --ui', dev: 'vite' },
    }, null, 2))
    fs.writeFileSync(readmePath, 'SailFish is a personal desktop secretary.\nIt runs on your computer.\n')

    const PKG_MARK = 'FIRST_KNOCK_PKG:SailFish@11.7.0'
    const README_MARK = 'FIRST_KNOCK_README:desktop-secretary'
    const TEST_MARK = 'SECOND_KNOCK_PKG:test,test:ui'
    const userTask = [
      '先派出两个伙计并行干，你自己不要读这些文件。',
      `一个叫「读包」，去读 ${pkgPath}，只回报 name 和 version。`,
      `一个叫「读说明」，去读 ${readmePath} 开头，用三句话概括。`,
      '派出后等他们敲门。都回来后用一段话汇总。',
      '汇总完再向「读包」交代：把 scripts 里和 test 相关的脚本名列出来。',
    ].join('\n')

    const childTurns = new Map<string, number>()
    const bump = (key: string) => {
      const n = (childTurns.get(key) ?? 0) + 1
      childTurns.set(key, n)
      return n
    }
    let waited = false
    let followed = false
    const parentTools: string[] = []
    const steps: AgentStep[] = []

    const services = makeServices(async ({ isChild, parentIndex, messages }) => {
      if (isChild) {
        const text = lastUserText(messages as Array<{ role?: string; content?: string }>)
        const key = text.includes('scripts') && text.includes('test')
          ? 'pkg-follow'
          : text.includes(readmePath) || text.includes('三句话')
            ? 'readme'
            : 'pkg'
        const n = bump(key)
        if (key === 'pkg') {
          await sleep(20)
          if (n === 1) return { tool_calls: [tc('read_file', { path: pkgPath })] }
          return { content: PKG_MARK }
        }
        if (key === 'readme') {
          await sleep(90)
          if (n === 1) return { tool_calls: [tc('read_file', { path: readmePath })] }
          return { content: README_MARK }
        }
        return { content: TEST_MARK }
      }

      if (parentIndex === 0) {
        parentTools.push('dispatch_agents')
        return {
          content: '已派出读包和读说明',
          tool_calls: [tc('dispatch_agents', {
            tasks: [
              { name: '读包', description: '读 package.json', prompt: `去读 ${pkgPath}，只回报 name 和 version` },
              { name: '读说明', description: '读 README', prompt: `去读 ${readmePath} 开头，用三句话概括` },
            ]
          })]
        }
      }
      if (!waited) {
        waited = true
        parentTools.push('wait_agents')
        return { tool_calls: [tc('wait_agents', {})] }
      }
      const text = lastUserText(messages as Array<{ role?: string; content?: string }>)
      const seen = allMessageText(messages as Array<{ role?: string; content?: unknown }>)
      if (!followed && (seen.includes(PKG_MARK) || seen.includes(README_MARK) || text.includes('读包'))) {
        followed = true
        parentTools.push('followup_agent')
        return {
          content: '两人齐了，再向读包交代 test 脚本',
          tool_calls: [tc('followup_agent', {
            name: '读包',
            message: `再读一遍 ${pkgPath} 的 scripts，把和 test 相关的脚本名列出来`,
          })]
        }
      }
      if (seen.includes(TEST_MARK) || text.includes(TEST_MARK)) {
        return { content: `主人汇总第二次：${TEST_MARK}` }
      }
      return { content: '先等他们' }
    })

    attachHistory(services, new HistoryService())
    const parent = new SailFish(services)
    parent.setAgentId('e2e-two-wait-followup')
    parent.updateConfig({ executionMode: 'free' })

    const result = await parent.run(userTask, ctx(), {
      callbacks: { onStep: (_id, step) => { steps.push({ ...step }) } }
    })

    expect(parentTools).toEqual(['dispatch_agents', 'wait_agents', 'followup_agent'])

    const waitStep = steps.find(s => s.toolName === 'wait_agents' && s.success === true)
    expect(waitStep?.toolResult).toMatch(/有新消息|还在做|已完成|There is an update|still working|done/)
    expect(waitStep?.toolResult).not.toContain(PKG_MARK)
    expect(waitStep?.toolResult).not.toContain(README_MARK)
    expect(waitStep?.toolResult).not.toContain(TEST_MARK)

    expect(result).toContain(TEST_MARK)
    expect(childTurns.get('pkg-follow')).toBeGreaterThanOrEqual(1)

    const childCalls = llmCalls.filter(c => !c.tools.includes('dispatch_agents'))
    const pkgOpening = childCalls.find(c =>
      lastUserText(c.messages as Array<{ role?: string; content?: string }>).includes('只回报 name 和 version')
    )
    expect(pkgOpening).toBeTruthy()
    const openingText = allMessageText(pkgOpening!.messages as Array<{ role?: string; content?: unknown }>)
    expect(openingText).toContain('只回报 name 和 version')
    expect(openingText).toContain('test 相关的脚本名')
  }, 15000)

  it('不带对话派出时，伙计开局看不见用户整段吩咐', async () => {
    const history = new HistoryService()
    const userTask = '先派读包只报 name。回来后再向读包交代：列出 test 脚本。'
    const services = makeServices(({ isChild, parentIndex, messages }) => {
      if (isChild) {
        return { content: 'NAME_ONLY' }
      }
      if (parentIndex === 0) {
        return {
          tool_calls: [tc('dispatch_agents', {
            tasks: [{
              name: '读包',
              description: '读包',
              prompt: '只回报 name 和 version',
              fork_turns: 'none',
            }]
          })]
        }
      }
      const text = lastUserText(messages as Array<{ role?: string; content?: string }>)
      if (text.includes('NAME_ONLY') || text.includes('读包')) {
        return { content: `收到 ${text.includes('NAME_ONLY') ? 'NAME_ONLY' : '敲门'}` }
      }
      return { content: '先等他们' }
    })
    attachHistory(services, history)
    const parent = new SailFish(services)
    parent.setAgentId('e2e-no-convo')
    parent.updateConfig({ executionMode: 'free' })

    const result = await parent.run(userTask, ctx())
    expect(result).toMatch(/NAME_ONLY|敲门/)

    const childCalls = llmCalls.filter(c => !c.tools.includes('dispatch_agents'))
    expect(childCalls.length).toBeGreaterThanOrEqual(1)
    const opening = allMessageText(childCalls[0].messages as Array<{ role?: string; content?: unknown }>)
    expect(opening).toContain('只回报 name 和 version')
    expect(opening).not.toContain('列出 test 脚本')
  })

  it('最近 1 轮派出时，伙计开局看不见更早那轮', async () => {
    const history = new HistoryService()
    let dispatched = false
    const services = makeServices(({ isChild, messages }) => {
      if (isChild) return { content: 'NAME_ONLY' }
      const text = lastUserText(messages as Array<{ role?: string; content?: string }>)
      if (text.includes('第一轮')) return { content: '好，先记下' }
      if (!dispatched && text.includes('第二轮')) {
        dispatched = true
        return {
          tool_calls: [tc('dispatch_agents', {
            tasks: [{
              name: '读包',
              description: '读包',
              prompt: '只回报 name',
              fork_turns: '1',
            }]
          })]
        }
      }
      if (text.includes('NAME_ONLY') || text.includes('读包')) {
        return { content: '收到 NAME_ONLY' }
      }
      return { content: '先等他们' }
    })
    attachHistory(services, history)
    const parent = new SailFish(services)
    parent.setAgentId('e2e-fork-last1')
    parent.updateConfig({ executionMode: 'free' })

    await parent.run('第一轮：先读包，不要派人', ctx())
    llmCalls = []
    const result = await parent.run('第二轮：只报 name。后面还要列 test 脚本。', ctx())
    expect(result).toContain('NAME_ONLY')

    const childCalls = llmCalls.filter(c => !c.tools.includes('dispatch_agents'))
    expect(childCalls.length).toBeGreaterThanOrEqual(1)
    const opening = allMessageText(childCalls[0].messages as Array<{ role?: string; content?: unknown }>)
    expect(opening).toContain('第二轮：只报 name')
    expect(opening).not.toContain('第一轮：先读包')
  })

  it('不带对话的两人并行：第一次敲门看不见后续安排', async () => {
    const pkgPath = path.join(tmpDir, 'package.json')
    const readmePath = path.join(tmpDir, 'README.md')
    fs.writeFileSync(pkgPath, JSON.stringify({ name: 'SailFish', version: '11.7.0' }), 'utf-8')
    fs.writeFileSync(readmePath, 'SailFish is a personal desktop secretary.\n')
    const PKG_MARK = 'NONE_PKG:SailFish'
    const README_MARK = 'NONE_README:secretary'
    const userTask = [
      `一个叫「读包」，去读 ${pkgPath}，只回报 name。`,
      `一个叫「读说明」，去读 ${readmePath}。`,
      '都回来后再向读包交代：列出 test 脚本。',
    ].join('\n')

    const services = makeServices(({ isChild, parentIndex, messages }) => {
      if (isChild) {
        const text = lastUserText(messages as Array<{ role?: string; content?: string }>)
        if (text.includes(pkgPath) || text.includes('只回报 name')) return { content: PKG_MARK }
        return { content: README_MARK }
      }
      if (parentIndex === 0) {
        return {
          tool_calls: [tc('dispatch_agents', {
            tasks: [
              { name: '读包', description: '读包', prompt: `去读 ${pkgPath}，只回报 name`, fork_turns: 'none' },
              { name: '读说明', description: '读说明', prompt: `去读 ${readmePath}`, fork_turns: 'none' },
            ]
          })]
        }
      }
      const text = lastUserText(messages as Array<{ role?: string; content?: string }>)
      if (text.includes(PKG_MARK) || text.includes(README_MARK) || text.includes('读包')) {
        return { content: `主人收到 ${PKG_MARK} ${README_MARK}` }
      }
      return { content: '先等他们' }
    })
    attachHistory(services, new HistoryService())
    const parent = new SailFish(services)
    parent.setAgentId('e2e-two-none')
    parent.updateConfig({ executionMode: 'free' })

    const result = await parent.run(userTask, ctx())
    expect(result).toContain(PKG_MARK)

    const childCalls = llmCalls.filter(c => !c.tools.includes('dispatch_agents'))
    const pkgOpening = childCalls.find(c =>
      lastUserText(c.messages as Array<{ role?: string; content?: string }>).includes('只回报 name')
    )
    expect(pkgOpening).toBeTruthy()
    const openingText = allMessageText(pkgOpening!.messages as Array<{ role?: string; content?: unknown }>)
    expect(openingText).toContain('只回报 name')
    expect(openingText).not.toContain('列出 test 脚本')
  })

  it('两次 wait_agents 分别接到两条敲门，第二次不会因为第一个人已做完立刻返回', async () => {
    const FAST = 'WAIT_FAST:ok'
    const SLOW = 'WAIT_SLOW:ok'
    const parentTools: string[] = []
    const waitResults: string[] = []
    const steps: AgentStep[] = []

    const services = makeServices(async ({ isChild, parentIndex, messages }) => {
      if (isChild) {
        const text = lastUserText(messages as Array<{ role?: string; content?: string }>)
        if (text.includes('快的先做完')) {
          await sleep(20)
          return { content: FAST }
        }
        await sleep(120)
        return { content: SLOW }
      }
      if (parentIndex === 0) {
        parentTools.push('dispatch_agents')
        return {
          tool_calls: [tc('dispatch_agents', {
            tasks: [
              { name: '快的', description: '快的', prompt: '快的先做完', fork_turns: 'none' },
              { name: '慢的', description: '慢的', prompt: '慢的后做完', fork_turns: 'none' },
            ]
          })]
        }
      }
      if (parentTools.filter(n => n === 'wait_agents').length < 2) {
        parentTools.push('wait_agents')
        return { tool_calls: [tc('wait_agents', { timeout: 5 })] }
      }
      const seen = allMessageText(messages as Array<{ role?: string; content?: unknown }>)
      if (seen.includes(FAST) && seen.includes(SLOW)) {
        return { content: `两人齐了 ${FAST} ${SLOW}` }
      }
      return { content: '先等他们' }
    })
    attachHistory(services, new HistoryService())
    const parent = new SailFish(services)
    parent.setAgentId('e2e-wait-twice')
    parent.updateConfig({ executionMode: 'free' })

    const result = await parent.run('派出两个，分别等两次敲门', ctx(), {
      callbacks: {
        onStep: (_id, step) => {
          steps.push({ ...step })
          if (step.toolName === 'wait_agents' && step.success === true && step.toolResult) {
            waitResults.push(step.toolResult)
          }
        }
      }
    })

    expect(parentTools.filter(n => n === 'wait_agents').length).toBe(2)
    expect(waitResults.length).toBeGreaterThanOrEqual(2)
    expect(waitResults[0]).not.toContain(FAST)
    expect(waitResults[0]).not.toContain(SLOW)
    expect(waitResults[1]).not.toContain(FAST)
    expect(waitResults[1]).not.toContain(SLOW)
    expect(result).toContain(FAST)
    expect(result).toContain(SLOW)
  }, 15000)

  it('伙计能写真实文件，主人从敲门接到内容', async () => {
    const outPath = path.join(tmpDir, 'note.txt')
    const MARK = 'WRITE_E2E_NOTE_8848'
    const services = makeServices(({ isChild, childIndex, parentIndex, messages }) => {
      if (isChild) {
        if (childIndex === 0) {
          return { tool_calls: [tc('write_text_file', { path: outPath, mode: 'create', content: MARK })] }
        }
        return { content: `已写入 ${MARK}` }
      }
      if (parentIndex === 0) {
        return {
          tool_calls: [tc('dispatch_agents', {
            tasks: [{ name: '书记', description: '写笔记', prompt: `把 ${MARK} 写到 ${outPath}`, fork_turns: 'none' }]
          })]
        }
      }
      const text = lastUserText(messages as Array<{ role?: string; content?: string }>)
      if (text.includes(MARK) || text.includes('书记')) return { content: `主人看到 ${MARK}` }
      return { content: '先等他们' }
    })
    attachHistory(services, new HistoryService())
    const parent = new SailFish(services)
    parent.setAgentId('e2e-write')
    parent.updateConfig({ executionMode: 'free' })

    const result = await parent.run('让伙计写笔记', ctx())
    expect(result).toContain(MARK)
    expect(fs.readFileSync(outPath, 'utf-8')).toContain(MARK)
  })

  it('伙计跑硬拦命令也会带上原命令', async () => {
    const BLOCKED = 'rm -rf /'
    const services = makeServices(({ isChild, childIndex, parentIndex, messages }) => {
      if (isChild) {
        if (childIndex === 0) return { tool_calls: [tc('exec', { command: BLOCKED })] }
        return { content: '硬拦，交给主人' }
      }
      if (parentIndex === 0) {
        return {
          tool_calls: [tc('dispatch_agents', {
            tasks: [{ name: '莽汉', description: '乱删根', prompt: `去执行 ${BLOCKED}`, fork_turns: 'none' }]
          })]
        }
      }
      const text = lastUserText(messages as Array<{ role?: string; content?: string }>)
      if (text.includes('莽汉') || text.includes('拦') || text.includes(BLOCKED)) {
        return { content: `主人知道被拦了：${BLOCKED}` }
      }
      return { content: '先等他们' }
    })
    attachHistory(services, new HistoryService())
    const parent = new SailFish(services)
    parent.setAgentId('e2e-blocked')
    parent.updateConfig({ executionMode: 'free' })

    const result = await parent.run('让伙计去删根目录', ctx())
    const toolOutputs = llmCalls
      .flatMap(c => c.messages as Array<{ role?: string; content?: string }>)
      .map(m => String(m.content || ''))
      .join('\n')
    expect(toolOutputs).toContain(`原命令：${BLOCKED}`)
    expect(result).toContain(BLOCKED)
  })

  it('宽松模式：伙计删家目录草稿要问这场，点头后文件真的没了', async () => {
    const victim = makeVictim('ask')
    const command = `rm -f "${victim}"`
    expect(await assessCommandRisk(command)).toBe('dangerous')

    const asked: Array<{ toolName?: string; reasons?: string[]; toolArgs?: Record<string, unknown> }> = []
    const services = makeServices(({ isChild, messages }) => {
      if (isChild) {
        const done = (messages as Array<{ role?: string }>).some(m => m.role === 'tool')
        if (!done) return { tool_calls: [tc('exec', { command }, 'rm-ask')] }
        return { content: '草稿删掉了' }
      }
      const text = allMessageText(messages as Array<{ content?: unknown }>)
      const alreadyDispatched = (messages as Array<{ tool_calls?: unknown }>).some(m => m.tool_calls)
      if (!alreadyDispatched && !text.includes('草稿删掉了')) {
        return {
          tool_calls: [tc('dispatch_agents', {
            tasks: [{ name: '甲', description: '删草稿', prompt: '把那份草稿删掉', fork_turns: 'none' }]
          })]
        }
      }
      if (text.includes('草稿删掉了')) return { content: '主人知道草稿已经删了' }
      return { content: '先等他们' }
    })
    attachHistory(services, new HistoryService())
    const parent = new SailFish(services)
    parent.setAgentId('e2e-ask')
    parent.updateConfig({ executionMode: 'relaxed' })

    const result = await parent.run('删掉桌上这份草稿', ctx(), {
      callbacks: {
        onNeedConfirm: (c) => {
          asked.push({ toolName: c.toolName, reasons: c.reasons, toolArgs: c.toolArgs })
          c.resolve(true)
        },
      },
    })

    expect(asked).toHaveLength(1)
    expect(asked[0].toolName).toBe('exec')
    expect(asked[0].reasons?.join('\n')).toContain('甲')
    expect(JSON.stringify(asked[0].toolArgs)).toContain(victim)
    expect(fs.existsSync(victim)).toBe(false)
    expect(result).toContain('草稿已经删了')
  })

  it('宽松模式：这场拒绝后，草稿还在', async () => {
    const victim = makeVictim('reject')
    const command = `rm -f "${victim}"`
    const services = makeServices(({ isChild, messages }) => {
      if (isChild) {
        const done = (messages as Array<{ role?: string }>).some(m => m.role === 'tool')
        if (!done) return { tool_calls: [tc('exec', { command }, 'rm-no')] }
        return { content: '没删成' }
      }
      const text = allMessageText(messages as Array<{ content?: unknown }>)
      if (!text.includes('没删成') && !(messages as Array<{ tool_calls?: unknown }>).some(m => m.tool_calls)) {
        return {
          tool_calls: [tc('dispatch_agents', {
            tasks: [{ name: '甲', description: '删草稿', prompt: '把那份草稿删掉', fork_turns: 'none' }]
          })]
        }
      }
      if (text.includes('没删成')) return { content: '主人知道没删' }
      return { content: '先等他们' }
    })
    attachHistory(services, new HistoryService())
    const parent = new SailFish(services)
    parent.setAgentId('e2e-reject')
    parent.updateConfig({ executionMode: 'relaxed' })

    const result = await parent.run('先别删', ctx(), {
      callbacks: { onNeedConfirm: (c) => c.resolve(false) },
    })

    expect(fs.existsSync(victim)).toBe(true)
    expect(result).toContain('没删')
  })

  it('自由模式：同一条高风险删除不再问，文件直接没了', async () => {
    const victim = makeVictim('free')
    const command = `rm -f "${victim}"`
    let asked = false
    const services = makeServices(({ isChild, messages }) => {
      if (isChild) {
        const done = (messages as Array<{ role?: string }>).some(m => m.role === 'tool')
        if (!done) return { tool_calls: [tc('exec', { command }, 'rm-free')] }
        return { content: '自由模式删掉了' }
      }
      const text = allMessageText(messages as Array<{ content?: unknown }>)
      if (!text.includes('自由模式删掉了') && !(messages as Array<{ tool_calls?: unknown }>).some(m => m.tool_calls)) {
        return {
          tool_calls: [tc('dispatch_agents', {
            tasks: [{ name: '甲', description: '删草稿', prompt: '把那份草稿删掉', fork_turns: 'none' }]
          })]
        }
      }
      if (text.includes('自由模式删掉了')) return { content: '主人知道自由模式删了' }
      return { content: '先等他们' }
    })
    attachHistory(services, new HistoryService())
    const parent = new SailFish(services)
    parent.setAgentId('e2e-free')
    parent.updateConfig({ executionMode: 'free' })

    const result = await parent.run('删掉这份草稿', ctx(), {
      callbacks: { onNeedConfirm: () => { asked = true } },
    })

    expect(asked).toBe(false)
    expect(fs.existsSync(victim)).toBe(false)
    expect(result).toContain('自由模式删了')
  })

  it('开了替我审批：用这场里你的话看准了就自己删，不问你', async () => {
    const victim = makeVictim('review')
    const command = `rm -f "${victim}"`
    const userTask = '删掉桌上这份叫草稿的文件'
    reviewSeesUserWords = (text) => text.includes(userTask)
    let asked = false
    const services = makeServices(({ isChild, messages }) => {
      if (isChild) {
        const done = (messages as Array<{ role?: string }>).some(m => m.role === 'tool')
        if (!done) return { tool_calls: [tc('exec', { command }, 'rm-review')] }
        return { content: '评审放行后删掉了' }
      }
      const text = allMessageText(messages as Array<{ content?: unknown }>)
      if (!text.includes('评审放行后删掉了') && !(messages as Array<{ tool_calls?: unknown }>).some(m => m.tool_calls)) {
        return {
          tool_calls: [tc('dispatch_agents', {
            tasks: [{ name: '甲', description: '删草稿', prompt: '把那个文件删掉', fork_turns: 'none' }]
          })]
        }
      }
      if (text.includes('评审放行后删掉了')) return { content: '主人知道评审放行了' }
      return { content: '先等他们' }
    })
    ;(services.configService as unknown as { isAutoApprovalReviewEnabled: ReturnType<typeof vi.fn> })
      .isAutoApprovalReviewEnabled.mockReturnValue(true)
    attachHistory(services, new HistoryService())
    const parent = new SailFish(services)
    parent.setAgentId('e2e-review')
    parent.updateConfig({ executionMode: 'relaxed' })

    const result = await parent.run(userTask, ctx(), {
      callbacks: { onNeedConfirm: () => { asked = true } },
    })

    expect(reviewPrompts.some(p => p.includes(userTask))).toBe(true)
    expect(reviewPrompts.some(p => p.includes('把那个文件删掉') && !p.includes(userTask))).toBe(false)
    expect(asked).toBe(false)
    expect(fs.existsSync(victim)).toBe(false)
    expect(result).toContain('评审放行了')
  })

  function makeCompanionDeleteServices(command: string, doneText: string): AgentServices {
    const services = makeServices(({ isChild, messages }) => {
      if (isChild) return { content: '不该派人' }
      const done = (messages as Array<{ role?: string }>).some(m => m.role === 'tool')
      if (!done) return { tool_calls: [tc('exec', { command }, 'rm-companion')] }
      return { content: doneText }
    })
    ;(services.configService as unknown as { isAutoApprovalReviewEnabled: ReturnType<typeof vi.fn> })
      .isAutoApprovalReviewEnabled.mockReturnValue(true)
    attachHistory(services, new HistoryService())
    return services
  }

  it('联络在桌面上开了替我审批：评审员看准了就自己删，不问你', async () => {
    const victim = makeVictim('companion-review')
    const userTask = '删掉家目录里那份测试草稿'
    reviewSeesUserWords = (text) => text.includes(userTask)
    let asked = false
    const services = makeCompanionDeleteServices(`rm -f "${victim}"`, '联络这边删掉了')
    const agent = new SailFish(services)
    agent.setAgentId('__companion__')
    agent.updateConfig({ executionMode: 'relaxed' })

    const result = await agent.run(userTask, { ...ctx(), remoteChannel: 'desktop' }, {
      callbacks: { onNeedConfirm: () => { asked = true } },
    })

    expect(reviewPrompts.some(p => p.includes(userTask))).toBe(true)
    expect(asked).toBe(false)
    expect(fs.existsSync(victim)).toBe(false)
    expect(result).toContain('联络这边删掉了')
  })

  it('联络从飞书进来的那一轮：也是你本人，评审员看准了就自己删', async () => {
    const victim = makeVictim('companion-im')
    const userTask = '删掉家目录里那份测试草稿'
    reviewSeesUserWords = (text) => text.includes(userTask)
    let asked = false
    const services = makeCompanionDeleteServices(`rm -f "${victim}"`, '飞书这边删掉了')
    const agent = new SailFish(services)
    agent.setAgentId('__companion__')
    agent.updateConfig({ executionMode: 'relaxed' })

    const { formatAutoReviewImNotice } =
      await vi.importActual<typeof import('../../im/im.service')>('../../im/im.service')
    const imNotices: string[] = []
    const result = await agent.run(userTask, { ...ctx(), remoteChannel: 'feishu' }, {
      callbacks: {
        onNeedConfirm: () => { asked = true },
        onStep: (_id, step) => {
          const notice = formatAutoReviewImNotice(step)
          if (notice) imNotices.push(notice)
        },
      },
    })

    expect(reviewPrompts.some(p => p.includes(userTask))).toBe(true)
    expect(asked).toBe(false)
    expect(fs.existsSync(victim)).toBe(false)
    expect(result).toContain('飞书这边删掉了')
    expect(imNotices.some(n => n.startsWith('正在替你看') && n.includes(victim))).toBe(true)
    expect(imNotices.some(n => n.includes('替你放行') && n.includes(victim))).toBe(true)
  })

  it('联络从飞书进来、评审员看不准：交回来问你，你不同意文件就留着', async () => {
    const victim = makeVictim('companion-im-ask')
    reviewSeesUserWords = () => false
    let asked = false
    const services = makeCompanionDeleteServices(`rm -f "${victim}"`, '你没同意，文件留着')
    const agent = new SailFish(services)
    agent.setAgentId('__companion__')
    agent.updateConfig({ executionMode: 'relaxed' })

    await agent.run('收拾一下家目录', { ...ctx(), remoteChannel: 'feishu' }, {
      callbacks: {
        onNeedConfirm: (confirmation) => {
          asked = true
          confirmation.resolve?.(false)
        },
      },
    })

    expect(reviewPrompts.length).toBeGreaterThan(0)
    expect(asked).toBe(true)
    expect(fs.existsSync(victim)).toBe(true)
  })

  it('额外禁止开着：高风险直接拦，不问，文件还在', async () => {
    const victim = makeVictim('ban')
    const command = `rm -f "${victim}"`
    let asked = false
    const services = makeServices(({ isChild, messages }) => {
      if (isChild) {
        const done = (messages as Array<{ role?: string }>).some(m => m.role === 'tool')
        if (!done) return { tool_calls: [tc('exec', { command }, 'rm-ban')] }
        return { content: '被额外禁止拦住了' }
      }
      const text = allMessageText(messages as Array<{ content?: unknown }>)
      if (!text.includes('被额外禁止拦住了') && !(messages as Array<{ tool_calls?: unknown }>).some(m => m.tool_calls)) {
        return {
          tool_calls: [tc('dispatch_agents', {
            tasks: [{ name: '甲', description: '删草稿', prompt: '把那份草稿删掉', fork_turns: 'none' }]
          })]
        }
      }
      if (text.includes('被额外禁止拦住了')) return { content: '主人知道被额外禁止拦住了' }
      return { content: '先等他们' }
    })
    ;(services.configService as unknown as { getCommandRiskPolicy: ReturnType<typeof vi.fn> })
      .getCommandRiskPolicy.mockReturnValue({ subAgentBlockDangerous: true })
    attachHistory(services, new HistoryService())
    const parent = new SailFish(services)
    parent.setAgentId('e2e-ban')
    parent.updateConfig({
      executionMode: 'relaxed',
      commandRiskPolicy: { subAgentBlockDangerous: true } as never,
    })

    const result = await parent.run('删掉这份草稿', ctx(), {
      callbacks: { onNeedConfirm: () => { asked = true } },
    })

    const toolOutputs = llmCalls
      .flatMap(c => c.messages as Array<{ role?: string; content?: string }>)
      .map(m => String(m.content || ''))
      .join('\n')
    expect(asked).toBe(false)
    expect(fs.existsSync(victim)).toBe(true)
    expect(toolOutputs).toContain(`原命令：${command}`)
    expect(result).toContain('额外禁止')
  })

  it('两个伙计同时要删，这场一次只问一件，两份都点头后才都没了', async () => {
    const fileA = makeVictim('queue-a')
    const fileB = makeVictim('queue-b')
    const cmdA = `rm -f "${fileA}"`
    const cmdB = `rm -f "${fileB}"`
    const seen: string[] = []
    let overlapped = false
    const services = makeServices(({ isChild, childIndex, messages }) => {
      if (isChild) {
        const done = (messages as Array<{ role?: string }>).some(m => m.role === 'tool')
        if (!done) {
          const command = childIndex === 0 ? cmdA : cmdB
          return { tool_calls: [tc('exec', { command }, `rm-${childIndex}`)] }
        }
        const blob = JSON.stringify(messages)
        return { content: blob.includes(fileA) ? '甲删好了' : '乙删好了' }
      }
      const text = allMessageText(messages as Array<{ content?: unknown }>)
      if (!text.includes('甲删好了') && !(messages as Array<{ tool_calls?: unknown }>).some(m => m.tool_calls)) {
        return {
          tool_calls: [tc('dispatch_agents', {
            tasks: [
              { name: '甲', description: '删甲', prompt: '删甲的草稿', fork_turns: 'none' },
              { name: '乙', description: '删乙', prompt: '删乙的草稿', fork_turns: 'none' },
            ]
          })]
        }
      }
      if (text.includes('甲删好了') && text.includes('乙删好了')) return { content: '两份都删了' }
      return { content: '先等他们' }
    })
    attachHistory(services, new HistoryService())
    const parent = new SailFish(services)
    parent.setAgentId('e2e-queue')
    parent.updateConfig({ executionMode: 'relaxed' })

    const result = await parent.run('两份草稿都删掉', ctx(), {
      callbacks: {
        onNeedConfirm: (c) => {
          seen.push(String(c.toolArgs?.command ?? ''))
          if (seen.length === 1) {
            setTimeout(() => {
              overlapped = seen.length !== 1
              c.resolve(true)
            }, 400)
          } else {
            c.resolve(true)
          }
        },
      },
    })

    expect(overlapped).toBe(false)
    expect(seen).toHaveLength(2)
    expect(seen[0]).not.toBe(seen[1])
    expect(fs.existsSync(fileA)).toBe(false)
    expect(fs.existsSync(fileB)).toBe(false)
    expect(result).toContain('两份都删了')
  })
})
