import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { AgentRecord, AgentStepRecord, OrganizationView } from '@shared/types'
import { childDirName, type ChildState } from '../sub-agent-record-store'
import { saveSessionRecord, saveSessionRecordToDir } from '../session-persistence'
import { AgentRecordStore } from '../agent-record-store'
import { rebuildOrganization } from '../organization-rebuild'

const child = (name: string, extra: Partial<ChildState> = {}): ChildState => ({
  name,
  description: `${name}在做的事`,
  prompt: '干活',
  status: 'completed',
  updatedAt: 1,
  ...extra,
})

const base: OrganizationView = {
  members: [
    { id: '研发组长', name: '研发组长', description: '带研发组', status: 'running', lead: true, team: '项目组' },
    { id: '运营组长', name: '运营组长', description: '带运营组', status: 'running', lead: true, team: '项目组' },
  ],
  teams: [{ name: '项目组', review: 'none', messageCount: 0, waitingLeader: false, wakeLimit: 30 }],
  live: 2,
  total: 2,
}

const leaderRecord = (leader: string, team: string, members: string[]): AgentRecord => ({
  steps: [{
    id: `${leader}-dispatch`,
    type: 'tool_call',
    timestamp: 10,
    content: '',
    subAgents: members.map(name => ({ id: name, name, description: '', status: 'completed' })),
    expertTeam: {
      name: team,
      messages: [],
      wakes: 0,
      wakeLimit: 30,
      waitingLeader: false,
      reviewers: members.includes('安全复核与实测') ? ['安全复核与实测'] : undefined,
      review: 'pass',
      chatFile: `team-${team}.jsonl`,
      transcriptPath: `team-${team}.md`,
    },
  }],
} as unknown as AgentRecord)

