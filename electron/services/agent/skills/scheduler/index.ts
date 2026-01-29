/**
 * 定时任务技能模块
 * 提供定时任务管理能力
 */

import { registerSkill } from '../registry'
import type { Skill } from '../types'
import { schedulerTools } from './tools'

const schedulerSkill: Skill = {
  id: 'scheduler',
  name: '定时任务',
  description: '提供定时任务管理能力，支持创建、查看、修改、删除定时执行的自动化任务。适用于定期巡检、自动备份、定时同步、周期性维护等场景。支持 Cron 表达式、固定间隔、一次性执行三种调度方式，可在本地终端或 SSH 远程主机执行。',
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
