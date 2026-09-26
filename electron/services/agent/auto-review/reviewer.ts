/**
 * 替我审批的评审员。每个 Agent 实例一个，跟着这场任务走。
 *
 * 它有自己的一条会话线：固定说明书 + 按时间往后追加的评审记录。同一场任务里再评，
 * 只补上次之后新出现的原话和过程，前面逐字不变，才能吃到缓存。它不接着干活那边的对话
 * 往下评——那等于自己批自己，干活那边读过的网页、命令输出也会混进前缀。
 *
 * 它只能把「要问人」变成「替你放行」：没放行、看不清、超时、出错，都交回人。
 */
import type { AgentStep, AutoReviewHandOverReason, RiskLevel } from '@shared/types'
import type { AiMessage, ChatWithToolsResult, TokenUsageInfo, ToolDefinition } from '../../ai.service'
import { buildReviewerPolicy } from './policy'
import { assessmentApproves, effectiveAssessment, parseAssessment, type ReviewAssessment } from './verdict'
import {
  collectUserWords,
  cursorAt,
  cursorStillValid,
  formatAction,
  formatProcess,
  formatUserWords,
  serializeActionArgs,
  userWordsChars,
  type PlannedAction,
  type ProcessCursor,
  type ReviewEnvironment,
} from './evidence'
import { INSPECTOR_TOOLS, runInspection, type InspectorDeps } from './inspector'

export type AutoReviewChat = (
  messages: AiMessage[],
  tools: ToolDefinition[],
  profileId: string | undefined,
  signal: AbortSignal,
  options?: { toolChoice?: 'auto' | 'none'; maxOutputTokens?: number },
) => Promise<ChatWithToolsResult>

export type HandOverReason = AutoReviewHandOverReason

export type AutoReviewResult =
  | { kind: 'approved'; assessment: ReviewAssessment; usage?: TokenUsageInfo }
  | { kind: 'handed_over'; reason: HandOverReason; assessment?: ReviewAssessment; detail?: string; usage?: TokenUsageInfo }
  | { kind: 'cancelled'; usage?: TokenUsageInfo }

export interface AutoReviewRequest {
  runId: string
  sessionId: string
  locale: 'zh-CN' | 'en-US'
  toolName: string
  toolArgs: Record<string, unknown>
  displayName?: string
  riskLevel: RiskLevel
  reasons?: string[]
  /** 每次调用都重新取：评审途中用户补的话要能看见 */
  getSteps: () => readonly AgentStep[]
  getMessages: () => readonly AiMessage[]
  aiRules: string
  environment: ReviewEnvironment
  profileId?: string
  signal?: AbortSignal
  inspector: InspectorDeps
}

export interface AutoApprovalReviewerOptions {
  chat: AutoReviewChat
  timeoutMs?: number
  maxInspections?: number
  circuitThreshold?: number
}

interface ReviewSession {
  key: string
  locale: 'zh-CN' | 'en-US'
  aiRules: string
  messages: AiMessage[]
  seenUserWordIds: Set<string>
  cursor: ProcessCursor
  chars: number
}

export const USER_WORDS_BUDGET_CHARS = 40_000
export const ACTION_BUDGET_CHARS = 16_000
const FIRST_PROCESS_BUDGET_CHARS = 12_000
const DELTA_PROCESS_BUDGET_CHARS = 8_000
const SESSION_BUDGET_CHARS = 60_000
const MAX_OUTPUT_TOKENS = 1500

class ReviewCancelled extends Error {}

function addUsage(total: TokenUsageInfo | undefined, u: TokenUsageInfo | undefined): TokenUsageInfo | undefined {
  if (!u) return total
  const base = total ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  return {
    prompt_tokens: base.prompt_tokens + u.prompt_tokens,
    completion_tokens: base.completion_tokens + u.completion_tokens,
    total_tokens: base.total_tokens + u.total_tokens,
    ...(u.cache_hit_tokens !== undefined || base.cache_hit_tokens !== undefined
      ? { cache_hit_tokens: (base.cache_hit_tokens ?? 0) + (u.cache_hit_tokens ?? 0) } : {}),
    ...(u.cache_miss_tokens !== undefined || base.cache_miss_tokens !== undefined
      ? { cache_miss_tokens: (base.cache_miss_tokens ?? 0) + (u.cache_miss_tokens ?? 0) } : {}),
  }
}

/** 有些模型通道不认中止信号；超时或任务被停时不再等它。 */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new ReviewCancelled())
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new ReviewCancelled())
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      v => { signal.removeEventListener('abort', onAbort); resolve(v) },
      e => { signal.removeEventListener('abort', onAbort); reject(e) },
    )
  })
}

