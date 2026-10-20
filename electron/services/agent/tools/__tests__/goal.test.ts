import { describe, expect, it } from 'vitest'
import { GoalContract } from '../../goal/goal-contract'
import { createGoal, editGoal, getGoal, updateGoal } from '../goal'
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
      return { id: 'notice', timestamp: 0, ...step } as ReturnType<NonNullable<ToolExecutorConfig['addStep']>>
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

  describe('edit_goal', () => {
    const withUserWords = (executor: ReturnType<typeof mockExecutor>, heard: boolean) => {
      executor.hasUserWordsThisRun = () => heard
      return executor
    }

    it('用户开口的这一轮可以改写：同一个目标，用量不变，会话里留一句', () => {
      const goal = GoalContract.start('把测试跑绿') as GoalContract
      goal.accountUsage({ expectedGoalId: goal.goalId, tokenDelta: 300, timeDeltaSeconds: 20 })
      const executor = withUserWords(mockExecutor({ goal }), true)

      const result = editGoal({ objective: '  把测试跑绿，并补上缺的用例  ' }, executor)

      expect(result.success).toBe(true)
      expect(goal.objective).toBe('把测试跑绿，并补上缺的用例')
      expect(goal.status).toBe('active')
      expect(goal.tokensUsed).toBe(300)
      expect(executor.notices).toHaveLength(1)
      expect(executor.notices[0]?.type).toBe('proactive_notice')
      expect(String(executor.notices[0]?.content)).toContain('把测试跑绿，并补上缺的用例')
      expect(executor.notices[0]?.systemInjected).toBe(true)
    })

    it('没人说话的自动续跑里被拒绝，目标不变', () => {
      const goal = GoalContract.start('把测试跑绿') as GoalContract
      const executor = withUserWords(mockExecutor({ goal }), false)

      const result = editGoal({ objective: '换个容易做的' }, executor)

      expect(result.success).toBe(false)
      expect(goal.objective).toBe('把测试跑绿')
      expect(executor.notices).toHaveLength(0)
    })

    it('拿不到「是否有人说话」时按没人说话处理', () => {
      const goal = GoalContract.start('把测试跑绿') as GoalContract
      const executor = mockExecutor({ goal })

      expect(editGoal({ objective: '换个容易做的' }, executor).success).toBe(false)
      expect(goal.objective).toBe('把测试跑绿')
    })

    it('已达成、预算用尽的目标不能改', () => {
      const achieved = GoalContract.start('做完') as GoalContract
      achieved.markAchieved()
      const budgeted = GoalContract.start('做完', { tokenBudget: 10 }) as GoalContract
      budgeted.accountUsage({ expectedGoalId: budgeted.goalId, tokenDelta: 10, timeDeltaSeconds: 1 })

      for (const goal of [achieved, budgeted]) {
        const executor = withUserWords(mockExecutor({ goal }), true)
        expect(editGoal({ objective: '别的' }, executor).success).toBe(false)
        expect(goal.objective).toBe('做完')
      }
    })

    it('暂停、停滞的目标可以改，状态不变', () => {
      const goal = GoalContract.start('做完') as GoalContract
      goal.pause()
      const executor = withUserWords(mockExecutor({ goal }), true)

      expect(editGoal({ objective: '做完，并写文档' }, executor).success).toBe(true)
      expect(goal.status).toBe('paused')
      expect(goal.objective).toBe('做完，并写文档')
    })

    it('空正文被拒绝；正文没变就不留痕', () => {
      const goal = GoalContract.start('做完') as GoalContract
      const executor = withUserWords(mockExecutor({ goal }), true)

      expect(editGoal({ objective: '   ' }, executor).success).toBe(false)
      expect(editGoal({}, executor).success).toBe(false)
      expect(editGoal({ objective: '做完' }, executor).success).toBe(true)
      expect(executor.notices).toHaveLength(0)
    })

    it('没有目标、或这场对话不能挂目标时被拒绝', () => {
      expect(editGoal({ objective: 'x' }, withUserWords(mockExecutor(), true)).success).toBe(false)
      expect(editGoal({ objective: 'x' }, withUserWords(mockExecutor({ supports: false }), true)).success).toBe(false)
    })
  })
})
