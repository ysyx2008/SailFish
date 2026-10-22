import { describe, it, expect } from 'vitest'
import { EXPERT_TEAM_LEADER, type ExpertTeamMessageView, type SubAgentResult } from '@shared/types'
import { avatarHue, avatarInitial, continuesPrevious, latestPreview, memberLabel, MESSAGE_GROUP_GAP_MS } from './expert-team-view'

const agents: SubAgentResult[] = [
  { id: '写需求', name: '写需求', role: '产品专家', description: '', status: 'completed' },
  { id: '写代码', name: '写代码', role: '开发专家', description: '', status: 'running' },
]
const labels = { leader: 'Lead' }
const msg = (from: string, to: string[], text: string): ExpertTeamMessageView => ({ seq: 1, from, to, text, at: 0 })

describe('专家团群聊的显示', () => {
  it('名字前带角色，组长换成界面语言里的叫法，不认识的名字原样', () => {
    expect(memberLabel('写需求', agents, labels)).toBe('产品专家·写需求')
    expect(memberLabel(EXPERT_TEAM_LEADER, agents, labels)).toBe('Lead')
    expect(memberLabel('别人', agents, labels)).toBe('别人')
  })

  it('小卡片只取最新一条，正文压成一行并截短', () => {
    expect(latestPreview([], labels)).toBeNull()
    const preview = latestPreview([msg('写需求', ['写代码'], '旧的'), msg('写代码', [EXPERT_TEAM_LEADER], '第一行\n第二行  ' + 'a'.repeat(100))], labels, 10)
    expect(preview).toEqual({ sender: '写代码', text: '第一行 第二行 aa…' })
    expect(latestPreview([msg(EXPERT_TEAM_LEADER, ['写代码'], '收到')], labels)?.sender).toBe('Lead')
  })
})

describe('群聊里的头像和分组', () => {
  it('头像颜色只由名字定，首字取名字的第一个字（含不在基本平面的字）', () => {
    expect(avatarHue('写代码')).toBe(avatarHue('写代码'))
    expect(avatarHue('写代码')).toBeGreaterThanOrEqual(0)
    expect(avatarHue('写代码')).toBeLessThan(360)
    expect(avatarHue('写代码')).not.toBe(avatarHue('做测试'))
    expect(avatarHue(' 写代码 ')).toBe(avatarHue('写代码'))
    expect(avatarInitial(' 写代码')).toBe('写')
    expect(avatarInitial('𠮷野')).toBe('𠮷')
    expect(avatarInitial('')).toBe('?')
  })

  it('同一个人隔得不久接着说算一组；换人、隔太久、时间倒着走都不算', () => {
    const at = (from: string, ms: number): ExpertTeamMessageView => ({ seq: 1, from, to: [], text: 'x', at: ms })
    expect(continuesPrevious(undefined, at('a', 0))).toBe(false)
    expect(continuesPrevious(at('a', 0), at('a', MESSAGE_GROUP_GAP_MS))).toBe(true)
    expect(continuesPrevious(at('a', 0), at('a', MESSAGE_GROUP_GAP_MS + 1))).toBe(false)
    expect(continuesPrevious(at('a', 0), at('b', 1000))).toBe(false)
    expect(continuesPrevious(at('a', 5000), at('a', 1000))).toBe(false)
  })
})
