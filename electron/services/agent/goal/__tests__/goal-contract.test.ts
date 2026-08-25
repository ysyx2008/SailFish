import { describe, expect, it } from 'vitest'
import { GoalContract, MAX_GOAL_TOKEN_BUDGET } from '../goal-contract'

describe('GoalContract', () => {
  it('start：空目标拒绝，合法目标进入推进中', () => {
    expect(GoalContract.start('   ')).toEqual({ error: 'empty_objective' })
    const started = GoalContract.start('把测试跑绿', { now: 1000 })
    expect('error' in started).toBe(false)
    if ('error' in started) return
    expect(started.status).toBe('active')
    expect(started.objective).toBe('把测试跑绿')
    expect(started.tokensUsed).toBe(0)
    expect(started.canContinue()).toBe(true)
    expect(started.snapshot().createdAt).toBe(1000)
  })

  it('start：预算必须是 1..上限 的整数', () => {
    expect(GoalContract.start('x', { tokenBudget: 0 })).toEqual({ error: 'invalid_token_budget' })
    expect(GoalContract.start('x', { tokenBudget: MAX_GOAL_TOKEN_BUDGET + 1 })).toEqual({ error: 'invalid_token_budget' })
    const started = GoalContract.start('x', { tokenBudget: 500 })
    expect('error' in started).toBe(false)
    if ('error' in started) return
    expect(started.tokenBudget).toBe(500)
  })

  it('pause / resume：只有推进中可暂停，暂停/停滞/限流可恢复', () => {
    const goal = mustStart('活')
    expect(goal.pause(2).ok).toBe(true)
    expect(goal.status).toBe('paused')
    expect(goal.canContinue()).toBe(false)
    expect(goal.pause().ok).toBe(false)

    expect(goal.resume(3).ok).toBe(true)
    expect(goal.status).toBe('active')

    expect(goal.markBlocked(4).ok).toBe(true)
    expect(goal.resume(5).ok).toBe(true)
    expect(goal.markUsageLimited(6).ok).toBe(true)
    expect(goal.resume(7).ok).toBe(true)
  })

  it('达成与预算停机是终态，不能恢复，只能重设', () => {
    const achieved = mustStart('活')
    expect(achieved.markAchieved(2).ok).toBe(true)
    expect(achieved.isTerminal()).toBe(true)
    expect(achieved.resume().ok).toBe(false)
    expect(achieved.pause().ok).toBe(false)
    expect(achieved.markBlocked().ok).toBe(false)

    const budgeted = mustStart('活', { tokenBudget: 10 })
    expect(budgeted.accountUsage({ expectedGoalId: budgeted.goalId, tokenDelta: 10, timeDeltaSeconds: 3, now: 8 }).ok).toBe(true)
    expect(budgeted.status).toBe('budget_limited')
    expect(budgeted.isTerminal()).toBe(true)
    expect(budgeted.resume().ok).toBe(false)
    expect(budgeted.replenishBudget(20, 9).ok).toBe(true)
    expect(budgeted.status).toBe('active')
    expect(budgeted.tokenBudget).toBe(20)
  })

  it('记账：goalId 对不上不改；触顶转预算停机；时间只累加', () => {
    const goal = mustStart('活', { tokenBudget: 100 })
    expect(goal.accountUsage({ expectedGoalId: 'other', tokenDelta: 50, timeDeltaSeconds: 9 }).ok).toBe(false)
    expect(goal.tokensUsed).toBe(0)

    expect(goal.accountUsage({ expectedGoalId: goal.goalId, tokenDelta: 40, timeDeltaSeconds: 12, now: 2 }).ok).toBe(true)
    expect(goal.tokensUsed).toBe(40)
    expect(goal.timeUsedSeconds).toBe(12)
    expect(goal.status).toBe('active')

    expect(goal.accountUsage({ expectedGoalId: goal.goalId, tokenDelta: 70, timeDeltaSeconds: 5, now: 3 }).ok).toBe(true)
    expect(goal.tokensUsed).toBe(110)
    expect(goal.timeUsedSeconds).toBe(17)
    expect(goal.status).toBe('budget_limited')
  })

  it('编辑目标文本不清空用量，终态不能改', () => {
    const goal = mustStart('旧目标', { tokenBudget: 80 })
    goal.accountUsage({ expectedGoalId: goal.goalId, tokenDelta: 15, timeDeltaSeconds: 2 })
    expect(goal.editObjective('  新目标  ').ok).toBe(true)
    expect(goal.objective).toBe('新目标')
    expect(goal.tokensUsed).toBe(15)
    expect(goal.goalId).toBe(goal.snapshot().goalId)

    goal.accountUsage({ expectedGoalId: goal.goalId, tokenDelta: 80, timeDeltaSeconds: 1 })
    expect(goal.editObjective('再改').ok).toBe(false)
  })

  it('fork 续跑延迟：带标记时不能自动续跑，清掉后可以', () => {
    const goal = mustStart('活')
    goal.deferContinuation()
    expect(goal.continuationDeferred).toBe(true)
    expect(goal.canContinue()).toBe(false)
    expect(goal.status).toBe('active')
    goal.clearContinuationDeferral()
    expect(goal.continuationDeferred).toBe(false)
    expect(goal.canContinue()).toBe(true)
  })

  it('fromJSON：缺字段或非法预算丢弃', () => {
    expect(GoalContract.fromJSON(null)).toBeNull()
    expect(GoalContract.fromJSON({ objective: 'x' })).toBeNull()
    const ok = mustStart('活', { tokenBudget: 30 })
    const snap = ok.snapshot()
    const restored = GoalContract.fromJSON(snap)
    expect(restored?.goalId).toBe(ok.goalId)
    expect(restored?.tokenBudget).toBe(30)
    expect(GoalContract.fromJSON({ ...snap, tokenBudget: 0 })).toBeNull()
  })
})

function mustStart(objective: string, opts?: { tokenBudget?: number }): GoalContract {
  const started = GoalContract.start(objective, { ...opts, now: 1 })
  if ('error' in started) throw new Error(started.error)
  return started
}
