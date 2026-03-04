/**
 * 用户技能创建技能模块
 * 提供创建、管理用户技能的能力
 */

import { registerSkill } from '../registry'
import type { Skill } from '../types'
import { skillCreatorTools } from './tools'
import { createLogger } from '../../../../utils/logger'

const log = createLogger('SkillCreator')

const skillCreatorSkill: Skill = {
  id: 'skill-creator',
  name: '技能管理',
  description: '创建和管理用户自定义技能（SKILL.md），支持创建、更新、删除。',
  tools: skillCreatorTools,
  
  async init() {
    log.info('Initialized')
  },
  
  async cleanup() {
    log.info('Cleaned up')
  }
}

// 注册技能
try {
  registerSkill(skillCreatorSkill)
} catch (error) {
  log.error('Failed to register:', error)
}

export { skillCreatorSkill }
export { executeSkillCreatorTool } from './executor'
