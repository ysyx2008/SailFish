/**
 * 技能加载器
 * 管理技能的动态加载和会话状态
 */

import type { Skill, SkillData, SkillState, SkillLoadResult, SkillSessionManager, SkillToolCall } from './types'
import type { ToolDefinition } from '../tools'
import type { ToolResult } from '../tools/types'
import { getSkill, getSkillsSummary } from './registry'
import { createLogger } from '../../../utils/logger'

const log = createLogger('SkillLoader')

/**
 * 技能会话管理器实现
 * 每个 Agent 会话应该有一个独立的实例
 */
export class SkillSession implements SkillSessionManager {
  /** 已加载的技能状态 */
  private loadedSkills: Map<string, SkillState> = new Map()
  /** 核心工具（始终可用） */
  private coreTools: ToolDefinition[] = []
  private onChange?: () => void
  /** 这场对话的主人标识；卸技能时只关自己的资源 */
  private readonly ownerId?: string

  constructor(coreTools: ToolDefinition[], ownerId?: string) {
    this.coreTools = coreTools
    this.ownerId = ownerId
  }

  setOnChange(onChange: () => void): void {
    this.onChange = onChange
  }

  private notifyChange(): void {
    this.onChange?.()
  }

  /**
   * 更新核心工具列表
   * 当运行上下文变化时（如 remoteChannel 不同），需要刷新核心工具
   */
  updateCoreTools(coreTools: ToolDefinition[]): void {
    this.coreTools = coreTools
  }

  /**
   * 获取已加载的技能 ID 列表
   */
  getLoadedSkills(): string[] {
    return Array.from(this.loadedSkills.keys())
  }

  /**
   * 加载技能
   */
  async loadSkill(skillId: string): Promise<SkillLoadResult> {
    // 检查是否已加载
    if (this.loadedSkills.has(skillId)) {
      return {
        success: true,
        skillId,
        skillName: getSkill(skillId)?.name,
        error: 'Skill already loaded'
      }
    }

    // 获取技能定义
    const skill = getSkill(skillId)
    if (!skill) {
      return {
        success: false,
        skillId,
        error: `Skill "${skillId}" not found`
      }
    }

    try {
      // 执行技能初始化（如动态 import 依赖）
      if (skill.init) {
        await skill.init()
      }

      // 记录加载状态
      this.loadedSkills.set(skillId, {
        skillId,
        loaded: true,
        loadedAt: Date.now(),
        data: {}
      })
      this.notifyChange()

      return {
        success: true,
        skillId,
        skillName: skill.name,
        toolsAdded: skill.tools.map(t => t.function.name)
      }
    } catch (error) {
      return {
        success: false,
        skillId,
        error: error instanceof Error ? error.message : 'Failed to initialize skill'
      }
    }
  }

  /**
   * 卸载技能
   */
  async unloadSkill(skillId: string): Promise<void> {
    const skill = getSkill(skillId)
    if (skill?.cleanup) {
      try {
        await skill.cleanup(this.ownerId)
      } catch (error) {
        log.error(`Error cleaning up skill "${skillId}":`, error)
      }
    }
    this.loadedSkills.delete(skillId)
    this.notifyChange()
  }

  /**
   * 获取所有可用工具（核心工具 + 已加载技能的工具）
   * 技能工具同名时会覆写核心工具（技能优先）
   */
  getAvailableTools(): ToolDefinition[] {
    const skillTools: ToolDefinition[] = []
    const loadedIds = Array.from(this.loadedSkills.keys())
    for (const skillId of loadedIds) {
      const skill = getSkill(skillId)
      if (skill) {
        skillTools.push(...skill.tools)
      }
    }
    
    if (skillTools.length === 0) {
      return [...this.coreTools]
    }
    
    const skillToolNames = new Set(skillTools.map(t => t.function.name))
    const filtered = this.coreTools.filter(t => !skillToolNames.has(t.function.name))
    return [...filtered, ...skillTools]
  }

