/**
 * 旗鱼配置管理技能
 * 提供应用配置读写和 IM 渠道连接能力
 */

import { registerSkill } from '../registry'
import type { Skill } from '../types'
import { configTools } from './tools'
import { createLogger } from '../../../../utils/logger'

const log = createLogger('ConfigSkill')

const configSkill: Skill = {
  id: 'config',
  name: '旗鱼配置管理',
  description: '读取和修改旗鱼应用配置，管理邮箱/日历账户和 IM 连接。',
  tools: configTools,

  async init() {
    log.info('Initialized')
  },

  async cleanup() {
    log.info('Cleaned up')
  }
}

try {
  registerSkill(configSkill)
} catch (error) {
  log.error('Failed to register:', error)
}

export { configSkill }
export { executeConfigTool } from './executor'
