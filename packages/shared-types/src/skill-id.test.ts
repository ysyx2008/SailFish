import { describe, expect, it } from 'vitest'
import { isSameSkillId, isUserSkillId, parseUserSkillId, toUserSkillId, USER_SKILL_ID_PREFIX } from './skill-id'

describe('技能 id 口径', () => {
  it('前缀常量就是 user:', () => {
    expect(USER_SKILL_ID_PREFIX).toBe('user:')
  })

  it('补前缀：已经带了不重复补', () => {
    expect(toUserSkillId('foo')).toBe('user:foo')
    expect(toUserSkillId('user:foo')).toBe('user:foo')
  })

  it('拆前缀：只认开头那一个，没有名字的不算', () => {
    expect(parseUserSkillId('user:foo')).toBe('foo')
    expect(parseUserSkillId(' user: foo ')).toBe('foo')
    expect(parseUserSkillId('excel')).toBeNull()
    expect(parseUserSkillId('user:')).toBeNull()
    expect(parseUserSkillId('user:user:foo')).toBe('user:foo')
  })

  it('自己装的技能带 user: 前缀，内置的不带', () => {
    expect(isUserSkillId('user:foo')).toBe(true)
    expect(isUserSkillId('excel')).toBe(false)
    expect(isUserSkillId('myuser:foo')).toBe(false)
  })

  it('同一个 id 是同一条', () => {
    expect(isSameSkillId('excel', 'excel')).toBe(true)
    expect(isSameSkillId('user:foo', 'user:foo')).toBe(true)
  })

  it('不同的技能不是同一条', () => {
    expect(isSameSkillId('excel', 'word')).toBe(false)
    expect(isSameSkillId('user:foo', 'user:bar')).toBe(false)
  })

  it('自己写的技能带不带 user: 前缀都是同一条', () => {
    expect(isSameSkillId('user:foo', 'foo')).toBe(true)
    expect(isSameSkillId('foo', 'user:foo')).toBe(true)
  })

  it('只剥掉开头那一个前缀，不乱切', () => {
    expect(isSameSkillId('user:user:foo', 'user:foo')).toBe(false)
    expect(isSameSkillId('myuser:foo', 'foo')).toBe(false)
  })
})
