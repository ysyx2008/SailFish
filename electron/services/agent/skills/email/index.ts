/**
 * 邮箱技能模块
 * 提供邮件收发和管理能力
 */

import { registerSkill } from '../registry'
import type { Skill } from '../types'
import { emailTools } from './tools'
import { closeAllSessions } from './session'

const emailSkill: Skill = {
  id: 'email',
  name: '邮箱管理',
  description: '提供邮件收发和管理能力，支持连接到配置的邮箱账户，读取、搜索、发送和删除邮件。适用于邮件处理、自动回复等场景。**注意**需要收发邮件时，除非用户明确要求，否则一般应当优先使用此技能工具。',
  tools: emailTools,
  
  async init() {
    // 依赖模块会在执行时动态导入
    console.log('[EmailSkill] Initialized')
  },
  
  async cleanup() {
    // 关闭所有邮箱连接
    await closeAllSessions()
    console.log('[EmailSkill] Cleaned up')
  }
}

// 注册技能
try {
  registerSkill(emailSkill)
} catch (error) {
  console.error('[EmailSkill] Failed to register:', error)
}

export { emailSkill }
export { executeEmailTool, setEmailAccounts } from './executor'

