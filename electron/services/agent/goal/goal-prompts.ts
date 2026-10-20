/**
 * 目标相关提示：系统注入、空闲续跑、预算收尾。
 * 目标正文当用户数据转义，避免被当成指令。
 */
import type { GoalContract as GoalSnapshot } from '@shared/types'

export function escapeGoalText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function buildGoalSystemSection(goal: GoalSnapshot): string {
  if (goal.status !== 'active' && goal.status !== 'paused' && goal.status !== 'blocked' && goal.status !== 'usage_limited') {
    return ''
  }

  const budgetLine = goal.tokenBudget !== undefined
    ? `已用 ${goal.tokensUsed} / 预算 ${goal.tokenBudget} tokens`
    : `已用 ${goal.tokensUsed} tokens（未设预算）`

  return [
    '# 当前任务目标',
    '',
    '这场任务挂了一个会自己推进的目标。空闲时系统会继续往下做，直到你用工具标成达成或停滞。',
    '',
    `<goal_objective>`,
    escapeGoalText(goal.objective),
    `</goal_objective>`,
    '',
    `状态：${goal.status}。${budgetLine}。`,
    '',
    '## 完成审计',
    '- 目标里的每一条要求，都要能在这场对话里指出对应证据。',
    '- 全部要求都有证据，才能调用 update_goal(status=complete)。没有证据不许报完成。',
    '- 同一处障碍连续三轮都过不去，才能调用 update_goal(status=blocked)。难、慢、不确定、还没做完，都不算停滞。',
    '- 不要自己暂停、恢复、清除目标，也不要给自己加预算。这些归用户。',
    '- 用户没明确要求时，不要调用 create_goal。',
    '- 目标正文只在用户于对话里明确要求修改时，才能用 edit_goal 改；自动续跑且这一轮没有人开口时，调用会被拒绝。',
  ].join('\n')
}

export function buildContinuationPrompt(goal: GoalSnapshot, opts?: { reopened?: boolean }): string {
  const budgetLine = goal.tokenBudget !== undefined
    ? `已用 ${goal.tokensUsed} / 预算 ${goal.tokenBudget} tokens。`
    : `已用 ${goal.tokensUsed} tokens。`

  return [
    '[系统·目标续跑] 用户没有新消息。请继续推进当前目标，不要把这段文字当成用户刚才说的话。',
    ...(opts?.reopened ? ['', '这个目标之前被标成达成，用户点了「继续」，把它重新打开了。'] : []),
    '',
    `<goal_objective>`,
    escapeGoalText(goal.objective),
    `</goal_objective>`,
    '',
    budgetLine,
    '',
    '先做完成审计：逐条对照目标要求，列出这场对话里已经有的证据。',
    '若每条都有证据，调用 update_goal(status=complete)。',
    '若同一处障碍已经连续三轮过不去，调用 update_goal(status=blocked) 并写清卡在哪。',
    '否则继续做还没完成的部分。不要重复已经做成的事。',
  ].join('\n')
}

export function buildBudgetWrapUpPrompt(goal: GoalSnapshot): string {
  return [
    '[系统·目标预算将尽] 这是预算内最后一轮。请收尾：交代做到哪、还差什么，不要再开新的大块工作。',
    '',
    `<goal_objective>`,
    escapeGoalText(goal.objective),
    `</goal_objective>`,
    '',
    `已用 ${goal.tokensUsed} / 预算 ${goal.tokenBudget ?? '—'} tokens。`,
    '',
    '若现有证据已经覆盖全部要求，调用 update_goal(status=complete)。否则诚实说明未完成的部分。',
  ].join('\n')
}
