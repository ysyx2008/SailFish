/**
 * Agent 抽象基类
 * 
 * 实现 Agent 的核心执行逻辑，子类（如 TerminalAgent）实现特定行为。
 * 
 * 职责划分：
 * - Agent（基类）：执行循环、AI 交互、工具执行、步骤管理、反思机制
 * - TerminalAgent（子类）：终端特定的工具列表、系统提示、终端交互
 */

import type { AiService, AiMessage, ToolCall, ChatWithToolsResult, ToolDefinition } from '../ai.service'
import type {
  AgentConfig,
  AgentStep,
  AgentContext,
  AgentPlan,
  AgentRun,
  AgentCallbacks,
  AgentServices,
  RunOptions,
  PromptOptions,
  KnowledgeContextResult,
  RunStatus,
  StepResult,
  RiskLevel,
  ExecutionMode,
  AgentExecutionPhase,
  ReflectionState,
  WorkerAgentOptions,
  PendingConfirmation
} from './types'
import { DEFAULT_AGENT_CONFIG } from './types'
import { TaskMemoryStore } from './task-memory'
import type { ToolExecutorConfig } from './tools/types'
import { executeTool } from './tools/index'
import { buildTaskHistoryContext } from './context-builder'
import { getKnowledgeService } from '../knowledge'
import { t } from './i18n'
import { createSkillSession, SkillSession } from './skills'

/**
 * Agent 抽象基类
 */
export abstract class Agent {
  // ==================== 配置（持久化） ====================
  
  /** 执行模式 */
  executionMode: ExecutionMode = 'strict'
  
  /** 命令超时时间（毫秒） */
  commandTimeout: number = 30000
  
  // ==================== 状态（持久化） ====================
  
  /** 当前执行计划 */
  currentPlan?: AgentPlan
  
  /** 任务记忆存储 */
  protected taskMemory: TaskMemoryStore
  
  // ==================== 运行时 ====================
  
  /** 当前运行状态 */
  protected currentRun?: AgentRun
  
  /** 依赖服务 */
  protected services: AgentServices
  
  /** 事件回调 */
  protected callbacks?: AgentCallbacks
  
  /** ID 计数器 */
  private idCounter = 0
  
  // ==================== 构造函数 ====================
  
  constructor(services: AgentServices) {
    this.services = services
    this.taskMemory = this.createTaskMemory()
  }
  
  /**
   * 创建任务记忆存储（可被子类重写以支持测试 mock）
   */
  protected createTaskMemory(): TaskMemoryStore {
    return new TaskMemoryStore()
  }
  
  // ==================== 抽象方法（子类必须实现） ====================
  
  /**
   * 获取当前可用的工具列表
   */
  abstract getAvailableTools(): ToolDefinition[]
  
  /**
   * 构建系统提示词
   */
  protected abstract buildSystemPrompt(context: AgentContext, options: PromptOptions): string
  
  /**
   * 获取 Agent 标识（用于日志和调试）
   */
  protected abstract getAgentId(): string
  
  // ==================== 公开方法 ====================
  
  /**
   * 执行 Agent 任务
   */
  async run(message: string, context: AgentContext, options?: RunOptions): Promise<string> {
    // 检查是否已有运行中的任务
    if (this.currentRun?.isRunning) {
      throw new Error('Agent is already running')
    }
    
    const run = this.initializeRun(message, context, options)
    
    try {
      await this.buildContext(run, message, options?.profileId)
      const result = await this.executeLoop(run)
      this.finalizeRun(run, result)
      return result
    } catch (error) {
      this.handleError(run, error)
      throw error
    } finally {
      this.cleanupRun(run)
    }
  }
  
  /**
   * 中止当前运行
   */
  abort(): boolean {
    if (!this.currentRun || !this.currentRun.isRunning) {
      return false
    }
    
    this.currentRun.aborted = true
    this.currentRun.isRunning = false
    
    // 中止 AI 请求
    if (this.currentRun.requestId) {
      this.services.aiService.abort(this.currentRun.requestId)
    }
    
    return true
  }
  
  /**
   * 检查是否正在运行
   */
  isRunning(): boolean {
    return this.currentRun?.isRunning ?? false
  }
  
