/**
 * Fork（"另开一聊"）单元测试
 *
 * 覆盖：
 *  - Agent.cloneRecordForFork 截断到第 N 个 task
 *  - Agent.cloneRecordForFork 全量复制
 *  - Agent.applyForkSnapshot
 *  - AgentService.forkAgent 端到端流程
 *  - 同模式 / 跨模式 fork 时 cache snapshot 的传递策略（含截断时按相同边界 truncate snapshot）
 *  - 防御场景：源 Agent 不存在 / 运行中 / 无 sessionId
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/mock/user/data'),
    getName: vi.fn().mockReturnValue('SailFish'),
    getVersion: vi.fn().mockReturnValue('1.0.0')
  },
  BrowserWindow: vi.fn(),
  ipcMain: { on: vi.fn(), handle: vi.fn() }
}))

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
    readFileSync: vi.fn().mockReturnValue(''),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn().mockReturnValue([])
  }
})

vi.mock('../../im/im.service', () => ({
  getIMService: vi.fn().mockReturnValue(null)
}))

import { Agent } from '../agent'
import { AgentService } from '../index'
import { Conversation } from '../../conversation'
import type { ToolDefinition, AiMessage } from '../../ai.service'
import type { AgentContext, AgentServices, PromptOptions, AgentStep } from '../types'
import type { AgentRecord } from '@shared/types'

class TestAgent extends Agent {
  getAvailableTools(): ToolDefinition[] {
    return []
  }
  protected buildSystemPrompt(_context: AgentContext, _options: PromptOptions): string {
    return 'Test system prompt'
  }
  protected getAgentId(): string {
    return 'test-agent'
  }

  // 测试辅助：直接注入会话状态（避免实际跑 run() 的复杂度）
  injectSession(opts: {
    sessionId: string
    sessionStartTime?: number
    sessionMessages: AiMessage[]
    sessionSteps: AgentStep[]
    previousRunMessages?: AiMessage[]
    terminalType?: 'local' | 'ssh'
    sshHost?: string
  }): void {
    // 会话状态现由 Conversation 聚合根持有：构建一个并装载 transcript（跳过 taskMemory 重建）
    const conv = Conversation.create(
      { agentKey: (this as any)._agentId ?? 'test-agent', terminalType: opts.terminalType ?? 'assistant' },
      { id: opts.sessionId, createdAt: opts.sessionStartTime ?? Date.now(), sshHost: opts.sshHost },
      { taskMemory: (this as any).taskMemory }
    )
    conv.setRestoredTranscript(opts.sessionMessages, opts.sessionSteps as any)
    if (opts.previousRunMessages) {
      conv.setCachePrefix(opts.previousRunMessages)
    }
    ;(this as any)._conversation = conv
  }

  exposeSessionId() {
    return (this as any)._sessionId as string | undefined
  }
  exposePreviousRunMessages() {
    return (this as any)._previousRunMessages as AiMessage[] | undefined
  }

  setRunning(running: boolean): void {
    if (running) {
      ;(this as any).currentRun = { isRunning: true }
    } else {
      ;(this as any).currentRun = undefined
    }
  }
}

function createMockServices(overrides?: Partial<AgentServices>): AgentServices {
  return {
    aiService: {
      chatWithToolsStream: vi.fn(),
      abort: vi.fn()
    } as any,
    ptyService: {
      onData: vi.fn().mockReturnValue(() => {}),
      write: vi.fn()
    } as any,
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
      hasVisionCapability: vi.fn().mockReturnValue(true)
    } as any,
    ...overrides
  }
}

/** 构造 3 个连续完成的 task：每个 task 1 user message + 1 assistant message + final_result step */
function buildThreeTaskSession() {
  const messages: AiMessage[] = [
    { role: 'user', content: 'Task 1 question' },
    { role: 'assistant', content: 'Task 1 answer' },
    { role: 'user', content: 'Task 2 question' },
    { role: 'assistant', content: 'Task 2 answer' },
    { role: 'user', content: 'Task 3 question' },
    { role: 'assistant', content: 'Task 3 answer' }
  ]
  const baseTs = Date.now() - 10000
  const steps: AgentStep[] = [
    { id: 'ut1', type: 'user_task', content: 'Task 1 question', timestamp: baseTs },
    { id: 'm1', type: 'message', content: 'Task 1 answer', timestamp: baseTs + 100 },
    { id: 'fr1', type: 'final_result', content: 'Task 1 answer', timestamp: baseTs + 200 },
    { id: 'ut2', type: 'user_task', content: 'Task 2 question', timestamp: baseTs + 300 },
    { id: 'm2', type: 'message', content: 'Task 2 answer', timestamp: baseTs + 400 },
    { id: 'fr2', type: 'final_result', content: 'Task 2 answer', timestamp: baseTs + 500 },
    { id: 'ut3', type: 'user_task', content: 'Task 3 question', timestamp: baseTs + 600 },
    { id: 'm3', type: 'message', content: 'Task 3 answer', timestamp: baseTs + 700 },
    { id: 'fr3', type: 'final_result', content: 'Task 3 answer', timestamp: baseTs + 800 }
  ]
  return { messages, steps }
}

