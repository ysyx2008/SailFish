/**
 * 浏览器技能模块
 * 提供浏览器自动化能力
 */

import { registerSkill } from '../registry'
import type { Skill } from '../types'
import { browserTools } from './tools'
import { closeAllSessions } from './session'

const browserSkill: Skill = {
  id: 'browser',
  name: '浏览器自动化',
  description: '提供浏览器自动化能力。支持打开网页、截图、获取内容、点击、输入、滚动等操作。适用于网页数据采集、自动化测试、表单填写等场景。浏览器窗口会显示在屏幕上，用户可以看到操作过程。',
  tools: browserTools,
  
  async init() {
    // playwright-core 会在执行时动态 import，这里不需要预加载
    console.log('[BrowserSkill] Initialized')
  },
  
  async cleanup() {
    // 关闭所有打开的浏览器
    await closeAllSessions()
    console.log('[BrowserSkill] Cleaned up')
  }
}

// 注册技能
registerSkill(browserSkill)

export { browserSkill }

