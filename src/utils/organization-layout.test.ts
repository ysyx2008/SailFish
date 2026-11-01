import { describe, expect, it } from 'vitest'
import type { OrganizationMemberView, OrganizationView } from '@shared/types'
import { buildOrgTree } from './organization-view'
import { layoutOrganization, ORG_CARD_HEIGHT, visibleOrgLines } from './organization-layout'

const member = (name: string, parent?: string, lead = true, team?: string): OrganizationMemberView => ({ id: name, name, parent, lead, team, description: name, status: 'running' })
const view = (members: OrganizationMemberView[], teams: OrganizationView['teams'] = []): OrganizationView => ({ members, teams, total: members.length, live: members.length })

describe('横向团队布局', () => {
  it('有下级的整枝与单个成员同级对齐，连线只指向真实直属成员', () => {
    const source = view([member('总负责人'), member('文档', '总负责人'), member('数据', '总负责人'), member('数据子组', '数据'), member('叶子', '数据子组', false)])
    const result = layoutOrganization(buildOrgTree(source), 1000)
    const byName = (name: string) => result.members.find(item => item.node.member.name === name)!
    expect(byName('文档').x).toBe(byName('数据').x)
    expect(byName('数据子组').x).toBeGreaterThan(byName('数据').x)
    expect(result.members.map(item => item.node.member.name)).toEqual(['总负责人', '文档', '数据', '数据子组', '叶子'])
    for (const child of result.members.filter(item => item.depth > 0)) {
      const parent = byName(child.node.member.parent!)
      expect(child.x - parent.x).toBe(296)
      expect(result.lines.some(line => line.x2 === child.x && line.y2 === child.y + ORG_CARD_HEIGHT / 2)).toBe(true)
    }
    // 任意两张卡片不能覆盖；有下级的同伴不再因额外框线向右缩进。
    result.members.forEach((a, i) => result.members.slice(i + 1).forEach(b => {
      expect(a.x + 240 <= b.x || b.x + 240 <= a.x || a.y + 76 <= b.y || b.y + 76 <= a.y).toBe(true)
    }))
  })
  it('小组不增加管理层级，异主同名团不混合', () => {
    const source = view([member('甲'), member('乙'), member('A', '甲', false, '同名'), member('B', '乙', false, '同名'), member('散人', '甲', false)],
      ['甲', '乙'].map(owner => ({ owner, name: '同名', review: 'pending', messageCount: 1 })))
    const result = layoutOrganization(buildOrgTree(source), 1000)
    expect(result.teams.map(item => item.key)).toEqual(['["甲","同名"]', '["乙","同名"]'])
    expect(result.members.filter(item => ['A', 'B', '散人'].includes(item.node.member.name)).map(item => item.x)).toEqual([296, 296, 296])
    expect(result.teams.every(item => item.x === 296)).toBe(true)
  })
  it('无管理层级时按宽度多列排布，千人完整保留，状态更新不改变坐标', () => {
    const source = view(Array.from({ length: 1000 }, (_, i) => member(`成员${i}`, undefined, false)))
    const initial = layoutOrganization(buildOrgTree(source), 1000)
    expect(initial.members).toHaveLength(1000)
    expect(new Set(initial.members.filter(item => item.y === 0).map(item => item.x)).size).toBe(3)
    expect(initial.lines).toHaveLength(0)
    source.members.forEach(item => { item.status = 'completed' })
    const done = layoutOrganization(buildOrgTree(source), 1000)
    const positions = (result: typeof initial) => result.members.map(({ x, y, depth }) => ({ x, y, depth }))
    expect(positions(done)).toEqual(positions(initial))
    expect(layoutOrganization([], 0)).toMatchObject({ members: [], teams: [], width: 0, height: 0 })
  })
  it('裁掉屏外线段，并将长主干裁到当前视口', () => {
    const source = view([member('负责人'), ...Array.from({ length: 999 }, (_, i) => member(`成员${i}`, '负责人', false))])
    const result = layoutOrganization(buildOrgTree(source), 800)
    expect(result.members).toHaveLength(1000)
    const visible = visibleOrgLines(result.lines, { left: 0, top: 0, right: 600, bottom: 900 })
    expect(visible.length).toBeLessThan(15)
    expect(visible.every(line => line.y1 >= 0 && line.y2 <= 900)).toBe(true)
  })
})
