/**
 * SailFish - 旗鱼 Agent 实现
 * 
 * 继承自 Agent 基类，实现具体的 Agent 行为：
 * - 工具列表管理（内置工具 + 可选技能）
 * - 系统提示构建
 * - 终端能力可选（通过 terminal 技能加载）
 */

import { Agent } from './agent'
import type { ToolDefinition } from '../ai.service'
import type {
  AgentContext,
  AgentServices,
  PromptOptions
} from './types'
import { getAgentTools, AgentMode } from './tools'
import { buildSystemPrompt } from './prompt-builder'
import type { SkillSession } from './skills'
import { createLogger } from '../../utils/logger'

const log = createLogger('SailfishAgent')

/**
 * SailFish Agent
 * 
 * 旗鱼的核心 Agent 实现。默认拥有基础能力（文件操作、知识库、命令执行），
 * 终端交互能力通过 terminal 技能按需加载。
 */
export class SailFish extends Agent {
  /** 终端 ID（可选，绑定终端后设置） */
  readonly ptyId?: string
  
  private _terminalSkillLoaded = false
  
  constructor(services: AgentServices, ptyId?: string) {
    super(services)
    this.ptyId = ptyId
  }
  
  /**
   * 获取技能会话，绑定终端时自动加载 terminal 技能
   */
  protected getSkillSession(): SkillSession {
    const session = super.getSkillSession()
    if (this.ptyId && !this._terminalSkillLoaded) {
      this._terminalSkillLoaded = true
      session.loadSkill('terminal').catch(err => {
        log.error('Failed to auto-load terminal skill:', err)
      })
    }
    return session
  }
  
  // ==================== 实现抽象方法 ====================
  
  /**
   * 获取 Agent 标识
   */
  protected getAgentId(): string {
    if (this.ptyId) {
      return `terminal:${this.ptyId}`
    }
    return `assistant:${this._sessionId || 'unknown'}`
  }
  
  /**
   * 获取当前可用的工具列表
   * 
   * 根据模式（local/ssh/assistant）返回不同的工具集
   * 如果有加载的技能，返回合并后的工具
   */
  getAvailableTools(): ToolDefinition[] {
    const mode = this.getAgentMode()
    const remoteChannel = this.currentRun?.context?.remoteChannel
    const baseTools = getAgentTools(this.services.mcpService, {
      mode,
      remoteChannel,
      includeContextTools: this.contextManagementEnabled
    })
    
    if (this.currentRun?.skillSession) {
      this.currentRun.skillSession.updateCoreTools(baseTools)
      return this.currentRun.skillSession.getAvailableTools()
    }
    
    return baseTools
  }
  
  /**
   * 构建系统提示词
   */
  protected buildSystemPrompt(context: AgentContext, options: PromptOptions): string {
    return buildSystemPrompt(
      context,
      this.services.hostProfileService,
      options.mbtiType ?? null,
      options.knowledgeContext,
      options.knowledgeEnabled,
      options.conversationHistory,
      this.executionMode,
      options.aiRules,
      options.taskSummaries,
      options.relatedTaskDigests,
      options.availableTaskIds,
      options.contextKnowledgeDoc
    )
  }
  
  // ==================== 模式判断 ====================
  
  /**
   * 获取 Agent 运行模式
   */
  private getAgentMode(): AgentMode {
    if (!this.ptyId) {
      return 'assistant'
    }
    if (this.services.unifiedTerminalService) {
      return this.services.unifiedTerminalService.getTerminalType(this.ptyId) as AgentMode
    }
    return 'local'
  }
}
