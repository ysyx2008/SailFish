/**
 * 技能系统类型定义
 * 技能是一组相关工具的集合，可以按需动态加载
 */

import type { ToolDefinition } from '../tools'
import type { ToolResult } from '../tools/types'

/** 技能在这场对话里的状态数据（跨轮保留，同一份引用，钩子可以直接改） */
export type SkillData = Record<string, unknown>

export interface SkillToolCall {
  name: string
  args: Record<string, unknown>
}

export interface SkillToolCallContext {
  data: SkillData
  /** 按本机文件工具同一套规则把路径解析成绝对路径 */
  resolveLocalPath: (rawPath: string) => string
}

export interface SkillRunStartContext {
  data: SkillData
  isSubAgent: boolean
}

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
  /** false = 默认关着，用户在设置里打开后才进目录、才装得上（高级能力，如编程） */
  defaultEnabled?: boolean
  /** 技能文档（Markdown），加载时注入上下文（同用户技能的 SKILL.md） */
  content?: string
  /**
   * 由系统按处境装卸：不进技能目录、设置页和 @ 列表，人和模型都不能手动装上。
   * 界面胶囊照常显示。
   */
  systemManaged?: boolean
  /** 初始化函数（可选，用于动态 import 依赖库） */
  init?: () => Promise<void>
  /** 清理函数（可选）。主人标识只关这场对话的资源，不能拆掉别的对话还在用的窗口 */
  cleanup?: (ownerId?: string) => Promise<void>
  /** 装着时，本机文件的相对路径和本机命令的默认目录以它为准（如编程技能打开的项目） */
  workingDirectory?: (data: SkillData) => string | undefined
  /** 装着时每轮开始调用一次 */
  onRunStart?: (ctx: SkillRunStartContext) => Promise<void>
  /** 装着时包住每一次工具调用：可以在前后插手，必须调用 proceed 才会真的执行 */
  wrapToolCall?: (
    call: SkillToolCall,
    proceed: () => Promise<ToolResult>,
    ctx: SkillToolCallContext
  ) => Promise<ToolResult>
  /** 派出去的伙计连同状态数据一起带上这份技能 */
  inheritToSubAgents?: boolean
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

