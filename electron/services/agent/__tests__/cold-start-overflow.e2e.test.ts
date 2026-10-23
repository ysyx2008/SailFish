/**
 * 冷启动装不下：任务平时带原文，原文装不下时这一次降级成五档，用户这句话照样发得出去。
 * 经真实 HistoryService 磁盘往返 + Agent.run（只有模型是假的）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { ConversationManager, ConversationStore } from '../../conversation'
import type { AgentRecord } from '@shared/types'

let tmpDir: string
let messagesByCall: any[][] = []

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
import { HistoryService } from '../../history.service'
import { ContextWindowManager } from '../context-window'
import { resolveRequestBudget } from '../../ai-request-budget'
import type { ToolDefinition } from '../../ai.service'
import type { AgentContext, AgentServices } from '../types'

const CONTEXT_LENGTH = 32000
/** system prompt 比冷启动首轮的缺省估值（4000）大得多：第一遍装载会低估固定开销 */
const BIG_SYSTEM_PROMPT = `test system prompt\n${'S'.repeat(40_000)}`
const bodyOf = (i: number) => `TOOL_BODY_${i}_${'长'.repeat(3000)}`

class TestAgent extends Agent {
  getAvailableTools(): ToolDefinition[] {
    return []
  }
  protected buildSystemPrompt(): string {
    return BIG_SYSTEM_PROMPT
  }
  protected getAgentId(): string {
    return 'test-agent'
  }
}

function makeServices(history: HistoryService): AgentServices {
  return {
    aiService: {
      chatWithToolsStream: vi.fn(
        (messages: any[], _t: unknown, onChunk: (s: string) => void, _otc: unknown, onDone: (r: unknown) => void) => {
          messagesByCall.push(JSON.parse(JSON.stringify(messages)))
          onChunk('好的')
          onDone({ content: '好的', tool_calls: undefined })
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
      getAiProfiles: vi.fn().mockReturnValue([{ id: 'test', contextLength: CONTEXT_LENGTH }]),
      getActiveAiProfile: vi.fn().mockReturnValue('test'),
      getAgentOnboardingCompleted: vi.fn().mockReturnValue(true),
      hasVisionCapability: vi.fn().mockReturnValue(true)
    } as any,
    historyService: history as any,
    conversationManager: new ConversationManager(new ConversationStore(history.getAgentRecordStore()))
  }
}

function ctx(): AgentContext {
  return {
    terminalOutput: [],
    systemInfo: { os: 'darwin', shell: '/bin/zsh' },
    terminalType: 'assistant',
    sessionId: 'sess_long_task'
  } as AgentContext
}

function longTaskMessages(turns: number) {
  const messages: any[] = []
  for (let i = 0; i < turns; i++) {
    const id = `c${i}`
    messages.push({ role: 'user', content: `第 ${i} 件事：查一下日志` })
    messages.push({
      role: 'assistant',
      content: '',
      tool_calls: [{ id, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: `/tmp/log_${i}.txt` }) } }]
    })
    messages.push({ role: 'tool', content: bodyOf(i), tool_call_id: id })
    messages.push({ role: 'assistant', content: `第 ${i} 件事的结论：日志正常` })
  }
  return messages
}

function flatten(messages: any[]): string {
  return messages.map(m => {
    const args = m.tool_calls?.map((tc: any) => `${tc.function?.name} ${tc.function?.arguments}`).join('\n') ?? ''
    return `${typeof m.content === 'string' ? m.content : ''}\n${args}`
  }).join('\n')
}

describe('端到端：冷启动任务原文装不下 → 五档降级', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-cold-overflow-'))
    messagesByCall = []
  })
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('原文装不下时：这句话照样发出去，近处过程还在，远处过程收掉，每件事的原话和结论都在', async () => {
    const history1 = new HistoryService()
    const timestamp = Date.now()
    const turns = 5
    history1.saveAgentRecord({
      id: 'sess_long_task',
      timestamp,
      terminalId: 'pty-1',
      agentKey: 'tab-long',
      kind: 'task',
      terminalType: 'assistant',
      userTask: '第 0 件事：查一下日志',
      steps: [
        { id: 'ut', type: 'user_task', content: '第 0 件事：查一下日志', timestamp },
        { id: 'fr', type: 'final_result', content: 'done', timestamp }
      ],
      duration: 1000,
      status: 'completed',
      messages: longTaskMessages(turns)
    } as AgentRecord)

    const agent = new TestAgent(makeServices(new HistoryService()))
    agent.setAgentId('tab-long')
    await agent.run('接着查第六件事', ctx())

    expect(messagesByCall.length).toBeGreaterThan(0)
    const sent = messagesByCall[0]
    const text = flatten(sent)

    // 请求以用户这句话收尾，且没有被塞超
    expect(sent[sent.length - 1].role).toBe('user')
    expect(text).toContain('接着查第六件事')
    const inputLimit = resolveRequestBudget({ contextLength: CONTEXT_LENGTH } as any).inputLimit
    const window = new ContextWindowManager({
      config: { getAiProfiles: () => [{ id: 'p', contextLength: CONTEXT_LENGTH } as any], getActiveAiProfile: () => 'p' },
      getProfileId: () => undefined,
      getLastPromptTokens: () => undefined,
      getLastCacheHitRate: () => undefined,
      reportUsage: () => {}
    })
    expect(window.estimateMessagesTokens(sent)).toBeLessThanOrEqual(inputLimit)

    // 每件事的原话和结论都在
    for (let i = 0; i < turns; i++) {
      expect(text).toContain(`第 ${i} 件事：查一下日志`)
      expect(text).toContain(`第 ${i} 件事的结论：日志正常`)
    }
    // 最近一轮的过程是完整的；最早一轮的大段输出不再整段回来
    expect(text).toContain(bodyOf(turns - 1))
    expect(text).not.toContain(bodyOf(0))
  })

  it('原文装得下时仍然是原文，不降级', async () => {
    const history1 = new HistoryService()
    const timestamp = Date.now()
    history1.saveAgentRecord({
      id: 'sess_long_task',
      timestamp,
      terminalId: 'pty-1',
      agentKey: 'tab-long',
      kind: 'task',
      terminalType: 'assistant',
      userTask: '第 0 件事：查一下日志',
      steps: [
        { id: 'ut', type: 'user_task', content: '第 0 件事：查一下日志', timestamp },
        { id: 'fr', type: 'final_result', content: 'done', timestamp }
      ],
      duration: 1000,
      status: 'completed',
      messages: longTaskMessages(2)
    } as AgentRecord)

    const agent = new TestAgent(makeServices(new HistoryService()))
    agent.setAgentId('tab-long')
    await agent.run('接着查', ctx())

    const text = flatten(messagesByCall[0])
    expect(text).toContain(bodyOf(0))
    expect(text).toContain(bodyOf(1))
  })
})