/** 缓存断点打在已提交的最后一条回答上：到那为止的前缀下次原样复用。 */
function withCacheBreakpoint(messages: readonly AiMessage[]): AiMessage[] {
  const out = [...messages]
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].role === 'assistant') {
      out[i] = { ...out[i], _cacheBreakpoint: true }
      break
    }
  }
  return out
}

function messageChars(m: AiMessage): number {
  return m.content.length + (m.tool_calls?.reduce((n, c) => n + c.function.arguments.length, 0) ?? 0)
}

export class AutoApprovalReviewer {
  private readonly chat: AutoReviewChat
  private readonly timeoutMs: number
  private readonly maxInspections: number
  private readonly circuitThreshold: number

  private session: ReviewSession | null = null
  private declineRunId: string | null = null
  private consecutiveDeclines = 0
  private chain: Promise<unknown> = Promise.resolve()

  constructor(opts: AutoApprovalReviewerOptions) {
    this.chat = opts.chat
    this.timeoutMs = opts.timeoutMs ?? 60_000
    this.maxInspections = opts.maxInspections ?? 4
    this.circuitThreshold = opts.circuitThreshold ?? 3
  }

  /** 这一轮是否已经连着好几次没放行，后面直接问人。 */
  isCircuitOpen(runId: string): boolean {
    return this.declineRunId === runId && this.consecutiveDeclines >= this.circuitThreshold
  }

  reset(): void {
    this.session = null
    this.declineRunId = null
    this.consecutiveDeclines = 0
  }

  async review(req: AutoReviewRequest): Promise<AutoReviewResult> {
    const run = this.chain.then(() => this.reviewSerial(req), () => this.reviewSerial(req))
    this.chain = run.then(() => undefined, () => undefined)
    return run
  }

  private async reviewSerial(req: AutoReviewRequest): Promise<AutoReviewResult> {
    try {
      return await this.reviewBody(req)
    } catch (e) {
      if (req.signal?.aborted) return { kind: 'cancelled' }
      return {
        kind: 'handed_over',
        reason: 'failed',
        detail: e instanceof Error ? e.message : String(e),
      }
    }
  }

  private async reviewBody(req: AutoReviewRequest): Promise<AutoReviewResult> {
    if (this.declineRunId !== req.runId) {
      this.declineRunId = req.runId
      this.consecutiveDeclines = 0
    }
    if (this.isCircuitOpen(req.runId)) {
      return { kind: 'handed_over', reason: 'circuit_open' }
    }

    let usage: TokenUsageInfo | undefined
    for (let attempt = 0; attempt < 2; attempt++) {
      const wordsBefore = collectUserWords(req.getSteps()).length
      const result = await this.reviewOnce(req)
      usage = addUsage(usage, result.usage)
      if (result.kind !== 'approved') {
        return this.settle(req.runId, { ...result, usage })
      }
      if (collectUserWords(req.getSteps()).length === wordsBefore) {
        return this.settle(req.runId, { ...result, usage })
      }
    }
    return this.settle(req.runId, { kind: 'handed_over', reason: 'user_spoke', usage })
  }

  private settle(runId: string, result: AutoReviewResult): AutoReviewResult {
    if (result.kind === 'approved') {
      this.consecutiveDeclines = 0
    } else if (result.kind === 'handed_over' && (result.reason === 'not_approved' || result.reason === 'failed')) {
      if (this.declineRunId === runId) this.consecutiveDeclines++
    }
    return result
  }

