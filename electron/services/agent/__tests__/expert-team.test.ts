/**
 * 派专家、专家团：角色、群里点名叫醒、组长、每 30 次等组长、敲门规则。
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

import { ExpertTeam, TEAM_LEADER, WAKES_PER_CHECKPOINT } from '../expert-team'
import { SubAgentRoster, type ChildAgentHandle, type TeamSeat } from '../sub-agent-roster'
import { teamSay } from '../tools/expert'
import { dispatchSubAgents, parseDispatchTasks, followupAgent, waitAgents, denyIfNotForThisAgent, SubAgentWorkspace } from '../tools/sub-agent'
import { filterSubAgentTools, filterTeamMemberTools, getAgentTools, type ToolDefinitionWithMeta } from '../tools'
import { PromptBuilder } from '../prompt-builder'
import type { AgentConfig, ToolExecutorConfig } from '../tools/types'
import type { AgentContext } from '../types'
import type { AgentStep } from '@shared/types'

const CONTEXT: AgentContext = {
  terminalOutput: [],
  systemInfo: { os: 'darwin', shell: 'zsh' },
  terminalType: 'assistant',
  cwd: '/tmp',
}

const CONFIG: AgentConfig = {
  enabled: true,
  maxSteps: 0,
  commandTimeout: 30000,
  autoExecuteSafe: true,
  autoExecuteModerate: true,
  executionMode: 'relaxed',
  debugMode: false
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

/** 手动控制什么时候干完的专家 */
interface ManualChild extends ChildAgentHandle {
  /** 每次开跑交给他的话 */
  runs: string[]
  /** 在跑时补给他的话 */
  supplements: string[]
  seat?: TeamSeat
  finish(result?: string): void
  fail(message: string): void
}

function manualChild(): ManualChild {
  let running = false
  let settle: { resolve: (v: string) => void; reject: (e: Error) => void } | undefined
  const child: ManualChild = {
    runs: [],
    supplements: [],
    isRunning: () => running,
    abort: () => {
      running = false
      settle?.reject(new Error('aborted'))
      return true
    },
    addUserMessage: (message: string) => {
      child.supplements.push(message)
      return true
    },
    joinTeam: (seat: TeamSeat) => {
      child.seat = seat
    },
    run(message: string) {
      running = true
      child.runs.push(message)
      return new Promise<string>((resolve, reject) => {
        settle = {
          resolve: (v) => { running = false; resolve(v) },
          reject: (e) => { running = false; reject(e) },
        }
      })
    },
    finish(result = 'done') {
      settle?.resolve(result)
    },
    fail(message: string) {
      settle?.reject(new Error(message))
    },
  }
  return child
}

function setup() {
  const roster = new SubAgentRoster({ knockSettleMs: 0 })
  const children = new Map<string, ManualChild>()
  const knocks: string[] = []
  const steps: AgentStep[] = []
  let n = 0
  const executor = {
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
    getTaskMemory: () => ({}) as any,
    getAgentContext: () => CONTEXT,
    getAiRules: () => '',
    getSubAgentRoster: () => roster,
    getParentMessages: () => [{ role: 'user' as const, content: '做个小工具' }],
    knockParent: (message: string) => { knocks.push(message) },
    createChildAgent: (name: string) => {
      const child = manualChild()
      children.set(name, child)
      return child
    },
  } as unknown as ToolExecutorConfig
  const child = (name: string) => {
    const c = children.get(name)
    if (!c) throw new Error(`no child ${name}`)
    return c
  }
  return { roster, children, child, knocks, steps, executor }
}

const TEAM_ARGS = {
  team: '小工具组',
  tasks: [
    { name: '定需求', role: '产品专家', description: '写清需求', prompt: '写需求文档' },
    { name: '写代码', role: '开发专家', description: '实现', prompt: '按需求实现' },
    { name: '测一遍', role: '测试专家', description: '测试', prompt: '测试实现' },
  ],
}

