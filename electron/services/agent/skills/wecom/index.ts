/**
 * 企业微信技能模块
 * 提供企业微信资源（日历日程、审批、考勤、通讯录）的读写能力
 */

import { registerSkill } from '../registry'
import type { Skill } from '../types'
import { wecomTools } from './tools'
import { cleanup } from './executor'
import { t } from '../../i18n'
import { createLogger } from '../../../../utils/logger'

const log = createLogger('WeComSkill')

const wecomSkill: Skill = {
  id: 'wecom',
  get name() { return t('wecom.skill_name' as any) },
  get description() { return t('wecom.skill_description' as any) },
  tools: wecomTools,
  get content() { return t('wecom.skill_content' as any) },

  async init() {
    log.info('Initialized')
  },

  async cleanup() {
    cleanup()
    log.info('Cleaned up')
  }
}

registerSkill(wecomSkill)

export { wecomSkill }
