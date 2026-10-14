/**
 * 本地联系人技能
 * 结构化 CONTACTS.json。不进心跳、不整本带上；用户话里提到谁，附上谁的名片。
 */
import { registerSkill } from '../registry'
import type { Skill } from '../types'
import { contactTools, contactSkillContent } from './tools'
import { getContactBook } from './contact-book'
import { buildMentionNote } from './mentions'
import { createLogger } from '../../../../utils/logger'

const log = createLogger('ContactSkill')

const contactSkill: Skill = {
  id: 'contact',
  name: '本地联系人',
  description:
    '管理用户本地联系人（工作空间 CONTACTS.json）：按姓名/别名/单位/联系方式查找、新增、更新、删除。用于认人、找邮箱和 IM。',
  tools: contactTools,
  content: contactSkillContent,

  noteForUserMessage(text, ctx) {
    return buildMentionNote(getContactBook().list(), text, ctx)
  },

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
