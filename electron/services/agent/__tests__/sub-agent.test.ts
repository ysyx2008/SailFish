/**
 * dispatch / followup / wait / interrupt：立刻返回名字，伙计在花名册里跑。
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/mock/user/data'),
    getName: vi.fn().mockReturnValue('SailFish'),
    getVersion: vi.fn().mockReturnValue('1.0.0')
  },
  BrowserWindow: vi.fn(),
  ipcMain: { on: vi.fn(), handle: vi.fn() }
}))

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
    readFileSync: vi.fn().mockReturnValue(''),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn().mockReturnValue([])
  }
})

vi.mock('../../im/im.service', () => ({
  getIMService: vi.fn().mockReturnValue(null)
}))

vi.mock('../../user-skill.service', () => ({
  getUserSkillService: () => ({ getEnabledSkills: () => [] })
}))

vi.mock('../../config.service', () => ({
  getConfigService: () => ({ get: () => undefined })
}))

vi.mock('../../web-search/index', () => ({
  isConfigured: () => false,
  getApiKey: () => '',
}))

import { dispatchSubAgents, followupAgent, waitAgents, interruptAgent } from '../tools/sub-agent'
import { SubAgentRoster, type ChildAgentHandle } from '../sub-agent-roster'
import type { ToolExecutorConfig, AgentConfig } from '../tools/types'
import type { AgentContext } from '../types'
import type { AgentStep } from '@shared/types'

const DEFAULT_CONTEXT: AgentContext = {
  terminalOutput: [],
  systemInfo: { os: 'darwin', shell: 'zsh' },
  terminalType: 'assistant',
  cwd: '/tmp',
}

const defaultConfig: AgentConfig = {
  enabled: true,
  maxSteps: 0,
  commandTimeout: 30000,
  autoExecuteSafe: true,
  autoExecuteModerate: true,
  executionMode: 'relaxed',
  debugMode: false
}

function stubChild(result = 'ok', delayMs = 40): ChildAgentHandle & { seeded: unknown[] } {
  let running = false
  let aborted = false
  const seeded: unknown[] = []
  return {
    seeded,
    isRunning: () => running,
    abort: () => { aborted = true; running = false; return true },
    addUserMessage: () => true,
    seedOpeningMessages: (messages) => {
      seeded.splice(0, seeded.length, ...messages)
    },
    async run() {
      running = true
      await new Promise(r => setTimeout(r, delayMs))
      running = false
      if (aborted) throw new Error('aborted')
      return result
    }
  }
}

function createExecutor(
  roster: SubAgentRoster,
  child: ChildAgentHandle | ((name: string) => ChildAgentHandle)
): ToolExecutorConfig {
  const steps: AgentStep[] = []
  let n = 0
  return {
    agentId: 'parent',
    terminalService: { getTerminalOutput: () => [], write: () => {}, getTerminalType: () => 'local' } as any,
    addStep: (partial: Partial<AgentStep>) => {
      const step = { ...partial, id: `s-${++n}`, timestamp: Date.now() } as AgentStep
      steps.push(step)
      return step
    },
    updateStep: (id: string, updates: Partial<AgentStep>) => {
      const step = steps.find(s => s.id === id)
      if (step) Object.assign(step, updates)
    },
    waitForConfirmation: async () => true,
    requestSecureInput: async () => false,
    isAborted: () => false,
    getHostId: () => undefined,
    hasPendingUserMessage: () => false,
    peekPendingUserMessage: () => undefined,
    consumePendingUserMessage: () => undefined,
    getRealtimeTerminalOutput: () => [],
    getCurrentPlan: () => undefined,
    setCurrentPlan: () => {},
    getTaskMemory: () => ({ getTasks: () => [], getTask: () => undefined, saveTask: () => {}, clear: () => {} }) as any,
    getAgentContext: () => DEFAULT_CONTEXT,
    getAiRules: () => '',
    getSubAgentRoster: () => roster,
    getParentMessages: () => [
      { role: 'user' as const, content: '查 nginx' },
      { role: 'assistant' as const, content: '', tool_calls: [{ id: '1', type: 'function' as const, function: { name: 'dispatch_agents', arguments: '{}' } }] },
    ],
    knockParent: () => {},
    createChildAgent: (name: string) => typeof child === 'function' ? child(name) : child,
    _steps: steps,
  } as any
}

describe('dispatch_agents 异步派出', () => {
  it('立刻返回名字，不等伙计做完', async () => {
    const roster = new SubAgentRoster()
    const child = stubChild('配置在 /etc')
    const executor = createExecutor(roster, child)
    const started = Date.now()
    const result = await dispatchSubAgents({
      tasks: [{ description: '读配置', prompt: '去读 nginx' }]
    }, defaultConfig, executor)
    expect(Date.now() - started).toBeLessThan(50)
    expect(result.success).toBe(true)
    expect(result.output).toContain('读配置')
    expect(roster.hasLive()).toBe(true)
    await roster.waitUntil(undefined, new AbortController().signal)
    expect(roster.hasLive()).toBe(false)
    expect(roster.list()[0].result).toBe('配置在 /etc')
  })

  it('followup / interrupt 走花名册', async () => {
    const roster = new SubAgentRoster()
    const child = stubChild('v1')
    const executor = createExecutor(roster, child)
    await dispatchSubAgents({
      tasks: [{ name: 'alice', description: '读配置', prompt: '去读' }]
    }, defaultConfig, executor)

    const follow = await followupAgent({ name: 'alice', message: '再看一眼端口' }, executor)
    expect(follow.success).toBe(true)

    const stop = await interruptAgent({ name: 'alice' }, executor)
    expect(stop.success).toBe(true)
    expect(roster.hasLive()).toBe(true)
    await roster.waitUntil(['alice'], new AbortController().signal)
    expect(roster.get('alice')?.status).toBe('interrupted')
  })

  it('wait_agents 超时后返回还在跑的状态，不挂死', async () => {
    const roster = new SubAgentRoster()
    let rejectRun: ((err: Error) => void) | undefined
    const slow: ChildAgentHandle = {
      isRunning: () => true,
      abort: () => {
        rejectRun?.(new Error('aborted'))
        return true
      },
      addUserMessage: () => true,
      seedOpeningMessages: () => {},
      run: () => new Promise((_, reject) => { rejectRun = reject }),
    }
    const executor = createExecutor(roster, slow)
    await dispatchSubAgents({
      tasks: [{ name: 'slow', description: '慢任务', prompt: '一直做' }]
    }, defaultConfig, executor)
    const started = Date.now()
    const waited = await waitAgents({ names: ['slow'], timeout: 1 }, executor)
    expect(Date.now() - started).toBeLessThan(2000)
    expect(waited.success).toBe(true)
    expect(waited.output).toMatch(/还没有新消息|no new update|还在做|still working/)
    expect(roster.hasLive()).toBe(true)
    roster.abortAll()
    await roster.waitUntil(['slow'], new AbortController().signal)
  })

  it('wait_agents 等到做完', async () => {
    const roster = new SubAgentRoster()
    const child = stubChild('done')
    const executor = createExecutor(roster, child)
    await dispatchSubAgents({
      tasks: [{ name: 'bob', description: '调研', prompt: '搜一下' }]
    }, defaultConfig, executor)
    const waited = await waitAgents({ names: ['bob'] }, executor)
    expect(waited.output).toContain('bob')
    expect(waited.output).not.toContain('done')
    expect(roster.hasLive()).toBe(false)
  })

  it('wait_agents 第一个人回来就返回，不把全文再报一遍', async () => {
    const roster = new SubAgentRoster()
    const fast = stubChild('快的：name=SailFish', 20)
    const slow = stubChild('慢的：README 三句话', 80)
    const executor = createExecutor(roster, (name) => name === '读包' ? fast : slow)
    await dispatchSubAgents({
      tasks: [
        { name: '读包', description: '读包', prompt: '读 package.json' },
        { name: '读说明', description: '读说明', prompt: '读 README' },
      ]
    }, defaultConfig, executor)

    const started = Date.now()
    const waited = await waitAgents({ names: ['读包', '读说明'] }, executor)
    expect(Date.now() - started).toBeLessThan(150)
    expect(waited.success).toBe(true)
    expect(waited.output).toMatch(/有新消息|There is an update/)
    expect(waited.output).toContain('读包')
    expect(waited.output).not.toContain('快的：name=SailFish')
    expect(waited.output).not.toContain('慢的：README')
    expect(roster.hasLive()).toBe(true)
  })

  it('fork_turns=none 时伙计开局不带这场对话', async () => {
    const roster = new SubAgentRoster()
    const child = stubChild('ok', 1)
    const executor = createExecutor(roster, child)
    await dispatchSubAgents({
      tasks: [{
        name: '读包',
        description: '读包',
        prompt: '只报 name',
        fork_turns: 'none',
      }]
    }, defaultConfig, executor)
    await roster.waitUntil(['读包'], new AbortController().signal)
    expect(child.seeded).toEqual([])
  })

  it('后一批进度不会把前面的卡片刷成整场花名册', async () => {
    const roster = new SubAgentRoster()
    const child = (): ChildAgentHandle => {
      let running = false
      return {
        isRunning: () => running,
        abort: () => { running = false; return true },
        addUserMessage: () => true,
        seedOpeningMessages: () => {},
        async run(_message, _context, options) {
          running = true
          await new Promise(r => setTimeout(r, 15))
          options?.callbacks?.onStep?.('child', {
            id: 'tool',
            type: 'tool_call',
            content: 'search',
            toolName: 'web_search',
            timestamp: Date.now(),
          })
          await new Promise(r => setTimeout(r, 15))
          running = false
          return 'ok'
        },
      }
    }
    const executor = createExecutor(roster, child)
    await dispatchSubAgents({
      tasks: [{ name: '海外', description: '海外搜索', prompt: '挖海外' }],
    }, defaultConfig, executor)
    await dispatchSubAgents({
      tasks: [
        { name: 'serp', description: 'SERP', prompt: '挖 SERP' },
        { name: '国内', description: '国内', prompt: '挖国内' },
      ],
    }, defaultConfig, executor)

    await roster.waitUntil(undefined, new AbortController().signal)

    const steps = (executor as unknown as { _steps: AgentStep[] })._steps
    const cards = steps.filter(s => s.toolName === 'dispatch_agents')
    expect(cards).toHaveLength(2)
    expect(cards[0].subAgents?.map(a => a.name)).toEqual(['海外'])
    expect(cards[1].subAgents?.map(a => a.name)).toEqual(['serp', '国内'])
    expect(cards[0].content).toContain('1')
    expect(cards[1].content).toContain('2')
  })

  it('非法 fork_turns 直接拒绝派出', async () => {
    const roster = new SubAgentRoster()
    const child = stubChild('ok', 1)
    const executor = createExecutor(roster, child)
    const result = await dispatchSubAgents({
      tasks: [{
        name: '读包',
        description: '读包',
        prompt: '只报 name',
        fork_turns: 'banana',
      }]
    }, defaultConfig, executor)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/fork_turns/)
    expect(roster.hasLive()).toBe(false)
  })
})
