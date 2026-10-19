/**
 * 计划没完成时的催促是问一次，不是循环：
 * 模型把评审意见交给用户复核（计划里剩下的步骤要等用户），引擎不能一遍遍追问、让同一份回复重写十几遍。
 * 真实 SailFish.run() + 脚本化模型。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import type { ToolDefinition } from '../../ai.service'
import type { AgentContext, AgentServices } from '../types'

let tmpDir: string

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

type Msg = { role?: string; content?: unknown; tool_calls?: unknown }
type LlmResponse = {
  content?: string
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  reasoning_content?: string
  thinkingOnly?: boolean
}

/** 失控保险：真有循环时让它在这里断开，测试照样能断言失败，不会卡到超时或撑爆内存 */
const RUNAWAY_GUARD = 10

function tc(name: string, args: Record<string, unknown>) {
  return { id: `tc-${name}-${Math.random().toString(36).slice(2, 7)}`, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } }
}

function planCall(args: Record<string, unknown>) {
  return tc('plan', args)
}

/** 到点清掉计划，之后只给一句收尾的话：循环再长也到此为止 */
function bail(index: number): LlmResponse {
  return index === RUNAWAY_GUARD
    ? { tool_calls: [planCall({ action: 'clear' })] }
    : { content: '失控保险收尾' }
}