  /**
   * 更新配置
   */
  updateConfig(config: Partial<AgentConfig>): void {
    if (config.executionMode !== undefined) {
      this.executionMode = config.executionMode
    }
    if (config.commandTimeout !== undefined) {
      this.commandTimeout = config.commandTimeout
    }
    // 如果正在运行，也更新运行时配置
    if (this.currentRun) {
      Object.assign(this.currentRun.config, config)
    }
  }
  
  /**
   * 添加用户补充消息
   */
  addUserMessage(message: string): boolean {
    if (!this.currentRun || !this.currentRun.isRunning) {
      return false
    }
    
    this.currentRun.pendingUserMessages.push(message)
    
    // 如果 Agent 正在等待（AI 思考中），中断当前请求让它处理新消息
    if (this.currentRun.executionPhase === 'thinking' && this.currentRun.requestId) {
      this.services.aiService.abort(this.currentRun.requestId)
    }
    
    return true
  }
  
  /**
   * 处理工具调用确认
   */
  confirmToolCall(
    toolCallId: string, 
    approved: boolean, 
    modifiedArgs?: Record<string, unknown>,
    alwaysAllow?: boolean
  ): boolean {
    if (!this.currentRun || !this.currentRun.pendingConfirmation) {
      return false
    }
    
    if (this.currentRun.pendingConfirmation.toolCallId === toolCallId) {
      // 如果用户选择"始终允许"，将工具+参数加入白名单
      if (approved && alwaysAllow) {
        const { toolName, toolArgs } = this.currentRun.pendingConfirmation
        const key = this.generateAllowedToolKey(toolName, modifiedArgs || toolArgs)
        this.currentRun.allowedTools.add(key)
      }
      
      this.currentRun.pendingConfirmation.resolve(approved, modifiedArgs)
      return true
    }
    
    return false
  }
  
  /**
   * 获取运行状态
   */
  getRunStatus(): RunStatus | undefined {
    if (!this.currentRun) {
      return undefined
    }
    
    return {
      isRunning: this.currentRun.isRunning,
      phase: this.currentRun.executionPhase,
      currentToolName: this.currentRun.currentToolName,
      stepCount: this.currentRun.steps.length,
      hasPendingConfirmation: !!this.currentRun.pendingConfirmation
    }
  }
  
  /**
   * 获取当前执行阶段
   */
  getExecutionPhase(): AgentExecutionPhase {
    return this.currentRun?.executionPhase ?? 'idle'
  }
  
  /**
   * 设置回调
   */
  setCallbacks(callbacks: AgentCallbacks): void {
    this.callbacks = callbacks
  }
  
  /**
   * 清理资源
   */
  cleanup(): void {
    if (this.currentRun) {
      this.cleanupRun(this.currentRun)
      this.currentRun = undefined
    }
  }
  
  // ==================== 受保护方法：生命周期 ====================
  
  /**
   * 初始化运行状态
   */
  protected initializeRun(message: string, context: AgentContext, options?: RunOptions): AgentRun {
    const runId = this.generateId()
    const config: AgentConfig = {
      ...DEFAULT_AGENT_CONFIG,
      executionMode: this.executionMode,
      commandTimeout: this.commandTimeout
    }
    
    const run: AgentRun = {
      id: runId,
      ptyId: context.ptyId,
      messages: [],
      steps: [],
      isRunning: true,
      aborted: false,
      pendingUserMessages: [],
      config,
      context,
      reflection: this.createInitialReflectionState(),
      realtimeOutputBuffer: [...context.terminalOutput],
      workerOptions: options?.workerOptions,
      executionPhase: 'thinking',
      skillSession: createSkillSession(this.getAvailableTools()),
      allowedTools: new Set<string>()
    }
    
    this.currentRun = run
    
    // 注册运行级别回调
    if (options?.callbacks) {
      this.callbacks = options.callbacks
    }
    
    // 初始化 TaskMemory（仅首次 run 时）
    // 场景：前端有之前会话的历史步骤，但 Agent 实例刚创建，TaskMemory 为空
    // 将前端历史同步到 TaskMemory，使 AI 能了解之前的对话上下文
    if (context.previousTasks && context.previousTasks.length > 0 && this.taskMemory.getTaskCount() === 0) {
      this.initializeTaskMemoryFromPreviousTasks(context.previousTasks)
    }
    
    // 添加初始步骤
    const initialStep = this.addStep({
      type: 'thinking',
      content: t('ai.preparing'),
      isStreaming: true
    })
    run.initialStepId = initialStep.id
    
    // 设置终端输出监听器
    this.setupOutputListener(run)
    
    return run
  }
  
