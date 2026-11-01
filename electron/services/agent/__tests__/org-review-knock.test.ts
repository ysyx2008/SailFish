/**
 * 组长向上交差时，敲门的文本带上他名下各团的验收结论。
 */
import { describe, expect, it } from 'vitest'
import type { ChildSnapshot } from '../sub-agent-roster'
import { formatKnock, leadReviewLines, type LeadReviewTeam } from '../tools/sub-agent'

const team = (name: string, owner: string, review: LeadReviewTeam['review'], reviewers?: string[]): LeadReviewTeam => ({
  name, owner, review, ...(reviewers ? { reviewers } : {}),
})

const leader = (name: string, status: ChildSnapshot['status'] = 'completed'): ChildSnapshot => ({
  name,
  description: `${name}做的事`,
  prompt: '干活',
  role: '研发组长',
  lead: true,
  status,
  ...(status === 'completed' ? { result: '都做完了' } : {}),
  steps: [],
})

describe('组长交差带验收结论', () => {
  it('只写这位组长名下的团，每个团一行', () => {
    const lines = leadReviewLines([
      team('研发团', '研发组长', 'pass', ['安全复核']),
      team('运营团', '运营组长', 'reject', ['内容审核']),
      team('无验收团', '研发组长', 'none'),
    ], '研发组长')
    expect(lines).toHaveLength(2)
    expect(lines.join('\n')).toContain('研发团')
    expect(lines.join('\n')).toContain('通过')
    expect(lines.join('\n')).toContain('没有验收人')
    expect(lines.join('\n')).not.toContain('运营团')
  })

  it('没有组长名 / 没有名下的团时不写', () => {
    expect(leadReviewLines([team('研发团', '研发组长', 'pass')], undefined)).toEqual([])
    expect(leadReviewLines([team('运营团', '运营组长', 'pass')], '研发组长')).toEqual([])
  })

  it('敲门文本里附上名下团的结论', () => {
    const text = formatKnock(leader('研发组长'), [team('研发团', '研发组长', 'pass', ['安全复核'])])
    expect(text).toContain('都做完了')
    expect(text).toContain('研发团')
    expect(text).toContain('通过')
    expect(text).toContain('安全复核')
  })

  it('普通伙计和没有团时不加这一段', () => {
    const text = formatKnock(leader('研发组长'), [team('运营团', '运营组长', 'pass')])
    expect(text).not.toContain('验收')
  })
})