describe('ExpertTeam：群里点名', () => {
  const members = [
    { name: 'a', role: '产品专家', description: '需求' },
    { name: 'b', role: '开发专家', description: '实现' },
    { name: 'c', role: '测试专家', description: '测试' },
  ]

  it('点到的专家叫醒，点自己不算，点组长另报，不写 to 不叫醒任何人', () => {
    const team = new ExpertTeam('t', members)
    const one = team.post('a', ['b', 'a', TEAM_LEADER], '需求写好了')
    expect(one.wakeNow).toEqual(['b'])
    expect(one.toLeader).toBe(true)
    const two = team.post('a', [], '我去喝水')
    expect(two.wakeNow).toEqual([])
    expect(two.toLeader).toBe(false)
    expect(team.wakesSoFar()).toBe(1)
  })

  it('补看未读：不含自己说的，看过的不再给', () => {
    const team = new ExpertTeam('t', members)
    team.post('a', ['b'], '第一条')
    team.post('b', ['c'], '第二条')
    expect(team.takeUnread('b').map(m => m.text)).toEqual(['第一条'])
    team.post('c', ['b'], '第三条')
    expect(team.takeUnread('b').map(m => m.text)).toEqual(['第三条'])
    expect(team.takeUnread('b')).toEqual([])
  })

  it('满 30 次那条照常叫醒，之后只记下；组长说话后重新数，放行期间被点的人（去重、不含说话对象）', () => {
    const team = new ExpertTeam('t', members)
    for (let i = 0; i < WAKES_PER_CHECKPOINT - 1; i++) {
      expect(team.post('a', ['b'], `${i}`).checkpointReached).toBe(false)
    }
    const last = team.post('b', ['c'], '满了')
    expect(last.wakeNow).toEqual(['c'])
    expect(last.checkpointReached).toBe(true)
    expect(team.isWaitingLeader()).toBe(true)

    const queued1 = team.post('c', ['a'], '再改改')
    expect(queued1.wakeNow).toEqual([])
    expect(queued1.queued).toEqual(['a'])
    expect(queued1.checkpointReached).toBe(false)
    team.post('a', ['a', 'b'], '还有')
    team.post('c', ['a'], '又点 a')

    const { release } = team.leaderSpoke('b', '先收尾')
    expect(release).toEqual(['a'])
    expect(team.isWaitingLeader()).toBe(false)
    expect(team.wakesSoFar()).toBe(0)
    expect(team.transcript().at(-1)).toMatchObject({ from: TEAM_LEADER, to: ['b'], text: '先收尾' })
  })
})

describe('dispatch_agents 带角色和团', () => {
  it('组团有人缺角色、组团带 batch、专家叫「组长」、组团只有一位、组团超过 15 位都退回；不组团超过 15 位照常', () => {
    const noRole = parseDispatchTasks({ team: 't', tasks: [{ description: 'x', prompt: 'y' }, { role: '测试专家', description: 'x', prompt: 'y' }] })
    expect('error' in noRole && noRole.error).toContain('第 1 位')
    const withBatch = parseDispatchTasks({
      team: 't',
      tasks: [{ role: '测试专家', description: 'x', prompt: 'y' }, { role: '开发专家', description: 'x', prompt: 'y' }],
      batch: { instruction: '审', items: [{ description: 'x', input: 'a' }] },
    })
    expect('error' in withBatch && withBatch.error).toContain('batch')
    const leaderRole = parseDispatchTasks({ tasks: [{ role: TEAM_LEADER, name: '探针', description: 'x', prompt: 'y' }] })
    expect('error' in leaderRole && leaderRole.error).toContain(TEAM_LEADER)
    const twoProblems = parseDispatchTasks({ team: 't', tasks: [{ description: 'x', prompt: 'y' }] })
    expect('error' in twoProblems && twoProblems.error).toContain('第 1 位没有')
    expect('error' in twoProblems && twoProblems.error).toContain('2 到 15')
    const mixed = parseDispatchTasks({ tasks: [{ role: '测试专家', description: 'x', prompt: 'y' }, { description: 'x', prompt: 'y' }] })
    expect('tasks' in mixed && mixed.tasks.map(task => task.role)).toEqual(['测试专家', undefined])
    const leader = parseDispatchTasks({ tasks: [{ role: '测试专家', name: TEAM_LEADER, description: 'x', prompt: 'y' }] })
    expect('error' in leader && leader.error).toContain(TEAM_LEADER)
    const solo = parseDispatchTasks({ team: 't', tasks: [{ role: '测试专家', description: 'x', prompt: 'y' }] })
    expect('error' in solo && solo.error).toContain('一位专家')
    const many = Array.from({ length: 16 }, (_, i) => ({ role: '审查专家', description: `第 ${i}`, prompt: '审' }))
    const tooBig = parseDispatchTasks({ team: 't', tasks: many })
    expect('error' in tooBig && tooBig.error).toContain('15')
    const loose = parseDispatchTasks({ tasks: many })
    expect('tasks' in loose && loose.tasks).toHaveLength(16)
  })

  it('组团超过 15 位：一个都不派', async () => {
    const { roster, executor } = setup()
    const result = await dispatchSubAgents({
      team: 't',
      tasks: Array.from({ length: 16 }, (_, i) => ({ role: '审查专家', description: `第 ${i}`, prompt: '审' })),
    }, CONFIG, executor)
    expect(result.success).toBe(false)
    expect(roster.list()).toHaveLength(0)
  })
})

