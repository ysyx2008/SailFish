vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/mock/user/data'),
    getName: vi.fn().mockReturnValue('SailFish'),
    getVersion: vi.fn().mockReturnValue('1.0.0')
  },
  BrowserWindow: vi.fn(),
  ipcMain: { on: vi.fn(), handle: vi.fn() }
}))
vi.mock('../../im/im.service', () => ({ getIMService: vi.fn().mockReturnValue(null) }))
vi.mock('../../user-skill.service', () => ({ getUserSkillService: () => ({ getEnabledSkills: () => [] }) }))
vi.mock('../../config.service', () => ({ getConfigService: () => ({ get: () => undefined }) }))
vi.mock('../../web-search/index', () => ({ isConfigured: () => false, getApiKey: () => '' }))

import { describe, it, expect, vi } from 'vitest'
import { MAX_LIVE_CHILDREN, SubAgentRoster, type ChildAgentHandle, type RosterSpawnDeps, type SpawnTask } from '../sub-agent-roster'
import { MAX_ORG_DEPTH, type LeadSeat } from '../org-ledger'
import { filterSubAgentTools, getAgentTools } from '../tools'
import { parseDispatchTasks, denyIfNotForThisAgent } from '../tools/sub-agent'
import { createTeamTexts } from '../tools/expert-team-text'
import type { ToolExecutorConfig } from '../tools/types'
import type { AgentContext } from '../types'
import type { AiMessage } from '../../ai.service'

const context: AgentContext = {
  terminalOutput: [],
  systemInfo: { os: 'darwin', shell: 'zsh' },
  terminalType: 'assistant',
  cwd: '/tmp',
}

function deps(createChild: (name: string) => ChildAgentHandle, knocks: string[] = []): RosterSpawnDeps {
  return {
    createChild,
    getParentMessages: () => [] as AiMessage[],
    getParentContext: () => context,
    knock: (m) => { knocks.push(m) },
    onProgress: () => {},
    isParentAborted: () => false,
    sanitize: () => [] as AiMessage[],
    formatKnock: snap => `knock:${snap.name}:${snap.status}`,
  }
}

/** 普通伙计：一直干到被打断 */
function worker(delayMs = 5000): ChildAgentHandle & { received: string[] } {
  let running = false
  let aborted = false
  const received: string[] = []
  return {
    received,
    isRunning: () => running,
    abort: () => { aborted = true; running = false; return true },
    addUserMessage: (m) => { received.push(m); return true },
    async run(message: string) {
      running = true
      received.push(message)
      await new Promise(resolve => setTimeout(resolve, delayMs))
      running = false
      if (aborted) throw new Error('aborted')
      return 'done'
    },
  }
}

/** 组长：开跑时建出自己那份花名册，派几位手下，手下都干完才收工 */
function lead(plan: { members: SpawnTask[]; memberDelayMs?: number; seats?: LeadSeat[]; rosters?: SubAgentRoster[]; handles?: ChildAgentHandle[] }): ChildAgentHandle {
  let seat: LeadSeat | undefined
  let roster: SubAgentRoster | undefined
  let running = false
  const self: ChildAgentHandle = {
    isRunning: () => running,
    abort: () => { roster?.abortAll(); running = false; return true },
    addUserMessage: () => true,
    becomeLead: (s) => { seat = s; plan.seats?.push(s) },
    async run() {
      running = true
      roster = new SubAgentRoster({ knockSettleMs: 0 })
      if (seat) roster.attachLedger(seat.ledger, seat.name, seat.depth)
      plan.rosters?.push(roster)
      roster.spawn(plan.members, deps(() => {
        const w = worker(plan.memberDelayMs ?? 30)
        plan.handles?.push(w)
        return w
      }))
      while (roster.hasLive()) await roster.waitForKnock(new AbortController().signal)
      roster.release()
      running = false
      return 'lead done'
    },
  }
  return self
}

