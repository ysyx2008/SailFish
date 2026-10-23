/**
 * 伙计的对话和进度随主会话存盘：真实 SailFish.run() + 真实写盘 + 脚本化模型。
 * 测的是整条链路：派出 → 每轮存盘 → 做完 / 停止 / 失败 → 盘上留下什么 →（被中断后）重开接着干。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { ConversationManager, ConversationStore } from '../../conversation'
import type { AiMessage, ToolDefinition } from '../../ai.service'
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
import { HistoryService } from '../../history.service'

type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } }
type LlmResponse = { content?: string; tool_calls?: ToolCall[] }
type Msg = { role?: string; content?: unknown; tool_calls?: unknown; tool_call_id?: string }

let calls: Array<{ who: string; tools: string[]; messages: Msg[] }> = []
let n = 0

function tc(name: string, args: Record<string, unknown>): ToolCall {
  return { id: `tc-${++n}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}

function text(messages: Msg[]): string {
  return messages.map(m => String(m.content ?? '')).join('\n')
}

/** 认人：伙计开工第一条话里带着自己的指令，指令里写着名字 */
function whoIs(messages: Msg[], tools: string[]): string {
  if (tools.includes('dispatch_agents')) return 'parent'
  const all = text(messages)
  for (const name of ['alice', 'bob']) {
    if (all.includes(`我是${name}`)) return name
  }
  return 'unknown'
}

