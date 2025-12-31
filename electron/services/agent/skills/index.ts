/**
 * 技能系统入口
 */

// 导出类型
export type { Skill, SkillState, SkillLoadResult, SkillSessionManager } from './types'

// 导出注册表
export { registerSkill, getSkill, getAllSkills, getSkillsSummary, hasSkill } from './registry'

// 导出加载器
export { SkillSession, createSkillSession } from './skill-loader'

// 注册所有技能（在这里导入各个技能模块）
import './excel'

