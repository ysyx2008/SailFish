/**
 * Agent 抽象基类
 * 
 * 实现 Agent 的核心执行逻辑，子类（如 SailFish）实现特定行为。
 * 
 * 职责划分：
 * - Agent（基类）：执行循环、AI 交互、工具执行、步骤管理
 * - SailFish（子类）：工具列表管理、系统提示构建、可选终端能力
 */

import type { AiMessage, ToolCall, ChatWithToolsResult, ToolDefinition } from '../ai.service'
import type { AgentRecord, AgentStepRecord } from '../history.service'
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
  TerminalType,
  ExecutionMode,
  AgentExecutionPhase,
  PendingConfirmationInternal
} from './types'
import { DEFAULT_AGENT_CONFIG } from './types'
import { TaskMemoryStore } from './task-memory'
import { getBondService } from '../bond.service'
import type { ToolExecutorConfig, ToolResult } from './tools/types'
import { executeTool } from './tools/index'
import { buildTaskHistoryContext } from './context-builder'
import { getKnowledgeService } from '../knowledge'
import { getContextKnowledgeService } from '../knowledge/context-knowledge'
import { getWatchService } from '../watch/watch.service'
import { formatWatchListForPrompt } from './skills/watch/executor'
import { consumeProactiveContext } from './proactive-store'
import { t } from './i18n'
import { createSkillSession, SkillSession } from './skills'
import { PromptBuilder } from './prompt-builder'
import { getAiDebugService } from '../ai-debug.service'
import { createLogger } from '../../utils/logger'

const log = createLogger('Agent')

/**
 * Agent 抽象基类
 */
export abstract class Agent {
  // ==================== 配置（持久化） ====================
  
  /** 执行模式 */
  executionMode: ExecutionMode = 'strict'
  
  /** 命令超时时间（毫秒） */
  commandTimeout: number = 30000
  
  /** 调试模式 */
  debugMode: boolean = false
  
  /** AI 配置档案 ID（每个 Agent 实例独立，未设置时 fallback 到全局） */
  profileId?: string

  /** Agent 实例的逻辑 ID（用于路由 proactive message 等场景） */
  private _agentId?: string
  
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

  /** 上下文管理功能是否已激活（用量超过 50% 时启用） */
  protected contextManagementEnabled = false
  
  // ==================== 会话追踪（跨 Run 持久化） ====================
  
  /** 会话 ID */
  private _sessionId?: string
  
  /** 会话开始时间 */
  private _sessionStartTime?: number
  
  /** 会话内累积的所有 steps（跨多次 run） */
  private _sessionSteps: AgentStep[] = []
  
  /** 会话内累积的所有 API 消息（跨多次 run 的 taskMessageLog 合并） */
  private _sessionMessages: AiMessage[] = []
  
  /** 终端元数据（从首次 run 的 context 获取） */
  private _terminalMeta?: { terminalType: TerminalType; sshHost?: string }
  /** 是否正在从 HistoryService 恢复（防止并发竞态） */
  private _isRestoring = false
  
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
   * 设置 Agent 实例的逻辑 ID（由 AgentService.createAssistantAgent 调用）
   */
  setAgentId(id: string): void {
    this._agentId = id
  }

