import { describe, it, expect } from 'vitest'
import type { OrganizationMemberView, OrganizationView, SubAgentResult } from '@shared/types'
import { settleOrphanedSubAgents } from './sub-agent-settle'

const sa = (id: string, status: SubAgentResult['status'], extra: Partial<SubAgentResult> = {}): SubAgentResult =>
  ({ id, name: id, description: id, status, ...extra })
const step = (id: string, ...list: SubAgentResult[]) => ({ id, subAgents: list })
const member = (id: string, status: OrganizationMemberView['status'], extra: Partial<OrganizationMemberView> = {}): OrganizationMemberView =>
  ({ id, name: id, description: id, status, ...extra })
const org = (members: OrganizationMemberView[], live: number): OrganizationView =>
  ({ members, teams: [], live, total: members.length })

describe('读回旧会话时收拾残留的伙计', () => {
  it('停在排队 / 在干 / 等模型的，改成已打断；已有结论的不动', () => {
    const [out] = settleOrphanedSubAgents([
      step('d', sa('a', 'running'), sa('b', 'pending'), sa('c', 'running', { waitingForModel: true }),
        sa('ok', 'completed', { result: 'r' }), sa('bad', 'failed', { error: 'e' }), sa('stop', 'interrupted')),
    ])
    expect(out.subAgents.map(s => s.status)).toEqual(['interrupted', 'interrupted', 'interrupted', 'completed', 'failed', 'interrupted'])
    expect(out.subAgents[2].waitingForModel).toBeUndefined()
    expect(out.subAgents[3].result).toBe('r')
    expect(out.subAgents[4].error).toBe('e')
  })

  it('没有要改的步骤原样返回，不复制', () => {
    const plain: { id: string; subAgents?: SubAgentResult[] } = { id: 'p' }
    const done = step('d', sa('a', 'completed'))
    const out = settleOrphanedSubAgents([plain, done])
    expect(out[0]).toBe(plain)
    expect(out[1]).toBe(done)
  })

  it('不改传进来的数据', () => {
    const running = step('d', sa('a', 'running'))
    settleOrphanedSubAgents([running])
    expect(running.subAgents[0].status).toBe('running')
  })

  it('组织快照里的在干也结算，没做完人数一起减', () => {
    const running = member('a', 'running')
    const [out] = settleOrphanedSubAgents([{
      id: 'd',
      organization: org([running, member('b', 'completed'), member('c', 'pending', { waitingForModel: true })], 2),
    }])
    expect(out.organization!.members.map(m => m.status)).toEqual(['interrupted', 'completed', 'interrupted'])
    expect(out.organization!.members[2].waitingForModel).toBeUndefined()
    expect(out.organization!.live).toBe(0)
    expect(out.organization!.problems).toBe(2)
    expect(running.status).toBe('running')
  })

  it('组织里的人都停下来了，原样返回', () => {
    const settled = { id: 'd', organization: org([member('a', 'completed')], 0) }
    const [out] = settleOrphanedSubAgents([settled])
    expect(out).toBe(settled)
  })
})
