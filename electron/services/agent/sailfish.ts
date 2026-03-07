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
import { PromptBuilder } from './prompt-builder'
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
  private _personalitySkillLoaded = false
  
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
    // 诞生引导时自动加载 personality 技能
    if (this.currentRun && !this._personalitySkillLoaded) {
      const isOnboarding = !(this.services.configService?.getAgentOnboardingCompleted() ?? true)
      if (isOnboarding) {
        this._personalitySkillLoaded = true
        session.loadSkill('personality').catch(err => {
          log.error('Failed to auto-load personality skill for onboarding:', err)
        })
      }
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
    return `assistant:${this.currentRun?.id || 'unknown'}`
  }
  
  /**
   * 获取当前可用的工具列表
   * 
   * 根据模式（local/ssh/assistant）返回不同的工具集
   * 如果有加载的技能，返回合并后的工具
   */
  getAvailableTools(): ToolDefinition[] {
    const mode = this.getAgentMode()
    let remoteChannel = this.currentRun?.context?.remoteChannel

    // 没有 remoteChannel 时，检查 IM 最近联系人以决定是否注册 IM 工具
    if (!remoteChannel) {
      try {
        const { getIMService } = require('../../im/im.service')
        const lastContact = getIMService().getLastContact()
        const validPlatforms = ['dingtalk', 'feishu', 'slack', 'telegram', 'wecom']
        if (lastContact && validPlatforms.includes(lastContact.platform)) {
          remoteChannel = lastContact.platform as typeof remoteChannel
        }
      } catch {
        // IM service not available in CLI mode
      }
    }

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
    return new PromptBuilder({
      context,
      hostProfileService: this.services.hostProfileService,
      executionMode: this.executionMode,
      mbtiType: options.mbtiType ?? null,
      knowledgeContext: options.knowledgeContext,
      knowledgeEnabled: options.knowledgeEnabled,
      conversationHistory: options.conversationHistory,
      contextKnowledgeDoc: options.contextKnowledgeDoc,
      aiRules: options.aiRules,
      personalityText: options.personalityText,
      agentName: options.agentName,
      taskSummaries: options.taskSummaries,
      relatedTaskDigests: options.relatedTaskDigests,
      availableTaskIds: options.availableTaskIds,
      watchListSummary: options.watchListSummary,
      bondContext: options.bondContext,
      isOnboarding: options.isOnboarding,
      skillsContent: this.getSkillSession().getLoadedSkillsContent(),
    }).build()
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
