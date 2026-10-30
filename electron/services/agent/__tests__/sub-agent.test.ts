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
import { dispatchSubAgents, followupAgent, waitAgents, interruptAgent, parseDispatchTasks, seedOrganizationBoard, SubAgentWorkspace, viewStepsPerAgent } from '../tools/sub-agent'
import { getAgentTools } from '../tools'
import { MAX_LIVE_CHILDREN, SubAgentRoster, type ChildAgentHandle } from '../sub-agent-roster'
import { OrgLedger } from '../org-ledger'
import type { ToolExecutorConfig, AgentConfig } from '../tools/types'
import type { AgentContext } from '../types'
import type { AgentStep, OrganizationView } from '@shared/types'

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

  it('秘书不能在一次派出里同时带团和指定组长', async () => {
    const roster = new SubAgentRoster()
    const executor = createExecutor(roster, stubChild('ok'))
    const result = await dispatchSubAgents({
      team: '研发团',
      tasks: [
        { description: '定路线', prompt: '定路线', role: '技术负责人', lead: true },
        { description: '对比', prompt: '对比', role: '选型' },
        { description: '估算', prompt: '估算', role: '估算' },
      ],
    }, defaultConfig, executor)
    expect(result.success).toBe(false)
    expect(result.error).toContain('只派组长')
    expect(roster.list()).toHaveLength(0)
  })

  it('秘书不能把组长装进一个上级团，组长应该直管', async () => {
    const roster = new SubAgentRoster()
    const executor = createExecutor(roster, stubChild('ok'))
    const result = await dispatchSubAgents({
      team: '项目组',
      tasks: [
        { description: '带研发组', prompt: '带研发组', role: '研发组长', lead: true },
        { description: '带运营组', prompt: '带运营组', role: '运营组长', lead: true },
      ],
    }, defaultConfig, executor)
    expect(result.success).toBe(false)
    expect(roster.list()).toHaveLength(0)
  })

  it('秘书可以一次派两位组长，组长自己组人', async () => {
    const roster = new SubAgentRoster()
    const executor = createExecutor(roster, stubChild('ok'))
    const result = await dispatchSubAgents({
      tasks: [
        { description: '带研发组', prompt: '带研发组', role: '研发组长', lead: true },
        { description: '带运营组', prompt: '带运营组', role: '运营组长', lead: true },
      ],
    }, defaultConfig, executor)
    expect(result.success).toBe(true)
    expect(roster.list()).toHaveLength(2)
    expect(roster.list().every(c => c.lead)).toBe(true)
    roster.abortAll()
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

  it('再交代一位组长：这一步也带上组织全貌，之后跟着全组织刷新', async () => {
    const roster = new SubAgentRoster({ knockSettleMs: 0 })
    const executor = createExecutor(roster, stubChild('ok', 5000))
    await dispatchSubAgents({
      tasks: [{ name: '研发组', role: '研发组长', lead: true, description: '带研发组做事', prompt: '带研发组做事' }]
    }, defaultConfig, executor)
    const follow = await followupAgent({ name: '研发组', message: '再查一下' }, executor)
    expect(follow.success).toBe(true)
    const step = (executor as unknown as { _steps: AgentStep[] })._steps.at(-1)
    expect(step?.organization?.members.map(m => m.name)).toContain('研发组')
    roster.abortAll()
  })

  it('组长再交代自己的成员时，不把全组织快照写进组长的步骤', async () => {
    const ledger = new OrgLedger()
    const root = new SubAgentRoster()
    root.attachLedger(ledger, undefined, 0)
    const lead = new SubAgentRoster({ knockSettleMs: 0 })
    lead.attachLedger(ledger, '研发组长', 1)
    const executor = createExecutor(lead, stubChild('ok', 50))
    await dispatchSubAgents({ tasks: [{ name: '甲', description: '甲', prompt: '甲' }] }, defaultConfig, executor)
    expect((await followupAgent({ name: '甲', message: '再看' }, executor)).success).toBe(true)
    const step = (executor as unknown as { _steps: AgentStep[] })._steps.at(-1)
    expect(step?.organization).toBeUndefined()
    lead.abortAll(); await lead.settled(); lead.release(); root.release()
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

  it('wait_agents 点名别枝的人：等到他停下，不领走他主人的敲门', async () => {
    const ledger = new OrgLedger()
    const root = new SubAgentRoster()
    root.attachLedger(ledger, undefined, 0)
    const lead = new SubAgentRoster({ knockSettleMs: 0 })
    lead.attachLedger(ledger, '研发组长', 1)
    const leadExecutor = createExecutor(lead, stubChild('做完了', 20))
    await dispatchSubAgents({
      tasks: [{ name: '小甲', description: '读配置', prompt: '去读' }]
    }, defaultConfig, leadExecutor)

    const waited = await waitAgents({ names: ['小甲'], timeout: 2 }, createExecutor(root, stubChild('unused')))
    expect(waited.success).toBe(true)
    expect(waited.output).toContain('要等的 1 个里：做完 1')
    // 敲门还在组长的名册上，组长自己等得到
    const leaderNews = await lead.waitForNews(['小甲'], new AbortController().signal)
    expect(leaderNews.arrived.map(c => c.name)).toEqual(['小甲'])
  })

  it('直接恢复深层成员后，不点名也会等到他，并保留负责人的敲门', async () => {
    const root = new SubAgentRoster({ knockSettleMs: 0 })
    const executor = createExecutor(root, stubChild('unused'))
    executor.restoreDormantChildren = () => [
      { name: '研发组长', lead: true, role: '负责人', description: '研发', prompt: '研发', status: 'completed', revive: () => { throw new Error('不应运行组长') } },
      { name: '小甲', parent: '研发组长', description: '核对', prompt: '核对', status: 'completed', revive: () => ({ handle: stubChild('核对完成', 50), steps: [] }) },
    ]
    expect((await followupAgent({ name: '小甲', message: '继续' }, executor)).success).toBe(true)
    const started = Date.now()
    const waited = await waitAgents({ timeout: 2 }, executor)
    expect(Date.now() - started).toBeGreaterThanOrEqual(30)
    expect(waited.success).toBe(true)
    expect(waited.output).not.toContain('没有要等的伙计')
    expect(waited.output).toContain('要等的 1 个里：做完 1')
    const holder = root.orgEntries().find(entry => entry.owner === '研发组长')!.roster
    const news = await holder.waitForNews(['小甲'], new AbortController().signal)
    expect(news.arrived.map(member => member.name)).toEqual(['小甲'])
    root.abortAll(); await root.settled(); root.release()
  })

  it('跨枝一起等时，本枝先回来就先返回，不被别枝的慢活拖住', async () => {
    const ledger = new OrgLedger()
    const root = new SubAgentRoster({ knockSettleMs: 0 })
    root.attachLedger(ledger, undefined, 0)
    const lead = new SubAgentRoster({ knockSettleMs: 0 })
    lead.attachLedger(ledger, '研发组长', 1)
    const rootExecutor = createExecutor(root, stubChild('本地做完了', 20))
    const leadExecutor = createExecutor(lead, stubChild('远处还在干', 5000))
    await dispatchSubAgents({
      tasks: [{ name: '本地', description: '本地活', prompt: '本地活' }]
    }, defaultConfig, rootExecutor)
    await dispatchSubAgents({
      tasks: [{ name: '远处', description: '远处的活', prompt: '远处的活' }]
    }, defaultConfig, leadExecutor)

    const started = Date.now()
    const waited = await waitAgents({ names: ['本地', '远处'], timeout: 10 }, rootExecutor)
    expect(Date.now() - started).toBeLessThan(1000)
    expect(waited.output).toContain('新到：本地')
    // 组长不能等别枝的人
    const fromLead = await waitAgents({ names: ['本地'], timeout: 1 }, leadExecutor)
    expect(fromLead.output).toContain('没有要等的伙计')
    root.abortAll()
    lead.abortAll()
  })

  it('派人的回执按全组织算没做完的人', async () => {
    const ledger = new OrgLedger()
    const root = new SubAgentRoster()
    root.attachLedger(ledger, undefined, 0)
    const lead = new SubAgentRoster()
    lead.attachLedger(ledger, '研发组长', 1)
    const executor = createExecutor(lead, stubChild('ok', 5000))
    await dispatchSubAgents({
      tasks: [{ name: '甲', description: 'a', prompt: 'a' }]
    }, defaultConfig, executor)
    const second = await dispatchSubAgents({
      tasks: [{ name: '乙', description: 'b', prompt: 'b' }]
    }, defaultConfig, executor)
    expect(second.output).toContain('全组织现在没做完的共 2 个')
    lead.abortAll()
  })

  it('派出组长：名单里写着「组长·名字」，并说明团里的人由组长自己管', async () => {
    const roster = new SubAgentRoster({ knockSettleMs: 0 })
    const executor = createExecutor(roster, stubChild('ok', 5000))
    const result = await dispatchSubAgents({
      tasks: [
        { name: '研发组长', description: '带研发组', prompt: '带研发组', role: '研发组长', lead: true },
        { name: '运营组长', description: '带运营组', prompt: '带运营组', role: '运营组长', lead: true },
      ],
    }, defaultConfig, executor)
    expect(result.output).toContain('组长·研发组长（研发组长）')
    expect(result.output).toContain('团里的人怎么分、怎么验收由他们管')
    roster.abortAll()
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

  it('等的时候用户说话：这次等待先停下、说明原因，伙计照旧在跑；用户没说话才等到超时', async () => {
    const roster = new SubAgentRoster({ knockSettleMs: 0 })
    const executor = createExecutor(roster, stubChild('ok', 5000))
    let userSpoke = false
    executor.hasPendingUserSpeech = () => userSpoke
    await dispatchSubAgents({ tasks: [{ name: 'a', description: 'a', prompt: 'a' }] }, defaultConfig, executor)

    setTimeout(() => { userSpoke = true }, 300)
    const started = Date.now()
    const waited = await waitAgents({ timeout: 120 }, executor)
    expect(Date.now() - started).toBeLessThan(2000)
    expect(waited.success).toBe(true)
    expect(waited.output).toContain('用户发来了新消息，这次等待先停下')
    expect(waited.output).toContain('在干 1')
    expect(roster.hasLive()).toBe(true)

    // 用户那句已经处理掉了：再等就是正常的等，到超时才返回
    userSpoke = false
    const quiet = await waitAgents({ timeout: 1 }, executor)
    expect(quiet.output).toContain('等了 1 秒，还没有新消息')
    roster.abortAll()
  })

  it('等之前用户已经说了话：谁都没做完也立刻返回，不等到超时', async () => {
    const roster = new SubAgentRoster({ knockSettleMs: 0 })
    const executor = createExecutor(roster, stubChild('ok', 5000))
    executor.hasPendingUserSpeech = () => true
    await dispatchSubAgents({ tasks: [{ name: 'slow', description: 'slow', prompt: 'b' }] }, defaultConfig, executor)
    const started = Date.now()
    const waited = await waitAgents({ timeout: 120 }, executor)
    expect(Date.now() - started).toBeLessThan(1000)
    expect(waited.output).toContain('用户发来了新消息，这次等待先停下')
    expect(waited.output).toContain('在干 1')
    roster.abortAll()
  })

  it('用户说话的同时刚好有人做完：新到的照报', async () => {
    const roster = new SubAgentRoster({ knockSettleMs: 0 })
    const executor = createExecutor(roster, (name) => stubChild('ok', name === 'quick' ? 5 : 5000))
    executor.hasPendingUserSpeech = () => true
    await dispatchSubAgents({
      tasks: [
        { name: 'quick', description: 'quick', prompt: 'a' },
        { name: 'slow', description: 'slow', prompt: 'b' },
      ]
    }, defaultConfig, executor)
    await new Promise(r => setTimeout(r, 60))
    const waited = await waitAgents({ timeout: 120 }, executor)
    expect(waited.output).toContain('新到：quick（已完成）')
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
    expect(Object.keys((tool.function.parameters as { properties: object }).properties).sort()).toEqual(['batch', 'continue_team', 'remote_commands', 'tasks', 'team'])
  })
})

describe('结果落文件与总览', () => {
  it('落盘目录按会话固定：中途退出后再跑，路径还对得上', () => {
    const first = new SubAgentWorkspace('/tmp/before-crash')
    first.bindSession('sess-1')
    const second = new SubAgentWorkspace('/tmp/next-run')
    second.bindSession('sess-1')
    expect(first.organizationView().sessionId).toBe('sess-1')
    expect(second.organizationView().sessionId).toBe('sess-1')
    expect(first.overviewPath).toContain('session-sess-1')
    expect(second.overviewPath).toBe(first.overviewPath)
  })

  it('超过 100 个团仍完整提供，不丢团框和群聊入口', () => {
    const ws = new SubAgentWorkspace('/tmp/org-team-limit')
    const teamViews = Array.from({ length: 101 }, (_, i) => ({
      name: `团${i}`, review: 'none', messageCount: 0, waitingLeader: false, wakeLimit: 30,
    }))
    ;(ws as unknown as { boardSections: Map<string, unknown> }).boardSections.set('', {
      owner: undefined, depth: 0, rows: [], teams: [], live: 0, total: 0, members: [], teamViews,
    })
    const view = ws.organizationView()
    expect(view.teams).toHaveLength(101)
    expect(view.omittedTeams).toBeUndefined()
  })

  it('重开时先用保存的组织全貌把看板铺出来', () => {
    const ws = new SubAgentWorkspace('/tmp/org-seed-board')
    const view: OrganizationView = {
      members: [
        { id: '研发组', name: '研发组', description: '带研发组', status: 'running', lead: true, role: '研发组长' },
        { id: '小甲', name: '小甲', description: '写甲', status: 'completed', parent: '研发组', team: '项目团' },
      ],
      teams: [{ name: '项目团', owner: '研发组', review: 'pass', reviewers: ['小甲'], messageCount: 3, waitingLeader: false, wakeLimit: 30 }],
      live: 1,
      total: 2,
    }
    seedOrganizationBoard(ws, view)
    const seeded = ws.organizationView()
    expect(seeded.members.map(m => m.name)).toEqual(['研发组', '小甲'])
    expect(seeded.teams[0]).toMatchObject({ name: '项目团', owner: '研发组', review: 'pass' })
    expect(seeded.live).toBe(1)
    ws.rememberBoardSection({ owner: '研发组', depth: 1, rows: [], teams: [], live: 0, total: 1,
      members: seeded.members.filter(m => m.parent === '研发组'), teamViews: [],
    })
    expect(ws.organizationView().teams).toEqual(seeded.teams)
    // 截断过的快照不铺：铺出来会把看得到的部分当成全组织
    const truncated = new SubAgentWorkspace('/tmp/org-seed-truncated')
    seedOrganizationBoard(truncated, { ...view, omitted: 5 })
    expect(truncated.hasBoard()).toBe(false)
  })

  it('超过 200 人仍保留所有节点与真实异常合计', () => {
    const ws = new SubAgentWorkspace('/tmp/org-member-limit')
    const member = (name: string, status: string) => ({ id: name, name, description: '', status })
    const members = Array.from({ length: 200 }, (_, i) => member(`m${i}`, 'completed'))
    members.push(member('bad', 'failed'))
    ;(ws as unknown as { boardSections: Map<string, unknown> }).boardSections.set('', {
      owner: undefined, depth: 0, rows: [], teams: [], live: 0, total: 201, members, teamViews: [],
    })
    const view = ws.organizationView()
    expect(view.members).toHaveLength(201)
    expect(view.omitted).toBeUndefined()
    expect(view.problems).toBe(1)
  })

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

      ws.writeOverview([
        {
          name: '忙的', description: '读 d', prompt: 'd', status: 'running',
          steps: [
            { tool: 'read_file', status: 'completed' },
            { tool: 'exec', status: 'running' },
          ],
        },
        { name: '排队的', description: '读 e', prompt: 'e', status: 'running', steps: [], waitingForModel: true },
        { name: '排队又忙', description: '读 f', prompt: 'f', status: 'running', steps: [{ tool: 'grep', status: 'completed' }], waitingForModel: true },
        { name: '没开工', description: '读 g', prompt: 'g', status: 'pending', steps: [] },
        { name: '做完了', description: '读 h', prompt: 'h', status: 'completed', steps: [{ tool: 'exec', status: 'completed' }] },
      ])
      const live = writes.get(ws.overviewPath)!.trim().split('\n')
      expect(live[2]).toContain('忙的 | 还在做（已 2 步，最近：exec） | - | - | 读 d')
      expect(live[3]).toContain('排队的 | 还在做（排队等模型） | - | - | 读 e')
      expect(live[4]).toContain('排队又忙 | 还在做（已 1 步，最近：grep；排队等模型）')
      expect(live[5]).toContain('没开工 | 还没开工 | - | - | 读 g')
      expect(live[6]).toContain('做完了 | 已完成 | - | - | 读 h')
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
    // 每人实际 20 步；派发那一步的视图按人数收紧，30 人时每人只留 viewStepsPerAgent(30) 步
    expect(step.subAgents![0].steps).toHaveLength(Math.min(20, viewStepsPerAgent(30)))
    expect(step.subAgents![0].steps!.every(st => st.result === undefined)).toBe(true)
    expect(step.subAgents![3].prompt).toBe('条目 3')
    expect((step.toolArgs as { batch?: { instruction: string } }).batch?.instruction).toBe('很长的共同指令'.repeat(50))
  })

  it('总览随进展重写：还在干的写做到第几步、最近的工具，不用等有人做完', async () => {
    const writes = new Map<string, string>()
    vi.mocked(fs.writeFileSync).mockImplementation((file, data) => { writes.set(String(file), String(data)) })
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const busy: ChildAgentHandle = {
      isRunning: () => true,
      abort: () => true,
      addUserMessage: () => true,
      async run(_message, _context, options) {
        const cb = options?.callbacks
        cb?.onStep?.('child', { id: 't0', type: 'tool_call', toolName: 'read_file', toolArgs: { path: '/a' }, content: '', timestamp: 0 } as AgentStep)
        cb?.onStep?.('child', { id: 't0', type: 'tool_call', toolName: 'read_file', toolArgs: { path: '/a' }, success: true, toolResult: 'x', content: '', timestamp: 0 } as AgentStep)
        await new Promise(r => setTimeout(r, 100))
        cb?.onStep?.('child', { id: 't1', type: 'tool_call', toolName: 'exec', toolArgs: { command: 'sleep 60' }, content: '', timestamp: 0 } as AgentStep)
        await gate
        return 'ok'
      },
    }
    try {
      const roster = new SubAgentRoster({ knockSettleMs: 0 })
      const executor = createExecutor(roster, () => busy)
      await dispatchSubAgents({ tasks: [{ name: 'a', description: '读配置', prompt: 'a' }] }, defaultConfig, executor)
      const overviewOf = () => [...writes].find(([file]) => file.endsWith('overview.md'))?.[1] ?? ''
      expect(overviewOf()).not.toContain('最近：exec')
      await new Promise(r => setTimeout(r, 1300))
      expect(overviewOf()).toContain('a | 还在做（已 2 步，最近：exec） | - | - | 读配置')
      release()
      await roster.waitUntil(undefined, new AbortController().signal)
    } finally {
      release()
      vi.mocked(fs.writeFileSync).mockReset()
    }
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


describe('独立团队边界', () => {
  it('历史百人不混入新三人，默认再次派出另开，明确指定才追加', async () => {
    const roster = new SubAgentRoster()
    const executor = createExecutor(roster, () => stubChild('ok', 5))
    executor.restoreDormantChildren = () => Array.from({length:100},(_,i)=>({name:`旧${i}`,description:'历史',prompt:'历史指令',status:'completed' as const,revive:()=>{throw Error('不应叫醒历史成员')}}))
    const tasks = (names:string[]) => names.map(name=>({name,description:name,prompt:'核对',role:'专家'}))
    const steps = () => (executor as ToolExecutorConfig & {_steps:AgentStep[]})._steps
    expect((await dispatchSubAgents({tasks:tasks(['新甲','新乙','新丙'])},defaultConfig,executor)).success).toBe(true)
    const first=steps()[0].organization!
    expect(first.total).toBe(3)
    expect(first.members.map(m=>m.name)).toEqual(['新甲','新乙','新丙'])
    expect(first.teamId).toBeTruthy()
    expect(first.teamId).not.toBe('legacy')
    expect((await dispatchSubAgents({tasks:tasks(['另甲','另乙'])},defaultConfig,executor)).success).toBe(true)
    const second=steps()[1].organization!
    expect(second.total).toBe(2)
    expect(second.teamId).not.toBe(first.teamId)
    expect((await dispatchSubAgents({tasks:tasks(['续甲']),continue_team:'新甲'},defaultConfig,executor)).success).toBe(true)
    const continued=steps()[2].organization!
    expect(continued.teamId).toBe(first.teamId)
    expect(continued.total).toBe(4)
    expect(continued.members.map(m=>m.name)).toEqual(['新甲','新乙','新丙','续甲'])
    expect(second.members.map(m=>m.name)).toEqual(['另甲','另乙'])
    await roster.settled()
  })
  it('不存在或格式错误的指定不创建成员，不退化成新队；组长不能另选队', async () => {
    const roster=new SubAgentRoster()
    const create=vi.fn(()=>stubChild('ok',1))
    const executor=createExecutor(roster,create)
    const tasks=[{name:'不应派出',description:'任务',prompt:'核对'}]
    for(const value of ['',null,42,'不存在']) expect((await dispatchSubAgents({tasks,continue_team:value},defaultConfig,executor)).success).toBe(false)
    expect(create).not.toHaveBeenCalled()
    expect(roster.list()).toEqual([])
    executor.isSubAgent=true
    expect((await dispatchSubAgents({tasks,continue_team:'旧团队成员'},defaultConfig,executor)).success).toBe(false)
  })
  it('重开后指定旧成员可续派原团队，历史小组名不会复用到新群',async()=>{
    const roster=new SubAgentRoster()
    const executor=createExecutor(roster,()=>stubChild('ok',1))
    executor.restoreDormantChildren=()=>[{name:'旧专家',teamId:'team-old',team:'审核组',description:'历史',prompt:'核对',role:'审核',status:'completed',revive:()=>{throw Error('不应叫醒')}}]
    const result=await dispatchSubAgents({tasks:[{name:'新审1',role:'审核',description:'核对',prompt:'核对'},{name:'新审2',role:'审核',description:'核对',prompt:'核对'}],team:'审核组',continue_team:'旧专家'},defaultConfig,executor)
    expect(result.success).toBe(true)
    expect(roster.get('新审1')?.teamId).toBe('team-old')
    expect(roster.get('新审1')?.team).not.toBe('审核组')
    const view=(executor as ToolExecutorConfig & {_steps:AgentStep[]})._steps[0].organization!
    expect(view.total).toBe(3)
    expect(view.members.every(m=>m.teamId==='team-old')).toBe(true)
    await roster.settled()
  })
})
