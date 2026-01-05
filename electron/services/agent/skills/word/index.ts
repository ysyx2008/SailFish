/**
 * Word 技能模块
 * 提供会话式 Word 文档创建和编辑能力
 */

import { registerSkill } from '../registry'
import type { Skill } from '../types'
import { wordTools } from './tools'
import { closeAllSessions } from './session'

const wordSkill: Skill = {
  id: 'word',
  name: 'Word 文档处理',
  description: '提供会话式 Word 文档创建和编辑能力。支持创建文档、添加段落/标题/列表/表格、读取内容、保存和关闭等操作。适用于生成报告、文档编写等场景。',
  tools: wordTools,
  
  async init() {
    // docx 库会在执行时动态 import，这里不需要预加载
    console.log('[WordSkill] Initialized')
  },
  
  async cleanup() {
    // 关闭所有打开的 Word 文档
    await closeAllSessions()
    console.log('[WordSkill] Cleaned up')
  }
}

// 注册技能
registerSkill(wordSkill)

export { wordSkill }

