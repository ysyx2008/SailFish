/**
 * 离开底部时，这一下要不要亮「新消息」。
 * 新的一步，或同一句还在往下长，才算。同一张卡片原地刷新（伙计进度、状态打点）不算。
 */
export function stepWarrantsNewMessageHint(
  previous: { type: string; content: string } | undefined,
  next: { type: string; content: string }
): boolean {
  if (!previous) return true
  return previous.type !== next.type || previous.content !== next.content
}
