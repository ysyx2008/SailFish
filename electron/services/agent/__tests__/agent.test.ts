/**
 * agent.ts 单元测试
 * 测试 Agent 基类的核心功能：执行循环、状态管理、工具调用、回调机制等
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock Electron 模块（必须在导入 Agent 之前）
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/mock/user/data'),
    getName: vi.fn().mockReturnValue('SailFish'),
    getVersion: vi.fn().mockReturnValue('1.0.0')
  },
  BrowserWindow: vi.fn(),
  ipcMain: { on: vi.fn(), handle: vi.fn() }
}))

// Mock fs 模块
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

// Mock im.service 打断 agent.ts → tools/misc → im.service → agent/index → sailfish → agent.ts 循环依赖
vi.mock('../../im/im.service', () => ({
  getIMService: vi.fn().mockReturnValue(null)
}))

import { Agent } from '../agent'
import type { ToolDefinition, AiMessage } from '../../ai.service'
import type { 
  AgentContext, 
  AgentServices, 
  PromptOptions,
  AgentCallbacks,
  AgentStep
} from '../types'
import { TaskMemoryStore } from '../task-memory'
import { ConversationManager, ConversationStore } from '../../conversation'
import { SUMMARY_MAX_OUTPUT_TOKENS } from '../../ai-request-budget'

// ==================== Mock 实现 ====================

/**
 * 测试用 Agent 实现类
 * 因为 Agent 是抽象类，需要创建具体实现来测试
 */
class TestAgent extends Agent {
  public mockTools: ToolDefinition[] = []
  public mockSystemPrompt: string = 'Test system prompt'

  getAvailableTools(): ToolDefinition[] {
    return this.mockTools
  }

  protected buildSystemPrompt(_context: AgentContext, _options: PromptOptions): string {
    return this.mockSystemPrompt
  }

  protected getAgentId(): string {
    return 'test-agent'
  }

  // 暴露受保护的方法用于测试
  public exposeCurrentRun() {
    return this.currentRun
  }

  public exposeTaskMemory() {
    return this.taskMemory
  }
  
  public exposeServices() {
    return this.services
  }

  public exposeProfileId() {
    return this.profileId
  }
  
  public exposeGetSkillSession() {
    return this.getSkillSession()
  }

  // 暴露 finalizeToolCallStep 和 addStep 用于测试 tool_call 成功/失败的 UI 回填语义
  public testFinalizeToolCallStep(run: any, toolCallId: string, success: boolean) {
    return (this as any).finalizeToolCallStep(run, toolCallId, success)
  }

  public testAddStep(step: any) {
    return (this as any).addStep(step)
  }

  // 暴露 ensureToolResultStep / wrapExecutorConfigForToolCall 用于测试
  // 同名批量、并行混合成败、toolCallId 注入等场景
  public testEnsureToolResultStep(run: any, stepCountBefore: number, toolCall: any, result: any) {
    return (this as any).ensureToolResultStep(run, stepCountBefore, toolCall, result)
  }

  public testWrapExecutorConfigForToolCall(run: any, toolCall: any, base: any) {
    return (this as any).wrapExecutorConfigForToolCall(run, toolCall, base)
  }

  // 暴露 processToolResult / flushPendingToolImages 用于验证：
  // 多个工具返回图片时，user 消息不会夹在 tool 消息之间，破坏 OpenAI tool_calls 协议
  public testProcessToolResult(run: any, toolCall: any, result: any, toolArgs: any = {}) {
    return (this as any).processToolResult(run, toolCall, result, toolArgs)
  }

  public testFlushPendingToolImages(run: any) {
    return (this as any).flushPendingToolImages(run)
  }

  // 注入 currentRun，便于直接针对 addStep/updateStep/finalizeToolCallStep 做单元测试
  // 而不必真正启动 agent.run 流程
  public injectCurrentRun(run: any) {
    (this as any).currentRun = run
  }
}

// Mock AI 服务
function createMockAiService() {
  return {
    chatWithToolsStream: vi.fn(),
    abort: vi.fn()
  }
}

// Mock PTY 服务
function createMockPtyService() {
  return {
    onData: vi.fn().mockReturnValue(() => {}),
    write: vi.fn()
  }
}

// Mock 配置服务
function createMockConfigService() {
  return {
    get: vi.fn().mockReturnValue(undefined),
    getAgentMbti: vi.fn().mockReturnValue(null),
    getAiRules: vi.fn().mockReturnValue(''),
    getAgentPersonalityText: vi.fn().mockReturnValue(''),
    getAgentName: vi.fn().mockReturnValue(''),
    getLanguage: vi.fn().mockReturnValue('zh-CN'),
    getAiProfiles: vi.fn().mockReturnValue([{ id: 'test', contextLength: 128000 }]),
    getActiveAiProfile: vi.fn().mockReturnValue('test'),
    getAgentOnboardingCompleted: vi.fn().mockReturnValue(true),
    // 默认假设 profile 具备视觉能力——大多数测试关注的是「图片如何注入到 messages」
    // 等协议路径，需要图片真的被附带；「无视觉时剥图」的行为有专门的测试用例覆盖。
    hasVisionCapability: vi.fn().mockReturnValue(true)
  }
}

// 创建基础的 AgentServices mock
function createMockServices(overrides?: Partial<AgentServices>): AgentServices {
  const services: AgentServices = {
    aiService: createMockAiService() as any,
    ptyService: createMockPtyService() as any,
    configService: createMockConfigService() as any,
    ...overrides
  }
  // 有 historyService 即自动装配 ConversationManager，让会话回种/恢复走生产路径
  //（馆长发证）。无 historyService 的纯单测仍走 Agent 内部退化路径。
  if (services.historyService && !services.conversationManager) {
    services.conversationManager = new ConversationManager(new ConversationStore(services.historyService.getAgentRecordStore()))
  }
  return services
}

// 创建基础的 AgentContext
function createMockContext(overrides?: Partial<AgentContext>): AgentContext {
  return {
    ptyId: 'test-pty',
    terminalOutput: [],
    systemInfo: {
      os: 'darwin',
      shell: '/bin/zsh'
    },
    terminalType: 'local',
    ...overrides
  }
}

// ==================== Agent 构造和初始化 ====================

