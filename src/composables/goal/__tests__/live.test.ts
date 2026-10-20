import { describe, expect, it } from 'vitest'
import { liveGoalOf, liveGoalOfAny, liveGoalOrSeed, liveRevealTick, rememberLiveGoal, rememberLiveGoalFor, revealLiveGoal } from '../live'

const sample = {
  goalId: 'g1',
  objective: '把测试跑绿',
  status: 'active' as const,
  tokensUsed: 0,
  timeUsedSeconds: 0,
  createdAt: 1,
  updatedAt: 1,
}

describe('live goal cache', () => {
  it('remembers and clears by agent key', () => {
    rememberLiveGoal('tab-1', sample)
    expect(liveGoalOf('tab-1')?.objective).toBe('把测试跑绿')
    rememberLiveGoal('tab-1', null)
    expect(liveGoalOf('tab-1')).toBeUndefined()
  })

  it('shares one goal across tab id and assistant id', () => {
    rememberLiveGoalFor(['tab-9', 'assistant-tab-9'], sample)
    expect(liveGoalOfAny(['tab-9'])?.objective).toBe('把测试跑绿')
    expect(liveGoalOfAny(['assistant-tab-9'])?.objective).toBe('把测试跑绿')
  })

  it('explicit clear wins over a leftover seed', () => {
    rememberLiveGoalFor(['tab-3', 'assistant-tab-3'], sample)
    rememberLiveGoalFor(['tab-3', 'assistant-tab-3'], null)
    expect(liveGoalOrSeed(['tab-3', 'assistant-tab-3'], sample)).toBeUndefined()
  })

  it('bumps reveal tick for the same key', () => {
    const before = liveRevealTick('tab-2')
    revealLiveGoal('tab-2')
    expect(liveRevealTick('tab-2')).toBe(before + 1)
  })
})
