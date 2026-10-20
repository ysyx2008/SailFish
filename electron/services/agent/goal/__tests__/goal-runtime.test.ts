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

describe('GoalRuntime 点继续时对话开头的小字说明', () => {
  function runWith(goal: GoalContract, rounds: number) {
    const notices: Array<string | undefined> = []
    const agent = {
      getGoal: () => goal,
      getConversationKind: () => 'task',
      getLastRunOutcome: () => ({ aborted: false, failed: false, usageLimited: false, unretryable: false, tokenDelta: 0, durationSeconds: 0 }),
      appendGoalNotice: () => {},
      hasQueuedUserInput: () => false,
      isRunning: () => false,
    } as unknown as Agent
    const runtime = new GoalRuntime({
      persist: () => {},
      notify: () => {},
      runAgent: async (_agent, _message, _context, options) => {
        notices.push(options.openingNotice)
        if (notices.length >= rounds) goal.markAchieved()
        return ''
      },
    })
    return { runtime, agent, notices }
  }

  it('暂停的目标点继续：第一轮开头说「已继续推进目标」，后面自己续的几轮不再说', async () => {
    const goal = startGoal()
    goal.pause()
    const { runtime, agent, notices } = runWith(goal, 3)

    await runtime.resumeAndContinue('tab-1', agent, {} as AgentContext, {})

    expect(notices).toEqual([t('goal.notice_resumed'), undefined, undefined])
  })

  it('已达成的目标点继续：说「已重新打开目标」，不是「已继续推进」', async () => {
    const goal = startGoal()
    goal.markAchieved()
    const { runtime, agent, notices } = runWith(goal, 1)

    await runtime.resumeAndContinue('tab-1', agent, {} as AgentContext, {})

    expect(notices).toEqual([t('goal.notice_reopened')])
    expect(notices[0]).not.toBe(t('goal.notice_resumed'))
  })

  it('用户自己发一句话引出的续跑，没有这行说明', async () => {
    const goal = startGoal()
    const { runtime, agent, notices } = runWith(goal, 2)

    await runtime.afterUserTurn('tab-1', agent, {} as AgentContext, {})

    expect(notices).toEqual([undefined, undefined])
  })

  it('点继续时有人正在说话、第一轮没跑成：这行说明留到真正发出的那一轮', async () => {
    const goal = startGoal()
    goal.pause()
    const notices: Array<string | undefined> = []
    let queued = true
    const agent = {
      getGoal: () => goal,
      getConversationKind: () => 'task',
      getLastRunOutcome: () => ({ aborted: false, failed: false, usageLimited: false, unretryable: false, tokenDelta: 0, durationSeconds: 0 }),
      appendGoalNotice: () => {},
      hasQueuedUserInput: () => queued,
      isRunning: () => false,
    } as unknown as Agent
    const runtime = new GoalRuntime({
      persist: () => {},
      notify: () => {},
      runAgent: async (_agent, _message, _context, options) => {
        notices.push(options.openingNotice)
        goal.markAchieved()
        return ''
      },
    })

    await runtime.resumeAndContinue('tab-1', agent, {} as AgentContext, {})
    expect(notices).toHaveLength(0)

    queued = false
    await runtime.afterUserTurn('tab-1', agent, {} as AgentContext, {})
    expect(notices).toEqual([t('goal.notice_resumed')])
  })
})

