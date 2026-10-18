/**
 * 联络派完任务，这一轮等着任务回来：
 * 回执在同一轮里读到并回复（用户看得见）；用户插话先回答、之后接着等；
 * 按停联络只是不再等，任务不被停，回执之后另起一轮送来。
 * 真实 SailFish.run() + 真实 TaskSupervisor + 脚本化模型。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import type { ToolDefinition } from '../../ai.service'
import type { AgentContext, AgentServices, AgentStep, TaskReceiptText } from '../types'

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
import { TaskSupervisor, type TaskSupervisorHost } from '../task-supervisor'

type Msg = { role?: string; content?: unknown; tool_calls?: unknown }
type LlmResponse = {
  content?: string
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
}

const COMPANION = '__companion__'

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function lastUserText(messages: Msg[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return String(messages[i].content || '')
  }
  return ''
}

function tc(name: string, args: Record<string, unknown>) {
  return { id: `tc-${name}-${Math.random().toString(36).slice(2, 7)}`, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } }
}

function ctx(): AgentContext {
  return {
    terminalOutput: [],
    systemInfo: { os: 'darwin', shell: '/bin/zsh' },
    terminalType: 'assistant',
    cwd: tmpDir,
  }
}

function makeServices(
  responder: (call: { index: number; messages: Msg[] }) => LlmResponse | Promise<LlmResponse>,
  taskSupervisor: TaskSupervisor
): AgentServices {
  let index = 0
  const inflight = new Set<() => void>()
  return {
    aiService: {
      chat: vi.fn().mockResolvedValue(''),
      chatWithToolsStream: vi.fn(async (
        messages: Msg[],
        _tools: ToolDefinition[],
        onChunk: (s: string) => void,
        _onToolCall: unknown,
        onDone: (r: unknown) => void,
        onError?: (e: string) => void
      ) => {
        let cancelled = false
        const cancel = () => { cancelled = true }
        inflight.add(cancel)
        try {
          const r = await responder({ index: index++, messages: JSON.parse(JSON.stringify(messages)) })
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
    conversationManager: undefined,
    taskSupervisor,
  }
}

/** 一个会把回执交给联络的监督器；任务那头用桩（派出去的任务始终算「在跑」） */
function makeSupervisor(
  deliver: (receipt: TaskReceiptText) => void,
  extra: { say?: () => Promise<unknown>; wakeCompanionWait?: () => void } = {}
) {
  const abort = vi.fn().mockReturnValue(true)
  const host = {
    getAllAgentEntries: () => [],
    getAgent: () => ({
      getRunStatus: () => ({ isRunning: true, phase: 'thinking', stepCount: 1, hasPendingConfirmation: false, ledBy: 'companion' }),
      getConversationTitle: () => '整理日志',
      getSessionStepsSnapshot: () => [],
      getTerminalType: () => 'assistant',
      getSessionId: () => 'session-task',
      getPendingConfirmationInfo: () => undefined,
    }),
    confirmToolCall: vi.fn().mockReturnValue(true),
    abort,
    say: extra.say ?? vi.fn().mockResolvedValue({ outcome: 'ran', result: 'ok' }),
    deliverCompanionReceipt: deliver,
    wakeCompanionWait: extra.wakeCompanionWait ?? vi.fn(),
    getHistoryService: () => undefined,
    getConfigService: () => undefined,
    prepareAssignedTask: vi.fn(),
  } as unknown as TaskSupervisorHost
  return { supervisor: new TaskSupervisor(host), abort }
}

function newCompanion(services: AgentServices): SailFish {
  const agent = new SailFish(services)
  agent.setAgentId(COMPANION)
  agent.updateConfig({ executionMode: 'free' })
  return agent
}