describe('dispatch_agents 派出那一步的标题与回执', () => {
  const render = (getAgentTools(undefined, { mode: 'assistant' }) as ToolDefinitionWithMeta[])
    .find(tool => tool.function.name === 'dispatch_agents')!._meta!.streamDisplay!.customRender!
  const cases = [
    { args: TEAM_ARGS, title: '派出专家团「小工具组」· 3 位专家', receipt: '已派出专家团「小工具组」' },
    { args: { tasks: TEAM_ARGS.tasks }, title: '派出 3 位专家', receipt: '已派出 3 位专家' },
    { args: { tasks: [...TEAM_ARGS.tasks, { name: '跑腿', description: '读配置', prompt: '去读' }] }, title: '派出 4 个伙计', receipt: '已派出 4 个伙计' },
  ]

  it.each(cases)('$title：预卡片与执行器逐字一样，回执对得上', async ({ args, title, receipt }) => {
    const { executor } = setup()
    const added: string[] = []
    const addStep = executor.addStep
    executor.addStep = (partial) => { added.push(String(partial.content)); return addStep(partial) }
    const result = await dispatchSubAgents(args, CONFIG, executor)
    expect(render(args)).toBe(title)
    expect(added[0]).toBe(title)
    expect(result.output.startsWith(receipt)).toBe(true)
  })

  it('组团不成立时预卡片不写团名', () => {
    const one = { team: 't', tasks: [TEAM_ARGS.tasks[0]] }
    expect(render(one)).toBe('派出 1 位专家')
    const withWorker = { team: 't', tasks: [...TEAM_ARGS.tasks, { description: 'x', prompt: 'y' }] }
    expect(render(withWorker)).toBe('派出 4 个伙计')
  })
})

describe('不组团的专家', () => {
  it('带角色，干完照常敲门，看不到 team_say', async () => {
    const { roster, child, knocks, executor } = setup()
    const result = await dispatchSubAgents({
      tasks: [{ name: '安全审查', role: '安全专家', description: '从安全角度审', prompt: '审登录' }],
    }, CONFIG, executor)
    expect(result.success).toBe(true)
    expect(roster.get('安全审查')?.role).toBe('安全专家')
    const c = child('安全审查')
    expect(c.seat).toBeUndefined()
    expect(c.runs[0]).toBe('你是 安全审查（安全专家）。\n\n审登录')
    c.finish('没发现问题')
    await flush()
    expect(knocks).toHaveLength(1)
    expect(knocks[0]).toContain('安全专家')
    expect(knocks[0]).toContain('没发现问题')
  })
})

