/**
 * 个性定义技能（SoulCraft）
 * 通过引导式对话帮助用户定义 Agent 的个性、沟通风格和价值观
 */

import { registerSkill } from '../registry'
import type { Skill } from '../types'
import { personalityTools } from './tools'
import { createLogger } from '../../../../utils/logger'

const log = createLogger('PersonalitySkill')

const personalitySkill: Skill = {
  id: 'personality',
  name: '个性定义',
  description: '通过引导式对话定义或修改 Agent 的个性、沟通风格、价值观和名字。适用于用户想要自定义 AI 助手的性格、说话方式、行为偏好，或说"帮我设计一个个性"、"我想改一下你的风格"、"你能不能更直接一点"等场景。使用流程：先用 personality_get 读取现状 → 与用户对话了解偏好 → personality_preview 预览 → 用户确认后 personality_craft 写入。',
  tools: personalityTools,

  async init() {
    log.info('Initialized')
  },

  async cleanup() {
    log.info('Cleaned up')
  }
}

try {
  registerSkill(personalitySkill)
} catch (error) {
  log.error('Failed to register:', error)
}

export { personalitySkill }
export { executePersonalityTool } from './executor'
