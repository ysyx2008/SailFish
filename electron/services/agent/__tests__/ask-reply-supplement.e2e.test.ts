/**
 * 题开着时从输入框发图或写字：等待停下来，内容原样进下一轮，不写成用户回复。
 * 点选项仍是直接作答，不另冒一条消息。
 * 真实 SailFish.run() + 脚本化模型。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import type { ToolDefinition } from '../../ai.service'
import type { AgentContext, AgentServices, AgentStep } from '../types'

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

type Msg = { role?: string; content?: unknown; images?: string[]; tool_calls?: unknown }
type LlmResponse = {
  content?: string
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
}

const IMG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/portrait'

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitFor(pred: () => boolean, ms = 8000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting')
    await sleep(40)
  }
}

function tc(name: string, args: Record<string, unknown>, id = `tc-${name}`) {
  return { id, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } }
}

function textOf(messages: Msg[], role: string): string {
  return messages.filter(m => m.role === role).map(m => String(m.content ?? '')).join('\n')
}

function latestAsking(steps: AgentStep[]): AgentStep | undefined {
  return [...steps].reverse().find(s => s.type === 'asking')
}

function makeServices(responder: (call: { index: number; messages: Msg[] }) => LlmResponse): AgentServices {
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
          const r = responder({ index: index++, messages: JSON.parse(JSON.stringify(messages)) })
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

function askCall() {
  return {
    content: '问你一下',
    tool_calls: [tc('ask_user', {
      question: '这张原始表情的形象照可以吗？',
      options: ['就用这张，桌面那三张微笑版清掉', '再调一版'],
      default_value: '就用这张，桌面那三张微笑版清掉',
      timeout: 30,
    })]
  }
}

describe('题开着时输入框发来的由模型自己看', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-ask-reply-e2e-'))
  })
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('只发图就结束等待，不选推荐项，图在下一轮', async () => {
    const calls: Msg[][] = []
    const services = makeServices(({ messages }) => {
      calls.push(messages)
      if (calls.length === 1) return askCall()
      return { content: '看到这张了' }
    })
    const agent = newAgent(services, 'e2e-ask-image')
    const steps: AgentStep[] = []
    const runPromise = agent.run('看看这张形象照', ctx(), {
      callbacks: { onStep: (_id, step) => { steps.push({ ...step }) } }
    })

    await waitFor(() => latestAsking(steps)?.askingStatus === 'waiting')
    agent.addUserMessage('', undefined, undefined, [IMG])
    const result = await runPromise

    expect(result).toContain('看到这张了')
    expect(calls).toHaveLength(2)
    expect(latestAsking(steps)?.askingStatus).toBe('received')
    expect(latestAsking(steps)?.askingAnswer).toBeUndefined()

    const seen = calls[1]
    const toolText = textOf(seen, 'tool')
    expect(toolText).toContain('没有点选项')
    expect(toolText).not.toContain('使用默认值')
    expect(toolText).not.toContain('用户回复')
    expect(seen.some(m => m.role === 'user' && m.images?.includes(IMG))).toBe(true)
    expect(steps.some(s => s.type === 'user_supplement' && s.images?.includes(IMG))).toBe(true)
  }, 20000)

  it('写了字也只是一条消息，不写成用户回复', async () => {
    const calls: Msg[][] = []
    const services = makeServices(({ messages }) => {
      calls.push(messages)
      if (calls.length === 1) return askCall()
      return { content: '收到，按你写的再调一版' }
    })
    const agent = newAgent(services, 'e2e-ask-text')
    const steps: AgentStep[] = []
    const runPromise = agent.run('看看这张形象照', ctx(), {
      callbacks: { onStep: (_id, step) => { steps.push({ ...step }) } }
    })

    await waitFor(() => latestAsking(steps)?.askingStatus === 'waiting')
    agent.addUserMessage('再调一版', undefined, undefined, [IMG])
    const result = await runPromise

    expect(result).toContain('再调一版')
    expect(latestAsking(steps)?.askingStatus).toBe('received')
    expect(latestAsking(steps)?.askingAnswer).toBeUndefined()
    expect(latestAsking(steps)?.toolResult).not.toContain('再调一版')

    const seen = calls[1]
    const toolText = textOf(seen, 'tool')
    expect(toolText).toContain('没有点选项')
    expect(toolText).not.toContain('用户回复：再调一版')
    expect(toolText).not.toContain('使用默认值')
    const supplement = seen.filter(m => m.role === 'user' && String(m.content).includes('再调一版'))
    expect(supplement).toHaveLength(1)
    expect(supplement[0].images).toContain(IMG)
  }, 20000)

  it('点选项只结题，不另冒一条消息', async () => {
    const calls: Msg[][] = []
    const services = makeServices(({ messages }) => {
      calls.push(messages)
      if (calls.length === 1) return askCall()
      return { content: '就用这张' }
    })
    const agent = newAgent(services, 'e2e-ask-click')
    const steps: AgentStep[] = []
    const runPromise = agent.run('看看这张形象照', ctx(), {
      callbacks: { onStep: (_id, step) => { steps.push({ ...step }) } }
    })

    await waitFor(() => latestAsking(steps)?.askingStatus === 'waiting')
    agent.addUserMessage('就用这张，桌面那三张微笑版清掉', undefined, undefined, undefined, undefined, true)
    const result = await runPromise

    expect(result).toContain('就用这张')
    expect(latestAsking(steps)?.askingStatus).toBe('received')
    expect(latestAsking(steps)?.askingAnswer).toBe('就用这张，桌面那三张微笑版清掉')
    expect(steps.some(s => s.type === 'user_supplement')).toBe(false)

    const seen = calls[1]
    expect(textOf(seen, 'tool')).toContain('用户回复：就用这张，桌面那三张微笑版清掉')
    const userText = textOf(seen, 'user')
    expect(userText).not.toContain('就用这张，桌面那三张微笑版清掉')
  }, 20000)
})
