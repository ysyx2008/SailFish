/**
 * 邮箱技能模块
 * 提供邮件收发和管理能力
 */

import { registerSkill } from '../registry'
import type { Skill } from '../types'
import { emailTools } from './tools'
import { closeAllSessions } from './session'
import { createLogger } from '../../../../utils/logger'

const log = createLogger('EmailSkill')

const emailSkill: Skill = {
  id: 'email',
  name: '邮箱管理',
  description: '邮件收发和管理，支持连接邮箱账户、读取、搜索、发送和删除邮件。需要收发邮件时优先使用。',
  tools: emailTools,
  
  async init() {
    // 依赖模块会在执行时动态导入
    log.info('Initialized')
  },
  
  async cleanup() {
    // 关闭所有邮箱连接
    await closeAllSessions()
    log.info('Cleaned up')
  }
}

// 注册技能
try {
  registerSkill(emailSkill)
} catch (error) {
  log.error('Failed to register:', error)
}

export { emailSkill }
export { executeEmailTool, setEmailAccounts } from './executor'

