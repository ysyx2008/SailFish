import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/sft-user-message-notes-unused' },
}))

import { registerSkill } from '../registry'
import { BuiltinSkillEnablement } from '../enablement'
import { collectUserMessageNotes } from '../user-message-notes'
import type { Skill } from '../types'

const ctx = { alreadyInConversation: () => false }

function testSkill(id: string, note: Skill['noteForUserMessage']): Skill {
  return { id, name: id, description: id, tools: [], noteForUserMessage: note }
}

function enablementWith(disabled: string[] = []) {
  return new BuiltinSkillEnablement({ get: key => (key === 'disabledBuiltinSkills' ? disabled : undefined) })
}

describe('collectUserMessageNotes', () => {
  afterEach(() => {
    registerSkill(testSkill('notes-a', undefined))
    registerSkill(testSkill('notes-b', undefined))
  })

  it('开着的技能不必装上也会被问，附注按技能收集', () => {
    registerSkill(testSkill('notes-a', text => (text.includes('梁总') ? '梁总是谁' : undefined)))
    expect(collectUserMessageNotes(enablementWith(), '约梁总', ctx)).toContain('梁总是谁')
    expect(collectUserMessageNotes(enablementWith(), '今天天气', ctx)).not.toContain('梁总是谁')
  })

  it('技能关掉了不问', () => {
    registerSkill(testSkill('notes-a', () => '附注'))
    expect(collectUserMessageNotes(enablementWith(['notes-a']), '随便说', ctx)).not.toContain('附注')
  })

  it('一个技能出错不连累别的', () => {
    registerSkill(testSkill('notes-a', () => { throw new Error('boom') }))
    registerSkill(testSkill('notes-b', () => '还在'))
    expect(collectUserMessageNotes(enablementWith(), '随便说', ctx)).toContain('还在')
  })

  it('空话不问', () => {
    registerSkill(testSkill('notes-a', () => '附注'))
    expect(collectUserMessageNotes(enablementWith(), '  ', ctx)).toEqual([])
  })
})
