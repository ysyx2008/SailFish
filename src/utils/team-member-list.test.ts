import { describe, expect, it } from 'vitest'
import type { OrganizationMemberView, OrganizationView } from '@shared/types'
import { teamMemberList } from './team-member-list'
import type { OrgGroup } from './organization-view'
const m = (name: string, extra: Partial<OrganizationMemberView> = {}): OrganizationMemberView => ({id:name,name,description:name,status:'completed',...extra})
const view = (members: OrganizationMemberView[], teams: OrganizationView['teams'] = []): OrganizationView => ({members,teams,total:members.length,live:members.filter(m=>m.status==='running'||m.status==='pending').length})
const names = (groups: OrgGroup[]): string[] => groups.flatMap(group=>group.nodes.flatMap(node=>[node.member.name,...names(node.groups)]))
describe('快捷名单恢复原有分页和排序',()=>{
  it('千人只显示40，增加至80时不丢原成员，全量最终均可访问',()=>{
    const org=view(Array.from({length:1000},(_,i)=>m(`成员${i}`)))
    const first=teamMemberList(org,40), next=teamMemberList(org,80), all=teamMemberList(org,1000)
    expect(first).toMatchObject({shown:40,hidden:960})
    expect(next).toMatchObject({shown:80,hidden:920})
    expect(names(next.groups)).toEqual(expect.arrayContaining(names(first.groups)))
    expect(all.hidden).toBe(0)
    expect(new Set(names(all.groups)).size).toBe(1000)
  })
  it('在干、等待、失败、打断、完成稳定排序，区分等模型',()=>{
    const org=view([m('完成'),m('打断',{status:'interrupted'}),m('失败',{status:'failed'}),m('等模型',{status:'running',waitingForModel:true}),m('在干甲',{status:'running'}),m('排队',{status:'pending'}),m('在干乙',{status:'running'})])
    expect(names(teamMemberList(org,40).groups)).toEqual(['在干甲','在干乙','等模型','排队','失败','打断','完成'])
    expect(org.members.map(m=>m.name)).toEqual(['完成','打断','失败','等模型','在干甲','排队','在干乙'])
  })
  it('不超过5人时保持旧版派出顺序',()=>{
    expect(names(teamMemberList(view([m('完成'),m('在干',{status:'running'})]),40).groups)).toEqual(['完成','在干'])
  })
  it('尾部深层活跃成员优先入选，同时保留祖先，上级计入40人',()=>{
    const org=view([m('一级',{lead:true}),m('二级',{lead:true,parent:'一级'}),...Array.from({length:998},(_,i)=>m(`成员${i}`,{parent:'二级',status:i===997?'running':'completed'}))])
    const page=teamMemberList(org,40)
    expect(names(page.groups).slice(0,3)).toEqual(['一级','二级','成员997'])
    expect(names(page.groups)).toHaveLength(40)
    expect(page.hidden).toBe(960)
    const next=teamMemberList(org,80)
    expect(names(next.groups)).toEqual(expect.arrayContaining(names(page.groups)))
  })
  it('小组按活跃分支前移，同名组在各自负责人下面，分页不产生孤儿',()=>{
    const org=view([m('负责人甲',{lead:true}),m('负责人乙',{lead:true}),m('甲完成',{parent:'负责人甲',team:'同名组'}),m('乙在干',{status:'running',parent:'负责人乙',team:'同名组'}),m('完成1'),m('完成2')],['负责人甲','负责人乙'].map(owner=>({owner,name:'同名组',review:'none',messageCount:0})))
    const page=teamMemberList(org,3)
    expect(names(page.groups)).toEqual(['负责人乙','乙在干','负责人甲'])
    expect(page.groups[0].nodes[0].groups[0].team?.owner).toBe('负责人乙')
    const all=teamMemberList(org,40)
    const a=all.groups.flatMap(g=>g.nodes).find(n=>n.member.name==='负责人甲')!
    expect(names(a.groups)).toEqual(['甲完成'])
  })
  it('状态改变后重新优先选择活跃成员，不截断全量组织数据',()=>{
    const org=view(Array.from({length:100},(_,i)=>m(`成员${i}`)))
    org.members[99].status='running'
    expect(names(teamMemberList(org,40).groups)[0]).toBe('成员99')
    org.members[99].status='completed';org.members[90].status='pending'
    expect(names(teamMemberList(org,40).groups)[0]).toBe('成员90')
    expect(org.members).toHaveLength(100)
  })
  it('空组织与零范围不产生多余节点',()=>{
    expect(teamMemberList(view([]),40)).toEqual({groups:[],shown:0,hidden:0,unavailable:0})
    expect(teamMemberList(view([m('甲')]),0)).toEqual({groups:[],shown:0,hidden:1,unavailable:0})
  })
  it('同状态候选按原成员顺序选择，不被树的深度遍历顺序改变',()=>{
    const org=view([m('甲',{lead:true}),m('乙',{lead:true}),m('乙先派',{parent:'乙',status:'running'}),m('甲后派',{parent:'甲',status:'running'}),m('完成1'),m('完成2')])
    expect(names(teamMemberList(org,2).groups)).toEqual(['乙','乙先派'])
  })
  it('历史缺失人数另列，不算作点更多就能加载的人',()=>{
    const org={...view(Array.from({length:50},(_,i)=>m(`成员${i}`))),total:70,omitted:20}
    expect(teamMemberList(org,40)).toMatchObject({shown:40,hidden:10,unavailable:20})
    expect(teamMemberList(org,80)).toMatchObject({shown:50,hidden:0,unavailable:20})
    const broken=view([m('不完整成员',{parent:'不存在的上级'})])
    expect(teamMemberList(broken,40)).toMatchObject({shown:0,hidden:0,unavailable:1})
  })

})