describe('专家团', () => {
  it('同团第一条话开头的团说明逐字一样，后面是各自的身份和指令；伙计照旧只拿指令', async () => {
    const { child, executor } = setup()
    await dispatchSubAgents(TEAM_ARGS, CONFIG, executor)
    const a = child('定需求').runs[0]
    const b = child('写代码').runs[0]
    const brief = a.slice(0, a.indexOf('你是 定需求'))
    expect(brief.length).toBeGreaterThan(20)
    expect(b.startsWith(brief)).toBe(true)
    expect(brief).toContain('小工具组')
    expect(brief).toContain('测一遍（测试专家）')
    expect(b).toContain('你是 写代码（开发专家）。\n\n按需求实现')
    expect(child('定需求').seat?.team).toBe('小工具组')

    await dispatchSubAgents({ tasks: [{ name: 'helper', description: '读配置', prompt: '去读' }] }, CONFIG, executor)
    expect(child('helper').runs[0]).toBe('去读')
    expect(child('helper').seat).toBeUndefined()
  })

  it('点名叫醒已停的人：交给他点名那条和他没看过的群消息', async () => {
    const { child, executor } = setup()
    await dispatchSubAgents(TEAM_ARGS, CONFIG, executor)
    child('写代码').finish('等需求')
    child('测一遍').finish('等实现')
    await flush()

    child('定需求').seat!.say([], '需求草稿放在 docs/req.md')
    const said = child('定需求').seat!.say(['写代码'], '需求定了，开工')
    expect(said).toMatchObject({ ok: true, woke: ['写代码'] })
    const wake = child('写代码').runs[1]
    expect(wake).toContain('需求草稿放在 docs/req.md')
    expect(wake).toContain('产品专家·定需求 点名要你接手：需求定了，开工')
    expect(child('测一遍').runs).toHaveLength(1)
  })

  it('点名在跑的人：先记下给他，不另开一轮', async () => {
    const { child, executor } = setup()
    await dispatchSubAgents(TEAM_ARGS, CONFIG, executor)
    child('定需求').seat!.say(['写代码'], '顺便看下接口')
    expect(child('写代码').runs).toHaveLength(1)
    expect(child('写代码').supplements[0]).toContain('顺便看下接口')
  })

  it('写错名字：失败并列出能点的名字', async () => {
    const { child, executor } = setup()
    await dispatchSubAgents(TEAM_ARGS, CONFIG, executor)
    const result = await teamSay({ to: ['不存在'], message: 'hi' }, { teamSeat: child('定需求').seat } as ToolExecutorConfig)
    expect(result.success).toBe(false)
    expect(result.error).toContain('不存在')
    expect(result.error).toContain('写代码')
    expect(result.error).toContain(TEAM_LEADER)
  })

  it('专家干完一段不敲门；整个团停下来敲一次门，带各人交的东西和群里最后几条', async () => {
    const { child, knocks, executor } = setup()
    await dispatchSubAgents(TEAM_ARGS, CONFIG, executor)
    child('定需求').seat!.say(['写代码'], '需求在 req.md')
    child('定需求').finish('需求写完')
    child('写代码').finish('实现完')
    await flush()
    expect(knocks).toHaveLength(0)
    child('测一遍').finish('全部通过')
    await flush()
    expect(knocks).toHaveLength(1)
    expect(knocks[0]).toContain('小工具组')
    expect(knocks[0]).toContain('需求写完')
    expect(knocks[0]).toContain('全部通过')
    expect(knocks[0]).toContain('需求在 req.md')
    expect(knocks[0]).toContain('team-小工具组.md')
  })

  it('wait_agents 只在专家团停下来时返回', async () => {
    const { child, executor } = setup()
    await dispatchSubAgents(TEAM_ARGS, CONFIG, executor)
    let returned = false
    const waiting = waitAgents({ timeout: 5 }, executor).then(r => { returned = true; return r })
    child('定需求').finish()
    child('写代码').finish()
    await flush()
    expect(returned).toBe(false)
    child('测一遍').finish()
    const result = await waiting
    expect(result.output).toContain('测一遍')
  })

  it('点名组长、有人失败：敲门', async () => {
    const { child, knocks, executor } = setup()
    await dispatchSubAgents(TEAM_ARGS, CONFIG, executor)
    child('定需求').seat!.say([TEAM_LEADER], '登录要不要支持手机号？')
    expect(knocks).toHaveLength(1)
    expect(knocks[0]).toContain('登录要不要支持手机号？')
    expect(knocks[0]).toContain('产品专家·定需求')
    child('写代码').fail('编译器崩了')
    await flush()
    expect(knocks).toHaveLength(2)
    expect(knocks[1]).toContain('编译器崩了')
  })

  it('组长再交代：进群里，对方收到的是组长的话', async () => {
    const { roster, child, executor } = setup()
    await dispatchSubAgents(TEAM_ARGS, CONFIG, executor)
    child('写代码').finish()
    await flush()
    const r = await followupAgent({ name: '写代码', message: '先别做导出' }, executor)
    expect(r.success).toBe(true)
    expect(child('写代码').runs[1]).toContain(`${TEAM_LEADER} 点名要你接手：先别做导出`)
    expect(roster.getTeam('小工具组')!.transcript().at(-1)).toMatchObject({ from: TEAM_LEADER, to: ['写代码'] })
  })

  it('满 30 次：敲一次门，之后点名只记不叫醒；组长说话后重新数，并叫醒期间被点的人（只叫醒一次）', async () => {
    const { roster, child, knocks, executor } = setup()
    await dispatchSubAgents(TEAM_ARGS, CONFIG, executor)
    const say = (from: string, to: string[], text: string) => child(from).seat!.say(to, text)
    for (let i = 0; i < WAKES_PER_CHECKPOINT; i++) say('定需求', ['写代码'], `改 ${i}`)
    expect(knocks).toHaveLength(1)
    expect(knocks[0]).toContain(String(WAKES_PER_CHECKPOINT))
    expect(roster.getTeam('小工具组')!.isWaitingLeader()).toBe(true)

    child('测一遍').finish()
    await flush()
    const r1 = say('写代码', ['测一遍'], '又改了')
    const r2 = say('定需求', ['测一遍'], '再测')
    expect(r1).toMatchObject({ ok: true, woke: [], queued: ['测一遍'] })
    expect(r2).toMatchObject({ ok: true, woke: [], queued: ['测一遍'] })
    expect(child('测一遍').runs).toHaveLength(1)
    expect(knocks).toHaveLength(1)

    await followupAgent({ name: '写代码', message: '继续' }, executor)
    expect(roster.getTeam('小工具组')!.wakesSoFar()).toBe(0)
    expect(child('测一遍').runs).toHaveLength(2)
    expect(child('测一遍').runs[1]).toContain('又改了')
    expect(child('测一遍').runs[1]).toContain('再测')
  })
})

