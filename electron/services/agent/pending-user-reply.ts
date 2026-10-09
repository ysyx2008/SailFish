import type { PendingUserMessage } from './types'

/**
 * 题还开着时，从排队消息里抄出一条写了字的，用来结题。
 *
 * 输入框来的整条仍留在队列里，稍后作为追加消息交给模型（字不会被抠掉）。
 * 只有图、没有字的不算回答。
 * 点选项是静默的，只用来答题，不留成追加消息。
 */
export function takeQueuedUserReply(queue: readonly PendingUserMessage[]): {
  reply?: string
  queue: PendingUserMessage[]
} {
  const idx = queue.findIndex(isReplyCandidate)
  if (idx < 0) return { queue: queue.slice() }

  const next = queue.slice()
  const item = next[idx]!
  if (item.silent) {
    next.splice(idx, 1)
    return { reply: item.message, queue: next }
  }

  next[idx] = { ...item, consumedAsReply: true }
  return { reply: item.message, queue: next }
}

function isReplyCandidate(pending: PendingUserMessage): boolean {
  return !pending.backgroundNotice
    && !pending.consumedAsReply
    && pending.message.trim().length > 0
}
