/**
 * 技能系统入口
 */

// 导出类型
export type { Skill, SkillState, SkillLoadResult, SkillSessionManager } from './types'

// 导出注册表
export { registerSkill, getSkill, getAllSkills, getSkillsSummary, hasSkill, isSystemManagedSkill } from './registry'
export { TERMINAL_SKILL_ID } from './terminal'
export { BuiltinSkillEnablement } from './enablement'

// 导出加载器
export { SkillSession, createSkillSession } from './skill-loader'

// 注册所有技能（在这里导入各个技能模块）
import './excel'
import './email'
import './browser'
import './word'
import './calendar'
import './todo'
import './watch'
import './config'
import './skill-creator'
import './terminal'
import './personality'
import './pdf'
import './chart'
import './ppt'
import './feishu'
import './wecom'
import './dingtalk'
import './chinese-writing'
import './chinese-document-official'
import './chinese-document-regulation'