function makeServices(responder: (call: { index: number; messages: Msg[] }) => LlmResponse): { services: AgentServices; calls: Msg[][] } {
  const calls: Msg[][] = []
  const services: AgentServices = {
    aiService: {
      chat: vi.fn().mockResolvedValue(''),
      chatWithToolsStream: vi.fn(async (
        messages: Msg[],
        _tools: ToolDefinition[],
        onChunk: (s: string) => void,
        _onToolCall: unknown,
        onDone: (r: unknown) => void,
      ) => {
        const snapshot: Msg[] = JSON.parse(JSON.stringify(messages))
        const index = calls.length
        calls.push(snapshot)
        const r = responder({ index, messages: snapshot })
        const content = r.content ?? ''
        if (content) onChunk(content)
        onDone({ content, tool_calls: r.tool_calls, reasoning_content: r.reasoning_content, thinkingOnly: r.thinkingOnly })
      }),
      abort: vi.fn()
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
  return { services, calls }
}

function ctx(): AgentContext {
  return {
    terminalOutput: [],
    systemInfo: { os: 'darwin', shell: '/bin/zsh' },
    terminalType: 'assistant',
    cwd: tmpDir,
  }
}

function newAgent(services: AgentServices, id: string): SailFish {
  const agent = new SailFish(services)
  agent.setAgentId(id)
  agent.updateConfig({ executionMode: 'free' })
  return agent
}

/** 把步数上限压到 2：运行配置目前没有对外的入口能把它设成非 0，测试里从子类里设 */
class StepLimitedAgent extends SailFish {
  protected initializeRun(...args: Parameters<SailFish['initializeRun']>) {
    const run = super.initializeRun(...args)
    run.config.maxSteps = 2
    return run
  }
}

const isHint = (m: Msg) => m.role === 'user' && String(m.content ?? '').startsWith('计划中还有')
const hintsIn = (messages: Msg[]) => messages.filter(isHint)

const REVIEW = '评审意见如下：建设范围与监管要求对不齐，建议补充全渠道说明。请你复核。'

describe('计划没完成时的催促：问一次，不是循环', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-plan-nudge-e2e-'))
  })
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('只回文字、剩下的步骤要等用户：追问一次后收工，回复在追问前就留在对话里，不重写', async () => {
    const { services, calls } = makeServices(({ index }) => {
      if (index === 0) {
        return { tool_calls: [planCall({ action: 'create', title: '评审立项', steps: ['形成评审意见', '用户复核后生成 Word'] })] }
      }
      if (index >= RUNAWAY_GUARD) return bail(index)
      return { content: REVIEW }
    })
    const agent = newAgent(services, 'e2e-plan-nudge-once')
    const result = await agent.run('评审这份立项材料', ctx(), {})

    // 创建计划 + 第一次回复 + 追问后的第二次回复，到此为止
    expect(calls.length).toBe(3)
    expect(result).toBe(REVIEW)

    // 追问只塞过一次
    expect(hintsIn(calls[2])).toHaveLength(1)
    // 追问紧跟在模型自己那段回复之后——它看得见自己已经答过
    const msgs = calls[2]
    const hintAt = msgs.findIndex(isHint)
    expect(msgs[hintAt - 1]).toMatchObject({ role: 'assistant', content: REVIEW })
    expect(String(msgs[hintAt].content)).toContain('你上一轮的回复已保留在对话里')
    // 追问把「等用户」的出路也摆了出来
    expect(String(msgs[hintAt].content)).toContain('plan(action="pause")')
  }, 15000)

  it('追问之后动了工具（含更新计划）就重新计数，之后偶尔再停一下仍可再被追问一次', async () => {
    const { services, calls } = makeServices(({ index }) => {
      switch (index) {
        case 0: return { tool_calls: [planCall({ action: 'create', title: '两步走', steps: ['第一步', '第二步'] })] }
        case 1: return { content: '第一步做完了。' }                       // 追问 #1
        case 2: return { tool_calls: [planCall({ action: 'update', step_index: 0, status: 'completed' })] }
        case 3: return { content: '第二步也差不多了。' }                    // 动过工具，重新计数 → 追问 #2
        case 4: return { content: '就停在这里，等你看。' }                  // 同一段里已问过一次 → 收工
        default: return bail(index)
      }
    })
    const agent = newAgent(services, 'e2e-plan-nudge-reset')
    const result = await agent.run('做两步', ctx(), {})

    expect(calls.length).toBe(5)
    expect(result).toBe('就停在这里，等你看。')
    expect(hintsIn(calls[4])).toHaveLength(2)
  }, 15000)

  it('模型选了暂停计划：这就是它的答复，不再追问', async () => {
    const { services, calls } = makeServices(({ index }) => {
      switch (index) {
        case 0: return { tool_calls: [planCall({ action: 'create', title: '评审立项', steps: ['形成评审意见', '用户复核后生成 Word'] })] }
        case 1: return { content: REVIEW }                                        // 追问
        case 2: return { tool_calls: [planCall({ action: 'pause', reason: '等用户复核' })] }
        case 3: return { content: '已暂停计划，等你复核后再继续。' }
        default: return bail(index)
      }
    })
    const agent = newAgent(services, 'e2e-plan-nudge-pause')
    const result = await agent.run('评审这份立项材料', ctx(), {})

    expect(calls.length).toBe(4)
    expect(result).toBe('已暂停计划，等你复核后再继续。')
    expect(hintsIn(calls[3])).toHaveLength(1)
  }, 15000)

  it('只思考没有正文的空回合：同一套界限，追问一次后收工，没有回复可留就不说「已保留」', async () => {
    const { services, calls } = makeServices(({ index }) => {
      if (index === 0) {
        return { tool_calls: [planCall({ action: 'create', title: '评审立项', steps: ['形成评审意见', '用户复核后生成 Word'] })] }
      }
      if (index >= RUNAWAY_GUARD) return bail(index)
      return { content: '', reasoning_content: '在想怎么写评审意见', thinkingOnly: true }
    })
    const agent = newAgent(services, 'e2e-plan-nudge-thinking')
    await agent.run('评审这份立项材料', ctx(), {})

    expect(calls.length).toBe(3)
    const hints = hintsIn(calls[2])
    expect(hints).toHaveLength(1)
    expect(String(hints[0].content)).not.toContain('你上一轮的回复已保留')
  }, 15000)

  it('追问之后用户插了话：算新的一段，之后模型再只回文字仍可再被追问一次', async () => {
    let agent!: SailFish
    const { services, calls } = makeServices(({ index }) => {
      switch (index) {
        case 0: return { tool_calls: [planCall({ action: 'create', title: '评审立项', steps: ['形成评审意见', '用户复核后生成 Word'] })] }
        case 1: return { content: REVIEW }                                   // 追问 #1
        case 2:
          agent.addUserMessage('再补充一句：重点看预算')                      // 用户在这一轮里插话
          return { content: REVIEW }
        case 3: return { content: '收到，预算部分已并入。' }                  // 插话后重新计数 → 追问 #2
        case 4: return { content: '等你复核。' }                              // 同一段里已问过一次 → 收工
        default: return bail(index)
      }
    })
    agent = newAgent(services, 'e2e-plan-nudge-user-speech')
    const result = await agent.run('评审这份立项材料', ctx(), {})

    expect(calls.length).toBe(5)
    expect(result).toBe('等你复核。')
    expect(hintsIn(calls[4])).toHaveLength(2)
  }, 15000)

  it('步数用尽正好停在追问那一轮：留下的回复不会在收尾时被存第二遍', async () => {
    const { services, calls } = makeServices(({ index }) => {
      if (index === 0) {
        return { tool_calls: [planCall({ action: 'create', title: '评审立项', steps: ['形成评审意见', '用户复核后生成 Word'] })] }
      }
      if (index === 1) return { content: REVIEW }                           // 追问；步数到此用尽
      if (index >= RUNAWAY_GUARD) return bail(index)
      return { content: '好的。' }
    })
    const agent = new StepLimitedAgent(services)
    agent.setAgentId('e2e-plan-nudge-max-steps')
    agent.updateConfig({ executionMode: 'free' })
    await agent.run('评审这份立项材料', ctx(), {})
    expect(calls.length).toBe(2)

    await agent.run('继续', ctx(), {})
    const history = calls[calls.length - 1]
    const stored = history.filter(m => m.role === 'assistant' && m.content === REVIEW)
    expect(stored).toHaveLength(1)
  }, 15000)

  it('计划已经全部完成时不追问', async () => {
    const { services, calls } = makeServices(({ index }) => {
      switch (index) {
        case 0: return { tool_calls: [planCall({ action: 'create', title: '一步', steps: ['唯一一步'] })] }
        case 1: return { tool_calls: [planCall({ action: 'update', step_index: 0, status: 'completed' })] }
        default: return { content: '做完了。' }
      }
    })
    const agent = newAgent(services, 'e2e-plan-nudge-done')
    const result = await agent.run('做一步', ctx(), {})

    expect(calls.length).toBe(3)
    expect(result).toBe('做完了。')
    expect(hintsIn(calls[2])).toHaveLength(0)
  }, 15000)
})
