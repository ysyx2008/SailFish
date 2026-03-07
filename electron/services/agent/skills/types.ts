/**
 * 技能系统类型定义
 * 技能是一组相关工具的集合，可以按需动态加载
 */

import type { ToolDefinition } from '../tools'

/**
 * 技能定义接口
 */
export interface Skill {
  /** 技能唯一标识 */
  id: string
  /** 技能名称（用于显示） */
  name: string
  /** 技能描述（给 AI 看的，说明这个技能能做什么） */
  description: string
  /** 该技能提供的工具列表 */
  tools: ToolDefinition[]
  /** 技能文档（Markdown），加载时注入上下文（同用户技能的 SKILL.md） */
  content?: string
  /** 初始化函数（可选，用于动态 import 依赖库） */
  init?: () => Promise<void>
  /** 清理函数（可选，用于关闭未保存的文件等资源） */
  cleanup?: () => Promise<void>
}

/**
 * 技能状态
 */
export interface SkillState {
  /** 技能 ID */
  skillId: string
  /** 是否已加载 */
  loaded: boolean
  /** 加载时间 */
  loadedAt?: number
  /** 技能特定的状态数据 */
  data?: Record<string, unknown>
}

/**
 * 技能加载结果
 */
export interface SkillLoadResult {
  success: boolean
  skillId: string
  skillName?: string
  toolsAdded?: string[]
  error?: string
}

/**
 * 技能会话管理器接口
 */
export interface SkillSessionManager {
  /** 获取已加载的技能列表 */
  getLoadedSkills(): string[]
  /** 加载技能 */
  loadSkill(skillId: string): Promise<SkillLoadResult>
  /** 卸载技能 */
  unloadSkill(skillId: string): Promise<void>
  /** 获取所有可用工具（核心工具 + 已加载技能的工具） */
  getAvailableTools(): ToolDefinition[]
  /** 更新核心工具列表（上下文变化时刷新） */
  updateCoreTools(coreTools: ToolDefinition[]): void
  /** 清理所有技能状态 */
  cleanup(): Promise<void>
}