describe('从伙计记录重建组织', () => {
  const children = [
    child('研发组长', { lead: true, role: '研发组长', status: 'running', team: '项目组' }),
    child('运营组长', { lead: true, role: '运营组长', status: 'running', team: '项目组' }),
    child('写清理脚本', { parent: '研发组长', status: 'running' }),
    child('安全复核与实测', { parent: '研发组长' }),
    child('写使用指引', { parent: '运营组长' }),
    child('写风险提示', { parent: '运营组长', status: 'running' }),
  ]
  const leaders = [
    { leader: children[0], record: leaderRecord('研发组长', '研发团', ['写清理脚本', '安全复核与实测']) },
    { leader: children[1], record: leaderRecord('运营组长', '运营团', ['写使用指引', '写风险提示']) },
  ]

  it('补齐组长自己派的人、团和验收人，已有的不动', () => {
    const org = rebuildOrganization({ ...base, sessionId: 'original-session' }, children, leaders)
    expect(org.sessionId).toBe('original-session')
    expect(org.teams.map(t => [t.name, t.owner])).toEqual([
      ['项目组', undefined],
      ['研发团', '研发组长'],
      ['运营团', '运营组长'],
    ])
    expect(org.members.map(m => m.name)).toEqual([
      '研发组长', '运营组长', '写清理脚本', '安全复核与实测', '写使用指引', '写风险提示',
    ])
    expect(org.members.find(m => m.name === '写清理脚本')?.team).toBe('研发团')
    expect(org.members.find(m => m.name === '安全复核与实测')?.reviewer).toBe(true)
    expect(org.total).toBe(6)
    expect(org.live).toBe(4)
    expect(org.teams.find(t => t.name === '研发团')?.review).toBe('pass')
    expect(org.teams.find(t => t.name === '研发团')?.chatFile).toBe('team-研发团.jsonl')
  })

  it('组长名下再设组长时，那一层的团和验收人也从记录补回来', () => {
    const nested = [
      child('研发组长', { lead: true, role: '研发组长', status: 'running', team: '项目组' }),
      child('子组长', { lead: true, role: '子组长', parent: '研发组长', status: 'running' }),
      child('子员', { parent: '子组长', team: '子团' }),
      child('子验收', { parent: '子组长', team: '子团' }),
    ]
    const record = leaderRecord('子组长', '子团', ['子员', '子验收'])
    record.steps[0].expertTeam!.reviewers = ['子验收']
    record.steps[0].expertTeam!.review = 'pass'

    const org = rebuildOrganization(base, nested, [{ leader: nested[1], record }])
    expect(org.teams.map(t => [t.name, t.owner])).toContainEqual(['子团', '子组长'])
    expect(org.members.find(m => m.name === '子员')?.team).toBe('子团')
    expect(org.members.find(m => m.name === '子验收')?.reviewer).toBe(true)
    expect(org.teams.find(t => t.name === '子团')?.review).toBe('pass')

    // 快照里已经有人、但缺验收人标记和团归属时，照样补上
    const withMember: OrganizationView = {
      ...base,
      members: [...base.members, { id: '子验收', name: '子验收', description: '', status: 'completed', parent: '子组长' }],
    }
    const filled = rebuildOrganization(withMember, nested, [{ leader: nested[1], record }])
    expect(filled.members.find(m => m.name === '子验收')?.reviewer).toBe(true)
    expect(filled.members.find(m => m.name === '子验收')?.team).toBe('子团')
  })

  it('再跑一遍结果不变', () => {
    const once = rebuildOrganization(base, children, leaders)
    const twice = rebuildOrganization(once, children, leaders)
    expect(twice.members).toHaveLength(6)
    expect(twice.teams).toHaveLength(3)
    expect(twice.total).toBe(6)
    expect(twice.live).toBe(4)
  })

  it('250 人截断快照补齐后不把遗漏的 50 人再次计入，状态按存盘更新', () => {
    const all = Array.from({ length: 250 }, (_, i) => child(`成员${i}`, { parent: '研发组长', status: i < 10 ? 'failed' : 'completed' }))
    const old: OrganizationView = {
      members: all.slice(0, 200).map(c => ({ id: c.name, name: c.name, description: c.description, parent: c.parent, status: 'running' })),
      teams: [], total: 250, live: 250, omitted: 50,
    }
    const result = rebuildOrganization(old, all, [])
    expect(result.members).toHaveLength(250)
    expect(result.total).toBe(250)
    expect(result.live).toBe(0)
    expect(result.problems).toBe(10)
    expect(result.omitted).toBeUndefined()
    expect(rebuildOrganization(result, all, [])).toEqual(result)
  })
  it('只恢复部分遗漏时扣除已补部分，并保持重复恢复幂等', () => {
    const all = Array.from({ length: 220 }, (_, i) => child(`成员${i}`, { parent: '研发组长' }))
    const old: OrganizationView = { members: all.slice(0, 200).map(c => ({ id: c.name, name: c.name, description: '', parent: c.parent, status: c.status })), teams: [], total: 250, live: 50, omitted: 50 }
    const result = rebuildOrganization(old, all, [])
    expect(result.total).toBe(250)
    expect(result.omitted).toBe(30)
    expect(result.live).toBe(30)
    expect(rebuildOrganization(result, all, [])).toEqual(result)
  })
  it('已有团的旧验收会更新，但消息更旧的记录不覆盖新结论', () => {
    const record = leaderRecord('研发组长', '研发团', [])
    record.steps[0].expertTeam!.review = 'reject'
    record.steps[0].expertTeam!.messages = [{ seq: 1, from: '安全复核与实测', to: ['组长'], text: '打回', at: 20, verdict: 'reject' }]
    const team = { name: '研发团', owner: '研发组长', review: 'pending' as const, messageCount: 0, waitingLeader: false, wakeLimit: 30 }
    const result = rebuildOrganization({ ...base, teams: [team], omittedTeams: 1 }, children, [{ leader: children[0], record }])
    expect(result.teams[0]).toMatchObject({ review: 'reject', messageCount: 1, chatFile: 'team-研发团.jsonl' })
    const newer = { ...result, teams: [{ ...result.teams[0], review: 'pass' as const, messageCount: 2 }] }
    expect(rebuildOrganization(newer, children, [{ leader: children[0], record }]).teams[0].review).toBe('pass')
  })
  it('截断里的根成员也补回来，秘书直接带的团同步验收结论', () => {
    const extra = child('根成员', { team: '项目组', updatedAt: 100 })
    const root = leaderRecord('秘书', '项目组', [])
    root.steps[0].expertTeam!.review = 'reject'
    const result = rebuildOrganization({ ...base, total: 3, omitted: 1 }, [children[0], children[1], extra], [], root)
    expect(result.total).toBe(3)
    expect(result.omitted).toBeUndefined()
    expect(result.members.find(m => m.name === '根成员')).toMatchObject({ team: '项目组' })
    expect(result.teams.find(t => t.name === '项目组' && !t.owner)?.review).toBe('reject')
    expect(result.updatedAt).toBe(100)
  })
  it('组长没有自己组团的记录时，组员按 parent 挂回组长', () => {
    const noTeams = leaders.map(({ leader }) => ({ leader, record: { steps: [] } as unknown as AgentRecord }))
    const org = rebuildOrganization(base, children, noTeams)
    expect(org.teams.map(t => t.name)).toEqual(['项目组'])
    expect(org.members).toHaveLength(6)
    expect(org.members.find(m => m.name === '写清理脚本')?.parent).toBe('研发组长')
    expect(org.members.find(m => m.name === '写清理脚本')?.team).toBeUndefined()
  })

  describe('从旧会话的历史目录读回时', () => {
    const tmpDirs: string[] = []
    afterEach(() => {
      for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
    })

    it('自动用组长记录把成员和团补回快照', () => {
      const history = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-org-rebuild-'))
      tmpDirs.push(history)
      const timestamp = Date.UTC(2026, 6, 13, 10)
      const dateStr = '2026-07-13'
      const step = {
        id: 'org-1',
        type: 'tool_call',
        timestamp,
        content: '派出组长',
        organization: base,
      } as unknown as AgentStepRecord
      const root = {
        id: 'sess-1',
        timestamp,
        duration: 1,
        userTask: '组个团队',
        terminalId: 'pty',
        terminalType: 'local',
        steps: [step],
        messages: [],
        status: 'completed',
      } as unknown as AgentRecord
      saveSessionRecord(path.join(history, 'agent'), root)

      const sessionDir = path.join(history, 'sub-agents', dateStr, 'sess-1')
      const writeChild = (state: ChildState, leaderSteps?: AgentRecord) => {
        const dir = path.join(sessionDir, childDirName(state.name))
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state))
        if (leaderSteps) saveSessionRecordToDir(dir, leaderSteps)
      }
      const writeLeader = (state: ChildState, team: string, members: string[]) => {
        writeChild(state, {
          ...leaderRecord(state.name, team, members),
          id: `leader-${state.name}`,
          timestamp,
          duration: 1,
          userTask: '',
          terminalId: 'pty',
          terminalType: 'local',
          messages: [],
          status: 'completed',
        } as unknown as AgentRecord)
      }
      writeLeader(children[0], '研发团', ['写清理脚本', '安全复核与实测'])
      writeLeader(children[1], '运营团', ['写使用指引', '写风险提示'])
      for (const state of children.slice(2)) writeChild(state)

      const store = new AgentRecordStore(history)
      const loaded = store.getAgentRecordById('sess-1')
      const org = loaded?.steps[0].organization
      expect(org?.members.map(m => m.name)).toEqual([
        '研发组长', '运营组长', '写清理脚本', '安全复核与实测', '写使用指引', '写风险提示',
      ])
      expect(org?.teams.map(t => t.name)).toEqual(['项目组', '研发团', '运营团'])
    })

    it('完整的 1000 人和 101 团跨越大 JSONL 行限制后仍可从元数据读回', () => {
      const history = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-large-org-'))
      tmpDirs.push(history)
      const org: OrganizationView = {
        members: Array.from({ length: 1000 }, (_, i) => ({ id: `m${i}`, name: `成员${i}`, description: 'x'.repeat(5000), status: 'completed' as const, team: `团${i % 101}` })),
        teams: Array.from({ length: 101 }, (_, i) => ({ name: `团${i}`, review: 'none' as const, messageCount: 0, waitingLeader: false, wakeLimit: 30 })),
        total: 1000, live: 0,
      }
      const record = { id: 'large-org', timestamp: Date.UTC(2026, 9, 30), duration: 1, userTask: '完整组织', terminalId: 'pty', terminalType: 'local', messages: [], status: 'completed',
        steps: [{ id: 'large-step', type: 'tool_call', timestamp: 1, content: '派人', organization: org }],
      } as unknown as AgentRecord
      saveSessionRecord(path.join(history, 'agent'), record)
      const restored = new AgentRecordStore(history).getAgentRecordById('large-org')?.steps[0].organization
      expect(restored?.members).toHaveLength(1000)
      expect(restored?.teams).toHaveLength(101)
      expect(restored?.members.at(-1)?.name).toBe('成员999')
      expect(restored?.total).toBe(1000)
    })

    it('步骤上残留的子 Agent 状态按伙计记录校正', () => {
      const history = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-subagent-rebuild-'))
      tmpDirs.push(history)
      const timestamp = Date.UTC(2026, 6, 13, 10)
      const dateStr = '2026-07-13'
      const root = {
        id: 'sess-2',
        timestamp,
        duration: 1,
        userTask: '组个团队',
        terminalId: 'pty',
        terminalType: 'local',
        steps: [{
          id: 'd1',
          type: 'tool_call',
          timestamp,
          content: '派出组长',
          subAgents: [{ id: '研发组长', name: '研发组长', description: '带研发组', status: 'interrupted' }],
        } as unknown as AgentStepRecord],
        messages: [],
        status: 'completed',
      } as unknown as AgentRecord
      saveSessionRecord(path.join(history, 'agent'), root)

      const leaderState = child('研发组长', { status: 'completed', lead: true })
      const dir = path.join(history, 'sub-agents', dateStr, 'sess-2', childDirName(leaderState.name))
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(leaderState))

      const store = new AgentRecordStore(history)
      const loaded = store.getAgentRecordById('sess-2')
      expect(loaded?.steps[0].subAgents?.[0].status).toBe('completed')
    })
  })
})


