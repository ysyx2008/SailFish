/**
 * 旗鱼配置管理技能
 * 提供应用配置读写和 IM 渠道连接能力
 */

import { registerSkill } from '../registry'
import type { Skill } from '../types'
import { configTools } from './tools'

const configSkill: Skill = {
  id: 'config',
  name: '旗鱼配置管理',
  description: '读取和修改旗鱼应用配置（界面语言、主题、终端设置、Agent 性格、IM 渠道凭证等），以及测试 IM 渠道连接。适用于用户要求调整应用设置、配置 IM 机器人、查看当前配置等场景。',
  tools: configTools,

  async init() {
    console.log('[ConfigSkill] Initialized')
  },

  async cleanup() {
    console.log('[ConfigSkill] Cleaned up')
  }
}

try {
  registerSkill(configSkill)
} catch (error) {
  console.error('[ConfigSkill] Failed to register:', error)
}

export { configSkill }
export { executeConfigTool } from './executor'
