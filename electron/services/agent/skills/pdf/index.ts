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
  description: '渲染扫描版 PDF 页面为图片供视觉模型分析。read_file 遇扫描件时自动加载。',
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
