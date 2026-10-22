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

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { dispatchSubAgents, followupAgent, waitAgents, interruptAgent, parseDispatchTasks, SubAgentWorkspace } from '../tools/sub-agent'
import { getAgentTools } from '../tools'
import { MAX_LIVE_CHILDREN, SubAgentRoster, type ChildAgentHandle } from '../sub-agent-roster'
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

  it('回执说清现在没做完几个、还能派几个', async () => {
    const roster = new SubAgentRoster()
    const executor = createExecutor(roster, () => stubChild('ok', 200))
    const result = await dispatchSubAgents({
      tasks: Array.from({ length: 12 }, (_, i) => ({ description: `第 ${i} 个`, prompt: '干活' }))
    }, defaultConfig, executor)
    expect(result.success).toBe(true)
    expect(result.output).toContain(`现在没做完的共 12 个，还能再派 ${MAX_LIVE_CHILDREN - 12} 个`)
    roster.abortAll()
  })

  it('超过保险丝整批不派，并把上限和余量告诉秘书', async () => {
    const roster = new SubAgentRoster()
    const executor = createExecutor(roster, () => stubChild('ok', 200))
    const result = await dispatchSubAgents({
      tasks: Array.from({ length: MAX_LIVE_CHILDREN + 1 }, (_, i) => ({ description: `第 ${i} 个`, prompt: '干活' }))
    }, defaultConfig, executor)
    expect(result.success).toBe(false)
    expect(result.error).toContain(String(MAX_LIVE_CHILDREN))
    expect(result.error).toContain(`这次要派 ${MAX_LIVE_CHILDREN + 1} 个`)
    expect(roster.list()).toHaveLength(0)
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
    const roster = new SubAgentRoster({ knockSettleMs: 0 })
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
    expect(waited.output).toContain('新到：读包（已完成）')
    expect(waited.output).toContain('要等的 2 个里：做完 1 / 在干 1 / 失败 0 / 已打断 0')
    expect(waited.output).not.toContain('快的：name=SailFish')
    expect(waited.output).not.toContain('慢的：README')
    expect(roster.hasLive()).toBe(true)
  })

  it('wait_agents 人多时只报计数和新到的，不列全员', async () => {
    const roster = new SubAgentRoster({ knockSettleMs: 0 })
    const executor = createExecutor(roster, (name) => stubChild('ok', name === 'w0' ? 10 : 5000))
    await dispatchSubAgents({
      batch: { instruction: '干', items: Array.from({ length: 30 }, (_, i) => ({ name: `w${i}`, description: `w${i}`, input: `${i}` })) }
    }, defaultConfig, executor)
    const waited = await waitAgents({}, executor)
    expect(waited.output.split('\n')).toHaveLength(3)
    expect(waited.output).toContain('新到：w0（已完成）')
    expect(waited.output).toContain('要等的 30 个里：做完 1 / 在干 29')
    expect(waited.output).toContain('overview.md')
    expect(waited.output).not.toContain('w17')
    roster.abortAll()
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

describe('两种写法', () => {
  it('batch：每个条目一个伙计，指令是共同指令、换行、本条目', () => {
    const parsed = parseDispatchTasks({
      batch: {
        instruction: '读这个文件，列出导出的函数',
        items: [
          { name: '读 a', description: '读 a.ts', input: 'src/a.ts' },
          { description: '读 b.ts', input: 'src/b.ts' },
        ],
      },
    })
    if ('error' in parsed) throw new Error(parsed.error)
    expect(parsed.tasks.map(t => t.prompt)).toEqual([
      '读这个文件，列出导出的函数\nsrc/a.ts',
      '读这个文件，列出导出的函数\nsrc/b.ts',
    ])
    expect(parsed.tasks[0].name).toBe('读 a')
    expect(parsed.tasks[1].description).toBe('读 b.ts')
  })

  it('两种写法默认都全带对话；batch 的 fork_turns 这一批共用', () => {
    const defaults = parseDispatchTasks({
      tasks: [{ description: 'x', prompt: 'x' }],
      batch: { instruction: '做', items: [{ description: 'y', input: 'y' }] },
    })
    if ('error' in defaults) throw new Error(defaults.error)
    expect(defaults.tasks.map(t => t.forkTurns)).toEqual([{ kind: 'all' }, { kind: 'all' }])

    const none = parseDispatchTasks({
      batch: { instruction: '做', fork_turns: 'none', items: [{ description: 'a', input: 'a' }, { description: 'b', input: 'b' }] },
    })
    if ('error' in none) throw new Error(none.error)
    expect(none.tasks.map(t => t.forkTurns.kind)).toEqual(['none', 'none'])
  })

  it('两个都没给、给了空的、缺共同指令或条目内容，都报错', () => {
    expect(parseDispatchTasks({})).toHaveProperty('error')
    expect(parseDispatchTasks({ tasks: [] })).toHaveProperty('error')
    expect(parseDispatchTasks({ batch: { instruction: '', items: [{ description: 'a', input: 'a' }] } })).toHaveProperty('error')
    expect(parseDispatchTasks({ batch: { instruction: '做', items: [] } })).toHaveProperty('error')
    expect(parseDispatchTasks({ batch: { instruction: '做', items: [{ description: 'a' }] } })).toHaveProperty('error')
  })

  it('混用时一起派出，合起来算进保险丝', async () => {
    const roster = new SubAgentRoster()
    const executor = createExecutor(roster, () => stubChild('ok', 200))
    const ok = await dispatchSubAgents({
      tasks: [{ name: '单独的', description: '单独的', prompt: '干' }],
      batch: { instruction: '读', items: Array.from({ length: 3 }, (_, i) => ({ description: `条目 ${i}`, input: `${i}` })) },
    }, defaultConfig, executor)
    expect(ok.success).toBe(true)
    expect(roster.liveCount()).toBe(4)

    const over = await dispatchSubAgents({
      tasks: [{ description: '再来', prompt: '干' }],
      batch: { instruction: '读', items: Array.from({ length: MAX_LIVE_CHILDREN - 4 }, (_, i) => ({ description: `b${i}`, input: `${i}` })) },
    }, defaultConfig, executor)
    expect(over.success).toBe(false)
    expect(roster.liveCount()).toBe(4)
    roster.abortAll()
  })

  it('模型还在写参数时，预卡片人数把两种写法加在一起', () => {
    const tool = getAgentTools(undefined, { mode: 'assistant' }).find(t => t.function.name === 'dispatch_agents') as any
    const render = tool._meta.streamDisplay.customRender as (args: Record<string, unknown>) => string | null
    expect(render({
      tasks: [{ description: 'a', prompt: 'a' }],
      batch: { instruction: '读', items: [{ description: 'b', input: 'b' }, { description: 'c', input: 'c' }] },
    })).toBe('派出 3 个伙计')
  })

  it('工具说明里写着保险丝的数', () => {
    const tool = getAgentTools(undefined, { mode: 'assistant' }).find(t => t.function.name === 'dispatch_agents')!
    expect(tool.function.description).toContain(String(MAX_LIVE_CHILDREN))
    expect(Object.keys((tool.function.parameters as { properties: object }).properties).sort()).toEqual(['batch', 'tasks', 'team'])
  })
})

describe('结果落文件与总览', () => {
  it('直接带回的字数随这一轮派的人数收紧，夹在 1000 到 8000 之间', () => {
    expect(SubAgentWorkspace.inlineLimit(1)).toBe(8000)
    expect(SubAgentWorkspace.inlineLimit(5)).toBe(8000)
    expect(SubAgentWorkspace.inlineLimit(10)).toBe(4000)
    expect(SubAgentWorkspace.inlineLimit(40)).toBe(1000)
    expect(SubAgentWorkspace.inlineLimit(200)).toBe(1000)
  })

  it('结果全文都落文件；超出上限的对话里只留尾部和位置；总览一人一行', async () => {
    const realFs = await vi.importActual<typeof import('fs')>('fs')
    const dir = realFs.mkdtempSync(path.join(os.tmpdir(), 'sub-agent-ws-'))
    const writes = new Map<string, string>()
    vi.mocked(fs.writeFileSync).mockImplementation((file, data) => { writes.set(String(file), String(data)) })
    try {
      const ws = new SubAgentWorkspace(dir)
      const short = ws.keepResult('短的', '三句话', 40)
      const long = ws.keepResult('长的', 'x'.repeat(5000), 40)
      expect(short).toBe('三句话')
      expect(long.length).toBeLessThan(1500)
      expect(long).toContain(path.join(dir, '长的.md'))
      expect(writes.get(path.join(dir, '长的.md'))).toHaveLength(5000)

      ws.writeOverview([
        { name: '短的', description: '读 a', prompt: 'a', status: 'completed', steps: [] },
        { name: '长的', description: '读 b', prompt: 'b', status: 'completed', steps: [] },
        { name: '还在干', description: '读 c', prompt: 'c', status: 'running', steps: [] },
      ])
      const overview = writes.get(ws.overviewPath)!.trim().split('\n')
      expect(overview[0]).toContain('共 3 个')
      expect(overview).toHaveLength(5)
      expect(overview[3]).toContain(`长的 | 已完成 | 5000 | ${path.join(dir, '长的.md')} | 读 b`)
      expect(overview[4]).toContain('还在干 | 还在做 | - | - | 读 c')
    } finally {
      vi.mocked(fs.writeFileSync).mockReset()
      realFs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('进度推给界面', () => {
  function chattyChild(opts: { steps: number; waitFirst?: boolean }): ChildAgentHandle {
    let running = false
    return {
      isRunning: () => running,
      abort: () => { running = false; return true },
      addUserMessage: () => true,
      async run(_message, _context, options) {
        running = true
        const cb = options?.callbacks
        if (opts.waitFirst) {
          cb?.onModelWait?.('child', true)
          await new Promise(r => setTimeout(r, 60))
          cb?.onModelWait?.('child', false)
        }
        for (let i = 0; i < opts.steps; i++) {
          cb?.onStep?.('child', { id: `t${i}`, type: 'tool_call', toolName: 'read_file', toolArgs: { path: `/f${i}` }, content: '', timestamp: 0 } as AgentStep)
          cb?.onStep?.('child', { id: `t${i}`, type: 'tool_call', toolName: 'read_file', toolArgs: { path: `/f${i}` }, success: true, toolResult: 'x'.repeat(10_000), content: '', timestamp: 0 } as AgentStep)
        }
        await new Promise(r => setTimeout(r, 20))
        running = false
        return 'ok'
      },
    }
  }

  it('一批伙计的变化攒在一起推，最后的样子一定推出去，且不带工具输出', async () => {
    const roster = new SubAgentRoster({ knockSettleMs: 0 })
    const executor = createExecutor(roster, () => chattyChild({ steps: 20 }))
    let pushes = 0
    const update = executor.updateStep
    executor.updateStep = (id, updates) => {
      if (updates.subAgents) pushes++
      update(id, updates)
    }
    await dispatchSubAgents({
      batch: { instruction: '很长的共同指令'.repeat(50), items: Array.from({ length: 30 }, (_, i) => ({ name: `w${i}`, description: `w${i}`, input: `条目 ${i}` })) }
    }, defaultConfig, executor)
    await roster.waitUntil(undefined, new AbortController().signal)
    await new Promise(r => setTimeout(r, 300))

    // 30 人 × 40 次变化，不节流会推上千次
    expect(pushes).toBeLessThan(80)
    const step = (executor as any)._steps.find((s: AgentStep) => s.toolName === 'dispatch_agents') as AgentStep
    expect(step.subAgents).toHaveLength(30)
    expect(step.subAgents!.every(sa => sa.status === 'completed')).toBe(true)
    expect(step.subAgents![0].steps).toHaveLength(20)
    expect(step.subAgents![0].steps!.every(st => st.result === undefined)).toBe(true)
    expect(step.subAgents![3].prompt).toBe('条目 3')
    expect((step.toolArgs as { batch?: { instruction: string } }).batch?.instruction).toBe('很长的共同指令'.repeat(50))
  })

  it('伙计在排队等模型时卡片上看得出来，拿到名额后恢复', async () => {
    const roster = new SubAgentRoster({ knockSettleMs: 0 })
    const executor = createExecutor(roster, () => chattyChild({ steps: 1, waitFirst: true }))
    await dispatchSubAgents({ tasks: [{ name: 'a', description: 'a', prompt: 'a' }] }, defaultConfig, executor)
    await new Promise(r => setTimeout(r, 30))
    const step = () => (executor as any)._steps.find((s: AgentStep) => s.toolName === 'dispatch_agents') as AgentStep
    expect(step().subAgents![0].waitingForModel).toBe(true)
    await roster.waitUntil(undefined, new AbortController().signal)
    await new Promise(r => setTimeout(r, 300))
    expect(step().subAgents![0].waitingForModel).toBeUndefined()
  })
})
