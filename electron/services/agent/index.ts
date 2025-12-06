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
  RiskLevel
} from './types'
import { DEFAULT_AGENT_CONFIG } from './types'
import { getAgentTools } from './tools'
import { assessCommandRisk, analyzeCommand } from './risk-assessor'
import type { CommandHandlingInfo } from './risk-assessor'
import { executeTool, ToolExecutorConfig } from './tool-executor'
import { buildSystemPrompt } from './prompt-builder'
import { analyzeTaskComplexity, generatePlanningPrompt } from './planner'

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
   * 生成反思提示消息
   * 只在检测到问题时触发，提示简洁自然
   */
  private generateReflectionPrompt(run: AgentRun): string {
    const { reflection } = run
    
    // 检测到循环
    if (this.detectCommandLoop(reflection.lastCommands)) {
      return `（注意：你似乎在重复相同的操作，请换个方法试试，或者告诉用户遇到了什么困难）`
    }
    
    // 连续失败
    if (reflection.failureCount >= 3) {
      return `（注意：已连续失败 ${reflection.failureCount} 次，建议换个思路或向用户说明情况）`
    }
    
    return ''
  }

  /**
   * 检查是否需要触发反思
   * 只在真正出问题时触发，避免打扰正常流程
   */
  private shouldTriggerReflection(run: AgentRun): boolean {
    const { reflection } = run
    
    // 连续失败 3 次以上触发
    if (reflection.failureCount >= 3) {
      return true
    }
    
    // 检测到命令循环时触发
    if (this.detectCommandLoop(reflection.lastCommands)) {
      return true
    }
    
    return false
  }

  /**
   * 更新反思追踪状态
   */
  private updateReflectionTracking(
    run: AgentRun, 
    toolName: string, 
    toolArgs: Record<string, unknown>,
    success: boolean
  ): void {
    run.reflection.toolCallCount++
    
    // 追踪命令执行
    if (toolName === 'execute_command' && toolArgs.command) {
      run.reflection.lastCommands.push(toolArgs.command as string)
      // 只保留最近 5 个命令
      if (run.reflection.lastCommands.length > 5) {
        run.reflection.lastCommands.shift()
      }
    }
    
    // 更新失败计数
    if (success) {
      run.reflection.failureCount = 0
    } else {
      run.reflection.failureCount++
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
   * 对于长输出，只保留关键信息
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
   * 压缩消息历史以节省上下文空间
   * 保留 system prompt、最近的对话和关键信息
   */
  private async compressMessages(
    messages: AiMessage[], 
    maxTokens: number = 12000
  ): Promise<AiMessage[]> {
    const totalTokens = this.estimateTotalTokens(messages)
    
    // 如果在限制内，不需要压缩
    if (totalTokens <= maxTokens) {
      return messages
    }

    console.log(`[Agent] 消息压缩: ${totalTokens} tokens -> 目标 ${maxTokens} tokens`)

    const result: AiMessage[] = []
    
    // 1. 保留 system prompt
    const systemMsg = messages.find(m => m.role === 'system')
    if (systemMsg) {
      result.push(systemMsg)
    }

    // 2. 找到最近的用户消息和相关的助手回复
    const nonSystemMessages = messages.filter(m => m.role !== 'system')
    
    // 3. 压缩工具输出
    const compressedMessages = nonSystemMessages.map(msg => {
      if (msg.role === 'tool' && msg.content.length > 2000) {
        return {
          ...msg,
          content: this.compressToolOutput(msg.content)
        }
      }
      // 压缩超长的 assistant 回复
      if (msg.role === 'assistant' && msg.content.length > 3000) {
        return {
          ...msg,
          content: msg.content.substring(0, 3000) + '\n... [回复已截断]'
        }
      }
      return msg
    })

    // 4. 计算压缩后的 token
    const compressedTokens = this.estimateTotalTokens([...result, ...compressedMessages])
    
    if (compressedTokens <= maxTokens) {
      return [...result, ...compressedMessages]
    }

    // 5. 如果还是太长，只保留最近的 N 条消息
    const reserveCount = Math.max(10, Math.floor(maxTokens / 500))
    const recentMessages = compressedMessages.slice(-reserveCount)
    
    // 添加一条摘要消息，说明之前的对话被压缩了
    const summaryMsg: AiMessage = {
      role: 'user',
      content: `[系统提示：之前的对话历史因上下文限制已被压缩。请继续当前任务，如需了解之前的上下文，请询问用户。]`
    }

    return [...result, summaryMsg, ...recentMessages]
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
      // 初始化反思追踪
      reflection: {
        toolCallCount: 0,
        failureCount: 0,
        lastCommands: [],
        lastReflectionAt: 0
      }
    }
    this.runs.set(agentId, run)

    // 构建系统提示（包含 MBTI 风格）
    const mbtiType = this.configService?.getAgentMbti() ?? null
    const systemPrompt = buildSystemPrompt(context, this.hostProfileService, mbtiType)
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
      waitForConfirmation: (toolCallId, toolName, toolArgs, riskLevel) => 
        this.waitForConfirmation(agentId, toolCallId, toolName, toolArgs, riskLevel),
      isAborted: () => run.aborted,
      getHostId: () => run.context.hostId
    }

    try {
      // Agent 执行循环
      while (stepCount < fullConfig.maxSteps && run.isRunning && !run.aborted) {
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
            this.updateReflectionTracking(run, toolCall.function.name, toolArgs, result.success)

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