  /**
   * 从前端传递的 previousTasks 初始化 TaskMemoryStore
   */
  private initializeTaskMemoryFromPreviousTasks(previousTasks: import('./types').PreviousTaskContext[]): void {
    for (const task of previousTasks) {
      // 将 PreviousTaskContext 转换为 AgentStep[]
      const steps: AgentStep[] = task.steps.map((step, index) => ({
        id: `prev_${Date.now()}_${index}`,
        type: step.type as AgentStep['type'],
        content: step.content,
        toolName: step.toolName,
        toolArgs: step.toolArgs,
        toolResult: step.toolResult,
        riskLevel: step.riskLevel as RiskLevel | undefined,
        timestamp: task.timestamp
      }))
      
      // 保存到任务记忆
      this.taskMemory.saveTask(
        `prev_${task.timestamp}`,
        task.userTask,
        steps,
        'success',
        task.finalResult
      )
    }
    
    console.log(`[Agent] Initialized TaskMemory with ${previousTasks.length} previous tasks`)
  }
  
  /**
   * 完成运行，保存任务记忆
   */
  protected finalizeRun(run: AgentRun, result: string): void {
    run.isRunning = false
    
    // 保存任务到记忆
    const status = run.aborted ? 'aborted' : 'success'
    const userRequest = run.messages.find(m => m.role === 'user')?.content || ''
    
    this.taskMemory.saveTask(
      run.id,
      userRequest,
      run.steps,
      status,
      result
    )
    
    // 触发完成回调
    this.callbacks?.onComplete?.(run.id, result, run.pendingUserMessages)
  }
  
  /**
   * 清理运行资源
   */
  protected cleanupRun(run: AgentRun): void {
    // 取消输出监听
    if (run.outputUnsubscribe) {
      run.outputUnsubscribe()
      run.outputUnsubscribe = undefined
    }
    
    // 清理技能会话
    if (run.skillSession) {
      run.skillSession.cleanup()
    }
    
    run.isRunning = false
  }
  
  /**
   * 处理运行错误
   */
  protected handleError(run: AgentRun, error: unknown): void {
    const errorMessage = error instanceof Error ? error.message : String(error)
    
    this.addStep({
      type: 'error',
      content: errorMessage
    })
    
    // 保存失败的任务
    const userRequest = run.messages.find(m => m.role === 'user')?.content || ''
    this.taskMemory.saveTask(
      run.id,
      userRequest,
      run.steps,
      'failed',
      errorMessage
    )
    
    this.callbacks?.onError?.(run.id, errorMessage)
  }
  
  // ==================== 受保护方法：上下文构建 ====================
  
  /**
   * 构建执行上下文
   */
  protected async buildContext(run: AgentRun, message: string, profileId?: string): Promise<void> {
    // 加载知识库上下文
    const knowledgeResult = await this.loadKnowledgeContext(message, run.context.hostId)
    
    // 构建任务历史上下文
    let taskSummaries = ''
    let relatedTaskDigests = ''
    let recentTaskMessages: AiMessage[] = []
    let availableTaskIds: Array<{ id: string; summary: string }> = []
    
    if (this.taskMemory.getTaskCount() > 0) {
      const contextLength = this.getContextLength(profileId)
      const contextResult = buildTaskHistoryContext(this.taskMemory, contextLength, message)
      
      recentTaskMessages = contextResult.recentTaskMessages
      if (contextResult.taskSummarySection) {
        taskSummaries = contextResult.taskSummarySection
      }
      availableTaskIds = contextResult.availableTaskIds
      
      // 语义预加载相关任务摘要
      const relatedDigests = this.taskMemory.getRelatedDigests(message, 3)
      if (relatedDigests.length > 0) {
        relatedTaskDigests = this.taskMemory.formatRelatedDigestsForContext(relatedDigests)
      }
    }
    
    // 构建系统提示
    const promptOptions: PromptOptions = {
      mbtiType: this.services.configService?.getAgentMbti() ?? undefined,
      knowledgeContext: knowledgeResult.context,
      knowledgeEnabled: knowledgeResult.enabled,
      hostMemories: knowledgeResult.hostMemories,
      aiRules: this.services.configService?.getAiRules() ?? '',
      taskSummaries,
      relatedTaskDigests,
      availableTaskIds
    }
    
    const systemPrompt = this.buildSystemPrompt(run.context, promptOptions)
    run.messages.push({ role: 'system', content: systemPrompt })
    
    // 注入最近任务的消息
    if (recentTaskMessages.length > 0) {
      for (const msg of recentTaskMessages) {
        run.messages.push(msg)
      }
    }
    
    // 添加当前用户消息
    const enhancedMessage = this.enhanceUserMessage(message)
    run.messages.push({ role: 'user', content: enhancedMessage })
  }
  
