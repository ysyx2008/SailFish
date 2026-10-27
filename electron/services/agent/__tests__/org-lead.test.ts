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
import { orgOpeningNote, renderBoard } from '../tools/organization-text'
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

  it('没有组织的团里没有「秘书」这个人：点名要报错，和以前一样', () => {
    const root = new SubAgentRoster({ knockSettleMs: 0 })
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
      }), teamTexts: createTeamTexts(team => `/tmp/${team.name}.md`) },
      { team: '顶层团' },
    )
    const result = says[0](['秘书'], '找你') as { ok: boolean; error?: string }
    expect(result.ok).toBe(false)
    expect(result.error).toContain('群里没有 秘书')
    root.abortAll()
  })

  it('组长只管自己这一枝', async () => {
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

  it('「秘书」这个名字一直留给最上面那位，没有组织时也不让专家占用', () => {
    expect('error' in parseDispatchTasks({ tasks: [{ role: '专家', name: '秘书', description: 'x', prompt: 'y' }] })).toBe(false)

    const plain = new SubAgentRoster({ knockSettleMs: 0 })
    expect(plain.spawn([{ description: 'x', prompt: 'p', role: '专家', name: '秘书' }], deps(() => worker()))).toEqual(['秘书-2'])
    expect(plain.spawn([{ description: 'y', prompt: 'p', name: '秘书' }], deps(() => worker()))).toEqual(['秘书-3'])
    plain.abortAll()

    const org = new SubAgentRoster({ knockSettleMs: 0 })
    const names = org.spawn(
      [{ description: '组', prompt: 'p', role: '组长', lead: true }, { description: 'x', prompt: 'p', role: '专家', name: '秘书' }],
      deps(() => worker()),
    )
    expect(names).not.toContain('秘书')
    org.abortAll()
  })
})

describe('验收', () => {
  const texts = createTeamTexts(team => `/tmp/${team.name}.md`)
  function team3(reviewerIndex: number | undefined, says: Array<(to: string[], text: string, verdict?: 'pass' | 'reject') => any>, knocks: string[] = []) {
    const root = new SubAgentRoster({ knockSettleMs: 0 })
    root.spawn(
      [
        { description: '前端', prompt: 'p', role: '前端专家', ...(reviewerIndex === 0 ? { reviewer: true } : {}) },
        { description: '后端', prompt: 'p', role: '后端专家', ...(reviewerIndex === 1 ? { reviewer: true } : {}) },
      ],
      { ...deps(() => {
        const w = worker(5000)
        w.joinTeam = (j: any) => { says.push(j.say) }
        return w
      }, knocks), teamTexts: texts },
      { team: '评审团' },
    )
    return root
  }

  it('验收状态：没有验收人 / 还没结论 / 最近一次结论', () => {
    const says: any[] = []
    const root = team3(1, says)
    const team = root.listTeams()[0]
    expect(team.reviewerNames()).toEqual(['后端'])
    expect(team.reviewState()).toBe('pending')
    expect(says[1](['前端'], '打回，缺测试', 'reject').ok).toBe(true)
    expect(team.reviewState()).toBe('reject')
    expect(says[1](['前端'], '这次可以', 'pass').ok).toBe(true)
    expect(team.reviewState()).toBe('pass')
    expect(team.transcript().map(m => m.verdict)).toEqual(['reject', 'pass'])
    expect(team.view().review).toBe('pass')
    expect(team.view().reviewers).toEqual(['后端'])
    root.abortAll()

    const none: any[] = []
    const plain = team3(undefined, none)
    expect(plain.listTeams()[0].reviewState()).toBe('none')
    expect(plain.listTeams()[0].view().review).toBeUndefined()
    plain.abortAll()
  })

  it('只有验收人能带结论', () => {
    const says: any[] = []
    const root = team3(1, says)
    const denied = says[0](['后端'], '我觉得通过', 'pass')
    expect(denied.ok).toBe(false)
    expect(root.listTeams()[0].transcript()).toHaveLength(0)
    root.abortAll()
  })

  it('交给组长的话里带验收状态，群消息带结论标记；没有验收人就没有这一行', () => {
    const says: any[] = []
    const root = team3(1, says)
    const team = root.listTeams()[0]
    says[1](['前端'], '打回', 'reject')
    const members = root.teamMembers(team)
    expect(texts.stopped(team, members)).toContain('验收：最近一次结论是「打回」')
    expect(texts.stopped(team, members)).toContain('（验收：打回）')
    expect(texts.checkpoint(team, members)).toContain('验收：')
    root.abortAll()

    const none: any[] = []
    const plain = team3(undefined, none)
    expect(texts.stopped(plain.listTeams()[0], plain.teamMembers(plain.listTeams()[0]))).not.toContain('验收')
    plain.abortAll()
  })

  it('指定验收人的写法检查', () => {
    expect(parseDispatchTasks({ tasks: [{ description: 'x', prompt: 'p', role: '专家', reviewer: true }] })).toHaveProperty('error')
    expect(parseDispatchTasks({ tasks: [{ description: 'x', prompt: 'p', reviewer: true }] })).toHaveProperty('error')
    const ok = parseDispatchTasks({ team: 't', tasks: [
      { description: 'a', prompt: 'p', role: '甲', reviewer: true },
      { description: 'b', prompt: 'p', role: '乙' },
    ] })
    expect('tasks' in ok && ok.tasks[0].reviewer).toBe(true)
    const all = parseDispatchTasks({ team: 't', tasks: [
      { description: 'a', prompt: 'p', role: '甲', reviewer: true },
      { description: 'b', prompt: 'p', role: '乙', reviewer: true },
    ] })
    expect(all).toHaveProperty('error')
    const bad = parseDispatchTasks({ team: 't', tasks: [{ description: 'a', prompt: 'p', role: '甲', reviewer: 'yes' }, { description: 'b', prompt: 'p', role: '乙' }] })
    expect(bad).toHaveProperty('error')
  })
})

