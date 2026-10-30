/**
 * 清洗父对话：伙计开局只带用户原话和主人说出口的最终答复，
 * 剥掉工具调用、工具结果、思考和系统注入，避免伙计去模仿主人的工具。
 */
import type { AiMessage } from '../ai.service'

export type ForkTurns =
  | { kind: 'none' }
  | { kind: 'all' }
  | { kind: 'last'; n: number }

export function parseForkTurns(raw: unknown): ForkTurns | { error: string } {
  if (raw == null || raw === '') return { kind: 'all' }
  const text = String(raw).trim()
  if (text === '') return { kind: 'all' }
  if (/^none$/i.test(text)) return { kind: 'none' }
  if (/^all$/i.test(text)) return { kind: 'all' }
  if (!/^\d+$/.test(text)) {
    return { error: 'fork_turns 必须是 none、all，或正整数字符串' }
  }
  const n = Number(text)
  if (n < 1) return { error: 'fork_turns 必须是 none、all，或正整数字符串' }
  return { kind: 'last', n }
}

/** 已清洗的对话上再按「不带 / 全带 / 最近几轮」裁。一轮 = 一条用户原话及其后的助手答复。 */
export function applyForkTurns(cleaned: readonly AiMessage[], fork: ForkTurns): AiMessage[] {
  if (fork.kind === 'none') return []
  if (fork.kind === 'all') return [...cleaned]
  const starts: number[] = []
  cleaned.forEach((msg, i) => {
    if (msg.role === 'user') starts.push(i)
  })
  if (starts.length === 0) return []
  const from = starts[Math.max(0, starts.length - fork.n)]
  return cleaned.slice(from)
}

export function sanitizeParentMessages(messages: readonly AiMessage[]): AiMessage[] {
  const out: AiMessage[] = []
  for (const msg of messages) {
    if (msg.role === 'tool' || msg.role === 'system') continue
    if (msg.role === 'assistant') {
      if (msg.tool_calls && msg.tool_calls.length > 0) continue
      const content = (msg.content || '').trim()
      if (!content) continue
      out.push({ role: 'assistant', content })
      continue
    }
    if (msg.role === 'user') {
      // 同批合并的通知不混入用户交代；落盘的插话虽不是task边界，仍保留用户部分。
      if (Array.isArray(msg._userContextParts)) {
        for (const part of msg._userContextParts) {
          if (!part || !Number.isInteger(part.start) || !Number.isInteger(part.end) || part.start < 0 || part.end <= part.start || part.end > msg.content.length) continue
          const content = msg.content.slice(part.start, part.end).trim()
          if (content) out.push({ role: 'user', content })
        }
        continue
      }
      if (msg._systemInjected) continue
      const content = (msg.content || '').trim()
      if (!content) continue
      out.push({ role: 'user', content })
    }
  }
  return out
}