  /**
   * 加载知识库上下文
   */
  protected async loadKnowledgeContext(message: string, hostId?: string): Promise<KnowledgeContextResult> {
    let context = ''
    let enabled = false
    let hostMemories: string[] = []
    
    try {
      const knowledgeService = getKnowledgeService()
      if (knowledgeService && knowledgeService.isEnabled()) {
        enabled = true
        context = await knowledgeService.buildContext(message, { hostId })
        
        if (hostId) {
          hostMemories = await knowledgeService.getHostMemoriesForPrompt(hostId, message, 30)
        }
      }
    } catch (e) {
      console.log('[Agent] Knowledge service error:', e)
    }
    
    return { context, enabled, hostMemories }
  }
  
  // ==================== 受保护方法：执行循环 ====================
  
  /**
   * 主执行循环
   */
  protected async executeLoop(run: AgentRun): Promise<string> {
    let stepCount = 0
    let lastResponse: ChatWithToolsResult | null = null
    let hasExecutedAnyTool = false
    let noToolCallRetryCount = 0
    const MAX_NO_TOOL_RETRIES = 2
    
    // 创建工具执行器配置
    const toolExecutorConfig = this.createToolExecutorConfig(run)
    
    // 外层循环：支持从 catch 块恢复
    executionLoop: while (run.isRunning && !run.aborted) {
      try {
        // 内层循环：Agent 执行
        while ((run.config.maxSteps === 0 || stepCount < run.config.maxSteps) && run.isRunning && !run.aborted) {
          stepCount++
          
          // 处理待处理的用户消息
          this.processPendingUserMessages(run)
          
          // 执行单步
          const stepResult = await this.executeStep(run, toolExecutorConfig)
          
          if (stepResult.response) {
            lastResponse = stepResult.response
          }
          
          if (stepResult.hasToolCalls) {
            hasExecutedAnyTool = true
            noToolCallRetryCount = 0
          }
          
          // 处理无工具调用的情况
          if (!stepResult.hasToolCalls) {
            if (!hasExecutedAnyTool) {
              // 从未执行过工具
              if (run.pendingUserMessages.length > 0) {
                continue
              }
              
              if (lastResponse?.content?.trim()) {
                // 直接返回，让 run() 方法中的 finalizeRun 处理完成回调
                return lastResponse.content
              }
              
              noToolCallRetryCount++
              if (noToolCallRetryCount >= MAX_NO_TOOL_RETRIES) {
                this.addStep({
                  type: 'error',
                  content: `⚠️ ${t('agent.no_content')}\n\n${t('agent.no_content_reasons')}`
                })
                return t('agent.no_response')
              }
              continue
            }
            
            // 已执行过工具，检查是否有待处理的用户消息
            if (run.pendingUserMessages.length > 0) {
              continue
            }
            
            // 检查计划进度
            const planAction = this.checkPlanProgress(run)
            if (planAction === 'continue') {
              continue
            }
            
            // 正常结束，直接返回结果
            const finalResult = lastResponse?.content || t('agent.task_complete')
            return finalResult
          }
        }
        
        // 循环正常结束
        break executionLoop
        
      } catch (error) {
        // 检查是否是用户消息中断
        const errorMsg = error instanceof Error ? error.message : String(error)
        const isAborted = errorMsg.toLowerCase().includes('aborted')
        
        if (isAborted && run.pendingUserMessages.length > 0) {
          console.log('[Agent] AI 输出被用户消息中断，继续循环处理')
          continue executionLoop
        }
        
        throw error
      }
    }
    
    // 被中止
    if (run.aborted) {
      return t('error.operation_aborted')
    }
    
    return lastResponse?.content || t('agent.task_complete')
  }
  