function makeServices(respond: (who: string, messages: Msg[]) => LlmResponse | Promise<LlmResponse>): AgentServices {
  const inflight = new Set<() => void>()
  return {
    aiService: {
      chat: vi.fn().mockResolvedValue(''),
      chatWithTools: vi.fn().mockResolvedValue({ content: '', tool_calls: [] }),
      chatWithToolsStream: vi.fn(async (
        messages: Msg[],
        tools: ToolDefinition[],
        onChunk: (s: string) => void,
        _onToolCall: unknown,
        onDone: (r: unknown) => void,
        onError?: (e: string) => void,
      ) => {
        const names = tools.map(t => t.function.name)
        const who = whoIs(messages, names)
        calls.push({ who, tools: names, messages: JSON.parse(JSON.stringify(messages)) })
        let cancelled = false
        const cancel = () => { cancelled = true }
        inflight.add(cancel)
        try {
          await new Promise(r => setTimeout(r, 5))
          const r = await respond(who, messages)
          if (cancelled) {
            onError?.('aborted')
            return
          }
          if (r.content) onChunk(r.content)
          onDone({ content: r.content ?? '', tool_calls: r.tool_calls })
        } finally {
          inflight.delete(cancel)
        }
      }),
      abort: vi.fn(() => {
        for (const cancel of inflight) cancel()
        inflight.clear()
      }),
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

function newParent(services: AgentServices, history: HistoryService, id: string): SailFish {
  services.historyService = history as any
  services.conversationManager = new ConversationManager(new ConversationStore(history.getAgentRecordStore()))
  const parent = new SailFish(services)
  parent.setAgentId(id)
  parent.updateConfig({ executionMode: 'free' })
  return parent
}

function ctx(): AgentContext {
  return {
    terminalOutput: [],
    systemInfo: { os: 'darwin', shell: '/bin/zsh' },
    terminalType: 'assistant',
    cwd: tmpDir,
  }
}

/** 盘里读回来的对话（记录里的消息没有写死类型） */
function messagesOf(record: { messages?: unknown[] }): AiMessage[] {
  return (record.messages ?? []) as AiMessage[]
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error('等不到')
    await sleep(10)
  }
}

describe('伙计的对话随主会话存盘（真实 SailFish.run）', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-subagent-persist-'))
    calls = []
  })
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('做完之后：每位的状态、结果和整段对话（含工具往返）都在主会话下面；不进最近对话；相同开局只存一份', async () => {
    const fixture = path.join(tmpDir, 'nginx.conf')
    fs.writeFileSync(fixture, 'listen 8848;\n', 'utf-8')
    const history = new HistoryService()
    const turns: Record<string, number> = { alice: 0, bob: 0 }

    const services = makeServices((who, messages) => {
      if (who === 'parent') {
        if (!text(messages).includes('已派出')) {
          return {
            tool_calls: [tc('dispatch_agents', {
              tasks: [
                { name: 'alice', description: '读配置', prompt: `我是alice，读 ${fixture} 回报端口` },
                { name: 'bob', description: '读配置二', prompt: `我是bob，读 ${fixture} 回报端口` },
              ],
            })],
          }
        }
        return { content: '收到，等他们' }
      }
      turns[who]++
      return turns[who] === 1
        ? { tool_calls: [tc('read_file', { path: fixture })] }
        : { content: `${who}：端口 8848` }
    })

    const parent = newParent(services, history, 'e2e-persist-parent')
    await parent.run('查一下端口', ctx())

    const sessionId = parent.getSessionId()!
    const store = history.getAgentRecordStore()
    const children = store.subAgents.list(sessionId)
    expect(children.map(c => c.state.name).sort()).toEqual(['alice', 'bob'])
    for (const child of children) {
      expect(child.state.status).toBe('completed')
      expect(child.state.result).toContain('端口 8848')
      expect(child.state.prompt).toContain(`我是${child.state.name}`)

      const record = store.subAgents.readRecord(child)!
      const roles = messagesOf(record).map(m => m.role)
      expect(roles).toEqual(['user', 'assistant', 'tool', 'assistant'])
      expect(messagesOf(record)[0].content).toContain(`我是${child.state.name}`)
      expect(messagesOf(record)[1].tool_calls?.[0].function.name).toBe('read_file')
      expect(messagesOf(record)[2].content).toContain('listen 8848')
      expect(String(messagesOf(record)[3].content)).toContain('端口 8848')
    }

    // 两位开局带的主人对话相同，只存一份；主人对话里有用户的原话
    const openingKeys = new Set(children.map(c => c.state.opening))
    expect(openingKeys.size).toBe(1)
    const opening = store.subAgents.readOpening(sessionId, children[0].state.opening)
    expect(opening.some(m => m.role === 'user' && String(m.content).includes('查一下端口'))).toBe(true)

    // 不进最近对话和历史搜索
    const ids = store.getAllIndexEntries().map(e => e.id)
    expect(ids).toEqual([sessionId])
    expect(store.getRecentAgentRecords(10).map(r => r.id)).toEqual([sessionId])
  })

  it('用户按停止：做到一半的伙计留下「被中断」和被打断的那一步，已做完的伙计和已写出的文件照旧', async () => {
    const history = new HistoryService()
    const target = path.join(tmpDir, 'half.txt')
    let aliceTurn = 0
    let bobTurn = 0
    let slowToolAnnounced = false

    const services = makeServices((who, messages) => {
      if (who === 'parent') {
        if (!text(messages).includes('已派出')) {
          return {
            tool_calls: [tc('dispatch_agents', {
              tasks: [
                { name: 'alice', description: '写文件', prompt: '我是alice，写一份文件然后做一件很慢的事' },
                { name: 'bob', description: '很快做完', prompt: '我是bob，说一句话就行' },
              ],
            })],
          }
        }
        return { content: '等他们' }
      }
      if (who === 'alice') {
        aliceTurn++
        if (aliceTurn === 1) return { tool_calls: [tc('write_text_file', { path: target, content: 'half', mode: 'create' })] }
        slowToolAnnounced = true
        return { tool_calls: [tc('exec', { command: 'sleep 30' })] }
      }
      bobTurn++
      return { content: 'bob 说完了' }
    })

    const parent = newParent(services, history, 'e2e-persist-stop')
    const running = parent.run('派两位去干活', ctx()).catch(() => undefined)

    await until(() => slowToolAnnounced)
    await sleep(300)
    parent.abort()
    await running

    const sessionId = parent.getSessionId()!
    const store = history.getAgentRecordStore()
    const listed = () => Object.fromEntries(store.subAgents.list(sessionId).map(c => [c.state.name, c]))
    // 主人这一轮收了工，被打断的伙计随后才收完尾（把现场写下来）
    await until(() => !!listed().alice?.state.error)
    const byName = listed()

    expect(byName.bob.state.status).toBe('completed')
    expect(bobTurn).toBe(1)

    expect(byName.alice.state.status).toBe('interrupted')
    const record = store.subAgents.readRecord(byName.alice)!
    expect(messagesOf(record)[0].content).toContain('我是alice')
    const callsMade = messagesOf(record).flatMap(m => m.tool_calls?.map(t => t.function.name) ?? [])
    expect(callsMade).toEqual(['write_text_file', 'exec'])
    // 被打断的那一步有了结果（命令被停掉），对话序列是完整的
    const execAt = messagesOf(record).findIndex(m => m.tool_calls?.[0]?.function.name === 'exec')
    expect(messagesOf(record)[execAt + 1].role).toBe('tool')
    expect(fs.readFileSync(target, 'utf-8')).toBe('half')
  })
})
