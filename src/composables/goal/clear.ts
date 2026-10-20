import type { GoalContract } from '@shared/types'

/** 清除前要不要再问一句：目标已经达成，清掉只是收起卡片，没有可惜的。 */
export function goalClearNeedsConfirm(goal?: GoalContract | null): boolean {
  return goal?.status !== 'achieved'
}
