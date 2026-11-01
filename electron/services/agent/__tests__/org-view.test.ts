const tmp = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path')
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sft-org-view-'))
})
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue(tmp),
    getName: vi.fn().mockReturnValue('SailFish'),
    getVersion: vi.fn().mockReturnValue('1.0.0')
  },
  BrowserWindow: vi.fn(),
  ipcMain: { on: vi.fn(), handle: vi.fn() }
}))

import fs from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { SubAgentRoster, type ChildAgentHandle, type RosterSpawnDeps, type SpawnTask } from '../sub-agent-roster'
import { OrgLedger, type LeadSeat } from '../org-ledger'
import { createTeamTexts } from '../tools/expert-team-text'
import { dispatchStepView, refreshOrgBoard, workspaceOf } from '../tools/sub-agent'
import type { AgentContext } from '../types'
import type { AiMessage } from '../../ai.service'

afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

const context: AgentContext = { terminalOutput: [], systemInfo: { os: 'darwin', shell: 'zsh' }, terminalType: 'assistant', cwd: '/tmp' }
const tick = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms))

function deps(createChild: (name: string) => ChildAgentHandle): RosterSpawnDeps {
  return {
    createChild,
    getParentMessages: () => [] as AiMessage[],
    getParentContext: () => context,
    knock: () => {},
    onProgress: () => {},
    isParentAborted: () => false,
    sanitize: () => [] as AiMessage[],
    formatKnock: snap => `knock:${snap.name}:${snap.status}`,
    teamTexts: createTeamTexts(team => `/tmp/${team.name}.md`),
  }
}

function worker(delayMs: number): ChildAgentHandle {
  let running = false
  let aborted = false
  return {
    isRunning: () => running,
    abort: () => { aborted = true; running = false; return true },
    addUserMessage: () => true,
    async run() {
      running = true
      await new Promise(resolve => setTimeout(resolve, delayMs))
      running = false
      if (aborted) throw new Error('aborted')
      return 'done'
    },
  }
}

/** 组长：开跑时建花名册，在自己名下组一个两人的团，团员干完他才收工 */
function leadWithTeam(rosters: SubAgentRoster[], memberMs: number, rosterDeps: RosterSpawnDeps): ChildAgentHandle {
  let seat: LeadSeat | undefined
  let roster: SubAgentRoster | undefined
  let running = false
  return {
    isRunning: () => running,
    abort: () => { roster?.abortAll(); running = false; return true },
    addUserMessage: () => true,
    becomeLead: (s) => { seat = s },
    async run() {
      running = true
      roster = new SubAgentRoster({ knockSettleMs: 0 })
      if (seat) roster.attachLedger(seat.ledger, seat.name, seat.depth)
      rosters.push(roster)
      const tasks: SpawnTask[] = [
        { description: '前端', prompt: 'p', role: '前端专家' },
        { description: '后端', prompt: 'p', role: '后端专家', reviewer: true },
      ]
      roster.spawn(tasks, { ...rosterDeps, createChild: () => worker(memberMs) }, { team: '项目团' })
      while (roster.hasLive()) await roster.waitForKnock(new AbortController().signal)
      roster.release()
      running = false
      return 'lead done'
    },
  }
}

