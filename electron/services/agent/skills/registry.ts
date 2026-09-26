/**
 * 技能注册表
 * 管理所有可用技能的注册和查询
 */

import type { Skill } from './types'
import { createLogger } from '../../../utils/logger'

const log = createLogger('SkillRegistry')

// 技能注册表（技能 ID -> 技能定义）
const skillRegistry = new Map<string, Skill>()

/**
 * 注册技能
 */
export function registerSkill(skill: Skill): void {
  if (skillRegistry.has(skill.id)) {
    log.warn(`Skill "${skill.id}" is already registered, overwriting...`)
  }
  skillRegistry.set(skill.id, skill)
  log.info(`Registered skill: ${skill.id} (${skill.tools.length} tools)`)
}

/**
 * 获取技能
 */
export function getSkill(skillId: string): Skill | undefined {
  return skillRegistry.get(skillId)
}

/**
 * 获取所有已注册的技能
 */
export function getAllSkills(): Skill[] {
  return Array.from(skillRegistry.values())
}

/** 能让人或模型挑选的技能（排除由系统按处境装卸的） */
function selectableSkills(): Skill[] {
  return Array.from(skillRegistry.values()).filter(skill => !skill.systemManaged)
}

export function isSystemManagedSkill(skillId: string): boolean {
  return skillRegistry.get(skillId)?.systemManaged === true
}

/**
 * 获取技能列表摘要（用于显示给 AI）
 */
export function getSkillsSummary(): { id: string; name: string; description: string }[] {
  return selectableSkills().map(skill => ({
    id: skill.id,
    name: skill.name,
    description: skill.description
  }))
}

/**
 * 获取内置技能列表（用于设置页展示）
 */
export function getBuiltinSkillsForSettings(disabledIds: string[]): { id: string; name: string; description: string; enabled: boolean }[] {
  const disabledSet = new Set(disabledIds)
  return selectableSkills().map(skill => ({
    id: skill.id,
    name: skill.name,
    description: skill.description,
    enabled: !disabledSet.has(skill.id)
  }))
}

/**
 * 检查技能是否存在
 */
export function hasSkill(skillId: string): boolean {
  return skillRegistry.has(skillId)
}

