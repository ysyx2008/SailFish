import type { AttachmentInfo, PendingUserHandoff, WorkbenchContext } from '@shared/types'

/** start：马上开下一轮。wait：还在忙，先留在队列里，空闲后再开。stop：这拍不动（空队列 / 正在改 / 页已关）。 */
export type FollowUpDrainDecision = 'start' | 'wait' | 'stop'

/**
 * 这一轮的失败还要不要再补一张卡片。
 * 临时气泡还在、它后面又没有收场，才要补——更早那场的收场不算。
 * 临时气泡已经被正式步骤换掉时，这场由那边收场，这里不再补。
 */
export function turnFailureAlreadyVisible(
  steps: ReadonlyArray<{ id: string; type: string }>,
  userStepId: string,
): boolean {
  const start = steps.findIndex(step => step.id === userStepId)
  if (start < 0) return true
  return steps.slice(start + 1).some(step => step.type === 'final_result')
}

export function decideFollowUpDrain(input: {
  hasQueued: boolean
  headEditing: boolean
  tabAlive: boolean
  agentRunning: boolean
  /** 队列里有没送出去的条目：整个队列停在那里等用户处理，不往下开 */
  anyFailed?: boolean
}): FollowUpDrainDecision {
  if (!input.hasQueued || !input.tabAlive || input.headEditing || input.anyFailed) return 'stop'
  if (input.agentRunning) return 'wait'
  return 'start'
}

type FailableEntry = { id: string; failed?: { reason: string } }

/** 取出来开跑的这条没送到后台：回到队首并标成没送出去，后面的原样留着。 */
export function withFailedAtHead<T extends FailableEntry>(queue: T[], item: T, reason: string): T[] {
  return [{ ...item, failed: { reason } }, ...queue.filter(entry => entry.id !== item.id)]
}

/** 重试没送出去的那条：摘掉标记、挪到队首。不是失败的条目不动。 */
export function withRetried<T extends FailableEntry>(queue: T[], id: string): T[] {
  const item = queue.find(entry => entry.id === id)
  if (!item?.failed) return queue
  const { failed: _failed, ...rest } = item
  return [rest as T, ...queue.filter(entry => entry.id !== id)]
}

/** 没送出去的话放回输入框：输入框里已有新打的字时，放回的接在前面，不覆盖。 */
export function mergeHandbackText(existing: string, handback: string): string {
  if (!existing.trim()) return handback
  if (!handback.trim()) return existing
  return `${handback}\n${existing}`
}

export interface CoalescedPendingFollowUp {
  message: string
  images?: string[]
  attachments?: AttachmentInfo[]
  documentContext?: string
  workbenchContext?: WorkbenchContext
}

function isHandoff(entry: unknown): entry is PendingUserHandoff {
  return !!entry && typeof entry === 'object' && typeof (entry as PendingUserHandoff).message === 'string'
}

/** 完成事件里没吃进模型的补充，收成一条下一轮。字符串是旧形状，对象里的图和附件要留下。 */
export function coalescePendingHandoff(raw: unknown): CoalescedPendingFollowUp | null {
  if (!Array.isArray(raw) || raw.length === 0) return null
  const messages: string[] = []
  const images: string[] = []
  const attachments: AttachmentInfo[] = []
  const docs: string[] = []
  let workbenchContext: WorkbenchContext | undefined
  for (const entry of raw) {
    if (typeof entry === 'string') {
      if (entry.trim()) messages.push(entry)
      continue
    }
    if (!isHandoff(entry)) continue
    if (entry.message.trim()) messages.push(entry.message)
    if (Array.isArray(entry.images)) {
      for (const img of entry.images) {
        if (typeof img === 'string' && img) images.push(img)
      }
    }
    if (Array.isArray(entry.attachments)) {
      for (const att of entry.attachments) {
        if (att && typeof att === 'object' && typeof att.filename === 'string') attachments.push(att)
      }
    }
    if (typeof entry.documentContext === 'string' && entry.documentContext.trim()) docs.push(entry.documentContext)
    if (entry.workbenchContext && typeof entry.workbenchContext === 'object') {
      workbenchContext = entry.workbenchContext
    }
  }
  const message = messages.join('\n')
  if (!message.trim() && images.length === 0 && attachments.length === 0) return null
  return {
    message,
    ...(images.length ? { images } : {}),
    ...(attachments.length ? { attachments } : {}),
    ...(docs.length ? { documentContext: docs.join('\n\n') } : {}),
    ...(workbenchContext ? { workbenchContext } : {}),
  }
}

export interface OptimisticStepLike {
  id: string
  type: string
  content?: string
  images?: string[]
  attachments?: Array<{ filename?: string }>
}

/**
 * 后端这条已经接住了墙上的临时消息：同一句话，而且临时消息上的图和附件都在。
 * 对不上的临时消息要留着——后面另一句不能把已经看见的话悄悄擦掉。
 */
export function optimisticPlaceholderConfirmedBy(
  optimistic: OptimisticStepLike,
  incoming: OptimisticStepLike,
): boolean {
  if (!optimistic.id.startsWith('__optimistic_')) return false
  if (incoming.id.startsWith('__optimistic_')) return false
  if ((optimistic.content ?? '') !== (incoming.content ?? '')) return false
  if (!optimisticMediaCovered(incoming, optimistic)) return false
  if (incoming.type === 'user_task') {
    return optimistic.type === 'user_task' || optimistic.type === 'user_supplement'
  }
  if (incoming.type === 'user_supplement') {
    return optimistic.type === 'user_supplement'
  }
  return false
}

/** 临时消息上的图、附件，到来的正式步骤里都得有。预览图和原图内容可以不同，张数不能少。 */
function optimisticMediaCovered(incoming: OptimisticStepLike, optimistic: OptimisticStepLike): boolean {
  const wantedNames = (optimistic.attachments ?? [])
    .map(item => item.filename)
    .filter((name): name is string => !!name)
  if (wantedNames.length > 0) {
    const got = new Set(
      (incoming.attachments ?? [])
        .map(item => item.filename)
        .filter((name): name is string => !!name),
    )
    if (!wantedNames.every(name => got.has(name))) return false
  }
  const wantedImages = optimistic.images?.length ?? 0
  if (wantedImages > 0 && (incoming.images?.length ?? 0) < wantedImages) return false
  return true
}

type QueueHead = {
  message: string
  images?: string[]
  previewImages?: string[]
  attachments?: AttachmentInfo[]
  documentContext?: string
  workbenchContext?: WorkbenchContext
}

/**
 * 收尾时带回的补充插到队首。
 * 队首已经是同一句时，不再开一条重复的；队首没带上的图，补到那一条上。
 */
export function mergePendingIntoQueue<T extends QueueHead>(
  queue: T[],
  pending: CoalescedPendingFollowUp,
  create: (pending: CoalescedPendingFollowUp) => T,
): T[] {
  const head = queue[0]
  if (!head || head.message !== pending.message) return [create(pending), ...queue]
  if (head.images?.length || !pending.images?.length) return queue
  return [{
    ...head,
    images: pending.images,
    previewImages: pending.images,
    attachments: head.attachments?.length ? head.attachments : pending.attachments,
    documentContext: head.documentContext || pending.documentContext,
    workbenchContext: head.workbenchContext || pending.workbenchContext,
  }, ...queue.slice(1)]
}
