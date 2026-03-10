/**
 * 钉钉技能模块
 * 提供钉钉云端资源（日历日程、待办任务、考勤打卡、通讯录、审批流程、多维表格、钉盘、知识库）的读写能力
 */

import { registerSkill } from '../registry'
import type { Skill } from '../types'
import { dingtalkTools } from './tools'
import { cleanup } from './executor'
import { t } from '../../i18n'
import { createLogger } from '../../../../utils/logger'

const log = createLogger('DingTalkSkill')

const dingtalkSkill: Skill = {
  id: 'dingtalk',
  get name() { return t('dingtalk.skill_name' as any) },
  get description() { return t('dingtalk.skill_description' as any) },
  tools: dingtalkTools,
  get content() { return t('dingtalk.skill_content' as any) },

  async init() {
    log.info('Initialized')
  },

  async cleanup() {
    cleanup()
    log.info('Cleaned up')
  }
}

registerSkill(dingtalkSkill)

export { dingtalkSkill }
