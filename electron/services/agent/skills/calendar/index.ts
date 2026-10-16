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
  description: '日程管理：查看、创建、修改、删除日历事件。重复日程可写到哪一天为止（含当天），或一共重复几次，两项只填一个；都不填则一直重复。日历待办为 CalDAV VTODO，工具名为 calendar_todo_*（与本地秘书 todo 技能的 todo_* 不同）。支持 CalDAV 协议。',
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