  /**
   * 执行单步
   */
  protected async executeStep(
    run: AgentRun, 
    toolExecutorConfig: ToolExecutorConfig
  ): Promise<{ response: ChatWithToolsResult | null; hasToolCalls: boolean }> {
    // 调用 AI
    const response = await this.callAiWithStreaming(run)
    
    // 处理工具调用
    if (response.tool_calls && response.tool_calls.length > 0) {
      // 移除初始步骤
      if (run.initialStepId) {
        this.removeStep(run.initialStepId)
        run.initialStepId = undefined
      }
      
      // 添加 assistant 消息到历史
      const assistantMsg: AiMessage = {
        role: 'assistant',
        content: response.content || '',
        tool_calls: response.tool_calls
      }
      if (response.reasoning_content) {
        assistantMsg.reasoning_content = response.reasoning_content
      }
      run.messages.push(assistantMsg)
      
      // 执行工具调用
      await this.executeToolCalls(run, response.tool_calls, toolExecutorConfig)
      
      // 检查反思
      this.checkAndTriggerReflection(run)
      
      return { response, hasToolCalls: true }
    }
    
    return { response, hasToolCalls: false }
  }
  
  // ==================== 受保护方法：AI 交互 ====================
  
  /**
   * 流式调用 AI
   */
  protected async callAiWithStreaming(run: AgentRun): Promise<ChatWithToolsResult> {
    const streamStepId = this.generateId()
    let streamContent = ''
    let lastContentUpdate = 0
    let pendingUpdate = false
    const STREAM_THROTTLE_MS = 100
    
    const sendContentUpdate = () => {
      this.updateStep(streamStepId, {
        type: 'message',
        content: streamContent,
        isStreaming: true
      })
      lastContentUpdate = Date.now()
      pendingUpdate = false
    }
    
    return new Promise<ChatWithToolsResult>((resolve, reject) => {
      streamContent = ''
      lastContentUpdate = 0
      pendingUpdate = false
      
      const availableTools = this.getAvailableTools()
      run.requestId = run.id
      
      this.services.aiService.chatWithToolsStream(
        run.messages,
        availableTools,
        // onChunk
        (chunk) => {
          streamContent += chunk
          const now = Date.now()
          
          if (lastContentUpdate === 0 && run.initialStepId) {
            this.removeStep(run.initialStepId)
            run.initialStepId = undefined
          }
          
          if (now - lastContentUpdate >= STREAM_THROTTLE_MS || lastContentUpdate === 0) {
            sendContentUpdate()
          } else if (!pendingUpdate) {
            pendingUpdate = true
            setTimeout(() => {
              if (pendingUpdate) {
                sendContentUpdate()
              }
            }, STREAM_THROTTLE_MS)
          }
        },
        // onToolCall
        (_toolCalls) => {
          // 工具调用在 onDone 中处理
        },
        // onDone
        (result) => {
          pendingUpdate = false
          if (streamContent) {
            this.updateStep(streamStepId, {
              type: 'message',
              content: streamContent,
              isStreaming: false
            })
          }
          resolve(result)
        },
        // onError
        (error) => {
          reject(new Error(error))
        },
        undefined, // profileId - 从 run 获取
        undefined, // onToolCallProgress
        run.id // requestId
      )
    })
  }
  
  // ==================== 受保护方法：工具执行 ====================
  
  /**
   * 执行工具调用列表
   */
  protected async executeToolCalls(
    run: AgentRun, 
    toolCalls: ToolCall[],
    toolExecutorConfig: ToolExecutorConfig
  ): Promise<void> {
    for (const toolCall of toolCalls) {
      if (run.aborted) break
      
      // 解析参数
      let toolArgs: Record<string, unknown> = {}
      try {
        toolArgs = JSON.parse(toolCall.function.arguments)
      } catch {
        // 忽略解析错误
      }
      
      // 设置执行阶段
      const toolName = toolCall.function.name
      this.setExecutionPhase(run, toolName)
      
      // 执行工具
      const result = await executeTool(
        run.ptyId,
        toolCall,
        run.config,
        run.context.terminalOutput,
        toolExecutorConfig
      )
      
      // 恢复执行阶段
      run.executionPhase = 'thinking'
      run.currentToolName = undefined
      
      // 更新反思追踪
      this.updateReflectionTracking(run, toolName, toolArgs, result)
      
      // 添加工具结果到消息历史
      run.messages.push({
        role: 'tool',
        content: result.success 
          ? result.output 
          : t('agent.tool_error', { error: result.error || t('agent.unknown_error') }),
        tool_call_id: toolCall.id
      })
    }
  }
  