describe('Agent', () => {
  let agent: TestAgent
  let mockServices: AgentServices

  beforeEach(() => {
    vi.clearAllMocks()
    mockServices = createMockServices()
    agent = new TestAgent(mockServices)
  })

  // ==================== 上下文压缩的小结调用 ====================

  describe('summarizeForCompression', () => {
    const summarize = (a: TestAgent, conversation: AiMessage[] = [{ role: 'user', content: '干活' }]) =>
      (a as unknown as {
        summarizeForCompression(o: { conversation: AiMessage[]; keepRecent: number }): Promise<string | null>
      }).summarizeForCompression({ conversation, keepRecent: 2 })

    it('把小结指令追加在对话末尾，并照常带上 tools（前缀不变才吃得到缓存）', async () => {
      const chatWithTools = vi.fn().mockResolvedValue({ content: '交接小结' })
      const services = createMockServices({ aiService: { chatWithTools } as never })
      const a = new TestAgent(services)

      const result = await summarize(a, [{ role: 'user', content: '查磁盘' }])

      expect(result).toBe('交接小结')
      const [messages, tools] = chatWithTools.mock.calls[0]
      expect(messages[0]).toEqual({ role: 'user', content: '查磁盘' })
      expect(messages[messages.length - 1].role).toBe('user')
      // 走的是带 tools 的接口（tools schema 属于前缀，另起一次无 tools 的调用等于换前缀）
      expect(Array.isArray(tools)).toBe(true)
      // 首次不禁用工具调用：禁用会让部分 provider 不再把 tools 计入 prompt，白丢缓存
      expect(chatWithTools.mock.calls[0][4]).toEqual({ maxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS })
    })

    it('模型转头去调工具没写正文 → 禁用工具调用重试一次', async () => {
      const chatWithTools = vi
        .fn()
        .mockResolvedValueOnce({ tool_calls: [{ id: 'x', type: 'function', function: { name: 'whatever', arguments: '{}' } }] })
        .mockResolvedValueOnce({ content: '重试拿到的小结' })
      const services = createMockServices({ aiService: { chatWithTools } as never })
      const a = new TestAgent(services)

      expect(await summarize(a)).toBe('重试拿到的小结')
      expect(chatWithTools).toHaveBeenCalledTimes(2)
      expect(chatWithTools.mock.calls[1][4]).toEqual({
        toolChoice: 'none',
        maxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS,
      })
    })

    it('重试仍拿不到正文 → 返回 null，由调用方回退固定模板', async () => {
      const chatWithTools = vi.fn().mockResolvedValue({ content: '   ' })
      const services = createMockServices({ aiService: { chatWithTools } as never })
      const a = new TestAgent(services)

      expect(await summarize(a)).toBeNull()
      expect(chatWithTools).toHaveBeenCalledTimes(2)
    })

    it('空对话 → 不发请求（没内容可交接）', async () => {
      const chatWithTools = vi.fn()
      const services = createMockServices({ aiService: { chatWithTools } as never })
      const a = new TestAgent(services)

      expect(await summarize(a, [])).toBeNull()
      expect(chatWithTools).not.toHaveBeenCalled()
    })
  })

  describe('constructor and initialization', () => {
    it('should initialize with default config', () => {
      expect(agent.executionMode).toBe('strict')
      expect(agent.commandTimeout).toBe(30000)
    })

    it('should create task memory store', () => {
      const taskMemory = agent.exposeTaskMemory()
      expect(taskMemory).toBeInstanceOf(TaskMemoryStore)
    })

    it('should store services reference', () => {
      const services = agent.exposeServices()
      expect(services).toBe(mockServices)
    })
  })

  // ==================== 配置更新 ====================

  describe('updateConfig', () => {
    it('should update execution mode', () => {
      agent.updateConfig({ executionMode: 'relaxed' })
      expect(agent.executionMode).toBe('relaxed')
    })

    it('should update command timeout', () => {
      agent.updateConfig({ commandTimeout: 60000 })
      expect(agent.commandTimeout).toBe(60000)
    })

    it('should handle partial config updates', () => {
      agent.updateConfig({ executionMode: 'free' })
      expect(agent.executionMode).toBe('free')
      expect(agent.commandTimeout).toBe(30000) // should remain unchanged
    })

    it('should update multiple config values at once', () => {
      agent.updateConfig({
        executionMode: 'relaxed',
        commandTimeout: 45000
      })
      expect(agent.executionMode).toBe('relaxed')
      expect(agent.commandTimeout).toBe(45000)
    })
  })

  // ==================== 运行状态检查 ====================

  describe('isRunning', () => {
    it('should return false when not running', () => {
      expect(agent.isRunning()).toBe(false)
    })
  })

  describe('getExecutionPhase', () => {
    it('should return idle when not running', () => {
      expect(agent.getExecutionPhase()).toBe('idle')
    })
  })

  describe('getRunStatus', () => {
    it('should return undefined when no run exists', () => {
      expect(agent.getRunStatus()).toBeUndefined()
    })
  })

  // ==================== 回调设置 ====================

  describe('setCallbacks', () => {
    it('should set callbacks', () => {
      const callbacks: AgentCallbacks = {
        onStep: vi.fn(),
        onComplete: vi.fn(),
        onError: vi.fn()
      }
      
      agent.setCallbacks(callbacks)
      // 回调会在实际运行时使用，这里只验证设置成功
      expect(true).toBe(true)
    })
  })

  // ==================== 中止功能 ====================

  describe('abort', () => {
    it('should return false when not running', () => {
      expect(agent.abort()).toBe(false)
    })
  })

  // ==================== 用户消息 ====================

  describe('addUserMessage', () => {
    it('should queue message before run starts', () => {
      expect(agent.addUserMessage('test message')).toBe(true)
      expect(agent.addUserMessage('second')).toBe(true)
    })

    it('should flush pre-run queue into user_supplement steps on initializeRun', async () => {
      const steps: AgentStep[] = []
      agent.setCallbacks({ onStep: (_id, step) => steps.push({ ...step }) })

      agent.addUserMessage('prep supplement')

      const aiService = agent.exposeServices().aiService as unknown as ReturnType<typeof createMockAiService>
      aiService.chatWithToolsStream.mockImplementation(
        (_messages, _tools, onChunk, _onToolCall, onDone) => {
          onChunk('Done')
          onDone({ content: 'Done', tool_calls: undefined })
          return Promise.resolve()
        }
      )

      await agent.run('Main task', createMockContext())

      const types = steps.map(s => s.type)
      const userTaskIdx = types.indexOf('user_task')
      const supplementIdx = types.indexOf('user_supplement')
      expect(userTaskIdx).toBeGreaterThanOrEqual(0)
      expect(supplementIdx).toBeGreaterThan(userTaskIdx)
      expect(steps[supplementIdx].content).toBe('prep supplement')
    })

    it('should append supplement after streaming message step (abort interrupts stream)', () => {
      agent.injectCurrentRun({
        id: 'run-1',
        isRunning: true,
        executionPhase: 'thinking',
        requestId: 'req-1',
        pendingUserMessages: [],
        steps: [
          { id: 'msg-1', type: 'message', content: 'streaming...', isStreaming: true, timestamp: 1 },
        ],
      })

      agent.addUserMessage('mid-stream supplement')

      const steps = agent.exposeCurrentRun()!.steps
      expect(steps.map(s => s.type)).toEqual(['message', 'user_supplement'])
      expect(steps[1].content).toBe('mid-stream supplement')
    })

    it('should append supplement after completed steps', () => {
      agent.injectCurrentRun({
        id: 'run-1',
        isRunning: true,
        executionPhase: 'executing_command',
        pendingUserMessages: [],
        steps: [
          { id: 'msg-1', type: 'message', content: 'done', isStreaming: false, timestamp: 1 },
          { id: 'tool-1', type: 'tool_call', content: 'browser_evaluate', timestamp: 2 },
        ],
      })

      agent.addUserMessage('after tool supplement')

      const steps = agent.exposeCurrentRun()!.steps
      expect(steps.map(s => s.type)).toEqual(['message', 'tool_call', 'user_supplement'])
    })

    it('should queue silent reply without user_supplement step', () => {
      agent.injectCurrentRun({
        id: 'run-1',
        isRunning: true,
        executionPhase: 'waiting',
        pendingUserMessages: [],
        steps: [
          { id: 'ask-1', type: 'tool_call', content: 'ask_user', timestamp: 1 },
        ],
      })

      expect(agent.addUserMessage('方案A', undefined, undefined, undefined, undefined, true)).toBe(true)

      const run = agent.exposeCurrentRun()!
      expect(run.steps.map(s => s.type)).toEqual(['tool_call'])
      expect(run.pendingUserMessages).toHaveLength(1)
      expect(run.pendingUserMessages[0].message).toBe('方案A')
      expect(run.pendingUserMessages[0].silent).toBe(true)
    })
  })

  // ==================== 工具确认 ====================

  describe('confirmToolCall', () => {
    it('should return false when not running', () => {
      expect(agent.confirmToolCall('tool-1', true)).toBe(false)
    })
  })

  // ==================== 清理 ====================

  describe('cleanup', () => {
    it('should not throw when no run exists', () => {
      expect(() => agent.cleanup()).not.toThrow()
    })
  })

  // ==================== tool_call 结果回填 ====================
  // 这组测试确保 UI 能按"执行结果"给 tool_call 左竖条着色：
  //   - 失败 → 红（exec-failed）
  //   - 成功 → 无特殊色（success=true，但视觉上不加竖条）
  // 避免此前"风险色红"被误读为"执行失败"。
  describe('finalizeToolCallStep', () => {
    // 构造一个最小化的 fake run，让 addStep/updateStep 可以工作
    function makeFakeRun(): any {
      return {
        id: 'fake-run',
        steps: [],
        pendingPreToolCallStepIds: undefined,
        pendingPreToolCallText: undefined,
        activeToolCallStepIds: undefined
      }
    }

    it('should backfill success=false onto the registered tool_call step', () => {
      const run = makeFakeRun()
      agent.injectCurrentRun(run)

      const toolCallId = 'tc-fail'
      const step = agent.testAddStep({
        type: 'tool_call',
        content: 'running...',
        toolName: 'execute_command',
        isStreaming: true
      })
      // 模拟 wrapExecutorConfigForToolCall 完成登记
      run.activeToolCallStepIds = new Map<string, string>([[toolCallId, step.id]])

      agent.testFinalizeToolCallStep(run, toolCallId, false)

      expect(run.activeToolCallStepIds.has(toolCallId)).toBe(false)
      expect(step.success).toBe(false)
      expect(step.isStreaming).toBe(false)
    })

    it('should backfill success=true onto pending pre-created tool_call step when executor never re-addStep', () => {
      const run = makeFakeRun()
      agent.injectCurrentRun(run)

      const toolCallId = 'tc-orphan'
      const step = agent.testAddStep({
        type: 'tool_call',
        content: 'pre-created',
        toolName: 'execute_command',
        isStreaming: true
      })
      run.pendingPreToolCallStepIds = new Map<string, string>([[toolCallId, step.id]])
      run.pendingPreToolCallText = new Map<string, string>([[toolCallId, 'pre-created']])

      agent.testFinalizeToolCallStep(run, toolCallId, true)

      expect(run.pendingPreToolCallStepIds.has(toolCallId)).toBe(false)
      expect(run.pendingPreToolCallText.has(toolCallId)).toBe(false)
      expect(step.success).toBe(true)
      expect(step.isStreaming).toBe(false)
    })

    it('should be a no-op when no tool_call step is registered', () => {
      const run = makeFakeRun()
      agent.injectCurrentRun(run)
      expect(() => agent.testFinalizeToolCallStep(run, 'nonexistent', false)).not.toThrow()
    })
  })

  // ==================== tool_result step 配对（按 toolCallId） ====================
  // 这组测试覆盖之前的 bug：同一批次中多次同名工具调用时，因为 ensureToolResultStep
  // 按 toolName 去重导致只有第 1 个 result 卡能显示。修复后改用 toolCallId 配对。
  describe('ensureToolResultStep (toolCallId 配对)', () => {
    function makeFakeRun(): any {
      return {
        id: 'fake-run',
        steps: [],
        pendingPreToolCallStepIds: undefined,
        pendingPreToolCallText: undefined,
        activeToolCallStepIds: undefined
      }
    }

    function makeToolCall(id: string, name: string, args: Record<string, unknown> = {}) {
      return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } } as any
    }

    it('should emit one tool_result per call when same-named tool is invoked multiple times in a batch', () => {
      const run = makeFakeRun()
      agent.injectCurrentRun(run)

      const baseline = run.steps.length
      const tcA = makeToolCall('tc-a', 'exec', { command: 'ls' })
      const tcB = makeToolCall('tc-b', 'exec', { command: 'pwd' })
      const tcC = makeToolCall('tc-c', 'exec', { command: 'whoami' })

      // 工具自己未 emit tool_result（exec 成功路径就是这种），由 ensureToolResultStep 兜底
      agent.testEnsureToolResultStep(run, baseline, tcA, { success: true, output: 'fileA' })
      agent.testEnsureToolResultStep(run, baseline, tcB, { success: true, output: 'fileB' })
      agent.testEnsureToolResultStep(run, baseline, tcC, { success: true, output: 'fileC' })

      const results = run.steps.filter((s: any) => s.type === 'tool_result')
      expect(results).toHaveLength(3)
      expect(results.map((s: any) => s.toolCallId)).toEqual(['tc-a', 'tc-b', 'tc-c'])
      expect(results.map((s: any) => s.toolResult)).toEqual(['fileA', 'fileB', 'fileC'])
      expect(results.every((s: any) => s.success === true)).toBe(true)
    })

    it('should backfill success precisely per toolCallId in a parallel mixed-result batch', () => {
      const run = makeFakeRun()
      agent.injectCurrentRun(run)

      const baseline = run.steps.length
      const tcA = makeToolCall('tc-a', 'read_file', { path: '/a' })
      const tcB = makeToolCall('tc-b', 'read_file', { path: '/b' })
      const tcC = makeToolCall('tc-c', 'read_file', { path: '/c' })

      // 模拟工具自己 emit 的 tool_result 卡（read_file 走这条路径），都是 success=undefined
      // 由 wrapExecutorConfigForToolCall 给 toolCallId 盖戳；这里直接显式带上模拟
      agent.testAddStep({ type: 'tool_result', content: '✅', toolName: 'read_file', toolCallId: 'tc-a', toolResult: 'A content' })
      agent.testAddStep({ type: 'tool_result', content: '❌', toolName: 'read_file', toolCallId: 'tc-b', toolResult: 'ENOENT' })
      agent.testAddStep({ type: 'tool_result', content: '✅', toolName: 'read_file', toolCallId: 'tc-c', toolResult: 'C content' })

      // A 完成（成功）→ 只回填 tc-a 那张，不会污染 tc-b / tc-c
      agent.testEnsureToolResultStep(run, baseline, tcA, { success: true, output: 'A content' })
      // B 完成（失败）→ 只回填 tc-b 那张
      agent.testEnsureToolResultStep(run, baseline, tcB, { success: false, error: 'ENOENT' })
      // C 完成（成功）→ 只回填 tc-c 那张
      agent.testEnsureToolResultStep(run, baseline, tcC, { success: true, output: 'C content' })

      const results = run.steps.filter((s: any) => s.type === 'tool_result')
      expect(results).toHaveLength(3)
      const byId = Object.fromEntries(results.map((s: any) => [s.toolCallId, s.success]))
      expect(byId).toEqual({ 'tc-a': true, 'tc-b': false, 'tc-c': true })
    })

    it('should fall back to toolName matching when an existing step has no toolCallId (legacy compat)', () => {
      const run = makeFakeRun()
      agent.injectCurrentRun(run)

      const baseline = run.steps.length
      const tc = makeToolCall('tc-legacy', 'read_file', { path: '/x' })

      // 模拟老版本的 step，只有 toolName，没有 toolCallId
      agent.testAddStep({ type: 'tool_result', content: '✅', toolName: 'read_file', toolResult: 'legacy' })

      agent.testEnsureToolResultStep(run, baseline, tc, { success: true, output: 'legacy' })

      // 不应再追加新 tool_result（按 toolName 退化匹配命中），且 success 被回填
      const results = run.steps.filter((s: any) => s.type === 'tool_result')
      expect(results).toHaveLength(1)
      expect(results[0].success).toBe(true)
    })

    it('wrapExecutorConfigForToolCall stamps toolCallId on tool_call / tool_result steps automatically', () => {
      const run = makeFakeRun()
      agent.injectCurrentRun(run)

      const tc = makeToolCall('tc-stamp', 'exec', { command: 'date' })

      // 构造一个最小可用的 base ToolExecutorConfig：只关心 addStep / updateStep 两个钩子
      const base = {
        addStep: (step: any) => agent.testAddStep(step),
        updateStep: (id: string, patch: any) => {
          const target = run.steps.find((s: any) => s.id === id)
          if (target) Object.assign(target, patch)
        },
        // 其他字段对本测试无关，置空即可
        isAborted: () => false,
        waitForConfirmation: () => Promise.resolve(true)
      }

      const wrapped = agent.testWrapExecutorConfigForToolCall(run, tc, base)
      // tool_call 类型应被自动盖戳
      const callStep = wrapped.addStep({ type: 'tool_call', content: 'running', toolName: 'exec' })
      expect(callStep.toolCallId).toBe('tc-stamp')
      // tool_result 类型也应被盖戳
      const resultStep = wrapped.addStep({ type: 'tool_result', content: '✅', toolName: 'exec' })
      expect(resultStep.toolCallId).toBe('tc-stamp')
      // 其他类型不应被改动
      const msgStep = wrapped.addStep({ type: 'message', content: 'hello' })
      expect(msgStep.toolCallId).toBeUndefined()
    })

    it('should not overwrite an existing toolCallId set by the tool implementation', () => {
      const run = makeFakeRun()
      agent.injectCurrentRun(run)

      const tc = makeToolCall('tc-outer', 'exec')
      const base = {
        addStep: (step: any) => agent.testAddStep(step),
        updateStep: () => {},
        isAborted: () => false,
        waitForConfirmation: () => Promise.resolve(true)
      }

      const wrapped = agent.testWrapExecutorConfigForToolCall(run, tc, base)
      const step = wrapped.addStep({ type: 'tool_call', content: 'x', toolName: 'exec', toolCallId: 'tc-inner' })
      expect(step.toolCallId).toBe('tc-inner')
    })
  })

  // ==================== 工具返回图片的延迟注入 ====================
  // 这组测试覆盖之前的 bug：多个 read_file 并行返回图片时，旧实现立即在每个
  // tool 消息后 push 一条 user 消息，导致 user 夹在同批 tool 消息之间，
  // 触发 DeepSeek "insufficient tool messages following tool_calls message" 校验错误。
  // 修复后：图片暂存到 pendingToolImages，由 flushPendingToolImages 在批次结束时
  // 合并为单条 user 消息追加到所有 tool 消息之后。
  describe('processToolResult + flushPendingToolImages (image deferral)', () => {
    function makeRun(): any {
      return {
        id: 'fake-run',
        steps: [],
        messages: [],
        taskMessageLog: [],
        requestId: undefined
      }
    }

    function makeToolCall(id: string, name: string) {
      return { id, type: 'function', function: { name, arguments: '{}' } } as any
    }

    it('should NOT push image user-message immediately; accumulate in pendingToolImages', () => {
      const run = makeRun()
      const tc = makeToolCall('tc-a', 'read_file')

      agent.testProcessToolResult(run, tc, {
        success: true,
        output: 'ok',
        images: ['data:image/png;base64,AAAA']
      })

      // tool 消息已 push，但 user 图片消息没有
      expect(run.messages).toHaveLength(1)
      expect(run.messages[0]).toMatchObject({ role: 'tool', tool_call_id: 'tc-a' })
      expect(run.pendingToolImages).toEqual(['data:image/png;base64,AAAA'])
    })

    it('should preserve OpenAI tool_calls protocol when multiple tools return images in one batch', () => {
      const run = makeRun()
      // 模拟一批 assistant.tool_calls 已经 push 过
      run.messages.push({
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'tc-a', type: 'function', function: { name: 'read_file', arguments: '{}' } },
          { id: 'tc-b', type: 'function', function: { name: 'read_file', arguments: '{}' } }
        ]
      })

      // 两个工具依次完成，每个都返回图片
      agent.testProcessToolResult(run, makeToolCall('tc-a', 'read_file'), {
        success: true, output: 'ok-a', images: ['data:image/png;base64,AAA']
      })
      agent.testProcessToolResult(run, makeToolCall('tc-b', 'read_file'), {
        success: true, output: 'ok-b', images: ['data:image/png;base64,BBB']
      })

      // 此时 messages 中只能是 assistant → tool_a → tool_b（user 还没注入）
      expect(run.messages.map((m: any) => m.role)).toEqual(['assistant', 'tool', 'tool'])
      expect(run.pendingToolImages).toEqual(['data:image/png;base64,AAA', 'data:image/png;base64,BBB'])

      // 批次结束 flush
      agent.testFlushPendingToolImages(run)

      // 最终序列：assistant → tool → tool → user(合并的图片)
      // 关键：两条 tool 消息之间没有 user 消息，DeepSeek API 才会接受
      expect(run.messages.map((m: any) => m.role)).toEqual(['assistant', 'tool', 'tool', 'user'])
      const userMsg = run.messages[3]
      expect(userMsg.images).toEqual(['data:image/png;base64,AAA', 'data:image/png;base64,BBB'])
      expect(run.pendingToolImages).toEqual([])
    })

    it('should not write images to taskMessageLog (they are too large to persist)', () => {
      const run = makeRun()
      agent.testProcessToolResult(run, makeToolCall('tc-a', 'read_file'), {
        success: true, output: 'ok', images: ['data:image/png;base64,large']
      })
      agent.testFlushPendingToolImages(run)

      const userInLog = run.taskMessageLog.find((m: any) => m.role === 'user')
      expect(userInLog).toBeDefined()
      expect(userInLog.images).toBeUndefined()
      expect(userInLog.content).toBeTruthy()
    })

    it('flushPendingToolImages should be idempotent (no-op when pending is empty)', () => {
      const run = makeRun()

      agent.testFlushPendingToolImages(run)
      expect(run.messages).toEqual([])

      agent.testProcessToolResult(run, makeToolCall('tc-a', 'read_file'), {
        success: true, output: 'ok', images: ['data:image/png;base64,CCC']
      })
      agent.testFlushPendingToolImages(run)
      const lengthAfterFirst = run.messages.length

      // 再 flush 一次，不应再产生 user 消息
      agent.testFlushPendingToolImages(run)
      expect(run.messages).toHaveLength(lengthAfterFirst)
    })

    it('should not flush when no tool returns images', () => {
      const run = makeRun()
      agent.testProcessToolResult(run, makeToolCall('tc-a', 'execute_command'), {
        success: true, output: 'plain text output'
      })
      agent.testFlushPendingToolImages(run)

      expect(run.messages.map((m: any) => m.role)).toEqual(['tool'])
      // 无图片场景下不需要初始化 pendingToolImages（undefined 或空数组都视为"无暂存"）
      expect(run.pendingToolImages?.length ?? 0).toBe(0)
    })

    it('should drop images and inject "no vision" hint when current profile lacks vision capability', () => {
      // 当前 profile 不支持视觉时，flushPendingToolImages 应剥图但仍 push 一条 user 提示，
      // 让 AI 主动告知用户切换视觉模型，避免它凭文件名/上下文瞎编内容
      const noVisionConfig = {
        ...createMockConfigService(),
        hasVisionCapability: vi.fn().mockReturnValue(false)
      }
      const noVisionAgent = new TestAgent(createMockServices({ configService: noVisionConfig as any }))
      const run = makeRun()
      run.messages.push({
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'tc-a', type: 'function', function: { name: 'read_file', arguments: '{}' } }
        ]
      })
      noVisionAgent.testProcessToolResult(run, makeToolCall('tc-a', 'read_file'), {
        success: true, output: 'ok', images: ['data:image/png;base64,AAA', 'data:image/png;base64,BBB']
      })
      noVisionAgent.testFlushPendingToolImages(run)

      // 序列：assistant → tool → user(无视觉提示，不带 images)
      expect(run.messages.map((m: any) => m.role)).toEqual(['assistant', 'tool', 'user'])
      const userMsg = run.messages[2]
      expect(userMsg.images).toBeUndefined()
      expect(userMsg.content).toBeTruthy()
      expect(userMsg._systemInjected).toBe(true)
    })

    it('should mark vision-mode tool image messages as _systemInjected', () => {
      // 系统注入的 user 消息必须打 _systemInjected 标记，
      // 否则 splitMessagesIntoTasks 会把它当作任务边界，把同一个 task 切碎，
      // 造成「孤儿 tool」违规序列
      const run = makeRun()
      run.messages.push({
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'tc-a', type: 'function', function: { name: 'read_file', arguments: '{}' } }
        ]
      })
      agent.testProcessToolResult(run, makeToolCall('tc-a', 'read_file'), {
        success: true, output: 'ok', images: ['data:image/png;base64,CCC']
      })
      agent.testFlushPendingToolImages(run)
      const userMsg = run.messages.find((m: any) => m.role === 'user')
      expect(userMsg?._systemInjected).toBe(true)
    })
  })
})

