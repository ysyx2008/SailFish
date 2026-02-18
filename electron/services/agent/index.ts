/**
 * Agent 服务
 * 
 * OOP 重构版本：AgentService 作为工厂和生命周期管理器
 * 实际执行逻辑在 Agent 基类和 TerminalAgent 子类中
 */
import type { AiService } from '../ai.service'
import type { PtyService } from '../pty.service'
import type { SshService } from '../ssh.service'
import type { SftpService } from '../sftp.service'
import type { McpService } from '../mcp.service'
import type { ConfigService } from '../config.service'
import { UnifiedTerminalService } from '../unified-terminal.service'

import type {
  AgentConfig,
  AgentStep,
  AgentContext,
  AgentCallbacks,
  HostProfileServiceInterface,
  RiskLevel,
  AgentServices,
  RunStatus,
  AgentExecutionPhase
} from './types'
import { TerminalAgent } from './terminal-agent'
import { assessCommandRisk, analyzeCommand } from './risk-assessor'
import type { CommandHandlingInfo } from './risk-assessor'
import { setConfigService as setI18nConfigService } from './i18n'
import { getTerminalStateService } from '../terminal-state.service'

// 重新导出类型，供外部使用
export type {
  AgentConfig,
  AgentStep,
  AgentContext,
  RiskLevel,
  CommandHandlingInfo,
  AgentServices,
  RunStatus
}
export { assessCommandRisk, analyzeCommand }

// 导出 Agent 类
export { Agent } from './agent'
export { TerminalAgent } from './terminal-agent'

/**
 * Agent 服务 - 工厂和生命周期管理器
 * 
 * 职责：
 * - 创建和管理 TerminalAgent 实例
 * - 提供向后兼容的 API
 * - 管理全局回调
 */
export class AgentService {
  /** Agent 实例映射（按 ptyId） */
  private agents: Map<string, TerminalAgent> = new Map()
  
  /** 依赖服务集合 */
  private services: AgentServices
  
  /** 默认回调 */
  private defaultCallbacks: AgentCallbacks = {}

  constructor(
    aiService: AiService, 
    ptyService: PtyService,
    hostProfileService?: HostProfileServiceInterface,
    mcpService?: McpService,
    configService?: ConfigService,
    sshService?: SshService,
    sftpService?: SftpService
  ) {
    // 创建统一终端服务
    let unifiedTerminalService: UnifiedTerminalService | undefined
    if (sshService) {
      unifiedTerminalService = new UnifiedTerminalService(ptyService, sshService)
    }
    
    // 组装服务集合
    this.services = {
      aiService,
      ptyService,
      sshService,
      sftpService,
      unifiedTerminalService,
      hostProfileService,
      mcpService,
      configService
    }
    
    // 初始化 i18n
    if (configService) {
      setI18nConfigService(configService)
    }
  }
  
  // ==================== 服务设置（延迟初始化） ====================

  /**
   * 设置 SSH 服务
   */
  setSshService(sshService: SshService): void {
    this.services.sshService = sshService
    if (this.services.ptyService) {
      this.services.unifiedTerminalService = new UnifiedTerminalService(
        this.services.ptyService, 
        sshService
      )
    }
  }

  /**
   * 设置 SFTP 服务
   */
  setSftpService(sftpService: SftpService): void {
    this.services.sftpService = sftpService
  }

  /**
   * 设置 MCP 服务
   */
  setMcpService(mcpService: McpService): void {
    this.services.mcpService = mcpService
  }

  /**
   * 设置历史记录服务
   */
  setHistoryService(historyService: import('../history.service').HistoryService): void {
    this.services.historyService = historyService
  }

  // ==================== 工厂方法 ====================

  /**
   * 获取或创建 Agent 实例
   */
  getOrCreateAgent(ptyId: string): TerminalAgent {
    let agent = this.agents.get(ptyId)
    if (!agent) {
      agent = new TerminalAgent(ptyId, this.services)
      agent.setCallbacks(this.defaultCallbacks)
      this.agents.set(ptyId, agent)
      console.log(`[AgentService] Created agent for terminal: ${ptyId}`)
    }
    return agent
  }

  /**
   * 获取 Agent 实例（不创建）
   */
  getAgent(ptyId: string): TerminalAgent | undefined {
    return this.agents.get(ptyId)
  }

