import { describe, it, expect } from 'vitest'
import type { AgentStep, SubAgentResult } from '@shared/types'
import { hasUnfinishedSubAgents, PinnedDispatchTracker } from './pinned-dispatch'

const sa = (id: string, status: SubAgentResult['status']): SubAgentResult => ({ id, name: id, description: id, status })
const dispatch = (id: string, ...status: SubAgentResult['status'][]): AgentStep =>
  ({ id, type: 'tool_call', content: id, timestamp: 0, subAgents: status.map((s, i) => sa(`${id}-${i}`, s)) }) as AgentStep
const say = (id: string, type: 'user_task' | 'user_supplement' = 'user_supplement', extra: Partial<AgentStep> = {}): AgentStep =>
  ({ id, type, content: id, timestamp: 0, ...extra }) as AgentStep
const plain = (id: string): AgentStep => ({ id, type: 'message', content: id, timestamp: 0 }) as AgentStep
const ids = (steps: AgentStep[]) => steps.map(s => s.id)

describe('挂在顶部的派出的人', () => {
  it('没有派过人就没有', () => {
    expect(new PinnedDispatchTracker().update([say('u'), plain('m')])).toEqual([])
  })

  it('还有人在干（含排队）就挂着，哪怕之后你又说过话', () => {
    const tracker = new PinnedDispatchTracker()
    expect(ids(tracker.update([say('u1', 'user_task'), dispatch('d', 'completed', 'running'), plain('m'), say('u2')]))).toEqual(['d'])
    expect(ids(new PinnedDispatchTracker().update([dispatch('q', 'pending'), say('u')]))).toEqual(['q'])
  })

  it('眼看着干完：留到你下次说话', () => {
    const tracker = new PinnedDispatchTracker()
    const before = [say('u1', 'user_task'), dispatch('d', 'running', 'running'), plain('m')]
    tracker.update(before)
    const done = [say('u1', 'user_task'), dispatch('d', 'completed', 'failed'), plain('m')]
    expect(ids(tracker.update(done))).toEqual(['d'])
    expect(ids(tracker.update([...done, plain('m2')]))).toEqual(['d'])
    expect(tracker.update([...done, say('u2')])).toEqual([])
    // 收起以后不会因为别的变化再冒出来
    expect(tracker.update([...done, say('u2'), plain('m3')])).toEqual([])
  })

  it('干活期间你插过话，干完的那一刻仍然挂着，到你再说话才收起', () => {
    const tracker = new PinnedDispatchTracker()
    tracker.update([say('u1', 'user_task'), dispatch('d', 'running')])
    tracker.update([say('u1', 'user_task'), dispatch('d', 'running'), say('u2')])
    const done = [say('u1', 'user_task'), dispatch('d', 'completed'), say('u2')]
    expect(ids(tracker.update(done))).toEqual(['d'])
    expect(tracker.update([...done, say('u3')])).toEqual([])
  })

  it('系统自己续跑（目标续跑）不算你说话', () => {
    const tracker = new PinnedDispatchTracker()
    tracker.update([dispatch('d', 'running')])
    const done = [dispatch('d', 'completed')]
    tracker.update(done)
    expect(ids(tracker.update([...done, say('goal', 'user_task', { systemInjected: true })]))).toEqual(['d'])
  })

  it('干完后被再叫起来，又挂回去；再干完再算', () => {
    const tracker = new PinnedDispatchTracker()
    tracker.update([dispatch('d', 'running')])
    expect(ids(tracker.update([dispatch('d', 'completed')]))).toEqual(['d'])
    expect(tracker.update([dispatch('d', 'completed'), say('u')])).toEqual([])
    expect(ids(tracker.update([dispatch('d', 'running'), say('u')]))).toEqual(['d'])
    expect(ids(tracker.update([dispatch('d', 'completed'), say('u')]))).toEqual(['d'])
    expect(tracker.update([dispatch('d', 'completed'), say('u'), say('u2')])).toEqual([])
  })

  it('好几批：没干完的各挂各的；干完的只留最近一批', () => {
    const tracker = new PinnedDispatchTracker()
    tracker.update([dispatch('a', 'running'), dispatch('b', 'running'), dispatch('c', 'running')])
    const steps = [dispatch('a', 'running'), dispatch('b', 'completed'), dispatch('c', 'completed')]
    expect(ids(tracker.update(steps))).toEqual(['a', 'c'])
    expect(ids(tracker.update([dispatch('a', 'completed'), dispatch('b', 'completed'), dispatch('c', 'completed')]))).toEqual(['c'])
  })

  it('一打开就是干完（或被中断）的旧事，不挂', () => {
    const tracker = new PinnedDispatchTracker()
    expect(tracker.update([say('u'), dispatch('old', 'completed', 'interrupted'), plain('m')])).toEqual([])
  })

  it('刚派出、还没人的那一步不挂', () => {
    expect(new PinnedDispatchTracker().update([dispatch('d')])).toEqual([])
    expect(hasUnfinishedSubAgents(dispatch('d', 'completed', 'interrupted').subAgents)).toBe(false)
    expect(hasUnfinishedSubAgents(undefined)).toBe(false)
  })
})
