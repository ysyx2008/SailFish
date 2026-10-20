import { describe, expect, it } from 'vitest'
import { formatCompactTokens, formatExactTokens, formatGoalElapsed, formatGoalTokenUsage } from '../format'

describe('formatGoalElapsed', () => {
  it('keeps seconds under a minute', () => {
    expect(formatGoalElapsed(0)).toBe('0s')
    expect(formatGoalElapsed(59)).toBe('59s')
  })

  it('switches to minutes then hours', () => {
    expect(formatGoalElapsed(60)).toBe('1m')
    expect(formatGoalElapsed(656)).toBe('10m 56s')
    expect(formatGoalElapsed(90 * 60)).toBe('1h 30m')
    expect(formatGoalElapsed(2 * 60 * 60)).toBe('2h')
  })
})

describe('formatCompactTokens', () => {
  it('keeps small numbers, compactes thousands', () => {
    expect(formatCompactTokens(999)).toBe('999')
    expect(formatCompactTokens(12_500)).toBe('12.5K')
    expect(formatCompactTokens(50_000)).toBe('50K')
    expect(formatCompactTokens(63_876)).toBe('63.9K')
  })

  it('接近一百万时不写「1000K」', () => {
    expect(formatCompactTokens(999_949)).toBe('999.9K')
    expect(formatCompactTokens(999_950)).toBe('1M')
    expect(formatCompactTokens(1_000_000)).toBe('1M')
    expect(formatCompactTokens(1_912_345)).toBe('1.9M')
  })
})

describe('formatGoalTokenUsage', () => {
  it('hides zero spend unless a budget is set', () => {
    expect(formatGoalTokenUsage({ tokensUsed: 0 })).toBe('')
    expect(formatGoalTokenUsage({ tokensUsed: 0, tokenBudget: 50_000 })).toBe('0 / 50K')
    expect(formatGoalTokenUsage({ tokensUsed: 12_500 })).toBe('12.5K')
  })

  it('shows spend next to the budget', () => {
    expect(formatGoalTokenUsage({ tokensUsed: 12_500, tokenBudget: 50_000 })).toBe('12.5K / 50K')
  })
})

describe('formatExactTokens', () => {
  it('writes the whole number with thousands separators', () => {
    expect(formatExactTokens(1_912_345)).toBe('1,912,345')
    expect(formatExactTokens(0)).toBe('0')
    expect(formatExactTokens(-5)).toBe('0')
  })
})