  private async reviewOnce(req: AutoReviewRequest): Promise<AutoReviewResult> {
    const steps = req.getSteps()
    const messages = req.getMessages()
    const words = collectUserWords(steps)
    if (userWordsChars(words) > USER_WORDS_BUDGET_CHARS) {
      return { kind: 'handed_over', reason: 'too_large', detail: 'user_words' }
    }
    const action: PlannedAction = {
      toolName: req.toolName,
      displayName: req.displayName,
      riskLevel: req.riskLevel,
      reasons: req.reasons,
      args: req.toolArgs,
      environment: req.environment,
    }
    const argsJson = serializeActionArgs(req.toolArgs)
    if (argsJson.length > ACTION_BUDGET_CHARS) {
      return { kind: 'handed_over', reason: 'too_large', detail: 'action' }
    }

    const session = this.prepareSession(req, messages)
    const isFirst = session.messages.length === 0
    const newWords = words.filter(w => !session.seenUserWordIds.has(w.id))
    const processFrom = isFirst ? 0 : session.cursor.count
    const processBudget = isFirst ? FIRST_PROCESS_BUDGET_CHARS : DELTA_PROCESS_BUDGET_CHARS

    const sections: string[] = []
    if (isFirst) {
      sections.push(`【用户写给 AI 的规则】\n${req.aiRules.trim() || '（无）'}`)
      sections.push(`【你的原话】（到目前为止全部）\n${newWords.length ? formatUserWords(newWords) : '（无）'}`)
      sections.push(`【最近过程】（线索）\n${formatProcess(messages, processFrom, processBudget)}`)
    } else {
      sections.push(`【你的原话】（上次评审之后新增）\n${newWords.length ? formatUserWords(newWords) : '（无新增）'}`)
      sections.push(`【最近过程】（线索，上次评审之后新增）\n${formatProcess(messages, processFrom, processBudget)}`)
    }
    sections.push(`【这一条动作】\n${formatAction(action, argsJson)}`)
    sections.push('请按说明书判断，最后只输出 JSON。')
    const newUser: AiMessage = { role: 'user', content: sections.join('\n\n') }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    const onParentAbort = () => controller.abort()
    if (req.signal?.aborted) controller.abort()
    req.signal?.addEventListener('abort', onParentAbort, { once: true })

    const exchange: AiMessage[] = [newUser]
    let usage: TokenUsageInfo | undefined
    let finalText: string | undefined
    try {
      const system: AiMessage = { role: 'system', content: buildReviewerPolicy(session.locale) }
      const history = withCacheBreakpoint(session.messages)
      for (let round = 0; ; round++) {
        if (controller.signal.aborted) throw new ReviewCancelled()
        const lastRound = round >= this.maxInspections
        const res = await untilAborted(this.chat(
          [system, ...history, ...exchange],
          INSPECTOR_TOOLS,
          req.profileId,
          controller.signal,
          { toolChoice: lastRound ? 'none' : 'auto', maxOutputTokens: MAX_OUTPUT_TOKENS },
        ), controller.signal)
        usage = addUsage(usage, res.usage)
        if (res.aborted) throw new ReviewCancelled()
        const calls = res.tool_calls ?? []
        if (calls.length === 0 || lastRound) {
          finalText = res.content
          exchange.push({ role: 'assistant', content: res.content ?? '' })
          break
        }
        exchange.push({
          role: 'assistant',
          content: res.content ?? '',
          tool_calls: calls,
          ...(res.reasoning_content !== undefined ? { reasoning_content: res.reasoning_content } : {}),
        })
        for (const call of calls) {
          if (controller.signal.aborted) throw new ReviewCancelled()
          const output = await untilAborted(runInspection(call, req.inspector), controller.signal)
          exchange.push({ role: 'tool', tool_call_id: call.id, content: output })
        }
      }
    } catch (e) {
      if (req.signal?.aborted) return { kind: 'cancelled', usage }
      const timedOut = controller.signal.aborted
      return {
        kind: 'handed_over',
        reason: 'failed',
        detail: timedOut ? 'timeout' : (e instanceof Error ? e.message : String(e)),
        usage,
      }
    } finally {
      clearTimeout(timer)
      req.signal?.removeEventListener('abort', onParentAbort)
    }

    this.commit(session, exchange, words, messages)

    const parsed = parseAssessment(finalText)
    if (!parsed) {
      return { kind: 'handed_over', reason: 'failed', detail: 'unreadable', usage }
    }
    const assessment = effectiveAssessment(parsed, req.riskLevel)
    if (!assessmentApproves(assessment)) {
      return { kind: 'handed_over', reason: 'not_approved', assessment, usage }
    }
    return { kind: 'approved', assessment, usage }
  }

  /** 换了会话、说明书语言或规则变了、干活那边被压缩改写、自己这条线太长，都从头来。 */
  private prepareSession(req: AutoReviewRequest, messages: readonly AiMessage[]): ReviewSession {
    const s = this.session
    const stale = !s
      || s.key !== req.sessionId
      || s.locale !== req.locale
      || s.aiRules !== req.aiRules
      || !cursorStillValid(messages, s.cursor)
      || s.chars > SESSION_BUDGET_CHARS
    if (!stale) return s!
    this.session = {
      key: req.sessionId,
      locale: req.locale,
      aiRules: req.aiRules,
      messages: [],
      seenUserWordIds: new Set(),
      cursor: { count: 0, fingerprint: '' },
      chars: 0,
    }
    return this.session
  }

  private commit(
    session: ReviewSession,
    exchange: AiMessage[],
    words: ReturnType<typeof collectUserWords>,
    messages: readonly AiMessage[],
  ): void {
    session.messages.push(...exchange)
    session.chars += exchange.reduce((n, m) => n + messageChars(m), 0)
    for (const w of words) session.seenUserWordIds.add(w.id)
    session.cursor = cursorAt(messages)
  }
}
