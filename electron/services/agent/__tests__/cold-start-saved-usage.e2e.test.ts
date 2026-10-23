/**
 * 重开旧会话：上次请求的真实用量随记录落盘，冷启动时对得上就以它为准判断装不装得下。
 * 经真实 HistoryService 磁盘往返 + Agent.run（只有模型是假的，且会报告我们指定的真实用量）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { ConversationManager, ConversationStore, Conversation } from '../../conversation'
import type { AgentRecord } from '@shared/types'

let tmpDir: string
let messagesByCall: any[][] = []
/** 假模型下一次报告的真实 prompt_tokens；没设就不报 */
let nextPromptTokens: number | undefined

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
import type { ToolDefinition } from '../../ai.service'
import type { AgentContext, AgentServices } from '../types'

const CONTEXT_LENGTH = 32000
/** 估算约 1 万 token；32K 窗口的输入上限约 2.3 万，原文估算装得下 */
const SYSTEM_PROMPT = `test system prompt\n${'S'.repeat(40_000)}`
const bodyOf = (i: number) => `TOOL_BODY_${i}_${'长'.repeat(3000)}`

class TestAgent extends Agent {
  getAvailableTools(): ToolDefinition[] {
    return []
  }
  protected buildSystemPrompt(): string {
    return SYSTEM_PROMPT
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
          const usage = nextPromptTokens === undefined
            ? undefined
            : { prompt_tokens: nextPromptTokens, completion_tokens: 5, total_tokens: nextPromptTokens + 5 }
          onDone({ content: '好的', tool_calls: undefined, usage })
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
    sessionId: 'sess_saved_usage'
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

function seedRecord(history: HistoryService, turns: number, lastPromptUsage?: AgentRecord['lastPromptUsage']) {
  const timestamp = Date.now()
  history.saveAgentRecord({
    id: 'sess_saved_usage',
    timestamp,
    terminalId: 'pty-1',
    agentKey: 'tab-usage',
    kind: 'task',
    terminalType: 'assistant',
    userTask: '第 0 件事：查一下日志',
    steps: [
      { id: 'ut', type: 'user_task', content: '第 0 件事：查一下日志', timestamp },
      { id: 'fr', type: 'final_result', content: 'done', timestamp }
    ],
    duration: 1000,
    status: 'completed',
    messages: longTaskMessages(turns),
    ...(lastPromptUsage ? { lastPromptUsage } : {})
  } as AgentRecord)
}

function flatten(messages: any[]): string {
  return messages.map(m => {
    const args = m.tool_calls?.map((tc: any) => `${tc.function?.name} ${tc.function?.arguments}`).join('\n') ?? ''
    return `${typeof m.content === 'string' ? m.content : ''}\n${args}`
  }).join('\n')
}

async function reopenAndRun(message: string): Promise<string> {
  const agent = new TestAgent(makeServices(new HistoryService()))
  agent.setAgentId('tab-usage')
  await agent.run(message, ctx())
  return flatten(messagesByCall[0])
}

describe('端到端：重开旧会话，用记下的真实用量判断装不装得下', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-cold-saved-usage-'))
    messagesByCall = []
    nextPromptTokens = undefined
  })
  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('估算觉得装得下、记下的真实用量说装不下：这一次降级重装，不把大段输出整段带回', async () => {
    // 2 轮 = 8 条消息；请求带了 system + 前 7 条 = 8 条，回复排在第 8 位
    seedRecord(new HistoryService(), 2, { promptTokens: 26_000, messageCount: 8 })
    const text = await reopenAndRun('接着查')

    expect(text).toContain('接着查')
    expect(text).toContain(bodyOf(1))
    expect(text).not.toContain(bodyOf(0))
  })

  it('记下的真实用量说装得下：照常带原文', async () => {
    seedRecord(new HistoryService(), 2, { promptTokens: 12_000, messageCount: 8 })
    const text = await reopenAndRun('接着查')

    expect(text).toContain(bodyOf(0))
    expect(text).toContain(bodyOf(1))
  })

  it('历史和记下的位置对不上（条数不符）：不采用，仍按估算带原文', async () => {
    seedRecord(new HistoryService(), 2, { promptTokens: 26_000, messageCount: 5 })
    const text = await reopenAndRun('接着查')

    expect(text).toContain(bodyOf(0))
    expect(text).toContain(bodyOf(1))
  })

  it('没有记下用量的老记录：行为和以前一样', async () => {
    seedRecord(new HistoryService(), 2)
    const text = await reopenAndRun('接着查')

    expect(text).toContain(bodyOf(0))
    expect(text).toContain(bodyOf(1))
  })

  it('真实跑完一轮落盘，再重开：记下的位置恰好对得上这次装好的历史', async () => {
    const history1 = new HistoryService()
    const agent1 = new TestAgent(makeServices(history1))
    agent1.setAgentId('tab-usage')
    nextPromptTokens = 3_000
    await agent1.run('第一件事', ctx())
    await agent1.run('第二件事', ctx())

    const saved = new HistoryService().getAgentRecordById('sess_saved_usage')
    expect(saved?.lastPromptUsage).toEqual({ promptTokens: 3_000, messageCount: expect.any(Number) })

    messagesByCall = []
    const adopt = vi.spyOn(Conversation.prototype, 'adoptSavedPromptUsage')
    const agent2 = new TestAgent(makeServices(new HistoryService()))
    agent2.setAgentId('tab-usage')
    await agent2.run('第三件事', ctx())

    expect(adopt).toHaveBeenCalled()
    expect(adopt.mock.results.some(r => r.value === true)).toBe(true)
  })
})
