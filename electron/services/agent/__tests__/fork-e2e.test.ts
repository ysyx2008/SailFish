/**
 * Fork 端到端测试：真实 Agent.run() → fork → 新 Agent 续聊
 *
 * 目的：钉死 fork 重构后的端到端语义不变量——
 *   ① 源 Agent 跑真实 run() 产生会话 → forkTask 产新会话 → 新 Agent 续聊能命中 cache prefix
 *   ② fork 产物的 kind 恒为 'task'（脱离源 kind）
 *   ③ toolCallId 经 fork 透传到新会话的 steps（stepRecord→step→stepRecord 往返不丢）
 *   ④ 截断 fork（untilTaskCount）只保留前 N 个 task，新 Agent 续聊不带截断后的内容
 *   ⑤ companion extractTask 端到端：N 条 companion record → 合并 → 新 task 续聊时冷启动一次
 *
 * 与 fork.test.ts 的区别：那个文件用 injectSession 注入数据 + mock fs，测的是 fork 逻辑本身；
 * 本文件用真实 HistoryService 写盘 + 真实 ConversationManager + 真实 run()，测的是「跑通」。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { ConversationManager, ConversationStore } from '../../conversation'

let tmpDir: string

// 捕获每次 LLM 调用传入的 messages，用于断言 cache prefix 是否复用
let messagesByCall: any[][] = []

type LlmResponse = { content?: string; reasoning_content?: string; tool_calls?: any[] }
type Responder = (callIndex: number) => LlmResponse

// 只 mock electron（userData → 临时目录），不 mock fs，让 HistoryService 真实写盘
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

import { Agent } from '../agent'
import { AgentService } from '../index'
import { HistoryService } from '../../history.service'
import type { ToolDefinition } from '../../ai.service'
import type { AgentContext, AgentServices } from '../types'

class TestAgent extends Agent {
  getAvailableTools(): ToolDefinition[] {
    return []
  }
  protected buildSystemPrompt(): string {
    return 'test system prompt'
  }
  protected getAgentId(): string {
    return 'test-agent'
  }
}

function makeServices(history: HistoryService, responder: Responder): AgentServices {
  let callIndex = 0
  return {
    aiService: {
      chatWithToolsStream: vi.fn(
        (messages: any[], _t: unknown, onChunk: (s: string) => void, _otc: unknown, onDone: (r: unknown) => void) => {
          messagesByCall.push(JSON.parse(JSON.stringify(messages)))
          const r = responder(callIndex++)
          const content = r.content ?? '好的'
          if (content) onChunk(content)
          onDone({ content, reasoning_content: r.reasoning_content, tool_calls: r.tool_calls })
          return Promise.resolve()
        }
      ),
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
      hasVisionCapability: vi.fn().mockReturnValue(true)
    } as any,
    historyService: history as any,
    conversationManager: new ConversationManager(new ConversationStore(history.getAgentRecordStore()))
  }
}

function ctx(overrides?: Partial<AgentContext>): AgentContext {
  return {
    terminalOutput: [],
    systemInfo: { os: 'darwin', shell: '/bin/zsh' },
    terminalType: 'assistant',
    ...overrides
  } as AgentContext
}

describe('Fork 端到端（真实 run() + 真实磁盘写盘）', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-fork-e2e-'))
    messagesByCall = []
  })
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('① task fork：源 Agent run → forkTask → 新 Agent 续聊命中 cache prefix', async () => {
    const history = new HistoryService()
    const services = makeServices(history, () => ({ content: '源回答' }))
    const agentService = new AgentService(services.aiService, services.ptyService)
    agentService.setHistoryService(history)

    // 源 Agent 跑一次真实 run，产生会话
    const srcAgent = agentService.createAssistantAgent('src-tab') as unknown as TestAgent
    Object.setPrototypeOf(srcAgent, TestAgent.prototype)
    // 注入 services（createAssistantAgent 用的是默认 services，这里覆盖关键依赖）
    ;(srcAgent as any).services = services

    await srcAgent.run('源问题', ctx({ sessionId: 'sess_src' }))

    // 验证源会话已写盘
    const srcRecord = history.getAgentRecordById('sess_src')
    expect(srcRecord).toBeTruthy()
    expect(srcRecord!.kind).toBe('task')
    expect(srcRecord!.messages!.length).toBeGreaterThanOrEqual(2)

    // fork（全量，不截断）
    const forkResult = await agentService.forkTask({
      sourceAgentKey: 'src-tab',
      newAgentId: 'forked-tab',
      titleSuffix: ' · 分支'
    })
    expect(forkResult).not.toBeNull()
    expect(forkResult!.newRecord.kind).toBe('task') // ② fork 产物恒为 task
    expect(forkResult!.newRecord.userTask).toContain('源问题')
    expect(forkResult!.newRecord.userTask).toContain('分支')
    expect(forkResult!.newRecord.messages!.length).toBe(srcRecord!.messages!.length)

    // fork 产物已写盘（新 sessionId）
    const forkedRecord = history.getAgentRecordById(forkResult!.newSessionId)
    expect(forkedRecord).toBeTruthy()
    expect(forkedRecord!.kind).toBe('task')

    // 新 Agent 续聊：首次 run 应复用 cache prefix（fork 时注入的 previousRunMessages）
    const forkedAgent = agentService.getAgent('forked-tab') as unknown as TestAgent
    Object.setPrototypeOf(forkedAgent, TestAgent.prototype)
    ;(forkedAgent as any).services = services

    messagesByCall = [] // 清空，只看续聊这次
    await forkedAgent.run('续聊问题', ctx())

    // 续聊的 messages 应包含 fork 出来的历史（cache prefix 命中）
    expect(messagesByCall.length).toBeGreaterThanOrEqual(1)
    const continuationMessages = messagesByCall[0]
    // 应能找到源会话的内容（cache prefix 携带）
    const allContent = JSON.stringify(continuationMessages)
    expect(allContent).toContain('源问题')
    expect(allContent).toContain('源回答')
  })

  it('② task fork 截断：untilTaskCount=1 只保留第一个 task，续聊不带后续内容', async () => {
    const history = new HistoryService()
    // 三轮对话，每轮不同回答便于区分
    const responses = ['第一轮回答', '第二轮回答', '第三轮回答']
    const services = makeServices(history, (i) => ({ content: responses[i] ?? '续聊回答' }))
    const agentService = new AgentService(services.aiService, services.ptyService)
    agentService.setHistoryService(history)

    const srcAgent = agentService.createAssistantAgent('src-trunc') as unknown as TestAgent
    Object.setPrototypeOf(srcAgent, TestAgent.prototype)
    ;(srcAgent as any).services = services

    // 跑三轮，产生 3 个 task
    await srcAgent.run('第一个问题', ctx({ sessionId: 'sess_trunc_src' }))
    await srcAgent.run('第二个问题', ctx())
    await srcAgent.run('第三个问题', ctx())

    const srcRecord = history.getAgentRecordById('sess_trunc_src')
    expect(srcRecord).toBeTruthy()
    // 3 个 task = 6 messages（3 user + 3 assistant）
    expect(srcRecord!.messages!.length).toBe(6)

    // 截断 fork：只保留第 1 个 task
    const forkResult = await agentService.forkTask({
      sourceAgentKey: 'src-trunc',
      newAgentId: 'forked-trunc',
      untilTaskCount: 1
    })
    expect(forkResult).not.toBeNull()
    expect(forkResult!.newRecord.messages!.length).toBe(2) // 1 user + 1 assistant

    // 截断后不应包含第 2、3 个 task 的内容
    const forkedContent = JSON.stringify(forkResult!.newRecord.messages)
    expect(forkedContent).toContain('第一个问题')
    expect(forkedContent).toContain('第一轮回答')
    expect(forkedContent).not.toContain('第二个问题')
    expect(forkedContent).not.toContain('第三个问题')

    // 新 Agent 续聊：cache prefix 应只含第 1 个 task
    const forkedAgent = agentService.getAgent('forked-trunc') as unknown as TestAgent
    Object.setPrototypeOf(forkedAgent, TestAgent.prototype)
    ;(forkedAgent as any).services = services

    messagesByCall = []
    await forkedAgent.run('续聊', ctx())

    const continuationContent = JSON.stringify(messagesByCall[0])
    expect(continuationContent).toContain('第一个问题')
    expect(continuationContent).not.toContain('第二个问题')
    expect(continuationContent).not.toContain('第三个问题')
  })

  it('③ toolCallId 透传：源会话含工具调用 → fork 后新会话 steps 保留 toolCallId', async () => {
    const history = new HistoryService()
    // 第一轮触发工具调用，第二轮纯文本
    const services = makeServices(history, (i) => {
      if (i === 0) {
        return {
          content: '',
          tool_calls: [{ id: 'call_e2e_1', type: 'function', function: { name: 'fake_tool', arguments: '{}' } }]
        }
      }
      return { content: '工具完成后的回答' }
    })
    const agentService = new AgentService(services.aiService, services.ptyService)
    agentService.setHistoryService(history)

    const srcAgent = agentService.createAssistantAgent('src-tool') as unknown as TestAgent
    Object.setPrototypeOf(srcAgent, TestAgent.prototype)
    ;(srcAgent as any).services = services

    await srcAgent.run('调用工具', ctx({ sessionId: 'sess_tool_src' }))

    const srcRecord = history.getAgentRecordById('sess_tool_src')
    expect(srcRecord).toBeTruthy()
    // 源会话应有 tool_result step（工具调用失败也会产生 tool_result）
    const srcToolResults = srcRecord!.steps!.filter(s => s.type === 'tool_result')
    expect(srcToolResults.length).toBeGreaterThanOrEqual(1)

    // fork
    const forkResult = await agentService.forkTask({
      sourceAgentKey: 'src-tool',
      newAgentId: 'forked-tool'
    })
    expect(forkResult).not.toBeNull()

    // ③ fork 产物的 tool_result steps 必须保留 toolCallId
    const forkedToolResults = forkResult!.newRecord.steps!.filter(s => s.type === 'tool_result')
    expect(forkedToolResults.length).toBeGreaterThanOrEqual(1)
    for (const s of forkedToolResults) {
      expect(s.toolCallId).toBeDefined()
      expect(s.toolCallId).not.toBe('')
    }
    // 应能找到源会话那个 tool_call id
    expect(forkedToolResults.some(s => s.toolCallId === 'call_e2e_1')).toBe(true)

    // 写盘后再读出来，toolCallId 仍在（验证序列化往返）
    const forkedRecord = history.getAgentRecordById(forkResult!.newSessionId)
    expect(forkedRecord).toBeTruthy()
    const diskToolResults = forkedRecord!.steps!.filter(s => s.type === 'tool_result')
    expect(diskToolResults.some(s => s.toolCallId === 'call_e2e_1')).toBe(true)
  })

  it('④ companion extractTask：N 条 companion record → 合并 → 新 task Agent 续聊', async () => {
    const history = new HistoryService()

    // 手动写两条 companion record 到磁盘（模拟 companion 关系线的多 record 形态）
    const baseTs = Date.now() - 10000
    const rec1 = {
      id: 'sess_c1',
      kind: 'companion' as const,
      timestamp: baseTs,
      terminalId: '',
      agentKey: '__companion__',
      terminalType: 'assistant' as const,
      userTask: '早段对话',
      steps: [
        { id: 'ut1', type: 'user_task', content: '早段对话', timestamp: baseTs },
        { id: 'fr1', type: 'final_result', content: '早段回答', timestamp: baseTs + 100 }
      ],
      messages: [
        { role: 'user', content: '早段对话' },
        { role: 'assistant', content: '早段回答' }
      ],
      duration: 0,
      status: 'completed' as const
    }
    const rec2 = {
      id: 'sess_c2',
      kind: 'companion' as const,
      timestamp: baseTs + 2000,
      terminalId: '',
      agentKey: '__companion__',
      terminalType: 'assistant' as const,
      userTask: '晚段对话',
      steps: [
        { id: 'ut2', type: 'user_task', content: '晚段对话', timestamp: baseTs + 2000 },
        { id: 'fr2', type: 'final_result', content: '晚段回答', timestamp: baseTs + 2100 }
      ],
      messages: [
        { role: 'user', content: '晚段对话' },
        { role: 'assistant', content: '晚段回答' }
      ],
      duration: 0,
      status: 'completed' as const
    }
    history.saveAgentRecord(rec1)
    history.saveAgentRecord(rec2)

    const services = makeServices(history, () => ({ content: '抽取后续聊回答' }))
    const agentService = new AgentService(services.aiService, services.ptyService)
    agentService.setHistoryService(history)

    // extractTask：锚点在第 0 个 task（早段），向前无连续 → 只带早段
    const result = await agentService.extractTaskFromCompanion({
      newAgentId: 'extracted-tab',
      anchorTaskIndex: 0,
      titleSuffix: ' · 抽取'
    })
    expect(result).not.toBeNull()
    expect(result!.newRecord.kind).toBe('task') // 异质转化：产物是 task
    expect(result!.newRecord.userTask).toBe('早段对话 · 抽取')
    // 截断到第 1 个 task → 只含早段
    expect(result!.newRecord.messages!.length).toBe(2)
    expect(result!.newRecord.messages![0].content).toBe('早段对话')

    // 回归：fork 产物的 agentKey 必须绑定到新 Agent，不能继承源 companion 的 '__companion__'。
    // 否则 listAgentHistorySummaries(excludeWakeup=true) 会把这条 task 误判为联络会话过滤掉，
    // 前端 pruneConversationMetadata 随之删除其自定义标题（用户重命名丢失）。
    expect(result!.newRecord.agentKey).toBe('extracted-tab')
    const persisted = history.getAgentRecordById(result!.newSessionId)
    expect(persisted?.agentKey).toBe('extracted-tab')

    // 新 Agent 续聊
    const extractedAgent = agentService.getAgent('extracted-tab') as unknown as TestAgent
    Object.setPrototypeOf(extractedAgent, TestAgent.prototype)
    ;(extractedAgent as any).services = services

    messagesByCall = []
    await extractedAgent.run('续聊', ctx())

    // 续聊冷启动：重新组系统提示，早段当历史装上，不含晚段
    const sent = messagesByCall[0]
    expect(sent[0].role).toBe('system')
    expect(sent[0].content).toContain('test system prompt')
    const content = JSON.stringify(sent)
    expect(content).toContain('早段对话')
    expect(content).not.toContain('晚段对话')

    // 回归：续聊 checkpoint 落盘后 agentKey 仍是新 Agent，不被 companion 污染
    const afterRun = history.getAgentRecordById(result!.newSessionId)
    expect(afterRun?.agentKey).toBe('extracted-tab')
  })
})
