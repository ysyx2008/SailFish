import { describe, it, expect } from 'vitest'
import { EXPERT_TEAM_LEADER, type ExpertTeamMessageView, type SubAgentResult } from '@shared/types'
import { latestPreview, memberLabel, messageRoute } from './expert-team-view'

const agents: SubAgentResult[] = [
  { id: '写需求', name: '写需求', role: '产品专家', description: '', status: 'completed' },
  { id: '写代码', name: '写代码', role: '开发专家', description: '', status: 'running' },
]
const labels = { leader: 'Lead', toNobody: '告知大家', listSeparator: ', ' }
const msg = (from: string, to: string[], text: string): ExpertTeamMessageView => ({ seq: 1, from, to, text, at: 0 })

describe('专家团群聊的显示', () => {
  it('名字前带角色，组长换成界面语言里的叫法，不认识的名字原样', () => {
    expect(memberLabel('写需求', agents, labels)).toBe('产品专家·写需求')
    expect(memberLabel(EXPERT_TEAM_LEADER, agents, labels)).toBe('Lead')
    expect(memberLabel('别人', agents, labels)).toBe('别人')
  })

  it('谁 → 谁；几个人用界面语言的分隔符；没点名写告知大家', () => {
    expect(messageRoute(msg('写需求', ['写代码', EXPERT_TEAM_LEADER], 'x'), agents, labels)).toBe('产品专家·写需求 → 开发专家·写代码, Lead')
    expect(messageRoute(msg('写代码', [], 'x'), agents, labels)).toBe('开发专家·写代码 → 告知大家')
  })

  it('小卡片只取最新一条，正文压成一行并截短', () => {
    expect(latestPreview([], agents, labels)).toBeNull()
    const preview = latestPreview([msg('写需求', ['写代码'], '旧的'), msg('写代码', [EXPERT_TEAM_LEADER], '第一行\n第二行  ' + 'a'.repeat(100))], agents, labels, 10)
    expect(preview).toEqual({ route: '开发专家·写代码 → Lead', text: '第一行 第二行 aa…' })
  })
})
