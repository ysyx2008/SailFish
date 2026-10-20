import { describe, expect, it } from 'vitest'
import type { GoalContract } from '@shared/types'
import { goalClearNeedsConfirm } from '../clear'

const goalWith = (status: GoalContract['status']): GoalContract => ({ status }) as GoalContract

describe('goalClearNeedsConfirm', () => {
  it('已达成的目标直接清除，不再询问', () => {
    expect(goalClearNeedsConfirm(goalWith('achieved'))).toBe(false)
  })

  it.each(['active', 'paused', 'blocked', 'usage_limited', 'budget_limited'] as const)(
    '%s 的目标清除前仍要确认',
    (status) => {
      expect(goalClearNeedsConfirm(goalWith(status))).toBe(true)
    },
  )

  it('看不到目标时保持询问', () => {
    expect(goalClearNeedsConfirm(undefined)).toBe(true)
    expect(goalClearNeedsConfirm(null)).toBe(true)
  })
})
