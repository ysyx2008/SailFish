/**
 * Agent 抽象基类
 * 
 * 实现 Agent 的核心执行逻辑，子类（如 TerminalAgent）实现特定行为。
 * 
 * 职责划分：
 * - Agent（基类）：执行循环、AI 交互、工具执行、步骤管理
 * - TerminalAgent（子类）：终端特定的工具列表、系统提示、终端交互
 */

import type { AiMessage, ToolCall, ChatWithToolsResult, ToolDefinition } from '../ai.service'
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
  RiskLevel,
  ExecutionMode,
  AgentExecutionPhase,
  PendingConfirmation
} from './types'
import { DEFAULT_AGENT_CONFIG } from './types'
import { TaskMemoryStore } from './task-memory'
import type { ToolExecutorConfig, ToolResult } from './tools/types'
import { executeTool } from './tools/index'
import { buildTaskHistoryContext } from './context-builder'
import { getKnowledgeService } from '../knowledge'
import { parseObservationsFromLLMResponse } from '../knowledge/memory-utils'
import { t } from './i18n'
import { createSkillSession, SkillSession } from './skills'
import { aiDebugService } from '../ai-debug.service'

/**
 * Agent 抽象基类
 */
export abstract class Agent {
  // ==================== 配置（持久化） ====================
  
  /** 执行模式 */
  executionMode: ExecutionMode = 'strict'
  
  /** 命令超时时间（毫秒） */
  commandTimeout: number = 30000
  
  /** AI 配置档案 ID（每个 Agent 实例独立，未设置时 fallback 到全局） */
  profileId?: string
  
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
  
  /** 技能会话（Agent 实例级别，跨 Run 持久化） */
  private _skillSession?: SkillSession
  
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
  