describe('联络派完任务，这一轮等着任务回来', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-companion-hold-e2e-'))
  })
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('派完先回一句，这一轮不收工；回执到了在同一轮里读到并回复，用户看得见', async () => {
    const timeline: string[] = []
    let agent!: SailFish
    const { supervisor } = makeSupervisor(receipt => agent.deliverTaskReceipt(receipt, { fallbackContext: ctx() }))
    const services = makeServices(({ index, messages }) => {
      const last = lastUserText(messages)
      if (index === 0) {
        return { tool_calls: [tc('manage_tasks', { action: 'create', title: '整理日志', brief: '把日志整理一下' })] }
      }
      if (last.includes('任务回执')) {
        timeline.push('receipt-read')
        expect(last).toContain('你这一轮还开着')
        expect(last).not.toContain('闲下来之后被回执叫醒')
        return { content: '任务完成了，日志整理好了' }
      }
      timeline.push('dispatched')
      return { content: '安排了，做完告诉你' }
    }, supervisor)
    agent = newCompanion(services)
    const steps: AgentStep[] = []

    const runPromise = agent.run('帮我整理日志', ctx(), {
      callbacks: { onStep: (_id, step) => { steps.push({ ...step }) } }
    })
    await sleep(300)

    // 说完「安排了」之后这一轮还开着，界面上有等待卡
    expect(timeline).toEqual(['dispatched'])
    expect(agent.isRunning()).toBe(true)
    expect(steps.some(s => s.type === 'tool_call' && s.toolName === 'manage_tasks' && String(s.content).includes('整理日志') && s.toolArgs?.action === 'await')).toBe(true)

    // 任务做完，回执在这一轮里送到
    const taskKey = String(steps.find(s => s.type === 'tool_result' && String(s.toolResult).includes('task_id='))?.toolResult).match(/task_id=(assistant-[\w-]+)/)![1]
    supervisor.handleRunFinished(taskKey, { status: 'success', summary: '整理好了', ledBy: 'companion' })
    await supervisor.flushPendingEvents()

    const result = await runPromise
    expect(result).toContain('任务完成了')
    expect(timeline).toEqual(['dispatched', 'receipt-read'])
    // 回执是这一轮自己读到的，不是另起一轮
    expect(steps.some(s => s.type === 'task_receipt')).toBe(true)
    expect(agent.isRunning()).toBe(false)
  }, 15000)

  it('等的时候用户插话：先回答，之后接着等；回执到了照样在这一轮里处理', async () => {
    const timeline: string[] = []
    let agent!: SailFish
    const { supervisor } = makeSupervisor(receipt => agent.deliverTaskReceipt(receipt, { fallbackContext: ctx() }))
    const services = makeServices(({ index, messages }) => {
      const last = lastUserText(messages)
      if (index === 0) {
        return { tool_calls: [tc('manage_tasks', { action: 'create', title: '整理日志', brief: '把日志整理一下' })] }
      }
      if (last.includes('任务回执')) {
        timeline.push('receipt-read')
        return { content: '任务完成了' }
      }
      if (last.includes('顺便问一句')) {
        timeline.push('answered')
        return { content: '任务还在做，别担心' }
      }
      timeline.push('dispatched')
      return { content: '安排了' }
    }, supervisor)
    agent = newCompanion(services)
    const steps: AgentStep[] = []

    const runPromise = agent.run('帮我整理日志', ctx(), {
      callbacks: { onStep: (_id, step) => { steps.push({ ...step }) } }
    })
    await sleep(300)
    agent.addUserMessage('顺便问一句，现在几点')
    await sleep(300)

    expect(timeline).toEqual(['dispatched', 'answered'])
    expect(agent.isRunning()).toBe(true)

    const taskKey = String(steps.find(s => s.type === 'tool_result' && String(s.toolResult).includes('task_id='))?.toolResult).match(/task_id=(assistant-[\w-]+)/)![1]
    supervisor.handleRunFinished(taskKey, { status: 'success', summary: '好了', ledBy: 'companion' })
    await supervisor.flushPendingEvents()

    await runPromise
    expect(timeline).toEqual(['dispatched', 'answered', 'receipt-read'])
  }, 15000)

  it('用户按停联络：任务不被停；任务之后做完，回执另起一轮送来（用户不在场的尾巴）', async () => {
    const seen: string[] = []
    let agent!: SailFish
    const { supervisor, abort } = makeSupervisor(receipt => agent.deliverTaskReceipt(receipt, { fallbackContext: ctx() }))
    const services = makeServices(({ index, messages }) => {
      const last = lastUserText(messages)
      if (index === 0) {
        return { tool_calls: [tc('manage_tasks', { action: 'create', title: '整理日志', brief: '把日志整理一下' })] }
      }
      if (last.includes('任务回执')) {
        seen.push(last)
        return { content: '收到回执，没有打扰用户' }
      }
      return { content: '安排了' }
    }, supervisor)
    agent = newCompanion(services)
    const steps: AgentStep[] = []

    const runPromise = agent.run('帮我整理日志', ctx(), {
      callbacks: { onStep: (_id, step) => { steps.push({ ...step }) } }
    })
    await sleep(300)
    expect(agent.isRunning()).toBe(true)

    agent.abort()
    await runPromise
    expect(agent.isRunning()).toBe(false)
    expect(abort).not.toHaveBeenCalled()

    const taskKey = String(steps.find(s => s.type === 'tool_result' && String(s.toolResult).includes('task_id='))?.toolResult).match(/task_id=(assistant-[\w-]+)/)![1]
    supervisor.handleRunFinished(taskKey, { status: 'success', summary: '好了', ledBy: 'companion' })
    await supervisor.flushPendingEvents()

    await vi.waitFor(() => expect(seen).toHaveLength(1))
    expect(seen[0]).toContain('闲下来之后被回执叫醒')
    expect(seen[0]).not.toContain('你这一轮还开着')
  }, 15000)

  it('任务根本没跑起来（开跑失败）：联络这一轮马上收工，不守着一张空等的卡等到下一个检查点', async () => {
    let agent!: SailFish
    const { supervisor } = makeSupervisor(receipt => agent.deliverTaskReceipt(receipt, { fallbackContext: ctx() }), {
      say: async () => {
        await sleep(100)
        throw new Error('没有可用的模型')
      },
      wakeCompanionWait: () => agent.reassessHold(),
    })
    const services = makeServices(({ index }) => {
      if (index === 0) {
        return { tool_calls: [tc('manage_tasks', { action: 'create', title: '整理日志', brief: '把日志整理一下' })] }
      }
      return { content: '安排了' }
    }, supervisor)
    agent = newCompanion(services)
    const steps: AgentStep[] = []

    const runPromise = agent.run('帮我整理日志', ctx(), {
      callbacks: { onStep: (_id, step) => { steps.push({ ...step }) } }
    })
    await sleep(50)
    // 开跑失败之前确实是挂着等的
    expect(agent.isRunning()).toBe(true)

    const result = await Promise.race([
      runPromise,
      sleep(3000).then(() => 'still-holding'),
    ])
    expect(result).toContain('安排了')
    expect(agent.isRunning()).toBe(false)
  }, 15000)
})
