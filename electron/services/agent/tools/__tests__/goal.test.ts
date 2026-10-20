import { describe, expect, it } from 'vitest'
import { GoalContract } from '../../goal/goal-contract'
import { createGoal, getGoal, updateGoal } from '../goal'
import type { ToolExecutorConfig } from '../types'

function mockExecutor(opts?: { goal?: GoalContract; supports?: boolean }): ToolExecutorConfig & { notices: Array<Record<string, unknown>> } {
  let goal = opts?.goal
  const notices: Array<Record<string, unknown>> = []
  return {
    supportsGoal: () => opts?.supports !== false,
    getGoal: () => goal,
    setGoal: (next) => { goal = next },
    persistGoal: () => {},
    notifyGoalChanged: () => {},
    addStep: (step) => {
      notices.push(step)
      return { id: 'notice', type: 'proactive_notice', content: '', timestamp: 0, ...step }
    },
    notices,
  } as ToolExecutorConfig & { notices: Array<Record<string, unknown>> }
}

describe('goal tools', () => {
  it('get_goal reports none', () => {
    const result = getGoal(mockExecutor())
    expect(result.success).toBe(true)
    expect(result.output).toContain('没有目标')
  })

  it('create_goal then get_goal', () => {
    const executor = mockExecutor()
    const created = createGoal({ objective: '把测试跑绿' }, executor)
    expect(created.success).toBe(true)
    const viewed = getGoal(executor)
    expect(viewed.output).toContain('把测试跑绿')
    expect(viewed.output).toContain('active')
  })

  it('refuses a second unfinished goal', () => {
    const executor = mockExecutor({ goal: GoalContract.start('旧目标') as GoalContract })
    const result = createGoal({ objective: '新目标' }, executor)
    expect(result.success).toBe(false)
  })

  it('update_goal complete needs evidence', () => {
    const executor = mockExecutor({ goal: GoalContract.start('做完') as GoalContract })
    expect(updateGoal({ status: 'complete' }, executor).success).toBe(false)
    const result = updateGoal({ status: 'complete', reason: '测试已绿，见 vitest 输出' }, executor)
    expect(result.success).toBe(true)
    expect(executor.getGoal?.()?.status).toBe('achieved')
    expect(executor.notices[0]?.systemInjected).toBe(true)
  })

  it('update_goal blocked needs a reason', () => {
    const executor = mockExecutor({ goal: GoalContract.start('做完') as GoalContract })
    expect(updateGoal({ status: 'blocked' }, executor).success).toBe(false)
    const result = updateGoal({ status: 'blocked', reason: '同一处连续三轮过不去' }, executor)
    expect(result.success).toBe(true)
    expect(executor.getGoal?.()?.status).toBe('blocked')
    expect(executor.notices[0]?.systemInjected).toBe(true)
  })

  it('refuses on conversations that cannot have a goal', () => {
    const executor = mockExecutor({ supports: false })
    expect(createGoal({ objective: 'x' }, executor).success).toBe(false)
  })
})
