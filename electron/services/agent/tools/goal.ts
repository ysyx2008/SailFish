import type { GoalContract as GoalSnapshot } from '@shared/types'
import { GoalContract } from '../goal/goal-contract'
import { t } from '../i18n'
import type { ToolExecutorConfig, ToolResult } from './types'

function deny(error: string): ToolResult {
  return { success: false, output: '', error }
}

function ok(output: string): ToolResult {
  return { success: true, output }
}

function persist(executor: ToolExecutorConfig): void {
  executor.persistGoal?.()
  executor.notifyGoalChanged?.()
}

function requireGoalSupport(executor: ToolExecutorConfig): string | null {
  if (!executor.supportsGoal?.()) {
    return t('goal.tool_not_supported')
  }
  return null
}

export function getGoal(executor: ToolExecutorConfig): ToolResult {
  const blocked = requireGoalSupport(executor)
  if (blocked) return deny(blocked)

  const goal = executor.getGoal?.()
  if (!goal) {
    return ok(t('goal.tool_none'))
  }
  return ok(formatGoalForModel(goal.snapshot()))
}

export function createGoal(args: Record<string, unknown>, executor: ToolExecutorConfig): ToolResult {
  const blocked = requireGoalSupport(executor)
  if (blocked) return deny(blocked)

  const existing = executor.getGoal?.()
  if (existing && !existing.isTerminal()) {
    return deny(t('goal.tool_already_exists'))
  }

  const objective = typeof args.objective === 'string' ? args.objective : ''
  const tokenBudget = typeof args.token_budget === 'number' ? args.token_budget : undefined
  const started = GoalContract.start(objective, tokenBudget !== undefined ? { tokenBudget } : undefined)
  if ('error' in started) {
    return deny(started.error === 'invalid_token_budget'
      ? t('goal.tool_invalid_budget')
      : t('goal.tool_empty_objective'))
  }

  executor.setGoal?.(started)
  persist(executor)
  return ok(t('goal.tool_created', { objective: started.objective }))
}

export function updateGoal(args: Record<string, unknown>, executor: ToolExecutorConfig): ToolResult {
  const blocked = requireGoalSupport(executor)
  if (blocked) return deny(blocked)

  const goal = executor.getGoal?.()
  if (!goal) return deny(t('goal.tool_none'))

  const status = args.status
  if (status !== 'complete' && status !== 'blocked') {
    return deny(t('goal.tool_update_status_invalid'))
  }

  if (goal.status !== 'active') {
    return deny(t('goal.tool_not_active'))
  }

  const reason = typeof args.reason === 'string' ? args.reason.trim() : ''

  if (status === 'complete') {
    const result = goal.markAchieved()
    if (!result.ok) return deny(t('goal.tool_not_active'))
    persist(executor)
    return ok(t('goal.tool_marked_achieved'))
  }

  if (!reason) {
    return deny(t('goal.tool_blocked_reason_required'))
  }

  const result = goal.markBlocked()
  if (!result.ok) return deny(t('goal.tool_not_active'))
  persist(executor)
  return ok(t('goal.tool_marked_blocked', { reason }))
}

export function formatGoalForModel(goal: GoalSnapshot): string {
  const budget = goal.tokenBudget !== undefined
    ? `${goal.tokensUsed}/${goal.tokenBudget}`
    : `${goal.tokensUsed}`
  return [
    `goal_id: ${goal.goalId}`,
    `status: ${goal.status}`,
    `objective: ${goal.objective}`,
    `tokens: ${budget}`,
    `time_used_seconds: ${goal.timeUsedSeconds}`,
  ].join('\n')
}
