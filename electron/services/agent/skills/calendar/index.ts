/**
 * 日历技能模块
 * 提供日程管理能力，支持 CalDAV 协议
 */

import { registerSkill } from '../registry'
import type { Skill } from '../types'
import { calendarTools } from './tools'
import { closeAllSessions } from './session'
import { createLogger } from '../../../../utils/logger'

const log = createLogger('CalendarSkill')

const calendarSkill: Skill = {
  id: 'calendar',
  name: '日程管理',
  description: '提供日程/日历管理能力，支持查看、创建、修改、删除日程事件和待办事项（VTODO）。适用于时间管理、会议安排、提醒设置、任务管理等场景。支持 CalDAV 协议的日历服务（Google Calendar、iCloud、Outlook、企业微信等）。',
  tools: calendarTools,
  
  async init() {
    // 依赖模块会在执行时动态导入
    log.info('Initialized')
  },
  
  async cleanup() {
    // 关闭所有日历连接
    await closeAllSessions()
    log.info('Cleaned up')
  }
}

// 注册技能
try {
  registerSkill(calendarSkill)
} catch (error) {
  log.error('Failed to register:', error)
}

export { calendarSkill }
export { executeCalendarTool, setCalendarAccounts } from './executor'
