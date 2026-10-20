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

function finishGoal(args: Record<string, unknown>, executor: ToolExecutorConfig): ToolResult {
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
    if (!reason) return deny(t('goal.tool_complete_evidence_required'))
    const result = goal.markAchieved()
    if (!result.ok) return deny(t('goal.tool_not_active'))
    persist(executor)
    executor.addStep({ type: 'proactive_notice', content: t('goal.notice_achieved'), systemInjected: true })
    return ok(t('goal.tool_marked_achieved'))
  }

  if (!reason) {
    return deny(t('goal.tool_blocked_reason_required'))
  }

  const result = goal.markBlocked()
  if (!result.ok) return deny(t('goal.tool_not_active'))
  persist(executor)
  executor.addStep({ type: 'proactive_notice', content: t('goal.notice_blocked'), systemInjected: true })
  return ok(t('goal.tool_marked_blocked', { reason }))
}

/** 更新：标终态（status + reason）和改正文（objective）二选一，不在一次调用里混着来 */
export function updateGoal(args: Record<string, unknown>, executor: ToolExecutorConfig): ToolResult {
  const hasStatus = args.status !== undefined
  const hasObjective = args.objective !== undefined
  if (hasStatus && hasObjective) return deny(t('goal.tool_update_one_thing'))
  return hasObjective ? editGoal(args, executor) : finishGoal(args, executor)
}

/** 目标工具的唯一入口：按 action 分派 */
export function goalTool(args: Record<string, unknown>, executor: ToolExecutorConfig): ToolResult {
  switch (args.action) {
    case 'get':
      return getGoal(executor)
    case 'create':
      return createGoal(args, executor)
    case 'update':
      return updateGoal(args, executor)
    default:
      return deny(t('goal.tool_action_invalid'))
  }
}

export function editGoal(args: Record<string, unknown>, executor: ToolExecutorConfig): ToolResult {
  const blocked = requireGoalSupport(executor)
  if (blocked) return deny(blocked)

  const goal = executor.getGoal?.()
  if (!goal) return deny(t('goal.tool_none'))

  if (!executor.hasUserWordsThisRun?.()) return deny(t('goal.tool_edit_needs_user'))

  const objective = typeof args.objective === 'string' ? args.objective.trim() : ''
  if (!objective) return deny(t('goal.tool_empty_objective'))
  if (objective === goal.objective) return ok(t('goal.tool_edit_unchanged'))

  const result = goal.editObjective(objective)
  if (!result.ok) {
    return deny(goal.status === 'achieved' ? t('goal.tool_edit_achieved') : t('goal.tool_edit_budget_limited'))
  }

  persist(executor)
  executor.addStep({
    type: 'proactive_notice',
    content: t('goal.notice_objective_updated', { objective: goal.objective }),
    systemInjected: true,
  })
  return ok(t('goal.tool_objective_updated', { objective: goal.objective }))
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
