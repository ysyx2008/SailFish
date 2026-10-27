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
    const org = rebuildOrganization(base, children, leaders)
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

  it('再跑一遍结果不变', () => {
    const once = rebuildOrganization(base, children, leaders)
    const twice = rebuildOrganization(once, children, leaders)
    expect(twice.members).toHaveLength(6)
    expect(twice.teams).toHaveLength(3)
    expect(twice.total).toBe(6)
    expect(twice.live).toBe(4)
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