describe('Agent.cloneRecordForFork', () => {
  let agent: TestAgent

  beforeEach(() => {
    agent = new TestAgent(createMockServices())
  })

  it('returns null when no session exists', () => {
    expect(agent.cloneRecordForFork('new-session')).toBeNull()
  })

  it('clones full session when untilTaskCount is undefined', () => {
    const { messages, steps } = buildThreeTaskSession()
    agent.injectSession({
      sessionId: 'src',
      sessionMessages: messages,
      sessionSteps: steps
    })

    const record = agent.cloneRecordForFork('new-session')
    expect(record).not.toBeNull()
    expect(record!.id).toBe('new-session')
    expect(record!.messages?.length).toBe(6)
    expect(record!.steps.length).toBe(9)
    // userTask 取自第一个 user_task step
    expect(record!.userTask).toContain('Task 1 question')
    expect(record!.finalResult).toBe('Task 3 answer')
  })

  it('truncates to first N tasks when untilTaskCount is provided', () => {
    const { messages, steps } = buildThreeTaskSession()
    agent.injectSession({
      sessionId: 'src',
      sessionMessages: messages,
      sessionSteps: steps
    })

    const record = agent.cloneRecordForFork('new-session', { untilTaskCount: 2 })
    expect(record).not.toBeNull()
    // 前 2 个 task：4 messages（2 user + 2 assistant），6 steps（3 per task）
    expect(record!.messages?.length).toBe(4)
    expect(record!.steps.length).toBe(6)
    // finalResult 应是第 2 个 task 的结果
    expect(record!.finalResult).toBe('Task 2 answer')
    // 不应包含 Task 3 的内容
    const allContent = JSON.stringify(record)
    expect(allContent).not.toContain('Task 3')
  })

  it('untilTaskCount >= total tasks behaves like full clone', () => {
    const { messages, steps } = buildThreeTaskSession()
    agent.injectSession({
      sessionId: 'src',
      sessionMessages: messages,
      sessionSteps: steps
    })

    const record = agent.cloneRecordForFork('new-session', { untilTaskCount: 10 })
    expect(record!.messages?.length).toBe(6)
    expect(record!.steps.length).toBe(9)
  })

  it('appends titleSuffix to userTask', () => {
    const { messages, steps } = buildThreeTaskSession()
    agent.injectSession({
      sessionId: 'src',
      sessionMessages: messages,
      sessionSteps: steps
    })

    const record = agent.cloneRecordForFork('new-session', { titleSuffix: ' · 分支' })
    expect(record!.userTask).toBe('Task 1 question · 分支')
  })

  it('preserves terminalType / sshHost from source', () => {
    const { messages, steps } = buildThreeTaskSession()
    agent.injectSession({
      sessionId: 'src',
      sessionMessages: messages,
      sessionSteps: steps,
      terminalType: 'ssh',
      sshHost: 'example.com'
    })

    const record = agent.cloneRecordForFork('new-session')
    expect(record!.terminalType).toBe('ssh')
    expect(record!.sshHost).toBe('example.com')
  })

  it('cloned record is a deep copy (mutating it does not affect source)', () => {
    const { messages, steps } = buildThreeTaskSession()
    agent.injectSession({
      sessionId: 'src',
      sessionMessages: messages,
      sessionSteps: steps
    })

    const record = agent.cloneRecordForFork('new-session')
    record!.messages![0].content = 'MUTATED'
    expect(messages[0].content).toBe('Task 1 question')
  })

  it('supplement message with _systemInjected does not create extra task boundary', () => {
    // Task 2 包含一条用户追加消息（supplement）。
    // supplement 带 _systemInjected: true，不应被计为新 task 边界，
    // 否则 tasks.length(4) > stepChunks.length(3)，fork 截断会错误丢掉 Task 3。
    const messages: AiMessage[] = [
      { role: 'user', content: 'Task 1 question' },
      { role: 'assistant', content: 'Task 1 answer' },
      { role: 'user', content: 'Task 2 question' },
      { role: 'assistant', content: '...' },
      { role: 'user', content: 'Task 2 supplement', _systemInjected: true },  // supplement
      { role: 'assistant', content: 'Task 2 answer' },
      { role: 'user', content: 'Task 3 question' },
      { role: 'assistant', content: 'Task 3 answer' }
    ]
    const baseTs = Date.now() - 10000
    const steps: AgentStep[] = [
      { id: 'ut1', type: 'user_task', content: 'Task 1 question', timestamp: baseTs },
      { id: 'fr1', type: 'final_result', content: 'Task 1 answer', timestamp: baseTs + 200 },
      { id: 'ut2', type: 'user_task', content: 'Task 2 question', timestamp: baseTs + 300 },
      { id: 'us2', type: 'user_supplement', content: 'Task 2 supplement', timestamp: baseTs + 450 },
      { id: 'fr2', type: 'final_result', content: 'Task 2 answer', timestamp: baseTs + 500 },
      { id: 'ut3', type: 'user_task', content: 'Task 3 question', timestamp: baseTs + 600 },
      { id: 'fr3', type: 'final_result', content: 'Task 3 answer', timestamp: baseTs + 800 }
    ]
    agent.injectSession({ sessionId: 'src', sessionMessages: messages, sessionSteps: steps })

    // fork 最后一个 group（index=2，untilTaskCount=3）
    const record = agent.cloneRecordForFork('new-session', { untilTaskCount: 3 })
    expect(record).not.toBeNull()
    // 3 个 step chunks，untilTaskCount=3 → 不截断，全量保留
    expect(record!.steps.length).toBe(7)
    // 3 个真实 task 边界（supplement 带 _systemInjected，不算），不截断 → 全量 8 messages
    expect(record!.messages?.length).toBe(8)
    // Task 3 的内容必须存在
    const content = JSON.stringify(record!.messages)
    expect(content).toContain('Task 3 question')
    expect(content).toContain('Task 3 answer')
  })

  it('supplement without _systemInjected creates extra task boundary causing truncation', () => {
    // 无 _systemInjected 的 supplement 会被误算为 task 边界，
    // 导致 tasks.length=4 > stepChunks.length=3，fork 截断丢 Task 3。
    // 此测试记录 bug 行为，保证有人移除 _systemInjected 时测试会红。
    const messages: AiMessage[] = [
      { role: 'user', content: 'Task 1 question' },
      { role: 'assistant', content: 'Task 1 answer' },
      { role: 'user', content: 'Task 2 question' },
      { role: 'assistant', content: '...' },
      { role: 'user', content: 'Task 2 supplement' },  // 没有 _systemInjected → 误算边界
      { role: 'assistant', content: 'Task 2 answer' },
      { role: 'user', content: 'Task 3 question' },
      { role: 'assistant', content: 'Task 3 answer' }
    ]
    const baseTs = Date.now() - 10000
    const steps: AgentStep[] = [
      { id: 'ut1', type: 'user_task', content: 'Task 1 question', timestamp: baseTs },
      { id: 'fr1', type: 'final_result', content: 'Task 1 answer', timestamp: baseTs + 200 },
      { id: 'ut2', type: 'user_task', content: 'Task 2 question', timestamp: baseTs + 300 },
      { id: 'us2', type: 'user_supplement', content: 'Task 2 supplement', timestamp: baseTs + 450 },
      { id: 'fr2', type: 'final_result', content: 'Task 2 answer', timestamp: baseTs + 500 },
      { id: 'ut3', type: 'user_task', content: 'Task 3 question', timestamp: baseTs + 600 },
      { id: 'fr3', type: 'final_result', content: 'Task 3 answer', timestamp: baseTs + 800 }
    ]
    agent.injectSession({ sessionId: 'src', sessionMessages: messages, sessionSteps: steps })

    const record = agent.cloneRecordForFork('new-session', { untilTaskCount: 3 })
    expect(record).not.toBeNull()
    // steps 不受影响：3 chunks，untilTaskCount=3 → 全量保留
    expect(record!.steps.length).toBe(7)
    // messages 被误截：4 message tasks（supplement 误算为边界），untilTaskCount=3 < 4 → 截断！
    // 只取前 3 个 message tasks，丢失 Task 3
    expect(record!.messages?.length).toBe(6)  // Task 1(2) + Task 2 first half(2) + supplement onward(2) = 6，Task 3 丢失
    const content = JSON.stringify(record!.messages)
    expect(content).not.toContain('Task 3 question')  // Task 3 被截掉
  })
})

describe('Agent.applyForkSnapshot', () => {
  let agent: TestAgent

  beforeEach(() => {
    agent = new TestAgent(createMockServices())
  })

  it('applyForkSnapshot sets sessionId and clears in-memory session arrays', () => {
    agent.injectSession({
      sessionId: 'old',
      sessionMessages: [{ role: 'user', content: 'old' }],
      sessionSteps: [{ id: 'old-step', type: 'user_task', content: 'old', timestamp: 0 }]
    })

    agent.applyForkSnapshot({
      sessionId: 'new',
      previousRunMessages: [{ role: 'user', content: 'prev' }]
    })

    expect(agent.exposeSessionId()).toBe('new')
    expect(agent.exposePreviousRunMessages()).toEqual([{ role: 'user', content: 'prev' }])
  })

  it('applyForkSnapshot without previousRunMessages still resets sessionId', () => {
    agent.injectSession({
      sessionId: 'old',
      sessionMessages: [],
      sessionSteps: []
    })

    agent.applyForkSnapshot({ sessionId: 'new' })

    expect(agent.exposeSessionId()).toBe('new')
    expect(agent.exposePreviousRunMessages()).toBeUndefined()
  })
})

