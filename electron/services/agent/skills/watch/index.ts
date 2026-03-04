/**
 * 关切技能模块
 * 让 Agent 通过对话自主管理"关切"——持续关注的事项
 */

import { registerSkill } from '../registry'
import type { Skill } from '../types'
import { watchTools } from './tools'
import { createLogger } from '../../../../utils/logger'

const log = createLogger('WatchSkill')

const watchSkill: Skill = {
  id: 'watch',
  name: '关切',
  description: '到点或触发时由 AI 自动执行任务并推送结果。支持 cron/间隔/文件监控/邮件/日历/webhook 触发。',
  tools: watchTools,

  async init() {
    log.info('Initialized')
  },

  async cleanup() {
    log.info('Cleaned up')
  }
}

try {
  registerSkill(watchSkill)
} catch (error) {
  log.error('Failed to register:', error)
}

export { watchSkill }
export { executeWatchTool } from './executor'
