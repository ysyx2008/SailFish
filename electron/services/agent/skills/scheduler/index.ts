/**
 * 定时任务技能模块
 * 提供定时任务管理能力
 */

import { registerSkill } from '../registry'
import type { Skill } from '../types'
import { schedulerTools } from './tools'

const schedulerSkill: Skill = {
  id: 'scheduler',
  name: '定时任务（已废弃）',
  description: '【已废弃】旧版定时任务系统已整合到"关切"系统。请优先使用 watch_* 工具管理定时执行的任务。旧的 schedule_* 工具仍可使用但将在未来版本移除。',
  tools: schedulerTools,
  
  async init() {
    console.log('[SchedulerSkill] Initialized')
  },
  
  async cleanup() {
    console.log('[SchedulerSkill] Cleaned up')
  }
}

// 注册技能
try {
  registerSkill(schedulerSkill)
} catch (error) {
  console.error('[SchedulerSkill] Failed to register:', error)
}

export { schedulerSkill }
export { executeSchedulerTool } from './executor'