describe('组长与账本', () => {
  it('不指定组长时没有账本：保险丝只看自己，行为不变', () => {
    const roster = new SubAgentRoster({ knockSettleMs: 0 })
    roster.spawn([{ description: '甲', prompt: 'p' }], deps(() => worker()))
    expect(roster.room()).toBe(MAX_LIVE_CHILDREN - 1)
    expect(roster.orgLiveCount()).toBe(1)
    expect(roster.orgDepth).toBe(0)
    roster.abortAll()
  })

  it('指定组长：组长拿到第 1 层的座位，他名下的人算进全组织的保险丝', async () => {
    const root = new SubAgentRoster({ knockSettleMs: 0 })
    const seats: LeadSeat[] = []
    const rosters: SubAgentRoster[] = []
    root.spawn(
      [{ description: '研发组', prompt: 'p', role: '研发组长', lead: true }],
      deps(() => lead({
        members: [{ description: '写代码', prompt: 'p' }, { description: '写测试', prompt: 'p' }],
        seats, rosters,
      })),
    )
    expect(seats).toHaveLength(1)
    expect(seats[0].depth).toBe(1)
    expect(seats[0].name).toBe('研发组')
    await new Promise(resolve => setTimeout(resolve, 10))
    // 组长 1 个 + 他名下 2 个
    expect(root.orgLiveCount()).toBe(3)
    expect(root.room()).toBe(MAX_LIVE_CHILDREN - 3)
    expect(rosters[0].room()).toBe(MAX_LIVE_CHILDREN - 3)
    root.abortAll()
  })

  it('名字全组织不重复：组长名下的人不会和秘书这边的人重名', async () => {
    const root = new SubAgentRoster({ knockSettleMs: 0 })
    const rosters: SubAgentRoster[] = []
    root.spawn(
      [
        { description: '写代码', prompt: 'p' },
        { description: '研发组', prompt: 'p', role: '组长甲', lead: true },
      ],
      deps(name => name === '研发组'
        ? lead({ members: [{ description: '写代码', prompt: 'p' }], rosters })
        : worker()),
    )
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(rosters[0].childNames()).toEqual(['写代码-2'])
    root.abortAll()
  })

  it('保险丝按全组织算：组长名下占满以后，秘书也派不出新人', async () => {
    const root = new SubAgentRoster({ knockSettleMs: 0 })
    const members: SpawnTask[] = Array.from({ length: 15 }, (_, i) => ({ description: `干活${i}`, prompt: 'p' }))
    root.spawn(
      [{ description: '大组', prompt: 'p', role: '组长', lead: true }],
      deps(() => lead({ members, memberDelayMs: 5000 })),
    )
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(root.orgLiveCount()).toBe(16)
    expect(root.room()).toBe(MAX_LIVE_CHILDREN - 16)
    expect(() => root.spawn(
      Array.from({ length: MAX_LIVE_CHILDREN - 15 }, (_, i) => ({ description: `外${i}`, prompt: 'p' })),
      deps(() => worker()),
    )).toThrow(RangeError)
    root.abortAll()
  })

  it('层数到顶不能再指定组长；伙计不能当组长', () => {
    const root = new SubAgentRoster({ knockSettleMs: 0 })
    expect(root.canAppointLeads()).toBe(true)
    expect(() => root.spawn([{ description: '没角色', prompt: 'p', lead: true }], deps(() => worker()))).toThrow(/专家/)

    const bottom = new SubAgentRoster({ knockSettleMs: 0 })
    const ledgerHolder: LeadSeat[] = []
    root.spawn([{ description: '一层', prompt: 'p', role: '组长', lead: true }], deps(() => lead({ members: [], seats: ledgerHolder })))
    bottom.attachLedger(ledgerHolder[0].ledger, '三层', MAX_ORG_DEPTH)
    expect(bottom.canAppointLeads()).toBe(false)
    expect(() => bottom.spawn([{ description: '再往下', prompt: 'p', role: '组长', lead: true }], deps(() => worker()))).toThrow(RangeError)
    root.abortAll()
  })

  it('秘书可以叫醒、打断组长名下的人', async () => {
    const root = new SubAgentRoster({ knockSettleMs: 0 })
    const handles: ChildAgentHandle[] = []
    root.spawn(
      [{ description: '研发组', prompt: 'p', role: '组长', lead: true }],
      deps(() => lead({ members: [{ description: '写代码', prompt: 'p' }], memberDelayMs: 5000, handles })),
    )
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(root.get('写代码')).toBeUndefined()

    const sent = root.followup('写代码', '加油', deps(() => worker()))
    expect(sent.ok).toBe(true)
    expect((handles[0] as ReturnType<typeof worker>).received).toContain('加油')

    expect(root.interrupt('写代码').ok).toBe(true)
    expect(root.interrupt('不存在').ok).toBe(false)
    root.abortAll()
  })

  it('按停整棵树：秘书打断组长，组长名下的人也跟着停', async () => {
    const root = new SubAgentRoster({ knockSettleMs: 0 })
    const rosters: SubAgentRoster[] = []
    root.spawn(
      [{ description: '研发组', prompt: 'p', role: '组长', lead: true }],
      deps(() => lead({ members: [{ description: '甲', prompt: 'p' }, { description: '乙', prompt: 'p' }], memberDelayMs: 5000, rosters })),
    )
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(root.orgLiveCount()).toBe(3)
    root.abortAll()
    expect(root.orgLiveCount()).toBe(0)
    expect(rosters[0].hasLive()).toBe(false)
  })

  it('组长收工后退出账本，下次开跑换新的花名册', async () => {
    const root = new SubAgentRoster({ knockSettleMs: 0 })
    const rosters: SubAgentRoster[] = []
    const seats: LeadSeat[] = []
    root.spawn(
      [{ description: '研发组', prompt: 'p', role: '组长', lead: true }],
      deps(() => lead({ members: [{ description: '甲', prompt: 'p' }], memberDelayMs: 20, rosters, seats })),
    )
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(root.orgLiveCount()).toBe(0)
    expect(seats[0].ledger.rosters()).not.toContain(rosters[0])
    expect(seats[0].ledger.rosters()).toContain(root)
  })
})