  /**
   * 获取技能会话（延迟初始化，Agent 实例级别持久化）
   * 技能加载状态会在多轮对话间保持
   */
  protected getSkillSession(): SkillSession {
    if (!this._skillSession) {
      this._skillSession = createSkillSession(this.getAvailableTools())
    }
    return this._skillSession
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
    
    // 如果传入了 profileId，更新 Agent 实例的配置
    if (options?.profileId) {
      this.profileId = options.profileId
    }
    
    const run = this.initializeRun(message, context, options)
    
    try {
      await this.buildContext(run, message)
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
  updateConfig(config: Partial<AgentConfig> & { profileId?: string }): void {
    if (config.executionMode !== undefined) {
      this.executionMode = config.executionMode
    }
    if (config.commandTimeout !== undefined) {
      this.commandTimeout = config.commandTimeout
    }
    if (config.profileId !== undefined) {
      this.profileId = config.profileId
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
    
    // 清理技能会话
    if (this._skillSession) {
      this._skillSession.cleanup()
      this._skillSession = undefined
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
      originalUserRequest: message,  // 保存原始用户请求，避免被历史消息覆盖
      messages: [],
      steps: [],
      isRunning: true,
      aborted: false,
      pendingUserMessages: [],
      config,
      context,
      realtimeOutputBuffer: [...context.terminalOutput],
      workerOptions: options?.workerOptions,
      executionPhase: 'thinking',
      skillSession: this.getSkillSession(),  // 使用 Agent 级别的技能会话，跨 Run 持久化
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
    
    this.taskMemory.saveTask(
      run.id,
      run.originalUserRequest,  // 使用原始用户请求，而不是 find() 查找（历史消息会干扰）
      run.steps,
      status,
      result
    )
    
    // 异步提取观察记忆（观察日志模型 - Observation Ledger）
    // 不阻塞用户，后台自动从任务执行记录中提取环境事实
    if (status === 'success' && run.context.hostId) {
      this.extractObservationsAsync(run).catch(err => {
        console.error('[Agent] 自动提取观察失败:', err)
      })
    }
    
    // 触发完成回调
    this.callbacks?.onComplete?.(run.id, result, run.pendingUserMessages)
  }
  
  // ==================== 观察自动提取（Observation Ledger）====================
  
  /** 观察提取配置常量 */
  private static readonly OBSERVATION_EXTRACTION = {
    MAX_CMD_LENGTH: 200,          // 单条命令截断长度
    MAX_OUTPUT_LENGTH: 500,       // 单条输出截断长度
    MAX_TOTAL_LENGTH: 3000,       // 提取 prompt 中执行记录的总长度上限（约 4K tokens）
    MAX_OBSERVATIONS: 10,         // 单次提取的最大观察数
    MAX_CONTENT_LENGTH: 500,      // 单条观察内容的最大长度
    MAX_SOURCE_LENGTH: 200,       // source 字段的最大长度
  } as const

  /**
   * 异步从任务执行记录中提取观察（Observation Ledger 自动提取）
   * 
   * 在任务完成后自动调用，用轻量 LLM 调用提取值得记忆的环境事实。
   * 完全异步，不阻塞用户。
   */
  private async extractObservationsAsync(run: AgentRun): Promise<void> {
    const hostId = run.context.hostId
    if (!hostId) return
    
    const knowledgeService = getKnowledgeService()
    if (!knowledgeService?.isEnabled()) return
    if (knowledgeService.getSettings().enableHostMemory === false) return
    
    // 收集命令执行记录
    const records = this.collectCommandRecords(run)
    if (records.length === 0) return
    
    // 调用 LLM 提取观察
    const observations = await this.callObservationExtractionLLM(run, records)
    if (observations.length === 0) return
    
    // 保存观察到知识库
    await this.saveExtractedObservations(knowledgeService, hostId, observations)
  }

  /**
   * 从任务步骤中收集命令执行记录（命令 + 输出）
   */
  private collectCommandRecords(run: AgentRun): string[] {
    const { MAX_CMD_LENGTH, MAX_OUTPUT_LENGTH, MAX_TOTAL_LENGTH } = Agent.OBSERVATION_EXTRACTION
    const records: string[] = []
    
    for (const step of run.steps) {
      if (step.toolName === 'execute_command' && step.toolArgs?.command) {
        const cmd = String(step.toolArgs.command)
        const shortCmd = cmd.length > MAX_CMD_LENGTH ? cmd.substring(0, MAX_CMD_LENGTH) + '...' : cmd
        records.push(`$ ${shortCmd}`)
      }
      if (step.type === 'tool_result' && step.toolName === 'execute_command' && step.toolResult) {
        const rawOutput = typeof step.toolResult === 'string' ? step.toolResult : JSON.stringify(step.toolResult)
        const output = rawOutput.length > MAX_OUTPUT_LENGTH
          ? rawOutput.substring(0, MAX_OUTPUT_LENGTH) + '...'
          : rawOutput
        records.push(output)
      }
    }
    
    // 截断总长度
    let totalLength = 0
    const truncated: string[] = []
    for (const record of records) {
      if (totalLength + record.length > MAX_TOTAL_LENGTH) break
      truncated.push(record)
      totalLength += record.length
    }
    
    return truncated
  }

  /**
   * 调用 LLM 从执行记录中提取观察
   */
  private async callObservationExtractionLLM(
    run: AgentRun,
    records: string[]
  ): Promise<Array<{ content: string; volatility?: string; source?: string }>> {
    const prompt = `你是一个信息提取助手。从以下任务执行记录中，提取关于这台主机/环境的客观事实。

规则：
- 只提取可复用的环境信息（配置、版本、路径、端口、架构等）
- 跳过临时状态（如当前 CPU 占用率、某个进程 PID、一次性操作结果）
- 跳过操作过程本身（"执行了 xxx 命令"不需要记）
- 每条观察用一句自然语言描述，信息必须完整准确
- 标注 volatility：stable（几乎不变，如 OS 类型、硬件架构）/ moderate（偶尔变，如服务端口、软件版本）/ volatile（经常变，如证书到期时间、磁盘用量）
- 标注 source：信息来源命令

用户请求：${run.originalUserRequest}

执行记录：
${records.join('\n')}

输出严格的 JSON 数组（如果没有值得记录的信息，返回空数组 []）：
[{"content": "描述", "volatility": "stable|moderate|volatile", "source": "来源命令"}]`
    
    try {
      const response = await this.services.aiService.chat([
        { role: 'user', content: prompt }
      ], this.profileId)
      
      const { MAX_CONTENT_LENGTH, MAX_OBSERVATIONS, MAX_SOURCE_LENGTH } = Agent.OBSERVATION_EXTRACTION
      return parseObservationsFromLLMResponse(response, MAX_OBSERVATIONS, MAX_CONTENT_LENGTH, MAX_SOURCE_LENGTH)
    } catch (error) {
      console.error('[Agent] 观察提取 LLM 调用失败:', error)
      return []
    }
  }

  /**
   * 将提取的观察保存到知识库
   */
  private async saveExtractedObservations(
    knowledgeService: NonNullable<ReturnType<typeof getKnowledgeService>>,
    hostId: string,
    observations: Array<{ content: string; volatility?: string; source?: string }>
  ): Promise<void> {
    let savedCount = 0
    
    for (const obs of observations) {
      // volatility 已在 parseObservationsFromLLMResponse 中校验，这里只需设默认值
      const volatility = (obs.volatility as 'stable' | 'moderate' | 'volatile') || 'moderate'
      
      const result = await knowledgeService.addHostMemorySmart(hostId, obs.content, {
        volatility,
        source: obs.source  // 已在 parseObservationsFromLLMResponse 中净化
      })
      
      if (result.success && result.action === 'save') {
        savedCount++
      }
    }
    
    if (savedCount > 0) {
      console.log(`[Agent] 自动提取并保存 ${savedCount} 条观察记忆 (hostId: ${hostId})`)
    }
  }
  
  /**
   * 清理运行资源
   * 注意：技能会话在 Agent 实例级别维护，不在单次 Run 结束时清理
   */
  protected cleanupRun(run: AgentRun): void {
    // 取消输出监听
    if (run.outputUnsubscribe) {
      run.outputUnsubscribe()
      run.outputUnsubscribe = undefined
    }
    
    // 技能会话已提升到 Agent 实例级别，这里不再清理
    // 技能会话会在 Agent.cleanup() 中统一清理
    
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
    this.taskMemory.saveTask(
      run.id,
      run.originalUserRequest,  // 使用原始用户请求
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
  protected async buildContext(run: AgentRun, message: string): Promise<void> {
    // 加载知识库上下文
    const knowledgeResult = await this.loadKnowledgeContext(message, run.context.hostId)
    
    // 构建任务历史上下文
    let taskSummaries = ''
    let relatedTaskDigests = ''
    let recentTaskMessages: AiMessage[] = []
    let availableTaskIds: Array<{ id: string; summary: string }> = []
    
    if (this.taskMemory.getTaskCount() > 0) {
      const contextLength = this.getContextLength()
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
    
    // 添加当前用户消息（如果有图片，附带 images 字段）
    const enhancedMessage = this.enhanceUserMessage(message)
    const userMsg: AiMessage = { role: 'user', content: enhancedMessage }
    if (run.context.images && run.context.images.length > 0) {
      userMsg.images = run.context.images
    }
    run.messages.push(userMsg)
  }
  
  /**
   * 加载知识库上下文
   */
  protected async loadKnowledgeContext(message: string, hostId?: string): Promise<KnowledgeContextResult> {
    let context = ''
    let enabled = false
    let hostMemories: string[] | import('./types').HostMemoryEntry[] = []
    
    try {
      const knowledgeService = getKnowledgeService()
      if (knowledgeService && knowledgeService.isEnabled()) {
        enabled = true
        context = await knowledgeService.buildContext(message, { hostId })
        
        if (hostId) {
          // 优先使用带元数据的新格式（支持时效标注）
          hostMemories = await knowledgeService.getHostMemoriesWithMetadata(hostId, message, 30)
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
          // 修复不完整的 tool_calls 消息序列
          // 当 abort 发生在工具执行过程中时，可能存在 assistant 消息（含 tool_calls）但缺少对应的 tool result
          this.fixIncompleteToolCalls(run)
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
    // 上下文长度检查：如果超限直接报错，不悄悄截断
    this.checkContextLimit(run.messages)
    
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
    const toolProgressStepId = this.generateId()
    let streamContent = ''
    let lastContentUpdate = 0
    let pendingUpdate = false
    let streamStepCreated = false
    let toolProgressStepCreated = false
    let lastToolProgressUpdate = 0
    const STREAM_THROTTLE_MS = 100
    const TOOL_PROGRESS_THROTTLE_MS = 200
    
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
      streamStepCreated = false
      toolProgressStepCreated = false
      lastToolProgressUpdate = 0
      
      const availableTools = this.getAvailableTools()
      run.requestId = run.id
      
      this.services.aiService.chatWithToolsStream(
        run.messages,
        availableTools,
        // onChunk
        (chunk) => {
          streamContent += chunk
          const now = Date.now()
          
          // 第一次收到内容时，移除初始步骤并立即创建流式步骤
          if (!streamStepCreated) {
            streamStepCreated = true
            if (run.initialStepId) {
              this.removeStep(run.initialStepId)
              run.initialStepId = undefined
            }
            // 立即创建步骤，确保 timestamp 在工具结果之前
            this.addStep({
              id: streamStepId,
              type: 'message',
              content: streamContent,
              isStreaming: true
            })
            lastContentUpdate = Date.now()
            return
          }
          
          if (now - lastContentUpdate >= STREAM_THROTTLE_MS) {
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
          // 移除工具进度步骤（如果存在）
          if (toolProgressStepCreated) {
            this.removeStep(toolProgressStepId)
            toolProgressStepCreated = false
          }
          if (streamContent && streamStepCreated) {
            this.updateStep(streamStepId, {
              type: 'message',
              content: streamContent,
              isStreaming: false
            })
          } else if (!streamStepCreated && streamContent) {
            // 如果没有创建过步骤但有内容，创建一个
            this.addStep({
              id: streamStepId,
              type: 'message',
              content: streamContent,
              isStreaming: false
            })
          }
          resolve(result)
        },
        // onError
        (error) => {
          // 移除工具进度步骤（如果存在）
          if (toolProgressStepCreated) {
            this.removeStep(toolProgressStepId)
            toolProgressStepCreated = false
          }
          reject(new Error(error))
        },
        this.profileId, // 使用 Agent 实例的 profileId
        // onToolCallProgress - 显示工具调用参数生成进度
        (toolName: string, argsLength: number) => {
          const now = Date.now()
          // 超过 50 字符且距离上次更新超过 200ms 才显示
          if (argsLength <= 50 || now - lastToolProgressUpdate < TOOL_PROGRESS_THROTTLE_MS) return
          lastToolProgressUpdate = now
          
          const progressContent = `⏳ ${t('progress.generating_args', { toolName })} ${argsLength} ${t('misc.characters')}`
          
          if (!toolProgressStepCreated) {
            // 如果还没有创建进度步骤，先移除初始步骤
            if (run.initialStepId) {
              this.removeStep(run.initialStepId)
              run.initialStepId = undefined
            }
            toolProgressStepCreated = true
            this.addStep({
              id: toolProgressStepId,
              type: 'thinking',
              content: progressContent,
              isStreaming: true
            })
          } else {
            this.updateStep(toolProgressStepId, {
              type: 'thinking',
              content: progressContent,
              isStreaming: true
            })
          }
        },
        run.id // requestId
      )
    })
  }
  
  // ==================== 受保护方法：工具执行 ====================
  
  /** 可以并行执行的工具（只读、无副作用） */
  private static readonly PARALLELIZABLE_TOOLS = new Set([
    'read_file',
    'file_search',
    'get_terminal_context',
    'check_terminal_status',
    'search_knowledge',
    'get_knowledge_doc',
    'recall_task',
    'deep_recall',
    'load_skill',
    'load_user_skill'
  ])
  
  /**
   * 判断工具是否可以并行执行
   */
  private isParallelizableTool(toolName: string): boolean {
    return Agent.PARALLELIZABLE_TOOLS.has(toolName)
  }
  
  /**
   * 执行工具调用列表（支持并行执行相邻的只读工具）
   * 
   * 执行策略：保持原始顺序，只对相邻的可并行工具进行并行优化
   * 例如：[read_file, read_file, execute_command, read_file, read_file]
   * 会分成3批执行：
   *   1. read_file || read_file （并行）
   *   2. execute_command        （顺序）
   *   3. read_file || read_file （并行）
   */
  protected async executeToolCalls(
    run: AgentRun, 
    toolCalls: ToolCall[],
    toolExecutorConfig: ToolExecutorConfig
  ): Promise<void> {
    if (toolCalls.length === 0) return
    
    // 将工具调用分成多个批次，相邻的可并行工具放在同一批次
    const batches: { parallel: boolean; tools: ToolCall[] }[] = []
    
    for (const toolCall of toolCalls) {
      const isParallel = this.isParallelizableTool(toolCall.function.name)
      const lastBatch = batches[batches.length - 1]
      
      if (lastBatch && lastBatch.parallel === isParallel) {
        // 与上一批次类型相同，加入同一批次
        lastBatch.tools.push(toolCall)
      } else {
        // 开始新批次
        batches.push({ parallel: isParallel, tools: [toolCall] })
      }
    }
    
    // 按批次执行
    for (const batch of batches) {
      if (run.aborted) break
      
      if (batch.parallel && batch.tools.length > 1) {
        // 并行执行多个可并行工具
        await this.executeToolBatchParallel(run, batch.tools, toolExecutorConfig)
      } else {
        // 顺序执行（单个可并行工具或不可并行工具）
        for (const toolCall of batch.tools) {
          if (run.aborted) break
          await this.executeToolSingle(run, toolCall, toolExecutorConfig)
        }
      }
    }
    
    // 恢复执行阶段
    run.executionPhase = 'thinking'
    run.currentToolName = undefined
  }
  
  /**
   * 并行执行一批工具
   */
  private async executeToolBatchParallel(
    run: AgentRun,
    toolCalls: ToolCall[],
    toolExecutorConfig: ToolExecutorConfig
  ): Promise<void> {
    // 设置执行阶段（并行读取属于安全打断）
    run.executionPhase = 'reading'
    run.currentToolName = `${toolCalls.length} tools`
    
    const parallelPromises = toolCalls.map(async (toolCall) => {
      // 检查 abort 状态
      if (run.aborted) {
        return { 
          toolCall, 
          result: { success: false, output: '', error: t('error.operation_aborted') } as ToolResult, 
          toolArgs: {} as Record<string, unknown>
        }
      }
      
      let toolArgs: Record<string, unknown> = {}
      try {
        toolArgs = JSON.parse(toolCall.function.arguments)
      } catch {
        // 忽略解析错误
      }
      
      try {
        const result = await executeTool(
          run.ptyId,
          toolCall,
          run.config,
          run.context.terminalOutput,
          toolExecutorConfig
        )
        return { toolCall, result, toolArgs }
      } catch (error) {
        // 捕获异常，确保单个工具失败不影响其他并行工具
        return { 
          toolCall, 
          result: { 
            success: false, 
            output: '', 
            error: error instanceof Error ? error.message : String(error) 
          } as ToolResult, 
          toolArgs 
        }
      }
    })
    
    const results = await Promise.all(parallelPromises)
    
    // 按原始顺序处理结果
    for (const { toolCall, result, toolArgs } of results) {
      this.processToolResult(run, toolCall, result, toolArgs)
    }
  }
  
  /**
   * 顺序执行单个工具
   */
  private async executeToolSingle(
    run: AgentRun,
    toolCall: ToolCall,
    toolExecutorConfig: ToolExecutorConfig
  ): Promise<void> {
    let toolArgs: Record<string, unknown> = {}
    try {
      toolArgs = JSON.parse(toolCall.function.arguments)
    } catch {
      // 忽略解析错误
    }
    
    const toolName = toolCall.function.name
    this.setExecutionPhase(run, toolName)
    
    let result: ToolResult
    try {
      result = await executeTool(
        run.ptyId,
        toolCall,
        run.config,
        run.context.terminalOutput,
        toolExecutorConfig
      )
    } catch (error) {
      // 捕获异常，与并行执行行为保持一致
      result = { 
        success: false, 
        output: '', 
        error: error instanceof Error ? error.message : String(error) 
      }
    }
    
    this.processToolResult(run, toolCall, result, toolArgs)
  }
  
  /**
   * 处理工具执行结果
   */
  private processToolResult(
    run: AgentRun,
    toolCall: ToolCall,
    result: ToolResult,
    toolArgs: Record<string, unknown>
  ): void {
    // AI Debug: 记录工具执行结果
    if (run.requestId) {
      const resultContent = result.success 
        ? result.output 
        : t('agent.tool_error', { error: result.error || t('agent.unknown_error') })
      aiDebugService.logToolResult(run.requestId, {
        toolCallId: toolCall.id,
        success: result.success,
        result: resultContent
      })
    }
    
    // 添加工具结果到消息历史
    run.messages.push({
      role: 'tool',
      content: result.success 
        ? result.output 
        : t('agent.tool_error', { error: result.error || t('agent.unknown_error') }),
      tool_call_id: toolCall.id
    })
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
      getTaskMemory: () => this.taskMemory,
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
   * 更新执行步骤（如果不存在则创建）
   */
  protected updateStep(stepId: string, updates: Partial<AgentStep>): void {
    if (!this.currentRun) return
    
    let step = this.currentRun.steps.find(s => s.id === stepId)
    
    if (!step) {
      // 如果步骤不存在，创建一个新的
      step = {
        id: stepId,
        type: updates.type || 'message',
        content: updates.content || '',
        timestamp: Date.now(),
        isStreaming: updates.isStreaming
      }
      this.currentRun.steps.push(step)
    } else {
      // 更新现有步骤
      Object.assign(step, updates)
    }
    
    this.callbacks?.onStep?.(this.currentRun.id, step)
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
  private getContextLength(): number {
    const configService = this.services.configService
    if (!configService) {
      return 128000  // 默认 128K
    }
    
    const profiles = configService.getAiProfiles()
    if (profiles.length === 0) {
      return 128000
    }
    
    let profile
    if (this.profileId) {
      profile = profiles.find(p => p.id === this.profileId)
    }
    if (!profile) {
      const activeId = configService.getActiveAiProfile()
      profile = profiles.find(p => p.id === activeId) || profiles[0]
    }
    
    // 返回配置的上下文长度，默认 128000
    return profile?.contextLength || 128000
  }
  
  /**
   * 估算文本的 token 数量
   */
  private estimateTokens(text: string | null | undefined): number {
    if (!text) return 0
    // 中文字符约 1.5 tokens/字
    // 非中文内容约 0.5 tokens/字符
    //   - 纯英文单词约 0.25，但实际内容含大量 URL、路径、标点、JSON、特殊符号，
    //     tokenizer 对这些切分很碎（每字符 0.5-1 token），取 0.5 作为均值
    //   - 实测：Excel 混合数据（URL + 中文 + 数字）0.5 系数与 API 实际计数误差 < 10%
    const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length
    const otherChars = text.length - chineseChars
    return Math.ceil(chineseChars * 1.5 + otherChars * 0.5)
  }
  
  /**
   * 估算消息列表的总 token 数量
   */
  private estimateTotalTokens(messages: AiMessage[]): number {
    // 每条消息有固定开销（role token、边界标记等），约 4 tokens
    const MESSAGE_OVERHEAD = 4
    // 工具定义（函数名、描述、参数 schema）的固定开销，约 3000-5000 tokens
    const TOOLS_OVERHEAD = 4000
    
    const messageTokens = messages.reduce((sum, msg) => {
      let tokens = this.estimateTokens(msg.content) + MESSAGE_OVERHEAD
      if (msg.tool_calls) {
        tokens += msg.tool_calls.reduce((t, tc) => 
          t + this.estimateTokens(tc.function.name) + this.estimateTokens(tc.function.arguments), 0)
      }
      if (msg.reasoning_content) {
        tokens += this.estimateTokens(msg.reasoning_content)
      }
      return sum + tokens
    }, 0)
    
    return messageTokens + TOOLS_OVERHEAD
  }
  
  /**
   * 检查上下文是否超出限制
   */
  private checkContextLimit(messages: AiMessage[]): void {
    const contextLength = this.getContextLength()
    const maxTokens = Math.floor(contextLength * 0.85)  // 预留 15% 给响应和估算误差
    const totalTokens = this.estimateTotalTokens(messages)
    
    // 将估算的 token 数更新到最近的 step，供前端上下文统计显示
    const steps = this.currentRun?.steps
    if (steps && steps.length > 0) {
      const lastStep = steps[steps.length - 1]
      lastStep.contextTokens = totalTokens
      this.callbacks?.onStep?.(this.currentRun?.id || '', lastStep)
    }
    
    if (totalTokens > maxTokens) {
      const percentage = Math.round((totalTokens / contextLength) * 100)
      throw new Error(
        t('agent.context_limit_exceeded', { 
          current: totalTokens, 
          limit: contextLength,
          percentage 
        })
      )
    }
  }
  
  /**
   * 修复不完整的工具调用序列
   * 当用户中断时，可能存在 assistant 消息（含 tool_calls）但缺少对应的 tool result
   */
  private fixIncompleteToolCalls(run: AgentRun): void {
    const { messages } = run
    if (messages.length === 0) return

    // 从后往前查找最后一个带有 tool_calls 的 assistant 消息
    let lastAssistantWithToolCallsIndex = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        lastAssistantWithToolCallsIndex = i
        break
      }
      // 如果遇到 user 消息，说明之前的对话是完整的
      if (msg.role === 'user') break
    }

    if (lastAssistantWithToolCallsIndex === -1) return

    const assistantMsg = messages[lastAssistantWithToolCallsIndex]
    const toolCalls = assistantMsg.tool_calls!

    // 收集该 assistant 消息之后已有的 tool result
    const existingToolCallIds = new Set<string>()
    for (let i = lastAssistantWithToolCallsIndex + 1; i < messages.length; i++) {
      const msg = messages[i]
      if (msg.role === 'tool' && msg.tool_call_id) {
        existingToolCallIds.add(msg.tool_call_id)
      }
    }

    // 为缺失的 tool_call_id 添加占位的 tool result
    const missingToolCalls = toolCalls.filter(tc => !existingToolCallIds.has(tc.id))
    if (missingToolCalls.length > 0) {
      console.log(`[Agent] 修复 ${missingToolCalls.length} 个缺失的 tool result 消息`)
      for (const tc of missingToolCalls) {
        messages.push({
          role: 'tool',
          content: '[操作被用户中断]',
          tool_call_id: tc.id
        })
      }
    }
  }
  
  /**
   * 根据程序设置的语言生成语言提示
   */
  private getLanguageHint(): string {
    const locale = this.services.configService?.getLanguage() || 'zh-CN'
    if (locale === 'en-US') {
      return '[Respond in English]\n'
    }
    return ''  // 中文不需要特别提示
  }
  
  /**
   * 增强用户消息
   */
  private enhanceUserMessage(message: string): string {
    // 添加语言提示
    const languageHint = this.getLanguageHint()
    return languageHint + message
  }
}