  getAgentId(): string | undefined {
    return this._agentId
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
    const taskPreview = message.length > 80 ? message.slice(0, 80) + '...' : message
    log.info(`Task started: runId=${run.id}, ptyId=${run.ptyId}, mode=${this.executionMode}, task="${taskPreview}"`)
    const taskStartTime = Date.now()
    
    try {
      await this.buildContext(run, message)
      const result = await this.executeLoop(run)
      this.finalizeRun(run, result)
      const elapsed = ((Date.now() - taskStartTime) / 1000).toFixed(1)
      log.info(`Task completed: runId=${run.id}, duration=${elapsed}s, steps=${run.steps.length}`)
      return result
    } catch (error) {
      this.handleError(run, error)
      const elapsed = ((Date.now() - taskStartTime) / 1000).toFixed(1)
      log.error(`Task failed: runId=${run.id}, duration=${elapsed}s, error=${error instanceof Error ? error.message : error}`)
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
    if (config.debugMode !== undefined) {
      this.debugMode = config.debugMode
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
    toolCallId: string | undefined, 
    approved: boolean, 
    modifiedArgs?: Record<string, unknown>,
    alwaysAllow?: boolean
  ): boolean {
    if (!this.currentRun || !this.currentRun.pendingConfirmation) {
      return false
    }
    
    if (!toolCallId || this.currentRun.pendingConfirmation.toolCallId === toolCallId) {
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
   * 是否有待确认的工具调用
   */
  hasPendingConfirmation(): boolean {
    return !!this.currentRun?.pendingConfirmation
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
      commandTimeout: this.commandTimeout,
      debugMode: this.debugMode
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
      allowedTools: new Set<string>(),
      taskMessageLog: []
    }
    
    this.currentRun = run
    
    // 注册运行级别回调
    if (options?.callbacks) {
      this.callbacks = options.callbacks
    }
    
    // 初始化会话追踪（首次 run 时创建 session 或从历史恢复）
    if (!this._sessionId) {
      if (context.sessionId) {
        this._sessionId = context.sessionId
        this._sessionStartTime = context.sessionStartTime || Date.now()
      } else {
        this._sessionId = `session_${Date.now()}`
        this._sessionStartTime = Date.now()
      }
      this._sessionSteps = []
      this._sessionMessages = []
    }
    
    // 记录终端元数据（从首次 run 的 context 获取）
    if (!this._terminalMeta) {
      this._terminalMeta = {
        terminalType: context.terminalType,
        sshHost: context.sshHost
      }
    }
    
    // 初始化 TaskMemory（仅首次 run 时，从 HistoryService 恢复）
    // 场景：用户恢复了历史对话，Agent 实例刚创建，TaskMemory 为空
    // 通过 sessionId 从 HistoryService 加载完整记录，避免前端反复传递大量数据
    if (this.taskMemory.getTaskCount() === 0 && this._sessionId && !this._isRestoring) {
      this._isRestoring = true
      try {
        this.restoreFromHistory()
      } finally {
        this._isRestoring = false
      }
    }
    
    // 添加 user_task 步骤（统一由后端生成，前端通过 onStep 回调接收）
    // previewImages 仅含 PDF 页面预览（UI 展示用），Word 嵌入图片只传给 AI 不展示
    this.addStep({
      type: 'user_task',
      content: message,
      images: context.previewImages || context.images,
      attachments: context.attachments
    })
    
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
   * 从 HistoryService 恢复 TaskMemory 和 session 步骤
   * 使用 sessionId 直接从后端存储加载，无需前端传递数据
   */
  private restoreFromHistory(): void {
    const historyService = this.services.historyService
    if (!historyService || !this._sessionId) return
    
    const record = historyService.getAgentRecordById(this._sessionId)
    if (!record) return
    
    // 从 messages 恢复 TaskMemory（按 user 消息分割为独立任务）
    if (record.messages && record.messages.length > 0) {
      const tasks = this.splitMessagesIntoTasks(record.messages as AiMessage[])
      for (const task of tasks) {
        this.taskMemory.saveTask(
          task.id,
          task.userTask,
          [],
          'success',
          task.finalResult,
          task.messages
        )
      }
      log.info(`Restored TaskMemory from HistoryService: ${tasks.length} tasks (from messages)`)
    } else if (record.steps && record.steps.length > 0) {
      // 降级：旧记录没有 messages，从 steps 重建基本 TaskMemory
      const tasks = this.splitStepsIntoTasks(record.steps)
      for (const task of tasks) {
        this.taskMemory.saveTask(
          task.id,
          task.userTask,
          task.steps,
          'success',
          task.finalResult
        )
      }
      log.info(`Restored TaskMemory from HistoryService: ${tasks.length} tasks (from steps, no messages)`)
    }
    
    // 恢复 _sessionSteps（避免后续保存时覆盖旧步骤）
    if (record.steps && record.steps.length > 0 && this._sessionSteps.length === 0) {
      this._sessionSteps = record.steps.map(s => ({
        id: s.id,
        type: s.type as AgentStep['type'],
        content: s.content,
        images: s.images,
        attachments: s.attachments,
        toolName: s.toolName,
        toolArgs: s.toolArgs,
        toolResult: s.toolResult,
        riskLevel: s.riskLevel as RiskLevel | undefined,
        timestamp: s.timestamp
      }))
    }
    
    // 恢复 _sessionMessages
    if (record.messages && record.messages.length > 0 && this._sessionMessages.length === 0) {
      this._sessionMessages = (record.messages as AiMessage[]).map(m => ({ ...m }))
    }
  }
  
  /**
   * 将连续的 API 消息按 user 消息分割为独立任务
   */
  private splitMessagesIntoTasks(messages: AiMessage[]): Array<{
    id: string; userTask: string; finalResult: string; messages: AiMessage[]
  }> {
    const tasks: Array<{ id: string; userTask: string; finalResult: string; messages: AiMessage[] }> = []
    let currentTaskMessages: AiMessage[] = []
    let currentUserTask = ''
    
    for (const msg of messages) {
      if (msg.role === 'user' && currentTaskMessages.length > 0) {
        // 新的 user 消息 → 结束当前任务
        const lastAssistant = [...currentTaskMessages].reverse().find(
          m => m.role === 'assistant' && !m.tool_calls
        )
        tasks.push({
          id: `restored_${Date.now()}_${tasks.length}`,
          userTask: currentUserTask,
          finalResult: lastAssistant?.content || '',
          messages: currentTaskMessages
        })
        currentTaskMessages = []
      }
      
      if (msg.role === 'user') {
        currentUserTask = msg.content || ''
      }
      
      currentTaskMessages.push(msg)
    }
    
    // 最后一组
    if (currentTaskMessages.length > 0) {
      const lastAssistant = [...currentTaskMessages].reverse().find(
        m => m.role === 'assistant' && !m.tool_calls
      )
      tasks.push({
        id: `restored_${Date.now()}_${tasks.length}`,
        userTask: currentUserTask,
        finalResult: lastAssistant?.content || '',
        messages: currentTaskMessages
      })
    }
    
    return tasks
  }
  
  /**
   * 从 steps 重建基本任务列表（降级路径：旧记录没有 messages 时使用）
   * 通过 user_task 和 final_result 步骤分割
   */
  private splitStepsIntoTasks(stepRecords: import('../history.service').AgentStepRecord[]): Array<{
    id: string; userTask: string; finalResult: string; steps: AgentStep[]
  }> {
    if (!stepRecords || stepRecords.length === 0) return []
    
    const tasks: Array<{ id: string; userTask: string; finalResult: string; steps: AgentStep[] }> = []
    let currentSteps: AgentStep[] = []
    let currentUserTask = ''
    const baseTs = stepRecords[0]?.timestamp || Date.now()
    
    for (const s of stepRecords) {
      const step: AgentStep = {
        id: s.id,
        type: s.type as AgentStep['type'],
        content: s.content,
        toolName: s.toolName,
        toolArgs: s.toolArgs,
        toolResult: s.toolResult,
        riskLevel: s.riskLevel as RiskLevel | undefined,
        timestamp: s.timestamp
      }
      
      if (s.type === 'user_task') {
        if (currentSteps.length > 0 && currentUserTask) {
          const lastFinal = [...currentSteps].reverse().find(st => st.type === 'final_result')
          tasks.push({
            id: `restored_${baseTs}_${tasks.length}`,
            userTask: currentUserTask,
            finalResult: lastFinal?.content || '',
            steps: currentSteps
          })
        }
        currentSteps = []
        currentUserTask = s.content || ''
      }
      
      currentSteps.push(step)
    }
    
    if (currentSteps.length > 0 && currentUserTask) {
      const lastFinal = [...currentSteps].reverse().find(st => st.type === 'final_result')
      tasks.push({
        id: `restored_${baseTs}_${tasks.length}`,
        userTask: currentUserTask,
        finalResult: lastFinal?.content || '',
        steps: currentSteps
      })
    }
    
    return tasks
  }
  
  /**
   * 完成运行，保存任务记忆
   */
  protected finalizeRun(run: AgentRun, result: string): void {
    run.isRunning = false
    
    // 补录最终 assistant 回复到完整对话日志
    // （纯文本回复不经过 executeStep 的 tool_calls 分支，不会被自动记录）
    if (result != null) {
      run.taskMessageLog.push({ role: 'assistant', content: result })
    }
    
    // 先添加 final_result 步骤到 run.steps，确保后续保存包含完整数据
    if (result) {
      this.addStep({
        type: 'final_result',
        content: result
      })
    }
    
    // 保存任务到记忆（此时 run.steps 已包含 final_result）
    const status = run.aborted ? 'aborted' : 'success'
    
    this.taskMemory.saveTask(
      run.id,
      run.originalUserRequest,
      run.steps,
      status,
      result,
      run.taskMessageLog
    )
    
    this.accumulateSessionData(run, status, result)
    this.saveSessionToHistory()

    // 诞生引导完成判定：personality_craft 被成功调用即视为引导完成
    if (!(this.services.configService?.getAgentOnboardingCompleted())) {
      const craftCalled = run.steps.some(s =>
        s.type === 'tool_call' && s.toolName === 'personality_craft'
      )
      if (craftCalled) {
        this.services.configService?.setAgentOnboardingCompleted(true)
        log.info('Agent onboarding completed — personality_craft was called')
      }
    }
    
    // L2: 异步更新知识文档（唤醒 run 跳过，避免短问候污染知识文档）
    this.updateContextKnowledgeAsync(run, result).catch(err => {
      log.error('知识文档更新失败:', err)
    })

    // L3: 异步索引对话到向量库（供跨会话语义检索）
    this.indexConversationAsync(run, 'success', result).catch(err => {
      log.warn('对话向量索引失败:', err)
    })
    
    // 触发完成回调
    this.callbacks?.onComplete?.(run.id, result, run.pendingUserMessages)
  }
  
  // ==================== 会话持久化 ====================
  
  /**
   * 将单次 run 的数据累积到会话级别
   */
  private accumulateSessionData(run: AgentRun, _status: string, _result?: string): void {
    // run.steps 已包含 user_task、执行步骤和 final_result（由 addStep 统一管理）
    this._sessionSteps.push(...run.steps)
    
    // 累积 API 消息
    this._sessionMessages.push(...run.taskMessageLog)
  }
  
  /**
   * 将会话数据保存到 HistoryService
   */
  private saveSessionToHistory(): void {
    const historyService = this.services.historyService
    if (!historyService || !this._sessionId || !this._sessionStartTime) return
    
    // 找到第一个 user_task 作为会话标题
    const firstUserTask = this._sessionSteps.find(s => s.type === 'user_task')
    if (!firstUserTask) return
    
    // 最后一个 final_result 的状态决定整个会话状态
    const lastFinalResult = [...this._sessionSteps].reverse().find(s => s.type === 'final_result')
    let status: 'completed' | 'failed' | 'aborted' = 'completed'
    // 根据 taskMemory 中最后一个任务的状态判断（比关键词匹配更准确）
    const lastTask = this.taskMemory.getSummaries(1)[0]
    if (lastTask) {
      if (lastTask.status === 'aborted') status = 'aborted'
      else if (lastTask.status === 'failed') status = 'failed'
    }
    
    // 序列化 steps
    const serializableSteps: AgentStepRecord[] = this._sessionSteps.map(s => ({
      id: s.id,
      type: s.type,
      content: s.content || '',
      images: s.images,
      attachments: s.attachments,
      toolName: s.toolName,
      toolArgs: s.toolArgs ? JSON.parse(JSON.stringify(s.toolArgs)) : undefined,
      toolResult: s.toolResult,
      riskLevel: s.riskLevel,
      timestamp: s.timestamp
    }))
    
    const record: AgentRecord = {
      id: this._sessionId,
      timestamp: this._sessionStartTime,
      terminalId: this.currentRun?.context.ptyId || '',
      terminalType: this._terminalMeta?.terminalType || 'local',
      sshHost: this._terminalMeta?.sshHost,
      userTask: firstUserTask.content,
      steps: serializableSteps,
      messages: this._sessionMessages.map(m => JSON.parse(JSON.stringify(m))),
      finalResult: lastFinalResult?.content,
      duration: Date.now() - this._sessionStartTime,
      status
    }
    
    try {
      historyService.saveAgentRecord(record)
    } catch (err) {
      log.error('保存会话历史失败:', err)
    }
  }
  
  /**
   * 保存执行检查点：将当前 session + 进行中 run 的数据写入 HistoryService
   * 每完成一轮工具调用后自动触发，确保程序意外退出时不丢失对话记录
   */
  private saveCheckpoint(run: AgentRun): void {
    const historyService = this.services.historyService
    if (!historyService || !this._sessionId || !this._sessionStartTime) return
    
    // 合并：已累积的 session 步骤 + 当前 run 的执行步骤（已包含 user_task）
    const allSteps: AgentStep[] = [
      ...this._sessionSteps,
      ...run.steps
    ]
    const checkpointSteps: AgentStepRecord[] = allSteps.map(s => ({
      id: s.id,
      type: s.type,
      content: s.content || '',
      images: s.images,
      attachments: s.attachments,
      toolName: s.toolName,
      toolArgs: s.toolArgs ? JSON.parse(JSON.stringify(s.toolArgs)) : undefined,
      toolResult: s.toolResult,
      riskLevel: s.riskLevel,
      timestamp: s.timestamp
    }))
    
    // 合并 API 消息
    const checkpointMessages = [...this._sessionMessages, ...run.taskMessageLog]
    
    const firstUserTask = this._sessionSteps.find(s => s.type === 'user_task') || { content: run.originalUserRequest }
    
    const record: AgentRecord = {
      id: this._sessionId,
      timestamp: this._sessionStartTime,
      terminalId: run.context.ptyId || '',
      terminalType: this._terminalMeta?.terminalType || 'local',
      sshHost: this._terminalMeta?.sshHost,
      userTask: firstUserTask.content,
      steps: checkpointSteps,
      messages: checkpointMessages.map(m => JSON.parse(JSON.stringify(m))),
      duration: Date.now() - this._sessionStartTime,
      status: 'completed'  // 检查点视为进行中但有效的记录
    }
    
    try {
      historyService.saveAgentRecord(record)
    } catch (err) {
      log.error('保存检查点失败:', err)
    }
  }
  
  /**
   * 重置会话状态（前端"新对话"或终端重连时调用）
   */
  resetSession(): void {
    this._sessionId = undefined
    this._sessionStartTime = undefined
    this._sessionSteps = []
    this._sessionMessages = []
    this._terminalMeta = undefined
    this.taskMemory.clear()
  }

  
  /**
   * L2: 异步更新知识文档
   * 收集执行记录，交给 LLM 判断是否有值得持久化的新信息
   */
  private async updateContextKnowledgeAsync(run: AgentRun, result?: string): Promise<void> {
    const aiService = this.services.aiService
    if (!aiService) return

    // 唤醒 run 跳过（短问候不产生值得持久化的系统知识）
    if (run.context.wakeup) return

    // 跳过纯对话（没有执行过工具的任务不太可能产生新的系统知识）
    const toolSteps = run.steps.filter(s => s.type === 'tool_call' && s.toolName)
    if (toolSteps.length === 0) return

    const contextId = run.context.hostId || 'personal'
    const MAX_ARG_DISPLAY = 200
    const MAX_RESULT_DISPLAY = 300
    const MAX_FINAL_RESULT_DISPLAY = 500
    
    const commandRecords: string[] = []
    for (const step of run.steps) {
      if (step.type === 'tool_call' && step.toolName && step.toolArgs) {
        const argsStr = Object.entries(step.toolArgs)
          .map(([k, v]) => {
            let str: string
            if (typeof v === 'string') {
              str = v
            } else {
              try { str = JSON.stringify(v) ?? String(v) } catch { str = String(v) }
            }
            return `${k}=${str.substring(0, MAX_ARG_DISPLAY)}`
          })
          .join(', ')
        commandRecords.push(`[${step.toolName}] ${argsStr}`)
      }
      if (step.type === 'tool_result' && step.toolName && step.toolResult) {
        commandRecords.push(`  → ${step.toolResult.substring(0, MAX_RESULT_DISPLAY)}`)
      }
    }
    
    if (result) {
      commandRecords.push(`\n最终结果: ${result.substring(0, MAX_FINAL_RESULT_DISPLAY)}`)
    }
    
    if (commandRecords.length === 0) return

    const ckService = getContextKnowledgeService()
    const profileId = this.services.configService?.getActiveAiProfile() ?? undefined
    
    await ckService.updateWithLLM(contextId, aiService, profileId, {
      userRequest: run.originalUserRequest,
      commandRecords
    })
  }

  /**
   * L3: 将对话摘要异步索引到向量库，供跨会话语义检索
   */
  private async indexConversationAsync(
    run: AgentRun,
    status: 'success' | 'failed' | 'aborted',
    result?: string
  ): Promise<void> {
    if (!run.originalUserRequest?.trim()) return

    // 唤醒 run 跳过（"你好"之类的短问候不值得索引）
    if (run.context.wakeup) return

    const knowledgeService = getKnowledgeService()
    if (!knowledgeService || !knowledgeService.isEnabled()) return

    const hostId = run.context.hostId || 'personal'

    await knowledgeService.indexConversation({
      taskId: run.id,
      hostId,
      userRequest: run.originalUserRequest,
      finalResult: result || '',
      status,
      timestamp: Date.now()
    })
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
      run.originalUserRequest,
      run.steps,
      'failed',
      errorMessage,
      run.taskMessageLog
    )
    
    // 添加 final_result 步骤（错误时也统一由后端生成）
    this.addStep({
      type: 'final_result',
      content: errorMessage
    })
    
    this.accumulateSessionData(run, 'failed', errorMessage)
    this.saveSessionToHistory()
    
    // L3: 异步索引失败的对话（失败经验同样有检索价值）
    this.indexConversationAsync(run, 'failed', errorMessage).catch(err => {
      log.warn('对话向量索引失败:', err)
    })

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
    
    // 加载 L2 知识文档
    let contextKnowledgeDoc = ''
    const contextId = run.context.hostId || 'personal'
    try {
      const ckService = getContextKnowledgeService()
      contextKnowledgeDoc = ckService.getDocument(contextId)
    } catch (e) {
      log.warn('ContextKnowledge load error:', e)
    }

    // L3 auto-recall: 语义检索相关的历史对话，注入提示词
    let conversationHistory: Array<{ userRequest: string; finalResult: string; status: string; timestamp: number; relevance: number }> = []
    try {
      const ks = getKnowledgeService()
      if (ks && ks.isEnabled() && message.trim().length >= 5) {
        const results = await ks.searchConversations(message, run.context.hostId, 3)
        if (results.length > 0) {
          conversationHistory = results.map(r => ({
            userRequest: r.userRequest,
            finalResult: r.finalResult,
            status: r.status,
            timestamp: r.timestamp,
            relevance: r.relevance ?? 0
          }))
        }
      }
    } catch (e) {
      log.warn('L3 auto-recall error:', e)
    }

    // 关切列表摘要（注入提示词，供 Agent 知晓已有关切）
    let watchListSummary = ''
    try {
      const watches = getWatchService().getAll()
      watchListSummary = formatWatchListForPrompt(watches)
    } catch (e) {
      log.warn('Watch list for prompt error:', e)
    }

    // 判断是否为诞生引导
    const isOnboarding = !(this.services.configService?.getAgentOnboardingCompleted() ?? true)

    // 构建系统提示
    const promptOptions: PromptOptions = {
      mbtiType: this.services.configService?.getAgentMbti() ?? undefined,
      knowledgeContext: knowledgeResult.context,
      knowledgeEnabled: knowledgeResult.enabled,
      conversationHistory: conversationHistory.length > 0 ? conversationHistory : undefined,
      contextKnowledgeDoc,
      aiRules: this.services.configService?.getAiRules() ?? '',
      agentName: this.services.configService?.getAgentName() ?? '',
      taskSummaries,
      relatedTaskDigests,
      availableTaskIds,
      watchListSummary: watchListSummary || undefined,
      bondContext: this.resolveBondContext(),
      isOnboarding,
    }
    
    const systemPrompt = this.buildSystemPrompt(run.context, promptOptions)
    run.messages.push({ role: 'system', content: systemPrompt })
    
    // 注入最近任务的消息
    if (recentTaskMessages.length > 0) {
      for (const msg of recentTaskMessages) {
        run.messages.push(msg)
      }
    }
    
    // 添加当前用户消息（如果有图片，附带 images 字段；如有主动消息上下文，注入到 API 消息中）
    let enhancedMessage = this.enhanceUserMessage(message)
    // proactiveContext：IM 路径由 context 直传，桌面路径从 proactive-store 补充
    const proactiveCtx = run.context.proactiveContext
      || (this._agentId ? consumeProactiveContext(this._agentId) : undefined)
    if (proactiveCtx?.trim()) {
      enhancedMessage = proactiveCtx.trim() + '\n\n' + enhancedMessage
    }
    if (run.context.documentContext) {
      enhancedMessage = enhancedMessage + '\n\n' + run.context.documentContext
    }
    // 如果有用户上传的图片，附带 images 字段并追加提示
    if (run.context.images && run.context.images.length > 0) {
      const imageCount = run.context.images.length
      const totalSize = run.context.images.reduce((sum, img) => sum + img.length, 0)
      log.info(`User images: ${imageCount} image(s), total base64 size: ${(totalSize / 1024).toFixed(0)}KB`)
      enhancedMessage += `\n\n[${t('agent.images_attached', { count: imageCount })}]`
    }
    const userMsg: AiMessage = { role: 'user', content: enhancedMessage }
    if (run.context.images && run.context.images.length > 0) {
      userMsg.images = run.context.images
    }
    run.messages.push(userMsg)
    
    // 记录到完整对话日志（taskMessageLog 的第一条）
    run.taskMessageLog.push({ ...userMsg })
  }
  
  /**
   * 加载知识库上下文
   */
  protected async loadKnowledgeContext(message: string, hostId?: string): Promise<KnowledgeContextResult> {
    let context = ''
    let enabled = false
    
    try {
      const knowledgeService = getKnowledgeService()
      if (knowledgeService && knowledgeService.isEnabled()) {
        enabled = true
        context = await knowledgeService.buildContext(message, { hostId })
      }
    } catch (e) {
      log.warn('Knowledge service error:', e)
    }
    
    return { context, enabled, conversationHistory: [] }
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
    let truncationRetryCount = 0
    const MAX_NO_TOOL_RETRIES = 2
    const MAX_TRUNCATION_RETRIES = 3
    
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
          
          // 输出被截断时强制继续循环（已在 executeStep 中注入续写提示）
          if (stepResult.truncated) {
            truncationRetryCount++
            if (truncationRetryCount >= MAX_TRUNCATION_RETRIES) {
              log.warn('Output repeatedly truncated, giving up continuation')
              return lastResponse?.content || t('agent.no_response')
            }
            continue
          }
          
          if (stepResult.hasToolCalls) {
            hasExecutedAnyTool = true
            noToolCallRetryCount = 0
            truncationRetryCount = 0
            // 每完成一轮工具调用后保存检查点，防止程序意外退出丢失对话记录
            this.saveCheckpoint(run)
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
          log.info('AI 输出被用户消息中断，继续循环处理')
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
  ): Promise<{ response: ChatWithToolsResult | null; hasToolCalls: boolean; truncated?: boolean }> {
    // 更新上下文状态（注入 Context Status + 渐进式提醒）
    this.updateContextPressure(run)
    
    // 调用 AI
    const response = await this.callAiWithStreaming(run)
    
    // 处理 finish_reason=length（输出被 max_tokens 截断）
    if (response.finish_reason === 'length') {
      const totalToolCalls = response.tool_calls?.length || 0
      const validToolCalls = (response.tool_calls || []).filter(tc => {
        if (!tc.id || !tc.function.name || !tc.function.arguments) return false
        try { JSON.parse(tc.function.arguments); return true }
        catch (e) { if (e instanceof SyntaxError) return false; throw e }
      })
      const discardedCount = totalToolCalls - validToolCalls.length
      
      if (discardedCount > 0) {
        log.warn(`Output truncated (finish_reason=length): discarded ${discardedCount}/${totalToolCalls} tool_calls with incomplete arguments`)
      } else if (totalToolCalls === 0) {
        log.warn(`Output truncated (finish_reason=length): text content may be incomplete`)
      }
      
      // 有有效的工具调用 → 正常执行，截断的已被丢弃
      if (validToolCalls.length > 0) {
        log.info(`Proceeding with ${validToolCalls.length} valid tool_calls despite truncation`)
        // 继续走正常的工具调用流程（下面的 if 分支会处理）
        response.tool_calls = validToolCalls
      } else {
        // 没有可用的工具调用，注入续写提示让 AI 重试
        const truncationHint: AiMessage = {
          role: 'assistant',
          content: response.content || ''
        }
        run.messages.push(truncationHint)
        run.taskMessageLog.push({ ...truncationHint })
        
        const continuationPrompt: AiMessage = {
          role: 'user',
          content: t('agent.output_truncated_hint')
        }
        run.messages.push(continuationPrompt)
        run.taskMessageLog.push({ ...continuationPrompt })
        
        this.addStep({
          type: 'thinking',
          content: `⚠️ ${t('agent.output_truncated')}`
        })
        
        return { response, hasToolCalls: false, truncated: true }
      }
    }
    
    // 处理工具调用
    if (response.tool_calls && response.tool_calls.length > 0) {
      const validToolCalls = response.tool_calls.filter(tc => {
        if (!tc.id || !tc.function.name || !tc.function.arguments) return false
        try { JSON.parse(tc.function.arguments); return true }
        catch (e) { if (e instanceof SyntaxError) return false; throw e }
      })
      
      if (validToolCalls.length < response.tool_calls.length) {
        log.warn(`Discarded ${response.tool_calls.length - validToolCalls.length} tool_calls with malformed arguments`)
      }
      
      if (validToolCalls.length === 0) {
        const discardedNames = response.tool_calls.map(tc => tc.function?.name || 'unknown').join(', ')
        log.warn(`All tool_calls discarded due to malformed arguments: [${discardedNames}], triggering retry`)
        
        const assistantMsg: AiMessage = {
          role: 'assistant',
          content: response.content || ''
        }
        run.messages.push(assistantMsg)
        run.taskMessageLog.push({ ...assistantMsg })
        
        const retryHint: AiMessage = {
          role: 'user',
          content: t('agent.tool_args_malformed', { tools: discardedNames })
        }
        run.messages.push(retryHint)
        run.taskMessageLog.push({ ...retryHint })
        
        this.addStep({
          type: 'thinking',
          content: `⚠️ ${t('agent.tool_args_malformed_step', { tools: discardedNames })}`
        })
        
        return { response, hasToolCalls: false, truncated: true }
      }
      
      // 移除初始步骤
      if (run.initialStepId) {
        this.removeStep(run.initialStepId)
        run.initialStepId = undefined
      }
      
      // 添加 assistant 消息到历史
      const assistantMsg: AiMessage = {
        role: 'assistant',
        content: response.content || '',
        tool_calls: validToolCalls
      }
      if (response.reasoning_content) {
        assistantMsg.reasoning_content = response.reasoning_content
      }
      run.messages.push(assistantMsg)
      run.taskMessageLog.push({ ...assistantMsg })
      
      // 执行工具调用
      await this.executeToolCalls(run, validToolCalls, toolExecutorConfig)
      
      return { response, hasToolCalls: true }
    }
    
    return { response, hasToolCalls: false }
  }
  
  // ==================== 受保护方法：AI 交互 ====================
  
  /**
   * 检测消息列表中是否有未被 assistant 处理过的新图片
   * 从末尾往前遍历：遇到 assistant 消息即停止，遇到图片即返回 true
   */
  private hasUnseenImages(messages: AiMessage[]): boolean {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg.role === 'assistant') break
      if (msg.images && msg.images.length > 0) return true
    }
    return false
  }
  
  /**
   * 解析本次 API 调用应使用的 profileId
   * 当满足以下条件时自动切换到视觉模型：
   * 1. autoVisionModel 全局开关已启用
   * 2. 当前主模型配置了 visionProfileId
   * 3. 消息中有未处理的新图片
   */
  private resolveEffectiveProfileId(run: AgentRun): string | undefined {
    const configService = this.services.configService
    if (!configService) return this.profileId
    
    const autoVision = configService.get('autoVisionModel')
    if (!autoVision) return this.profileId
    
    if (!this.hasUnseenImages(run.messages)) return this.profileId
    
    // 获取当前主模型的 profile
    const profiles = configService.getAiProfiles()
    const currentProfileId = this.profileId || configService.getActiveAiProfile()
    const currentProfile = profiles.find(p => p.id === currentProfileId)
    
    if (!currentProfile) return this.profileId
    
    // 如果当前模型本身就是 vision 类型，无需切换
    if (currentProfile.modelType === 'vision') return this.profileId
    
    // 如果配置了关联视觉模型，切换过去（排除自引用和不存在的 profile）
    const visionId = currentProfile.visionProfileId
    if (visionId && visionId !== currentProfileId && profiles.some(p => p.id === visionId)) {
      const visionProfile = profiles.find(p => p.id === visionId)
      log.info(`Vision routing: switching from ${currentProfile.model} to ${visionProfile?.model || visionId}`)
      return visionId
    }
    
    return this.profileId
  }
  
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
      
      const effectiveProfileId = this.resolveEffectiveProfileId(run)
      
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
        effectiveProfileId, // 视觉路由：有新图片时自动切换到视觉模型
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
    'recall',
    'recall_task',
    'deep_recall',
    'skill',
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
    const toolNames = toolCalls.map(tc => tc.function.name).join(', ')
    log.info(`Tools parallel batch: [${toolNames}]`)

    run.executionPhase = 'reading'
    run.currentToolName = `${toolCalls.length} tools`
    
    const batchStartTime = Date.now()
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
    
    const batchElapsed = Date.now() - batchStartTime
    const successCount = results.filter(r => r.result.success).length
    log.info(`Tools parallel done: ${successCount}/${results.length} succeeded, ${batchElapsed}ms`)

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
    
    const toolStartTime = Date.now()
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
      result = { 
        success: false, 
        output: '', 
        error: error instanceof Error ? error.message : String(error) 
      }
    }
    
    const toolElapsed = Date.now() - toolStartTime
    if (result.success) {
      log.info(`Tool executed: ${toolName}, ${toolElapsed}ms, outputLen=${result.output.length}`)
    } else {
      log.warn(`Tool failed: ${toolName}, ${toolElapsed}ms, error=${(result.error || '').slice(0, 200)}`)
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
    _toolArgs: Record<string, unknown>
  ): void {
    const resultContent = result.success 
      ? result.output 
      : t('agent.tool_error', { error: result.error || t('agent.unknown_error') })
    
    // AI Debug: 记录工具执行结果
    if (run.requestId) {
      getAiDebugService().logToolResult(run.requestId, {
        toolCallId: toolCall.id,
        success: result.success,
        result: resultContent
      })
    }
    
    // 添加工具结果到消息历史
    const toolMsg: AiMessage = {
      role: 'tool',
      content: resultContent,
      tool_call_id: toolCall.id
    }
    run.messages.push(toolMsg)
    run.taskMessageLog.push({ ...toolMsg })
    
    // 如果工具返回了图片，追加一条 user 消息携带图片
    // 用 user 消息而非 tool 消息携带图片，兼容所有 AI 提供商
    if (result.images && result.images.length > 0) {
      const imageMsg: AiMessage = {
        role: 'user',
        content: t('agent.image_from_tool'),
        images: result.images
      }
      run.messages.push(imageMsg)
      // taskMessageLog 不保存 images（base64 太大，会撑爆持久化存储）
      run.taskMessageLog.push({ role: 'user', content: imageMsg.content })
    }
  }
  
  /**
   * 创建工具执行器配置
   */
  protected createToolExecutorConfig(run: AgentRun): ToolExecutorConfig {
    return {
      agentId: this._agentId || run.ptyId || undefined,
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
      getSshConfig: (terminalId) => this.services.sshService?.getConfig(terminalId) || null,
      // 上下文管理
      compressCurrentContext: (summary: string, keepRecent: number) => {
        return this.compressCurrentContext(run, summary, keepRecent)
      },
      getCompressedArchives: () => {
        return (run.compressedArchives || []).map(a => ({
          id: a.id,
          summary: a.summary,
          messageCount: a.messages.length,
          timestamp: a.timestamp
        }))
      },
      getCompressedArchive: (archiveId: string) => {
        const archive = run.compressedArchives?.find(a => a.id === archiveId)
        return archive ? archive.messages : null
      },
      historyService: this.services.historyService,
      getAiService: () => this.services.aiService,
      getActiveProfileId: () => this.services.configService?.getActiveAiProfile() ?? undefined
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
    const userSupplementMsg: AiMessage = { role: 'user', content: supplementMsg }
    run.messages.push(userSupplementMsg)
    run.taskMessageLog.push({ ...userSupplementMsg })
    
    // 如果有计划，提示 AI
    if (this.currentPlan && this.currentPlan.steps.some(s => s.status === 'pending')) {
      const planHintMsg: AiMessage = { role: 'user', content: t('agent.user_supplement_with_plan') }
      run.messages.push(planHintMsg)
      run.taskMessageLog.push({ ...planHintMsg })
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
      const planMsg: AiMessage = { role: 'user', content: hint }
      run.messages.push(planMsg)
      run.taskMessageLog.push({ ...planMsg })
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
    } else if (toolName === 'execute_command' || toolName === 'exec' || toolName === 'run_command') {
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
      const confirmation: PendingConfirmationInternal = {
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
    const keyArgs = (toolName === 'execute_command' || toolName === 'exec') ? { command: toolArgs.command } : toolArgs
    return `${toolName}:${JSON.stringify(keyArgs)}`
  }
  
  /**
   * 设置终端输出监听器
   */
  private setupOutputListener(run: AgentRun): void {
    if (!run.ptyId) return
    
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
  
  /** 上下文管理功能激活阈值（用量百分比） */
  private static readonly CONTEXT_MGMT_THRESHOLD = 50

  /** 动态章节的标题（用于在系统提示词中按 markdown 章节定位和替换） */
  private static readonly CONTEXT_MGMT_HEADING = '\n\n## 运行环境'
  private static readonly CONTEXT_STATUS_HEADING = '\n\n## 上下文状态'

  /**
   * 更新上下文压力状态：注入上下文状态 + 渐进式提醒
   * 
   * 设计原则：程序只提供信息，所有压缩决策由 AI 做。
   * - < 50%: 不注入任何上下文信息（节省 token）
   * - >= 50%: 注入上下文状态 + 管理章节 + 注册管理工具
   * - 70%-85%: 追加压缩建议
   * - 85%+: 注入警告消息到 run.messages
   * - API 自然报错: 最终兜底
   */
  private updateContextPressure(run: AgentRun): void {
    const contextLength = this.getContextLength()
    const totalTokens = this.estimateTotalTokens(run.messages)
    const usagePercent = Math.round((totalTokens / contextLength) * 100)
    const remaining = Math.max(0, contextLength - totalTokens)

    // 将估算的 token 数更新到最近的 step，供前端上下文统计显示
    const steps = this.currentRun?.steps
    if (steps && steps.length > 0) {
      const lastStep = steps[steps.length - 1]
      lastStep.contextTokens = totalTokens
      this.callbacks?.onStep?.(this.currentRun?.id || '', lastStep)
    }

    // 统计当前任务的消息数（user 消息之后的消息）
    let taskMessageCount = 0
    for (let i = run.messages.length - 1; i >= 0; i--) {
      if (run.messages[i].role === 'user') break
      taskMessageCount++
    }

    // 超过阈值时激活上下文管理功能（一旦激活不会关闭，因为压缩后用量可能降低）
    if (!this.contextManagementEnabled && usagePercent >= Agent.CONTEXT_MGMT_THRESHOLD) {
      this.contextManagementEnabled = true
    }

    // 构建上下文状态章节
    const statusLines = [
      '## 上下文状态',
      `- 上下文窗口：${contextLength.toLocaleString()} tokens`,
      `- 当前用量：~${totalTokens.toLocaleString()} tokens（${usagePercent}%）`,
      `- 剩余容量：~${remaining.toLocaleString()} tokens`,
      `- 当前任务消息数：${taskMessageCount}`,
    ]

    // 渐进式提醒
    if (usagePercent >= 85) {
      statusLines.push(`- ⚠️ 警告：上下文用量已达危险水平，请立即调用 compress_context 压缩较早的对话，否则下次请求可能因超出模型上下文限制而失败。`)
    } else if (usagePercent >= 70) {
      statusLines.push(`- 建议：上下文空间开始紧张，考虑调用 compress_context 压缩较早的对话以释放空间。`)
    }

    // 按 markdown 章节标题定位并替换动态尾部
    if (run.messages.length > 0 && run.messages[0].role === 'system') {
      const systemContent = run.messages[0].content || ''

      // 找到最早的动态章节位置（运行环境 或 上下文状态），从该位置截断
      const mgmtIdx = systemContent.indexOf(Agent.CONTEXT_MGMT_HEADING)
      const statusIdx = systemContent.indexOf(Agent.CONTEXT_STATUS_HEADING)
      const cutPoints = [mgmtIdx, statusIdx].filter(i => i !== -1)
      const cutPoint = cutPoints.length > 0 ? Math.min(...cutPoints) : -1

      let content = cutPoint !== -1 ? systemContent.substring(0, cutPoint) : systemContent

      // 上下文管理章节（超过阈值时追加）
      if (this.contextManagementEnabled) {
        content += PromptBuilder.buildContextManagementSection()
        content += '\n\n' + statusLines.join('\n')
      }

      run.messages[0].content = content
    }

    // 85%+ 额外注入警告消息（避免重复注入）
    if (usagePercent >= 85) {
      const lastMsg = run.messages[run.messages.length - 1]
      const isAlreadyWarned = lastMsg?.role === 'user' && 
        typeof lastMsg.content === 'string' && 
        lastMsg.content.includes('[系统] 上下文用量告警')
      
      if (!isAlreadyWarned) {
        run.messages.push({
          role: 'user',
          content: t('agent.context_pressure_warning', {
            percentage: usagePercent,
            remaining: remaining.toLocaleString()
          })
        })
      }
    }
  }
  
  /**
   * 压缩当前任务的对话上下文
   * 将早期的 assistant + tool 消息归档，替换为 AI 提供的摘要
   */
  private compressCurrentContext(
    run: AgentRun,
    summary: string,
    keepRecent: number
  ): { beforeTokens: number; afterTokens: number; freedTokens: number; archiveId: string } | null {
    // 找到当前任务的消息范围（最后一条 user 消息之后的部分）
    let lastUserIndex = -1
    for (let i = run.messages.length - 1; i >= 0; i--) {
      if (run.messages[i].role === 'user') {
        // 跳过系统注入的警告消息
        if (typeof run.messages[i].content === 'string' &&
            run.messages[i].content!.includes('[系统] 上下文用量告警')) {
          continue
        }
        lastUserIndex = i
        break
      }
    }

    if (lastUserIndex === -1) return null

    // 当前任务的消息（user 消息之后到末尾）
    const taskMessages = run.messages.slice(lastUserIndex + 1)

    // 计算需要保留的消息数量
    // 一组 = assistant 消息 + 对应的 tool result 消息
    // 从后往前数 keepRecent 组
    let keepFromIndex = taskMessages.length
    let groupCount = 0
    for (let i = taskMessages.length - 1; i >= 0; i--) {
      if (taskMessages[i].role === 'assistant') {
        groupCount++
        if (groupCount >= keepRecent) {
          keepFromIndex = i
          break
        }
      }
    }

    // 需要压缩的消息
    const toCompress = taskMessages.slice(0, keepFromIndex)
    if (toCompress.length === 0) return null

    const beforeTokens = this.estimateTotalTokens(run.messages)

    // 生成归档 ID
    if (!run.compressedArchives) {
      run.compressedArchives = []
    }
    const archiveId = `ca-${run.compressedArchives.length + 1}`

    // 归档原始消息（深拷贝，防止后续 run.messages 修改影响归档）
    run.compressedArchives.push({
      id: archiveId,
      messages: JSON.parse(JSON.stringify(toCompress)),
      summary,
      timestamp: Date.now()
    })

    // 替换：用一条摘要消息替换被压缩的消息
    const summaryMessage: AiMessage = {
      role: 'assistant',
      content: `[早期对话已压缩，归档 ID: "${archiveId}"。如需查看原始内容，请调用 recall_compressed(archive_id: "${archiveId}")。]\n\n${summary}`
    }

    // 重建 messages: system + 历史任务消息 + user + 摘要 + 保留的最近消息
    const preserved = taskMessages.slice(keepFromIndex)
    run.messages = [
      ...run.messages.slice(0, lastUserIndex + 1),
      summaryMessage,
      ...preserved
    ]

    const afterTokens = this.estimateTotalTokens(run.messages)

    return {
      beforeTokens,
      afterTokens,
      freedTokens: beforeTokens - afterTokens,
      archiveId
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
      log.info(`修复 ${missingToolCalls.length} 个缺失的 tool result 消息`)
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
    const languageHint = this.getLanguageHint()
    return languageHint + message
  }

  private resolveBondContext(): string | undefined {
    try {
      return getBondService().getBondContext()
    } catch {
      return undefined
    }
  }
}
