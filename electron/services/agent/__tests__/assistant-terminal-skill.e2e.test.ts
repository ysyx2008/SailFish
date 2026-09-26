/**
 * 独立助手的「终端」技能端到端：同一场对话从桌面同一入口走下来——
 * 没开终端时不带终端工具；它自己开窗后下一步就有、命令真打进窗里、胶囊挂上；
 * 终端在座时点不掉、它自己也卸不掉；关窗后留到这场结束；关窗后用户能点掉；
 * 用户手动开窗再发消息，自动装回；重开这场，技能跟着回来。
 * 只有模型和「前端开窗」是脚本，终端、工具、技能、历史落盘都是真的。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { ToolDefinition } from '../../ai.service'
import type { AgentContext, AgentPaneInfo, VisibleConversationSkill } from '@shared/types'

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

import { PtyService } from '../../pty.service'
import { initTerminalStateService, type TerminalStateService } from '../../terminal-state.service'
import { UnifiedTerminalService } from '../../unified-terminal.service'
import { HistoryService } from '../../history.service'
import { ConversationManager, ConversationStore } from '../../conversation'
import { splitPaneBridge } from '../../split-pane-bridge.service'
import { AgentService } from '../index'

type Msg = { role?: string; content?: unknown }
type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } }
type Call = { tools: string[]; system: string; messages: Msg[] }

const TERMINAL_TOOLS = ['execute_command', 'check_terminal_status', 'get_terminal_context', 'send_control_key', 'send_input', 'wait']
const SKILL_DOC_MARK = '这场对话里已有看得见的终端窗'
const AGENT_KEY = 'assistant-e2e'
const itUnix = process.platform === 'win32' ? it.skip : it

function tc(name: string, args: Record<string, unknown>, id: string): ToolCall {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}

describe('独立助手的「终端」技能（真终端端到端）', () => {
  let pty: PtyService
  let terminalState: TerminalStateService
  let terminals: UnifiedTerminalService
  let history: HistoryService
  let calls: Call[]
  let skillEvents: VisibleConversationSkill[][]
  let agentService: AgentService
  /** 前端那边此刻开着的窗 */
  let openPtyIds: string[] = []

  /** 桌面建窗：起 shell 并登记成本机窗 */
  function openLocalWindow(): string {
    const id = pty.create({ shell: '/bin/zsh', cwd: os.homedir() }).id
    terminalState.initTerminal(id, 'local')
    openPtyIds.push(id)
    return id
  }

  function makeServices(disabledBuiltinSkills?: string[]) {
    return {
      aiService: {
        chat: vi.fn().mockResolvedValue(''),
        chatWithToolsStream: vi.fn(async (
          messages: Msg[],
          tools: ToolDefinition[],
          onChunk: (s: string) => void,
          _onToolCall: unknown,
          onDone: (r: unknown) => void,
        ) => {
          const system = String(messages.find(m => m.role === 'system')?.content ?? '')
          calls.push({ tools: tools.map(t => t.function.name), system, messages: JSON.parse(JSON.stringify(messages)) })
          const r = respond(messages, calls.length)
          if (r.content) onChunk(r.content)
          onDone({ content: r.content ?? '', tool_calls: r.tool_calls })
        }),
        abort: vi.fn(),
      },
      ptyService: pty,
      unifiedTerminalService: terminals,
      configService: {
        get: vi.fn((key: string) => (key === 'disabledBuiltinSkills' ? disabledBuiltinSkills : undefined)),
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

  function makeAgentService(disabledBuiltinSkills?: string[]): AgentService {
    const services = makeServices(disabledBuiltinSkills)
    const svc = new AgentService(services.aiService as never, pty, services.hostProfileService as never, undefined, services.configService as never)
    svc.setHistoryService(history)
    svc.onSkillsChanged((key, skills) => {
      if (key === AGENT_KEY) skillEvents.push(skills)
    })
    const agent = svc.getOrCreateAgent(AGENT_KEY)
    ;(agent as unknown as { services: unknown }).services = services
    return svc
  }

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-term-skill-e2e-'))
    pty = new PtyService()
    terminalState = initTerminalStateService(pty)
    terminals = new UnifiedTerminalService(pty, { hasInstance: () => false } as never)
    history = new HistoryService()
    calls = []
    skillEvents = []

    vi.mocked(splitPaneBridge.exec).mockImplementation(async (op) => {
      if (op.type === 'open') {
        const id = openLocalWindow()
        await new Promise(r => setTimeout(r, 300))
        return { ok: true, data: { ptyId: id, panes: [{ ptyId: id, label: '主窗格', isActive: true, terminalType: 'local' }] } }
      }
      if (op.type === 'close') {
        pty.dispose(op.ptyId)
        openPtyIds = openPtyIds.filter(id => id !== op.ptyId)
        return { ok: true, data: { panes: [] } }
      }
      return { ok: false, error: `unexpected op ${op.type}` }
    })

    agentService = makeAgentService()
  }, 20000)

  afterAll(() => {
    pty?.disposeAll()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  function respond(messages: Msg[], n: number): { content?: string; tool_calls?: ToolCall[] } {
    const lastUserIdx = messages.map(m => m.role).lastIndexOf('user')
    const ask = String(messages[lastUserIdx]?.content ?? '')
    const after = messages.slice(lastUserIdx + 1)
    const toolTexts = after.filter(m => m.role === 'tool').map(m => String(m.content ?? ''))
    const did = (mark: string) => toolTexts.some(t => t.includes(mark))

    if (ask.includes('开个终端')) {
      if (toolTexts.length === 0) return { tool_calls: [tc('manage_pane', { action: 'open', target: 'local' }, `open-${n}`)] }
      if (toolTexts.length === 1) return { tool_calls: [tc('execute_command', { command: 'echo SF_TERM_$((20+7))' }, `cmd-${n}`)] }
      if (toolTexts.length === 2) return { tool_calls: [tc('skill', { action: 'unload', skill_id: 'terminal' }, `unload-${n}`)] }
      return { content: '命令跑完了' }
    }
    if (ask.includes('关掉终端')) {
      if (toolTexts.length === 0) return { tool_calls: [tc('manage_pane', { action: 'close', pane_id: openPtyIds[0] }, `close-${n}`)] }
      if (ask.includes('顺手卸掉') && toolTexts.length === 1) {
        return { tool_calls: [tc('skill', { action: 'unload', skill_id: 'terminal' }, `unload-${n}`)] }
      }
      return { content: did('已关闭最后一扇终端') ? '关好了' : '没关上' }
    }
    return { content: '好的' }
  }

  function assistantContext(extra?: Partial<AgentContext>): AgentContext {
    return {
      mode: 'single',
      terminalOutput: [],
      systemInfo: { os: 'macos', shell: '/bin/zsh' },
      terminalType: 'assistant',
      ...extra,
    }
  }

  function runOnce(message: string, extra?: Partial<AgentContext>): Promise<string> {
    return agentService.run(AGENT_KEY, message, assistantContext(extra), { executionMode: 'free' })
  }

  function visible(): VisibleConversationSkill[] {
    return agentService.getVisibleSkills(AGENT_KEY)
  }

  function lacksTerminalTools(c: Call) {
    for (const name of TERMINAL_TOOLS) expect(c.tools).not.toContain(name)
    expect(c.tools).toContain('manage_pane')
  }

  function hasTerminalTools(c: Call) {
    for (const name of TERMINAL_TOOLS) expect(c.tools).toContain(name)
  }

  itUnix('没开终端：不带终端工具，开窗入口在，没有「终端」胶囊', async () => {
    const from = calls.length
    await expect(runOnce('随便聊聊')).resolves.toContain('好的')
    const mine = calls.slice(from)
    expect(mine.length).toBe(1)
    lacksTerminalTools(mine[0])
    expect(mine[0].system).not.toContain(SKILL_DOC_MARK)
    expect(visible().some(s => s.id === 'terminal')).toBe(false)
  }, 30000)

  itUnix('它自己开窗：下一步就有终端工具，命令真打进窗里，胶囊挂上；在座时它卸不掉', async () => {
    const from = calls.length
    const eventsFrom = skillEvents.length
    await expect(runOnce('开个终端，跑一下 echo')).resolves.toContain('命令跑完了')
    const mine = calls.slice(from)
    expect(mine.length).toBe(4)

    lacksTerminalTools(mine[0])
    expect(mine[0].system).not.toContain(SKILL_DOC_MARK)
    hasTerminalTools(mine[1])
    expect(mine[1].system).toContain(SKILL_DOC_MARK)

    const toolOut = mine[2].messages.filter(m => m.role === 'tool').map(m => String(m.content))
    expect(toolOut.join('\n---\n')).toContain('SF_TERM_27')

    const unloadOut = mine[3].messages.filter(m => m.role === 'tool').map(m => String(m.content)).pop() ?? ''
    expect(unloadOut).toContain('终端还在座')
    hasTerminalTools(mine[3])

    const events = skillEvents.slice(eventsFrom)
    expect(events.some(list => list.some(s => s.id === 'terminal' && s.systemManaged))).toBe(true)
    expect(visible()).toContainEqual(expect.objectContaining({ id: 'terminal', name: '终端', systemManaged: true }))
  }, 30000)

  itUnix('关掉终端后：这场接着聊还带着终端能力，说明也在', async () => {
    await expect(runOnce('关掉终端吧')).resolves.toContain('关好了')
    expect(openPtyIds).toEqual([])

    const from = calls.length
    await expect(runOnce('再随便聊聊')).resolves.toContain('好的')
    const mine = calls.slice(from)
    hasTerminalTools(mine[0])
    expect(mine[0].system).toContain(SKILL_DOC_MARK)
    expect(visible().some(s => s.id === 'terminal')).toBe(true)
  }, 30000)

  itUnix('关窗后用户点掉胶囊：卸下，下一条就不带终端工具了', async () => {
    const { skills } = await agentService.unpinSkill(AGENT_KEY, 'terminal')
    expect(skills.some(s => s.id === 'terminal')).toBe(false)

    const from = calls.length
    await expect(runOnce('还是聊聊')).resolves.toContain('好的')
    lacksTerminalTools(calls[from])
    expect(calls[from].system).not.toContain(SKILL_DOC_MARK)
  }, 30000)

  itUnix('用户手动开窗再发消息：开工就装回，第一步就有终端工具和说明', async () => {
    const id = openLocalWindow()
    await new Promise(r => setTimeout(r, 300))
    const panes: AgentPaneInfo[] = [{ paneId: id, ptyId: id, label: '主窗格', isActive: true, terminalOutput: [], terminalType: 'local' }]

    const from = calls.length
    await expect(runOnce('我自己开了个终端，看一眼', { ptyId: id, panes, activePaneId: id })).resolves.toContain('好的')
    hasTerminalTools(calls[from])
    expect(calls[from].system).toContain(SKILL_DOC_MARK)
    expect(visible()).toContainEqual(expect.objectContaining({ id: 'terminal', systemManaged: true }))
  }, 30000)

  itUnix('终端在座、这一轮正在跑时，用户点胶囊也卸不掉', async () => {
    const id = openPtyIds[0]
    const agent = agentService.getAgent(AGENT_KEY)!
    let unpinResult: VisibleConversationSkill[] | undefined
    const services = (agent as unknown as { services: ReturnType<typeof makeServices> }).services
    const original = services.aiService.chatWithToolsStream.getMockImplementation()!
    services.aiService.chatWithToolsStream.mockImplementationOnce(async (...args: Parameters<typeof original>) => {
      unpinResult = (await agentService.unpinSkill(AGENT_KEY, 'terminal')).skills
      return original(...args)
    })
    await runOnce('终端还开着，接着聊', { ptyId: id })
    expect(unpinResult?.some(s => s.id === 'terminal')).toBe(true)
    expect(visible().some(s => s.id === 'terminal')).toBe(true)
  }, 30000)

  itUnix('重开这场（没开终端，老配置里还禁着旧「终端控制」）：「终端」技能跟着回来', async () => {
    const sessionId = agentService.getAgent(AGENT_KEY)!.getSessionId()!
    const record = history.getAgentRecordById(sessionId)!
    expect(record.loadedSkills).toContain('terminal')

    agentService.cleanupAgent(AGENT_KEY)
    agentService = makeAgentService(['terminal'])
    const hydrated = agentService.hydrateSkills(AGENT_KEY, record.loadedSkills, record.userDismissedSkills)
    expect(hydrated).toContainEqual(expect.objectContaining({ id: 'terminal', systemManaged: true }))

    const from = calls.length
    await expect(runOnce('接着上次聊', { sessionId, sessionStartTime: record.timestamp })).resolves.toContain('好的')
    hasTerminalTools(calls[from])
    expect(calls[from].system).toContain(SKILL_DOC_MARK)
    expect(visible()).toContainEqual(expect.objectContaining({ id: 'terminal', systemManaged: true }))
    expect(visible().find(s => s.id === 'terminal')?.unavailable).toBeUndefined()
  }, 30000)

  itUnix('同一轮里关掉最后一扇窗：这一轮就不再当终端在座，它能自己卸掉', async () => {
    const id = openPtyIds[0]
    expect(id).toBeTruthy()
    const from = calls.length
    await expect(runOnce('关掉终端，顺手卸掉终端技能', { ptyId: id })).resolves.toContain('关好了')
    const unloadOut = calls.slice(from).pop()!.messages.filter(m => m.role === 'tool').map(m => String(m.content)).pop() ?? ''
    expect(unloadOut).toContain('已卸载技能')
    expect(openPtyIds).toEqual([])
    expect(visible().some(s => s.id === 'terminal')).toBe(false)
  }, 30000)
})