describe('组织看板与开场', () => {
  it('看板：每份花名册一段，写明层数、向谁汇报、团的验收状态', () => {
    const board = renderBoard([
      { depth: 0, rows: ['研发组 | 在干 | - | - | [研发组长] 带研发组'], teams: [] },
      { owner: '研发组', depth: 1, rows: ['前端 | 已完成 | 10 | /tmp/前端.md | [前端专家「项目团」] 做界面'], teams: [{ name: '项目团', review: 'reject', reviewers: ['后端'] }] },
      { owner: '子组', depth: 2, reportsTo: '研发组', rows: [], teams: [{ name: '小团', review: 'none', reviewers: [] }] },
    ], { live: 1, total: 3 })
    expect(board).toContain('合计：1 人没做完，共 3 人。')
    expect(board).toContain('## 秘书名下')
    expect(board).toContain('## 研发组 名下（第 1 层，向 秘书 汇报）')
    expect(board).toContain('## 子组 名下（第 2 层，向 研发组 汇报）')
    expect(board).toContain('团「项目团」，验收：最近一次结论「打回」（后端）')
    expect(board).toContain('团「小团」，没有验收人')
    expect(board).toContain('前端 | 已完成 | 10 | /tmp/前端.md')
  })

  it('开场：看板位置、结果目录、向谁汇报；组长再多一句他名下的目录', () => {
    const member = orgOpeningNote({ boardPath: '/b/board.md', resultDir: '/b/org/组长', reportsTo: '组长' })
    expect(member).toContain('/b/board.md')
    expect(member).toContain('/b/org/组长')
    expect(member).toContain('向 组长 汇报')
    expect(member).toContain('以文件为准')
    expect(member).not.toContain('你是组长')
    const lead = orgOpeningNote({ boardPath: '/b/board.md', resultDir: '/b', leadDir: '/b/org/甲' })
    expect(lead).toContain('向 秘书 汇报')
    expect(lead).toContain('你是组长')
    expect(lead).toContain('/b/org/甲')
  })
})

describe('组织的存盘', () => {
  const state = (name: string, parent?: string, lead = false) => ({
    name, description: name, prompt: 'p', status: 'completed' as const, steps: [], ...(parent ? { parent } : {}), ...(lead ? { lead: true, role: '组长甲' } : {}),
  })

  it('秘书只从盘上取自己直接派的人；组长名下的记作别人的，点名时说明归谁', () => {
    const root = new SubAgentRoster({ knockSettleMs: 0 })
    const restoreDormant = () => [state('研发组', undefined, true), state('前端', '研发组')] as any
    const d = { ...deps(() => worker()), restoreDormant }
    const reply = root.followup('前端', 'hi', d)
    expect(reply.ok).toBe(false)
    expect(reply.error).toContain('研发组')
    expect(root.followup('不存在', 'hi', d).error).toContain('没有叫')
    // 名字全组织不重复：新派的人不能占用盘上组长名下的名字
    root.spawn([{ description: '前端', prompt: 'p' }], d)
    expect(root.childNames()).toEqual(['前端-2'])
    root.abortAll()
  })
})

describe('组长收工之后账本仍然管得住', () => {
  const tick = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms))

  it('组长收工后，他名下的名字仍然占着：别人不会再派出同名的人盖掉他的对话', async () => {
    const root = new SubAgentRoster({ knockSettleMs: 0 })
    root.spawn(
      [{ description: '甲组', prompt: 'p', role: '甲组长', lead: true }],
      deps(() => lead({ members: [{ description: '调研员', prompt: 'p' }] })),
    )
    await tick(150)
    const names = root.spawn([{ description: '调研员', prompt: 'p' }], deps(() => worker()))
    expect(names).toEqual(['调研员-2'])
    root.abortAll()
  })

  it('秘书叫得醒组长名下已经停下的人', async () => {
    const root = new SubAgentRoster({ knockSettleMs: 0 })
    const rosters: SubAgentRoster[] = []
    // 组长不收工：手下干完以后一直等着
    const stay = (): ChildAgentHandle => {
      let seat: LeadSeat | undefined
      let roster: SubAgentRoster | undefined
      return {
        isRunning: () => true,
        abort: () => { roster?.abortAll(); return true },
        addUserMessage: () => true,
        becomeLead: (s) => { seat = s },
        async run() {
          roster = new SubAgentRoster({ knockSettleMs: 0 })
          if (seat) roster.attachLedger(seat.ledger, seat.name, seat.depth)
          rosters.push(roster)
          roster.spawn([{ description: '甲员', prompt: 'p' }], deps(() => worker(10)))
          await new Promise(resolve => setTimeout(resolve, 5000))
          return 'x'
        },
      }
    }
    root.spawn([{ description: '甲组', prompt: 'p', role: '甲组长', lead: true }], deps(() => stay()))
    await tick(150)
    expect(rosters[0].hasMember('甲员')).toBe(true)
    expect(root.interrupt('甲员').error ?? '').not.toContain('没有叫')
    root.abortAll()
  })
})