  /**
   * 创建工具执行器配置
   */
  protected createToolExecutorConfig(run: AgentRun): ToolExecutorConfig {
    return {
      terminalService: this.services.unifiedTerminalService || this.services.ptyService as any,
      hostProfileService: this.services.hostProfileService,
      mcpService: this.services.mcpService,
      skillSession: run.skillSession,
      addStep: (step) => this.addStep(step),
      updateStep: (stepId, updates) => this.updateStep(stepId, updates),
      waitForConfirmation: async (toolCallId, toolName, toolArgs, riskLevel) => {
        const result = await this.waitForConfirmation(run, toolCallId, toolName, toolArgs, riskLevel)
        return result.approved
      },
      isAborted: () => run.aborted,
      getHostId: () => run.context.hostId,
      hasPendingUserMessage: () => run.pendingUserMessages.length > 0,
      peekPendingUserMessage: () => run.pendingUserMessages[0],
      consumePendingUserMessage: () => run.pendingUserMessages.shift(),
      getRealtimeTerminalOutput: () => [...run.realtimeOutputBuffer],
      getCurrentPlan: () => this.currentPlan,
      setCurrentPlan: (plan) => {
        this.currentPlan = plan
      },
      getSftpService: () => this.services.sftpService,
      getSshConfig: (terminalId) => this.services.sshService?.getConfig(terminalId) || null
    }
  }
  
  // ==================== 受保护方法：辅助功能 ====================
  
  /**
   * 添加执行步骤
   */
  protected addStep(step: Partial<AgentStep>): AgentStep {
    const fullStep: AgentStep = {
      id: step.id || this.generateId(),
      type: step.type || 'thinking',
      content: step.content || '',
      timestamp: Date.now(),
      ...step
    }
    
    this.currentRun?.steps.push(fullStep)
    this.callbacks?.onStep?.(this.currentRun?.id || '', fullStep)
    
    return fullStep
  }
  
  /**
   * 更新执行步骤
   */
  protected updateStep(stepId: string, updates: Partial<AgentStep>): void {
    if (!this.currentRun) return
    
    const step = this.currentRun.steps.find(s => s.id === stepId)
    if (step) {
      Object.assign(step, updates)
      this.callbacks?.onStep?.(this.currentRun.id, step)
    }
  }
  
  /**
   * 移除执行步骤
   */
  protected removeStep(stepId: string): void {
    if (!this.currentRun) return
    
    const index = this.currentRun.steps.findIndex(s => s.id === stepId)
    if (index !== -1) {
      this.currentRun.steps.splice(index, 1)
    }
  }
  
  /**
   * 处理待处理的用户消息
   */
  protected processPendingUserMessages(run: AgentRun): void {
    if (run.pendingUserMessages.length === 0) return
    
    for (const msg of run.pendingUserMessages) {
      this.addStep({
        type: 'user_supplement',
        content: msg
      })
    }
    
    const supplementMsg = run.pendingUserMessages.join('\n')
    run.messages.push({ role: 'user', content: supplementMsg })
    
    // 如果有计划，提示 AI
    if (this.currentPlan && this.currentPlan.steps.some(s => s.status === 'pending')) {
      run.messages.push({
        role: 'user',
        content: t('agent.user_supplement_with_plan')
      })
    }
    
    run.pendingUserMessages = []
  }
  
  /**
   * 检查并触发反思
   */
  protected checkAndTriggerReflection(run: AgentRun): void {
    // 简化的反思检查逻辑
    if (run.reflection.failureCount >= 3) {
      const prompt = '你已经连续失败了几次。请分析失败原因，尝试不同的方法。'
      run.messages.push({ role: 'user', content: prompt })
      run.reflection.failureCount = 0
      run.reflection.reflectionCount++
    }
  }
  
  /**
   * 检查计划进度
   */
  protected checkPlanProgress(run: AgentRun): 'continue' | 'complete' {
    if (!this.currentPlan) {
      return 'complete'
    }
    
    const pendingSteps = this.currentPlan.steps.filter(s => 
      s.status === 'pending' || s.status === 'in_progress'
    )
    
    if (pendingSteps.length > 0) {
      // 提示继续执行计划
      const stepTitles = pendingSteps.map((s, i) => `${i + 1}. ${s.title}`).join('\n')
      const hint = t('agent.plan_incomplete', { count: pendingSteps.length, steps: stepTitles })
      run.messages.push({ role: 'user', content: hint })
      return 'continue'
    }
    
    return 'complete'
  }
  
