/**
 * 飞书技能模块
 * 提供飞书云端资源（多维表格、云文档、电子表格、日历、任务、云空间）的读写能力
 */

import { registerSkill } from '../registry'
import type { Skill } from '../types'
import { feishuTools } from './tools'
import { cleanup } from './executor'
import { t } from '../../i18n'
import { createLogger } from '../../../../utils/logger'

const log = createLogger('FeishuSkill')

const feishuSkill: Skill = {
  id: 'feishu',
  get name() { return t('feishu.skill_name') },
  get description() { return t('feishu.skill_description') },
  tools: feishuTools,
  get content() { return t('feishu.skill_content') },

  async init() {
    log.info('Initialized')
  },

  async cleanup() {
    cleanup()
    log.info('Cleaned up')
  }
}

registerSkill(feishuSkill)

export { feishuSkill }
