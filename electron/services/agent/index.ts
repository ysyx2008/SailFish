/**
 * Agent 服务
 * 模块化重构版本
 */
import type { AiService, AiMessage, ToolCall, ChatWithToolsResult } from '../ai.service'
import { CommandExecutorService } from '../command-executor.service'
import type { PtyService } from '../pty.service'
import type { McpService } from '../mcp.service'
import type { ConfigService } from '../config.service'

// 导入子模块
import type {
  AgentConfig,
  AgentStep,
  AgentContext,
  ToolResult,
  PendingConfirmation,
  AgentRun,
  AgentCallbacks,
  HostProfileServiceInterface,
  RiskLevel,
  ExecutionStrategy,
  ReflectionState,
  ExecutionQualityScore
} from './types'
import { DEFAULT_AGENT_CONFIG } from './types'
import { getAgentTools } from './tools'
import { assessCommandRisk, analyzeCommand } from './risk-assessor'
import type { CommandHandlingInfo } from './risk-assessor'
import { executeTool, ToolExecutorConfig } from './tool-executor'
import { buildSystemPrompt } from './prompt-builder'
import { analyzeTaskComplexity, generatePlanningPrompt } from './planner'
import { getKnowledgeService } from '../knowledge'

// 重新导出类型，供外部使用
export type {
  AgentConfig,
  AgentStep,
  AgentContext,
  ToolResult,
  PendingConfirmation,
  RiskLevel,
  CommandHandlingInfo
}
export { assessCommandRisk, analyzeCommand }

export class AgentService {
  private aiService: AiService
  private commandExecutor: CommandExecutorService
  private ptyService: PtyService
  private hostProfileService?: HostProfileServiceInterface
  private mcpService?: McpService
  private configService?: ConfigService
  private runs: Map<string, AgentRun> = new Map()

  // 事件回调
  private onStepCallback?: AgentCallbacks['onStep']
  private onNeedConfirmCallback?: AgentCallbacks['onNeedConfirm']
  private onCompleteCallback?: AgentCallbacks['onComplete']
  private onErrorCallback?: AgentCallbacks['onError']
  private onTextChunkCallback?: AgentCallbacks['onTextChunk']

  constructor(
    aiService: AiService, 
    ptyService: PtyService,
    hostProfileService?: HostProfileServiceInterface,
    mcpService?: McpService,
    configService?: ConfigService
  ) {
    this.aiService = aiService
    this.ptyService = ptyService
    this.hostProfileService = hostProfileService
    this.mcpService = mcpService
    this.configService = configService
    this.commandExecutor = new CommandExecutorService()
  }

  /**
   * 设置 MCP 服务
   */
  setMcpService(mcpService: McpService): void {
    this.mcpService = mcpService
  }

  /**
   * 设置事件回调
   */
  setCallbacks(callbacks: AgentCallbacks): void {
    this.onStepCallback = callbacks.onStep
    this.onNeedConfirmCallback = callbacks.onNeedConfirm
    this.onCompleteCallback = callbacks.onComplete
    this.onErrorCallback = callbacks.onError
    this.onTextChunkCallback = callbacks.onTextChunk
  }

  /**
   * 生成唯一 ID
   */
  private generateId(): string {
    return `agent_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`
  }

  /**
   * 检测是否存在命令循环（重复执行相同命令）
   */
  private detectCommandLoop(commands: string[]): boolean {
    if (commands.length < 3) return false
    
    // 检查最后 3 个命令是否相同
    const last3 = commands.slice(-3)
    if (last3[0] === last3[1] && last3[1] === last3[2]) {
      return true
    }
    
    // 检查是否有 AB-AB 模式的循环
    if (commands.length >= 4) {
      const last4 = commands.slice(-4)
      if (last4[0] === last4[2] && last4[1] === last4[3]) {
        return true
      }
    }
    
    return false
  }

  /**
   * 检测执行中的问题（增强版）
   */
  private detectExecutionIssues(run: AgentRun): string[] {
    const issues: string[] = []
    const { reflection } = run
    
    // 检测命令循环
    if (this.detectCommandLoop(reflection.lastCommands)) {
      issues.push('detected_command_loop')
    }
    
    // 检测连续失败
    if (reflection.failureCount >= 3) {
      issues.push('consecutive_failures')
    }
    
    // 检测高失败率
    const totalAttempts = reflection.successCount + reflection.totalFailures
    if (totalAttempts >= 5 && reflection.totalFailures / totalAttempts > 0.6) {
      issues.push('high_failure_rate')
    }
    
    // 检测策略切换过于频繁
    const recentSwitches = reflection.strategySwitches.filter(
      s => Date.now() - s.timestamp < 60000  // 1 分钟内
    )
    if (recentSwitches.length >= 3) {
      issues.push('frequent_strategy_changes')
    }
    
    return issues
  }

