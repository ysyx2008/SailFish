/**
 * 技能文档不重复的端到端：联络里装上一份「正文自带一级标题」的用户技能，连聊多轮，
 * 每一次发给模型的系统提示词里文档只能有一份，且各轮逐字不变（前缀缓存才吃得住）；
 * 卸掉技能后文档整份撤走；重启后接着一份被旧版补丁重复污染的检查点，下一句就自动清干净。
 * 只有模型是脚本，Agent、技能装卸工具、提示词构建、用户技能读盘、历史落盘都是真的。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { ToolDefinition } from '../../ai.service'
import type { AgentContext } from '@shared/types'

let dataDir: string

vi.mock('electron', () => ({
  app: {
    getPath: () => dataDir,
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

vi.mock('../../split-pane-bridge.service', () => ({
  splitPaneBridge: { exec: vi.fn() }
}))

import { HistoryService } from '../../history.service'
import { ConversationManager, ConversationStore } from '../../conversation'
import { AgentService } from '../index'
import type { AgentRecord } from '@shared/types'

type Msg = { role?: string; content?: unknown }
type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } }
type Call = { system: string; messages: Msg[] }

const AGENT_KEY = '__companion__'
const SKILL_ID = 'user:printer-helper'
const DOC_H1 = '# 打印助手'
const SKILL_DOC = [
  DOC_H1,
  '',
  '在本机打印文件到家庭喷墨打印机。排版脚本在本机运行。',
  '',
  '## 一、打印机环境',
  '',
  '队列名 EPSON_L6170，本地局域网。',
  '',
  '## 二、实测参数',
  '',
  '用 lpoptions 列出的键名为准。',
].join('\n')

function tc(name: string, args: Record<string, unknown>, id: string): ToolCall {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}

/**
 * 系统提示词里技能文档正文出现了几份。
 * 按「行首的一级标题」数：装载时正文会被包在 `## 打印助手` 下面，不能按子串数，否则一份被数成两份。
 */