describe('组长的工具', () => {
  const catalog = getAgentTools(undefined, { mode: 'assistant' })
  const names = (tools: readonly { function: { name: string } }[]) => tools.map(t => t.function.name)

  it('伙计看不到派人那几样，组长看得到', () => {
    const forWorker = names(filterSubAgentTools(catalog))
    const forLead = names(filterSubAgentTools(catalog, { lead: true }))
    for (const tool of ['dispatch_agents', 'followup_agent', 'wait_agents', 'interrupt_agent']) {
      expect(forWorker).not.toContain(tool)
      expect(forLead).toContain(tool)
    }
  })

  it('组长不会因此多出别的只给秘书的工具', () => {
    const forWorker = new Set(names(filterSubAgentTools(catalog)))
    const extra = names(filterSubAgentTools(catalog, { lead: true })).filter(n => !forWorker.has(n))
    expect(extra.sort()).toEqual(['dispatch_agents', 'followup_agent', 'interrupt_agent', 'wait_agents'])
  })

  it('运行时硬拦：伙计调用被拒，组长放行，秘书不受影响', () => {
    const base = { getToolCatalog: () => catalog } as Partial<ToolExecutorConfig>
    const seat = { ledger: {}, name: 'x', depth: 1 } as unknown as LeadSeat
    expect(denyIfNotForThisAgent({ ...base, isSubAgent: true } as ToolExecutorConfig, 'dispatch_agents')).not.toBeNull()
    expect(denyIfNotForThisAgent({ ...base, isSubAgent: true, leadSeat: seat } as ToolExecutorConfig, 'dispatch_agents')).toBeNull()
    expect(denyIfNotForThisAgent({ ...base, isSubAgent: false } as ToolExecutorConfig, 'dispatch_agents')).toBeNull()
    // 组长也碰不了别的只给秘书的工具
    expect(denyIfNotForThisAgent({ ...base, isSubAgent: true, leadSeat: seat } as ToolExecutorConfig, 'ask_user')).not.toBeNull()
  })
})

describe('派出参数里的 lead', () => {
  it('带 role 的专家可以当组长', () => {
    const parsed = parseDispatchTasks({ tasks: [{ description: '研发', prompt: 'p', role: '研发组长', lead: true }] })
    expect('error' in parsed).toBe(false)
    if (!('error' in parsed)) expect(parsed.tasks[0].lead).toBe(true)
  })

  it('没有 role 不能当组长，lead 不是布尔值整批退回', () => {
    expect(parseDispatchTasks({ tasks: [{ description: '研发', prompt: 'p', lead: true }] })).toHaveProperty('error')
    expect(parseDispatchTasks({ tasks: [{ description: '研发', prompt: 'p', role: '组长甲', lead: 'yes' }] })).toHaveProperty('error')
  })

  it('不写 lead 的和以前完全一样', () => {
    const parsed = parseDispatchTasks({ tasks: [{ description: '研发', prompt: 'p', role: '研发' }] })
    expect('error' in parsed).toBe(false)
    if (!('error' in parsed)) expect(parsed.tasks[0]).not.toHaveProperty('lead')
  })
})

