import { describe, expect, it } from 'vitest'
import {
  skillListKeyAction,
  skillSearchKeyAction,
  stepSkillIndex,
  type SkillListState,
  type SkillPickerKey,
  type SkillSearchState,
} from './skill-picker-keys'

const key = (k: string, extra: Partial<SkillPickerKey> = {}): SkillPickerKey => ({
  key: k,
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  repeat: false,
  isComposing: false,
  ...extra,
})

const search = (extra: Partial<SkillSearchState> = {}): SkillSearchState => ({
  count: 4,
  query: '',
  loading: false,
  ...extra,
})

const list = (extra: Partial<SkillListState> = {}): SkillListState => ({
  index: 1,
  count: 4,
  loading: false,
  ...extra,
})

describe('搜索框', () => {
  it('有技能时 Tab 走进列表，没有就离开', () => {
    expect(skillSearchKeyAction(key('Tab'), search())).toBe('to-list')
    expect(skillSearchKeyAction(key('Tab'), search({ count: 0 }))).toBeNull()
  })

  it('Shift+Tab 离开；按住不放的连发吞掉，免得刚退回来就把面板关掉', () => {
    expect(skillSearchKeyAction(key('Tab', { shiftKey: true }), search())).toBeNull()
    expect(skillSearchKeyAction(key('Tab', { shiftKey: true, repeat: true }), search())).toBe('swallow')
  })

  it('空格仍是字；回车开关；还在加载或没有技能时回车不动', () => {
    expect(skillSearchKeyAction(key(' '), search())).toBeNull()
    expect(skillSearchKeyAction(key('Enter'), search())).toBe('toggle')
    expect(skillSearchKeyAction(key('Enter'), search({ loading: true }))).toBe('swallow')
    expect(skillSearchKeyAction(key('Enter'), search({ count: 0 }))).toBe('swallow')
  })

  it('没打字时方向键走动，打了字之后左右留给改字', () => {
    expect(skillSearchKeyAction(key('ArrowDown'), search())).toBe('move')
    expect(skillSearchKeyAction(key('ArrowLeft'), search())).toBe('move')
    expect(skillSearchKeyAction(key('ArrowLeft'), search({ query: '京' }))).toBeNull()
    expect(skillSearchKeyAction(key('ArrowDown'), search({ query: '京' }))).toBe('move')
  })

  it('Esc 收起；输入法开着、带修饰键，都不抢', () => {
    expect(skillSearchKeyAction(key('Escape'), search())).toBe('close')
    expect(skillSearchKeyAction(key('Tab', { isComposing: true }), search())).toBeNull()
    expect(skillSearchKeyAction(key('Tab', { metaKey: true }), search())).toBeNull()
  })
})

describe('焦点在技能列表上', () => {
  it('Tab 换到下一个，到了最后一个也还是下一步（由步进出头尾停住）', () => {
    expect(skillListKeyAction(key('Tab'), list())).toBe('next')
    expect(skillListKeyAction(key('Tab'), list({ index: 3 }))).toBe('next')
  })

  it('Shift+Tab 换到上一个，已经是第一个才回到搜索框', () => {
    expect(skillListKeyAction(key('Tab', { shiftKey: true }), list({ index: 2 }))).toBe('prev')
    expect(skillListKeyAction(key('Tab', { shiftKey: true }), list({ index: 0 }))).toBe('back-to-search')
  })

  it('空格和回车是开关；加载中不动', () => {
    expect(skillListKeyAction(key(' '), list())).toBe('toggle')
    expect(skillListKeyAction(key('Enter'), list())).toBe('toggle')
    expect(skillListKeyAction(key(' '), list({ loading: true }))).toBe('swallow')
    expect(skillListKeyAction(key('Enter'), list({ loading: true }))).toBe('swallow')
  })

  it('方向键走动，打字和删除回到搜索框', () => {
    expect(skillListKeyAction(key('ArrowRight'), list())).toBe('move')
    expect(skillListKeyAction(key('ArrowUp'), list())).toBe('move')
    expect(skillListKeyAction(key('a'), list())).toBe('type')
    expect(skillListKeyAction(key('京'), list())).toBe('type')
    expect(skillListKeyAction(key('Backspace'), list())).toBe('type')
  })

  it('Esc 收起；输入法开着、带修饰键，都不抢', () => {
    expect(skillListKeyAction(key('Escape'), list())).toBe('close')
    expect(skillListKeyAction(key(' ', { isComposing: true }), list())).toBeNull()
    expect(skillListKeyAction(key('a', { ctrlKey: true }), list())).toBeNull()
    expect(skillListKeyAction(key('Tab', { altKey: true }), list())).toBeNull()
  })
})

describe('走到头就停', () => {
  it('往后到最后一个停住，往前到第一个停住', () => {
    expect(stepSkillIndex(0, 4, 1)).toBe(1)
    expect(stepSkillIndex(3, 4, 1)).toBe(3)
    expect(stepSkillIndex(2, 4, -1)).toBe(1)
    expect(stepSkillIndex(0, 4, -1)).toBe(0)
  })

  it('序号超出范围时先收回来再走', () => {
    expect(stepSkillIndex(9, 3, 1)).toBe(2)
    expect(stepSkillIndex(-2, 3, -1)).toBe(0)
    expect(stepSkillIndex(1, 0, 1)).toBe(0)
  })
})
