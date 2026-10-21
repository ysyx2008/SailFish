/**
 * 技能面板的 Tab / 空格：搜索框和下面的标签各按各的键。
 * 只判断这一下该干什么，不碰焦点。
 */

export interface SkillPickerKey {
  key: string
  shiftKey: boolean
  isComposing: boolean
}

/** 搜索框里按 Tab，且下面有技能可去：焦点交给列表，面板不收。 */
export function tabMovesToSkillList(event: SkillPickerKey, hasSkills: boolean): boolean {
  return event.key === 'Tab' && !event.shiftKey && !event.isComposing && hasSkills
}

export type SkillListKeyAction = 'toggle' | 'back-to-search' | 'close' | 'move'

/**
 * 焦点在技能列表上时这一下要干什么。
 * null：交给浏览器（比如 Tab 离开面板）。
 */
export function skillListKeyAction(event: SkillPickerKey): SkillListKeyAction | null {
  if (event.isComposing) return null
  if (event.key === 'Escape') return 'close'
  if (event.key === 'Tab') return event.shiftKey ? 'back-to-search' : null
  if (event.key === ' ' || event.key === 'Enter') return 'toggle'
  if (event.key === 'ArrowUp' || event.key === 'ArrowDown' || event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    return 'move'
  }
  return null
}
