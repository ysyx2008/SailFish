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
  getUserSkillService: () => ({ getEnabledSkills: () => [], buildSkillsSummary: () => '' })
}))

vi.mock('../../config.service', () => ({
  getConfigService: () => ({ get: () => undefined })
}))

vi.mock('../../web-search/index', () => ({
  isConfigured: () => false,
  getApiKey: () => '',
}))

import * as fs from 'fs'
import { ExpertTeam, TEAM_LEADER, tidyLabel, WAKES_PER_CHECKPOINT } from '../expert-team'
import { SubAgentRoster, type ChildAgentHandle, type TeamSeat } from '../sub-agent-roster'
import { teamSay } from '../tools/expert'
import { dispatchSubAgents, parseDispatchTasks, followupAgent, waitAgents, denyIfNotForThisAgent, SubAgentWorkspace } from '../tools/sub-agent'
import { filterSubAgentTools, filterTeamMemberTools, getAgentTools, type ToolDefinitionWithMeta } from '../tools'
import { PromptBuilder } from '../prompt-builder'
import { buildPreToolCallDisplay, formatToolCallPrefixFromMeta } from '../tool-metadata'
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

/** 回执里「- 名字（角色）：」那一行的第一位的名字 */
function allocatedNameOf(receipt: string): string {
  const m = /^- (.+?)（/m.exec(receipt)
  if (!m) throw new Error(`回执里找不到名单：${receipt}`)
  return m[1]
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

describe('dispatch_agents 团名和角色的整理与上限', () => {
  const two = (role = '测试专家') => [
    { role, description: 'x', prompt: 'y' },
    { role: '开发专家', description: 'x', prompt: 'y' },
  ]

  it('团名里的换行、制表折成一个空格，首尾去掉；角色同样', () => {
    const parsed = parseDispatchTasks({ team: '  换行测试团\n第二行\t三  ', tasks: two('测\n试专家') })
    expect('tasks' in parsed && parsed.team).toBe('换行测试团 第二行 三')
    expect('tasks' in parsed && parsed.tasks[0].role).toBe('测 试专家')
  })

  it('团名恰好 40 个字可以；41 个字退回并写明字数，不悄悄截断', () => {
    const ok = parseDispatchTasks({ team: '团'.repeat(40), tasks: two() })
    expect('tasks' in ok && ok.team).toBe('团'.repeat(40))
    const over = parseDispatchTasks({ team: '团'.repeat(41), tasks: two() })
    expect('error' in over && over.error).toContain('团名最长 40 个字，这次 41 个字')
  })

  it('字数按看得见的字算：40 个表情、40 个组合表情（家庭，由多个符号拼成）都不算超限', () => {
    const rocket = parseDispatchTasks({ team: '🚀'.repeat(40), tasks: two() })
    expect('tasks' in rocket && rocket.team).toBe('🚀'.repeat(40))
    const family = '👨\u200D👩\u200D👧'
    const joined = parseDispatchTasks({ team: family.repeat(40), tasks: two() })
    expect('tasks' in joined && joined.team).toBe(family.repeat(40))
    const over = parseDispatchTasks({ team: family.repeat(41), tasks: two() })
    expect('error' in over && over.error).toContain('这次 41 个字')
  })

  it('整理的范围：回车换行、不换行空格、控制字符、零宽空格、改方向的符号都折成空格；组合表情用的连接符不动', () => {
    expect(tidyLabel('甲\r\n乙')).toBe('甲 乙')
    expect(tidyLabel('甲\u00A0乙')).toBe('甲 乙')
    expect(tidyLabel('甲\u0007\u0085乙')).toBe('甲 乙')
    expect(tidyLabel('甲\u200B乙')).toBe('甲 乙')
    expect(tidyLabel('\u202E甲乙\u202C')).toBe('甲乙')
    expect(tidyLabel('👨\u200D👩')).toBe('👨\u200D👩')
    expect(tidyLabel('  \n ')).toBe('')
  })

  it('一句话简述里的换行也折成一行', () => {
    const parsed = parseDispatchTasks({
      tasks: [{ description: '读\n配置', prompt: 'y' }],
      batch: { instruction: '审', items: [{ description: '第一\r\n条', input: 'a' }] },
    })
    expect('tasks' in parsed && parsed.tasks.map(task => task.description)).toEqual(['读 配置', '第一 条'])
  })

  it('团名超长和别的问题一起说', () => {
    const parsed = parseDispatchTasks({ team: '团'.repeat(50), tasks: [{ description: 'x', prompt: 'y' }] })
    const error = 'error' in parsed ? parsed.error : ''
    expect(error).toContain('团名最长 40')
    expect(error).toContain('第 1 位没有')
  })

  it('角色超过 20 个字：整批退回并指出是第几位；和团名超长一起说', () => {
    const parsed = parseDispatchTasks({ tasks: [...two(), { role: '专'.repeat(21), description: 'x', prompt: 'y' }] })
    expect('error' in parsed && parsed.error).toContain('子任务 3 的 role 最长 20 个字，这次 21 个字')
    const both = parseDispatchTasks({ team: '团'.repeat(41), tasks: two('专'.repeat(21)) })
    const error = 'error' in both ? both.error : ''
    expect(error).toContain('子任务 1 的 role 最长 20')
    expect(error).toContain('团名最长 40')
  })

  it('团名整理后是空的（只有换行）：当没给团名', () => {
    const parsed = parseDispatchTasks({ team: '\n\t ', tasks: two() })
    expect('tasks' in parsed && parsed.team).toBeUndefined()
  })

  it('超长团名：执行器整批不派，预卡片也不写团名', async () => {
    const { roster, executor } = setup()
    const args = { team: '团'.repeat(41), tasks: TEAM_ARGS.tasks }
    const result = await dispatchSubAgents(args, CONFIG, executor)
    expect(result.success).toBe(false)
    expect(roster.list()).toHaveLength(0)
    const render = (getAgentTools(undefined, { mode: 'assistant' }) as ToolDefinitionWithMeta[])
      .find(tool => tool.function.name === 'dispatch_agents')!._meta!.streamDisplay!.customRender!
    expect(render(args)).toBe('派出 3 位专家')
  })

  it('带换行的团名：回执和名册里是整理后的名字，总览每人仍是一行', async () => {
    const writes = new Map<string, string>()
    vi.mocked(fs.writeFileSync).mockImplementation((file, data) => { writes.set(String(file), String(data)) })
    try {
      const { roster, executor } = setup()
      const result = await dispatchSubAgents({ team: '小工具\n组', tasks: TEAM_ARGS.tasks }, CONFIG, executor)
      expect(result.output.startsWith('已派出专家团「小工具 组」')).toBe(true)
      expect(roster.list().every(c => c.team === '小工具 组')).toBe(true)
      const overview = [...writes].find(([file]) => file.endsWith('overview.md'))![1].trim().split('\n')
      expect(overview).toHaveLength(2 + TEAM_ARGS.tasks.length)
      expect(overview.slice(2).every(line => line.includes('「小工具 组」'))).toBe(true)
    } finally {
      vi.mocked(fs.writeFileSync).mockReset()
    }
  })

  it('角色只有控制字符：预卡片和执行器一致，都当没有角色', async () => {
    const { executor } = setup()
    const args = { team: '小工具组', tasks: TEAM_ARGS.tasks.map(task => ({ ...task, role: '\u0007' })) }
    const render = (getAgentTools(undefined, { mode: 'assistant' }) as ToolDefinitionWithMeta[])
      .find(tool => tool.function.name === 'dispatch_agents')!._meta!.streamDisplay!.customRender!
    const result = await dispatchSubAgents(args, CONFIG, executor)
    expect(result.success).toBe(false)
    expect(render(args)).toBe('派出 3 个伙计')
  })
})

describe('等待 / 再交代 / 打断那几张卡：对象是专家就写专家', () => {
  const tools = getAgentTools(undefined, { mode: 'assistant' }) as ToolDefinitionWithMeta[]
  const metaOf = (name: string) => tools.find(def => def.function.name === name)!._meta
  const roster = [
    { name: '写代码', role: '开发专家', status: 'running' },
    { name: '做测试', role: '测试专家', status: 'completed' },
    { name: '跑腿', status: 'running' },
    { name: '读配置', status: 'completed' },
  ]
  const card = (tool: string, args: Record<string, unknown>, subAgents: typeof roster | undefined = roster) =>
    formatToolCallPrefixFromMeta(metaOf(tool), args, { subAgents: subAgents && (() => subAgents) })

  it('等待：还在干的全是专家就写「等待专家」，混着伙计或没名册就写「等待伙计」', () => {
    expect(card('wait_agents', {}, [roster[0], roster[1]])).toBe('等待专家')
    expect(card('wait_agents', {})).toBe('等待伙计')
    expect(card('wait_agents', {}, undefined)).toBe('等待伙计')
    expect(card('wait_agents', {}, [])).toBe('等待伙计')
  })

  it('等待：不传名字只看还在干的；都不在干了看全部；传了名字就看名字', () => {
    expect(card('wait_agents', {}, [roster[0], roster[1], roster[3]])).toBe('等待专家')
    expect(card('wait_agents', {}, [roster[1], roster[3]])).toBe('等待伙计')
    expect(card('wait_agents', { names: ['写代码', '做测试'] })).toBe('等待专家')
    expect(card('wait_agents', { names: ['写代码', '跑腿'] })).toBe('等待伙计')
    expect(card('wait_agents', { names: ['不认识的人'] })).toBe('等待伙计')
  })

  it('再交代、打断：对象是专家写「专家」，后面跟名字；名字还没到时用占位符', () => {
    expect(card('followup_agent', { name: '写代码' })).toBe('再交代专家: 写代码')
    expect(card('followup_agent', { name: '跑腿' })).toBe('再交代伙计: 跑腿')
    expect(card('interrupt_agent', { name: '做测试' })).toBe('打断专家: 做测试')
    expect(card('interrupt_agent', { name: '读配置' })).toBe('打断伙计: 读配置')
    expect(card('followup_agent', {})).toMatch(/^再交代伙计: /)
  })

  it('流式预卡片和执行器用同一套：认得花名册', () => {
    const built = buildPreToolCallDisplay('wait_agents', '{"timeout": 60}', metaOf('wait_agents'), { subAgents: () => [roster[0]] })
    expect(built).toBe('等待专家')
  })

  it('花名册给的名单只有名字、角色、状态', async () => {
    const { roster: live, executor } = setup()
    await dispatchSubAgents({ team: '小工具组', tasks: TEAM_ARGS.tasks }, CONFIG, executor)
    const brief = live.brief()
    expect(brief).toHaveLength(TEAM_ARGS.tasks.length)
    expect(Object.keys(brief[0]).sort()).toEqual(['name', 'role', 'status'])
    expect(brief.every(c => !!c.role)).toBe(true)
  })
})

describe('dispatch_agents 工具说明里的数字各归各处', () => {
  const tool = (getAgentTools(undefined, { mode: 'assistant' }) as ToolDefinitionWithMeta[])
    .find(def => def.function.name === 'dispatch_agents')!
  const props = (tool.function.parameters as { properties: Record<string, any> }).properties
  const roleDescription: string = props.tasks.items.properties.role.description

  it('团名那栏只讲团名的字数，人数写在工具说明里（被模型读成团名字数过三次）', () => {
    expect(props.team.description).toContain('最长 40 个字')
    expect(props.team.description).not.toMatch(/15|位/)
    expect(tool.function.description).toContain('2 到 15 位')
  })

  it('角色那栏写明字数上限', () => {
    expect(roleDescription).toContain('最长 20 个字')
  })
})

describe('伙计和专家的区别写给秘书看（用户说「专家团」却被派成伙计过）', () => {
  const prompt = new PromptBuilder({ context: CONTEXT }).build()
  const tool = (getAgentTools(undefined, { mode: 'assistant' }) as ToolDefinitionWithMeta[])
    .find(def => def.function.name === 'dispatch_agents')!
  const props = (tool.function.parameters as { properties: Record<string, any> }).properties

  it('系统说明把两种人并列讲：各自带不带 role、界面上看到什么；用户的话指的是什么', () => {
    expect(prompt).toContain('派出的人有两种')
    expect(prompt).toContain('伙计：不带 role')
    expect(prompt).toContain('界面上只是一行进度')
    expect(prompt).toContain('专家：带 role')
    expect(prompt).toContain('名字前的角色标签')
    expect(prompt).toContain('用户点开能看到完整群聊')
  })

  it('如实说角色给了专家什么：显示的称呼和开场一句话，别的和伙计一样，专长看指令；不替用户猜他想要什么', () => {
    expect(prompt).toContain('也写进专家的开场「你是 名字（role）」')
    expect(prompt).toContain('除此之外专家和伙计一样（同样的模型和权限，工具也一样，团里的专家多一个在群里说话的）')
    expect(prompt).toContain('取决于你写给他的指令')
    expect(prompt).not.toContain('他想看到的是')
  })

  it('先各自独立判断再组团的安排：独立判断那步也可以是专家；带 team 时每位都带 role', () => {
    expect(prompt).toContain('独立判断那一步派不带 team 的专家，一样有角色标签')
    expect(prompt).toContain('带 team 时 tasks 里每一位都要带 role，主持、协调这类位置也一样')
  })

  it('不再用「分头就能做完的活派伙计」去压用户明说的专家', () => {
    expect(prompt).not.toContain('分头就能做完的同类活照旧派伙计')
    expect(prompt).not.toContain('各看各的就够的不组团')
  })

  it('工具说明开头就分开：不带 role 的是伙计，带 role 的是专家；角色那栏写明界面上是标签、带 team 时每项都带', () => {
    expect(tool.function.description.startsWith('派出这场任务里的同事并行干活：不带 role 的是伙计，带 role 的是专家')).toBe(true)
    expect(props.tasks.items.properties.role.description).toContain('界面上显示为角色标签')
    expect(props.tasks.items.properties.role.description).toContain('带 team 时 tasks 里每一项都要带')
  })

  it('伙计和专家自己的系统说明里没有这一段', () => {
    expect(PromptBuilder.buildSubAgentSystemPrompt({ context: CONTEXT })).not.toContain('派出的人有两种')
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

  it('team 是空串：照常各干各的派出，回执里说明没组团', async () => {
    const { roster, executor } = setup()
    const result = await dispatchSubAgents({ team: '  ', tasks: TEAM_ARGS.tasks }, CONFIG, executor)
    expect(result.output.startsWith('已派出 3 位专家')).toBe(true)
    expect(result.output).toContain('team 是空的')
    expect(roster.list().every(c => !c.team)).toBe(true)
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

  it('点名的返回按对方当时的样子写：已停的写重新开了一段，还在干的写话转给他了', async () => {
    const { child, executor } = setup()
    await dispatchSubAgents(TEAM_ARGS, CONFIG, executor)
    child('写代码').finish('等需求')
    await flush()

    const result = await teamSay(
      { to: ['写代码', '测一遍'], message: '看一下接口' },
      { teamSeat: child('定需求').seat } as ToolExecutorConfig,
    )
    expect(result.output).toContain('叫醒了：写代码（他已经停下，这次重新开了一段）')
    expect(result.output).toContain('测一遍 还在干，话已转给他，手上这一步走完会看到')
    expect(result.output).not.toContain('叫醒了：测一遍')
    expect(child('写代码').runs).toHaveLength(2)
    expect(child('写代码').runs[1]).toContain('看一下接口')
    expect(child('测一遍').runs).toHaveLength(1)
    expect(child('测一遍').supplements[0]).toContain('看一下接口')
  })

  it('指定的名字已被占用（先来的已经做完，还在名册里）：改了名的写在回执里，同团每人的开场也写明，开场开头仍逐字一样', async () => {
    const { child, executor } = setup()
    await dispatchSubAgents({ tasks: [{ name: '甲', role: '产品专家', description: '先来的', prompt: 'p' }] }, CONFIG, executor)
    child('甲').finish('做完了')
    await flush()

    const result = await dispatchSubAgents({
      team: '二组',
      tasks: [
        { name: '甲', role: '产品专家', description: '写需求', prompt: '写完点名乙' },
        { name: '乙', role: '开发专家', description: '实现', prompt: '等甲点名' },
      ],
    }, CONFIG, executor)
    expect(result.output).toContain('这几位的名字和指定的不一样：甲 → 甲-2')
    expect(result.output).not.toContain('乙 →')

    const a = child('甲-2').runs[0]
    const b = child('乙').runs[0]
    expect(a).toContain('这几位的名字和任务里写的不一样：甲 → 甲-2')
    expect(a).not.toContain('乙 →')
    expect(a.slice(0, a.indexOf('你是 甲-2'))).toBe(b.slice(0, b.indexOf('你是 乙')))
  })

  it('名字里的空格和符号会折成「-」：写明指定的和现在的；没指定名字（用简述起名）的不提', async () => {
    const { child, executor } = setup()
    const result = await dispatchSubAgents({
      team: '三组',
      tasks: [
        { name: '读 nginx 配置', role: '运维专家', description: '读配置', prompt: '读' },
        { name: '审核', role: '安全专家', description: '审一遍', prompt: '审' },
        { role: '测试专家', description: '读 日志', prompt: '读日志' },
      ],
    }, CONFIG, executor)
    expect(result.output).toContain('这几位的名字和指定的不一样：读 nginx 配置 → 读-nginx-配置。')
    expect(result.output.match(/→/g)).toHaveLength(1)
    expect(child('审核').runs[0]).toContain('这几位的名字和任务里写的不一样：读 nginx 配置 → 读-nginx-配置。')
    expect(child('读-日志').runs[0]).toContain('读 nginx 配置 → 读-nginx-配置')
  })

  it('指定的名字带换行或特别长：折成一行、截短再写进回执和开场，不拆行', async () => {
    const { child, executor } = setup()
    const asked = `甲\n乙${'长'.repeat(100)}`
    const result = await dispatchSubAgents({
      team: '四组',
      tasks: [
        { name: asked, role: '产品专家', description: '写', prompt: 'p' },
        { name: '丙', role: '开发专家', description: '做', prompt: 'q' },
      ],
    }, CONFIG, executor)
    const line = result.output.split('\n').find(l => l.startsWith('这几位的名字和指定的不一样'))!
    expect(line).toContain('甲 乙')
    expect(line).toContain('…')
    expect(line.length).toBeLessThan(200)
    const opened = child(allocatedNameOf(result.output)).runs[0]
    expect(opened.split('\n').filter(l => l.includes('→')).every(l => l.startsWith('这几位的名字和任务里写的不一样'))).toBe(true)
  })

  it('名字都用上了：回执和开场都不提改名', async () => {
    const { child, executor } = setup()
    const result = await dispatchSubAgents(TEAM_ARGS, CONFIG, executor)
    expect(result.output).not.toContain('和指定的不一样')
    expect(child('定需求').runs[0]).not.toContain('和任务里写的不一样')
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
