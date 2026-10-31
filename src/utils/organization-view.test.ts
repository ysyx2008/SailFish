import { describe, expect, it } from 'vitest'
import type { OrganizationMemberView, OrganizationView } from '@shared/types'
import { buildOrgTree, describeOrgDock, organizationAttention } from './organization-view'

const m = (name: string, extra: Partial<OrganizationMemberView> = {}): OrganizationMemberView => ({
  id: name, name, description: name, status: 'running', ...extra,
})
const t = (key: string, named?: Record<string, unknown>) => `${key}:${JSON.stringify(named ?? {})}`

const view: OrganizationView = {
  members: [
    m('甲组', { lead: true, role: '组长' }),
    m('乙组', { lead: true, role: '组长' }),
    m('前端', { parent: '甲组', team: '项目团', role: '前端专家' }),
    m('后端', { parent: '甲组', team: '项目团', role: '后端专家', reviewer: true }),
    m('散工', { parent: '甲组' }),
    m('子组', { parent: '乙组', lead: true }),
    m('小丙', { parent: '子组' }),
  ],
  teams: [{ name: '项目团', owner: '甲组', review: 'pending', reviewers: ['后端'], messageCount: 3, waitingLeader: false, wakeLimit: 30 }],
  live: 7,
  total: 7,
}

describe('组织图', () => {
  it('还原成树：秘书名下是两位组长，组长名下按团分组，没组团的散人放最前', () => {
    const root = buildOrgTree(view)
    expect(root).toHaveLength(1)
    expect(root[0].team).toBeUndefined()
    expect(root[0].nodes.map(n => n.member.name)).toEqual(['甲组', '乙组'])

    const jia = root[0].nodes[0]
    expect(jia.groups.map(g => g.team?.name)).toEqual([undefined, '项目团'])
    expect(jia.groups[0].nodes.map(n => n.member.name)).toEqual(['散工'])
    expect(jia.groups[1].nodes.map(n => n.member.name)).toEqual(['前端', '后端'])

    const yi = root[0].nodes[1]
    expect(yi.groups[0].nodes[0].member.name).toBe('子组')
    expect(yi.groups[0].nodes[0].groups[0].nodes[0].member.name).toBe('小丙')
  })

  it('数据成环也不会无限往下', () => {
    const loop: OrganizationView = { members: [m('甲', { lead: true, parent: '乙' }), m('乙', { lead: true, parent: '甲' })], teams: [], live: 2, total: 2 }
    expect(buildOrgTree(loop)).toEqual([])
  })

  it('十层无role负责人及最底层执行成员全部可达，不被旧绘制层数截断', () => {
    const leads = Array.from({ length: 10 }, (_, i) => m(`负责人${i + 1}`, { lead: true, parent: i ? `负责人${i}` : undefined }))
    const members = [...leads, m('末层成员', { parent: '负责人10' })]
    const tree = buildOrgTree({ members, teams: [], total: 11, live: 11 })
    let groups = tree
    const names: string[] = []
    while (groups.length) {
      expect(groups[0].nodes).toHaveLength(1)
      const node = groups[0].nodes[0]
      names.push(node.member.name)
      groups = node.groups
    }
    expect(names).toEqual(members.map(member => member.name))
  })

  it('可达数据含同名祖先时按路径防环，不额外展开祖先副本', () => {
    const members = [m('甲', { lead: true }), m('乙', { lead: true, parent: '甲' }), m('甲', { lead: true, parent: '乙' })]
    const tree = buildOrgTree({ members, teams: [], live: 3, total: 3 })
    expect(tree[0].nodes[0].groups[0].nodes[0].groups).toEqual([])
  })

  it('顶部一行：在干 / 有问题 / 都干完', () => {
    expect(describeOrgDock(t, view)).toMatchObject({ kind: 'working' })
    const done: OrganizationView = { ...view, live: 0, members: view.members.map(x => ({ ...x, status: 'completed' as const })) }
    expect(describeOrgDock(t, done).headline).toContain('dockStopped')
    expect(describeOrgDock(t, { ...done, teams: [] }).kind).toBe('done')
    const bad: OrganizationView = { ...done, members: done.members.map((x, i) => (i === 0 ? { ...x, status: 'failed' as const } : x)) }
    expect(describeOrgDock(t, bad).kind).toBe('problem')
    // 出问题的人没放进 members（人数太多被截断）时，也要按全组织的数报问题
    expect(describeOrgDock(t, { ...done, problems: 1 }).kind).toBe('problem')
  })

  it('正在做、执行失败、打回、待验收和等负责人同时保留', () => {
    const mixed: OrganizationView = { ...view, members: [...view.members, m('失败', { status: 'failed' })], teams: [
      { ...view.teams[0], review: 'reject', waitingLeader: true },
      { ...view.teams[0], name: '待验团', review: 'pending' },
    ] }
    expect(organizationAttention(mixed)).toEqual({ problems: 1, rejected: 1, pending: 1, waiting: 1 })
    const dock = describeOrgDock(t, mixed)
    expect(dock.kind).toBe('problem')
    for (const key of ['dockWorking', 'cardProblem', 'summaryRejected', 'summaryPending', 'summaryWaiting']) expect(dock.headline).toContain(key)
    const stopped = describeOrgDock(t, { ...mixed, live: 0, members: [], problems: 0 })
    expect(stopped.headline).toContain('dockStopped')
    expect(stopped.headline).not.toContain('dockDone')
  })

  it('仅等负责人处理时显示已收工与等待，不显示都干完了或完成勾', () => {
    const waiting: OrganizationView = { ...view, live: 0, members: view.members.map(x => ({ ...x, status: 'completed' })),
      teams: [{ ...view.teams[0], review: 'none', waitingLeader: true }],
    }
    expect(describeOrgDock(t, waiting).kind).toBe('problem')
    expect(describeOrgDock(t, waiting).headline).toContain('dockStopped')
    expect(describeOrgDock(t, waiting).headline).toContain('summaryWaiting')
    expect(describeOrgDock(t, waiting).headline).not.toContain('dockDone')
  })

  it('完整构建 1000 人、101 团，默认包含尾部节点', () => {
    const members = Array.from({ length: 1000 }, (_, i) => m(`成员${i}`, { team: `团${i % 101}` }))
    const teams = Array.from({ length: 101 }, (_, i) => ({ name: `团${i}`, review: 'none' as const, messageCount: 0, waitingLeader: false, wakeLimit: 30 }))
    const tree = buildOrgTree({ members, teams, total: 1000, live: 1000 })
    expect(tree).toHaveLength(101)
    expect(tree.flatMap(g => g.nodes)).toHaveLength(1000)
    expect(tree.flatMap(g => g.nodes).some(n => n.member.name === '成员999')).toBe(true)
  })

  it('不同组长手下的同名团各归各的组', () => {
    const sameName: OrganizationView = {
      ...view,
      members: [...view.members, m('小丁', { parent: '乙组', team: '项目团' })],
      teams: [
        view.teams[0],
        { name: '项目团', owner: '乙组', review: 'none', messageCount: 0, waitingLeader: false, wakeLimit: 30 },
      ],
    }
    const root = buildOrgTree(sameName)
    const teamOf = (name: string) => root[0].nodes.find(n => n.member.name === name)!.groups.find(g => g.team)!
    expect(teamOf('甲组').team?.owner).toBe('甲组')
    expect(teamOf('甲组').nodes.map(n => n.member.name)).toEqual(['前端', '后端'])
    expect(teamOf('乙组').team?.owner).toBe('乙组')
    expect(teamOf('乙组').nodes.map(n => n.member.name)).toEqual(['小丁'])
  })
})