  /**
   * 检查是否存在 Agent 实例
   */
  hasAgent(ptyId: string): boolean {
    return this.agents.has(ptyId)
  }
  
  // ==================== 生命周期管理 ====================

  /**
   * 清理 Agent 实例
   */
  cleanupAgent(ptyId: string): void {
    const agent = this.agents.get(ptyId)
    if (agent) {
      agent.cleanup()
      this.agents.delete(ptyId)
      console.log(`[AgentService] Cleaned up agent for terminal: ${ptyId}`)
    }
    }

  /**
   * 清理所有 Agent 实例
   */
  cleanupAllAgents(): void {
    Array.from(this.agents.entries()).forEach(([ptyId, agent]) => {
      agent.cleanup()
      console.log(`[AgentService] Cleaned up agent for terminal: ${ptyId}`)
    })
    this.agents.clear()
  }

  // ==================== 全局设置 ====================
  
  /**
   * 设置默认回调
   */
  setCallbacks(callbacks: AgentCallbacks): void {
    this.defaultCallbacks = callbacks
    // 更新已存在的 agents
    Array.from(this.agents.values()).forEach(agent => {
      agent.setCallbacks(callbacks)
    })
  }

  // ==================== 便捷方法（向后兼容） ====================

  /**
   * 运行 Agent
   * 
   * 向后兼容的便捷方法，内部委托给 TerminalAgent
   */
  async run(
    ptyId: string,
    userMessage: string,
    context: AgentContext,
    config?: Partial<AgentConfig>,
    profileId?: string,
    workerOptions?: import('./types').WorkerAgentOptions,
    callbacks?: AgentCallbacks
  ): Promise<string> {
    const agent = this.getOrCreateAgent(ptyId)
    
    // 更新配置
    if (config) {
      agent.updateConfig(config)
    }
    
    // 在启动前刷新并设置当前工作目录（重要！避免 AI 使用错误的相对路径）
    const terminalStateService = getTerminalStateService()
    const cwd = await terminalStateService.refreshCwd(ptyId, 'initial')
    const enrichedContext: AgentContext = {
      ...context,
      cwd: cwd !== '~' ? cwd : undefined  // 只有获取到有效路径时才设置
    }
    
    // 运行
    return agent.run(userMessage, enrichedContext, {
      profileId,
      workerOptions,
      callbacks
    })
  }
  
  /**
   * 中止运行
   */
  abort(ptyId: string): boolean {
    const agent = this.getAgent(ptyId)
    return agent?.abort() ?? false
    }
    
  /**
   * 确认工具调用
   */
  confirmToolCall(
    ptyId: string,
    toolCallId: string,
    approved: boolean,
    modifiedArgs?: Record<string, unknown>,
    alwaysAllow?: boolean
  ): boolean {
    const agent = this.getAgent(ptyId)
    return agent?.confirmToolCall(toolCallId, approved, modifiedArgs, alwaysAllow) ?? false
  }
  
  /**
   * 添加用户消息
   */
  addUserMessage(ptyId: string, message: string): boolean {
    const agent = this.getAgent(ptyId)
    return agent?.addUserMessage(message) ?? false
  }
  
  /**
   * 重置 Agent 会话状态（前端"新对话"时调用）
   */
  resetSession(ptyId: string): void {
    const agent = this.getAgent(ptyId)
    agent?.resetSession()
  }
  
  /**
   * 更新配置
   */
  updateConfig(ptyId: string, config: Partial<AgentConfig>): void {
    const agent = this.getAgent(ptyId)
    agent?.updateConfig(config)
  }
  
  /**
   * 获取运行状态
   */
  getRunStatus(ptyId: string): RunStatus | undefined {
    const agent = this.getAgent(ptyId)
    return agent?.getRunStatus()
  }

  /**
   * 获取执行阶段
   */
  getExecutionPhase(ptyId: string): AgentExecutionPhase {
    const agent = this.getAgent(ptyId)
    return agent?.getExecutionPhase() ?? 'idle'
  }

  /**
   * 检查是否正在运行
   */
  isRunning(ptyId: string): boolean {
    const agent = this.getAgent(ptyId)
    return agent?.isRunning() ?? false
  }
}
