/**
 * 运维专家的结论。
 *
 * 正常写法：第一行只写结论，空一行，然后是说明。说明可以很长，
 * 结论一出来就能读，说明写到哪就读到哪。
 * 整段是一个 JSON 时也认（以前的写法），免得模型没跟上新格式就变成没给意见。
 * 字段缺、取值不对、该写的话没写，都当作看不懂，调用方一律交给用户，不当放行。
 */

export const EXPERT_OUTCOMES = ['allow', 'ask_user', 'refuse'] as const
export type ExpertOutcome = (typeof EXPERT_OUTCOMES)[number]

export type ExpertVerdict =
  /** note：一句话说明为什么放行 */
  | { outcome: 'allow'; note: string }
  /** card：给用户看的话 */
  | { outcome: 'ask_user'; card: string }
  /** reason：给秘书看，便于它改 */
  | { outcome: 'refuse'; reason: string }

/** 还在写的时候能读到的部分。text 为空表示结论已到、说明还没开始 */
export interface ExpertPartial {
  outcome: ExpertOutcome
  text: string
}

/** 说明可以写长，界面一边收一边显示。落定时截一刀，避免一条过程被写爆 */
const MAX_TEXT_CHARS = 8000
const OUTCOME_LINE = /^(allow|ask_user|refuse)$/

function extractJsonObject(text: string): unknown {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return undefined
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return undefined
  }
}

function clip(value: string): string {
  const text = value.trim()
  return text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}…` : text
}

function tidy(value: unknown): string {
  if (typeof value !== 'string') return ''
  return clip(value)
}

/**
 * 第一行写完并且正好是结论时，就能读。说明还没写完也行，text 随着后文变长。
 * 第一行还没换行、或第一行不是这三个词，返回 null，不当结论。
 */
export function readExpertPartial(raw: string): ExpertPartial | null {
  const text = raw.replace(/^\uFEFF/, '')
  const start = text.search(/\S/)
  if (start < 0) return null
  const body = text.slice(start)
  const newline = body.search(/\r?\n/)
  if (newline < 0) return null
  const first = body.slice(0, newline).trim()
  if (!OUTCOME_LINE.test(first)) return null
  let rest = body.slice(newline).replace(/^\r?\n/, '')
  if (rest.startsWith('\n') || rest.startsWith('\r\n')) rest = rest.replace(/^\r?\n/, '')
  return { outcome: first as ExpertOutcome, text: clip(rest) }
}

export function partialFromVerdict(verdict: ExpertVerdict): ExpertPartial {
  const text = verdict.outcome === 'allow' ? verdict.note : verdict.outcome === 'ask_user' ? verdict.card : verdict.reason
  return { outcome: verdict.outcome, text }
}

function verdictFromPartial(partial: ExpertPartial | null): ExpertVerdict | null {
  if (!partial?.text) return null
  if (partial.outcome === 'allow') return { outcome: 'allow', note: partial.text }
  if (partial.outcome === 'ask_user') return { outcome: 'ask_user', card: partial.text }
  return { outcome: 'refuse', reason: partial.text }
}

export function parseExpertVerdict(text: string | undefined): ExpertVerdict | null {
  if (!text) return null
  const fromLine = verdictFromPartial(readExpertPartial(text))
  if (fromLine) return fromLine

  const raw = extractJsonObject(text)
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const outcome = obj.outcome
  if (!EXPERT_OUTCOMES.includes(outcome as ExpertOutcome)) return null

  const card = tidy(obj.card)
  if (outcome === 'allow') return card ? { outcome, note: card } : null
  if (outcome === 'ask_user') return card ? { outcome, card } : null
  const reason = tidy(obj.reason)
  return reason ? { outcome: 'refuse', reason } : null
}