  /**
   * 计算执行质量评分
   */
  private calculateQualityScore(reflection: ReflectionState): ExecutionQualityScore {
    const totalAttempts = reflection.successCount + reflection.totalFailures
    
    // 成功率
    const successRate = totalAttempts > 0 
      ? reflection.successCount / totalAttempts 
      : 1
    
    // 效率（基于工具调用次数和失败次数）
    const efficiency = totalAttempts > 0
      ? Math.max(0, 1 - (reflection.totalFailures / totalAttempts) * 0.5)
      : 1
    
    // 适应性（基于策略切换的效果）
    let adaptability = 0.7  // 默认值
    if (reflection.strategySwitches.length > 0) {
      // 如果有策略切换，检查切换后是否有改善
      const lastSwitch = reflection.strategySwitches[reflection.strategySwitches.length - 1]
      const timeSinceSwitch = Date.now() - lastSwitch.timestamp
      if (timeSinceSwitch > 10000 && reflection.failureCount === 0) {
        adaptability = 0.9  // 切换后成功
      } else if (reflection.failureCount > 0) {
        adaptability = 0.5  // 切换后仍有失败
      }
    }
    
    // 综合评分
    const overallScore = successRate * 0.5 + efficiency * 0.3 + adaptability * 0.2
    
    return { successRate, efficiency, adaptability, overallScore }
  }

  /**
   * 决定是否需要切换策略
   */
  private shouldSwitchStrategy(run: AgentRun): { 
    should: boolean
    newStrategy?: ExecutionStrategy
    reason?: string 
  } {
    const { reflection } = run
    const issues = this.detectExecutionIssues(run)
    
    // 如果刚切换过策略，先观察一下
    const lastSwitch = reflection.strategySwitches[reflection.strategySwitches.length - 1]
    if (lastSwitch && Date.now() - lastSwitch.timestamp < 30000) {
      return { should: false }
    }
    
    // 连续失败 -> 切换到保守策略
    if (issues.includes('consecutive_failures') && reflection.currentStrategy !== 'conservative') {
      return {
        should: true,
        newStrategy: 'conservative',
        reason: `连续失败 ${reflection.failureCount} 次，切换到保守策略`
      }
    }
    
    // 检测到循环 -> 切换到诊断策略
    if (issues.includes('detected_command_loop') && reflection.currentStrategy !== 'diagnostic') {
      return {
        should: true,
        newStrategy: 'diagnostic',
        reason: '检测到命令循环，切换到诊断策略进行问题分析'
      }
    }
    
    // 高失败率 -> 切换到保守策略
    if (issues.includes('high_failure_rate') && reflection.currentStrategy === 'aggressive') {
      return {
        should: true,
        newStrategy: 'conservative',
        reason: '失败率较高，从激进策略切换到保守策略'
      }
    }
    
    // 如果一切顺利且当前是保守策略，可以考虑切换回默认
    if (issues.length === 0 && 
        reflection.currentStrategy === 'conservative' && 
        reflection.successCount >= 3 &&
        reflection.failureCount === 0) {
      return {
        should: true,
        newStrategy: 'default',
        reason: '执行顺利，切换回默认策略'
      }
    }
    
    return { should: false }
  }

  /**
   * 执行策略切换
   */
  private switchStrategy(run: AgentRun, newStrategy: ExecutionStrategy, reason: string): void {
    const oldStrategy = run.reflection.currentStrategy
    
    run.reflection.strategySwitches.push({
      timestamp: Date.now(),
      fromStrategy: oldStrategy,
      toStrategy: newStrategy,
      reason,
      triggerCondition: this.detectExecutionIssues(run).join(', ') || 'manual'
    })
    
    run.reflection.currentStrategy = newStrategy
    
    console.log(`[Agent] 策略切换: ${oldStrategy} -> ${newStrategy}, 原因: ${reason}`)
  }

  /**
   * 生成反思提示消息（增强版）
   * 基于当前策略和检测到的问题生成更有针对性的提示
   */
  private generateReflectionPrompt(run: AgentRun): string {
    const { reflection } = run
    const issues = this.detectExecutionIssues(run)
    
    // 更新检测到的问题列表
    for (const issue of issues) {
      if (!reflection.detectedIssues.includes(issue)) {
        reflection.detectedIssues.push(issue)
      }
    }
    
    // 根据当前策略和问题生成提示
    const prompts: string[] = []
    
    // 检测到循环
    if (issues.includes('detected_command_loop')) {
      if (reflection.currentStrategy === 'diagnostic') {
        prompts.push('你在重复相同的操作。请分析：1) 为什么会陷入循环？2) 有什么根本原因导致方法无效？3) 是否需要完全不同的方法？')
      } else {
        prompts.push('你似乎在重复相同的操作，请换个方法试试，或者告诉用户遇到了什么困难。')
      }
    }
    
    // 连续失败
    if (issues.includes('consecutive_failures')) {
      const failCount = reflection.failureCount
      if (reflection.currentStrategy === 'conservative') {
        prompts.push(`已连续失败 ${failCount} 次。保守策略建议：暂停执行，向用户说明具体困难和可能的原因。`)
      } else {
        prompts.push(`已连续失败 ${failCount} 次，建议换个思路或向用户说明情况。`)
      }
    }
    
    // 高失败率
    if (issues.includes('high_failure_rate')) {
      prompts.push('整体失败率较高，建议重新评估任务方案或寻求用户指导。')
    }
    
    if (prompts.length === 0) {
      return ''
    }
    
    return `（注意：${prompts.join(' ')}）`
  }

