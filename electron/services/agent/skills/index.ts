/**
 * 技能系统入口
 */

// 导出类型
export type { Skill, SkillState, SkillLoadResult, SkillSessionManager } from './types'

// 导出注册表
export { registerSkill, getSkill, getAllSkills, getSkillsSummary, getBuiltinSkillsForSettings, hasSkill } from './registry'

// 导出加载器
export { SkillSession, createSkillSession } from './skill-loader'

// 注册所有技能（在这里导入各个技能模块）
import './excel'
import './email'
import './browser'
import './word'
import './calendar'
import './watch'
import './config'
import './skill-creator'
import './terminal'
import './personality'
import './pdf'

