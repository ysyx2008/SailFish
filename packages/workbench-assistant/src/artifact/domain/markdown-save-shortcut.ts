/**
 * Markdown 编辑器的 Cmd/Ctrl+S。
 *
 * 切走的对话仍挂在页面上，各自的编辑器都会接到同一次按键。
 * 只让眼前这份处理；同一次按键再进来也不再提示或再写一遍。
 */

export function isMarkdownSaveShortcut(event: {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  repeat?: boolean
}): boolean {
  if (event.repeat) return false
  if (!(event.ctrlKey || event.metaKey)) return false
  return event.key === 's'
}

/** 短到连按两下仍各算一次，又盖住同一次按键打到多个编辑器 */
export const MARKDOWN_SAVE_SHORTCUT_GUARD_MS = 200

let handledUntil = 0

/** 这次按键还没人接过则认领并返回 true。 */
export function claimMarkdownSaveShortcut(now = Date.now()): boolean {
  if (now < handledUntil) return false
  handledUntil = now + MARKDOWN_SAVE_SHORTCUT_GUARD_MS
  return true
}

/** 测试用：清掉按键窗口，避免用例互相污染 */
export function resetMarkdownSaveShortcutGuard(): void {
  handledUntil = 0
}
