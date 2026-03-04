/**
 * 浏览器技能模块
 * 提供浏览器自动化能力
 */

import { registerSkill } from '../registry'
import type { Skill } from '../types'
import { browserTools } from './tools'
import { closeAllSessions } from './session'
import { createLogger } from '../../../../utils/logger'

const log = createLogger('BrowserSkill')

const browserSkill: Skill = {
  id: 'browser',
  name: '浏览器自动化',
  description: '浏览器自动化，通过无障碍树感知页面（非视觉渲染）。支持打开网页、点击、输入、截图、滚动等操作。',
  tools: browserTools,
  
  async init() {
    // playwright-core 会在执行时动态 import，这里不需要预加载
    log.info('Initialized')
  },
  
  async cleanup() {
    // 关闭所有打开的浏览器
    await closeAllSessions()
    log.info('Cleaned up')
  }
}

// 注册技能
registerSkill(browserSkill)

export { browserSkill }

