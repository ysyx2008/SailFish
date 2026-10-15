import { describe, it, expect, afterEach } from 'vitest'
import { builtinSkillNames } from '@shared/builtin-skill-names'
import { builtinSkillDisplayName, t, updateLocale } from '../i18n'

describe('builtin skill display names', () => {
  afterEach(() => updateLocale('zh-CN'))

  it('中英文覆盖同一批技能', () => {
    expect(Object.keys(builtinSkillNames['en-US']).sort())
      .toEqual(Object.keys(builtinSkillNames['zh-CN']).sort())
  })

  it('加载提示用当前语言的名字，不用技能编号', () => {
    updateLocale('zh-CN')
    expect(t('skill.loading', { id: builtinSkillDisplayName('contact') }))
      .toBe('正在加载技能: 本地联系人')

    updateLocale('en-US')
    expect(t('skill.loading', { id: builtinSkillDisplayName('contact') }))
      .toBe('Loading skill: Local Contacts')
  })

  it('没有译文时用作者起的名字，再没有才用编号', () => {
    updateLocale('zh-CN')
    expect(builtinSkillDisplayName('my-pack', '视频下载器')).toBe('视频下载器')
    expect(builtinSkillDisplayName('my-pack')).toBe('my-pack')
  })
})