describe('按独立团队重建历史',()=>{
  it('读取旧团队快照不能把同会话的其它团队补进来，旧无归属记录也不吸收新队',()=>{
    const states=[child('旧1'),child('新1',{teamId:'new'}),child('新2',{teamId:'new'})]
    const legacy:OrganizationView={members:[{id:'旧1',name:'旧1',description:'旧',status:'completed'}],teams:[],total:1,live:0}
    expect(rebuildOrganization(legacy,states,[]).members.map(m=>m.name)).toEqual(['旧1'])
    const current:OrganizationView={teamId:'new',members:[{id:'新1',name:'新1',description:'新',status:'running',teamId:'new'}],teams:[],total:1,live:1}
    const restored=rebuildOrganization(current,states,[])
    expect(restored.members.map(m=>m.name)).toEqual(['新1','新2'])
    expect(restored.total).toBe(2)
    expect(restored.members.every(m=>m.teamId==='new')).toBe(true)
  })
  it('按团队过滤根派出记录中的小组，不能借其它团队的群和验收',()=>{
    const current:OrganizationView={teamId:'A',members:[],teams:[],total:0,live:0}
    const record=leaderRecord('秘书','其它组',['乙'])
    record.steps[0].subAgents![0].teamId='B'
    const view=rebuildOrganization(current,[child('甲',{teamId:'A'}),child('乙',{teamId:'B',team:'其它组'})],[],record)
    expect(view.members.map(m=>m.name)).toEqual(['甲'])
    expect(view.teams).toEqual([])
  })
})
