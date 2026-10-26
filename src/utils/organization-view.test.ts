import { describe, expect, it } from 'vitest'
import type { OrganizationMemberView, OrganizationView } from '@shared/types'
import { buildOrgTree, describeOrgDock } from './organization-view'

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

  it('顶部一行：在干 / 有问题 / 都干完', () => {
    expect(describeOrgDock(t, view)).toMatchObject({ kind: 'working' })
    const done: OrganizationView = { ...view, live: 0, members: view.members.map(x => ({ ...x, status: 'completed' as const })) }
    expect(describeOrgDock(t, done).kind).toBe('done')
    const bad: OrganizationView = { ...done, members: done.members.map((x, i) => (i === 0 ? { ...x, status: 'failed' as const } : x)) }
    expect(describeOrgDock(t, bad).kind).toBe('problem')
  })
})
