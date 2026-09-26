/**
 * 终端页的当前目录端到端：真 zsh 里 cd 过去，从桌面同一入口开工，
 * 主人的提示词与相对路径读文件、伙计的提示词与后台命令和读文件，都要落在那个目录；
 * 续聊时目录变了，开场说明不动，新消息里补一句。
 * 只有模型是脚本，终端、目录查询、工具、派伙计都是真的。
 * 主人在窗里打的命令本就跑在那个 shell 里，这里不重复验。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { ToolDefinition } from '../../ai.service'
import type { AgentContext } from '../types'

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

import { PtyService } from '../../pty.service'
import { initTerminalStateService } from '../../terminal-state.service'
import { HistoryService } from '../../history.service'
import { Conversation, ConversationManager, ConversationStore } from '../../conversation'
import { AgentService } from '../index'

type Msg = { role?: string; content?: unknown; tool_calls?: unknown }
type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } }
type Call = { child: boolean; system: string; messages: Msg[] }

const itUnix = process.platform === 'win32' ? it.skip : it

function tc(name: string, args: Record<string, unknown>, id: string): ToolCall {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}

function toolResults(messages: Msg[]): string {
  return messages.filter(m => m.role === 'tool').map(m => String(m.content ?? '')).join('\n')
}

function text(messages: Msg[]): string {
  return messages.map(m => String(m.content ?? '')).join('\n')
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error('等待超时')
}

describe('终端页当前目录（真终端端到端）', () => {
  let pty: PtyService
  let ptyId: string
  let project: string
  let sub: string
  let calls: Call[]
  let agentService: AgentService

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-cwd-e2e-data-'))
    project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sf-cwd-e2e-proj-')))
    sub = path.join(project, 'sub')
    fs.mkdirSync(sub)
    fs.writeFileSync(path.join(project, 'README.md'), 'PROJECT_README_MARK\n')
    fs.writeFileSync(path.join(sub, 'README.md'), 'SUB_README_MARK\n')

    pty = new PtyService()
    ptyId = pty.create({ shell: '/bin/zsh', cwd: os.homedir() }).id
    const terminalState = initTerminalStateService(pty)
    // 桌面端建窗时登记的初始目录就是主目录；用户随后在窗里 cd
    terminalState.initTerminal(ptyId, 'local')
    await new Promise(r => setTimeout(r, 300))
    pty.write(ptyId, `cd ${project}\r`)
    await waitFor(async () => (await pty.getCwd(ptyId)) === project)

    calls = []
    const history = new HistoryService()
    const services = {
      aiService: {
        chat: vi.fn().mockResolvedValue(''),
        chatWithToolsStream: vi.fn(async (
          messages: Msg[],
          tools: ToolDefinition[],
          onChunk: (s: string) => void,
          _onToolCall: unknown,
          onDone: (r: unknown) => void,
        ) => {
          const names = tools.map(t => t.function.name)
          const child = !names.includes('dispatch_agents')
          const system = String(messages.find(m => m.role === 'system')?.content ?? '')
          calls.push({ child, system, messages: JSON.parse(JSON.stringify(messages)) })
          const r = respond(child, messages, calls.length)
          if (r.content) onChunk(r.content)
          onDone({ content: r.content ?? '', tool_calls: r.tool_calls })
        }),
        abort: vi.fn(),
      },
      ptyService: pty,
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
      },
      hostProfileService: {
        generateHostContext: vi.fn().mockReturnValue(''),
        addNote: vi.fn(),
        getProfile: vi.fn().mockReturnValue(null),
      },
      historyService: history,
      conversationManager: new ConversationManager(new ConversationStore(history.getAgentRecordStore())),
    }
    agentService = new AgentService(services.aiService as never, pty, services.hostProfileService as never, undefined, services.configService as never)
    agentService.setHistoryService(history)
    const agent = agentService.getOrCreateAgent('tab-e2e')
    ;(agent as unknown as { services: unknown }).services = services
  }, 20000)

  afterAll(() => {
    pty?.disposeAll()
    fs.rmSync(project, { recursive: true, force: true })
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  let parentTurn = 0
  function respond(child: boolean, messages: Msg[], n: number): { content?: string; tool_calls?: ToolCall[] } {
    if (child) {
      if (!messages.some(m => m.role === 'tool')) {
        return { tool_calls: [tc('exec', { command: 'pwd' }, `c-pwd-${n}`), tc('read_file', { path: 'README.md' }, `c-read-${n}`)] }
      }
      return { content: `伙计回报：\n${toolResults(messages)}` }
    }
    const lastUser = [...messages].reverse().find(m => m.role === 'user')
    const fresh = String(lastUser?.content ?? '').includes('看看这里')
    if (fresh && !messages.slice(messages.indexOf(lastUser!)).some(m => m.role === 'tool')) {
      parentTurn = 0
      return {
        tool_calls: [
          tc('read_file', { path: 'README.md' }, `p-read-${n}`),
          tc('dispatch_agents', {
            tasks: [
              { name: '甲', description: '看目录', prompt: '跑 pwd，读相对路径 README.md', fork_turns: 'none' },
              { name: '乙', description: '看目录', prompt: '跑 pwd，读相对路径 README.md', fork_turns: 'none' },
            ],
          }, `p-dispatch-${n}`),
        ],
      }
    }
    const seen = text(messages)
    if ((seen.match(/伙计回报/g) ?? []).length < 2 && parentTurn++ < 5) {
      return { tool_calls: [tc('wait_agents', { timeout: 10 }, `p-wait-${n}`)] }
    }
    return { content: '汇总完毕' }
  }

  function runOnce(message: string): Promise<string> {
    const context: AgentContext = {
      ptyId,
      terminalOutput: [],
      systemInfo: { os: 'macos', shell: '/bin/zsh' },
      terminalType: 'local',
      hostId: 'local',
    }
    return agentService.run('tab-e2e', message, context, { executionMode: 'free' })
  }

  const CHANGED = '当前工作目录已变为：'

  function lastUserText(c: Call): string {
    return String([...c.messages].reverse().find(m => m.role === 'user')?.content ?? '')
  }

  function parentOpening(from: number): Call {
    const first = calls.slice(from).find(c => !c.child)
    expect(first).toBeTruthy()
    return first!
  }

  function assertLandedIn(dir: string, readme: string, from: number) {
    const mine = calls.slice(from)
    const parent = mine.filter(c => !c.child)
    const children = mine.filter(c => c.child)
    expect(parent.length).toBeGreaterThan(0)
    expect(toolResults(parent[parent.length - 1].messages)).toContain(readme)

    const childOpenings = children.filter(c => !c.messages.some(m => m.role === 'tool'))
    expect(childOpenings.length).toBe(2)
    for (const c of childOpenings) expect(c.system).toContain(`命令默认执行目录：${dir}`)

    const childReports = children.filter(c => c.messages.some(m => m.role === 'tool'))
    expect(childReports.length).toBe(2)
    for (const c of childReports) {
      const seen = toolResults(c.messages)
      expect(seen).toContain(dir)
      expect(seen).toContain(readme)
      expect(seen).not.toContain('ENOENT')
    }
  }

  itUnix('cd 到项目后开工：主人和两个伙计都在项目目录干活', async () => {
    const from = calls.length
    const result = await runOnce('看看这里：读 README.md，再派两个伙计各自跑 pwd 并读 README.md')
    expect(result).toContain('汇总完毕')
    const opening = parentOpening(from)
    expect(opening.system).toContain(`当前工作目录：${project}`)
    expect(lastUserText(opening)).not.toContain(CHANGED)
    assertLandedIn(project, 'PROJECT_README_MARK', from)
  }, 30000)

  itUnix('再 cd 进子目录发下一条：开场说明不动，新消息里补一句，工具和伙计按新目录干活', async () => {
    pty.write(ptyId, `cd ${sub}\r`)
    await waitFor(async () => (await pty.getCwd(ptyId)) === sub)
    const from = calls.length
    const result = await runOnce('再看看这里：同样派两个伙计')
    expect(result).toContain('汇总完毕')
    const opening = parentOpening(from)
    expect(opening.system).toContain(`当前工作目录：${project}`)
    expect(lastUserText(opening)).toContain(`${CHANGED}${sub}`)
    assertLandedIn(sub, 'SUB_README_MARK', from)
  }, 30000)

  itUnix('没再 cd 就发下一条：不再补那句', async () => {
    const from = calls.length
    const result = await runOnce('还是看看这里：同样派两个伙计')
    expect(result).toContain('汇总完毕')
    expect(lastUserText(parentOpening(from))).not.toContain(CHANGED)
    assertLandedIn(sub, 'SUB_README_MARK', from)
  }, 30000)

  itUnix('接的是别处来的前缀：目录没变也补一句（说不准它知道）', async () => {
    const agent = agentService.getAgent('tab-e2e')!
    const prefix = (agent as unknown as { _conversation: Conversation })._conversation.getCachePrefix()
    agent.attachConversation(Conversation.create({ agentKey: 'tab-e2e', terminalType: 'local' }), { cachePrefix: prefix })
    const from = calls.length
    const result = await runOnce('接着看看这里：同样派两个伙计')
    expect(result).toContain('汇总完毕')
    expect(lastUserText(parentOpening(from))).toContain(`${CHANGED}${sub}`)
    assertLandedIn(sub, 'SUB_README_MARK', from)
  }, 30000)
})
