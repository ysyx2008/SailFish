import { afterEach, describe, expect, it } from 'vitest'
import {
  MARKDOWN_SAVE_SHORTCUT_GUARD_MS,
  claimMarkdownSaveShortcut,
  isMarkdownSaveShortcut,
  resetMarkdownSaveShortcutGuard
} from '../domain/markdown-save-shortcut'

describe('isMarkdownSaveShortcut', () => {
  it('Cmd+S / Ctrl+S 算保存', () => {
    expect(isMarkdownSaveShortcut({ key: 's', metaKey: true, ctrlKey: false })).toBe(true)
    expect(isMarkdownSaveShortcut({ key: 's', metaKey: false, ctrlKey: true })).toBe(true)
  })

  it('按住不放、没有修饰键、或不是 S 不算', () => {
    expect(isMarkdownSaveShortcut({ key: 's', metaKey: true, ctrlKey: false, repeat: true })).toBe(false)
    expect(isMarkdownSaveShortcut({ key: 's', metaKey: false, ctrlKey: false })).toBe(false)
    expect(isMarkdownSaveShortcut({ key: 'S', metaKey: true, ctrlKey: false })).toBe(false)
    expect(isMarkdownSaveShortcut({ key: 'l', metaKey: true, ctrlKey: false })).toBe(false)
  })
})

describe('claimMarkdownSaveShortcut', () => {
  afterEach(() => {
    resetMarkdownSaveShortcutGuard()
  })

  it('同一次按键只认领一次，窗口过后可以再来', () => {
    expect(claimMarkdownSaveShortcut(1_000)).toBe(true)
    expect(claimMarkdownSaveShortcut(1_000)).toBe(false)
    expect(claimMarkdownSaveShortcut(1_000 + MARKDOWN_SAVE_SHORTCUT_GUARD_MS - 1)).toBe(false)
    expect(claimMarkdownSaveShortcut(1_000 + MARKDOWN_SAVE_SHORTCUT_GUARD_MS)).toBe(true)
  })
})