describe('组织全貌（给界面看的那一份）', () => {
  it('没有组长也带独立团队全貌，成员执行规则不变', () => {
    const root = new SubAgentRoster({ knockSettleMs: 0 })
    const names = root.spawn([{ description: '甲', prompt: 'p' }], deps(() => worker(50)))
    const view = dispatchStepView(root, new Set(names))
    expect(view.organization?.total).toBe(1)
    expect(view.organization?.teamId).toBeTruthy()
    expect(view.organization?.teams).toEqual([])
    expect(view.subAgents).toHaveLength(1)
    root.abortAll()
  })

  it('指定了组长：带整个组织的人、团、合计和看板位置；组长收工后他那一段仍在', async () => {
    const root = new SubAgentRoster({ knockSettleMs: 0 })
    const rosters: SubAgentRoster[] = []
    const rootDeps = deps(() => leadWithTeam(rosters, 80, rootDeps))
    const names = root.spawn([{ description: '研发组', prompt: 'p', role: '研发组长', lead: true }], rootDeps)
    await tick(30)

    const view = dispatchStepView(root, new Set(names))
    const org = view.organization!
    expect(org).toBeDefined()
    expect(org.total).toBe(3)
    expect(org.live).toBe(3)
    const byName = Object.fromEntries(org.members.map(m => [m.name, m]))
    expect(byName['研发组']).toMatchObject({ lead: true, role: '研发组长' })
    expect(byName['研发组'].parent).toBeUndefined()
    expect(byName['前端']).toMatchObject({ parent: '研发组', team: '项目团' })
    expect(byName['后端']).toMatchObject({ parent: '研发组', team: '项目团', reviewer: true })
    expect(org.members.every(member => member.teamId === org.teamId)).toBe(true)
    expect(org.teams).toEqual([expect.objectContaining({ name: '项目团', owner: '研发组', review: 'pending', reviewers: ['后端'] })])
    expect(org.boardPath && fs.existsSync(org.boardPath)).toBe(true)
    expect(fs.readFileSync(org.boardPath!, 'utf8')).toContain('研发组')

    await tick(400)
    refreshOrgBoard(root)
    const after = dispatchStepView(root, new Set(names)).organization!
    expect(after.live).toBe(0)
    expect(after.members.map(m => m.name).sort()).toEqual(['前端', '后端', '研发组'])
    expect(after.members.every(m => m.status === 'completed')).toBe(true)
    // 组长名下的结果放在 org/<组长>/ 里
    expect(workspaceOf(rosters[0]).directory).toContain(`${path.sep}org${path.sep}`)
  })

  it('人很多时保留完整团队，合计与尾部成员均真实', async () => {
    const root = new SubAgentRoster({ knockSettleMs: 0 })
    const rosters: SubAgentRoster[] = []
    const bigDeps = (): RosterSpawnDeps => deps(() => {
      let seat: LeadSeat | undefined
      let roster: SubAgentRoster | undefined
      let running = false
      const self: ChildAgentHandle = {
        isRunning: () => running,
        abort: () => { roster?.abortAll(); running = false; return true },
        addUserMessage: () => true,
        becomeLead: (s) => { seat = s },
        async run() {
          running = true
          roster = new SubAgentRoster({ knockSettleMs: 0 })
          if (seat) roster.attachLedger(seat.ledger, seat.name, seat.depth)
          rosters.push(roster)
          roster.spawn(Array.from({ length: 250 }, (_, i) => ({ description: `工人${i}`, prompt: 'p' })), deps(() => worker(300)))
          while (roster.hasLive()) await roster.waitForKnock(new AbortController().signal)
          roster.release()
          running = false
          return 'ok'
        },
      }
      return self
    })
    const names = root.spawn([{ description: '大组', prompt: 'p', role: '大组长', lead: true }], bigDeps())
    await tick(50)
    const org = dispatchStepView(root, new Set(names)).organization!
    expect(org.total).toBe(251)
    expect(org.members.length).toBe(251)
    expect(org.omitted).toBeUndefined()
    expect(org.members.some(m => m.lead)).toBe(true)
    root.abortAll()
  })

  it('组长收工后重新挂空名册或只恢复部分成员，不丢旧成员及看板行', async () => {
    const root = new SubAgentRoster({ knockSettleMs: 0 })
    const rosters: SubAgentRoster[] = []
    let seat!: LeadSeat
    const rootDeps = deps(() => {
      const handle = leadWithTeam(rosters, 100, rootDeps)
      const bind = handle.becomeLead!
      return { ...handle, becomeLead: s => { seat = s; bind(s) } }
    })
    const names = root.spawn([{ description: '研发组', prompt: 'p', role: '研发组长', lead: true }], rootDeps)
    refreshOrgBoard(root)
    await root.settled()
    refreshOrgBoard(root)
    const workspace = workspaceOf(root)
    const before = workspace.organizationView()
    expect(before.total).toBe(3)
    expect(before.live).toBe(0)

    const resumed = new SubAgentRoster({ knockSettleMs: 0 })
    resumed.attachLedger(seat.ledger, seat.name, seat.depth)
    refreshOrgBoard(resumed)
    expect(workspace.organizationView().members).toEqual(before.members)
    expect(fs.readFileSync(workspace.boardPath, 'utf8')).toContain('后端 | 已完成')

    const front = before.members.find(member => member.name === '前端')!
    const d = { ...deps(() => worker(30)), restoreDormant: () => [{
      ...front, description: front.description, prompt: 'p', status: 'completed' as const,
      revive: () => ({ handle: worker(30), steps: [] }),
    }] }
    expect(resumed.followup('前端', '再核对', d).ok).toBe(true)
    refreshOrgBoard(resumed)
    expect(workspace.organizationView()).toMatchObject({ total: 3, live: 1 })
    expect(workspace.organizationView().members.find(member => member.name === '后端')?.status).toBe('completed')
    await resumed.settled()
    refreshOrgBoard(resumed)
    expect(workspace.organizationView()).toMatchObject({ total: 3, live: 0 })

    resumed.spawn([{ description: '新增', prompt: 'p' }], deps(() => worker(10)))
    refreshOrgBoard(resumed)
    expect(workspace.organizationView()).toMatchObject({ total: 4, live: 1 })
    expect(workspace.organizationView().members.map(member => member.name).sort()).toEqual(['前端', '后端', '新增', ...names].sort())
    expect(fs.readFileSync(workspace.boardPath, 'utf8')).toContain('后端 | 已完成')
    await resumed.settled()
    resumed.release(); root.release()
  })
})

describe('组织账本通知', () => {
  it('订阅者回调里再通知不会递归', () => {
    const ledger = new OrgLedger()
    let calls = 0
    ledger.subscribe(() => {
      calls += 1
      ledger.notify()
    })
    ledger.notify()
    expect(calls).toBe(1)
  })
})
