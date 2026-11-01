/**
 * 产出物有焦点时 Cmd/Ctrl+W 关当前页签。
 * 面板注册「有焦点就关」；壳层关闭快捷键先问这里，避免菜单加速键与页面按键各关一次。
 *
 * 同一次按键会打到页面 keydown 和 Electron 菜单加速键（后者经 IPC，晚于微任务），
 * 防连关必须跨过这次菜单回声，但不能挡住下一记真正的 Cmd+W。
 */

export function isCloseArtifactShortcut(event: {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey?: boolean
}): boolean {
  if (event.altKey || event.shiftKey) return false
  if (!(event.ctrlKey || event.metaKey)) return false
  return event.key.toLowerCase() === 'w'
}

/** 覆盖菜单 IPC 回声，又短到连按两下仍能各关一份 */
export const CLOSE_ARTIFACT_SHORTCUT_GUARD_MS = 200

type CloseFocusedFn = () => boolean

const closers = new Set<CloseFocusedFn>()
let handledUntil = 0
let guardTimer: ReturnType<typeof setTimeout> | null = null

export function registerFocusedArtifactCloser(fn: CloseFocusedFn | null): () => void {
  if (!fn) { closers.clear(); return () => {} }
  closers.add(fn)
  return () => { closers.delete(fn) }
}

function clearCloseGuard(): void {
  handledUntil = 0
  if (guardTimer !== null) {
    clearTimeout(guardTimer)
    guardTimer = null
  }
}

function armCloseGuard(): void {
  handledUntil = Date.now() + CLOSE_ARTIFACT_SHORTCUT_GUARD_MS
  if (guardTimer !== null) clearTimeout(guardTimer)
  guardTimer = setTimeout(() => {
    handledUntil = 0
    guardTimer = null
  }, CLOSE_ARTIFACT_SHORTCUT_GUARD_MS)
}

function isCloseGuardActive(): boolean {
  return handledUntil > 0 && Date.now() < handledUntil
}

/** 焦点在产出物上则关掉当前页签并返回 true；同一次按键再进来也返回 true，避免连关两份。 */
export function closeFocusedArtifact(): boolean {
  if (isCloseGuardActive()) return true
  for (const close of [...closers].reverse()) {
    if (close()) { armCloseGuard(); return true }
  }
  return false
}

/** 测试用：清掉按键窗口，避免用例互相污染 */
export function resetCloseArtifactShortcutGuard(): void {
  clearCloseGuard()
}
