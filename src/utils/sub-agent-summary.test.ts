import { describe, it, expect } from 'vitest'
import type { SubAgentResult } from '@shared/types'
import { countSubAgents, sortSubAgentsByBucket, subAgentBucket } from './sub-agent-summary'

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