describe('AgentService.forkAgent', () => {
  it('returns null when source agent does not exist', async () => {
    const ai = { chatWithToolsStream: vi.fn(), abort: vi.fn() } as any
    const pty = { onData: vi.fn().mockReturnValue(() => {}), write: vi.fn() } as any
    const service = new AgentService(ai, pty)
    const result = await service.forkAgent({
      sourceAgentKey: 'nonexistent',
      newAgentId: 'new-id'
    })
    expect(result).toBeNull()
  })

  it('forks from HistoryService when source agent is missing but sourceSessionId is provided', async () => {
    const ai = { chatWithToolsStream: vi.fn(), abort: vi.fn() } as any
    const pty = { onData: vi.fn().mockReturnValue(() => {}), write: vi.fn() } as any
    const service = new AgentService(ai, pty)

    const { messages, steps } = buildThreeTaskSession()
    const historyRecord = {
      id: 'history-session',
      timestamp: Date.now() - 20000,
      terminalId: '',
      terminalType: 'local' as const,
      userTask: 'Task 1 question',
      steps,
      messages,
      duration: 1000,
      status: 'completed' as const,
    }

    const savedRecords: any[] = []
    const historyService = {
      saveAgentRecord: vi.fn((r) => { savedRecords.push(r) }),
      getAgentRecordById: vi.fn((id: string) => id === 'history-session' ? historyRecord : undefined),
      getRecentAgentRecords: vi.fn().mockReturnValue([]),
      getAgentRecordStore: vi.fn(() => historyService)
    }
    service.setHistoryService(historyService as any)

    const result = await service.forkAgent({
      sourceAgentKey: 'nonexistent',
      newAgentId: 'new-from-history',
      sourceSessionId: 'history-session',
      untilTaskCount: 2,
      titleSuffix: ' · 分支'
    })

    expect(result).not.toBeNull()
    expect(result!.newAgentId).toBe('new-from-history')
    expect(result!.sourceUserTask).toBe('Task 1 question · 分支')
    expect(savedRecords[0].messages?.length).toBe(4)
    expect(historyService.getAgentRecordById).toHaveBeenCalledWith('history-session')
  })

  it('returns null when historyService is not configured', async () => {
    const ai = { chatWithToolsStream: vi.fn(), abort: vi.fn() } as any
    const pty = { onData: vi.fn().mockReturnValue(() => {}), write: vi.fn() } as any
    const service = new AgentService(ai, pty)

    // 创建一个有会话的源 agent，但不注入 historyService
    const src = service.createAssistantAgent('src') as unknown as TestAgent
    Object.setPrototypeOf(src, TestAgent.prototype)
    const { messages, steps } = buildThreeTaskSession()
    src.injectSession({ sessionId: 'src-session', sessionMessages: messages, sessionSteps: steps })

    const result = await service.forkAgent({
      sourceAgentKey: 'src',
      newAgentId: 'new-id'
    })
    expect(result).toBeNull()
  })

  it('end-to-end: writes new record + creates new agent + transfers cache snapshot for assistant→assistant', async () => {
    const ai = { chatWithToolsStream: vi.fn(), abort: vi.fn() } as any
    const pty = { onData: vi.fn().mockReturnValue(() => {}), write: vi.fn() } as any
    const service = new AgentService(ai, pty)

    const savedRecords: any[] = []
    const historyService = {
      saveAgentRecord: vi.fn((r) => { savedRecords.push(r) }),
      getAgentRecordById: vi.fn().mockReturnValue(undefined),
      getRecentAgentRecords: vi.fn().mockReturnValue([]),
      getAgentRecordStore: vi.fn(() => historyService)
    }
    service.setHistoryService(historyService as any)

    const src = service.createAssistantAgent('src') as unknown as TestAgent
    Object.setPrototypeOf(src, TestAgent.prototype)
    const { messages, steps } = buildThreeTaskSession()
    // 注：源是 assistant 模式（无 terminalType）
    src.injectSession({
      sessionId: 'src-session',
      sessionMessages: messages,
      sessionSteps: steps
    })

    const result = await service.forkAgent({
      sourceAgentKey: 'src',
      newAgentId: 'new-id',
      titleSuffix: ' · 分支'
    })

    expect(result).not.toBeNull()
    expect(result!.newAgentId).toBe('new-id')
    expect(result!.sourceUserTask).toBe('Task 1 question · 分支')
    expect(historyService.saveAgentRecord).toHaveBeenCalledOnce()
    expect(savedRecords[0].id).toBe(result!.newSessionId)
    expect(savedRecords[0].userTask).toBe('Task 1 question · 分支')
    expect(savedRecords[0].messages?.length).toBe(6)

    // 同模式全量 fork：新 agent 应继承 cache snapshot，内容 = newRecord.messages
    const newAgent = service.getAgent('new-id') as unknown as TestAgent
    Object.setPrototypeOf(newAgent, TestAgent.prototype)
    expect(newAgent.exposeSessionId()).toBe(result!.newSessionId)
    expect(newAgent.exposePreviousRunMessages()).toEqual(savedRecords[0].messages)
  })

  it('cross-mode fork (terminal → assistant): does NOT transfer cache snapshot', async () => {
    const ai = { chatWithToolsStream: vi.fn(), abort: vi.fn() } as any
    const pty = { onData: vi.fn().mockReturnValue(() => {}), write: vi.fn() } as any
    const service = new AgentService(ai, pty)

    const historyService = {
      saveAgentRecord: vi.fn(),
      getAgentRecordById: vi.fn().mockReturnValue(undefined),
      getRecentAgentRecords: vi.fn().mockReturnValue([]),
      getAgentRecordStore: vi.fn(() => historyService)
    }
    service.setHistoryService(historyService as any)

    // 用 getOrCreateAgent 模拟终端 Agent，再覆盖原型为 TestAgent
    const src = service.getOrCreateAgent('src-tab-id') as unknown as TestAgent
    Object.setPrototypeOf(src, TestAgent.prototype)
    const { messages, steps } = buildThreeTaskSession()
    src.injectSession({
      sessionId: 'src-session',
      sessionMessages: messages,
      sessionSteps: steps,
      terminalType: 'ssh',
      sshHost: 'example.com'
    })

    const result = await service.forkAgent({
      sourceAgentKey: 'src-tab-id',
      newAgentId: 'new-assistant',
      targetMode: 'assistant'
    })

    expect(result).not.toBeNull()

    // 跨模式 fork：cache snapshot 不应被传递（system prompt 不同，cache 物理上无法命中）
    const newAgent = service.getAgent('new-assistant') as unknown as TestAgent
    Object.setPrototypeOf(newAgent, TestAgent.prototype)
    expect(newAgent.exposePreviousRunMessages()).toBeUndefined()
  })

  it('truncated same-mode fork: cache snapshot is set to the truncated messages (matches new record)', async () => {
    const ai = { chatWithToolsStream: vi.fn(), abort: vi.fn() } as any
    const pty = { onData: vi.fn().mockReturnValue(() => {}), write: vi.fn() } as any
    const service = new AgentService(ai, pty)

    const savedRecords: any[] = []
    const historyService = {
      saveAgentRecord: vi.fn((r) => { savedRecords.push(r) }),
      getAgentRecordById: vi.fn().mockReturnValue(undefined),
      getRecentAgentRecords: vi.fn().mockReturnValue([]),
      getAgentRecordStore: vi.fn(() => historyService)
    }
    service.setHistoryService(historyService as any)

    const src = service.createAssistantAgent('src') as unknown as TestAgent
    Object.setPrototypeOf(src, TestAgent.prototype)
    const { messages, steps } = buildThreeTaskSession()
    src.injectSession({
      sessionId: 'src-session',
      sessionMessages: messages,
      sessionSteps: steps,
      // 注入完整对话的 cache snapshot；fork 时不应原样传递（会破坏截断意图）
      previousRunMessages: messages.map(m => ({ ...m }))
    })

    await service.forkAgent({
      sourceAgentKey: 'src',
      newAgentId: 'new-id',
      untilTaskCount: 2
    })

    const newAgent = service.getAgent('new-id') as unknown as TestAgent
    Object.setPrototypeOf(newAgent, TestAgent.prototype)
    const carriedSnapshot = newAgent.exposePreviousRunMessages()
    // 截断 fork 仍然传 cache snapshot —— 但内容是按相同边界截断后的 messages（4 条），
    // 与新 record.messages 字节一致；既保持截断意图，又能命中 LLM 前缀缓存
    expect(carriedSnapshot).toBeDefined()
    expect(carriedSnapshot).toEqual(savedRecords[0].messages)
    expect(carriedSnapshot!.length).toBe(4)
    // 不应包含被截掉的 Task 3
    const allContent = JSON.stringify(carriedSnapshot)
    expect(allContent).not.toContain('Task 3')
  })

  it('truncates record when untilTaskCount is provided', async () => {
    const ai = { chatWithToolsStream: vi.fn(), abort: vi.fn() } as any
    const pty = { onData: vi.fn().mockReturnValue(() => {}), write: vi.fn() } as any
    const service = new AgentService(ai, pty)

    const savedRecords: any[] = []
    const historyService = {
      saveAgentRecord: vi.fn((r) => { savedRecords.push(r) }),
      getAgentRecordById: vi.fn().mockReturnValue(undefined),
      getRecentAgentRecords: vi.fn().mockReturnValue([]),
      getAgentRecordStore: vi.fn(() => historyService)
    }
    service.setHistoryService(historyService as any)

    const src = service.createAssistantAgent('src') as unknown as TestAgent
    Object.setPrototypeOf(src, TestAgent.prototype)
    const { messages, steps } = buildThreeTaskSession()
    src.injectSession({
      sessionId: 'src-session',
      sessionMessages: messages,
      sessionSteps: steps
    })

    await service.forkAgent({
      sourceAgentKey: 'src',
      newAgentId: 'new-id',
      untilTaskCount: 2
    })

    expect(savedRecords[0].messages?.length).toBe(4)
    expect(savedRecords[0].steps.length).toBe(6)
    expect(savedRecords[0].finalResult).toBe('Task 2 answer')
  })

  it('returns null on full fork while source agent is running', async () => {
    const ai = { chatWithToolsStream: vi.fn(), abort: vi.fn() } as any
    const pty = { onData: vi.fn().mockReturnValue(() => {}), write: vi.fn() } as any
    const service = new AgentService(ai, pty)

    const historyService = {
      saveAgentRecord: vi.fn(),
      getAgentRecordById: vi.fn().mockReturnValue(undefined),
      getRecentAgentRecords: vi.fn().mockReturnValue([]),
      getAgentRecordStore: vi.fn(() => historyService)
    }
    service.setHistoryService(historyService as any)

    const src = service.createAssistantAgent('src') as unknown as TestAgent
    Object.setPrototypeOf(src, TestAgent.prototype)
    const { messages, steps } = buildThreeTaskSession()
    src.injectSession({ sessionId: 'src-session', sessionMessages: messages, sessionSteps: steps })
    src.setRunning(true)

    const result = await service.forkAgent({
      sourceAgentKey: 'src',
      newAgentId: 'new-id'
    })
    expect(result).toBeNull()
    expect(historyService.saveAgentRecord).not.toHaveBeenCalled()
  })

  it('allows truncated fork while source agent is running', async () => {
    const ai = { chatWithToolsStream: vi.fn(), abort: vi.fn() } as any
    const pty = { onData: vi.fn().mockReturnValue(() => {}), write: vi.fn() } as any
    const service = new AgentService(ai, pty)

    const savedRecords: any[] = []
    const historyService = {
      saveAgentRecord: vi.fn((r) => { savedRecords.push(r) }),
      getAgentRecordById: vi.fn().mockReturnValue(undefined),
      getRecentAgentRecords: vi.fn().mockReturnValue([]),
      getAgentRecordStore: vi.fn(() => historyService)
    }
    service.setHistoryService(historyService as any)

    const src = service.createAssistantAgent('src') as unknown as TestAgent
    Object.setPrototypeOf(src, TestAgent.prototype)
    const { messages, steps } = buildThreeTaskSession()
    src.injectSession({ sessionId: 'src-session', sessionMessages: messages, sessionSteps: steps })
    src.setRunning(true)

    const result = await service.forkAgent({
      sourceAgentKey: 'src',
      newAgentId: 'new-id',
      untilTaskCount: 2
    })

    expect(result).not.toBeNull()
    expect(savedRecords[0].messages?.length).toBe(4)
    expect(savedRecords[0].finalResult).toBe('Task 2 answer')
  })
})

