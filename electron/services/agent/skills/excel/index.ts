/**
 * Excel 技能模块
 * 提供会话式 Excel 文件读写能力
 */

import { registerSkill } from '../registry'
import type { Skill } from '../types'
import { excelTools } from './tools'
import { closeAllSessions } from './session'

const excelSkill: Skill = {
  id: 'excel',
  name: 'Excel 处理',
  description: '提供会话式 Excel 文件读写能力。支持打开文件、读取数据、修改单元格、添加/删除 Sheet、保存和关闭等操作。适用于数据分析、报表处理等场景。',
  tools: excelTools,
  
  async init() {
    // exceljs 会在执行时动态 import，这里不需要预加载
    console.log('[ExcelSkill] Initialized')
  },
  
  async cleanup() {
    // 关闭所有打开的 Excel 文件
    await closeAllSessions()
    console.log('[ExcelSkill] Cleaned up')
  }
}

// 注册技能
registerSkill(excelSkill)

export { excelSkill }