describe('GoalRuntime 重新打开已达成的目标', () => {
  function reopenWith(goal: GoalContract, rounds: number) {
    const prompts: string[] = []
    const outcome: AgentRunOutcome = {
      aborted: false,
      failed: false,
      usageLimited: false,
      unretryable: false,
      tokenDelta: 0,
      durationSeconds: 0,
    }
    const agent = {
      getGoal: () => goal,
      getConversationKind: () => 'task',
      getLastRunOutcome: () => ({ ...outcome }),
      appendGoalNotice: () => {},
      hasQueuedUserInput: () => false,
      isRunning: () => false,
    } as unknown as Agent
    const runtime = new GoalRuntime({
      persist: () => {},
      notify: () => {},
      runAgent: async (_agent, message) => {
        prompts.push(message)
        if (prompts.length >= rounds) goal.markAchieved()
        return ''
      },
    })
    return { runtime, agent, prompts }
  }

  it('点继续：同一个目标回到推进中，第一轮被告知是重新打开的，用量保留', async () => {
    const goal = startGoal('全面测试goal功能')
    goal.accountUsage({ expectedGoalId: goal.goalId, tokenDelta: 4_000, timeDeltaSeconds: 30 })
    goal.markAchieved()
    const { runtime, agent, prompts } = reopenWith(goal, 1)

    const result = await runtime.resumeAndContinue('tab-1', agent, {} as AgentContext, {})

    expect(result.ok).toBe(true)
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('重新打开')
    expect(prompts[0]).toContain('全面测试goal功能')
    expect(goal.tokensUsed).toBe(4_000)
  })

  it('点继续时带的界面回调，每一轮续跑都原样用上（重启后点开的历史会话没有上一轮留下的回调）', async () => {
    const goal = startGoal()
    goal.markAchieved()
    const seen: Array<unknown> = []
    const agent = {
      getGoal: () => goal,
      getConversationKind: () => 'task',
      getLastRunOutcome: () => ({ aborted: false, failed: false, usageLimited: false, unretryable: false, tokenDelta: 0, durationSeconds: 0 }),
      appendGoalNotice: () => {},
      hasQueuedUserInput: () => false,
      isRunning: () => false,
    } as unknown as Agent
    let rounds = 0
    const runtime = new GoalRuntime({
      persist: () => {},
      notify: () => {},
      runAgent: async (_agent, _message, _context, options) => {
        seen.push(options.callbacks)
        if (++rounds >= 2) goal.markAchieved()
        return ''
      },
    })
    const callbacks = { onStep: () => {} }

    await runtime.resumeAndContinue('tab-1', agent, {} as AgentContext, { callbacks })

    expect(seen).toEqual([callbacks, callbacks])
  })

  it('只有紧接着那一轮提重新打开，之后的续跑回到平常的说法', async () => {
    const goal = startGoal()
    goal.markAchieved()
    const { runtime, agent, prompts } = reopenWith(goal, 2)

    await runtime.resumeAndContinue('tab-1', agent, {} as AgentContext, {})

    expect(prompts).toHaveLength(2)
    expect(prompts[0]).toContain('重新打开')
    expect(prompts[1]).not.toContain('重新打开')
  })

  it('点继续时有人正在说话、第一轮没跑成：重新打开的提示留到真正发出的那一轮', async () => {
    const goal = startGoal()
    goal.markAchieved()
    const prompts: string[] = []
    let queued = true
    const agent = {
      getGoal: () => goal,
      getConversationKind: () => 'task',
      getLastRunOutcome: () => ({ aborted: false, failed: false, usageLimited: false, unretryable: false, tokenDelta: 0, durationSeconds: 0 }),
      appendGoalNotice: () => {},
      hasQueuedUserInput: () => queued,
      isRunning: () => false,
    } as unknown as Agent
    const runtime = new GoalRuntime({
      persist: () => {},
      notify: () => {},
      runAgent: async (_agent, message) => {
        prompts.push(message)
        goal.markAchieved()
        return ''
      },
    })

    await runtime.resumeAndContinue('tab-1', agent, {} as AgentContext, {})
    expect(prompts).toHaveLength(0)
    expect(goal.status).toBe('active')

    queued = false
    await runtime.afterUserTurn('tab-1', agent, {} as AgentContext, {})
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('重新打开')
  })

  it('分叉出来的目标点继续：用户亲手点的，盖过「先别自己跑」', async () => {
    const goal = startGoal()
    goal.markAchieved()
    goal.deferContinuation()
    const { runtime, agent, prompts } = reopenWith(goal, 1)

    await runtime.resumeAndContinue('tab-1', agent, {} as AgentContext, {})

    expect(prompts).toHaveLength(1)
    expect(goal.continuationDeferred).toBe(false)
  })

  it('预算已经花完的已达成目标点继续：拒绝，不再跑一轮', async () => {
    const goal = startGoal('活', 100)
    goal.markAchieved()
    goal.accountUsage({ expectedGoalId: goal.goalId, tokenDelta: 150, timeDeltaSeconds: 1 })
    const { runtime, agent, prompts } = reopenWith(goal, 1)

    const result = await runtime.resumeAndContinue('tab-1', agent, {} as AgentContext, {})

    expect(result).toEqual({ ok: false, error: 'budget_exhausted' })
    expect(prompts).toHaveLength(0)
    expect(goal.status).toBe('achieved')
  })

  it('从暂停点继续，不提重新打开', async () => {
    const goal = startGoal()
    goal.pause()
    const { runtime, agent, prompts } = reopenWith(goal, 1)

    await runtime.resumeAndContinue('tab-1', agent, {} as AgentContext, {})

    expect(prompts[0]).not.toContain('重新打开')
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