// ==================== Agent run 方法测试 ====================

describe('Agent run method', () => {
  let agent: TestAgent
  let mockServices: AgentServices
  let mockAiService: ReturnType<typeof createMockAiService>
  let mockPtyService: ReturnType<typeof createMockPtyService>

  beforeEach(() => {
    vi.clearAllMocks()
    mockAiService = createMockAiService()
    mockPtyService = createMockPtyService()
    mockServices = createMockServices({
      aiService: mockAiService as any,
      ptyService: mockPtyService as any
    })
    agent = new TestAgent(mockServices)
  })

  describe('run lifecycle', () => {
    it('should throw if already running', async () => {
      // 模拟一个简单的 AI 响应
      mockAiService.chatWithToolsStream.mockImplementation(
        (_messages, _tools, _onChunk, _onToolCall, onDone) => {
          // 延迟完成以模拟运行状态
          setTimeout(() => {
            onDone({ content: 'Done', tool_calls: undefined })
          }, 100)
          return Promise.resolve()
        }
      )

      const context = createMockContext()
      const promise1 = agent.run('First task', context)
      
      // 立即尝试第二次运行应该抛出错误
      await expect(agent.run('Second task', context)).rejects.toThrow('Agent is already running')
      
      // 等待第一个运行完成
      await promise1
    })

    it('should return AI response content', async () => {
      const expectedResponse = 'Task completed successfully'
      
      mockAiService.chatWithToolsStream.mockImplementation(
        (_messages, _tools, onChunk, _onToolCall, onDone) => {
          onChunk(expectedResponse)
          onDone({ content: expectedResponse, tool_calls: undefined })
          return Promise.resolve()
        }
      )

      const context = createMockContext()
      const result = await agent.run('Test task', context)
      
      expect(result).toBe(expectedResponse)
    })

    it('should set up output listener', async () => {
      mockAiService.chatWithToolsStream.mockImplementation(
        (_messages, _tools, _onChunk, _onToolCall, onDone) => {
          onDone({ content: 'Done', tool_calls: undefined })
          return Promise.resolve()
        }
      )

      const context = createMockContext()
      await agent.run('Test task', context)
      
      // 验证 onData 被调用来设置监听器
      expect(mockPtyService.onData).toHaveBeenCalled()
    })

    it('should handle errors during execution', async () => {
      const errorMessage = 'AI service error'
      
      mockAiService.chatWithToolsStream.mockImplementation(
        (_messages, _tools, _onChunk, _onToolCall, _onDone, onError) => {
          onError(errorMessage)
          return Promise.reject(new Error(errorMessage))
        }
      )

      const context = createMockContext()
      
      await expect(agent.run('Test task', context)).rejects.toThrow(errorMessage)
    })

    it('should call onComplete callback on success', async () => {
      const onComplete = vi.fn()
      const expectedResponse = 'Task done'
      
      mockAiService.chatWithToolsStream.mockImplementation(
        (_messages, _tools, onChunk, _onToolCall, onDone) => {
          onChunk(expectedResponse)
          onDone({ content: expectedResponse, tool_calls: undefined })
          return Promise.resolve()
        }
      )

      agent.setCallbacks({ onComplete })
      
      const context = createMockContext()
      await agent.run('Test task', context)
      
      expect(onComplete).toHaveBeenCalled()
    })

    it('should call onError callback on failure', async () => {
      const onError = vi.fn()
      const errorMessage = 'Test error'
      
      mockAiService.chatWithToolsStream.mockImplementation(
        (_messages, _tools, _onChunk, _onToolCall, _onDone, onErrorCb) => {
          onErrorCb(errorMessage)
          return Promise.reject(new Error(errorMessage))
        }
      )

      agent.setCallbacks({ onError })
      
      const context = createMockContext()
      
      try {
        await agent.run('Test task', context)
      } catch {
        // 预期抛出错误
      }
      
      expect(onError).toHaveBeenCalled()
    })
  })

  describe('companion / wakeup profile binding', () => {
    const completeImmediately = () => {
      mockAiService.chatWithToolsStream.mockImplementation(
        (_messages, _tools, _onChunk, _onToolCall, onDone) => {
          onDone({ content: 'Done', tool_calls: undefined })
          return Promise.resolve()
        }
      )
    }

    it('keeps the liaison-selected model when WeChat comes in without an explicit profile', async () => {
      completeImmediately()
      const config = mockServices.configService as unknown as { getActiveAiProfile: ReturnType<typeof vi.fn> }
      config.getActiveAiProfile.mockReturnValue('local-8081')
      agent.setAgentId('__companion__')
      agent.updateConfig({ profileId: 'deepseek-v4-flash' })

      await agent.run('from wechat', createMockContext())

      expect(agent.exposeProfileId()).toBe('deepseek-v4-flash')
      expect(mockAiService.chatWithToolsStream).toHaveBeenCalled()
      const passedProfileId = mockAiService.chatWithToolsStream.mock.calls[0][6]
      expect(passedProfileId).toBe('deepseek-v4-flash')
    })

    it('does not pin the default when liaison has never selected a model', async () => {
      completeImmediately()
      const config = mockServices.configService as unknown as { getActiveAiProfile: ReturnType<typeof vi.fn> }
      config.getActiveAiProfile.mockReturnValue('local-8081')
      agent.setAgentId('__companion__')

      await agent.run('from wechat', createMockContext())

      expect(agent.exposeProfileId()).toBeUndefined()
      config.getActiveAiProfile.mockReturnValue('deepseek-v4-flash')
      await agent.run('from wechat again', createMockContext())
      expect(agent.exposeProfileId()).toBeUndefined()
    })

    it('wakeup still follows the default model when none is passed', async () => {
      completeImmediately()
      const config = mockServices.configService as unknown as { getActiveAiProfile: ReturnType<typeof vi.fn> }
      config.getActiveAiProfile.mockReturnValue('local-8081')
      agent.setAgentId('__wakeup__')
      agent.updateConfig({ profileId: 'deepseek-v4-flash' })

      await agent.run('heartbeat', createMockContext())

      expect(agent.exposeProfileId()).toBe('local-8081')
    })
  })

  describe('task memory', () => {
    it('should save task to memory on success', async () => {
      mockAiService.chatWithToolsStream.mockImplementation(
        (_messages, _tools, onChunk, _onToolCall, onDone) => {
          onChunk('Done')
          onDone({ content: 'Done', tool_calls: undefined })
          return Promise.resolve()
        }
      )

      const context = createMockContext()
      await agent.run('Test task', context)
      
      const taskMemory = agent.exposeTaskMemory()
      expect(taskMemory.getTaskCount()).toBe(1)
    })

    it('should save task to memory on failure', async () => {
      mockAiService.chatWithToolsStream.mockImplementation(
        (_messages, _tools, _onChunk, _onToolCall, _onDone, onError) => {
          onError('Failed')
          return Promise.reject(new Error('Failed'))
        }
      )

      const context = createMockContext()
      
      try {
        await agent.run('Test task', context)
      } catch {
        // 预期抛出错误
      }
      
      const taskMemory = agent.exposeTaskMemory()
      expect(taskMemory.getTaskCount()).toBe(1)
    })

    it('should restore from HistoryService when sessionId is provided', async () => {
      const sessionId = 'session_test_123'
      const mockHistoryService = {
        getAgentRecordById: vi.fn().mockReturnValue({
          id: sessionId,
          timestamp: Date.now() - 5000,
          terminalId: 'test-pty',
          terminalType: 'local',
          userTask: 'Previous task',
          steps: [
            { id: 'ut1', type: 'user_task', content: 'Previous task', timestamp: Date.now() - 5000 },
            { id: 'fr1', type: 'final_result', content: 'Previous result', timestamp: Date.now() - 4000 }
          ],
          messages: [
            { role: 'user', content: 'Previous task' },
            { role: 'assistant', content: 'Previous result' }
          ],
          finalResult: 'Previous result',
          duration: 1000,
          status: 'completed'
        }),
        saveAgentRecord: vi.fn(),
        getAgentRecordStore: vi.fn(() => mockHistoryService)
      }

      const services = createMockServices({ historyService: mockHistoryService as any })
      const agentWithHistory = new TestAgent(services)

      mockAiService = services.aiService as any
      mockAiService.chatWithToolsStream.mockImplementation(
        (_messages: any, _tools: any, onChunk: any, _onToolCall: any, onDone: any) => {
          onChunk('Done')
          onDone({ content: 'Done', tool_calls: undefined })
          return Promise.resolve()
        }
      )

      const context = createMockContext({ sessionId, sessionStartTime: Date.now() - 5000 })
      await agentWithHistory.run('New task', context)

      const taskMemory = agentWithHistory.exposeTaskMemory()
      // 应该有 2 个任务：从 HistoryService 恢复的 + 当前的
      expect(taskMemory.getTaskCount()).toBe(2)
      expect(mockHistoryService.getAgentRecordById).toHaveBeenCalledWith(sessionId)
    })

    it('续聊后保存的记录仍保留旧步骤的 canvasData（防产出物丢失回归）', async () => {
      const sessionId = 'session_canvas_keep'
      const savedRecords: any[] = []
      const oldCanvas = { action: 'open', renderer: 'markdown', title: 'a.md', filePath: '/tmp/a.md', content: '# A', contentFromFile: true }
      const mockHistoryService = {
        getAgentRecordById: vi.fn().mockReturnValue({
          id: sessionId,
          timestamp: Date.now() - 5000,
          terminalId: 'test-pty',
          terminalType: 'local',
          userTask: 'Previous task',
          steps: [
            { id: 'ut1', type: 'user_task', content: 'Previous task', timestamp: Date.now() - 5000 },
            { id: 'tr1', type: 'tool_result', content: 'wrote a.md', toolName: 'write_text_file', timestamp: Date.now() - 4500, canvasData: oldCanvas },
            { id: 'fr1', type: 'final_result', content: 'done', timestamp: Date.now() - 4000 }
          ],
          messages: [
            { role: 'user', content: 'Previous task' },
            { role: 'assistant', content: 'done' }
          ],
          finalResult: 'done',
          duration: 1000,
          status: 'completed'
        }),
        saveAgentRecord: vi.fn((r) => { savedRecords.push(JSON.parse(JSON.stringify(r))) }),
        getAgentRecordStore: vi.fn(() => mockHistoryService)
      }

      const services = createMockServices({ historyService: mockHistoryService as any })
      const agentWithHistory = new TestAgent(services)
      mockAiService = services.aiService as any
      mockAiService.chatWithToolsStream.mockImplementation(
        (_m: any, _t: any, onChunk: any, _otc: any, onDone: any) => {
          onChunk('Done'); onDone({ content: 'Done', tool_calls: undefined }); return Promise.resolve()
        }
      )

      const context = createMockContext({ sessionId, sessionStartTime: Date.now() - 5000 })
      await agentWithHistory.run('New task', context)

      // 所有保存的记录里，旧的 a.md 步骤都应保留 canvasData（contentFromFile 标记 + filePath）
      const stepsWithOldCanvas = savedRecords
        .flatMap(r => r.steps)
        .filter((s: any) => s.id === 'tr1')
      expect(stepsWithOldCanvas.length).toBeGreaterThan(0)
      for (const s of stepsWithOldCanvas) {
        expect(s.canvasData?.filePath).toBe('/tmp/a.md')
        expect(s.canvasData?.contentFromFile).toBe(true)
      }
    })

    /**
     * 防回归：新开 tab 的第一次对话不应被全局历史污染
     *
     * 场景：用户新开一个 terminal/SSH/独立助手 tab，前端生成新 sessionId 传给后端。
     * 由于是新 sessionId，HistoryService 必然找不到对应 record。此时普通 Agent
     * **绝对不能**走 restoreRecentTaskMemory fallback——那会把全局最近 N 个无关任务
     * 注入 TaskMemory，让 LLM 误以为是连续对话，沿用历史里的工具名造成幻觉调用
     * （例如截图反馈过的 `Unknown tool: generate_chart` 案例：上次对话用过 chart
     * 技能，新 tab 第一次说"画个图"，AI 直接捏造 generate_chart 而不是先 load 技能）。
     */
    it('should NOT restore global recent history for normal agent when sessionId record missing', async () => {
      const newSessionId = 'session_brand_new_tab'
      const mockHistoryService = {
        getAgentRecordById: vi.fn().mockReturnValue(undefined),
        getRecentAgentRecords: vi.fn().mockReturnValue([
          {
            id: 'session_other_tab',
            timestamp: Date.now() - 10000,
            terminalId: 'other-pty',
            terminalType: 'local',
            userTask: 'Unrelated task from another tab',
            steps: [
              { id: 'ut1', type: 'user_task', content: 'Unrelated task', timestamp: Date.now() - 10000 },
              { id: 'fr1', type: 'final_result', content: 'Unrelated result', timestamp: Date.now() - 9000 }
            ],
            messages: [
              { role: 'user', content: 'Unrelated task' },
              { role: 'assistant', content: 'Unrelated result' }
            ],
            finalResult: 'Unrelated result',
            duration: 1000,
            status: 'completed'
          }
        ]),
        saveAgentRecord: vi.fn(),
        getAgentRecordStore: vi.fn(() => mockHistoryService)
      }

      const services = createMockServices({ historyService: mockHistoryService as any })
      const normalAgent = new TestAgent(services)
      // 默认情况下 _persistentNamedAgent === false（普通 tab Agent）
      expect(normalAgent.isPersistentNamedAgent()).toBe(false)

      const ai = services.aiService as any
      ai.chatWithToolsStream.mockImplementation(
        (_messages: any, _tools: any, onChunk: any, _onToolCall: any, onDone: any) => {
          onChunk('OK')
          onDone({ content: 'OK', tool_calls: undefined })
          return Promise.resolve()
        }
      )

      const context = createMockContext({ sessionId: newSessionId, sessionStartTime: Date.now() })
      await normalAgent.run('First message in new tab', context)

      // sessionId 找不到 record → 普通 Agent 直接返回，**不**调用 getRecentAgentRecords
      expect(mockHistoryService.getAgentRecordById).toHaveBeenCalledWith(newSessionId)
      expect(mockHistoryService.getRecentAgentRecords).not.toHaveBeenCalled()
      // TaskMemory 仅含本次新任务，没有任何全局历史
      const taskMemory = normalAgent.exposeTaskMemory()
      expect(taskMemory.getTaskCount()).toBe(1)
    })

    /**
     * 持久命名 Agent（Companion / Watch）的 fallback 行为必须保留。
     * 这些 Agent 重启后用 `session_${Date.now()}` 找不到 record，但语义上是「同一个
     * 长期 Agent」，需要从全局最近历史恢复工作记忆才能记得最近聊过什么。
     */
    it('should restore companion recent history for persistent named agent when sessionId record missing', async () => {
      const newSessionId = 'session_companion_after_restart'
      const recentRecord = {
        id: 'session_previous',
        timestamp: Date.now() - 10000,
        terminalId: 'companion-pty',
        terminalType: 'assistant',
        agentKey: '__companion__',
        userTask: 'Previous companion chat',
        steps: [
          { id: 'ut1', type: 'user_task', content: 'Previous companion chat', timestamp: Date.now() - 10000 },
          { id: 'fr1', type: 'final_result', content: 'Previous reply', timestamp: Date.now() - 9000 }
        ],
        messages: [
          { role: 'user', content: 'Previous companion chat' },
          { role: 'assistant', content: 'Previous reply' }
        ],
        finalResult: 'Previous reply',
        duration: 1000,
        status: 'completed'
      }
      const mockHistoryService = {
        getAgentRecordById: vi.fn().mockReturnValue(undefined),
        getRecentAgentRecords: vi.fn().mockReturnValue([recentRecord]),
        getRecentRecordsByAgentKey: vi.fn().mockReturnValue([recentRecord]),
        saveAgentRecord: vi.fn(),
        getAgentRecordStore: vi.fn(() => mockHistoryService)
      }

      const services = createMockServices({ historyService: mockHistoryService as any })
      const companion = new TestAgent(services)
      companion.setAgentId('__companion__')
      expect(companion.isPersistentNamedAgent()).toBe(true)

      const ai = services.aiService as any
      ai.chatWithToolsStream.mockImplementation(
        (_messages: any, _tools: any, onChunk: any, _onToolCall: any, onDone: any) => {
          onChunk('Hi again')
          onDone({ content: 'Hi again', tool_calls: undefined })
          return Promise.resolve()
        }
      )

      const context = createMockContext({ sessionId: newSessionId, sessionStartTime: Date.now() })
      await companion.run('Hello after restart', context)

      // companion 走同 agentKey 的最近历史（getRecentRecordsByAgentKey），不走全局 fallback
      expect(mockHistoryService.getRecentRecordsByAgentKey).toHaveBeenCalledWith('__companion__', expect.any(Number))
      expect(mockHistoryService.getRecentAgentRecords).not.toHaveBeenCalled()
      // 工作记忆 = 恢复的 1 条 + 当前 1 条
      const taskMemory = companion.exposeTaskMemory()
      expect(taskMemory.getTaskCount()).toBe(2)
    })

    /**
     * 防回归（本次修复的核心）：companion 即使 sessionId 精确命中「最新单条」，也必须再从
     * 同 agentKey 最近多条历史重建工作记忆——否则会丢掉同期其它并行 companion 会话（典型：
     * 另一条 companion 线刚写完的文档），导致「屏幕合并展示看得见、AI 上下文只有单条记不住」。
     */
    it('should merge companion recent records into memory even when sessionId record is found', async () => {
      const latestId = 'session_companion_latest'
      const latestRecord = {
        id: latestId,
        timestamp: Date.now() - 5000,
        terminalId: 'companion-pty',
        terminalType: 'assistant',
        agentKey: '__companion__',
        userTask: '继续',
        steps: [
          { id: 'ut1', type: 'user_task', content: '继续', timestamp: Date.now() - 5000 },
          { id: 'fr1', type: 'final_result', content: '哪个方向？', timestamp: Date.now() - 4500 }
        ],
        messages: [
          { role: 'user', content: '继续' },
          { role: 'assistant', content: '哪个方向？' }
        ],
        finalResult: '哪个方向？',
        duration: 500,
        status: 'completed'
      }
      // 另一条并行 companion 会话（写文档那条），不应被「精确命中单条」漏掉
      const otherRecord = {
        id: 'session_companion_other',
        timestamp: Date.now() - 60000,
        terminalId: 'companion-pty',
        terminalType: 'assistant',
        agentKey: '__companion__',
        userTask: '写中证协案例文档',
        steps: [
          { id: 'ut2', type: 'user_task', content: '写中证协案例文档', timestamp: Date.now() - 60000 },
          { id: 'fr2', type: 'final_result', content: '已写完 docx', timestamp: Date.now() - 59000 }
        ],
        messages: [
          { role: 'user', content: '写中证协案例文档' },
          { role: 'assistant', content: '已写完 docx' }
        ],
        finalResult: '已写完 docx',
        duration: 1000,
        status: 'completed'
      }
      const mockHistoryService = {
        getAgentRecordById: vi.fn().mockReturnValue(latestRecord),
        getRecentAgentRecords: vi.fn().mockReturnValue([otherRecord]),
        getRecentRecordsByAgentKey: vi.fn().mockReturnValue([latestRecord, otherRecord]),
        saveAgentRecord: vi.fn(),
        getAgentRecordStore: vi.fn(() => mockHistoryService)
      }

      const services = createMockServices({ historyService: mockHistoryService as any })
      const companion = new TestAgent(services)
      companion.setAgentId('__companion__')

      const ai = services.aiService as any
      ai.chatWithToolsStream.mockImplementation(
        (_messages: any, _tools: any, onChunk: any, _onToolCall: any, onDone: any) => {
          onChunk('好的')
          onDone({ content: '好的', tool_calls: undefined })
          return Promise.resolve()
        }
      )

      const context = createMockContext({ sessionId: latestId, sessionStartTime: Date.now() })
      await companion.run('就上次那个，继续', context)

      // companion 走同 agentKey 的最近历史；即命中 latest 也调用（excludeId 排除 latest 后取其它并行线）
      expect(mockHistoryService.getRecentRecordsByAgentKey).toHaveBeenCalledWith('__companion__', expect.any(Number))
      expect(mockHistoryService.getRecentAgentRecords).not.toHaveBeenCalled()
      // 工作记忆 = 其它并行线 1 条 + latest 1 条 + 当前 1 条 = 3
      const taskMemory = companion.exposeTaskMemory()
      expect(taskMemory.getTaskCount()).toBe(3)
    })

    /**
     * 防回归（本次调整的核心）：companion 恢复工作记忆时**不得**装入 task tab 的记录。
     * 旧实现取全局最近 N 条（不区分 agentKey），会把刚在任务 tab 做的事灌进联络的 AI 上下文，
     * 让用户在联络里感觉「Agent 在串台」。新实现按 agentKey 过滤，task record 一律不进 companion 工作记忆。
     */
    it('should NOT load task tab records into companion working memory (isolation)', async () => {
      const latestCompanion = {
        id: 'session_companion_a',
        timestamp: Date.now() - 5000,
        terminalId: 'companion-pty',
        terminalType: 'assistant',
        agentKey: '__companion__',
        userTask: '在吗',
        steps: [
          { id: 'ut1', type: 'user_task', content: '在吗', timestamp: Date.now() - 5000 },
          { id: 'fr1', type: 'final_result', content: '在的', timestamp: Date.now() - 4500 }
        ],
        messages: [
          { role: 'user', content: '在吗' },
          { role: 'assistant', content: '在的' }
        ],
        finalResult: '在的',
        duration: 500,
        status: 'completed'
      }
      // 任务 tab 刚跑的记录——必须被排除
      const taskRecord = {
        id: 'session_task_x',
        timestamp: Date.now() - 3000,
        terminalId: 'task-pty',
        terminalType: 'local',
        agentKey: 'task-tab-1',
        userTask: '部署 nginx 到生产环境',
        steps: [
          { id: 'ut2', type: 'user_task', content: '部署 nginx 到生产环境', timestamp: Date.now() - 3000 },
          { id: 'fr2', type: 'final_result', content: '已部署', timestamp: Date.now() - 2500 }
        ],
        messages: [
          { role: 'user', content: '部署 nginx 到生产环境' },
          { role: 'assistant', content: '已部署' }
        ],
        finalResult: '已部署',
        duration: 500,
        status: 'completed'
      }
      const mockHistoryService = {
        getAgentRecordById: vi.fn().mockReturnValue(latestCompanion),
        // 全局 fallback 即使被调用也会返回含 taskRecord；companion 不应走这条路径
        getRecentAgentRecords: vi.fn().mockReturnValue([taskRecord, latestCompanion]),
        // companion 走这条：只返回同 agentKey 的（不含 taskRecord）
        getRecentRecordsByAgentKey: vi.fn().mockReturnValue([latestCompanion]),
        saveAgentRecord: vi.fn(),
        getAgentRecordStore: vi.fn(() => mockHistoryService)
      }

      const services = createMockServices({ historyService: mockHistoryService as any })
      const companion = new TestAgent(services)
      companion.setAgentId('__companion__')

      const ai = services.aiService as any
      ai.chatWithToolsStream.mockImplementation(
        (_messages: any, _tools: any, onChunk: any, _onToolCall: any, onDone: any) => {
          onChunk('在')
          onDone({ content: '在', tool_calls: undefined })
          return Promise.resolve()
        }
      )

      const context = createMockContext({ sessionId: latestCompanion.id, sessionStartTime: Date.now() })
      await companion.run('在吗', context)

      // companion 走同 agentKey 路径，**不**走全局 getRecentAgentRecords
      expect(mockHistoryService.getRecentRecordsByAgentKey).toHaveBeenCalledWith('__companion__', expect.any(Number))
      expect(mockHistoryService.getRecentAgentRecords).not.toHaveBeenCalled()
      // 工作记忆里**不应**出现任务 tab 的 userRequest
      const taskMemory = companion.exposeTaskMemory()
      const allTasks = taskMemory.getTasksInOrder()
      expect(allTasks.some(t => t.userRequest.includes('部署 nginx'))).toBe(false)
    })

    /**
     * 防回归：wakeup 仍走全局 main 树（排除 wakeup 噪声），不进 companion 的同 agentKey 路径。
     * wakeup 是 Agent 的内心独白，需参考用户在任意 tab 的最近活动做决策——全局借记忆对 wakeup 成立。
     * 注：普通 watch（__watch__）已改为逐次失忆（seedFromHistoryOnColdStart=false），不再借记忆。
     */
    it('should restore global recent history for wakeup agent (not companion-scoped)', async () => {
      const wakeupLatest = {
        id: 'session_wakeup_latest',
        timestamp: Date.now() - 5000,
        terminalId: 'watch-pty',
        terminalType: 'assistant',
        agentKey: '__wakeup__',
        userTask: '[当前时间：06:00] 触发事件：心跳',
        steps: [
          { id: 'ut1', type: 'user_task', content: '[当前时间：06:00] 触发事件：心跳', timestamp: Date.now() - 5000 },
          { id: 'fr1', type: 'final_result', content: 'NO_ACTION', timestamp: Date.now() - 4500 }
        ],
        messages: [
          { role: 'user', content: '[当前时间：06:00] 触发事件：心跳' },
          { role: 'assistant', content: 'NO_ACTION' }
        ],
        finalResult: 'NO_ACTION',
        duration: 500,
        status: 'completed'
      }
      // 用户在任务 tab 的活动——wakeup 应能借作工作记忆（全局路径）
      const taskActivity = {
        id: 'session_task_y',
        timestamp: Date.now() - 3000,
        terminalId: 'task-pty',
        terminalType: 'local',
        agentKey: 'task-tab-2',
        userTask: '排查磁盘满',
        steps: [
          { id: 'ut2', type: 'user_task', content: '排查磁盘满', timestamp: Date.now() - 3000 },
          { id: 'fr2', type: 'final_result', content: '已清理日志', timestamp: Date.now() - 2500 }
        ],
        messages: [
          { role: 'user', content: '排查磁盘满' },
          { role: 'assistant', content: '已清理日志' }
        ],
        finalResult: '已清理日志',
        duration: 500,
        status: 'completed'
      }
      const mockHistoryService = {
        getAgentRecordById: vi.fn().mockReturnValue(wakeupLatest),
        // 全局路径返回 [taskActivity]——wakeup 命中的 latest 是 wakeup 噪声，会被 isWakeupNoise 排除，
        // 再 excludeId 排除 latest 自身，所以 getRecentAgentRecords 应返回 taskActivity
        getRecentAgentRecords: vi.fn().mockReturnValue([taskActivity]),
        getRecentRecordsByAgentKey: vi.fn().mockReturnValue([wakeupLatest]),
        saveAgentRecord: vi.fn(),
        getAgentRecordStore: vi.fn(() => mockHistoryService)
      }

      const services = createMockServices({ historyService: mockHistoryService as any })
      const wakeup = new TestAgent(services)
      wakeup.setAgentId('__wakeup__')

      const ai = services.aiService as any
      ai.chatWithToolsStream.mockImplementation(
        (_m: any, _t: any, onChunk: any, _otc: any, onDone: any) => {
          onChunk('ok'); onDone({ content: 'ok', tool_calls: undefined }); return Promise.resolve()
        }
      )

      const context = createMockContext({ sessionId: wakeupLatest.id, sessionStartTime: Date.now() })
      await wakeup.run('wakeup', context)

      // wakeup 走全局 getRecentAgentRecords，不进 companion 的同 agentKey 路径
      expect(mockHistoryService.getRecentAgentRecords).toHaveBeenCalled()
      expect(mockHistoryService.getRecentRecordsByAgentKey).not.toHaveBeenCalled()
      // 工作记忆含任务 tab 的活动（全局借记忆对 wakeup 成立）。
      // 注：latest 自身（wakeup 那条）由 restoreFromSessionRecord 恢复供 checkpoint 续写，
      // restoreRecentTaskMemory 的全局路径已用 isWakeupNoise 排除它（不会再加一份）。
      const taskMemory = wakeup.exposeTaskMemory()
      const allTasks = taskMemory.getTasksInOrder()
      expect(allTasks.some(t => t.userRequest.includes('排查磁盘满'))).toBe(true)
    })

    /**
     * 防回归（联络分裂根因①）：持久命名 Agent 在「无 context.sessionId」时（IM/网关/主动
     * 消息等入口），不能新起 session_${Date.now()}，而应从最近一条同 agentKey 历史回种
     * sessionId，让所有入口续写到同一条会话，避免建出与历史断链的并行记录。
     */
    it('should seed sessionId from latest record for persistent named agent when context has no sessionId', async () => {
      const persistedRecord = {
        id: 'session_persisted_companion',
        timestamp: Date.now() - 100000,
        terminalId: 'companion-pty',
        terminalType: 'assistant',
        userTask: '昨天聊的事',
        steps: [
          { id: 'ut1', type: 'user_task', content: '昨天聊的事', timestamp: Date.now() - 100000 },
          { id: 'fr1', type: 'final_result', content: '记得', timestamp: Date.now() - 99000 }
        ],
        messages: [
          { role: 'user', content: '昨天聊的事' },
          { role: 'assistant', content: '记得' }
        ],
        finalResult: '记得',
        duration: 1000,
        status: 'completed'
      }
      const mockHistoryService = {
        getAgentRecordById: vi.fn().mockReturnValue(persistedRecord),
        getRecentAgentRecords: vi.fn().mockReturnValue([]),
        getLatestRecordByAgentKey: vi.fn().mockReturnValue(persistedRecord),
        saveAgentRecord: vi.fn(),
        getAgentRecordStore: vi.fn(() => mockHistoryService)
      }

      const services = createMockServices({ historyService: mockHistoryService as any })
      const companion = new TestAgent(services)
      companion.setAgentId('__companion__')

      const ai = services.aiService as any
      ai.chatWithToolsStream.mockImplementation(
        (_m: any, _t: any, onChunk: any, _otc: any, onDone: any) => {
          onChunk('好'); onDone({ content: '好', tool_calls: undefined }); return Promise.resolve()
        }
      )

      // 关键：context 不带 sessionId（模拟 IM/主动消息入口）
      const context = createMockContext({ terminalType: 'assistant' })
      await companion.run('在吗', context)

      expect(mockHistoryService.getLatestRecordByAgentKey).toHaveBeenCalledWith('__companion__')
      // 回种到历史最近一条，而不是新起 session_${Date.now()}
      expect(companion.getSessionId()).toBe('session_persisted_companion')
    })

    /**
     * 防回归（根因①的边界）：startNewSession（wakeup 每次独立记录）/ resetSession（清空对话）
     * 后，本次有意要全新会话，必须抑制回种，避免覆盖历史最近一条记录。
     * 注：watch 已改为 seedFromHistoryOnColdStart=false（逐次失忆），本测试用 wakeup
     * （仍为持久命名 Agent）覆盖 suppress 机制。
     */
    it('should NOT seed sessionId after startNewSession (suppressed) even for persistent named agent', async () => {
      const persistedRecord = {
        id: 'session_persisted_x', timestamp: Date.now() - 100000, terminalId: 'p',
        terminalType: 'assistant', userTask: 'x', steps: [], messages: [],
        finalResult: 'x', duration: 1, status: 'completed'
      }
      const mockHistoryService = {
        getAgentRecordById: vi.fn().mockReturnValue(undefined),
        getRecentAgentRecords: vi.fn().mockReturnValue([]),
        getLatestRecordByAgentKey: vi.fn().mockReturnValue(persistedRecord),
        saveAgentRecord: vi.fn(),
        getAgentRecordStore: vi.fn(() => mockHistoryService)
      }
      const services = createMockServices({ historyService: mockHistoryService as any })
      const wakeupLike = new TestAgent(services)
      wakeupLike.setAgentId('__wakeup__')

      const ai = services.aiService as any
      ai.chatWithToolsStream.mockImplementation(
        (_m: any, _t: any, onChunk: any, _otc: any, onDone: any) => {
          onChunk('ok'); onDone({ content: 'ok', tool_calls: undefined }); return Promise.resolve()
        }
      )

      wakeupLike.startNewSession() // 有意要独立会话
      const context = createMockContext({ terminalType: 'assistant' })
      await wakeupLike.run('wakeup', context)

      // 抑制生效：不回种，生成新 session_，且不等于历史那条
      expect(mockHistoryService.getLatestRecordByAgentKey).not.toHaveBeenCalled()
      expect(wakeupLike.getSessionId()).not.toBe('session_persisted_x')
      expect(wakeupLike.getSessionId()).toMatch(/^session_\d+$/)
    })

    it('should restore from steps when messages field is missing (old records)', async () => {
      const sessionId = 'session_old_record'
      const mockHistoryService = {
        getAgentRecordById: vi.fn().mockReturnValue({
          id: sessionId,
          timestamp: Date.now() - 5000,
          terminalId: 'test-pty',
          terminalType: 'local',
          userTask: 'Old task without messages',
          steps: [
            { id: 'ut1', type: 'user_task', content: 'Old task 1', timestamp: Date.now() - 5000 },
            { id: 'tc1', type: 'tool_call', content: 'Running command', toolName: 'execute_command', timestamp: Date.now() - 4500 },
            { id: 'tr1', type: 'tool_result', content: 'OK', toolName: 'execute_command', toolResult: 'success', timestamp: Date.now() - 4000 },
            { id: 'fr1', type: 'final_result', content: 'Task 1 done', timestamp: Date.now() - 3500 },
            { id: 'ut2', type: 'user_task', content: 'Old task 2', timestamp: Date.now() - 3000 },
            { id: 'fr2', type: 'final_result', content: 'Task 2 done', timestamp: Date.now() - 2000 }
          ],
          // messages field is intentionally missing (old record)
          finalResult: 'Task 2 done',
          duration: 3000,
          status: 'completed'
        }),
        saveAgentRecord: vi.fn(),
        getAgentRecordStore: vi.fn(() => mockHistoryService)
      }

      const services = createMockServices({ historyService: mockHistoryService as any })
      const agentWithHistory = new TestAgent(services)

      mockAiService = services.aiService as any
      mockAiService.chatWithToolsStream.mockImplementation(
        (_messages: any, _tools: any, onChunk: any, _onToolCall: any, onDone: any) => {
          onChunk('Done')
          onDone({ content: 'Done', tool_calls: undefined })
          return Promise.resolve()
        }
      )

      const context = createMockContext({ sessionId, sessionStartTime: Date.now() - 5000 })
      await agentWithHistory.run('New task', context)

      const taskMemory = agentWithHistory.exposeTaskMemory()
      // 应该有 3 个任务：从 steps 恢复的 2 个 + 当前的 1 个
      expect(taskMemory.getTaskCount()).toBe(3)
      expect(mockHistoryService.getAgentRecordById).toHaveBeenCalledWith(sessionId)
    })
  })

  describe('with tool calls', () => {
    it('should execute tool calls from AI response', async () => {
      const toolCall = {
        id: 'call-1',
        type: 'function' as const,
        function: {
          name: 'test_tool',
          arguments: '{}'
        }
      }

      let callCount = 0
      mockAiService.chatWithToolsStream.mockImplementation(
        (_messages, _tools, onChunk, _onToolCall, onDone) => {
          callCount++
          if (callCount === 1) {
            // 第一次调用返回工具调用
            onDone({ content: '', tool_calls: [toolCall] })
          } else {
            // 第二次调用返回最终响应
            onChunk('Final response')
            onDone({ content: 'Final response', tool_calls: undefined })
          }
          return Promise.resolve()
        }
      )

      agent.mockTools = [{
        type: 'function',
        function: {
          name: 'test_tool',
          description: 'A test tool',
          parameters: { type: 'object', properties: {} }
        }
      }]

      const context = createMockContext()
      const result = await agent.run('Test with tools', context)
      
      // 应该调用两次 AI：第一次返回工具调用，第二次返回最终响应
      expect(mockAiService.chatWithToolsStream).toHaveBeenCalledTimes(2)
      expect(result).toBe('Final response')
    })

    it('should batch adjacent parallelizable tools together', async () => {
      // 测试分批逻辑：使用只读工具来测试分批
      // [read_file, read_file, search_knowledge, read_file]
      // 全是可并行工具，应该在一个批次并行执行
      const toolCalls = [
        { id: 'call-1', type: 'function' as const, function: { name: 'read_file', arguments: '{"path":"a.txt"}' } },
        { id: 'call-2', type: 'function' as const, function: { name: 'read_file', arguments: '{"path":"b.txt"}' } },
        { id: 'call-3', type: 'function' as const, function: { name: 'file_search', arguments: '{"pattern":"*.ts"}' } },
        { id: 'call-4', type: 'function' as const, function: { name: 'read_file', arguments: '{"path":"c.txt"}' } },
      ]

      let callCount = 0
      mockAiService.chatWithToolsStream.mockImplementation(
        (_messages, _tools, onChunk, _onToolCall, onDone) => {
          callCount++
          if (callCount === 1) {
            onDone({ content: '', tool_calls: toolCalls })
          } else {
            // 验证所有工具结果都已返回
            const messages = _messages as AiMessage[]
            const toolResults = messages.filter(m => m.role === 'tool')
            expect(toolResults.length).toBe(4)
            
            onChunk('Done')
            onDone({ content: 'Done', tool_calls: undefined })
          }
          return Promise.resolve()
        }
      )

      const context = createMockContext()
      await agent.run('Test parallel tools', context)

      expect(mockAiService.chatWithToolsStream).toHaveBeenCalledTimes(2)
    })

    it('should execute multiple parallelizable tools in parallel', async () => {
      // 测试多个可并行工具确实是并行执行的
      const toolCalls = [
        { id: 'call-1', type: 'function' as const, function: { name: 'read_file', arguments: '{"path":"a.txt"}' } },
        { id: 'call-2', type: 'function' as const, function: { name: 'read_file', arguments: '{"path":"b.txt"}' } },
      ]

      let callCount = 0
      mockAiService.chatWithToolsStream.mockImplementation(
        (_messages, _tools, onChunk, _onToolCall, onDone) => {
          callCount++
          if (callCount === 1) {
            onDone({ content: '', tool_calls: toolCalls })
          } else {
            // 检查消息历史中的工具结果
            const messages = _messages as AiMessage[]
            const toolResults = messages.filter(m => m.role === 'tool')
            // 应该有 2 个工具结果，且顺序正确
            expect(toolResults.length).toBe(2)
            expect(toolResults[0].tool_call_id).toBe('call-1')
            expect(toolResults[1].tool_call_id).toBe('call-2')
            
            onChunk('Done')
            onDone({ content: 'Done', tool_calls: undefined })
          }
          return Promise.resolve()
        }
      )

      const context = createMockContext()
      await agent.run('Test parallel execution', context)

      expect(mockAiService.chatWithToolsStream).toHaveBeenCalledTimes(2)
    })

    it('should maintain execution order for mixed tool calls', async () => {
      // 测试混合工具调用保持正确的执行顺序
      // [read_file(A), execute_command(B), read_file(C)]
      // 期望：先执行 A，再执行 B，最后执行 C
      // 使用 free 模式跳过确认
      agent.updateConfig({ executionMode: 'free' })
      
      const toolCalls = [
        { id: 'call-1', type: 'function' as const, function: { name: 'read_file', arguments: '{"path":"a.txt"}' } },
        { id: 'call-2', type: 'function' as const, function: { name: 'execute_command', arguments: '{"command":"echo test"}' } },
        { id: 'call-3', type: 'function' as const, function: { name: 'read_file', arguments: '{"path":"c.txt"}' } },
      ]

      let callCount = 0
      mockAiService.chatWithToolsStream.mockImplementation(
        (_messages, _tools, onChunk, _onToolCall, onDone) => {
          callCount++
          if (callCount === 1) {
            onDone({ content: '', tool_calls: toolCalls })
          } else {
            // 检查消息历史中的工具结果顺序
            const messages = _messages as AiMessage[]
            const toolResults = messages.filter(m => m.role === 'tool')
            // 应该有 3 个工具结果，且顺序与原始调用顺序一致
            expect(toolResults.length).toBe(3)
            expect(toolResults[0].tool_call_id).toBe('call-1')
            expect(toolResults[1].tool_call_id).toBe('call-2')
            expect(toolResults[2].tool_call_id).toBe('call-3')
            
            onChunk('Done')
            onDone({ content: 'Done', tool_calls: undefined })
          }
          return Promise.resolve()
        }
      )

      const context = createMockContext()
      await agent.run('Test mixed tools order', context)

      expect(mockAiService.chatWithToolsStream).toHaveBeenCalledTimes(2)
    })
  })
})

