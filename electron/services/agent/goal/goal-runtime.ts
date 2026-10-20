/**
 * 任务目标的空闲续跑：一轮结束后若还能推进，再起一轮独立 run。
 * 不包进 Agent 主循环；读目标 → 起续跑串行。
 */
import type { GoalContract as GoalSnapshot } from '@shared/types'
import { conversationPolicy } from '../../conversation/policy'
import { inferConversationKind } from '@shared/types'
import { t, type TranslationKey } from '../i18n'
import { buildBudgetWrapUpPrompt, buildContinuationPrompt } from './goal-prompts'
import type { Agent } from '../agent'
import type { AgentContext, AgentRunOutcome, RunOptions } from '../types'

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
  /** 已经算过账的那一轮：外层出错后又走一遍收尾时，同一轮不记第二次 */
  private readonly settled = new WeakSet<AgentRunOutcome>()
  /** 用户刚点了继续、还没来得及发出第一轮：agentKey → 哪个目标、是不是从已达成重新打开的 */
  private readonly pendingResume = new Map<string, { goalId: string; reopened: boolean }>()

  constructor(private readonly host: GoalRuntimeHost) {}

  onUserAbort(agentKey: string, agent: Agent): void {
    const goal = agent.getGoal()
    if (!goal || goal.status !== 'active') return
    goal.pause()
    agent.appendGoalNotice(t('goal.notice_paused'))
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
      if (agent.hasQueuedUserInput()) return
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
    const reopened = goal.status === 'achieved'
    const resumed = goal.resume()
    if (!resumed.ok) return { ok: false, error: resumed.error }
    // 用户亲手点的继续，盖过「分叉后先别自己跑」
    goal.clearContinuationDeferral()
    this.pendingResume.set(agentKey, { goalId: goal.goalId, reopened })
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
    if (this.settled.has(outcome)) return
    this.settled.add(outcome)
    const prev = goal.status

    // 这一轮花的先记账：不论它怎么收的场（达成、被按停、出错），都是为这个目标花的
    if (outcome.goalId) {
      goal.accountUsage({
        expectedGoalId: outcome.goalId,
        tokenDelta: outcome.tokenDelta,
        timeDeltaSeconds: outcome.durationSeconds,
      })
    }

    if (outcome.aborted) {
      if (goal.status === 'active') goal.pause()
    } else if (outcome.failed && goal.status === 'active') {
      if (outcome.usageLimited) {
        goal.markUsageLimited()
      } else if (outcome.unretryable) {
        goal.markBlocked()
      }
    }
    this.announceStatusChange(agent, prev, goal.status)
  }

  private announceStatusChange(agent: Agent, prev: GoalSnapshot['status'], next: GoalSnapshot['status']): void {
    if (prev === next) return
    const notices: Partial<Record<GoalSnapshot['status'], TranslationKey>> = {
      paused: 'goal.notice_paused',
      blocked: 'goal.notice_blocked',
      usage_limited: 'goal.notice_usage_limited',
      budget_limited: 'goal.notice_budget_limited',
      achieved: 'goal.notice_achieved',
    }
    const key = notices[next]
    if (key) agent.appendGoalNotice(t(key))
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
      if (agent.hasQueuedUserInput()) return
      const goal = agent.getGoal()
      if (!goal) return

      const needsWrapUp = goal.status === 'budget_limited' && !wrapUpDone
      if (!goal.canContinue() && !needsWrapUp) return

      // 点继续的说明（给模型的提示、给用户的一行小字）只给真正发出去的第一轮；
      // 那一轮没跑成（有人插话、被占用）就留到下一次
      const pending = this.pendingResume.get(agentKey)
      const resume = pending?.goalId === goal.goalId && !needsWrapUp ? pending : undefined
      const prompt = needsWrapUp
        ? buildBudgetWrapUpPrompt(goal.snapshot())
        : buildContinuationPrompt(goal.snapshot(), { reopened: resume?.reopened === true })
      this.pendingResume.delete(agentKey)

      try {
        await this.host.runAgent(agent, prompt, context, {
          ...runOptions,
          goalContinuation: true,
          ...(resume ? { openingNotice: t(resume.reopened ? 'goal.notice_reopened' : 'goal.notice_resumed') } : {}),
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
      const outcome = agent.getLastRunOutcome()
      if (outcome?.aborted || outcome?.failed) return
    }
  }
}
