/**
 * 伙计在已存主机上后台跑命令：真实 SailFish.run() + 脚本化模型 + 真实后台通道 + 假 SSH 主机。
 * 测的是整条链路：派出前确认 → 伙计只拿到自己的主机和命令 → 命令真的发到主机 → 留痕落盘。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { ToolDefinition } from '../../ai.service'
import type { AgentContext, AgentServices, AgentStep } from '../types'
import type { PendingConfirmation } from '@shared/types'

let tmpDir: string
let sessions: Array<Record<string, unknown>> = []

vi.mock('electron', () => ({
  app: { getPath: () => tmpDir, getName: () => 'SailFish', getVersion: () => '1.0.0', isPackaged: false },
  BrowserWindow: vi.fn(),
  ipcMain: { on: vi.fn(), handle: vi.fn() },
}))
vi.mock('../../im/im.service', () => ({ getIMService: vi.fn().mockReturnValue(null) }))
vi.mock('../../web-search/index', () => ({ isConfigured: () => false, getApiKey: () => '' }))
vi.mock('../../knowledge', () => ({
  getKnowledgeService: () => ({
    isEnabled: () => false,
    searchConversations: async () => [],
    buildContext: async () => '',
  }),
}))
vi.mock('../../config.service', () => ({
  getConfigService: () => ({
    get: () => undefined,
    getSshSessions: () => sessions,
    getSessionGroups: () => [{ id: 'g1', name: '测试组' }],
  }),
}))

import { SailFish } from '../sailfish'
import { startFakeHost, type FakeHost } from '../../remote-exec/__tests__/fake-ssh-host'

type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } }
type LlmResponse = { content?: string; tool_calls?: ToolCall[] }

const tc = (name: string, args: Record<string, unknown>, id = `tc-${name}`): ToolCall =>
  ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })

const toolNames = (tools: ToolDefinition[]) => tools.map(t => t.function.name)
const isChildCall = (tools: ToolDefinition[]) => !toolNames(tools).includes('dispatch_agents')

let llmCalls: Array<{ tools: string[]; messages: Array<{ role?: string; content?: unknown }> }> = []

function makeServices(responder: (args: {
  isChild: boolean
  childIndex: number
  parentIndex: number
  messages: Array<{ role?: string; content?: unknown }>
}) => LlmResponse): AgentServices {
  let childIndex = 0
  let parentIndex = 0
  return {
    aiService: {
      chat: vi.fn().mockResolvedValue(''),
      chatWithTools: vi.fn(async () => ({ content: '', tool_calls: [] })),
      chatWithToolsStream: vi.fn(async (
        messages: Array<{ role?: string; content?: unknown }>,
        tools: ToolDefinition[],
        onChunk: (s: string) => void,
        _onToolCall: unknown,
        onDone: (r: unknown) => void,
      ) => {
        const child = isChildCall(tools)
        const idx = child ? childIndex++ : parentIndex++
        llmCalls.push({ tools: toolNames(tools), messages: JSON.parse(JSON.stringify(messages)) })
        const r = responder({ isChild: child, childIndex: idx, parentIndex: idx, messages })
        const content = r.content ?? ''
        if (content) onChunk(content)
        onDone({ content, tool_calls: r.tool_calls })
      }),
      abort: vi.fn(),
    } as never,
    ptyService: { onData: vi.fn().mockReturnValue(() => {}), write: vi.fn() } as never,
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
      isAutoApprovalReviewEnabled: vi.fn().mockReturnValue(false),
    } as never,
    hostProfileService: {
      generateHostContext: vi.fn().mockReturnValue(''),
      addNote: vi.fn(),
      getProfile: vi.fn().mockReturnValue(null),
    } as never,
    historyService: undefined,
    conversationManager: undefined,
  }
}

function ctx(): AgentContext {
  return { terminalOutput: [], systemInfo: { os: 'darwin', shell: '/bin/zsh' }, terminalType: 'assistant', cwd: tmpDir }
}

function lastUserText(messages: Array<{ role?: string; content?: unknown }>): string {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.role === 'user') return String(messages[i]!.content ?? '')
  return ''
}

function toolOutputsOf(call: { messages: Array<{ role?: string; content?: unknown }> }): string {
  return call.messages.filter(m => m.role === 'tool').map(m => String(m.content ?? '')).join('\n')
}

describe('伙计在已存主机上后台跑命令（真实 SailFish.run）', () => {
  let host: FakeHost
  let other: FakeHost

  beforeEach(async () => {
    host = await startFakeHost({ users: { tester: 'secret' } })
    other = await startFakeHost({ users: { tester: 'secret' } })
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-remote-worker-e2e-'))
    llmCalls = []
    sessions = [
      { id: 'h1', name: 'web-01', host: '127.0.0.1', port: host.port, username: 'tester', authType: 'password', password: 'secret', groupId: 'g1' },
      { id: 'h2', name: 'web-02', host: '127.0.0.1', port: other.port, username: 'tester', authType: 'password', password: 'secret', groupId: 'g1' },
    ]
  })
  afterEach(async () => {
    await host.close()
    await other.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function runParent(services: AgentServices, mode: 'relaxed' | 'free', decide: (c: PendingConfirmation) => boolean) {
    const parent = new SailFish(services)
    parent.setAgentId('e2e-remote')
    parent.updateConfig({ executionMode: mode })
    const confirmations: PendingConfirmation[] = []
    const steps: AgentStep[] = []
    const result = parent.run('巡检一下 web-01', ctx(), {
      callbacks: {
        onStep: (_id: string, step: AgentStep) => { steps.push({ ...step }) },
        onNeedConfirm: (c: PendingConfirmation) => {
          confirmations.push(c)
          setTimeout(() => parent.confirmToolCall(c.toolCallId, decide(c)), 0)
        },
      },
    })
    return { result, confirmations, steps }
  }

  const dispatch = (hosts: string[], commands: string[]) => tc('dispatch_agents', {
    tasks: [{ name: 'wk', description: '看 web-01', prompt: '去看', hosts }],
    remote_commands: commands,
  })

  it('批准后：伙计连上主机跑单上的命令，命令真的发到了主机，结果回到主人，留痕落盘', async () => {
    const services = makeServices(({ isChild, childIndex, parentIndex, messages }) => {
      if (isChild) {
        if (childIndex === 0) return { tool_calls: [tc('remote_exec', { host: 'h1', command: 'echo HELLO_FROM_REMOTE' })] }
        const seen = lastUserText(messages) + toolOutputsOf({ messages })
        return { content: seen.includes('HELLO_FROM_REMOTE') ? '远程输出：HELLO_FROM_REMOTE' : '没有拿到输出' }
      }
      if (parentIndex === 0) return { content: '派人去看', tool_calls: [dispatch(['h1'], ['echo HELLO_FROM_REMOTE'])] }
      return { content: lastUserText(messages).includes('HELLO_FROM_REMOTE') ? '汇总：web-01 回了 HELLO_FROM_REMOTE' : '再等等' }
    })

    const { result, confirmations } = runParent(services, 'relaxed', () => true)
    expect(await result).toContain('HELLO_FROM_REMOTE')

    // 派出前问过一次，卡片里是主机和命令清单
    expect(confirmations).toHaveLength(1)
    expect(confirmations[0]!.riskLevel).toBe('moderate')
    expect(confirmations[0]!.remoteAccess?.commands).toEqual(['echo HELLO_FROM_REMOTE'])
    expect(confirmations[0]!.remoteAccess?.hosts).toEqual([
      expect.objectContaining({ id: 'h1', name: 'web-01', address: `tester@127.0.0.1:${host.port}`, group: '测试组' }),
    ])

    // 命令真的发到了主机 1，没碰主机 2
    expect(host.commands).toEqual(['echo HELLO_FROM_REMOTE'])
    expect(other.commands).toEqual([])
    expect(other.connections).toBe(0)

    // 工具清单：只有带了范围的伙计看得到 remote_exec
    const childCalls = llmCalls.filter(c => isChildCallNames(c.tools))
    const parentCalls = llmCalls.filter(c => !isChildCallNames(c.tools))
    expect(childCalls.every(c => c.tools.includes('remote_exec'))).toBe(true)
    expect(parentCalls.every(c => !c.tools.includes('remote_exec'))).toBe(true)

    // 伙计的任务后面接着处境说明
    const opening = childCalls[0]!.messages.filter(m => m.role === 'user').map(m => String(m.content)).join('\n')
    expect(opening).toContain('你能连的远程主机')
    expect(opening).toContain('web-01（sessionId: h1')
    expect(opening).toContain('`echo HELLO_FROM_REMOTE`')

    // 留痕：一行一条，输出另存一份
    const opsFiles = findFiles(tmpDir, 'remote-ops.jsonl')
    expect(opsFiles).toHaveLength(1)
    const entries = fs.readFileSync(opsFiles[0]!, 'utf-8').trim().split('\n').map(l => JSON.parse(l))
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ worker: 'wk', hostId: 'h1', hostName: 'web-01', command: 'echo HELLO_FROM_REMOTE', exitCode: 0 })
    expect(fs.readFileSync(entries[0].outputFile, 'utf-8')).toContain('HELLO_FROM_REMOTE')
  })

  it('用户拒绝：一个伙计都没派，没有连任何主机', async () => {
    const services = makeServices(({ isChild, parentIndex, messages }) => {
      if (isChild) return { content: '不该有伙计' }
      if (parentIndex === 0) return { tool_calls: [dispatch(['h1'], ['uptime'])] }
      return { content: lastUserText(messages).includes('没有批准') ? '用户没批准，我不派了' : '？' }
    })
    const { result, confirmations } = runParent(services, 'relaxed', () => false)
    await result
    expect(confirmations).toHaveLength(1)
    expect(llmCalls.some(c => isChildCallNames(c.tools))).toBe(false)
    expect(host.connections).toBe(0)
    expect(toolOutputsOf(llmCalls.at(-1)!)).toContain('用户没有批准')
  })

  it('自由模式：不弹卡，伙计照样只能跑单上的；单外的命令和范围外的主机被拒，没发出去', async () => {
    const services = makeServices(({ isChild, childIndex, parentIndex, messages }) => {
      if (isChild) {
        if (childIndex === 0) return { tool_calls: [tc('remote_exec', { host: 'h1', command: 'echo NOT_LISTED' }, 'c1')] }
        if (childIndex === 1) return { tool_calls: [tc('remote_exec', { host: 'h2', command: 'uptime' }, 'c2')] }
        return { content: '两次都被拒绝了' }
      }
      if (parentIndex === 0) return { tool_calls: [dispatch(['h1'], ['uptime'])] }
      return { content: lastUserText(messages).includes('拒绝') ? '汇总：被拒绝' : '再等等' }
    })
    const { result, confirmations } = runParent(services, 'free', () => true)
    await result
    expect(confirmations).toHaveLength(0)
    expect(host.commands).toEqual([])
    expect(other.commands).toEqual([])
    const childCalls = llmCalls.filter(c => isChildCallNames(c.tools))
    const seen = childCalls.map(toolOutputsOf).join('\n')
    expect(seen).toContain('不在批准的清单里')
    expect(seen).toContain('不在你的范围里')
  })

  it('命令不是只读：整批退回，主人看到原因，没有问人也没有伙计', async () => {
    const services = makeServices(({ isChild, parentIndex, messages }) => {
      if (isChild) return { content: '不该有伙计' }
      if (parentIndex === 0) return { tool_calls: [dispatch(['h1'], ['rm -rf /var/log/app'])] }
      return { content: lastUserText(messages).includes('不是只读') ? '换只读命令' : '？' }
    })
    const { result, confirmations } = runParent(services, 'relaxed', () => true)
    await result
    expect(confirmations).toHaveLength(0)
    expect(llmCalls.some(c => isChildCallNames(c.tools))).toBe(false)
    expect(toolOutputsOf(llmCalls.at(-1)!)).toContain('不是只读')
    expect(host.connections).toBe(0)
  })
})

const isChildCallNames = (tools: string[]) => !tools.includes('dispatch_agents')

function findFiles(root: string, name: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name === name) out.push(full)
    }
  }
  walk(root)
  return out
}