describe('点名秘书', () => {
  const tick = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms))

  /** 组长在自己名下建一个两人的团，团员的发言入口记下来 */
  function leadWithTeam(says: Array<(to: string[], text: string) => unknown>, members: ChildAgentHandle[], rosters: SubAgentRoster[]): ChildAgentHandle {
    let seat: LeadSeat | undefined
    let roster: SubAgentRoster | undefined
    return {
      isRunning: () => !!roster?.hasLive(),
      abort: () => { roster?.abortAll(); return true },
      addUserMessage: () => true,
      becomeLead: (s) => { seat = s },
      async run() {
        roster = new SubAgentRoster({ knockSettleMs: 0 })
        if (seat) roster.attachLedger(seat.ledger, seat.name, seat.depth)
        rosters.push(roster)
        roster.spawn(
          [
            { description: '前端', prompt: 'p', role: '前端专家' },
            { description: '后端', prompt: 'p', role: '后端专家' },
          ],
          { ...deps(() => {
            const w = worker(5000)
            w.joinTeam = (j: { say: (to: string[], text: string) => unknown }) => { says.push(j.say) }
            members.push(w)
            return w
          }), teamTexts: createTeamTexts(team => `/tmp/${team.name}.md`) },
          { team: '项目团' },
        )
        while (roster.hasLive()) await roster.waitForKnock(new AbortController().signal)
        return 'done'
      },
    }
  }

  it('下面几层的团里点名秘书：秘书那边收到敲门，话记在群里', async () => {
    const root = new SubAgentRoster({ knockSettleMs: 0 })
    const knocks: string[] = []
    const says: Array<(to: string[], text: string) => unknown> = []
    const members: ChildAgentHandle[] = []
    const rosters: SubAgentRoster[] = []
    root.spawn(
      [{ description: '研发组', prompt: 'p', role: '研发组长', lead: true }],
      deps(() => leadWithTeam(says, members, rosters), knocks),
    )
    await tick()
    expect(says).toHaveLength(2)

    const result = says[0](['秘书'], '需要你定一下范围') as { ok: boolean; toSecretary?: boolean }
    expect(result.ok).toBe(true)
    expect(result.toSecretary).toBe(true)
    expect(knocks.some(k => k.includes('需要你定一下范围') && k.includes('点名秘书'))).toBe(true)
    // 敲门之后秘书的 wait_agents 能被叫醒
    const news = await root.waitForNews(undefined, new AbortController().signal)
    expect(news.arrived.map(c => c.name)).toEqual(['研发组'])
    root.abortAll()
  })

  it('秘书点名回应：记进那个群、送到被点名的人，不算组长看过', async () => {
    const root = new SubAgentRoster({ knockSettleMs: 0 })
    const says: Array<(to: string[], text: string) => unknown> = []
    const members: ChildAgentHandle[] = []
    const rosters: SubAgentRoster[] = []
    root.spawn(
      [{ description: '研发组', prompt: 'p', role: '研发组长', lead: true }],
      deps(() => leadWithTeam(says, members, rosters)),
    )
    await tick()
    const reply = root.followup('前端', '范围就这些', deps(() => worker()))
    expect(reply.ok).toBe(true)
    const team = rosters[0].listTeams()[0]
    const last = team.transcript().at(-1)!
    expect(last.from).toBe('秘书')
    expect(last.to).toEqual(['前端'])
    expect((members[0] as ReturnType<typeof worker>).received.join('\n')).toContain('范围就这些')
    root.abortAll()
  })

  it('最上面一层的团里，点名秘书等同点名组长；组长只管自己这一枝', async () => {
    const root = new SubAgentRoster({ knockSettleMs: 0 })
    const knocks: string[] = []
    const says: Array<(to: string[], text: string) => unknown> = []
    root.spawn(
      [
        { description: '前端', prompt: 'p', role: '前端专家' },
        { description: '后端', prompt: 'p', role: '后端专家' },
      ],
      { ...deps(() => {
        const w = worker(5000)
        w.joinTeam = (j: { say: (to: string[], text: string) => unknown }) => { says.push(j.say) }
        return w
      }, knocks), teamTexts: createTeamTexts(team => `/tmp/${team.name}.md`) },
      { team: '顶层团' },
    )
    const result = says[0](['秘书'], '找你') as { ok: boolean; toLeader?: boolean; toSecretary?: boolean }
    expect(result.toLeader).toBe(true)
    expect(result.toSecretary).toBe(false)
    expect(knocks).toHaveLength(1)
    root.abortAll()

    // 组长越过自己这一枝去叫别的组长名下的人：找不到
    const root2 = new SubAgentRoster({ knockSettleMs: 0 })
    const rosters: SubAgentRoster[] = []
    root2.spawn(
      [
        { description: '甲组', prompt: 'p', role: '甲组长', lead: true },
        { description: '乙组', prompt: 'p', role: '乙组长', lead: true },
      ],
      deps(name => name === '甲组'
        ? lead({ members: [{ description: '甲员', prompt: 'p' }], memberDelayMs: 5000, rosters })
        : lead({ members: [{ description: '乙员', prompt: 'p' }], memberDelayMs: 5000, rosters })),
    )
    await tick()
    expect(rosters[0].followup('乙员', 'hi', deps(() => worker())).ok).toBe(false)
    expect(root2.followup('乙员', 'hi', deps(() => worker())).ok).toBe(true)
    root2.abortAll()
  })

  it('秘书这个名字不给专家用', () => {
    const parsed = parseDispatchTasks({ tasks: [{ role: '专家', name: '秘书', description: 'x', prompt: 'y' }] })
    expect('error' in parsed && parsed.error).toMatch(/秘书/)
  })
})
