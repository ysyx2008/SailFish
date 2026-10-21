/**
 * 技能面板的键盘：搜索框负责打字，走进列表之后 Tab 在技能之间换，不会把面板关掉。
 * 只判断这一下该干什么，不碰焦点。
 */

export interface SkillPickerKey {
  key: string
  shiftKey: boolean
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  repeat: boolean
  isComposing: boolean
}

export interface SkillSearchState {
  count: number
  /** 搜索框里已有的字。有字时，左右留给移动光标 */
  query: string
  loading: boolean
}

/** 搜索框里这一下。null：交给浏览器，焦点会离开面板，面板收起。 */
export type SkillSearchKeyAction = 'to-list' | 'close' | 'move' | 'toggle' | 'swallow'

/**
 * 还在搜索框里。
 * Tab 走进列表（落在当前这个技能上）；没有技能可去时 Tab 离开。
 * Shift+Tab 离开；按住不放的连发吞掉，避免刚从列表退回来就顺势把面板关掉。
 */
export function skillSearchKeyAction(event: SkillPickerKey, state: SkillSearchState): SkillSearchKeyAction | null {
  if (event.isComposing || modified(event)) return null
  if (event.key === 'Escape') return 'close'
  if (event.key === 'Tab') {
    if (event.shiftKey) return event.repeat ? 'swallow' : null
    return state.count > 0 ? 'to-list' : null
  }
  if (event.key === 'Enter') {
    if (state.loading || state.count <= 0) return 'swallow'
    return 'toggle'
  }
  if (isArrow(event.key)) {
    const horizontal = event.key === 'ArrowLeft' || event.key === 'ArrowRight'
    if (horizontal && state.query) return null
    if (state.count <= 0) return null
    return 'move'
  }
  return null
}

export interface SkillListState {
  index: number
  count: number
  loading: boolean
}

/** 焦点已经在技能列表上。null：这个键不归列表（修饰键之类）。 */
export type SkillListKeyAction = 'toggle' | 'back-to-search' | 'close' | 'move' | 'next' | 'prev' | 'type' | 'swallow'

/**
 * Tab 换到下一个，到最后一个停住。
 * Shift+Tab 换到上一个，已经是第一个就回到搜索框。
 * 打字和删除回到搜索框，字进搜索框。
 */
export function skillListKeyAction(event: SkillPickerKey, state: SkillListState): SkillListKeyAction | null {
  if (event.isComposing || modified(event)) return null
  if (event.key === 'Escape') return 'close'
  if (event.key === 'Tab') {
    if (event.shiftKey) return state.index <= 0 ? 'back-to-search' : 'prev'
    return 'next'
  }
  if (event.key === ' ' || event.key === 'Enter') return state.loading ? 'swallow' : 'toggle'
  if (isArrow(event.key)) return state.count > 0 ? 'move' : 'swallow'
  if (event.key === 'Backspace' || event.key.length === 1) return 'type'
  return null
}

/** 下一个 / 上一个技能。头尾停住，不绕回，也不离开列表。 */
export function stepSkillIndex(index: number, count: number, delta: number): number {
  if (count <= 0) return 0
  const cur = Math.max(0, Math.min(index, count - 1))
  return Math.max(0, Math.min(cur + delta, count - 1))
}

function modified(event: SkillPickerKey): boolean {
  return event.metaKey || event.ctrlKey || event.altKey
}

function isArrow(key: string): boolean {
  return key === 'ArrowUp' || key === 'ArrowDown' || key === 'ArrowLeft' || key === 'ArrowRight'
}
