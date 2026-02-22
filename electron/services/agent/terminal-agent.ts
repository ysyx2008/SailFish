/**
 * TerminalAgent - 终端 Agent 实现
 * 
 * 继承自 Agent 基类，实现终端特定的行为：
 * - 终端特定的工具列表（根据 local/ssh 模式）
 * - 终端特定的系统提示构建
 * - 终端交互相关的方法
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

/**
 * 终端 Agent
 * 
 * 用于管理单个终端（本地或 SSH）的 AI 助手交互
 */
export class TerminalAgent extends Agent {
  /** 终端 ID */
  readonly ptyId: string
  
  constructor(ptyId: string, services: AgentServices) {
    super(services)
    this.ptyId = ptyId
  }
  
  // ==================== 实现抽象方法 ====================
  
  /**
   * 获取 Agent 标识
   */
  protected getAgentId(): string {
    return `terminal:${this.ptyId}`
  }
  
  /**
   * 获取当前可用的工具列表
   * 
   * 根据终端类型（local/ssh）返回不同的工具集
   * 如果有加载的技能，返回合并后的工具
   */
  getAvailableTools(): ToolDefinition[] {
    const mode = this.getTerminalMode()
    const remoteChannel = this.currentRun?.context?.remoteChannel
    const baseTools = getAgentTools(this.services.mcpService, {
      mode,
      remoteChannel,
      includeContextTools: this.contextManagementEnabled
    })
    
    // 如果有技能会话，用最新的 baseTools 刷新核心工具后返回
    // （remoteChannel 等上下文可能在不同 run 间变化，coreTools 需要同步更新）
    if (this.currentRun?.skillSession) {
      this.currentRun.skillSession.updateCoreTools(baseTools)
      return this.currentRun.skillSession.getAvailableTools()
    }
    
    return baseTools
  }
  
  /**
   * 构建系统提示词
   * 
   * 使用终端上下文和选项构建完整的系统提示
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
      options.availableTaskIds
    )
  }
  
  // ==================== 终端特有方法 ====================
  
  /**
   * 获取终端模式（local/ssh）
   */
  private getTerminalMode(): AgentMode {
    if (this.services.unifiedTerminalService) {
      return this.services.unifiedTerminalService.getTerminalType(this.ptyId) as AgentMode
    }
    return 'local'
  }
  
  /**
   * 获取终端服务
   */
  private getTerminalService() {
    return this.services.unifiedTerminalService || this.services.ptyService
  }
}
