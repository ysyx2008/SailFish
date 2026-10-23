/**
 * 联络没有产出物面板：它手里没有查看 / 维护面板的工具，系统说明里也不提这块面板；
 * 即便照着旧记录硬调，也被当作「没有这个工具」拒绝，不会被告知「已在面板打开」。
 * 对照：独立助手页的任务照旧有面板、能打开。
 * 真实 SailFish.run() + 脚本化模型，经真实工具执行链路。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import type { ToolDefinition } from '../../ai.service'
import type { AgentContext, AgentServices } from '../types'
import type { AgentStep } from '@shared/types'

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

type Msg = { role?: string; content?: unknown; tool_calls?: unknown; tool_call_id?: string }
type LlmResponse = {
  content?: string
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
}

const PANEL_TOOLS = ['list_workbench_artifacts', 'manage_workbench_artifacts']

function openCall(filePath: string): LlmResponse {
  return {
    tool_calls: [{
      id: 'tc-open',
      type: 'function',
      function: { name: 'manage_workbench_artifacts', arguments: JSON.stringify({ action: 'open', path: filePath }) }
    }]
  }
}

/** streaming=true 时按真实模型服务的做法：tool_call 参数一完整就交给流式执行器提前开跑 */
function makeServices(responder: (index: number) => LlmResponse, streaming = false) {
  const calls: Array<{ messages: Msg[]; toolNames: string[] }> = []
  const services = {
    aiService: {
      chat: vi.fn().mockResolvedValue(''),
      chatWithToolsStream: vi.fn(async (
        messages: Msg[],
        tools: ToolDefinition[],
        onChunk: (s: string) => void,
        _onToolCall: unknown,
        onDone: (r: unknown) => void,
        _onError: unknown,
        _profileId: unknown,
        _onToolCallProgress: unknown,
        _requestId: unknown,
        _onRetry: unknown,
        onToolCallReady?: (toolCall: unknown) => void,
      ) => {
        const index = calls.length
        calls.push({
          messages: JSON.parse(JSON.stringify(messages)),
          toolNames: tools.map(t => t.function.name),
        })
        const r = responder(index)
        const content = r.content ?? ''
        if (content) onChunk(content)
        if (streaming) for (const call of r.tool_calls ?? []) onToolCallReady?.(call)
        onDone({ content, tool_calls: r.tool_calls })
      }),
      abort: vi.fn()
    },
    ptyService: { onData: vi.fn().mockReturnValue(() => {}), write: vi.fn() },
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
    },
    hostProfileService: {
      generateHostContext: vi.fn().mockReturnValue(''),
      addNote: vi.fn(),
      getProfile: vi.fn().mockReturnValue(null)
    },
    historyService: undefined,
    conversationManager: undefined
  } as unknown as AgentServices
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

function newAgent(services: AgentServices, agentKey: string): SailFish {
  const agent = new SailFish(services)
  agent.setAgentId(agentKey)
  if (agentKey.startsWith('__')) agent.markAsPersistentNamed()
  agent.updateConfig({ executionMode: 'free' })
  return agent
}

const systemPromptOf = (messages: Msg[]) =>
  messages.filter(m => m.role === 'system').map(m => String(m.content ?? '')).join('\n')

const toolReplyIn = (messages: Msg[], id: string) =>
  String(messages.find(m => m.role === 'tool' && m.tool_call_id === id)?.content ?? '')

describe('联络没有产出物面板', () => {
  let doc: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-no-panel-e2e-'))
    doc = path.join(tmpDir, '培训方案.md')
    fs.writeFileSync(doc, '# 培训方案\n\n第一期：本月下旬。\n', 'utf-8')
  })
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it.each([false, true])('联络（流式=%s）：模型看到的工具和系统说明里都没有面板；硬调被当作没有这个工具拒绝，没有任何面板步骤', async (streaming) => {
    const { services, calls } = makeServices(index =>
      index === 0 ? openCall(doc) : { content: '文件在桌面上，你自己打开看。' }
    , streaming)
    const agent = newAgent(services, '__companion__')
    const steps: AgentStep[] = []
    agent.setCallbacks({ onStep: (_id: string, s: AgentStep) => { steps.push(s) } })

    await agent.run('把方案给我看看', ctx(), {})

    expect(calls.length).toBe(2)
    for (const name of PANEL_TOOLS) expect(calls[0].toolNames).not.toContain(name)
    expect(calls[0].toolNames).toContain('manage_tasks') // 联络自己的工具还在
    expect(systemPromptOf(calls[0].messages)).not.toContain('产出物面板')

    const reply = toolReplyIn(calls[1].messages, 'tc-open')
    expect(reply).toMatch(/未知工具|Unknown tool/)
    expect(reply).not.toContain('已在产出物面板打开')
    expect(steps.some(s => s.canvasData)).toBe(false)
  }, 15000)

  it.each([false, true])('对照（流式=%s）：独立助手页的任务有面板工具，打开成功并推出产出物', async (streaming) => {
    const { services, calls } = makeServices(index =>
      index === 0 ? openCall(doc) : { content: '已打开。' }
    , streaming)
    const agent = newAgent(services, 'assistant-tab-e2e')
    const steps: AgentStep[] = []
    agent.setCallbacks({ onStep: (_id: string, s: AgentStep) => { steps.push(s) } })

    await agent.run('把方案打开', ctx(), {})

    for (const name of PANEL_TOOLS) expect(calls[0].toolNames).toContain(name)
    expect(toolReplyIn(calls[1].messages, 'tc-open')).toContain('已在产出物面板打开')
    expect(steps.some(s => s.canvasData?.action === 'open' && s.canvasData.filePath === doc)).toBe(true)
  }, 15000)
})
