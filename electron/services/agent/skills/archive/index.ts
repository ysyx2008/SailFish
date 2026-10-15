/**
 * 档案室整理。搜索和放入不在这里，那些是手头一直有的工具。
 */
import { registerSkill } from '../registry'
import type { Skill } from '../types'
import { archiveSkillContent, archiveTools } from './tools'
import { createLogger } from '../../../../utils/logger'

const log = createLogger('ArchiveSkill')

const archiveSkill: Skill = {
  id: 'archive',
  name: '档案室整理',
  description: '整理档案室的目录：建子目录、把已入库的文件挪到别的目录、给目录改名、删掉一个目录。空目录会留下来。',
  tools: archiveTools,
  content: archiveSkillContent,
}

try {
  registerSkill(archiveSkill)
} catch (error) {
  log.error('Failed to register:', error)
}

export { archiveSkill }
export { executeArchiveTool } from './executor'