// ============================================================================
// 新增：Conversation.extractTaskFromRecords + AgentService.extractTaskFromCompanion
// companion → task 异质转化：N 条物理 record 合并后截断产出新任务会话
// ============================================================================

/** 构造一条 companion record（agentKey='__companion__'，含 N 个 task） */
function buildCompanionRecord(opts: {
  id: string
  timestamp: number
  userTask: string
  messages: AiMessage[]
  steps: AgentStep[]
  proactive?: boolean
}): AgentRecord {
  return {
    id: opts.id,
    kind: 'companion',
    timestamp: opts.timestamp,
    terminalId: '',
    agentKey: '__companion__',
    terminalType: 'assistant',
    userTask: opts.proactive ? '__proactive__' : opts.userTask,
    steps: opts.steps,
    messages: opts.messages,
    duration: 0,
    status: 'completed'
  }
}

describe('Conversation.extractTaskFromRecords', () => {
  it('returns null for empty records array', () => {
    const result = Conversation.extractTaskFromRecords([], 'new-session')
    expect(result).toBeNull()
  })

  it('merges multiple records by timestamp; anchor at last takes all continuous tasks', () => {
    // 两条 companion record，各含 1 个 task；合并后是 2 个 task，间隔 1s（< 6h，连续）
    const rec1 = buildCompanionRecord({
      id: 'sess_c1',
      timestamp: 1000,
      userTask: '早段问题',
      messages: [
        { role: 'user', content: '早段问题' },
        { role: 'assistant', content: '早段回答' }
      ],
      steps: [
        { id: 'ut1', type: 'user_task', content: '早段问题', timestamp: 1000 },
        { id: 'fr1', type: 'final_result', content: '早段回答', timestamp: 1100 }
      ]
    })
    const rec2 = buildCompanionRecord({
      id: 'sess_c2',
      timestamp: 2000,
      userTask: '晚段问题',
      messages: [
        { role: 'user', content: '晚段问题' },
        { role: 'assistant', content: '晚段回答' }
      ],
      steps: [
        { id: 'ut2', type: 'user_task', content: '晚段问题', timestamp: 2000 },
        { id: 'fr2', type: 'final_result', content: '晚段回答', timestamp: 2100 }
      ]
    })

    // (a) 默认锚点 = 最后一个 task → 两段连续（间隔 1s < 6h），全带
    const full = Conversation.extractTaskFromRecords([rec2, rec1], 'sess_extract_full')!
    expect(full).not.toBeNull()
    expect(full.record.id).toBe('sess_extract_full')
    expect(full.record.kind).toBe('task') // 异质转化：产物恒为 task
    expect(full.record.messages!.length).toBe(4)
    expect(full.record.messages![0].content).toBe('早段问题') // 按 timestamp 升序

    // (b) 锚点 = 第 0 个 task（最早那段）→ 只含早段
    const partial = Conversation.extractTaskFromRecords(
      [rec2, rec1],
      'sess_extract_partial',
      { anchorTaskIndex: 0 }
    )!
    expect(partial).not.toBeNull()
    expect(partial.record.messages!.length).toBe(2)
    expect(partial.record.messages![0].content).toBe('早段问题')
    expect(partial.record.messages![1].content).toBe('早段回答')
  })

  it('time window: 6h gap breaks continuity (anchored at later task drops earlier)', () => {
    // 两条 record 间隔 7h（> 6h 阈值）→ 不连续
    const baseTs = Date.now()
    const rec1 = buildCompanionRecord({
      id: 'sess_old',
      timestamp: baseTs,
      userTask: '昨天的话题',
      messages: [
        { role: 'user', content: '昨天的话题' },
        { role: 'assistant', content: '昨天的回答' }
      ],
      steps: [
        { id: 'ut1', type: 'user_task', content: '昨天的话题', timestamp: baseTs },
        { id: 'fr1', type: 'final_result', content: '昨天的回答', timestamp: baseTs + 100 }
      ]
    })
    const rec2 = buildCompanionRecord({
      id: 'sess_new',
      timestamp: baseTs + 7 * 60 * 60 * 1000, // 7h 后（> 6h 阈值）
      userTask: '今天的话题',
      messages: [
        { role: 'user', content: '今天的话题' },
        { role: 'assistant', content: '今天的回答' }
      ],
      steps: [
        { id: 'ut2', type: 'user_task', content: '今天的话题', timestamp: baseTs + 7 * 60 * 60 * 1000 },
        { id: 'fr2', type: 'final_result', content: '今天的回答', timestamp: baseTs + 7 * 60 * 60 * 1000 + 100 }
      ]
    })

    // 锚点 = 最后一个 task（今天）→ 间隔 7h ≥ 6h，昨天那段不带
    const result = Conversation.extractTaskFromRecords([rec1, rec2], 'sess_window')!
    expect(result).not.toBeNull()
    expect(result.record.messages!.length).toBe(2)
    expect(result.record.messages![0].content).toBe('今天的话题')
    expect(result.record.messages![1].content).toBe('今天的回答')
  })

  it('time window: cross-night continuity (< 6h gap keeps both)', () => {
    // 周日 23:50 → 周一 00:10，间隔 20 分钟 < 6h → 跨夜连续，都带
    const sundayNight = new Date('2026-06-28T23:50:00').getTime()
    const mondayEarly = sundayNight + 20 * 60 * 1000 // +20min
    const rec1 = buildCompanionRecord({
      id: 'sess_sun',
      timestamp: sundayNight,
      userTask: '周日夜聊',
      messages: [
        { role: 'user', content: '周日夜聊' },
        { role: 'assistant', content: '周日夜答' }
      ],
      steps: [
        { id: 'ut1', type: 'user_task', content: '周日夜聊', timestamp: sundayNight },
        { id: 'fr1', type: 'final_result', content: '周日夜答', timestamp: sundayNight + 100 }
      ]
    })
    const rec2 = buildCompanionRecord({
      id: 'sess_mon',
      timestamp: mondayEarly,
      userTask: '周一凌晨续聊',
      messages: [
        { role: 'user', content: '周一凌晨续聊' },
        { role: 'assistant', content: '周一凌晨回答' }
      ],
      steps: [
        { id: 'ut2', type: 'user_task', content: '周一凌晨续聊', timestamp: mondayEarly },
        { id: 'fr2', type: 'final_result', content: '周一凌晨回答', timestamp: mondayEarly + 100 }
      ]
    })

    // 锚点 = 最后一个 task（周一凌晨）→ 间隔 20min < 6h，周日夜那段也带
    const result = Conversation.extractTaskFromRecords([rec1, rec2], 'sess_cross_night')!
    expect(result).not.toBeNull()
    expect(result.record.messages!.length).toBe(4)
    expect(result.record.messages![0].content).toBe('周日夜聊')
    expect(result.record.messages![2].content).toBe('周一凌晨续聊')
  })

  it('time window: cap at 10 tasks (anchored at last drops older beyond cap)', () => {
    // 12 条 record，每条间隔 1 分钟（< 6h，全连续），锚点取最后一个 → cap=10 截断到最近 10 段
    const baseTs = Date.now()
    const records: AgentRecord[] = []
    for (let i = 0; i < 12; i++) {
      const ts = baseTs + i * 60 * 1000 // 1 分钟间隔
      records.push(buildCompanionRecord({
        id: `sess_cap_${i}`,
        timestamp: ts,
        userTask: `第${i + 1}段`,
        messages: [
          { role: 'user', content: `第${i + 1}段问题` },
          { role: 'assistant', content: `第${i + 1}段回答` }
        ],
        steps: [
          { id: `ut_${i}`, type: 'user_task', content: `第${i + 1}段`, timestamp: ts },
          { id: `fr_${i}`, type: 'final_result', content: `第${i + 1}段回答`, timestamp: ts + 100 }
        ]
      }))
    }

    // 锚点默认 = 最后一个 task（第 12 段）→ 12 段全连续，但 cap=10，取最近 10 段（第 3-12 段）
    const result = Conversation.extractTaskFromRecords(records, 'sess_cap')!
    expect(result).not.toBeNull()
    expect(result.record.messages!.length).toBe(20) // 10 段 × 2 messages
    // 第一段应是第 3 段（index 2），不是第 1 段
    expect(result.record.messages![0].content).toBe('第3段问题')
    expect(result.record.messages![18].content).toBe('第12段问题')
  })

  it('skips proactive records when merging messages (proactive has no API messages)', () => {
    // proactive record（Watch 主动消息冒泡）：userTask='__proactive__'，无 messages
    const proactive = buildCompanionRecord({
      id: 'sess_proactive',
      timestamp: 1500,
      userTask: '主动通知',
      messages: [],
      steps: [
        { id: 'ut_p', type: 'user_task', content: '主动通知', timestamp: 1500 }
      ],
      proactive: true
    })
    const real = buildCompanionRecord({
      id: 'sess_real',
      timestamp: 1000,
      userTask: '真实对话',
      messages: [
        { role: 'user', content: '真实对话' },
        { role: 'assistant', content: '真实回答' }
      ],
      steps: [
        { id: 'ut_r', type: 'user_task', content: '真实对话', timestamp: 1000 }
      ]
    })

    const result = Conversation.extractTaskFromRecords([proactive, real], 'sess_extract', {
      anchorTaskStepId: 'ut_r'
    })!
    // messages 只含真实对话（proactive record 无 API messages；锚点为用户对话）
    expect(result.record.messages!.length).toBe(2)
    expect(result.record.messages![0].content).toBe('真实对话')
  })

  it('resolves anchor by anchorTaskStepId when index would mismatch', () => {
    const baseTs = Date.now()
    const records: AgentRecord[] = []
    for (let i = 0; i < 5; i++) {
      const ts = baseTs + i * 60 * 1000
      records.push(buildCompanionRecord({
        id: `sess_${i}`,
        timestamp: ts,
        userTask: `第${i + 1}段`,
        messages: [
          { role: 'user', content: `第${i + 1}段问题` },
          { role: 'assistant', content: `第${i + 1}段回答` }
        ],
        steps: [
          { id: `ut_${i}`, type: 'user_task', content: `第${i + 1}段`, timestamp: ts },
          { id: `fr_${i}`, type: 'final_result', content: `第${i + 1}段回答`, timestamp: ts + 100 }
        ]
      }))
    }

    const result = Conversation.extractTaskFromRecords(records, 'sess_by_id', {
      anchorTaskIndex: 99,
      anchorTaskStepId: 'ut_2'
    })!
    // 锚在第 3 段，向前连续含第 1–3 段（均在 6h 内）
    expect(result.record.messages!.length).toBe(6)
    expect(result.record.messages![0].content).toBe('第1段问题')
    expect(result.record.userTask).toBe('第3段')
  })

  it('proactive anchor only includes that notification, not earlier proactive within 6h', () => {
    const baseTs = Date.now()
    const rec1 = buildCompanionRecord({
      id: 'sess_p1',
      timestamp: baseTs,
      userTask: '主动通知',
      messages: [],
      steps: [
        { id: 'ut_p1', type: 'user_task', content: '__proactive__', timestamp: baseTs },
        { id: 'fr_p1', type: 'final_result', content: '邮件提醒内容', timestamp: baseTs + 100 }
      ],
      proactive: true
    })
    const rec2 = buildCompanionRecord({
      id: 'sess_p2',
      timestamp: baseTs + 30 * 60 * 1000,
      userTask: '主动通知',
      messages: [],
      steps: [
        { id: 'ut_p2', type: 'user_task', content: '__proactive__', timestamp: baseTs + 30 * 60 * 1000 },
        { id: 'fr_p2', type: 'final_result', content: '截止提醒内容', timestamp: baseTs + 30 * 60 * 1000 + 100 }
      ],
      proactive: true
    })

    const result = Conversation.extractTaskFromRecords([rec1, rec2], 'sess_proactive_only', {
      anchorTaskStepId: 'ut_p2'
    })!
    expect(result.record.steps!.filter(s => s.type === 'user_task').length).toBe(1)
    expect(result.record.userTask).toContain('截止提醒')
    expect(result.record.userTask).not.toContain('邮件提醒')
    expect(result.record.messages!.length).toBe(1)
    expect(result.record.messages![0].content).toBe('截止提醒内容')
  })

  it('proactive interleaved: anchor messages stay at clicked task (no slide past)', () => {
    // 回归：messageTasks 下标曾直接用 stepChunk 下标，锚在 B 会取到 C（往后滑）。
    // A → proactive → B → C，锚在 B 应只含 B；锚在 C 应含 B+C（连续、中间 proactive 切断向前）。
    const baseTs = Date.now()
    const recA = buildCompanionRecord({
      id: 'sess_a',
      timestamp: baseTs,
      userTask: '问题A',
      messages: [
        { role: 'user', content: '问题A' },
        { role: 'assistant', content: '回答A' }
      ],
      steps: [
        { id: 'ut_a', type: 'user_task', content: '问题A', timestamp: baseTs },
        { id: 'fr_a', type: 'final_result', content: '回答A', timestamp: baseTs + 100 }
      ]
    })
    const recP = buildCompanionRecord({
      id: 'sess_p',
      timestamp: baseTs + 60 * 1000,
      userTask: '主动通知',
      messages: [],
      steps: [
        { id: 'ut_p', type: 'user_task', content: '__proactive__', timestamp: baseTs + 60 * 1000 },
        { id: 'fr_p', type: 'final_result', content: '主动提醒', timestamp: baseTs + 60 * 1000 + 100 }
      ],
      proactive: true
    })
    const recB = buildCompanionRecord({
      id: 'sess_b',
      timestamp: baseTs + 2 * 60 * 1000,
      userTask: '问题B',
      messages: [
        { role: 'user', content: '问题B' },
        { role: 'assistant', content: '回答B' }
      ],
      steps: [
        { id: 'ut_b', type: 'user_task', content: '问题B', timestamp: baseTs + 2 * 60 * 1000 },
        { id: 'fr_b', type: 'final_result', content: '回答B', timestamp: baseTs + 2 * 60 * 1000 + 100 }
      ]
    })
    const recC = buildCompanionRecord({
      id: 'sess_c',
      timestamp: baseTs + 3 * 60 * 1000,
      userTask: '问题C',
      messages: [
        { role: 'user', content: '问题C' },
        { role: 'assistant', content: '回答C' }
      ],
      steps: [
        { id: 'ut_c', type: 'user_task', content: '问题C', timestamp: baseTs + 3 * 60 * 1000 },
        { id: 'fr_c', type: 'final_result', content: '回答C', timestamp: baseTs + 3 * 60 * 1000 + 100 }
      ]
    })
    const records = [recA, recP, recB, recC]

    const atB = Conversation.extractTaskFromRecords(records, 'sess_at_b', {
      anchorTaskStepId: 'ut_b'
    })!
    // 用户窗 A+B，中间 proactive 补进（通知→可能接着回）
    expect(atB.record.userTask).toBe('问题B')
    expect(atB.record.messages!.some(m => m.content === '问题A')).toBe(true)
    expect(atB.record.messages!.some(m => m.content === '问题B')).toBe(true)
    expect(atB.record.messages!.some(m => m.content === '主动提醒')).toBe(true)
    expect(atB.record.messages!.some(m => m.content === '问题C')).toBe(false)
    expect(atB.record.steps!.some(s => s.id === 'ut_p')).toBe(true)

    const atC = Conversation.extractTaskFromRecords(records, 'sess_at_c', {
      anchorTaskStepId: 'ut_c'
    })!
    expect(atC.record.userTask).toBe('问题C')
    expect(atC.record.messages!.some(m => m.content === '问题A')).toBe(true)
    expect(atC.record.messages!.some(m => m.content === '问题B')).toBe(true)
    expect(atC.record.messages!.some(m => m.content === '问题C')).toBe(true)
  })

  it('two proactives before anchor: still cuts at clicked task (not +2 slide)', () => {
    const baseTs = Date.now()
    const makeReal = (id: string, label: string, offsetMin: number) =>
      buildCompanionRecord({
        id: `sess_${id}`,
        timestamp: baseTs + offsetMin * 60 * 1000,
        userTask: label,
        messages: [
          { role: 'user', content: label },
          { role: 'assistant', content: `答${label}` }
        ],
        steps: [
          { id: `ut_${id}`, type: 'user_task', content: label, timestamp: baseTs + offsetMin * 60 * 1000 },
          { id: `fr_${id}`, type: 'final_result', content: `答${label}`, timestamp: baseTs + offsetMin * 60 * 1000 + 100 }
        ]
      })
    const makeProactive = (id: string, offsetMin: number) =>
      buildCompanionRecord({
        id: `sess_${id}`,
        timestamp: baseTs + offsetMin * 60 * 1000,
        userTask: '主动通知',
        messages: [],
        steps: [
          { id: `ut_${id}`, type: 'user_task', content: '__proactive__', timestamp: baseTs + offsetMin * 60 * 1000 },
          { id: `fr_${id}`, type: 'final_result', content: `通知${id}`, timestamp: baseTs + offsetMin * 60 * 1000 + 100 }
        ],
        proactive: true
      })

    // A → p1 → p2 → B → C；锚在 B：用户窗 A+B，补进窗口内 p1/p2，不含 C
    const records = [
      makeReal('a', 'A', 0),
      makeProactive('p1', 1),
      makeProactive('p2', 2),
      makeReal('b', 'B', 3),
      makeReal('c', 'C', 4)
    ]
    const result = Conversation.extractTaskFromRecords(records, 'sess_two_p', {
      anchorTaskStepId: 'ut_b'
    })!
    expect(result.record.userTask).toBe('B')
    expect(result.record.messages!.some(m => m.content === 'A')).toBe(true)
    expect(result.record.messages!.some(m => m.content === 'B')).toBe(true)
    expect(result.record.messages!.some(m => m.content === 'C')).toBe(false)
    expect(result.record.steps!.some(s => s.id === 'ut_p1')).toBe(true)
    expect(result.record.steps!.some(s => s.id === 'ut_p2')).toBe(true)
  })

  it('proactive immediately before first user turn is included (reply-to-notice)', () => {
    const baseTs = Date.now()
    const recP = buildCompanionRecord({
      id: 'sess_p',
      timestamp: baseTs,
      userTask: '主动通知',
      messages: [],
      steps: [
        { id: 'ut_p', type: 'user_task', content: '__proactive__', timestamp: baseTs },
        { id: 'fr_p', type: 'final_result', content: '监控到异动，要不要看？', timestamp: baseTs + 100 }
      ],
      proactive: true
    })
    const recOld = buildCompanionRecord({
      id: 'sess_old',
      timestamp: baseTs - 7 * 60 * 60 * 1000,
      userTask: '七小时前的闲聊',
      messages: [
        { role: 'user', content: '七小时前的闲聊' },
        { role: 'assistant', content: '嗯' }
      ],
      steps: [
        { id: 'ut_old', type: 'user_task', content: '七小时前的闲聊', timestamp: baseTs - 7 * 60 * 60 * 1000 },
        { id: 'fr_old', type: 'final_result', content: '嗯', timestamp: baseTs - 7 * 60 * 60 * 1000 + 100 }
      ]
    })
    const recReply = buildCompanionRecord({
      id: 'sess_r',
      timestamp: baseTs + 60 * 1000,
      userTask: '帮我看看',
      messages: [
        { role: 'user', content: '帮我看看' },
        { role: 'assistant', content: '好的' }
      ],
      steps: [
        { id: 'ut_r', type: 'user_task', content: '帮我看看', timestamp: baseTs + 60 * 1000 },
        { id: 'fr_r', type: 'final_result', content: '好的', timestamp: baseTs + 60 * 1000 + 100 }
      ]
    })
    const result = Conversation.extractTaskFromRecords([recOld, recP, recReply], 'sess_reply', {
      anchorTaskStepId: 'ut_r'
    })!
    // 6h 切断旧闲聊；紧挨首条用户话之前的通知保留
    expect(result.record.messages!.some(m => m.content === '七小时前的闲聊')).toBe(false)
    expect(result.record.userTask).toBe('帮我看看')
    expect(result.record.steps!.some(s => s.id === 'ut_p')).toBe(true)
    expect(result.record.messages!.some(m => m.content === '帮我看看')).toBe(true)
  })

  it('unknown anchorTaskStepId returns null (does not slide to latest)', () => {
    const rec = buildCompanionRecord({
      id: 'sess_c1',
      timestamp: 1000,
      userTask: '问题A',
      messages: [
        { role: 'user', content: '问题A' },
        { role: 'assistant', content: '回答A' }
      ],
      steps: [
        { id: 'ut_a', type: 'user_task', content: '问题A', timestamp: 1000 },
        { id: 'fr_a', type: 'final_result', content: '回答A', timestamp: 1100 }
      ]
    })
    const rec2 = buildCompanionRecord({
      id: 'sess_c2',
      timestamp: 2000,
      userTask: '问题B',
      messages: [
        { role: 'user', content: '问题B' },
        { role: 'assistant', content: '回答B' }
      ],
      steps: [
        { id: 'ut_b', type: 'user_task', content: '问题B', timestamp: 2000 },
        { id: 'fr_b', type: 'final_result', content: '回答B', timestamp: 2100 }
      ]
    })
    // 旧逻辑：stepId 找不到 → clamp 到最后一条 → 悄悄带上 B
    const result = Conversation.extractTaskFromRecords([rec, rec2], 'sess_miss', {
      anchorTaskStepId: 'ut_not_on_disk',
      anchorTaskIndex: 0
    })
    expect(result).toBeNull()
  })

  it('proactive_notice after final_result is its own anchor (not previous user_task)', () => {
    // 回归：磁盘里 notice 无独立 user_task，旧切段会并进「是不是可以不执行了」那一段
    const baseTs = Date.now()
    const recUser = buildCompanionRecord({
      id: 'sess_u',
      timestamp: baseTs,
      userTask: '是不是可以不执行了',
      messages: [
        { role: 'user', content: '是不是可以不执行了' },
        { role: 'assistant', content: '可以先停' }
      ],
      steps: [
        { id: 'ut_u', type: 'user_task', content: '是不是可以不执行了', timestamp: baseTs },
        { id: 'fr_u', type: 'final_result', content: '可以先停', timestamp: baseTs + 100 }
      ]
    })
    const recNotice: AgentRecord = {
      id: 'proactive-session',
      kind: 'companion',
      timestamp: baseTs + 60 * 1000,
      terminalId: '',
      agentKey: '__companion__',
      terminalType: 'assistant',
      userTask: '__proactive__',
      steps: [
        {
          id: 'proactive-xxx-notice',
          type: 'proactive_notice',
          content: '提醒：还有一件事',
          timestamp: baseTs + 60 * 1000
        }
      ],
      messages: [],
      duration: 0,
      status: 'completed'
    }
    const recLater = buildCompanionRecord({
      id: 'sess_later',
      timestamp: baseTs + 2 * 60 * 1000,
      userTask: '后面的问题',
      messages: [
        { role: 'user', content: '后面的问题' },
        { role: 'assistant', content: '后面的回答' }
      ],
      steps: [
        { id: 'ut_later', type: 'user_task', content: '后面的问题', timestamp: baseTs + 2 * 60 * 1000 },
        { id: 'fr_later', type: 'final_result', content: '后面的回答', timestamp: baseTs + 2 * 60 * 1000 + 100 }
      ]
    })

    const result = Conversation.extractTaskFromRecords(
      [recUser, recNotice, recLater],
      'sess_notice_anchor',
      { anchorTaskStepId: 'proactive-xxx-notice' }
    )!
    expect(result.record.userTask).toContain('提醒：还有一件事')
    expect(result.record.userTask).not.toContain('是不是可以不执行了')
    expect(result.record.messages!.some(m => m.content === '后面的问题')).toBe(false)
    expect(result.record.steps!.some(s => s.id === 'ut_later')).toBe(false)
  })

  it('sourceSteps from UI win over disk merge for cutoff', () => {
    const baseTs = Date.now()
    const diskOnly = buildCompanionRecord({
      id: 'sess_disk',
      timestamp: baseTs,
      userTask: '磁盘上的旧话',
      messages: [
        { role: 'user', content: '磁盘上的旧话' },
        { role: 'assistant', content: '旧答' }
      ],
      steps: [
        { id: 'ut_old', type: 'user_task', content: '磁盘上的旧话', timestamp: baseTs },
        { id: 'fr_old', type: 'final_result', content: '旧答', timestamp: baseTs + 100 },
        { id: 'ut_new', type: 'user_task', content: '屏幕上点的这句', timestamp: baseTs + 200 },
        { id: 'fr_new', type: 'final_result', content: '新答', timestamp: baseTs + 300 },
        { id: 'ut_after', type: 'user_task', content: '点完之后才有的', timestamp: baseTs + 400 },
        { id: 'fr_after', type: 'final_result', content: '不应带上', timestamp: baseTs + 500 }
      ]
    })
    // 前端只展示到「屏幕上点的这句」（不含 after）
    const sourceSteps = diskOnly.steps!.slice(0, 4)
    const result = Conversation.extractTaskFromRecords([diskOnly], 'sess_ui', {
      anchorTaskStepId: 'ut_new',
      sourceSteps
    })!
    expect(result.record.userTask).toBe('屏幕上点的这句')
    expect(result.record.steps!.some(s => s.id === 'ut_after')).toBe(false)
    expect(result.record.messages!.some(m => m.content === '点完之后才有的')).toBe(false)
  })

  it('appends titleSuffix to userTask', () => {
    const rec = buildCompanionRecord({
      id: 'sess_c1',
      timestamp: 1000,
      userTask: '原始问题',
      messages: [
        { role: 'user', content: '原始问题' },
        { role: 'assistant', content: '回答' }
      ],
      steps: [{ id: 'ut1', type: 'user_task', content: '原始问题', timestamp: 1000 }]
    })

    const result = Conversation.extractTaskFromRecords([rec], 'sess_x', { titleSuffix: ' · 分支' })!
    expect(result.record.userTask).toBe('原始问题 · 分支')
  })

  it('preserves toolCallId through stepRecord → step → stepRecord round-trip', () => {
    // 回归测试:原 Agent.buildForkRecord 漏了 toolCallId,且 stepRecordToStep 也漏,
    // 导致 fork 产物的 tool_result steps 丢失配对钥匙。修复后必须透传。
    const rec = buildCompanionRecord({
      id: 'sess_c1',
      timestamp: 1000,
      userTask: '工具调用任务',
      messages: [
        { role: 'user', content: '工具调用任务' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'call_x1', type: 'function', function: { name: 'fake_tool', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call_x1', content: '工具结果' },
        { role: 'assistant', content: '完成' }
      ],
      steps: [
        { id: 'ut1', type: 'user_task', content: '工具调用任务', timestamp: 1000 },
        { id: 'tr1', type: 'tool_result', content: '工具结果', toolName: 'fake_tool', toolCallId: 'call_x1', timestamp: 1100 }
      ]
    })

    const result = Conversation.extractTaskFromRecords([rec], 'sess_fork_toolcallid')!
    const toolResultSteps = result.record.steps!.filter(s => s.type === 'tool_result')
    expect(toolResultSteps.length).toBe(1)
    expect(toolResultSteps[0].toolCallId).toBe('call_x1') // 关键:toolCallId 必须保留
  })
})

describe('AgentService.extractTaskFromCompanion', () => {
  it('returns null when historyService is not available', async () => {
    const ai = { chatWithToolsStream: vi.fn(), abort: vi.fn() } as any
    const pty = { onData: vi.fn().mockReturnValue(() => {}), write: vi.fn() } as any
    const service = new AgentService(ai, pty)
    // 不调 setHistoryService → historyService / companion 都未装配
    const result = await service.extractTaskFromCompanion({
      newAgentId: 'new-id'
    })
    expect(result).toBeNull()
  })

  it('returns null when no companion records exist', async () => {
    const ai = { chatWithToolsStream: vi.fn(), abort: vi.fn() } as any
    const pty = { onData: vi.fn().mockReturnValue(() => {}), write: vi.fn() } as any
    const service = new AgentService(ai, pty)
    const historyService = {
      getAgentRecordStore: vi.fn(() => historyService),
      getRecentRecordsByAgentKey: vi.fn().mockReturnValue([]),
      saveAgentRecord: vi.fn()
    }
    service.setHistoryService(historyService as any)

    const result = await service.extractTaskFromCompanion({
      newAgentId: 'new-id'
    })
    expect(result).toBeNull()
  })

  it('不把联络的交接检查点带进新任务，历史留在工作记忆里', () => {
    const rec = buildCompanionRecord({
      id: 'sess_c1',
      timestamp: 1000,
      userTask: '早段问题',
      messages: [
        { role: 'user', content: '早段问题' },
        { role: 'assistant', content: '早段回答' }
      ],
      steps: [
        { id: 'ut1', type: 'user_task', content: '早段问题', timestamp: 1000 },
        { id: 'fr1', type: 'final_result', content: '早段回答', timestamp: 1100 }
      ]
    })
    rec.workingContext = [
      { role: 'system', content: '联络当时的系统提示' },
      { role: 'user', content: '早段问题' }
    ]
    rec.compressedArchives = [{
      id: 'arc1',
      messages: [{ role: 'user', content: '已压掉的原文' }],
      summary: '旧归档',
      timestamp: 900
    }]

    const result = Conversation.extractTaskFromRecords([rec], 'sess_no_prefix')!

    expect(result.record.workingContext).toBeUndefined()
    expect(result.record.compressedArchives).toBeUndefined()
    expect(result.conversation.getCachePrefix()).toBeUndefined()
    expect(result.conversation.hasHandoff()).toBe(false)
    expect(result.conversation.taskMemory.getTaskCount()).toBe(1)
  })

  it('end-to-end: merges companion records, saves new task record, creates new agent without cache prefix', async () => {
    const ai = { chatWithToolsStream: vi.fn(), abort: vi.fn() } as any
    const pty = { onData: vi.fn().mockReturnValue(() => {}), write: vi.fn() } as any
    const service = new AgentService(ai, pty)

    const savedRecords: AgentRecord[] = []
    const historyService = {
      getAgentRecordStore: vi.fn(() => historyService),
      getRecentRecordsByAgentKey: vi.fn().mockReturnValue([
        buildCompanionRecord({
          id: 'sess_c1',
          timestamp: 1000,
          userTask: 'companion 任务',
          messages: [
            { role: 'user', content: 'companion 任务' },
            { role: 'assistant', content: 'companion 回答' }
          ],
          steps: [
            { id: 'ut1', type: 'user_task', content: 'companion 任务', timestamp: 1000 },
            { id: 'fr1', type: 'final_result', content: 'companion 回答', timestamp: 1100 }
          ]
        })
      ]),
      saveAgentRecord: vi.fn((r: AgentRecord) => { savedRecords.push(r) }),
      getAgentRecordById: vi.fn()
    }
    service.setHistoryService(historyService as any)

    const result = await service.extractTaskFromCompanion({
      newAgentId: 'new-extracted',
      titleSuffix: ' · 分支'
    })

    expect(result).not.toBeNull()
    expect(result!.newAgentId).toBe('new-extracted')
    expect(result!.sourceUserTask).toBe('companion 任务 · 分支')
    expect(savedRecords.length).toBe(1)
    expect(savedRecords[0].id).toBe(result!.newSessionId)
    expect(savedRecords[0].kind).toBe('task') // 异质转化：产物是 task，不是 companion
    expect(savedRecords[0].messages!.length).toBe(2)

    // 新 Agent 应已创建（createAssistantAgent 注册到 agents map）
    const newAgent = service.getAgent('new-extracted')
    expect(newAgent).toBeTruthy()
    // 不把存档当成上一轮请求，继续说时才会冷启动
    expect((newAgent as any)._previousRunMessages).toBeUndefined()
    expect(savedRecords[0].workingContext).toBeUndefined()
  })
})
