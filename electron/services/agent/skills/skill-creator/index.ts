/**
 * 用户技能创建技能模块
 * 提供创建、管理用户技能的能力
 */

import { registerSkill } from '../registry'
import type { Skill } from '../types'
import { skillCreatorTools } from './tools'

const skillCreatorSkill: Skill = {
  id: 'skill-creator',
  name: '技能管理',
  description: '创建和管理用户技能。可以将操作流程、最佳实践、领域知识保存为可复用的技能文件，供后续任务参考使用。支持创建、更新、删除技能。',
  tools: skillCreatorTools,
  
  async init() {
    console.log('[SkillCreatorSkill] Initialized')
  },
  
  async cleanup() {
    console.log('[SkillCreatorSkill] Cleaned up')
  }
}

// 注册技能
try {
  registerSkill(skillCreatorSkill)
} catch (error) {
  console.error('[SkillCreatorSkill] Failed to register:', error)
}

export { skillCreatorSkill }
export { executeSkillCreatorTool } from './executor'
