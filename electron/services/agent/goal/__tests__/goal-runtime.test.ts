import { describe, expect, it } from 'vitest'
import { agentSupportsGoal, classifyGoalError } from '../goal-runtime'
import { t } from '../../i18n'

describe('classifyGoalError', () => {
  it('detects rate limits as usage limited', () => {
    const result = classifyGoalError(t('error.api_rate_limited'))
    expect(result.usageLimited).toBe(true)
    expect(result.unretryable).toBe(false)
  })

  it('detects compress failure as unretryable', () => {
    const result = classifyGoalError(t('agent.context_limit_compress_failed'))
    expect(result.unretryable).toBe(true)
  })

  it('leaves ordinary errors unclassified', () => {
    expect(classifyGoalError('network timeout')).toEqual({
      usageLimited: false,
      unretryable: false,
    })
  })
})

describe('agentSupportsGoal', () => {
  it('is true for ordinary task keys', () => {
    expect(agentSupportsGoal('tab-1')).toBe(true)
  })

  it('is false for companion / watch / wakeup', () => {
    expect(agentSupportsGoal('__companion__')).toBe(false)
    expect(agentSupportsGoal('__wakeup__')).toBe(false)
    expect(agentSupportsGoal('__watch__:abc')).toBe(false)
  })
})