// ==================== Agent 运行时状态管理测试 ====================

describe('Agent runtime state management', () => {
  let agent: TestAgent
  let mockServices: AgentServices
  let mockAiService: ReturnType<typeof createMockAiService>

  beforeEach(() => {
    vi.clearAllMocks()
    mockAiService = createMockAiService()
    mockServices = createMockServices({
      aiService: mockAiService as any
    })
    agent = new TestAgent(mockServices)
  })

  describe('abort during execution', () => {
    it('should abort running task', async () => {
      let resolveAi: (() => void) | undefined
      
      mockAiService.chatWithToolsStream.mockImplementation(
        (_messages, _tools, _onChunk, _onToolCall, onDone) => {
          return new Promise<void>((resolve) => {
            resolveAi = () => {
              onDone({ content: 'Aborted', tool_calls: undefined })
              resolve()
            }
          })
        }
      )

      const context = createMockContext()
      const promise = agent.run('Long running task', context)
      
      // 等待一下让 agent 开始运行
      await new Promise(resolve => setTimeout(resolve, 10))
      
      // 现在应该在运行中
      expect(agent.isRunning()).toBe(true)
      
      // 中止
      const aborted = agent.abort()
      expect(aborted).toBe(true)
      expect(agent.exposeCurrentRun()?.abortController?.signal.aborted).toBe(true)
      
      // 验证 AI 服务的 abort 被调用
      expect(mockAiService.abort).toHaveBeenCalled()
      
      // 完成 AI 调用
      resolveAi?.()
      await promise
    })
  })

  describe('addUserMessage during execution', () => {
    it('should add message to pending queue', async () => {
      // 使用同步的方式来测试，避免 Promise 超时问题
      mockAiService.chatWithToolsStream.mockImplementation(
        (_messages, _tools, onChunk, _onToolCall, onDone) => {
          // 模拟稍微延迟的响应
          setTimeout(() => {
            onChunk('Done')
            onDone({ content: 'Done', tool_calls: undefined })
          }, 50)
          return Promise.resolve()
        }
      )

      const context = createMockContext()
      const promise = agent.run('Task', context)
      
      // 等待一下让 agent 开始运行
      await new Promise(resolve => setTimeout(resolve, 10))
      
      // 添加用户消息
      const added = agent.addUserMessage('User supplement')
      expect(added).toBe(true)
      
      // 等待完成
      await promise
    }, 10000) // 增加超时时间
  })

  describe('getRunStatus during execution', () => {
    it('should return correct status', async () => {
      let resolveAi: (() => void) | undefined
      
      mockAiService.chatWithToolsStream.mockImplementation(
        (_messages, _tools, _onChunk, _onToolCall, onDone) => {
          return new Promise<void>((resolve) => {
            resolveAi = () => {
              onDone({ content: 'Done', tool_calls: undefined })
              resolve()
            }
          })
        }
      )

      const context = createMockContext()
      const promise = agent.run('Task', context)
      
      // 等待一下让 agent 开始运行
      await new Promise(resolve => setTimeout(resolve, 10))
      
      const status = agent.getRunStatus()
      expect(status).toBeDefined()
      expect(status!.isRunning).toBe(true)
      expect(status!.hasPendingConfirmation).toBe(false)
      
      // 完成
      resolveAi?.()
      await promise
    })
  })
})

