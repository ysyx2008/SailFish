/**
 * 技能加载器
 * 管理技能的动态加载和会话状态
 */

import type { SkillState, SkillLoadResult, SkillSessionManager } from './types'
import type { ToolDefinition } from '../tools'
import { getSkill, getSkillsSummary } from './registry'

/**
 * 技能会话管理器实现
 * 每个 Agent 会话应该有一个独立的实例
 */
export class SkillSession implements SkillSessionManager {
  /** 已加载的技能状态 */
  private loadedSkills: Map<string, SkillState> = new Map()
  /** 核心工具（始终可用） */
  private coreTools: ToolDefinition[] = []

  constructor(coreTools: ToolDefinition[]) {
    this.coreTools = coreTools
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
        await skill.cleanup()
      } catch (error) {
        console.error(`[SkillSession] Error cleaning up skill "${skillId}":`, error)
      }
    }
    this.loadedSkills.delete(skillId)
  }

  /**
   * 获取所有可用工具（核心工具 + 已加载技能的工具）
   */
  getAvailableTools(): ToolDefinition[] {
    const tools = [...this.coreTools]
    
    const loadedIds = Array.from(this.loadedSkills.keys())
    for (const skillId of loadedIds) {
      const skill = getSkill(skillId)
      if (skill) {
        tools.push(...skill.tools)
      }
    }
    
    return tools
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
export function createSkillSession(coreTools: ToolDefinition[]): SkillSession {
  return new SkillSession(coreTools)
}

