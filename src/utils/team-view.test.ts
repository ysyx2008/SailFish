import { describe, expect, it } from 'vitest'
import type { AgentStep, OrganizationView } from '@shared/types'
import { teamCards, teamViewForStep, teamMemberSnapshot, teamMemberSnapshots } from './team-view'
const step = (id: string, extra: Partial<AgentStep> = {}): AgentStep => ({ id, type: 'tool_call', content: '', timestamp: 1, ...extra })
const member = (name: string, status: 'running' | 'completed' = 'running') => ({ id: name, name, description: `${name}的职责`, status })

describe('统一团队视图', () => {
  it('同一任务的多批成员合并为一个入口，追问不重复计人，状态取较新更新', () => {
    const steps = [step('u', { type: 'user_task' }), step('a', { subAgents: [member('甲')], snapshotAt: 30 }),
      step('b', { timestamp: 20, subAgents: [member('甲', 'completed'), member('乙')] })]
    expect([...teamCards(steps).keys()]).toEqual(['a'])
    expect(teamViewForStep(steps, 'a')).toMatchObject({ total: 2, live: 2 })
    expect(teamMemberSnapshot(steps, 'a', '甲')?.status).toBe('running')
    expect([...teamMemberSnapshots(steps, 'a').keys()]).toEqual(['甲', '乙'])
    expect(teamMemberSnapshots(steps, 'a').get('甲')?.status).toBe('running')
  })
  it('独立成员不伪造小组或群，真实小组保留归属与验收', () => {
    const steps = [step('a', { subAgents: [member('散人')] }), step('b', { subAgents: [member('开发'), member('测试')],
      expertTeam: { name: '研发', messages: [], reviewers: ['测试'], review: 'pending', wakes: 0, waitingLeader: false, wakeLimit: 30 } })]
    const view = teamViewForStep(steps, 'a')!
    expect(view.total).toBe(3)
    expect(view.teams).toHaveLength(1)
    expect(view.members[0].team).toBeUndefined()
    expect(view.members.find(m => m.name === '测试')).toMatchObject({ team: '研发', reviewer: true })
  })
  it('后面的用户任务独立成队，系统续跑不拆队', () => {
    const steps = [step('a', { subAgents: [member('甲')] }), step('sys', { type: 'user_task', systemInjected: true }),
      step('b', { subAgents: [member('乙')] }), step('new', { type: 'user_task' }), step('c', { subAgents: [member('丙')] })]
    expect([...teamCards(steps).values()].map(v => v.total)).toEqual([2, 1])
  })
  it('已有组织快照是权威，不被后面陈旧的重复步骤或直属名单覆盖', () => {
    const org: OrganizationView = { members: [member('真实')], teams: [], total: 1, live: 0 }
    const steps = [step('a', { organization: org }), step('b', { organization: { ...org, live: 1 }, subAgents: [member('陈旧')] })]
    expect(teamViewForStep(steps, 'b')).toMatchObject({ members: org.members, total: 1, live: 0 })
  })
  it('合并历史按原会话隔离，详情与成果不会借当前会话读取', () => {
    const steps = [step('a', { sourceSessionId: 'old-a', subAgents: [member('同名')] }), step('b', { sourceSessionId: 'old-b', subAgents: [member('同名')] })]
    expect([...teamCards(steps, 'current').values()].map(v => [v.sessionId, v.total])).toEqual([['old-a', 1], ['old-b', 1]])
  })
})

it('合并历史中的计划也按来源过滤，不借另一场任务的计划', () => {
  const steps = [step('a', { sourceSessionId: 'a', subAgents: [member('甲')] }), step('plan-b', { sourceSessionId: 'b', type: 'plan_created', plan: { id: 'p', title: '别的任务', createdAt: 1, updatedAt: 1, steps: [] } }), step('b', { sourceSessionId: 'b', subAgents: [member('乙')] })]
  expect(teamViewForStep(steps, 'a')?.members.map(m => m.name)).toEqual(['甲'])
  expect([...teamCards(steps).keys()]).toEqual(['a', 'b'])
})

it('团队图只携带活动摘要，不把工具输出正文复制到全局快照', () => {
  const source = step('a', { subAgents: [{ ...member('甲'), steps: [{ tool: 'read_file', args: '/tmp/file', status: 'completed', result: '很长的工具输出' }] }] })
  expect(teamViewForStep([source], 'a')?.members[0].activity).toEqual({ tool: 'read_file', args: '/tmp/file', status: 'completed' })
})


describe('明确的团队归属',()=>{
  const scoped=(id:string,names:string[],updatedAt=1):OrganizationView=>({teamId:id,sessionId:'sid',members:names.map(name=>({...member(name),teamId:id})),teams:[],total:names.length,live:names.length,updatedAt})
  it('同一轮派出两队也不合并，历史百人与新三人分别显示',()=>{
    const old=Array.from({length:100},(_,i)=>`旧${i}`)
    const steps=[step('u',{type:'user_task'}),step('old',{organization:scoped('old',old)}),step('new',{organization:scoped('new',['甲','乙','丙'])})]
    expect([...teamCards(steps).values()].map(view=>view.total)).toEqual([100,3])
    expect(teamViewForStep(steps,'new')?.members.map(m=>m.name)).toEqual(['甲','乙','丙'])
  })
  it('明确续派跨用户轮次仍归原团队，使用该团队最新完整快照',()=>{
    const steps=[step('a',{organization:scoped('A',['甲'])}),step('b',{organization:scoped('B',['乙'])}),step('next',{type:'user_task'}),step('continued',{organization:scoped('A',['甲','丙'],20)})]
    expect([...teamCards(steps).keys()]).toEqual(['a','b'])
    expect(teamViewForStep(steps,'a')?.total).toBe(2)
    expect(teamViewForStep(steps,'b')?.total).toBe(1)
  })
  it('尚未生成组织快照的等待派出也按自己的归属隔离',()=>{
    const steps=[step('a',{subAgents:[{...member('甲'),teamId:'A'}]}),step('b',{subAgents:[{...member('乙'),teamId:'B'}]})]
    expect([...teamCards(steps).values()].map(view=>view.members[0].name)).toEqual(['甲','乙'])
  })
  it('旧无标识组织不会进入新团队，相同标识也不能跨原会话',()=>{
    const steps=[step('legacy',{organization:{members:[member('历史')],teams:[],total:1,live:0}}),step('a',{organization:scoped('A',['甲'])}),step('b',{sourceSessionId:'other',organization:{...scoped('A',['乙']),sessionId:'other'}})]
    expect(teamViewForStep(steps,'a')?.members.map(m=>m.name)).toEqual(['甲'])
    expect([...teamCards(steps).values()].map(view=>view.total)).toEqual([1,1,1])
  })
})
