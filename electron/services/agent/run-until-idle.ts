/**
 * 父循环收工：没有待处理消息，且没有活着的伙计。
 * 有伙计还没敲门时阻塞等待，不要空转再调一轮模型。
 */
export async function runUntilIdle(params: {
  executeLoop: () => Promise<string>
  hasPendingMessages: () => boolean
  hasLiveChildren: () => boolean
  waitForChildrenOrKnock: () => Promise<void>
  /** 有待处理消息、接着跑之前：给陆续回来的伙计留一点时间一起进来 */
  settlePending?: () => Promise<void>
  isAborted: () => boolean
}): Promise<string> {
  let result = await params.executeLoop()
  while (!params.isAborted()) {
    if (params.hasPendingMessages()) {
      await params.settlePending?.()
      if (params.isAborted()) break
      result = await params.executeLoop()
      continue
    }
    if (params.hasLiveChildren()) {
      await params.waitForChildrenOrKnock()
      continue
    }
    break
  }
  return result
}
