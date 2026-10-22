/**
 * 专家团端到端：真实 SailFish.run() + 真实写盘 + 脚本化模型。
 * 产品在群里把活交给开发，开发写出真文件、点名组长，整个团停下来后组长收到一次敲门。
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
import { ExpertTeamChatStore } from '../../history/expert-team-chat-store'

type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } }
type LlmResponse = { content?: string; tool_calls?: ToolCall[] }
type Msg = { role?: string; content?: unknown; tool_calls?: unknown }

let calls: Array<{ who: string; tools: string[]; messages: Msg[] }> = []
let n = 0

function tc(name: string, args: Record<string, unknown>): ToolCall {
  return { id: `tc-${++n}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}

function text(messages: Msg[]): string {
  return messages.map(m => String(m.content ?? '')).join('\n')
}

/** 认人：专家开工第一条话里写着「你是 名字（角色）」 */
function whoIs(messages: Msg[], tools: string[]): string {
  if (tools.includes('dispatch_agents')) return 'parent'
  const m = /你是 (\S+)（/.exec(text(messages))
  return m ? m[1] : 'unknown'
}

function makeServices(respond: (who: string, messages: Msg[]) => LlmResponse): AgentServices {
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
      ) => {
        const names = tools.map(t => t.function.name)
        const who = whoIs(messages, names)
        calls.push({ who, tools: names, messages: JSON.parse(JSON.stringify(messages)) })
        await new Promise(r => setTimeout(r, 5))
        const r = respond(who, messages)
        if (r.content) onChunk(r.content)
        onDone({ content: r.content ?? '', tool_calls: r.tool_calls })
      }),
      abort: vi.fn(),
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

function findFile(dir: string, name: string): string | undefined {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const hit = findFile(full, name)
      if (hit) return hit
    } else if (entry.name === name) {
      return full
    }
  }
  return undefined
}

describe('专家团端到端（真实 SailFish.run）', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-expert-e2e-'))
    calls = []
  })
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('产品在群里交给开发，开发写出文件并点名组长，团停下来组长收到一次敲门', async () => {
    const target = path.join(tmpDir, 'hello.txt')
    const done = { dev: { wrote: false, told: false }, pm: { handed: false } }

    const services = makeServices((who, messages) => {
      const all = text(messages)
      if (who === 'parent') {
        if (!all.includes('已派出专家团')) {
          return {
            content: '我派个专家团',
            tool_calls: [tc('dispatch_agents', {
              team: '小工具组',
              tasks: [
                { name: '定需求', role: '产品专家', description: '写清需求', prompt: '想清楚 hello 工具要输出什么，交给开发' },
                { name: '写代码', role: '开发专家', description: '实现', prompt: '等产品交需求，按需求实现' },
              ],
            })],
          }
        }
        if (all.includes('停下来了')) return { content: '汇总：hello.txt 写好了' }
        return { content: '收到，等他们做完' }
      }
      if (who === '定需求') {
        if (!done.pm.handed) {
          done.pm.handed = true
          return { tool_calls: [tc('team_say', { to: ['写代码'], message: `需求：在 ${target} 写入 hi` })] }
        }
        return { content: '需求交给开发了' }
      }
      if (who === '写代码') {
        if (!all.includes('点名要你接手')) return { content: '还没收到需求，先停下' }
        if (!done.dev.wrote) {
          done.dev.wrote = true
          return { tool_calls: [tc('write_text_file', { path: target, content: 'hi', mode: 'create' })] }
        }
        if (!done.dev.told) {
          done.dev.told = true
          return { tool_calls: [tc('team_say', { to: ['组长'], message: 'hello.txt 写好了' })] }
        }
        return { content: '实现完成' }
      }
      return { content: '?' }
    })

    const parent = new SailFish(services)
    parent.setAgentId('e2e-expert-parent')
    parent.updateConfig({ executionMode: 'free' })
    const chats = new ExpertTeamChatStore(path.join(tmpDir, 'history', 'expert-teams'))
    const withChats = parent as unknown as { createToolExecutorConfig: (run: unknown) => object }
    const baseConfig = withChats.createToolExecutorConfig.bind(parent)
    withChats.createToolExecutorConfig = (run) => ({ ...baseConfig(run), getExpertTeamChats: () => chats })

    const steps: AgentStep[] = []
    const result = await parent.run('做个 hello 小工具', ctx(), {
      callbacks: { onStep: (_id, step) => { steps.push({ ...step }) } }
    })

    expect(result).toContain('hello.txt 写好了')
    expect(fs.readFileSync(target, 'utf-8')).toBe('hi')

    const parentCalls = calls.filter(c => c.who === 'parent')
    expect(parentCalls[0].tools).not.toContain('team_say')
    const expertCalls = calls.filter(c => c.who === '定需求' || c.who === '写代码')
    expect(expertCalls.length).toBeGreaterThan(0)
    expect(expertCalls.every(c => c.tools.includes('team_say'))).toBe(true)
    expect(expertCalls.every(c => !c.tools.includes('dispatch_agents'))).toBe(true)

    const knocks = parentCalls.flatMap(c => c.messages).map(m => String(m.content ?? ''))
    const leaderKnocks = new Set(knocks.filter(k => k.includes('[专家团「小工具组」开发专家·写代码 点名组长]')))
    const stoppedKnocks = new Set(knocks.filter(k => k.includes('[专家团「小工具组」停下来了，没人在干]')))
    expect(leaderKnocks.size).toBe(1)
    expect(stoppedKnocks.size).toBe(1)
    expect(knocks.some(k => k.includes('[专家 ') && k.includes('完成]'))).toBe(false)

    const dispatched = steps.filter(s => s.toolName === 'dispatch_agents')
    expect(dispatched.length).toBeGreaterThan(0)
    const last = dispatched[dispatched.length - 1]
    expect(last.subAgents?.map(s => s.role).sort()).toEqual(['产品专家', '开发专家'])
    expect(last.expertTeam?.name).toBe('小工具组')
    expect(last.expertTeam?.messages.map(m => `${m.from}→${m.to.join(',')}`)).toEqual(['定需求→写代码', '写代码→组长'])

    const chatFile = last.expertTeam?.chatFile
    expect(chatFile).toMatch(/team-小工具组\.jsonl$/)
    expect(chats.read(chatFile!)!.messages.map(m => m.text)).toEqual([`需求：在 ${target} 写入 hi`, 'hello.txt 写好了'])

    const transcript = findFile(tmpDir, 'team-小工具组.md')
    expect(transcript).toBeTruthy()
    const body = fs.readFileSync(transcript!, 'utf-8')
    expect(body).toContain('产品专家·定需求 → 开发专家·写代码')
    expect(body).toContain('hello.txt 写好了')
  })
})
