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
  description: '通过引导式对话定义或修改 Agent 的个性、沟通风格和名字。',
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
