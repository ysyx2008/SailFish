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
import { getAgentTools, filterUnattendedTools, filterSubAgentTools, AgentMode } from './tools'
import type { ToolExecutorConfig } from './tools/types'
import type { AgentRun } from './types'
import type { ChildAgentHandle } from './sub-agent-roster'
import { PromptBuilder } from './prompt-builder'
import type { SkillSession } from './skills'
import { createLogger } from '../../utils/logger'

const log = createLogger('SailfishAgent')

/**
 * SailFish Agent
 * 
 * 旗鱼的核心 Agent 实现。默认拥有基础能力（文件操作、知识库、命令执行），
 * 终端交互能力（execute_command 等）通过 getAgentTools 按 context.terminalType 注入。
 */
export class SailFish extends Agent {
  /** 终端 ID（可选）。注意：仅作为向后兼容保留，不参与模式判断。
   * 模式（local/ssh/assistant）由 currentRun.context.terminalType 决定。 */
  readonly ptyId?: string
  
  private _personalitySkillLoaded = false
  
  constructor(services: AgentServices, ptyId?: string) {
    super(services)
    this.ptyId = ptyId
  }
  
  /**
   * 获取技能会话，诞生引导时自动加载 personality 技能
   */
  protected getSkillSession(): SkillSession {
    const session = super.getSkillSession()
    // 诞生引导时自动加载 personality 技能
    if (this.currentRun && !this._personalitySkillLoaded && !this.isSubAgent()) {
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
    const raw = this.collectToolCatalog()
    const unattended = this.currentRun?.context?.unattended
    const afterUnattended = unattended ? filterUnattendedTools(raw) : raw
    return this.isSubAgent() ? filterSubAgentTools(afterUnattended) : afterUnattended
  }

  protected collectToolCatalog() {
    const mode = this.getAgentMode()
    let remoteChannel = this.currentRun?.context?.remoteChannel

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

    const unattended = this.currentRun?.context?.unattended
    const baseTools = getAgentTools(this.services.mcpService, {
      mode,
      remoteChannel,
      includeContextTools: this.contextManagementEnabled,
      mcpToolSession: this.getMcpToolSession(),
      unattended
    }, this.services.pluginRegistry)

    if (this.currentRun?.skillSession) {
      this.currentRun.skillSession.updateCoreTools(baseTools)
      return this.currentRun.skillSession.getAvailableTools()
    }
    return baseTools
  }

  protected createToolExecutorConfig(run: AgentRun): ToolExecutorConfig {
    const config = super.createToolExecutorConfig(run)
    return {
      ...config,
      createChildAgent: (name) => this.spawnChild(name),
    }
  }

  private spawnChild(name: string): ChildAgentHandle {
    const child = new SailFish(this.services)
    child.setAgentId(`${this.getConversationAgentId()}:sub:${name}`)
    child.markAsSubAgent()
    child.bindConfirmationHost(this, name)
    child.updateConfig({
      executionMode: this.executionMode,
      commandTimeout: this.commandTimeout,
      commandRiskPolicy: this.commandRiskPolicy,
      profileId: this.profileId,
    })
    return child
  }
  
  /**
   * 构建系统提示词
   */
  protected buildSystemPrompt(context: AgentContext, options: PromptOptions): string {
    if (this.isSubAgent()) {
      return PromptBuilder.buildSubAgentSystemPrompt({
        context,
        aiRules: options.aiRules,
        hostProfileService: this.services.hostProfileService,
      })
    }
    return new PromptBuilder({
      context,
      hostProfileService: this.services.hostProfileService,
      executionMode: this.executionMode,
      autoApprovalReview: this.autoReviewApplies(context.unattended),
      mbtiType: options.mbtiType ?? null,
      knowledgeContext: options.knowledgeContext,
      knowledgeEnabled: options.knowledgeEnabled,
      conversationHistory: options.conversationHistory,
      contextKnowledgeDoc: options.contextKnowledgeDoc,
      aiRules: options.aiRules,
      agentName: options.agentName,
      taskSummaries: options.taskSummaries,
      relatedTaskDigests: options.relatedTaskDigests,
      availableTaskIds: options.availableTaskIds,
      watchListSummary: options.watchListSummary,
      bondContext: options.bondContext,
      isOnboarding: options.isOnboarding,
      skillsContent: [this.getSkillSession().getLoadedSkillsContent(), this.getLoadedUserSkillsContent()]
        .filter(Boolean)
        .join('\n\n'),
      loadedSkillsRoster: this.getLoadedSkillsRoster(),
      mcpServerCatalog: this.services.mcpService?.shouldDeferTools()
        ? this.services.mcpService.getServerCatalogText()
        : undefined,
      proactiveCompact: options.proactiveCompact,
    }).build()
  }
  
  // ==================== 模式判断 ====================
  
  /**
   * 获取 Agent 运行模式。
   * 从当前 run 的 context.terminalType 读取，与实例级 ptyId 完全解耦。
   * agentKey（tabId）与操作目标 ptyId 解耦后，实例级 ptyId 不可靠，不得用于模式判断。
   */
  private getAgentMode(): AgentMode {
    const terminalType = this.currentRun?.context?.terminalType
    if (terminalType === 'local' || terminalType === 'ssh') {
      return terminalType
    }
    return 'assistant'
  }
}