describe('专家团：边角', () => {
  it('上一段刚跑完还没记账时又被点名：新一段照常跑，旧的不把他记成做完、不敲门', async () => {
    const { roster, child, knocks, executor } = setup()
    await dispatchSubAgents(TEAM_ARGS, CONFIG, executor)
    child('定需求').finish()
    child('测一遍').finish()
    await flush()
    child('写代码').finish('第一段')
    child('定需求').seat!.say(['写代码'], '再加个参数')
    await flush()
    expect(child('写代码').runs).toHaveLength(2)
    expect(roster.get('写代码')?.status).toBe('running')
    expect(knocks).toHaveLength(0)
    child('写代码').finish('第二段')
    await flush()
    expect(knocks).toHaveLength(1)
    expect(knocks[0]).toContain('第二段')
  })

  it('被打断的专家：同伴点名只记在群里不叫醒，组长再交代才接着干', async () => {
    const { roster, child, executor } = setup()
    await dispatchSubAgents(TEAM_ARGS, CONFIG, executor)
    roster.interrupt('写代码')
    await flush()
    expect(roster.get('写代码')?.status).toBe('interrupted')
    const said = await teamSay({ to: ['写代码'], message: '接着写' }, { teamSeat: child('定需求').seat } as ToolExecutorConfig)
    expect(said.success).toBe(true)
    expect(said.output).toContain('打断')
    expect(child('写代码').runs).toHaveLength(1)
    await followupAgent({ name: '写代码', message: '继续' }, executor)
    expect(child('写代码').runs).toHaveLength(2)
    expect(child('写代码').runs[1]).toContain('接着写')
  })

  it('满 30 次的敲门只报各人状态，不重发交的东西', async () => {
    const { child, knocks, executor } = setup()
    await dispatchSubAgents(TEAM_ARGS, CONFIG, executor)
    child('测一遍').finish('一大段测试报告')
    await flush()
    for (let i = 0; i < WAKES_PER_CHECKPOINT; i++) child('定需求').seat!.say(['写代码'], `改 ${i}`)
    expect(knocks).toHaveLength(1)
    expect(knocks[0]).toContain('测试专家·测一遍')
    expect(knocks[0]).not.toContain('一大段测试报告')
  })

  it('很久没被点到的人被叫醒：未读太多时只列最近的，说明更早的在群聊文件里', async () => {
    const { child, executor } = setup()
    await dispatchSubAgents(TEAM_ARGS, CONFIG, executor)
    child('测一遍').finish()
    await flush()
    const long = '长'.repeat(3000)
    for (let i = 0; i < 12; i++) child('定需求').seat!.say([], `${i}:${long}`)
    child('写代码').seat!.say(['测一遍'], '来测')
    const wake = child('测一遍').runs[1]
    expect(wake.length).toBeLessThan(25000)
    expect(wake).toContain('更早的')
    expect(wake).toContain('team-小工具组.md')
    expect(wake).toContain('11:')
    expect(wake).toContain('点名要你接手：来测')
  })

  it('两个团名去掉符号后一样：群聊各写各的文件', () => {
    const workspace = new SubAgentWorkspace('/tmp/sf-expert-ws')
    const a = workspace.teamTranscriptPath(new ExpertTeam('A/B', []))
    const b = workspace.teamTranscriptPath(new ExpertTeam('a b', []))
    expect(a).not.toBe(b)
    expect(workspace.teamTranscriptPath(new ExpertTeam('A/B', []))).toBe(a)
  })
})

