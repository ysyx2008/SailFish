/**
 * 等命令时插话：答完接着盯、跑完在同一轮里报结果；按停连命令一起停。
 * 真实 SailFish.run() + 真实子进程 + 脚本化模型。
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
import { getExecManager } from '../tools/exec-manager'

type Msg = { role?: string; content?: unknown; tool_calls?: unknown }
type LlmResponse = {
  content?: string
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
}

const itPosix = process.platform === 'win32' ? it.skip : it

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function lastUserText(messages: Msg[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return String(messages[i].content || '')
  }
  return ''
}

function allText(messages: Msg[]): string {
  return messages.map(m => String(m.content ?? '')).join('\n')
}

function tc(name: string, args: Record<string, unknown>, id = `tc-${name}-${Math.random().toString(36).slice(2, 7)}`) {
  return { id, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } }
}

function makeServices(responder: (call: { index: number; messages: Msg[] }) => LlmResponse | Promise<LlmResponse>): AgentServices {
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
          const r = await responder({ index: index++, messages: JSON.parse(JSON.stringify(messages)) })
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
      getCommandRiskPolicy: vi.fn().mockReturnValue(undefined)
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

function pidFrom(messages: Msg[]): number | undefined {
  const m = allText(messages).match(/pid=(\d+)/)
  return m ? Number(m[1]) : undefined
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch {
    return false
  }
}

describe('等命令时插话：答完接着盯；按停连命令一起停', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-exec-watch-e2e-'))
  })
  afterEach(() => {
    getExecManager()._resetForTest()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  itPosix('插话先回答，答完这一轮不收工；盯的时候再问也马上回；命令跑完在同一轮里报结果', async () => {
    const timeline: string[] = []
    const services = makeServices(({ index, messages }) => {
      const last = lastUserText(messages)
      if (index === 0) {
        return { content: '这就跑', tool_calls: [tc('exec', { command: 'echo start; sleep 2; echo done-marker', wait_seconds: 30 })] }
      }
      if (last.includes('done-marker')) {
        timeline.push('reported')
        return { content: '最后一行：done-marker' }
      }
      if (last.includes('第二问')) {
        timeline.push('answered-2')
        return { content: '还在跑' }
      }
      timeline.push('answered-1')
      return { content: '跑了不到一秒，命令没停' }
    })
    const agent = newAgent(services, 'e2e-exec-watch')
    const steps: AgentStep[] = []
    const started = Date.now()
    const runPromise = agent.run('跑这条命令，等它结束告诉我最后一行', ctx(), {
      callbacks: { onStep: (_id, step) => { steps.push({ ...step }) } }
    })

    await sleep(400)
    agent.addUserMessage('现在跑了多久？命令别停')
    await sleep(700)
    expect(timeline).toEqual(['answered-1'])
    expect(agent.isRunning()).toBe(true)

    agent.addUserMessage('第二问：还在吗')
    await sleep(300)
    expect(timeline).toEqual(['answered-1', 'answered-2'])

    const result = await runPromise
    expect(result).toContain('done-marker')
    expect(timeline).toEqual(['answered-1', 'answered-2', 'reported'])
    expect(Date.now() - started).toBeGreaterThanOrEqual(1800)

    // 不冒一条假装是用户说的
    const userBubbles = steps.filter(s => s.type === 'user_task' || s.type === 'user_supplement').map(s => s.content)
    expect(userBubbles.some(c => c.includes('done-marker'))).toBe(false)
    // 盯着的时候界面上看得出在等
    expect(steps.some(s => s.type === 'tool_call' && s.toolName === 'await_exec')).toBe(true)
  }, 15000)

  itPosix('模型自己放去后台、没在等的命令：不挂住这一轮，也不回头找人', async () => {
    let calls = 0
    const services = makeServices(({ index }) => {
      calls++
      if (index === 0) {
        return { tool_calls: [tc('exec', { command: 'sleep 2', wait_seconds: 1 })] }
      }
      return { content: '放后台了' }
    })
    const agent = newAgent(services, 'e2e-exec-bg')
    const started = Date.now()
    const result = await agent.run('后台跑个 sleep', ctx())
    expect(result).toContain('放后台了')
    expect(Date.now() - started).toBeLessThan(1800)
    await sleep(1600)
    expect(calls).toBe(2)
    expect(agent.isRunning()).toBe(false)
  }, 15000)

  itPosix('盯着时按停：命令连子进程一起停掉，不再送回结果；下一轮带着交代', async () => {
    let pid: number | undefined
    const seenNextTurn: string[] = []
    const services = makeServices(({ index, messages }) => {
      if (index === 0) {
        // 后台的 sleep 在非交互 shell 里不理 Ctrl+C，只能靠到点强制结束
        return { tool_calls: [tc('exec', { command: "trap 'echo cleaned; exit 3' INT; echo start; sleep 30 & wait", wait_seconds: 30 })] }
      }
      pid = pid ?? pidFrom(messages)
      const last = lastUserText(messages)
      if (last.includes('刚才那条')) {
        seenNextTurn.push(last)
        return { content: '那条被你停在半截了' }
      }
      return { content: '还在跑，我接着盯' }
    })
    const agent = newAgent(services, 'e2e-exec-stop')
    const steps: AgentStep[] = []
    const runPromise = agent.run('跑个长命令', ctx(), {
      callbacks: { onStep: (_id, step) => { steps.push({ ...step }) } }
    })

    await sleep(400)
    agent.addUserMessage('跑多久了')
    await sleep(500)
    expect(pid).toBeTruthy()
    expect(groupAlive(pid!)).toBe(true)

    expect(agent.abort()).toBe(true)
    await runPromise.catch(() => undefined)

    await sleep(4000)
    expect(groupAlive(pid!)).toBe(false)
    expect(steps.some(s => s.type === 'tool_result' && String(s.content).includes('已停止'))).toBe(true)

    await agent.run('刚才那条怎么样了', ctx())
    expect(seenNextTurn).toHaveLength(1)
    expect(seenNextTurn[0]).toContain('中途停掉')
    expect(seenNextTurn[0]).toContain('sleep 30')
    // 停下之后命令收尾打印的也带上
    expect(seenNextTurn[0]).toContain('cleaned')
  }, 20000)

  itPosix('插话不延长原定等待：到点仍在跑就当作转后台告诉它，这一轮收工，结束也不再回头', async () => {
    const timeline: string[] = []
    const services = makeServices(({ index, messages }) => {
      const last = lastUserText(messages)
      if (index === 0) {
        return { tool_calls: [tc('exec', { command: 'sleep 4', wait_seconds: 2 })] }
      }
      if (last.includes('原定的等待时间')) {
        timeline.push('expired')
        return { content: '到点了还在跑，放后台了' }
      }
      timeline.push(`other:${last.slice(-40)}`)
      return { content: '还在跑' }
    })
    const agent = newAgent(services, 'e2e-exec-expire')
    const started = Date.now()
    const runPromise = agent.run('跑 sleep', ctx())
    await sleep(300)
    agent.addUserMessage('还要多久')
    const result = await runPromise
    const elapsed = Date.now() - started
    expect(result).toContain('放后台了')
    expect(elapsed).toBeGreaterThanOrEqual(1800)
    expect(elapsed).toBeLessThan(3500)
    await sleep(2500)
    expect(timeline.filter(t => t === 'expired')).toHaveLength(1)
    expect(timeline).toHaveLength(2)
    expect(agent.isRunning()).toBe(false)
  }, 15000)

  itPosix('工具还在等时按停：正在等的那条也一起停', async () => {
    let pid: number | undefined
    const services = makeServices(({ index }) => {
      if (index === 0) {
        return { tool_calls: [tc('exec', { command: 'echo $$; sleep 30', wait_seconds: 30 })] }
      }
      return { content: '好' }
    })
    const agent = newAgent(services, 'e2e-exec-stop-waiting')
    const runPromise = agent.run('跑个长命令', ctx())
    await sleep(500)
    const running = getExecManager().list().find(t => t.status === 'running')
    pid = running?.pid
    expect(pid).toBeTruthy()
    agent.abort()
    await runPromise.catch(() => undefined)
    await sleep(4000)
    expect(groupAlive(pid!)).toBe(false)
  }, 15000)
})
