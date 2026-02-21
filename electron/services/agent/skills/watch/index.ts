/**
 * 关切技能模块
 * 让 Agent 通过对话自主管理"关切"——持续关注的事项
 */

import { registerSkill } from '../registry'
import type { Skill } from '../types'
import { watchTools } from './tools'

const watchSkill: Skill = {
  id: 'watch',
  name: '关切',
  description: '管理 AI 的关切（关注点），支持创建、查看、修改、删除、触发。关切让 AI 能主动关注并执行任务，包括定时执行、文件监控、邮件触发、日历提醒、心跳唤醒等多种触发方式。',
  tools: watchTools,

  async init() {
    console.log('[WatchSkill] Initialized')
  },

  async cleanup() {
    console.log('[WatchSkill] Cleaned up')
  }
}

try {
  registerSkill(watchSkill)
} catch (error) {
  console.error('[WatchSkill] Failed to register:', error)
}

export { watchSkill }
export { executeWatchTool } from './executor'
