/**
 * 任务会话上的目标契约：状态机 + 预算判定 + 用量结算。
 * 纯逻辑，不碰 IO / IPC。
 */
import type { GoalContract as GoalSnapshot, GoalStatus } from '@shared/types'

/** 用户可设的 token 预算上限，防手滑写出天文数字 */
export const MAX_GOAL_TOKEN_BUDGET = 10_000_000

const GOAL_STATUSES: readonly GoalStatus[] = [
  'active',
  'paused',
  'blocked',
  'usage_limited',
  'budget_limited',
  'achieved',
]

/** 已达成的也能重新打开：秘书报得太早时，用户点继续接着推 */
const RESUMABLE: ReadonlySet<GoalStatus> = new Set(['paused', 'blocked', 'usage_limited', 'achieved'])
const TERMINAL: ReadonlySet<GoalStatus> = new Set(['achieved', 'budget_limited'])

export type GoalMutationResult =
  | { ok: true }
  | { ok: false; error: string }

export class GoalContract {
  private data: GoalSnapshot

  private constructor(data: GoalSnapshot) {
    this.data = data
  }

  static start(objective: string, opts?: { tokenBudget?: number; now?: number }): GoalContract | { error: string } {
    const text = objective.trim()
    if (!text) return { error: 'empty_objective' }

    let tokenBudget: number | undefined
    if (opts?.tokenBudget !== undefined) {
      const parsed = sanitizeTokenBudget(opts.tokenBudget)
      if (parsed === null) return { error: 'invalid_token_budget' }
      tokenBudget = parsed
    }

    const now = opts?.now ?? Date.now()
    return new GoalContract({
      goalId: createGoalId(now),
      objective: text,
      status: 'active',
      ...(tokenBudget !== undefined ? { tokenBudget } : {}),
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: now,
      updatedAt: now,
    })
  }

  static fromJSON(raw: unknown): GoalContract | null {
    const snapshot = sanitizeGoalSnapshot(raw)
    return snapshot ? new GoalContract(snapshot) : null
  }

  /**
   * 从落盘的记录接回来：此刻没有任何一轮在跑（重启、重新打开历史），
   * 推进中的目标回到已暂停，等用户点继续才动。
   */
  static fromStored(raw: unknown): GoalContract | null {
    const goal = GoalContract.fromJSON(raw)
    if (goal?.status === 'active') goal.pause()
    return goal
  }

  snapshot(): GoalSnapshot {
    return { ...this.data }
  }

  get goalId(): string { return this.data.goalId }
  get objective(): string { return this.data.objective }
  get status(): GoalStatus { return this.data.status }
  get tokenBudget(): number | undefined { return this.data.tokenBudget }
  get tokensUsed(): number { return this.data.tokensUsed }
  get timeUsedSeconds(): number { return this.data.timeUsedSeconds }
  get continuationDeferred(): boolean { return this.data.continuationDeferred === true }

  isTerminal(): boolean {
    return TERMINAL.has(this.data.status)
  }

  budgetExhausted(): boolean {
    return this.data.tokenBudget !== undefined && this.data.tokensUsed >= this.data.tokenBudget
  }

  canContinue(): boolean {
    return this.data.status === 'active' && !this.continuationDeferred
  }

  pause(now = Date.now()): GoalMutationResult {
    if (this.data.status !== 'active') return { ok: false, error: 'not_active' }
    this.data = { ...this.data, status: 'paused', updatedAt: now }
    return { ok: true }
  }

  resume(now = Date.now()): GoalMutationResult {
    if (!RESUMABLE.has(this.data.status)) return { ok: false, error: 'not_resumable' }
    // 达成的那一轮是在「已达成」状态下记的账，可能已经超过预算；这时重新打开会绕过预算硬停
    if (this.data.status === 'achieved' && this.budgetExhausted()) return { ok: false, error: 'budget_exhausted' }
    this.data = { ...this.data, status: 'active', updatedAt: now }
    return { ok: true }
  }

  markAchieved(now = Date.now()): GoalMutationResult {
    if (this.data.status !== 'active') return { ok: false, error: 'not_active' }
    this.data = { ...this.data, status: 'achieved', updatedAt: now }
    return { ok: true }
  }

  markBlocked(now = Date.now()): GoalMutationResult {
    if (this.data.status !== 'active') return { ok: false, error: 'not_active' }
    this.data = { ...this.data, status: 'blocked', updatedAt: now }
    return { ok: true }
  }