  /**
   * 检查是否需要触发反思（增强版）
   */
  private shouldTriggerReflection(run: AgentRun): boolean {
    const { reflection } = run
    const issues = this.detectExecutionIssues(run)
    
    // 有问题就触发
    if (issues.length > 0) {
      return true
    }
    
    // 定期检查（每 10 次工具调用）
    if (reflection.toolCallCount - reflection.lastReflectionAt >= 10) {
      return true
    }
    
    return false
  }

  /**
   * 更新反思追踪状态（增强版）
   */
  private updateReflectionTracking(
    run: AgentRun,
    toolName: string,
    toolArgs: Record<string, unknown>,
    result: ToolResult
  ): void {
    const { reflection } = run

    reflection.toolCallCount++

    // 追踪命令执行
    if (toolName === 'execute_command' && toolArgs.command) {
      reflection.lastCommands.push(toolArgs.command as string)
      // 只保留最近 5 个命令
      if (reflection.lastCommands.length > 5) {
        reflection.lastCommands.shift()
      }
    }

    // 如果命令仍在运行（长耗时命令超时），不计入失败
    if (result.isRunning) {
      // 命令仍在执行，不更新成功/失败计数
      // 这种情况通常是构建、编译等长耗时命令的正常超时
      return
    }

    // 更新成功/失败计数
    if (result.success) {
      reflection.successCount++
      reflection.failureCount = 0
    } else {
      reflection.failureCount++
      reflection.totalFailures++
    }
    
    // 更新质量评分
    reflection.qualityScore = this.calculateQualityScore(reflection)
    
    // 检查是否需要切换策略
    const switchDecision = this.shouldSwitchStrategy(run)
    if (switchDecision.should && switchDecision.newStrategy && switchDecision.reason) {
      this.switchStrategy(run, switchDecision.newStrategy, switchDecision.reason)
    }
  }

  /**
   * 估算消息的 token 数量（粗略估计）
   * 中文约 1.5 token/字符，英文约 0.25 token/字符
   */
  private estimateTokens(text: string): number {
    const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length
    const otherChars = text.length - chineseChars
    return Math.ceil(chineseChars * 1.5 + otherChars * 0.25)
  }

  /**
   * 估算消息数组的总 token 数
   */
  private estimateTotalTokens(messages: AiMessage[]): number {
    return messages.reduce((sum, msg) => {
      let tokens = this.estimateTokens(msg.content)
      // 工具调用也占用 token
      if (msg.tool_calls) {
        tokens += msg.tool_calls.reduce((t, tc) => 
          t + this.estimateTokens(tc.function.name) + this.estimateTokens(tc.function.arguments), 0)
      }
      if (msg.reasoning_content) {
        tokens += this.estimateTokens(msg.reasoning_content)
      }
      return sum + tokens
    }, 0)
  }

  /**
   * 压缩工具输出内容
   * 对于长输出，智能保留关键信息
   */
  private compressToolOutput(output: string, maxLength: number = 2000): string {
    if (output.length <= maxLength) {
      return output
    }

    // 分析输出类型，采用不同压缩策略
    const lines = output.split('\n')
    
    // 如果是结构化输出（如命令结果），保留头尾
    if (lines.length > 20) {
      const headLines = lines.slice(0, 10)
      const tailLines = lines.slice(-10)
      const omitted = lines.length - 20
      return [
        ...headLines,
        `\n... [省略 ${omitted} 行] ...\n`,
        ...tailLines
      ].join('\n')
    }

    // 普通文本，直接截断
    return output.substring(0, maxLength) + `\n... [截断，原长度: ${output.length} 字符]`
  }

