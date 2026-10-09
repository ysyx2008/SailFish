import type { PendingUserMessage } from './types'

/** 点选项是明确的回答。输入框发来的只说明用户开口了，整条仍留在队列里。 */
export type QueuedReplyTake =
  | { kind: 'answer'; text: string }
  | { kind: 'message' }

/**
 * 题还开着时，看队列里有没有能结束等待的。
 * 点选项是静默的，只用来答题，不留成追加消息。队列里有点选时，以点选为准。
 * 输入框来的（有字、有图或有文件）整条留在队列里，稍后作为追加消息交给模型。
 * 是不是在答题，不在这里判断。
 */
export function takeQueuedUserReply(queue: readonly PendingUserMessage[]): {
  take?: QueuedReplyTake
  queue: PendingUserMessage[]
} {
  const next = queue.slice()
  const clickAt = next.findIndex(isOptionClick)
  if (clickAt >= 0) {
    const item = next[clickAt]!
    next.splice(clickAt, 1)
    return { take: { kind: 'answer', text: item.message }, queue: next }
  }

  const spokenAt = next.findIndex(isComposerMessage)
  if (spokenAt < 0) return { queue: next }

  const item = next[spokenAt]!
  next[spokenAt] = { ...item, consumedAsReply: true }
  return { take: { kind: 'message' }, queue: next }
}

function isOptionClick(pending: PendingUserMessage): boolean {
  return !!pending.silent
    && !pending.backgroundNotice
    && pending.message.trim().length > 0
}

function isComposerMessage(pending: PendingUserMessage): boolean {
  return !pending.silent
    && !pending.backgroundNotice
    && !pending.consumedAsReply
    && hasComposerPayload(pending)
}

function hasComposerPayload(pending: PendingUserMessage): boolean {
  return pending.message.trim().length > 0
    || (pending.images?.length ?? 0) > 0
    || (pending.attachments?.length ?? 0) > 0
    || !!pending.documentContext
    || !!pending.workbenchContext
}
