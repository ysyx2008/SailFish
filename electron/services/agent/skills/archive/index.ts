/**
 * 知识库整理。搜索和放入不在这里，那些是手头一直有的工具。
 */
import { registerSkill } from '../registry'
import type { Skill } from '../types'
import { archiveTools } from './tools'
import { createLogger } from '../../../../utils/logger'

const log = createLogger('ArchiveSkill')

const archiveSkill: Skill = {
  id: 'archive',
  name: '知识库管理',
  description: '管理知识库：把本机文件放进去、删除一份、建目录、挪动文件、给目录改名、删除目录。',
  tools: archiveTools,
}

try {
  registerSkill(archiveSkill)
} catch (error) {
  log.error('Failed to register:', error)
}

export { archiveSkill }
export { executeArchiveTool } from './executor'