  /**
   * 提取消息中的关键信息（记忆锚点）
   * 借鉴 DeepAgent 的 Memory Folding 思想
   */
  private extractKeyPoints(messages: AiMessage[]): string[] {
    const keyPoints: string[] = []
    
    for (const msg of messages) {
      // 从 assistant 消息中提取关键决策和发现
      if (msg.role === 'assistant' && msg.content) {
        // 提取诊断结果
        const diagMatch = msg.content.match(/(?:诊断结果|分析结果|发现|结论)[：:]\s*([^\n]+)/g)
        if (diagMatch) {
          keyPoints.push(...diagMatch.map(m => m.trim()))
        }
        
        // 提取执行的关键操作
        const actionMatch = msg.content.match(/(?:已执行|已完成|成功)[：:]\s*([^\n]+)/g)
        if (actionMatch) {
          keyPoints.push(...actionMatch.map(m => m.trim()))
        }
        
        // 提取错误信息
        const errorMatch = msg.content.match(/(?:错误|失败|问题)[：:]\s*([^\n]+)/g)
        if (errorMatch) {
          keyPoints.push(...errorMatch.map(m => m.trim()))
        }
      }
      
      // 从 tool 消息中提取关键结果
      if (msg.role === 'tool' && msg.content) {
        // 提取错误信息
        if (msg.content.includes('错误') || msg.content.includes('Error') || msg.content.includes('failed')) {
          const firstLine = msg.content.split('\n')[0]
          if (firstLine.length < 200) {
            keyPoints.push(`[工具结果] ${firstLine}`)
          }
        }
      }
    }
    
    // 去重并限制数量
    return [...new Set(keyPoints)].slice(-10)
  }

  /**
   * 计算消息的重要性分数
   * 用于决定压缩时的保留优先级
   */
  private calculateMessageImportance(msg: AiMessage, index: number, total: number): number {
    let score = 0
    
    // 位置因素：越新的消息越重要
    score += (index / total) * 30
    
    // 角色因素
    if (msg.role === 'user') score += 20  // 用户消息重要
    if (msg.role === 'assistant' && msg.tool_calls) score += 15  // 包含工具调用的回复重要
    
    // 内容因素
    if (msg.content) {
      // 包含关键信息的消息更重要
      if (msg.content.includes('结果') || msg.content.includes('发现')) score += 10
      if (msg.content.includes('错误') || msg.content.includes('失败')) score += 15
      if (msg.content.includes('成功') || msg.content.includes('完成')) score += 10
      
      // 太长的消息降低优先级（可能是原始输出）
      if (msg.content.length > 2000) score -= 10
    }
    
    return score
  }

  /**
   * 将消息按对话轮次分组
   * 确保 assistant 的 tool_calls 和对应的 tool 消息保持在一起
   */
  private groupMessagesByTurn(messages: AiMessage[]): AiMessage[][] {
    const groups: AiMessage[][] = []
    let currentGroup: AiMessage[] = []
    let expectingToolResponses = false
    let expectedToolCallIds: Set<string> = new Set()
    
    for (const msg of messages) {
      if (msg.role === 'system') {
        // system 消息单独一组
        if (currentGroup.length > 0) {
          groups.push(currentGroup)
          currentGroup = []
        }
        groups.push([msg])
        expectingToolResponses = false
        expectedToolCallIds.clear()
        continue
      }
      
      if (msg.role === 'user') {
        // 新的用户消息开始新的一轮
        if (currentGroup.length > 0) {
          groups.push(currentGroup)
          currentGroup = []
        }
        currentGroup.push(msg)
        expectingToolResponses = false
        expectedToolCallIds.clear()
        continue
      }
      
      if (msg.role === 'assistant') {
        // assistant 消息加入当前组
        currentGroup.push(msg)
        // 如果有 tool_calls，标记需要等待 tool 响应
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          expectingToolResponses = true
          expectedToolCallIds = new Set(msg.tool_calls.map(tc => tc.id))
        } else {
          // 没有 tool_calls，这轮结束
          if (currentGroup.length > 0) {
            groups.push(currentGroup)
            currentGroup = []
          }
          expectingToolResponses = false
          expectedToolCallIds.clear()
        }
        continue
      }
      
      if (msg.role === 'tool') {
        // tool 消息必须跟在 assistant 后面
        currentGroup.push(msg)
        // 移除已响应的 tool_call_id
        if (msg.tool_call_id) {
          expectedToolCallIds.delete(msg.tool_call_id)
        }
        // 如果所有 tool_calls 都已响应，这轮结束
        if (expectedToolCallIds.size === 0) {
          if (currentGroup.length > 0) {
            groups.push(currentGroup)
            currentGroup = []
          }
          expectingToolResponses = false
        }
        continue
      }
    }
    
    // 处理剩余的消息
    if (currentGroup.length > 0) {
      groups.push(currentGroup)
    }
    
