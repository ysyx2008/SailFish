/**
 * 智能巡检协调器服务
 * Master Agent 逻辑：协调多个 Worker Agent 执行跨终端任务
 */
import { v4 as uuidv4 } from 'uuid'
import { BrowserWindow } from 'electron'
import type { 
  OrchestratorConfig, 
  OrchestratorRun, 
  WorkerState, 
  AvailableHost,
  DispatchResult,
  AggregatedResult,
  OrchestratorMessage,
  OrchestratorCallbacks,
  BatchConfirmation,
  WorkerAgentOptions
} from './orchestrator-types'
import { DEFAULT_ORCHESTRATOR_CONFIG } from './orchestrator-types'
import type { AgentPlan, AgentPlanStep, AgentStep, RiskLevel } from './types'
import { getOrchestratorTools, isOrchestratorTool } from './orchestrator-tools'
import type { AiService, AiMessage } from '../ai.service'
import type { SshSession } from '../config.service'

/**
 * 协调器服务
 */
export class OrchestratorService {
  private runs: Map<string, OrchestratorRun> = new Map()
  private callbacks: OrchestratorCallbacks = {}
  
  // 依赖服务（通过 setServices 注入）
  private aiService?: AiService
  private getSshSessions?: () => SshSession[]
  private createLocalTerminal?: () => Promise<string>
  private createSshTerminal?: (sshConfig: unknown) => Promise<string>
  private closeTerminal?: (terminalId: string) => Promise<void>
  private getTerminalType?: (terminalId: string) => 'local' | 'ssh'
  private runWorkerAgent?: (
    ptyId: string,
    task: string,
    workerOptions: WorkerAgentOptions
  ) => Promise<string>
  
  /**
   * 注入依赖服务
   */
  setServices(services: {
    aiService: AiService
    getSshSessions: () => SshSession[]
    createLocalTerminal: () => Promise<string>
    createSshTerminal: (sshConfig: unknown) => Promise<string>
    closeTerminal: (terminalId: string) => Promise<void>
    getTerminalType: (terminalId: string) => 'local' | 'ssh'
    runWorkerAgent: (ptyId: string, task: string, workerOptions: WorkerAgentOptions) => Promise<string>
  }) {
    this.aiService = services.aiService
    this.getSshSessions = services.getSshSessions
    this.createLocalTerminal = services.createLocalTerminal
    this.createSshTerminal = services.createSshTerminal
    this.closeTerminal = services.closeTerminal
    this.getTerminalType = services.getTerminalType
    this.runWorkerAgent = services.runWorkerAgent
  }
  
  /**
   * 设置事件回调
   */
  setCallbacks(callbacks: OrchestratorCallbacks) {
    this.callbacks = callbacks
  }
  
  /**
   * 启动协调任务
   */
  async startTask(
    task: string,
    config?: Partial<OrchestratorConfig>
  ): Promise<string> {
    const orchestratorId = uuidv4()
    const fullConfig: OrchestratorConfig = {
      ...DEFAULT_ORCHESTRATOR_CONFIG,
      ...config
    }
    
    const run: OrchestratorRun = {
      id: orchestratorId,
      task,
      config: fullConfig,
      status: 'running',
      workers: new Map(),
      terminalAliasMap: new Map(),  // 每个 run 独立的别名映射，避免多任务冲突
      messages: [],
      startedAt: Date.now()
    }
    
    this.runs.set(orchestratorId, run)
    
    // 发送初始消息
    this.addMessage(orchestratorId, {
      id: uuidv4(),
      type: 'user',
      content: task,
      timestamp: Date.now()
    })
    
    // 启动 Master Agent 循环
    this.runMasterAgent(orchestratorId).catch(error => {
      console.error(`[Orchestrator] Master Agent error:`, error)
      this.handleError(orchestratorId, error.message || String(error))
    })
    
    return orchestratorId
  }
  