function docCopies(system: string): number {
  return (system.match(/^# 打印助手$/gm) ?? []).length
}

describe('技能文档刷新（联络会话端到端）', () => {
  let history: HistoryService
  const calls: Call[] = []

  function makeServices() {
    return {
      aiService: {
        chat: vi.fn().mockResolvedValue(''),
        chatWithToolsStream: vi.fn(async (
          messages: Msg[],
          _tools: ToolDefinition[],
          onChunk: (s: string) => void,
          _onToolCall: unknown,
          onDone: (r: unknown) => void,
        ) => {
          const system = String(messages.find(m => m.role === 'system')?.content ?? '')
          calls.push({ system, messages: JSON.parse(JSON.stringify(messages)) })
          const r = respond(messages, calls.length)
          if (r.content) onChunk(r.content)
          onDone({ content: r.content ?? '', tool_calls: r.tool_calls })
        }),
        abort: vi.fn(),
      },
      ptyService: { onData: vi.fn().mockReturnValue(() => {}), write: vi.fn() },
      configService: {
        get: vi.fn().mockReturnValue(undefined),
        getAgentMbti: vi.fn().mockReturnValue(null),
        getAiRules: vi.fn().mockReturnValue(''),
        getAgentPersonalityText: vi.fn().mockReturnValue(''),
        getAgentName: vi.fn().mockReturnValue(''),
        getLanguage: vi.fn().mockReturnValue('zh-CN'),
        getAiProfiles: vi.fn().mockReturnValue([{ id: 'test', contextLength: 1_000_000 }]),
        getActiveAiProfile: vi.fn().mockReturnValue('test'),
        getAgentOnboardingCompleted: vi.fn().mockReturnValue(true),
        hasVisionCapability: vi.fn().mockReturnValue(true),
        getCommandRiskPolicy: vi.fn().mockReturnValue(undefined),
        getMcpServers: vi.fn().mockReturnValue([]),
      },
      hostProfileService: {
        generateHostContext: vi.fn().mockReturnValue(''),
        addNote: vi.fn(),
        getProfile: vi.fn().mockReturnValue(null),
      },
      historyService: history,
      conversationManager: new ConversationManager(new ConversationStore(history.getAgentRecordStore())),
    }
  }

  function makeAgentService(): AgentService {
    const services = makeServices()
    const svc = new AgentService(
      services.aiService as never,
      services.ptyService as never,
      services.hostProfileService as never,
      undefined,
      services.configService as never,
    )
    svc.setHistoryService(history)
    const agent = svc.getOrCreateAgent(AGENT_KEY)
    ;(agent as unknown as { services: unknown }).services = services
    return svc
  }

  function respond(messages: Msg[], n: number): { content?: string; tool_calls?: ToolCall[] } {
    const lastUserIdx = messages.map(m => m.role).lastIndexOf('user')
    const ask = String(messages[lastUserIdx]?.content ?? '')
    const toolTexts = messages.slice(lastUserIdx + 1).filter(m => m.role === 'tool')

    if (ask.includes('装上打印助手')) {
      if (toolTexts.length === 0) return { tool_calls: [tc('skill', { action: 'load', skill_id: SKILL_ID }, `load-${n}`)] }
      return { content: '装好了' }
    }
    if (ask.includes('卸掉打印助手')) {
      if (toolTexts.length === 0) return { tool_calls: [tc('skill', { action: 'unload', skill_id: SKILL_ID }, `unload-${n}`)] }
      return { content: '卸掉了' }
    }
    return { content: '好的' }
  }

  function ctx(extra?: Partial<AgentContext>): AgentContext {
    return {
      mode: 'single',
      terminalOutput: [],
      systemInfo: { os: 'macos', shell: '/bin/zsh' },
      terminalType: 'assistant',
      ...extra,
    }
  }

  function say(svc: AgentService, message: string, extra?: Partial<AgentContext>): Promise<string> {
    return svc.run(AGENT_KEY, message, ctx(extra), { executionMode: 'free' })
  }

  beforeAll(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-skill-doc-e2e-'))
    const skillDir = path.join(dataDir, 'skills', 'printer-helper')
    fs.mkdirSync(skillDir, { recursive: true })
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      `---\nname: 打印助手\ndescription: 打印文件到家庭打印机\n---\n${SKILL_DOC}\n`,
    )
    history = new HistoryService()
  })

  afterAll(() => {
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it('装上正文自带一级标题的技能后连聊多轮：每轮文档只有一份，提示词逐字不变；卸掉后整份撤走', async () => {
    const svc = makeAgentService()

    const from = calls.length
    await expect(say(svc, '装上打印助手')).resolves.toContain('装好了')
    const loadTurn = calls.slice(from)
    expect(loadTurn.length).toBe(2)
    // 装载当轮：文档经工具结果交给模型，系统提示词的清单与文档从下一句起刷新（原有设计）
    expect(docCopies(loadTurn[0].system)).toBe(0)
    const toolOut = loadTurn[1].messages.filter(m => m.role === 'tool').map(m => String(m.content)).join('\n')
    expect(toolOut).toContain('EPSON_L6170')

    // 连聊 8 轮，走的是复用上一轮前缀那条路
    const chatSystems: string[] = []
    for (let i = 0; i < 8; i++) {
      const at = calls.length
      await expect(say(svc, `嗯，第 ${i} 句闲聊`)).resolves.toContain('好的')
      expect(calls.length - at).toBe(1)
      chatSystems.push(calls[at].system)
    }
    for (const system of chatSystems) expect(docCopies(system)).toBe(1)
    // 各轮逐字相同——前缀缓存才不会每句话都被打穿
    expect(new Set(chatSystems).size).toBe(1)
    expect(chatSystems[0]).toContain('打印助手（user:printer-helper）')

    // 落盘的会话里同样只有一份（重启后带回来的就是这份）
    const saved = history.getRecentRecordsByAgentKey(AGENT_KEY, 1)[0] as AgentRecord & { workingContext?: Msg[] }
    expect(saved).toBeTruthy()

    // 卸掉技能：当轮系统提示词照旧（与装载对称，下一句才刷新），下一句起文档整份撤走、清单如实说没有
    const unloadAt = calls.length
    await expect(say(svc, '卸掉打印助手')).resolves.toContain('卸掉了')
    expect(calls.length - unloadAt).toBe(2)

    const laterSystems: string[] = []
    for (let i = 0; i < 3; i++) {
      const at = calls.length
      await say(svc, `卸掉之后第 ${i} 句`)
      laterSystems.push(calls[at].system)
    }
    for (const system of laterSystems) {
      expect(docCopies(system)).toBe(0)
      expect(system).not.toContain('EPSON_L6170')
      expect(system).toContain('当前没有开着的技能')
    }
    expect(new Set(laterSystems).size).toBe(1)
  }, 60000)

  it('重启后接着一份被旧版补丁重复污染的检查点：下一句就自动清干净，别的内容不丢', async () => {
    // 以上一个用例里真实产出的提示词为底，还原线上现场：清单被写成「没有开着」，其后残留 23 份文档
    const clean = calls[calls.length - 1].system
    const rosterAt = clean.indexOf('# 这场对话开着的技能')
    expect(rosterAt).toBeGreaterThan(0)
    const noneRoster = '# 这场对话开着的技能\n\n当前没有开着的技能。只认这一节，不要凭对话里有没有 load 过来猜。'
    const polluted =
      clean.slice(0, rosterAt) +
      noneRoster +
      Array.from({ length: 23 }, () => `\n\n${SKILL_DOC}`).join('')
    expect(docCopies(polluted)).toBe(23)
    const head = clean.slice(0, 200)

    const ts = Date.now() - 60_000
    history.saveAgentRecord({
      id: 'sess_polluted_checkpoint',
      timestamp: ts,
      terminalId: 'pty-1',
      agentKey: AGENT_KEY,
      kind: 'companion',
      terminalType: 'assistant',
      userTask: '之前聊过的事',
      steps: [
        { id: 'ut', type: 'user_task', content: '之前聊过的事', timestamp: ts },
        { id: 'fr', type: 'final_result', content: '好的', timestamp: ts },
      ],
      messages: [
        { role: 'user', content: '之前聊过的事' },
        { role: 'assistant', content: '好的' },
      ],
      workingContext: [
        { role: 'system', content: polluted },
        { role: 'user', content: '[交接] 之前聊过的事，已经交代完。' },
        { role: 'assistant', content: '好的，我记着了' },
      ],
      duration: 1000,
      status: 'completed',
    } as AgentRecord)

    // 重启：全新的 AgentService、全新的 Agent，只靠磁盘上的记录接着走
    const restarted = makeAgentService()
    const at = calls.length
    await expect(say(restarted, '继续', { sessionId: 'sess_polluted_checkpoint' })).resolves.toContain('好的')
    const sent = calls[at]

    expect(docCopies(sent.system)).toBe(0)
    expect(sent.system).toContain('当前没有开着的技能')
    expect(sent.system.startsWith(head)).toBe(true)
    // 接着的是这份检查点，而不是从头重装
    const texts = sent.messages.map(m => String(m.content ?? ''))
    expect(texts.some(t => t.includes('[交接] 之前聊过的事，已经交代完。'))).toBe(true)
    // 瘦身是实打实的：至少少了 22 份文档的长度
    expect(polluted.length - sent.system.length).toBeGreaterThanOrEqual(22 * SKILL_DOC.length)
  }, 60000)
})
