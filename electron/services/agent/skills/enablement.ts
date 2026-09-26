/**
 * 内置技能启用状态
 *
 * 两类技能：
 * - 默认开着的：用户在设置里关掉后进 `disabledBuiltinSkills`
 * - 默认关着的（`Skill.defaultEnabled === false`，如编程）：用户在设置里打开后进 `enabledOptInSkills`
 *
 * 「这个内置技能开着吗」只在这里回答，技能目录、装技能、重开恢复、设置页都问它。
 */

import { getAllSkills, getSkill } from './registry'
import type { Skill } from './types'

export interface SkillEnablementConfigReader {
  get?(key: string): unknown
}

export interface SkillEnablementConfigStore extends SkillEnablementConfigReader {
  set(key: string, value: unknown): void
}

const DISABLED_KEY = 'disabledBuiltinSkills'
const OPT_IN_KEY = 'enabledOptInSkills'

function readIdSet(config: SkillEnablementConfigReader | undefined, key: string): Set<string> {
  const raw = config?.get?.(key)
  if (!Array.isArray(raw)) return new Set()
  return new Set(raw.filter((id): id is string => typeof id === 'string'))
}

function selectableSkills(): Skill[] {
  return getAllSkills().filter(skill => !skill.systemManaged)
}

export function isOptInSkill(skill: Pick<Skill, 'defaultEnabled'>): boolean {
  return skill.defaultEnabled === false
}

export class BuiltinSkillEnablement {
  constructor(private readonly config: SkillEnablementConfigReader | undefined) {}

  /** 未注册的技能一律算没开；系统按处境装卸的不归用户开关，一律算开着 */
  isEnabled(skillId: string): boolean {
    const skill = getSkill(skillId)
    if (!skill) return false
    if (skill.systemManaged) return true
    if (isOptInSkill(skill)) return readIdSet(this.config, OPT_IN_KEY).has(skillId)
    return !readIdSet(this.config, DISABLED_KEY).has(skillId)
  }

  /** 给模型挑的技能目录：开着的，且不是系统装卸的 */
  enabledSkills(): Skill[] {
    return selectableSkills().filter(skill => this.isEnabled(skill.id))
  }

  listForSettings(): { id: string; name: string; description: string; enabled: boolean }[] {
    return selectableSkills().map(skill => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      enabled: this.isEnabled(skill.id),
    }))
  }

  setEnabled(skillId: string, enabled: boolean): void {
    const store = this.config as SkillEnablementConfigStore
    const skill = getSkill(skillId)
    const key = skill && isOptInSkill(skill) ? OPT_IN_KEY : DISABLED_KEY
    const ids = readIdSet(store, key)
    const listed = key === OPT_IN_KEY ? enabled : !enabled
    if (listed) ids.add(skillId)
    else ids.delete(skillId)
    store.set(key, Array.from(ids))
  }
}
