import { describe, expect, it } from 'vitest'
import { GoalRuntime, agentSupportsGoal, classifyGoalError } from '../goal-runtime'
import { GoalContract } from '../goal-contract'
import { t } from '../../i18n'
import type { Agent } from '../../agent'
import type { AgentContext, AgentRunOutcome } from '../../types'

describe('classifyGoalError', () => {
  it('detects rate limits as usage limited', () => {
    const result = classifyGoalError(t('error.api_rate_limited'))
    expect(result.usageLimited).toBe(true)
    expect(result.unretryable).toBe(false)
  })

  it('detects compress failure as unretryable', () => {
    const result = classifyGoalError(t('agent.context_limit_compress_failed'))
    expect(result.unretryable).toBe(true)
  })

  it('leaves ordinary errors unclassified', () => {
    expect(classifyGoalError('network timeout')).toEqual({
      usageLimited: false,
      unretryable: false,
    })
  })
})

function startGoal(objective = '全面测试goal功能', tokenBudget?: number): GoalContract {
  const started = GoalContract.start(objective, tokenBudget ? { tokenBudget } : undefined)
  if ('error' in started) throw new Error(started.error)
  return started
}

function settle(goal: GoalContract, outcome: Partial<AgentRunOutcome>) {
  const full: AgentRunOutcome = {
    aborted: false,
    failed: false,
    usageLimited: false,
    unretryable: false,
    tokenDelta: 0,
    durationSeconds: 0,
    ...outcome,
  }
  const notices: string[] = []
  const agent = {
    getGoal: () => goal,
    getConversationKind: () => 'task',
    getLastRunOutcome: () => full,
    appendGoalNotice: (content: string) => { notices.push(content) },
    hasQueuedUserInput: () => false,
    isRunning: () => false,
  } as unknown as Agent
  const runtime = new GoalRuntime({
    persist: () => {},
    notify: () => {},
    runAgent: async () => '',
  })
  return runtime.afterUserTurn('tab-1', agent, {} as AgentContext, {}, { continueIfIdle: false }).then(() => notices)
}

describe('GoalRuntime 一轮收场后的记账', () => {
  it('同一轮的收尾被走到两次，只记一次账', async () => {
    const goal = startGoal()
    const outcome: AgentRunOutcome = {
      aborted: false,
      failed: false,
      usageLimited: false,
      unretryable: false,
      tokenDelta: 5_000,
      durationSeconds: 12,
      goalId: goal.goalId,
    }
    const agent = {
      getGoal: () => goal,
      getConversationKind: () => 'task',
      getLastRunOutcome: () => outcome,
      appendGoalNotice: () => {},
      hasQueuedUserInput: () => false,
      isRunning: () => false,
    } as unknown as Agent
    const runtime = new GoalRuntime({ persist: () => {}, notify: () => {}, runAgent: async () => '' })
    await runtime.afterUserTurn('tab-1', agent, {} as AgentContext, {}, { continueIfIdle: false })
    await runtime.afterUserTurn('tab-1', agent, {} as AgentContext, {}, { continueIfIdle: false })
    expect(goal.tokensUsed).toBe(5_000)
    expect(goal.timeUsedSeconds).toBe(12)
  })

  it('宣布达成的那一轮也记上，状态仍是已达成', async () => {
    const goal = startGoal()
    goal.markAchieved()
    await settle(goal, { goalId: goal.goalId, tokenDelta: 470_000, durationSeconds: 61 })
    expect(goal.status).toBe('achieved')
    expect(goal.tokensUsed).toBe(470_000)
    expect(goal.timeUsedSeconds).toBe(61)
  })

  it('一场目标跨好几轮，每一轮都累加', async () => {
    const goal = startGoal()
    await settle(goal, { goalId: goal.goalId, tokenDelta: 100_000, durationSeconds: 40 })
    goal.markAchieved()
    await settle(goal, { goalId: goal.goalId, tokenDelta: 250_000, durationSeconds: 70 })
    expect(goal.tokensUsed).toBe(350_000)
    expect(goal.timeUsedSeconds).toBe(110)
  })

  it('被按停的那一轮也记上，目标转为暂停', async () => {
    const goal = startGoal()
    await settle(goal, { goalId: goal.goalId, aborted: true, tokenDelta: 30_000, durationSeconds: 9 })
    expect(goal.status).toBe('paused')
    expect(goal.tokensUsed).toBe(30_000)
  })

  it('出错的那一轮也记上；额度不够照样转为额度受限', async () => {
    const goal = startGoal()
    await settle(goal, {
      goalId: goal.goalId,
      failed: true,
      usageLimited: true,
      tokenDelta: 12_000,
      durationSeconds: 5,
    })
    expect(goal.status).toBe('usage_limited')
    expect(goal.tokensUsed).toBe(12_000)
  })

  it('这一轮触到预算上限，转为预算用尽并说一声', async () => {
    const goal = startGoal('活', 100)
    const notices = await settle(goal, { goalId: goal.goalId, tokenDelta: 120, durationSeconds: 3 })
    expect(goal.status).toBe('budget_limited')
    expect(notices).toHaveLength(1)
  })

  it('开跑时目标没在推进（暂停期间随口聊的），不算在目标头上', async () => {
    const goal = startGoal()
    goal.pause()
    await settle(goal, { tokenDelta: 80_000, durationSeconds: 20 })
    expect(goal.tokensUsed).toBe(0)
    expect(goal.timeUsedSeconds).toBe(0)
  })

  it('这一轮跑的时候目标被换成了新的，不记到新目标上', async () => {
    const replaced = startGoal('新目标')
    await settle(replaced, { goalId: 'goal-old', tokenDelta: 80_000, durationSeconds: 20 })
    expect(replaced.tokensUsed).toBe(0)
  })
})

describe('agentSupportsGoal', () => {
  it('is true for ordinary task keys', () => {
    expect(agentSupportsGoal('tab-1')).toBe(true)
  })

  it('is false for companion / watch / wakeup', () => {
    expect(agentSupportsGoal('__companion__')).toBe(false)
    expect(agentSupportsGoal('__wakeup__')).toBe(false)
    expect(agentSupportsGoal('__watch__:abc')).toBe(false)
  })
})