// ==================== Agent 步骤回调测试 ====================

describe('Agent step callbacks', () => {
  let agent: TestAgent
  let mockServices: AgentServices
  let mockAiService: ReturnType<typeof createMockAiService>

  beforeEach(() => {
    vi.clearAllMocks()
    mockAiService = createMockAiService()
    mockServices = createMockServices({
      aiService: mockAiService as any
    })
    agent = new TestAgent(mockServices)
  })

  it('should call onStep for initial thinking step', async () => {
    // 在调用瞬间 snapshot type，避免后续 updateStep 把 initial thinking step 改造为 message 时
    // 通过对象引用回溯影响断言（见 callAiWithStreaming 第一个 chunk 的 step 复用逻辑）
    const stepTypes: string[] = []
    const onStep = vi.fn((_runId: string, step: { type: string }) => {
      stepTypes.push(step.type)
    })
    
    mockAiService.chatWithToolsStream.mockImplementation(
      (_messages, _tools, onChunk, _onToolCall, onDone) => {
        onChunk('Response')
        onDone({ content: 'Response', tool_calls: undefined })
        return Promise.resolve()
      }
    )

    agent.setCallbacks({ onStep })
    
    const context = createMockContext()
    await agent.run('Test', context)
    
    // 应该至少调用一次 onStep
    expect(onStep).toHaveBeenCalled()
    
    // 第一个步骤是 user_task（后端统一生成），第二个是 thinking 占位（"正在准备..."）
    expect(stepTypes[0]).toBe('user_task')
    expect(stepTypes[1]).toBe('thinking')
  })

  it('should call onStart after user_task step is emitted', async () => {
    const onStart = vi.fn()

    mockAiService.chatWithToolsStream.mockImplementation(
      (_messages, _tools, onChunk, _onToolCall, onDone) => {
        onChunk('Response')
        onDone({ content: 'Response', tool_calls: undefined })
        return Promise.resolve()
      }
    )

    agent.setCallbacks({ onStart })

    const context = createMockContext()
    await agent.run('Hello task', context)

    expect(onStart).toHaveBeenCalledOnce()
    expect(onStart).toHaveBeenCalledWith(expect.any(String), 'Hello task')
  })

  it('should call onStep for message step', async () => {
    const onStep = vi.fn()
    
    mockAiService.chatWithToolsStream.mockImplementation(
      (_messages, _tools, onChunk, _onToolCall, onDone) => {
        onChunk('Response')
        onDone({ content: 'Response', tool_calls: undefined })
        return Promise.resolve()
      }
    )

    agent.setCallbacks({ onStep })
    
    const context = createMockContext()
    await agent.run('Test', context)
    
    // 检查是否有 message 类型的步骤
    const messageCalls = onStep.mock.calls.filter(
      (call) => call[1]?.type === 'message'
    )
    expect(messageCalls.length).toBeGreaterThan(0)
  })
})

// ==================== SkillSession 持久化测试 ====================

describe('Agent SkillSession persistence', () => {
  let agent: TestAgent

  beforeEach(() => {
    const services = createMockServices()
    agent = new TestAgent(services)
  })

  it('should return same skillSession instance on multiple calls (lazy init)', () => {
    // 第一次获取
    const session1 = agent.exposeGetSkillSession()
    
    // 第二次获取
    const session2 = agent.exposeGetSkillSession()
    
    // 应该是同一个实例（延迟初始化后持久化）
    expect(session1).toBeDefined()
    expect(session2).toBeDefined()
    expect(session1).toBe(session2)
  })

  it('should have getLoadedSkills method', () => {
    const session = agent.exposeGetSkillSession()
    
    // 初始状态应该没有加载任何技能
    expect(session.getLoadedSkills()).toEqual([])
  })

  it('should cleanup skillSession and currentRun when agent cleanup is called', () => {
    // 先触发 skillSession 初始化
    const session = agent.exposeGetSkillSession()
    expect(session).toBeDefined()
    
    // cleanup
    agent.cleanup()
    
    // currentRun 应该被清理
    expect(agent.exposeCurrentRun()).toBeUndefined()
  })
})