  /**
   * 停止协调任务
   */
  async stopTask(orchestratorId: string): Promise<void> {
    const run = this.runs.get(orchestratorId)
    if (!run) return
    
    run.status = 'aborted'
    
    // 关闭所有 Worker 终端
    for (const [terminalId] of run.workers) {
      try {
        await this.closeTerminal?.(terminalId)
      } catch (e) {
        console.warn(`[Orchestrator] Failed to close terminal ${terminalId}:`, e)
      }
    }
    
    this.addMessage(orchestratorId, {
      id: uuidv4(),
      type: 'system',
      content: '任务已停止',
      timestamp: Date.now()
    })
  }
  
  /**
   * 获取可用主机列表
   */
  listAvailableHosts(): AvailableHost[] {
    const sessions = this.getSshSessions?.() || []
    return sessions.map(session => ({
      hostId: session.id,
      name: session.name,
      host: session.host,
      port: session.port,
      username: session.username,
      group: session.group,
      groupId: session.groupId,
      tags: session.tags
    }))
  }
  
  /**
   * 响应批量确认
   */
  respondBatchConfirm(
    orchestratorId: string,
    action: 'cancel' | 'current' | 'all',
    selectedTerminals?: string[]
  ): void {
    const run = this.runs.get(orchestratorId)
    if (!run?.pendingBatchConfirmation) return
    
    run.pendingBatchConfirmation.resolve(action, selectedTerminals)
    run.pendingBatchConfirmation = undefined
  }
  
  /**
   * 获取协调器状态
   */
  getStatus(orchestratorId: string): OrchestratorRun | null {
    return this.runs.get(orchestratorId) || null
  }
  
  // ==================== 私有方法 ====================
  
