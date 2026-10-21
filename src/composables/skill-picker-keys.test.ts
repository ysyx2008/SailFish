import { describe, expect, it } from 'vitest'
import { skillListKeyAction, tabMovesToSkillList, type SkillPickerKey } from './skill-picker-keys'

const key = (k: string, extra: Partial<SkillPickerKey> = {}): SkillPickerKey => ({
  key: k,
  shiftKey: false,
  isComposing: false,
  ...extra,
})

describe('搜索框里的 Tab', () => {
  it('下面有技能时，Tab 把焦点交给列表', () => {
    expect(tabMovesToSkillList(key('Tab'), true)).toBe(true)
  })

  it('没有技能、往回跳、输入法开着，都不抢 Tab', () => {
    expect(tabMovesToSkillList(key('Tab'), false)).toBe(false)
    expect(tabMovesToSkillList(key('Tab', { shiftKey: true }), true)).toBe(false)
    expect(tabMovesToSkillList(key('Tab', { isComposing: true }), true)).toBe(false)
  })

  it('空格仍是搜索框里的字，不拿来选技能', () => {
    expect(tabMovesToSkillList(key(' '), true)).toBe(false)
  })
})

describe('焦点在技能列表上', () => {
  it('空格和回车是开关，Shift+Tab 回到搜索框，Esc 收起', () => {
    expect(skillListKeyAction(key(' '))).toBe('toggle')
    expect(skillListKeyAction(key('Enter'))).toBe('toggle')
    expect(skillListKeyAction(key('Tab', { shiftKey: true }))).toBe('back-to-search')
    expect(skillListKeyAction(key('Escape'))).toBe('close')
  })

  it('方向键在列表里走', () => {
    expect(skillListKeyAction(key('ArrowRight'))).toBe('move')
    expect(skillListKeyAction(key('ArrowUp'))).toBe('move')
  })

  it('Tab 离开列表，交给浏览器', () => {
    expect(skillListKeyAction(key('Tab'))).toBeNull()
  })

  it('输入法开着时这些键都不抢', () => {
    expect(skillListKeyAction(key(' ', { isComposing: true }))).toBeNull()
    expect(skillListKeyAction(key('Enter', { isComposing: true }))).toBeNull()
  })
})
