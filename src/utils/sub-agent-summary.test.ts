import { describe, it, expect } from 'vitest'
import type { SubAgentResult } from '@shared/types'
import { countSubAgents, describeDock, formatSubAgentSummary, sortSubAgentsByBucket, subAgentBucket } from './sub-agent-summary'

const sa = (id: string, status: SubAgentResult['status'], waitingForModel?: boolean): SubAgentResult =>
  ({ id, name: id, description: id, status, waitingForModel })

describe('伙计折叠行', () => {
  it('排队等模型的单算一堆，不算在干', () => {
    expect(subAgentBucket(sa('a', 'running', true))).toBe('waiting')
    expect(subAgentBucket(sa('a', 'running'))).toBe('running')
    expect(subAgentBucket(sa('a', 'pending'))).toBe('waiting')
  })

  it('按堆数人', () => {
    const counts = countSubAgents([
      sa('a', 'completed'), sa('b', 'completed'), sa('c', 'running'),
      sa('d', 'running', true), sa('e', 'failed'), sa('f', 'interrupted'),
    ])
    expect(counts).toEqual({ completed: 2, running: 1, waiting: 1, failed: 1, interrupted: 1 })
  })

  it('展开后还在动的排前面，同一堆保持派出先后', () => {
    const sorted = sortSubAgentsByBucket([
      sa('done1', 'completed'), sa('run1', 'running'), sa('wait1', 'running', true),
      sa('fail1', 'failed'), sa('run2', 'running'), sa('done2', 'completed'),
    ])
    expect(sorted.map(s => s.id)).toEqual(['run1', 'run2', 'wait1', 'fail1', 'done1', 'done2'])
  })
})

describe('顶部挂着那一行的标题', () => {
  // 只认键名和参数，够看出选了哪一句
  const t = (key: string, named?: Record<string, unknown>) => `${key}${named ? JSON.stringify(named) : ''}`
  const expert = (id: string, status: SubAgentResult['status']): SubAgentResult => ({ ...sa(id, status), role: '专家' })

  it('还有人在干：计数行', () => {
    const list = [sa('a', 'completed'), sa('b', 'running')]
    expect(describeDock(t, list)).toEqual({ kind: 'working', headline: formatSubAgentSummary(t, list) })
  })

  it('全做完：专家说专家、伙计说伙计', () => {
    expect(describeDock(t, [expert('a', 'completed'), expert('b', 'completed')])).toEqual({ kind: 'done', headline: 'ai.subAgentDock.allDoneExperts{"count":2}' })
    expect(describeDock(t, [sa('a', 'completed')])).toEqual({ kind: 'done', headline: 'ai.subAgentDock.allDoneAgents{"count":1}' })
  })

  it('干完但有人失败或被打断：如实用计数行，不写都干完了', () => {
    expect(describeDock(t, [sa('a', 'completed'), sa('b', 'failed')])).toMatchObject({ kind: 'problem' })
    expect(describeDock(t, [sa('a', 'completed'), sa('b', 'failed')]).headline).toContain('ai.subAgentSummary')
    expect(describeDock(t, [expert('a', 'interrupted')]).headline).toContain('ai.expertSummary')
  })
})
