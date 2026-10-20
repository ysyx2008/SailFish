import { describe, expect, it, vi } from 'vitest'

const messages: Record<string, string> = {
  'skillSettings.builtinSkillNames.todo': 'Local Todos',
  'skillSettings.builtinSkillDescs.todo': 'Manage your local to-do list',
}

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => messages[key] ?? key,
    te: (key: string) => key in messages,
  }),
}))

import { useBuiltinSkillText } from './useBuiltinSkillText'

describe('内置技能的名字和简介', () => {
  const { builtinSkillName, builtinSkillDescription } = useBuiltinSkillText()

  it('有译名就用译名', () => {
    expect(builtinSkillName({ id: 'todo', name: '本地待办' })).toBe('Local Todos')
  })

  it('有译文简介就用译文简介', () => {
    expect(builtinSkillDescription({ id: 'todo', description: '管理本地待办' })).toBe('Manage your local to-do list')
  })

  it('表里没有的（新增还没翻的）用后端给的原文', () => {
    expect(builtinSkillName({ id: 'brand-new', name: '新技能' })).toBe('新技能')
    expect(builtinSkillDescription({ id: 'brand-new', description: '新技能简介' })).toBe('新技能简介')
  })

  it('原文简介也没有时是空串，不是 undefined', () => {
    expect(builtinSkillDescription({ id: 'brand-new' })).toBe('')
  })
})
