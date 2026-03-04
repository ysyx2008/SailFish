/**
 * Word 技能模块
 * 提供会话式 Word 文档创建和编辑能力
 */

import { registerSkill } from '../registry'
import type { Skill } from '../types'
import { wordTools } from './tools'
import { closeAllSessions } from './session'
import { createLogger } from '../../../../utils/logger'

const log = createLogger('WordSkill')

const wordSkill: Skill = {
  id: 'word',
  name: 'Word 文档处理',
  description: 'Word 文档创建和编辑，支持段落/标题/列表/表格/样式管理。',
  tools: wordTools,
  
  async init() {
    // docx 库会在执行时动态 import，这里不需要预加载
    log.info('Initialized')
  },
  
  async cleanup() {
    // 关闭所有打开的 Word 文档
    await closeAllSessions()
    log.info('Cleaned up')
  }
}

// 注册技能
registerSkill(wordSkill)

export { wordSkill }

