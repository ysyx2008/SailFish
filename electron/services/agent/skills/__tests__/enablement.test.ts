import { describe, it, expect, beforeAll } from 'vitest'
import { registerSkill } from '../registry'
import { BuiltinSkillEnablement } from '../enablement'

function memoryConfig(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...initial }
  return {
    data,
    get: (key: string) => data[key],
    set: (key: string, value: unknown) => { data[key] = value },
  }
}

describe('BuiltinSkillEnablement', () => {
  beforeAll(() => {
    registerSkill({ id: 'test-regular', name: '普通', description: '', tools: [] })
    registerSkill({ id: 'test-opt-in', name: '默认关', description: '', tools: [], defaultEnabled: false })
    registerSkill({ id: 'test-system', name: '系统装卸', description: '', tools: [], systemManaged: true })
  })

  it('普通技能默认开，进禁用列表才关', () => {
    expect(new BuiltinSkillEnablement(memoryConfig()).isEnabled('test-regular')).toBe(true)
    expect(new BuiltinSkillEnablement(memoryConfig({ disabledBuiltinSkills: ['test-regular'] })).isEnabled('test-regular')).toBe(false)
  })

  it('默认关的技能：老配置、没配置都算关着', () => {
    expect(new BuiltinSkillEnablement(undefined).isEnabled('test-opt-in')).toBe(false)
    expect(new BuiltinSkillEnablement(memoryConfig({ disabledBuiltinSkills: [] })).isEnabled('test-opt-in')).toBe(false)
  })

  it('默认关的技能进了打开列表才开，且不受禁用列表影响', () => {
    const on = new BuiltinSkillEnablement(memoryConfig({ enabledOptInSkills: ['test-opt-in'], disabledBuiltinSkills: ['test-opt-in'] }))
    expect(on.isEnabled('test-opt-in')).toBe(true)
  })

  it('未注册的技能一律算没开', () => {
    expect(new BuiltinSkillEnablement(memoryConfig()).isEnabled('no-such-skill')).toBe(false)
  })

  it('开关各写各的列表', () => {
    const config = memoryConfig()
    const enablement = new BuiltinSkillEnablement(config)

    enablement.setEnabled('test-opt-in', true)
    expect(config.data.enabledOptInSkills).toEqual(['test-opt-in'])
    expect(config.data.disabledBuiltinSkills).toBeUndefined()
    expect(enablement.isEnabled('test-opt-in')).toBe(true)

    enablement.setEnabled('test-regular', false)
    expect(config.data.disabledBuiltinSkills).toEqual(['test-regular'])

    enablement.setEnabled('test-opt-in', false)
    enablement.setEnabled('test-regular', true)
    expect(config.data.enabledOptInSkills).toEqual([])
    expect(config.data.disabledBuiltinSkills).toEqual([])
  })

  it('设置页清单和技能目录都按同一规则', () => {
    const enablement = new BuiltinSkillEnablement(memoryConfig())
    const listed = enablement.listForSettings()
    expect(listed.find(s => s.id === 'test-opt-in')?.enabled).toBe(false)
    expect(listed.find(s => s.id === 'test-regular')?.enabled).toBe(true)
    const ids = enablement.enabledSkills().map(s => s.id)
    expect(ids).toContain('test-regular')
    expect(ids).not.toContain('test-opt-in')
  })

  it('系统装卸的技能不归用户开关：总算开着，但不进设置页和技能目录', () => {
    const enablement = new BuiltinSkillEnablement(memoryConfig({ disabledBuiltinSkills: ['test-system'] }))
    expect(enablement.isEnabled('test-system')).toBe(true)
    expect(enablement.listForSettings().map(s => s.id)).not.toContain('test-system')
    expect(enablement.enabledSkills().map(s => s.id)).not.toContain('test-system')
  })
})