    return groups
  }

  /**
   * 获取当前 AI Profile 的上下文长度
   */
  private getContextLength(profileId?: string): number {
    if (!this.configService) {
      return 32000  // 默认 32K
    }
    
    const profiles = this.configService.getAiProfiles()
    if (profiles.length === 0) {
      return 32000
    }
    
    let profile
    if (profileId) {
      profile = profiles.find(p => p.id === profileId)
    } else {
      const activeId = this.configService.getActiveAiProfile()
      profile = profiles.find(p => p.id === activeId) || profiles[0]
    }
    
    // 返回配置的上下文长度，默认 32000
    return profile?.contextLength || 32000
  }

  /**
   * 智能压缩消息历史（借鉴 DeepAgent Memory Folding）
   * 关键改进：以消息组为单位压缩，确保 tool_calls 和 tool 消息配对
   * @param maxTokens 压缩阈值，默认根据模型上下文长度的 80% 计算
   */
  private async compressMessages(
    messages: AiMessage[], 
    maxTokens?: number
  ): Promise<AiMessage[]> {
    // 如果未指定阈值，使用模型上下文长度的 80%
    const threshold = maxTokens ?? Math.floor(this.getContextLength() * 0.8)
    const totalTokens = this.estimateTotalTokens(messages)
    
    // 如果在限制内，不需要压缩
    if (totalTokens <= threshold) {
      return messages
    }

    console.log(`[Agent] 智能记忆压缩: ${totalTokens} tokens -> 目标 ${threshold} tokens`)

    // 1. 将消息按轮次分组（保证 tool_calls 和 tool 消息配对）
    const messageGroups = this.groupMessagesByTurn(messages)
    
    const result: AiMessage[] = []
    
    // 2. 保留 system prompt（必须）
    const systemGroup = messageGroups.find(g => g.length === 1 && g[0].role === 'system')
    if (systemGroup) {
      result.push(systemGroup[0])
    }

    // 3. 获取非系统消息组
    const nonSystemGroups = messageGroups.filter(g => !(g.length === 1 && g[0].role === 'system'))
    
    // 4. 压缩每个组内的工具输出
    const compressedGroups = nonSystemGroups.map(group => 
      group.map(msg => {
        if (msg.role === 'tool' && msg.content.length > 2000) {
          return {
            ...msg,
            content: this.compressToolOutput(msg.content)
          }
        }
        if (msg.role === 'assistant' && msg.content.length > 3000) {
          return {
            ...msg,
            content: msg.content.substring(0, 3000) + '\n... [回复已截断]'
          }
        }
        return msg
      })
    )

    // 5. 计算压缩后的 token
    const allCompressedMessages = compressedGroups.flat()
    const compressedTokens = this.estimateTotalTokens([...result, ...allCompressedMessages])
    
    if (compressedTokens <= threshold) {
      return [...result, ...allCompressedMessages]
    }

    // 6. 需要进一步压缩，使用 Memory Folding 策略
    console.log('[Agent] 启用 Memory Folding 策略')
    
    // 提取关键信息作为记忆锚点
    const keyPoints = this.extractKeyPoints(allCompressedMessages)
    
    // 7. 以组为单位计算重要性并选择
    const recentGroupCount = 3  // 保留最近的 3 组对话
    const recentGroups = compressedGroups.slice(-recentGroupCount)
    const historyGroups = compressedGroups.slice(0, -recentGroupCount)
    
    // 计算历史组的重要性（取组内最高分）
    const historyWithScore = historyGroups.map((group, groupIndex) => {
      const groupScore = Math.max(
        ...group.map((msg, msgIndex) => 
          this.calculateMessageImportance(msg, groupIndex * 10 + msgIndex, historyGroups.length * 10)
        )
      )
      return { group, score: groupScore }
    })
    
    // 选择最重要的历史组
    const targetHistoryGroups = Math.max(2, Math.floor((threshold - this.estimateTotalTokens(result)) / 2000))
    const importantHistoryGroups = historyWithScore
      .sort((a, b) => b.score - a.score)
      .slice(0, targetHistoryGroups)
      .sort((a, b) => historyGroups.indexOf(a.group) - historyGroups.indexOf(b.group))  // 恢复时间顺序
      .map(item => item.group)
    
    // 8. 构建摘要消息
    let summaryContent = '[系统提示：对话历史已被智能压缩，以下是关键信息摘要]\n\n'
    
    if (keyPoints.length > 0) {
      summaryContent += '**关键记录**：\n'
      keyPoints.forEach(point => {
        summaryContent += `- ${point}\n`
      })
      summaryContent += '\n'
    }
    
    summaryContent += '如需了解更多历史细节，请询问用户。'
    
    const summaryMsg: AiMessage = {
      role: 'user',
      content: summaryContent
    }

    // 9. 组合最终结果（按组展开）
    const finalMessages = [
      ...result, 
      summaryMsg, 
      ...importantHistoryGroups.flat(), 
      ...recentGroups.flat()
    ]
    
    console.log(`[Agent] Memory Folding 完成: 保留 ${finalMessages.length} 条消息，提取 ${keyPoints.length} 个关键点`)
    
    return finalMessages
  }

  /**
   * 分析任务并添加规划提示
   */
  private enhanceUserMessage(userMessage: string): string {
    const complexity = analyzeTaskComplexity(userMessage)
    const planningPrompt = generatePlanningPrompt(userMessage, complexity)
    
    if (planningPrompt) {
      return userMessage + '\n' + planningPrompt
    }
    return userMessage
  }

  /**
   * 添加执行步骤
   */
  private addStep(agentId: string, step: Omit<AgentStep, 'id' | 'timestamp'>): AgentStep {
    const run = this.runs.get(agentId)
    if (!run) return step as AgentStep

    const fullStep: AgentStep = {
      ...step,
      id: `step_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      timestamp: Date.now()
    }
    run.steps.push(fullStep)

    // 触发回调
    if (this.onStepCallback) {
      this.onStepCallback(agentId, fullStep)
    }

    return fullStep
  }

  /**
   * 更新执行步骤（用于流式输出）
   */
  private updateStep(agentId: string, stepId: string, updates: Partial<Omit<AgentStep, 'id' | 'timestamp'>>): void {
    const run = this.runs.get(agentId)
    if (!run) return

    // 查找现有步骤
    let step = run.steps.find(s => s.id === stepId)
    
    if (!step) {
      // 如果步骤不存在，创建一个新的
      step = {
        id: stepId,
        type: updates.type || 'message',
        content: updates.content || '',
        timestamp: Date.now(),
        isStreaming: updates.isStreaming
      }
      run.steps.push(step)
    } else {
      // 更新现有步骤
      Object.assign(step, updates)
    }

    // 触发回调
    if (this.onStepCallback) {
      this.onStepCallback(agentId, step)
    }
  }

  /**
   * 等待用户确认
   */
  private waitForConfirmation(
    agentId: string,
    toolCallId: string,
    toolName: string,
    toolArgs: Record<string, unknown>,
    riskLevel: RiskLevel
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const run = this.runs.get(agentId)
      if (!run) {
        resolve(false)
        return
      }

      // 添加确认步骤
      this.addStep(agentId, {
        type: 'confirm',
        content: `等待用户确认: ${toolName}`,
        toolName,
        toolArgs,
        riskLevel
      })

      const confirmation: PendingConfirmation = {
        agentId,
        toolCallId,
        toolName,
        toolArgs,
        riskLevel,
        resolve: (approved, modifiedArgs) => {
          run.pendingConfirmation = undefined
          if (modifiedArgs) {
            Object.assign(toolArgs, modifiedArgs)
          }
          resolve(approved)
        }
      }

      run.pendingConfirmation = confirmation

      // 通知前端需要确认
      if (this.onNeedConfirmCallback) {
        this.onNeedConfirmCallback(confirmation)
      }
    })
  }

  /**
   * 处理用户确认
   */
  confirmToolCall(
    agentId: string,
    toolCallId: string,
    approved: boolean,
    modifiedArgs?: Record<string, unknown>
  ): boolean {
    const run = this.runs.get(agentId)
    if (!run || !run.pendingConfirmation) return false

    if (run.pendingConfirmation.toolCallId === toolCallId) {
      run.pendingConfirmation.resolve(approved, modifiedArgs)
      return true
    }
    return false
  }

  /**
   * 运行 Agent
   */
  async run(
    ptyId: string,
    userMessage: string,
    context: AgentContext,
    config?: Partial<AgentConfig>,
    profileId?: string
  ): Promise<string> {
    const agentId = this.generateId()
    const fullConfig = { ...DEFAULT_AGENT_CONFIG, ...config }

    // 初始化运行状态
    const run: AgentRun = {
      id: agentId,
      ptyId,
      messages: [],
      steps: [],
      isRunning: true,
      aborted: false,
      pendingUserMessages: [],  // 用户补充消息队列
      config: fullConfig,
      context,  // 保存上下文供工具使用
      // 初始化反思追踪（增强版）
      reflection: {
        toolCallCount: 0,
        failureCount: 0,
        totalFailures: 0,
        successCount: 0,
        lastCommands: [],
        lastReflectionAt: 0,
        currentStrategy: 'default',
        strategySwitches: [],
        detectedIssues: [],
        appliedFixes: []
      }
    }
    this.runs.set(agentId, run)

    // 构建系统提示（包含 MBTI 风格）
    const mbtiType = this.configService?.getAgentMbti() ?? null
    
    // 获取知识库上下文（如果启用）
    let knowledgeContext = ''
    let knowledgeEnabled = false
    try {
      const knowledgeService = getKnowledgeService()
      if (knowledgeService && knowledgeService.isEnabled()) {
        knowledgeEnabled = true
        // buildContext 内部会自动初始化服务
        knowledgeContext = await knowledgeService.buildContext(userMessage, {
          hostId: context.hostId
        })
        if (knowledgeContext) {
          console.log('[Agent] 知识库上下文已加载，长度:', knowledgeContext.length)
        }
      }
    } catch (e) {
      // 知识库服务出错，忽略
      console.log('[Agent] Knowledge service error:', e)
    }
    
    const systemPrompt = buildSystemPrompt(context, this.hostProfileService, mbtiType, knowledgeContext, knowledgeEnabled)
    run.messages.push({ role: 'system', content: systemPrompt })

    // 添加历史对话（保持 Agent 记忆）
    if (context.historyMessages && context.historyMessages.length > 0) {
      // 只保留最近的对话历史，避免超出上下文限制
      const recentHistory = context.historyMessages.slice(-10)
      for (const msg of recentHistory) {
        if (msg.role === 'user' || msg.role === 'assistant') {
          run.messages.push({ 
            role: msg.role as 'user' | 'assistant', 
            content: msg.content 
          })
        }
      }
    }

    // 添加当前用户消息（包含任务复杂度分析和规划提示）
    const enhancedMessage = this.enhanceUserMessage(userMessage)
    run.messages.push({ role: 'user', content: enhancedMessage })

    // 添加开始步骤
    this.addStep(agentId, {
      type: 'thinking',
      content: '正在分析任务...'
    })

    let stepCount = 0
    let lastResponse: ChatWithToolsResult | null = null

    // 创建工具执行器配置
    const toolExecutorConfig: ToolExecutorConfig = {
      ptyService: this.ptyService,
      hostProfileService: this.hostProfileService,
      mcpService: this.mcpService,
      addStep: (step) => this.addStep(agentId, step),
      updateStep: (stepId, updates) => this.updateStep(agentId, stepId, updates),
      waitForConfirmation: (toolCallId, toolName, toolArgs, riskLevel) =>
        this.waitForConfirmation(agentId, toolCallId, toolName, toolArgs, riskLevel),
      isAborted: () => run.aborted,
      getHostId: () => run.context.hostId,
      hasPendingUserMessage: () => run.pendingUserMessages.length > 0
    }

    try {
      // Agent 执行循环
      // maxSteps = 0 表示无限制，由 Agent 自行决定何时结束
      while ((fullConfig.maxSteps === 0 || stepCount < fullConfig.maxSteps) && run.isRunning && !run.aborted) {
        stepCount++

        // 处理用户补充消息（如果有）
        if (run.pendingUserMessages.length > 0) {
          // 为每条补充消息添加步骤（在正确的时机显示）
          for (const msg of run.pendingUserMessages) {
            this.addStep(agentId, {
              type: 'user_supplement',
              content: msg
            })
          }
          const supplementMsg = run.pendingUserMessages.join('\n')
          run.messages.push({ 
            role: 'user', 
            content: `[用户补充信息]\n${supplementMsg}` 
          })
          run.pendingUserMessages = []
        }

        // 上下文压缩：如果消息过长，进行压缩
        if (stepCount > 3) {  // 只在多轮对话后检查压缩
          run.messages = await this.compressMessages(run.messages)
        }

        // 创建流式消息步骤
        const streamStepId = this.generateId()
        let streamContent = ''
        
        // 使用流式 API 调用 AI
        const response = await new Promise<ChatWithToolsResult>((resolve, reject) => {
          this.aiService.chatWithToolsStream(
            run.messages,
            getAgentTools(this.mcpService),
            // onChunk: 流式文本更新
            (chunk) => {
              streamContent += chunk
              // 发送流式更新
              this.updateStep(agentId, streamStepId, {
                type: 'message',
                content: streamContent,
                isStreaming: true
              })
            },
            // onToolCall: 工具调用（流式结束时）
            (_toolCalls) => {
              // 工具调用会在 onDone 中处理
            },
            // onDone: 完成
            (result) => {
              // 标记流式结束
              if (streamContent) {
                this.updateStep(agentId, streamStepId, {
                  type: 'message',
                  content: streamContent,
                  isStreaming: false
                })
              }
              resolve(result)
            },
            // onError: 错误
            (error) => {
              reject(new Error(error))
            },
            profileId
          )
        })
        
        lastResponse = response

        // 如果没有流式内容但有最终内容，添加消息步骤
        if (!streamContent && response.content) {
          this.addStep(agentId, {
            type: 'message',
            content: response.content
          })
        }

        // 检查是否有工具调用
        if (response.tool_calls && response.tool_calls.length > 0) {
          // 将 assistant 消息（包含 tool_calls 和 reasoning_content）添加到历史
          // DeepSeek think 模型要求后续消息必须包含 reasoning_content
          const assistantMsg: AiMessage = {
            role: 'assistant',
            content: response.content || '',  // 不使用 streamContent，因为它包含 HTML 标签
            tool_calls: response.tool_calls
          }
          // 如果有思考内容，添加到消息中（DeepSeek think 模型要求）
          if (response.reasoning_content) {
            assistantMsg.reasoning_content = response.reasoning_content
          }
          run.messages.push(assistantMsg)

          // 执行每个工具调用
          for (const toolCall of response.tool_calls) {
            if (run.aborted) break

            // 解析工具参数
            let toolArgs: Record<string, unknown> = {}
            try {
              toolArgs = JSON.parse(toolCall.function.arguments)
            } catch {
              // 忽略解析错误
            }

            const result = await executeTool(
              ptyId,
              toolCall,
              run.config,  // 使用运行时配置，支持动态更新
              context.terminalOutput,
              toolExecutorConfig
            )

            // 更新反思追踪状态
            this.updateReflectionTracking(run, toolCall.function.name, toolArgs, result)

            // 将工具结果添加到消息历史
            run.messages.push({
              role: 'tool',
              content: result.success 
                ? result.output 
                : `错误: ${result.error}`,
              tool_call_id: toolCall.id
            })
          }

          // 检查是否需要触发反思
          if (this.shouldTriggerReflection(run)) {
            const reflectionPrompt = this.generateReflectionPrompt(run)
            run.messages.push({
              role: 'user',
              content: reflectionPrompt
            })
            run.reflection.lastReflectionAt = run.reflection.toolCallCount
            // 重置失败计数，给 Agent 新的机会
            run.reflection.failureCount = 0
          }
        } else {
          // 没有工具调用，Agent 完成
          break
        }
      }

      // 完成
      run.isRunning = false

      // 检查是否是用户主动中止
      if (run.aborted) {
        console.log('[Agent] run was aborted by user')
        // 用户中止时抛出错误，让前端知道是中止而非正常完成
        throw new Error('用户中止了 Agent 执行')
      }

      const finalMessage = lastResponse?.content || '任务完成'

      console.log('[Agent] run completed normally, calling onCompleteCallback')
      if (this.onCompleteCallback) {
        this.onCompleteCallback(agentId, finalMessage)
      }

      console.log('[Agent] returning finalMessage')
      return finalMessage

    } catch (error) {
      run.isRunning = false
      const errorMsg = error instanceof Error ? error.message : '未知错误'
      console.log('[Agent] caught error:', errorMsg)
      
      // 检查是否是用户主动中止
      const isUserAborted = errorMsg === '用户中止了 Agent 执行' || run.aborted
      
      if (isUserAborted) {
        // 用户主动中止，直接抛出错误，不视为成功
        // 注意：不调用 onErrorCallback，因为 abort() 方法已经添加了错误步骤
        console.log('[Agent] user aborted, throwing error without callback')
        throw error
      }
      
      // 如果是 AI 请求被中止但已经有有效的响应内容，视为正常完成
      const isAiAbortedError = errorMsg.toLowerCase().includes('aborted')
      const hasValidResponse = lastResponse && lastResponse.content && lastResponse.content.length > 10
      
      if (isAiAbortedError && hasValidResponse) {
        // 已经有有效响应，视为正常完成
        console.log('[Agent] AI request aborted but has valid response, treating as success')
        const finalMessage = lastResponse!.content || '任务完成'
        
        if (this.onCompleteCallback) {
          this.onCompleteCallback(agentId, finalMessage)
        }
        
        return finalMessage
      }
      
      console.log('[Agent] error is not recoverable, adding error step')
      this.addStep(agentId, {
        type: 'error',
        content: `执行出错: ${errorMsg}`
      })

      if (this.onErrorCallback) {
        this.onErrorCallback(agentId, errorMsg)
      }

      throw error
    }
  }

  /**
   * 中止 Agent 执行
   */
  abort(agentId: string): boolean {
    const run = this.runs.get(agentId)
    if (!run) return false

    run.aborted = true
    run.isRunning = false

    // 如果有待确认的操作，拒绝它
    if (run.pendingConfirmation) {
      run.pendingConfirmation.resolve(false)
    }

    // 中止所有正在执行的命令
    this.commandExecutor.abortAll()

    this.addStep(agentId, {
      type: 'error',
      content: '用户中止了 Agent 执行'
    })

    return true
  }

  /**
   * 获取 Agent 运行状态
   */
  getRunStatus(agentId: string): {
    isRunning: boolean
    steps: AgentStep[]
    pendingConfirmation?: PendingConfirmation
  } | null {
    const run = this.runs.get(agentId)
    if (!run) return null

    return {
      isRunning: run.isRunning,
      steps: run.steps,
      pendingConfirmation: run.pendingConfirmation
    }
  }

  /**
   * 更新运行中的 Agent 配置（如严格模式）
   */
  updateConfig(agentId: string, config: Partial<AgentConfig>): boolean {
    const run = this.runs.get(agentId)
    if (!run) return false

    // 合并配置
    run.config = { ...run.config, ...config }
    return true
  }

  /**
   * 添加用户补充消息（在 Agent 执行过程中）
   * 消息会在下一轮 AI 请求时被包含并显示
   */
  addUserMessage(agentId: string, message: string): boolean {
    const run = this.runs.get(agentId)
    if (!run || !run.isRunning) return false

    // 添加到待处理队列（步骤会在处理时添加，确保顺序正确）
    run.pendingUserMessages.push(message)

    return true
  }

  /**
   * 清理已完成的运行记录
   */
  cleanup(agentId: string): void {
    this.runs.delete(agentId)
  }
}