  /**
   * 获取已加载技能的文档内容（用于注入系统提示词）
   */
  getLoadedSkillsContent(): string {
    const parts: string[] = []
    for (const skillId of this.loadedSkills.keys()) {
      const skill = getSkill(skillId)
      if (skill?.content) {
        parts.push(skill.content)
      }
    }
    return parts.join('\n\n')
  }

  /**
   * 获取技能的状态数据
   */
  getSkillData<T = unknown>(skillId: string): T | undefined {
    return this.loadedSkills.get(skillId)?.data as T | undefined
  }

  /**
   * 设置技能的状态数据
   */
  setSkillData(skillId: string, data: Record<string, unknown>): void {
    const state = this.loadedSkills.get(skillId)
    if (state) {
      state.data = { ...state.data, ...data }
    }
  }

  private loadedSkillDefs(): Array<{ skill: Skill; state: SkillState }> {
    const defs: Array<{ skill: Skill; state: SkillState }> = []
    for (const state of this.loadedSkills.values()) {
      const skill = getSkill(state.skillId)
      if (skill) defs.push({ skill, state })
    }
    return defs
  }

  private dataOf(state: SkillState): SkillData {
    if (!state.data) state.data = {}
    return state.data
  }

  /** 装着的技能里第一个给出工作目录的为准；都没给返回 undefined */
  getWorkingDirectory(): string | undefined {
    for (const { skill, state } of this.loadedSkillDefs()) {
      const dir = skill.workingDirectory?.(this.dataOf(state))
      if (dir) return dir
    }
    return undefined
  }

  /** 每轮开始通知装着的技能；某份技能出错只记日志，不挡这一轮 */
  async notifyRunStart(opts: { isSubAgent: boolean }): Promise<void> {
    for (const { skill, state } of this.loadedSkillDefs()) {
      if (!skill.onRunStart) continue
      try {
        await skill.onRunStart({ data: this.dataOf(state), isSubAgent: opts.isSubAgent })
      } catch (error) {
        log.error(`onRunStart failed for skill "${skill.id}":`, error)
      }
    }
  }

  /** 按加载顺序一层层包住这次工具调用，先加载的在最外层 */
  async runToolCall(
    call: SkillToolCall,
    execute: () => Promise<ToolResult>,
    resolveLocalPath: (rawPath: string) => string
  ): Promise<ToolResult> {
    const wrappers = this.loadedSkillDefs().filter(({ skill }) => skill.wrapToolCall)
    const invoke = (index: number): Promise<ToolResult> => {
      if (index >= wrappers.length) return execute()
      const { skill, state } = wrappers[index]
      return skill.wrapToolCall!(call, () => invoke(index + 1), { data: this.dataOf(state), resolveLocalPath })
    }
    return invoke(0)
  }

  /** 要带给伙计的技能及其状态（浅拷贝，伙计改自己的不回写主人） */
  getInheritableSkills(): Array<{ skillId: string; data: SkillData }> {
    return this.loadedSkillDefs()
      .filter(({ skill }) => skill.inheritToSubAgents)
      .map(({ skill, state }) => ({ skillId: skill.id, data: { ...this.dataOf(state) } }))
  }

  /**
   * 清理所有技能状态
   */
  async cleanup(): Promise<void> {
    const skillIds = Array.from(this.loadedSkills.keys())
    for (const skillId of skillIds) {
      await this.unloadSkill(skillId)
    }
    this.loadedSkills.clear()
  }

  /**
   * 获取可用技能列表（给 AI 参考）
   */
  getAvailableSkillsInfo(): string {
    const skills = getSkillsSummary()
    const loaded = this.getLoadedSkills()
    
    return skills.map(s => {
      const status = loaded.includes(s.id) ? '✓ 已加载' : '○ 未加载'
      return `- **${s.name}** (${s.id}) [${status}]\n  ${s.description}`
    }).join('\n')
  }
}

/**
 * 创建新的技能会话
 */
export function createSkillSession(coreTools: ToolDefinition[], ownerId?: string): SkillSession {
  return new SkillSession(coreTools, ownerId)
}