  markUsageLimited(now = Date.now()): GoalMutationResult {
    if (this.data.status !== 'active' && this.data.status !== 'budget_limited') {
      return { ok: false, error: 'cannot_usage_limit' }
    }
    this.data = { ...this.data, status: 'usage_limited', updatedAt: now }
    return { ok: true }
  }

  /** 改正文不动 updatedAt：它是上次结算的时刻，界面据此推算这一轮已经走了多久 */
  editObjective(objective: string): GoalMutationResult {
    const text = objective.trim()
    if (!text) return { ok: false, error: 'empty_objective' }
    if (this.isTerminal()) return { ok: false, error: 'terminal' }
    this.data = { ...this.data, objective: text }
    return { ok: true }
  }

  deferContinuation(): void {
    this.data = { ...this.data, continuationDeferred: true, updatedAt: this.data.updatedAt }
  }

  clearContinuationDeferral(): void {
    if (!this.data.continuationDeferred) return
    const next = { ...this.data }
    delete next.continuationDeferred
    this.data = next
  }

  /**
   * 预算用尽后续一笔：新预算必须大于已用量，状态回到推进中。
   */
  replenishBudget(tokenBudget: number, now = Date.now()): GoalMutationResult {
    if (this.data.status !== 'budget_limited') return { ok: false, error: 'not_budget_limited' }
    const parsed = sanitizeTokenBudget(tokenBudget)
    if (parsed === null) return { ok: false, error: 'invalid_token_budget' }
    if (parsed <= this.data.tokensUsed) return { ok: false, error: 'budget_not_above_used' }
    this.data = { ...this.data, tokenBudget: parsed, status: 'active', updatedAt: now }
    return { ok: true }
  }

  /**
   * 结算一轮用量。goalId 对不上则不记账（避免记到已被替换的目标上）。
   * 这一轮不论怎么收的场（达成、停滞、被按停、出错）都是为这个目标花的，一律记上；
   * 只有推进中的目标才会因此触顶转预算停机。
   */
  accountUsage(input: {
    expectedGoalId: string
    tokenDelta: number
    timeDeltaSeconds: number
    now?: number
  }): GoalMutationResult {
    if (input.expectedGoalId !== this.data.goalId) return { ok: false, error: 'goal_id_mismatch' }

    const tokenDelta = Number.isFinite(input.tokenDelta) ? Math.max(0, Math.floor(input.tokenDelta)) : 0
    const timeDelta = Number.isFinite(input.timeDeltaSeconds) ? Math.max(0, Math.floor(input.timeDeltaSeconds)) : 0
    const tokensUsed = this.data.tokensUsed + tokenDelta
    const timeUsedSeconds = this.data.timeUsedSeconds + timeDelta
    const now = input.now ?? Date.now()
    const hitBudget = this.data.status === 'active'
      && this.data.tokenBudget !== undefined
      && tokensUsed >= this.data.tokenBudget

    this.data = {
      ...this.data,
      tokensUsed,
      timeUsedSeconds,
      status: hitBudget ? 'budget_limited' : this.data.status,
      updatedAt: now,
    }
    return { ok: true }
  }
}

export function sanitizeGoalSnapshot(raw: unknown): GoalSnapshot | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (typeof o.goalId !== 'string' || !o.goalId.trim()) return null
  if (typeof o.objective !== 'string' || !o.objective.trim()) return null
  if (typeof o.status !== 'string' || !GOAL_STATUSES.includes(o.status as GoalStatus)) return null
  if (!isNonNegativeInt(o.tokensUsed) || !isNonNegativeInt(o.timeUsedSeconds)) return null
  if (!isPositiveInt(o.createdAt) || !isPositiveInt(o.updatedAt)) return null

  let tokenBudget: number | undefined
  if (o.tokenBudget !== undefined) {
    const parsed = sanitizeTokenBudget(o.tokenBudget)
    if (parsed === null) return null
    tokenBudget = parsed
  }

  return {
    goalId: o.goalId.trim(),
    objective: o.objective.trim(),
    status: o.status as GoalStatus,
    ...(tokenBudget !== undefined ? { tokenBudget } : {}),
    tokensUsed: o.tokensUsed,
    timeUsedSeconds: o.timeUsedSeconds,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
    ...(o.continuationDeferred === true ? { continuationDeferred: true } : {}),
  }
}

export function sanitizeTokenBudget(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null
  const n = Math.floor(raw)
  if (n < 1 || n > MAX_GOAL_TOKEN_BUDGET) return null
  return n
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value > 0
}

function createGoalId(now: number): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `goal_${now.toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}