describe('team_say 只给专家团成员', () => {
  it('主人、伙计、不组团的专家看不到；团员看得到', () => {
    const catalog = getAgentTools(undefined, { mode: 'assistant' })
    const names = (tools: typeof catalog) => tools.map(t => t.function.name)
    expect(names(filterTeamMemberTools(catalog, false))).not.toContain('team_say')
    expect(names(filterSubAgentTools(filterTeamMemberTools(catalog, false)))).not.toContain('team_say')
    const member = names(filterSubAgentTools(filterTeamMemberTools(catalog, true)))
    expect(member).toContain('team_say')
    expect(member).not.toContain('dispatch_agents')
    expect(names(filterTeamMemberTools(catalog, false))).toContain('dispatch_agents')
    expect(names(catalog)).not.toContain('dispatch_experts')
  })

  it('没有座位的调用直接拦下', () => {
    const catalog = getAgentTools(undefined, { mode: 'assistant' })
    const asWorker = { isSubAgent: true, getToolCatalog: () => catalog } as unknown as ToolExecutorConfig
    const asParent = { isSubAgent: false, getToolCatalog: () => catalog } as unknown as ToolExecutorConfig
    expect(denyIfNotForThisAgent(asWorker, 'team_say')?.success).toBe(false)
    expect(denyIfNotForThisAgent(asParent, 'team_say')?.success).toBe(false)
    const seat = { team: 't', name: 'a', say: () => ({ ok: false as const, error: '' }) }
    expect(denyIfNotForThisAgent({ ...asWorker, teamSeat: seat } as ToolExecutorConfig, 'team_say')).toBeNull()
  })

  it('伙计和专家的系统说明逐字一样，角色和团员都不进系统说明', () => {
    const prompt = PromptBuilder.buildSubAgentSystemPrompt({ context: CONTEXT })
    expect(prompt).not.toContain('专家团')
    expect(prompt).not.toContain('team_say')
  })
})
