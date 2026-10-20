import type { GoalContract } from '@shared/types'

/** 清除前要不要再问一句：目标已经达成，清掉只是收起卡片，没有可惜的。 */
export function goalClearNeedsConfirm(goal?: GoalContract | null): boolean {
  return goal?.status !== 'achieved'
}

/** 挂新目标时，要不要先问「换掉原来的吗」：原来的还没做完才问。 */
export function goalReplaceNeedsConfirm(goal?: GoalContract | null): boolean {
  return !!goal && goal.status !== 'achieved' && goal.status !== 'budget_limited'
}

/** 目标用量怎么给人看：时间总在；有用量或预算才跟上 token。 */
export function formatGoalElapsed(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  const restSeconds = total % 60
  if (minutes < 60) return restSeconds === 0 ? `${minutes}m` : `${minutes}m ${restSeconds}s`
  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  if (hours >= 24) {
    const days = Math.floor(hours / 24)
    return `${days}d ${hours % 24}h ${restMinutes}m`
  }
  return restMinutes === 0 ? `${hours}h` : `${hours}h ${restMinutes}m`
}

export function formatCompactTokens(tokens: number): string {
  const n = Math.max(0, Math.floor(tokens))
  if (n < 1000) return String(n)
  const k = Math.round(n / 100) / 10
  // 四舍五入后满 1000K 的（如 999,950）按 M 写，不出现「1000K」
  if (k < 1000) return `${k}K`
  const m = Math.round(n / 100_000) / 10
  return `${m}M`
}

export function formatGoalTokenUsage(goal: {
  tokenBudget?: number
  tokensUsed: number
}): string {
  if (goal.tokenBudget !== undefined) {
    return `${formatCompactTokens(goal.tokensUsed)} / ${formatCompactTokens(goal.tokenBudget)}`
  }
  if (goal.tokensUsed > 0) return formatCompactTokens(goal.tokensUsed)
  return ''
}

/** 鼠标停上去时给的精确数字：1,912,345 */
export function formatExactTokens(tokens: number): string {
  return Math.max(0, Math.floor(tokens)).toLocaleString('en-US')
}