  /**
   * 设置执行阶段
   */
  protected setExecutionPhase(run: AgentRun, toolName: string): void {
    if (toolName === 'write_file' || toolName === 'edit_file') {
      run.executionPhase = 'writing_file'
    } else if (toolName === 'execute_command' || toolName === 'run_command') {
      run.executionPhase = 'executing_command'
    } else if (toolName === 'wait') {
      run.executionPhase = 'waiting'
    } else {
      run.executionPhase = 'executing_command'
    }
    run.currentToolName = toolName
  }
  
  /**
   * 更新反思追踪状态
   */
  protected updateReflectionTracking(
    run: AgentRun, 
    toolName: string, 
    toolArgs: Record<string, unknown>,
    result: { success: boolean; output: string; error?: string }
  ): void {
    run.reflection.toolCallCount++
    
    if (result.success) {
      run.reflection.successCount++
      run.reflection.failureCount = 0
    } else {
      run.reflection.failureCount++
      run.reflection.totalFailures++
    }
    
    // 记录最近的工具调用
    const toolSignature = `${toolName}:${JSON.stringify(toolArgs).slice(0, 50)}`
    run.reflection.lastToolCalls.push(toolSignature)
    if (run.reflection.lastToolCalls.length > 5) {
      run.reflection.lastToolCalls.shift()
    }
  }
  
  /**
   * 等待用户确认
   */
  protected waitForConfirmation(
    run: AgentRun,
    toolCallId: string, 
    toolName: string, 
    toolArgs: Record<string, unknown>,
    riskLevel: RiskLevel
  ): Promise<{ approved: boolean; modifiedArgs?: Record<string, unknown> }> {
    return new Promise((resolve) => {
      const confirmation: PendingConfirmation = {
        agentId: run.id,
        toolCallId,
        toolName,
        toolArgs,
        riskLevel,
        resolve: (approved, modifiedArgs) => {
          run.pendingConfirmation = undefined
          run.executionPhase = 'thinking'
          resolve({ approved, modifiedArgs })
        }
      }
      
      run.pendingConfirmation = confirmation
      run.executionPhase = 'confirming'
      this.callbacks?.onNeedConfirm?.(confirmation)
    })
  }
  
  // ==================== 私有方法 ====================
  
  /**
   * 生成唯一 ID
   */
  private generateId(): string {
    return `${Date.now()}_${++this.idCounter}`
  }
  
  /**
   * 生成工具白名单键
   */
  private generateAllowedToolKey(toolName: string, toolArgs: Record<string, unknown>): string {
    const keyArgs = toolName === 'execute_command' ? { command: toolArgs.command } : toolArgs
    return `${toolName}:${JSON.stringify(keyArgs)}`
  }
  
  /**
   * 创建初始反思状态
   */
  private createInitialReflectionState(): ReflectionState {
    return {
      toolCallCount: 0,
      failureCount: 0,
      totalFailures: 0,
      successCount: 0,
      lastCommands: [],
      lastToolCalls: [],
      lastReflectionAt: 0,
      reflectionCount: 0,
      currentStrategy: 'default',
      strategySwitches: [],
      detectedIssues: [],
      appliedFixes: []
    }
  }
  
  /**
   * 设置终端输出监听器
   */
  private setupOutputListener(run: AgentRun): void {
    const MAX_BUFFER_LINES = 200
    const terminalService = this.services.unifiedTerminalService || this.services.ptyService
    
    run.outputUnsubscribe = terminalService.onData(run.ptyId, (data: string) => {
      const newLines = data.split('\n')
      run.realtimeOutputBuffer.push(...newLines)
      
      if (run.realtimeOutputBuffer.length > MAX_BUFFER_LINES) {
        run.realtimeOutputBuffer = run.realtimeOutputBuffer.slice(-MAX_BUFFER_LINES)
      }
    })
  }
  
  /**
   * 获取上下文长度
   */
  private getContextLength(profileId?: string): number {
    // TODO: 从配置服务获取
    return 128000
  }
  
  /**
   * 增强用户消息
   */
  private enhanceUserMessage(message: string): string {
    // TODO: 添加任务复杂度分析等
    return message
  }
}
