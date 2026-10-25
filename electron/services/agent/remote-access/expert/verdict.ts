/**
 * 运维专家的结论：解析模型输出的一个 JSON。
 *
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

const MAX_TEXT_CHARS = 1200

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

function tidy(value: unknown): string {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  return text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}…` : text
}

export function parseExpertVerdict(text: string | undefined): ExpertVerdict | null {
  if (!text) return null
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
