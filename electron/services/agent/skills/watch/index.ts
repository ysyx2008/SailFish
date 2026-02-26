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
  description: '关切 = 到点或触发时由 AI **自动执行**你设定的任务（如每天检查、文件变化时执行、收到邮件时处理），结果可推送到桌面/IM。支持 cron/间隔/文件监控/邮件/日历事件/webhook 等触发。与「日程」不同：日程只在日历记一条、到点提醒；关切是到时 AI 真的去执行指令。用户说「每天帮我做 X」「到点自动检查 Y」时用本技能。',
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
