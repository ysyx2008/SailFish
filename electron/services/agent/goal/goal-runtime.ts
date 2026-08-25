/**
 * 任务目标的空闲续跑：一轮结束后若还能推进，再起一轮独立 run。
 * 不包进 Agent 主循环；读目标 → 起续跑串行。
 */
import type { GoalContract as GoalSnapshot } from '@shared/types'
import { conversationPolicy } from '../../conversation/policy'
import { inferConversationKind } from '@shared/types'
import { t } from '../i18n'
import { buildBudgetWrapUpPrompt, buildContinuationPrompt } from './goal-prompts'
import type { Agent } from '../agent'
import type { AgentContext, RunOptions } from '../types'

export type GoalRunOutcome = {
  aborted: boolean
  failed: boolean
  usageLimited: boolean
  unretryable: boolean
  tokenDelta: number
  durationSeconds: number
}

export interface GoalRuntimeHost {
  persist(agent: Agent): void
  notify(agentKey: string, goal: GoalSnapshot | undefined): void
  runAgent(
    agent: Agent,
    message: string,
    context: AgentContext,
    options: RunOptions
  ): Promise<string>
}

const USAGE_MARKERS = [
  () => t('error.api_rate_limited'),
  () => t('error.api_insufficient_quota'),
]

const UNRETRYABLE_MARKERS = [
  () => t('agent.context_limit_compress_failed'),
]

export function classifyGoalError(message: string): { usageLimited: boolean; unretryable: boolean } {
  const usageLimited = USAGE_MARKERS.some(marker => message.includes(marker()))
  const unretryable = UNRETRYABLE_MARKERS.some(marker => message.includes(marker()))
  return { usageLimited, unretryable }
}

export function agentSupportsGoal(agentKey: string, kind?: import('@shared/types').ConversationKind): boolean {
  return conversationPolicy(kind ?? inferConversationKind(agentKey)).supportsGoal
}

export class GoalRuntime {
  private driving = new Set<string>()

  constructor(private readonly host: GoalRuntimeHost) {}

  onUserAbort(agentKey: string, agent: Agent): void {
    const goal = agent.getGoal()
    if (!goal || goal.status !== 'active') return
    goal.pause()
    this.host.persist(agent)
    this.host.notify(agentKey, goal.snapshot())
  }

  /**
   * 用户主动一轮结束后：记账、处理中止/错误，空闲则可续跑。
   */
  async afterUserTurn(
    agentKey: string,
    agent: Agent,
    context: AgentContext,
    runOptions: RunOptions,
    opts?: { continueIfIdle?: boolean }
  ): Promise<void> {
    if (this.driving.has(agentKey)) return
    this.driving.add(agentKey)
    try {
      const goal = agent.getGoal()
      if (!goal || !agentSupportsGoal(agentKey, agent.getConversationKind())) return

      goal.clearContinuationDeferral()
      this.applyOutcome(agentKey, agent)
      this.host.persist(agent)
      this.host.notify(agentKey, agent.getGoal()?.snapshot())

      if (opts?.continueIfIdle === false) return
      await this.continueWhileIdle(agentKey, agent, context, runOptions)
    } finally {
      this.driving.delete(agentKey)
    }
  }

  async resumeAndContinue(
    agentKey: string,
    agent: Agent,
    context: AgentContext,
    runOptions: RunOptions
  ): Promise<{ ok: boolean; error?: string }> {
    const goal = agent.getGoal()
    if (!goal) return { ok: false, error: 'no_goal' }
    const resumed = goal.resume()
    if (!resumed.ok) return { ok: false, error: resumed.error }
    this.host.persist(agent)
    this.host.notify(agentKey, goal.snapshot())

    if (agent.isRunning()) return { ok: true }
    if (this.driving.has(agentKey)) return { ok: true }

    this.driving.add(agentKey)
    try {
      await this.continueWhileIdle(agentKey, agent, context, runOptions)
      return { ok: true }
    } finally {
      this.driving.delete(agentKey)
    }
  }

  private applyOutcome(agentKey: string, agent: Agent): void {
    const goal = agent.getGoal()
    const outcome = agent.getLastRunOutcome()
    if (!goal || !outcome) return

    if (outcome.aborted) {
      if (goal.status === 'active') goal.pause()
      return
    }

    if (outcome.failed) {
      if (goal.status !== 'active') return
      if (outcome.usageLimited) {
        goal.markUsageLimited()
        return
      }
      if (outcome.unretryable) {
        goal.markBlocked()
        return
      }
      // 普通失败不自动停滞，留给下一轮或用户
      return
    }

    if (goal.status === 'active') {
      goal.accountUsage({
        expectedGoalId: goal.goalId,
        tokenDelta: outcome.tokenDelta,
        timeDeltaSeconds: outcome.durationSeconds,
      })
    }
  }

  private async continueWhileIdle(
    agentKey: string,
    agent: Agent,
    context: AgentContext,
    runOptions: RunOptions
  ): Promise<void> {
    let wrapUpDone = false

    while (true) {
      if (agent.isRunning()) return
      const goal = agent.getGoal()
      if (!goal) return

      const needsWrapUp = goal.status === 'budget_limited' && !wrapUpDone
      if (!goal.canContinue() && !needsWrapUp) return

      const prompt = needsWrapUp
        ? buildBudgetWrapUpPrompt(goal.snapshot())
        : buildContinuationPrompt(goal.snapshot())

      try {
        await this.host.runAgent(agent, prompt, context, {
          ...runOptions,
          goalContinuation: true,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        agent.recordFailedOutcome(message)
      }

      this.applyOutcome(agentKey, agent)
      if (needsWrapUp) wrapUpDone = true
      this.host.persist(agent)
      this.host.notify(agentKey, agent.getGoal()?.snapshot())

      if (needsWrapUp) return
      if (agent.getLastRunOutcome()?.aborted) return
    }
  }
}