  /**
   * Master Agent 主循环
   */
  private async runMasterAgent(orchestratorId: string): Promise<void> {
    const run = this.runs.get(orchestratorId)
    if (!run) return
    
    if (!this.aiService) {
      this.handleError(orchestratorId, '请先在设置中配置 AI 服务')
      return
    }
    
    const tools = getOrchestratorTools()
    const messages: AiMessage[] = [
      {
        role: 'system',
        content: this.buildSystemPrompt()
      },
      {
        role: 'user',
        content: run.task
      }
    ]
    
    this.addMessage(orchestratorId, {
      id: uuidv4(),
      type: 'agent',
      content: '好的，我来分析任务并识别需要检查的服务器...',
      timestamp: Date.now()
    })
    
    let maxIterations = 50  // 防止无限循环
    
    while (run.status === 'running' && maxIterations-- > 0) {
      try {
        // 调用 AI（使用支持工具调用的方法，传递配置的 profileId）
        const response = await this.aiService.chatWithTools(messages, tools, run.config.profileId)
        
        // 处理响应
        if (response.content) {
          this.addMessage(orchestratorId, {
            id: uuidv4(),
            type: 'agent',
            content: response.content,
            timestamp: Date.now()
          })
        }
        
        // 检查是否有工具调用
        if (!response.tool_calls || response.tool_calls.length === 0) {
          // 没有工具调用，任务完成
          run.status = 'completed'
          run.completedAt = Date.now()
          
          // 收集最终结果
          const result = this.collectFinalResults(orchestratorId)
          run.result = result
          
          this.callbacks.onComplete?.(orchestratorId, result)
          this.sendToRenderer('orchestrator:complete', {
            orchestratorId,
            result
          })
          break
        }
        
        // 处理工具调用
        messages.push({
          role: 'assistant',
          content: response.content || '',
          tool_calls: response.tool_calls
        })
        
        for (const toolCall of response.tool_calls) {
          const toolName = toolCall.function.name
          const toolArgs = JSON.parse(toolCall.function.arguments || '{}')
          
          let toolResult: string
          
          try {
            toolResult = await this.executeOrchestratorTool(
              orchestratorId,
              toolName,
              toolArgs
            )
          } catch (error) {
            toolResult = JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : String(error)
            })
          }
          
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: toolResult
          })
        }
        
      } catch (error) {
        console.error(`[Orchestrator] AI call error:`, error)
        this.handleError(orchestratorId, error instanceof Error ? error.message : String(error))
        break
      }
    }
    
    if (maxIterations <= 0) {
      this.handleError(orchestratorId, '执行步数超过上限')
    }
  }
  
  /**
   * 执行协调器工具
   */
  private async executeOrchestratorTool(
    orchestratorId: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<string> {
    const run = this.runs.get(orchestratorId)
    if (!run) throw new Error('Orchestrator run not found')
    
    switch (toolName) {
      case 'list_available_hosts': {
        const hosts = this.listAvailableHosts()
        return JSON.stringify({
          success: true,
          hosts,
          count: hosts.length
        })
      }
      
      case 'connect_terminal': {
        const { type, host_id, alias } = args as { type: 'local' | 'ssh'; host_id?: string; alias: string }
        const result = await this.connectTerminal(orchestratorId, type, alias, host_id)
        return JSON.stringify(result)
      }
      
      case 'dispatch_task': {
        const { terminal_id, task, wait_for_result = true } = args as {
          terminal_id: string
          task: string
          wait_for_result?: boolean
        }
        const result = await this.dispatchTask(
          orchestratorId,
          terminal_id,
          task,
          wait_for_result
        )
        return JSON.stringify(result)
      }
      
      case 'parallel_dispatch': {
        const { terminal_ids, task } = args as {
          terminal_ids: string[]
          task: string
        }
        const results = await this.parallelDispatch(orchestratorId, terminal_ids, task)
        return JSON.stringify({
          success: true,
          results
        })
      }
      
      case 'get_task_status': {
        const { terminal_id } = args as { terminal_id: string }
        const realId = this.resolveTerminalId(terminal_id, run)
        const worker = run.workers.get(realId)
        if (!worker) {
          return JSON.stringify({
            success: false,
            error: `Terminal ${terminal_id} not found`
          })
        }
        return JSON.stringify({
          success: true,
          status: worker.status,
          currentTask: worker.currentTask,
          result: worker.result,
          error: worker.error,
          duration: worker.taskStartedAt 
            ? Date.now() - worker.taskStartedAt 
            : undefined
        })
      }
      
      case 'collect_results': {
        const { terminal_ids, format = 'summary' } = args as {
          terminal_ids?: string[]
          format?: 'table' | 'list' | 'summary'
        }
        const result = this.collectResults(orchestratorId, terminal_ids, format)
        return JSON.stringify(result)
      }
      
      case 'close_terminal': {
        const { terminal_id } = args as { terminal_id: string }
        await this.closeWorkerTerminal(orchestratorId, terminal_id)
        return JSON.stringify({ success: true })
      }
      
      case 'analyze_and_report': {
        const { findings, recommendations, severity } = args as {
          findings: string[]
          recommendations: string[]
          severity: 'info' | 'warning' | 'critical'
        }
        
        // 更新计划状态为完成
        if (run.currentPlan) {
          run.currentPlan.updatedAt = Date.now()
        }
        
        return JSON.stringify({
          success: true,
          report: {
            findings,
            recommendations,
            severity,
            generatedAt: Date.now()
          }
        })
      }
      
      default:
        throw new Error(`Unknown orchestrator tool: ${toolName}`)
    }
  }
  
  /**
   * 连接终端（支持本地和 SSH）
   */
  private async connectTerminal(
    orchestratorId: string,
    type: 'local' | 'ssh',
    alias: string,
    hostId?: string
  ): Promise<{ success: boolean; terminalId?: string; alias?: string; type?: string; error?: string }> {
    const run = this.runs.get(orchestratorId)
    if (!run) return { success: false, error: 'Orchestrator run not found' }
    
    try {
      let terminalId: string | undefined
      let hostName: string
      
      if (type === 'local') {
        // 创建本地终端
        terminalId = await this.createLocalTerminal?.()
        hostName = 'localhost'
      } else {
        // 创建 SSH 终端
        if (!hostId) {
          return { success: false, error: 'host_id is required for SSH terminal' }
        }
        
        const sessions = this.getSshSessions?.() || []
        const session = sessions.find(s => s.id === hostId)
        if (!session) {
          return { success: false, error: `Host ${hostId} not found` }
        }
        
        terminalId = await this.createSshTerminal?.({
          host: session.host,
          port: session.port,
          username: session.username,
          password: session.password,
          privateKey: session.privateKeyPath
        })
        hostName = session.name
      }
      
      if (!terminalId) {
        return { success: false, error: 'Failed to create terminal' }
      }
      
      // 注册 Worker
      const worker: WorkerState = {
        terminalId,
        hostId: hostId || 'local',
        hostName,
        status: 'idle'
      }
      run.workers.set(terminalId, worker)
      
      // 注册别名（使用 run 级别的 Map，避免多任务冲突）
      run.terminalAliasMap.set(alias, terminalId)
      
      // 更新计划（如果有）
      this.updatePlanWithWorker(orchestratorId, terminalId, alias)
      
      this.callbacks.onWorkerUpdate?.(orchestratorId, worker)
      this.sendToRenderer('orchestrator:workerUpdate', {
        orchestratorId,
        worker
      })
      
      return { success: true, terminalId, alias, type }
      
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }
  
  /**
   * 派发任务给单个终端
   */
  private async dispatchTask(
    orchestratorId: string,
    terminalId: string,
    task: string,
    waitForResult: boolean
  ): Promise<DispatchResult> {
    const run = this.runs.get(orchestratorId)
    const realId = this.resolveTerminalId(terminalId, run)
    const worker = run?.workers.get(realId)
    
    if (!run || !worker) {
      return {
        terminalId: realId,
        terminalName: terminalId,
        success: false,
        error: `Terminal ${terminalId} not found`
      }
    }
    
    worker.status = 'running'
    worker.currentTask = task
    worker.taskStartedAt = Date.now()
    this.callbacks.onWorkerUpdate?.(orchestratorId, worker)
    this.sendToRenderer('orchestrator:workerUpdate', {
      orchestratorId,
      worker
    })
    
    // 更新计划步骤状态
    this.updatePlanStepStatus(orchestratorId, realId, 'in_progress')
    
    try {
      const workerOptions: WorkerAgentOptions = {
        isWorker: true,
        orchestratorId,
        terminalName: worker.hostName,
        reportProgress: (step) => {
          // Worker 进度回调
          if (step.type === 'tool_result') {
            worker.steps = worker.steps || []
            worker.steps.push(step)
          }
        }
      }
      
      const result = await this.runWorkerAgent?.(realId, task, workerOptions)
      
      worker.status = 'completed'
      worker.result = result || 'Task completed'
      this.callbacks.onWorkerUpdate?.(orchestratorId, worker)
      this.sendToRenderer('orchestrator:workerUpdate', {
        orchestratorId,
        worker
      })
      
      // 更新计划步骤状态
      this.updatePlanStepStatus(orchestratorId, realId, 'completed', worker.result)
      
      return {
        terminalId: realId,
        terminalName: worker.hostName,
        success: true,
        result: worker.result,
        duration: Date.now() - (worker.taskStartedAt || Date.now())
      }
      
    } catch (error) {
      worker.status = 'failed'
      worker.error = error instanceof Error ? error.message : String(error)
      this.callbacks.onWorkerUpdate?.(orchestratorId, worker)
      this.sendToRenderer('orchestrator:workerUpdate', {
        orchestratorId,
        worker
      })
      
      // 更新计划步骤状态
      this.updatePlanStepStatus(orchestratorId, realId, 'failed', worker.error)
      
      return {
        terminalId: realId,
        terminalName: worker.hostName,
        success: false,
        error: worker.error,
        duration: Date.now() - (worker.taskStartedAt || Date.now())
      }
    }
  }
  
  /**
   * 并行派发任务
   */
  private async parallelDispatch(
    orchestratorId: string,
    terminalIds: string[],
    task: string
  ): Promise<DispatchResult[]> {
    const run = this.runs.get(orchestratorId)
    if (!run) return []
    
    const maxParallel = run.config.maxParallelWorkers
    const results: DispatchResult[] = []
    
    // 分批并行执行
    for (let i = 0; i < terminalIds.length; i += maxParallel) {
      const batch = terminalIds.slice(i, i + maxParallel)
      const batchResults = await Promise.all(
        batch.map(id => this.dispatchTask(orchestratorId, id, task, true))
      )
      results.push(...batchResults)
    }
    
    return results
  }
  
  /**
   * 收集结果
   */
  private collectResults(
    orchestratorId: string,
    terminalIds?: string[],
    format: 'table' | 'list' | 'summary' = 'summary'
  ): {
    totalCount: number
    successCount: number
    failedCount: number
    results: Array<{ terminalName: string; status: string; result?: string; error?: string }>
    formatted: string
  } {
    const run = this.runs.get(orchestratorId)
    if (!run) {
      return {
        totalCount: 0,
        successCount: 0,
        failedCount: 0,
        results: [],
        formatted: 'No data'
      }
    }
    
    const workers = Array.from(run.workers.values())
      .filter(w => !terminalIds || terminalIds.some(id => {
        const realId = this.resolveTerminalId(id, run)
        return w.terminalId === realId
      }))
    
    const results = workers.map(w => ({
      terminalName: w.hostName,
      status: w.status,
      result: w.result,
      error: w.error
    }))
    
    const successCount = workers.filter(w => w.status === 'completed').length
    const failedCount = workers.filter(w => w.status === 'failed').length
    
    let formatted: string
    switch (format) {
      case 'table':
        formatted = this.formatAsTable(results)
        break
      case 'list':
        formatted = this.formatAsList(results)
        break
      default:
        formatted = `总计 ${workers.length} 台，成功 ${successCount}，失败 ${failedCount}`
    }
    
    return {
      totalCount: workers.length,
      successCount,
      failedCount,
      results,
      formatted
    }
  }
  
  /**
   * 收集最终结果
   */
  private collectFinalResults(orchestratorId: string): AggregatedResult {
    const collected = this.collectResults(orchestratorId)
    return {
      totalCount: collected.totalCount,
      successCount: collected.successCount,
      failedCount: collected.failedCount,
      results: collected.results.map(r => ({
        terminalId: '',
        terminalName: r.terminalName,
        success: r.status === 'completed',
        result: r.result,
        error: r.error
      }))
    }
  }
  
  /**
   * 关闭 Worker 终端
   */
  private async closeWorkerTerminal(
    orchestratorId: string,
    terminalId: string
  ): Promise<void> {
    const run = this.runs.get(orchestratorId)
    const realId = this.resolveTerminalId(terminalId, run)
    
    if (run?.workers.has(realId)) {
      await this.closeTerminal?.(realId)
      run.workers.delete(realId)
    }
  }
  
  /**
   * 解析终端 ID（支持别名）
   * @param idOrAlias 终端 ID 或别名
   * @param run 协调器运行实例（用于获取该 run 的别名映射）
   */
  private resolveTerminalId(idOrAlias: string, run?: OrchestratorRun): string {
    // 使用 run 级别的别名映射，避免多任务冲突
    return run?.terminalAliasMap.get(idOrAlias) || idOrAlias
  }
  
  /**
   * 添加消息
   */
  private addMessage(orchestratorId: string, message: OrchestratorMessage): void {
    const run = this.runs.get(orchestratorId)
    if (!run) return
    
    run.messages.push(message)
    this.callbacks.onMessage?.(orchestratorId, message)
    
    // 发送到渲染进程
    this.sendToRenderer('orchestrator:message', {
      orchestratorId,
      message
    })
  }
  
  /**
   * 处理错误
   */
  private handleError(orchestratorId: string, error: string): void {
    const run = this.runs.get(orchestratorId)
    if (run) {
      run.status = 'failed'
      run.completedAt = Date.now()
    }
    
    this.addMessage(orchestratorId, {
      id: uuidv4(),
      type: 'system',
      content: `错误：${error}`,
      timestamp: Date.now()
    })
    
    this.callbacks.onError?.(orchestratorId, error)
    
    this.sendToRenderer('orchestrator:error', {
      orchestratorId,
      error
    })
  }
  
  /**
   * 更新计划中的 Worker 信息
   */
  private updatePlanWithWorker(
    orchestratorId: string,
    terminalId: string,
    alias: string
  ): void {
    const run = this.runs.get(orchestratorId)
    if (!run) return
    
    // 如果还没有计划，创建一个
    if (!run.currentPlan) {
      run.currentPlan = {
        id: uuidv4(),
        title: run.task.slice(0, 50),
        steps: [],
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
    }
    
    // 添加步骤
    const step: AgentPlanStep = {
      id: uuidv4(),
      title: '执行任务',
      status: 'pending',
      terminalId,
      terminalName: alias
    }
    run.currentPlan.steps.push(step)
    run.currentPlan.updatedAt = Date.now()
    
    this.callbacks.onPlanUpdate?.(orchestratorId, run.currentPlan)
    this.sendToRenderer('orchestrator:planUpdate', {
      orchestratorId,
      plan: run.currentPlan
    })
  }
  
  /**
   * 更新计划步骤状态
   */
  private updatePlanStepStatus(
    orchestratorId: string,
    terminalId: string,
    status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped',
    result?: string
  ): void {
    const run = this.runs.get(orchestratorId)
    if (!run?.currentPlan) return
    
    const step = run.currentPlan.steps.find(s => s.terminalId === terminalId)
    if (step) {
      step.status = status
      if (result) step.result = result
      if (status === 'in_progress') step.startedAt = Date.now()
      if (status === 'completed' || status === 'failed') step.completedAt = Date.now()
      
      run.currentPlan.updatedAt = Date.now()
      
      this.callbacks.onPlanUpdate?.(orchestratorId, run.currentPlan)
      this.sendToRenderer('orchestrator:planUpdate', {
        orchestratorId,
        plan: run.currentPlan
      })
    }
  }
  
  /**
   * 发送消息到渲染进程
   */
  private sendToRenderer(channel: string, data: unknown): void {
    const windows = BrowserWindow.getAllWindows()
    windows.forEach(win => {
      win.webContents.send(channel, data)
    })
  }
  
  /**
   * 构建系统提示词
   */
  private buildSystemPrompt(): string {
    return `你是一个智能运维助手，专门负责协调多台服务器的巡检和运维任务。

## 你的职责

1. **分析用户任务**：理解用户想要检查什么、在哪些服务器上执行
2. **识别目标服务器**：根据任务描述，从可用主机列表中选择合适的服务器
3. **连接服务器**：使用 connect_terminal 工具建立连接
4. **派发任务**：使用 dispatch_task 或 parallel_dispatch 向服务器派发具体任务
5. **收集结果**：使用 collect_results 汇总各服务器的执行结果
6. **分析报告**：使用 analyze_and_report 给出最终分析和建议

## 工作流程

1. 首先调用 list_available_hosts 了解有哪些服务器可用
2. 根据用户任务匹配服务器（如"生产服务器"→匹配分组名包含"生产"或"prod"的主机）
3. 连接需要的服务器
4. 并行或顺序派发任务
5. 收集并分析结果
6. 给出汇总报告和建议

## 注意事项

- 任务描述要清晰，Worker Agent 会自行决定具体命令
- 对于危险操作，系统会请求用户确认
- 合理使用并行派发提高效率
- 完成后记得生成分析报告

## 示例交互

用户："检查所有生产服务器的磁盘使用情况"
你的做法：
1. list_available_hosts → 找到生产服务器
2. connect_terminal 连接各服务器
3. parallel_dispatch "检查磁盘使用情况"
4. collect_results 收集结果
5. analyze_and_report 给出报告（哪些磁盘使用率高、建议清理等）`
  }
  
  /**
   * 格式化为表格
   */
  private formatAsTable(results: Array<{ terminalName: string; status: string; result?: string }>): string {
    const lines = ['| 服务器 | 状态 | 结果 |', '|--------|------|------|']
    for (const r of results) {
      lines.push(`| ${r.terminalName} | ${r.status} | ${r.result?.slice(0, 50) || '-'} |`)
    }
    return lines.join('\n')
  }
  
  /**
   * 格式化为列表
   */
  private formatAsList(results: Array<{ terminalName: string; status: string; result?: string; error?: string }>): string {
    return results.map(r => 
      `**${r.terminalName}** (${r.status})\n${r.result || r.error || '无结果'}`
    ).join('\n\n')
  }
}

// 单例导出
export const orchestratorService = new OrchestratorService()

