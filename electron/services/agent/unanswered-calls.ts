/**
 * 对话里宣告了、却没有记录结果的工具调用。
 * 按消息结构判断：assistant 消息里的调用，没有对应 tool_call_id 的 tool 消息。
 */
import type { AiMessage } from '../ai.service'
import type { UnansweredCall } from '../history/sub-agent-record-store'
import { summarizeArgs } from './sub-agent-roster'

export function findUnansweredToolCalls(messages: readonly AiMessage[]): UnansweredCall[] {
  const answered = new Set<string>()
  for (const msg of messages) {
    if (msg.role === 'tool' && msg.tool_call_id) answered.add(msg.tool_call_id)
  }
  const calls: UnansweredCall[] = []
  for (const msg of messages) {
    if (msg.role !== 'assistant' || !msg.tool_calls) continue
    for (const call of msg.tool_calls) {
      if (answered.has(call.id)) continue
      const target = summarizeArgs(parseArgs(call.function.arguments))
      calls.push({ tool: call.function.name, ...(target ? { target } : {}) })
    }
  }
  return calls
}

function parseArgs(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}
