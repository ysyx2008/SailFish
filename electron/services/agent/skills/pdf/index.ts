/**
 * PDF 技能
 * 提供扫描版/图片型 PDF 的页面渲染能力，配合视觉模型使用
 */

import { registerSkill } from '../registry'
import type { Skill } from '../types'
import { pdfTools } from './tools'
import { createLogger } from '../../../../utils/logger'

const log = createLogger('PdfSkill')

const pdfSkill: Skill = {
  id: 'pdf',
  name: 'PDF 阅读',
  description: '渲染扫描版/图片型 PDF 的指定页面为图片，配合视觉模型分析内容。当 read_file 读取 PDF 时发现是扫描件（无可提取文本），会自动加载此技能。使用 pdf_view_page 查看指定页面。',
  tools: pdfTools,

  async init() {
    log.info('Initialized')
  },

  async cleanup() {
    log.info('Cleaned up')
  }
}

try {
  registerSkill(pdfSkill)
} catch (error) {
  log.error('Failed to register:', error)
}

export { pdfSkill }
export { executePdfTool } from './executor'
