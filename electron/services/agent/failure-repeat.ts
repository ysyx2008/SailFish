/**
 * 同一个动作、参数逐字相同，连着失败时记一笔。
 * 只认完全相同，不靠「像不像」。命令还在跑的不记。
 */

export const IDENTICAL_FAILURE_LIMIT = 5
export const ALTERNATING_ROUNDS = 3
const RECENT_LIMIT = 8

type Nudge =
  | { kind: 'identical'; signature: string }
  | { kind: 'alternating'; first: string; second: string }

export interface FailureRepeatState {
  recent: RepeatEntry[]
  /** 已经点明过的那一种重复。同一种还在继续就不再说。 */
  nudged: Nudge | null
}

interface RepeatEntry {
  signature: string
  toolName: string
  failed: boolean
}

export type RepeatNotice =
  | { kind: 'identical'; toolName: string; times: number }
  | { kind: 'alternating'; firstName: string; secondName: string; rounds: number }

export interface ToolAttempt {
  toolName: string
  args: Record<string, unknown>
  /** 模型原文。args 是空的时候用它，避免没解析到参数就被当成「参数相同」。 */
  rawArguments?: string
  failed: boolean
  /** 还没有成败（命令仍在跑，而且这次没有失败） */
  unsettled?: boolean
}

export function emptyFailureRepeatState(): FailureRepeatState {
  return { recent: [], nudged: null }
}

export function noteFailureRepeat(
  state: FailureRepeatState,
  attempt: ToolAttempt,
): { state: FailureRepeatState; notice: RepeatNotice | null } {
  if (attempt.unsettled) return { state, notice: null }

  const entry: RepeatEntry = {
    signature: signatureOf(attempt),
    toolName: attempt.toolName,
    failed: attempt.failed,
  }
  const recent = state.recent.concat(entry).slice(-RECENT_LIMIT)
  if (stillCovered(state.nudged, recent)) {
    return { state: { recent, nudged: state.nudged }, notice: null }
  }

  const identical = identicalFailureTail(recent)
  if (identical) {
    return {
      state: { recent, nudged: { kind: 'identical', signature: identical[0].signature } },
      notice: {
        kind: 'identical',
        toolName: identical[0].toolName,
        times: identical.length,
      },
    }
  }

  const alternating = alternatingFailures(recent)
  if (alternating) {
    return {
      state: {
        recent,
        nudged: { kind: 'alternating', first: alternating.a.signature, second: alternating.b.signature },
      },
      notice: {
        kind: 'alternating',
        firstName: alternating.a.toolName,
        secondName: alternating.b.toolName,
        rounds: ALTERNATING_ROUNDS,
      },
    }
  }

  return { state: { recent, nudged: null }, notice: null }
}

function identicalFailureTail(recent: RepeatEntry[]): RepeatEntry[] | null {
  const last = recent[recent.length - 1]
  if (!last?.failed) return null
  const tail: RepeatEntry[] = []
  for (let i = recent.length - 1; i >= 0; i--) {
    const entry = recent[i]
    if (!entry.failed || entry.signature !== last.signature) break
    tail.push(entry)
  }
  if (tail.length < IDENTICAL_FAILURE_LIMIT) return null
  return tail
}

function alternatingFailures(recent: RepeatEntry[]): { a: RepeatEntry; b: RepeatEntry } | null {
  const need = ALTERNATING_ROUNDS * 2
  if (recent.length < need) return null
  const window = recent.slice(-need)
  if (window.some(entry => !entry.failed)) return null
  const a = window[0]
  const b = window[1]
  if (a.signature === b.signature) return null
  for (let i = 0; i < need; i++) {
    const expected = i % 2 === 0 ? a.signature : b.signature
    if (window[i].signature !== expected) return null
  }
  return { a, b }
}

function stillCovered(nudge: Nudge | null, recent: RepeatEntry[]): boolean {
  if (!nudge) return false
  const last = recent[recent.length - 1]
  if (!last?.failed) return false
  if (nudge.kind === 'identical') return last.signature === nudge.signature
  if (recent.length < 2) return false
  const prev = recent[recent.length - 2]
  if (!prev.failed) return false
  const pair = [nudge.first, nudge.second]
  return pair.includes(last.signature)
    && pair.includes(prev.signature)
    && last.signature !== prev.signature
}

function signatureOf(attempt: ToolAttempt): string {
  return `${attempt.toolName}\n${canonicalArgs(attempt)}`
}

function canonicalArgs(attempt: ToolAttempt): string {
  if (attempt.args && Object.keys(attempt.args).length > 0) return canonical(attempt.args)
  const raw = attempt.rawArguments
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return canonical(parsed)
    } catch {
      return raw
    }
  }
  return canonical(attempt.args ?? {})
}

function canonical(value: unknown): string {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).filter(key => record[key] !== undefined).sort()
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
}
