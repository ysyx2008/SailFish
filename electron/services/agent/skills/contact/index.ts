/**
 * 本地联系人技能
 * 结构化 CONTACTS.json。用到才查，不进心跳。
 */
import { registerSkill } from '../registry'
import type { Skill } from '../types'
import { contactTools, contactSkillContent } from './tools'
import { createLogger } from '../../../../utils/logger'

const log = createLogger('ContactSkill')

const contactSkill: Skill = {
  id: 'contact',
  name: '本地联系人',
  description:
    '管理用户本地联系人（工作空间 CONTACTS.json）：按姓名/别名/单位/联系方式查找、新增、更新、删除。用于认人、找邮箱和 IM。',
  tools: contactTools,
  content: contactSkillContent,

  async init() {
    log.info('Initialized')
  },

  async cleanup() {
    log.info('Cleaned up')
  },
}

try {
  registerSkill(contactSkill)
} catch (error) {
  log.error('Failed to register:', error)
}

export { contactSkill }
export { executeContactTool } from './executor'
