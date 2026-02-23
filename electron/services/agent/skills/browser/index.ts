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
  description: `提供浏览器自动化能力。你通过无障碍树（Accessibility Tree）感知页面结构，而非直接看到页面——颜色、图标、纯视觉提示不在树中。操作前请通过快照获取 ref 编号，表单中 [必填] 字段需在提交前填写完整。如需确认视觉效果可用 browser_screenshot。支持打开网页、截图、获取内容、点击、输入、滚动等操作。浏览器窗口会显示在屏幕上，用户可以看到操作过程。

**能力与限制提示**：本技能基于 Playwright 的自动化能力对 AI 而言仍相对有限，并非「所见即所得」的完美控制。操作失败或结果与预期不符时，请优先考虑选择器不准、页面未加载完、弹窗/iframe 等常见原因，适度重试或换用其他方式（如换 selector、先 browser_wait），避免在未明确原因时频繁重复同一操作。`,
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

