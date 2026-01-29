/**
 * 定时任务调度服务
 * 负责任务的调度、执行和生命周期管理
 */
import { BrowserWindow, Notification } from 'electron'
import { 
  getSchedulerStore, 
  type ScheduledTask, 
  type TaskRunRecord,
  type TaskHistoryRecord,
  type ScheduleConfig,
  type TargetConfig,
  type TaskOptions
} from './scheduler.store'
import type { PtyService } from './pty.service'
import type { SshService, SshConfig } from './ssh.service'
import type { ConfigService, SshSession } from './config.service'
import type { AgentService } from './agent'
import type { AgentContext, AgentCallbacks, AgentStep } from './agent/types'

// cron-parser 动态导入
let cronParser: typeof import('cron-parser') | null = null

/**
 * 任务执行结果
 */
export interface TaskExecutionResult {
  success: boolean
  output: string
  error?: string
  duration: number
  steps?: AgentStep[]
}

/**
 * 调度服务配置
 */
export interface SchedulerServiceConfig {
  ptyService: PtyService
  sshService: SshService
  configService: ConfigService
  agentService: AgentService
  mainWindow: BrowserWindow | null
}

/**
 * 任务创建参数
 */
export interface CreateTaskParams {
  name: string
  description?: string
  schedule: ScheduleConfig
  prompt: string
  target: TargetConfig
  options?: Partial<TaskOptions>
  enabled?: boolean
}

/**
 * 正在运行的任务信息
 */
interface RunningTask {
  taskId: string
  ptyId: string | null
  startTime: number
  abortController?: AbortController
}

export class SchedulerService {
  private store = getSchedulerStore()
  private config: SchedulerServiceConfig | null = null
  private timers: Map<string, NodeJS.Timeout> = new Map()
  private runningTasks: Map<string, RunningTask> = new Map()
  private isRunning = false
  private checkInterval: NodeJS.Timeout | null = null
  
  // 任务执行回调（用于通知前端）
  private onTaskStartCallback?: (taskId: string, ptyId: string | null) => void
  private onTaskCompleteCallback?: (taskId: string, result: TaskExecutionResult) => void

  /**
   * 初始化服务
   */
  init(config: SchedulerServiceConfig): void {
    this.config = config
    console.log('[SchedulerService] 初始化完成')
  }

  /**
   * 启动调度器
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('[SchedulerService] 调度器已在运行')
      return
    }

    // 动态加载 cron-parser
    if (!cronParser) {
      try {
        cronParser = await import('cron-parser')
      } catch (e) {
        console.error('[SchedulerService] 无法加载 cron-parser:', e)
        throw new Error('cron-parser 模块加载失败')
      }
    }

    this.isRunning = true
    console.log('[SchedulerService] 调度器启动')

    // 计算所有任务的下次执行时间
    const tasks = this.store.getTasks()
    for (const task of tasks) {
      if (task.enabled) {
        this.scheduleTask(task)
      }
    }

    // 定期检查（每分钟），处理可能错过的任务
    this.checkInterval = setInterval(() => {
      this.checkMissedTasks()
    }, 60 * 1000)
  }

  /**
   * 停止调度器
   */
  stop(): void {
    if (!this.isRunning) return

    this.isRunning = false

    // 清除所有定时器
    for (const [taskId, timer] of this.timers) {
      clearTimeout(timer)
      console.log(`[SchedulerService] 清除任务定时器: ${taskId}`)
    }
    this.timers.clear()

    // 清除检查定时器
    if (this.checkInterval) {
      clearInterval(this.checkInterval)
      this.checkInterval = null
    }

    console.log('[SchedulerService] 调度器已停止')
  }

  // ==================== 任务 CRUD ====================

  /**
   * 获取所有任务
   */
  getTasks(): ScheduledTask[] {
    return this.store.getTasks()
  }

  /**
   * 获取单个任务
   */
  getTask(id: string): ScheduledTask | undefined {
    return this.store.getTask(id)
  }

  /**
   * 创建任务
   */
  createTask(params: CreateTaskParams): ScheduledTask {
    const task = this.store.createTask({
      name: params.name,
      description: params.description,
      schedule: params.schedule,
      prompt: params.prompt,
      target: params.target,
      options: {
        timeout: params.options?.timeout ?? 300,
        requireConfirm: params.options?.requireConfirm ?? false,
        notifyOnComplete: params.options?.notifyOnComplete ?? false,
        notifyOnError: params.options?.notifyOnError ?? true
      },
      enabled: params.enabled ?? true
    })

    // 如果启用，立即调度
    if (task.enabled && this.isRunning) {
      this.scheduleTask(task)
    }

    console.log(`[SchedulerService] 创建任务: ${task.name} (${task.id})`)
    return task
  }

  /**
   * 更新任务
   */
  updateTask(id: string, updates: Partial<CreateTaskParams>): ScheduledTask | null {
    const task = this.store.updateTask(id, updates)
    
    if (task) {
      // 重新调度
      this.cancelTaskTimer(id)
      if (task.enabled && this.isRunning) {
        this.scheduleTask(task)
      }
      console.log(`[SchedulerService] 更新任务: ${task.name} (${task.id})`)
    }

    return task
  }

  /**
   * 删除任务
   */
  deleteTask(id: string): boolean {
    this.cancelTaskTimer(id)
    const result = this.store.deleteTask(id)
    if (result) {
      console.log(`[SchedulerService] 删除任务: ${id}`)
    }
    return result
  }

  /**
   * 切换任务启用状态
   */
  toggleTask(id: string): ScheduledTask | null {
    const task = this.store.toggleTask(id)
    
    if (task) {
      if (task.enabled && this.isRunning) {
        this.scheduleTask(task)
      } else {
        this.cancelTaskTimer(id)
      }
      console.log(`[SchedulerService] 切换任务: ${task.name} -> ${task.enabled ? '启用' : '禁用'}`)
    }

    return task
  }

  // ==================== 执行历史 ====================

  /**
   * 获取执行历史
   */
  getHistory(taskId?: string, limit?: number): TaskHistoryRecord[] {
    return this.store.getHistory(taskId, limit)
  }

  /**
   * 清除历史
   */
  clearHistory(taskId?: string): void {
    this.store.clearHistory(taskId)
  }

  // ==================== SSH 会话 ====================

  /**
   * 获取可用的 SSH 会话列表
   */
  getSshSessions(): SshSession[] {
    return this.config?.configService.getSshSessions() || []
  }

  /**
   * 获取单个 SSH 会话
   */
  getSshSession(id: string): SshSession | undefined {
    const sessions = this.getSshSessions()
    return sessions.find(s => s.id === id)
  }

  // ==================== 任务执行 ====================

  /**
   * 立即执行任务
   */
  async runTask(id: string): Promise<TaskExecutionResult> {
    const task = this.store.getTask(id)
    if (!task) {
      return {
        success: false,
        output: '',
        error: '任务不存在',
        duration: 0
      }
    }

    return this.executeTask(task)
  }

  /**
   * 执行任务
   */
  private async executeTask(task: ScheduledTask): Promise<TaskExecutionResult> {
    if (!this.config) {
      return {
        success: false,
        output: '',
        error: '调度服务未初始化',
        duration: 0
      }
    }

    // 检查是否已在运行
    if (this.runningTasks.has(task.id)) {
      return {
        success: false,
        output: '',
        error: '任务正在执行中',
        duration: 0
      }
    }

    const startTime = Date.now()
    let ptyId: string | null = null
    let result: TaskExecutionResult

    console.log(`[SchedulerService] 开始执行任务: ${task.name} (${task.id})`)

    try {
      // 1. 创建终端
      if (task.target.type === 'local') {
        ptyId = this.config.ptyService.create({
          cwd: task.target.workingDirectory
        })
        console.log(`[SchedulerService] 创建本地终端: ${ptyId}`)
      } else if (task.target.type === 'ssh') {
        const sshSession = this.getSshSession(task.target.sshSessionId || '')
        if (!sshSession) {
          throw new Error(`SSH 会话不存在: ${task.target.sshSessionName || task.target.sshSessionId}`)
        }
        
        const sshConfig: SshConfig = {
          host: sshSession.host,
          port: sshSession.port,
          username: sshSession.username,
          password: sshSession.password,
          privateKeyPath: sshSession.privateKeyPath,
          passphrase: sshSession.passphrase
        }
        
        ptyId = await this.config.sshService.connect(sshConfig)
        console.log(`[SchedulerService] 创建 SSH 终端: ${ptyId} -> ${sshSession.name}`)
      }
      // assistant 模式不需要终端

      // 记录运行状态
      this.runningTasks.set(task.id, {
        taskId: task.id,
        ptyId,
        startTime
      })

      // 2. 通知前端任务开始（包含 prompt，前端负责创建 tab 并执行 Agent）
      this.notifyTaskStarted(task.id, ptyId, task)

      // 3. 前端会自动执行 Agent，后端只记录已触发
      result = {
        success: true,
        output: '任务已触发，Agent 正在前端执行',
        duration: Date.now() - startTime
      }

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      result = {
        success: false,
        output: '',
        error: errorMsg,
        duration: Date.now() - startTime
      }
    } finally {
      // 清理运行状态（标记为已触发，实际执行在前端）
      this.runningTasks.delete(task.id)
    }

    // 4. 记录触发记录
    const runRecord: TaskRunRecord = {
      at: startTime,
      status: result.success ? 'success' : 'failed',
      duration: result.duration,
      output: result.output.substring(0, 1000),
      error: result.error
    }

    this.store.updateTaskLastRun(task.id, runRecord)
    this.store.addHistory({
      taskId: task.id,
      taskName: task.name,
      ...runRecord
    })

    // 5. 发送系统通知（仅当有错误时）
    if (!result.success) {
      this.sendNotification(task, result)
    }

    // 6. 重新调度（如果是周期性任务）
    if (task.enabled && this.isRunning && task.schedule.type !== 'once') {
      this.scheduleTask(task)
    }

    console.log(`[SchedulerService] 任务已触发: ${task.name}, Agent 执行中...`)

    return result
  }

  /**
   * 使用 Agent 执行任务
   */
  private async executeWithAgent(task: ScheduledTask, ptyId: string | null): Promise<TaskExecutionResult> {
    if (!this.config?.agentService) {
      return {
        success: false,
        output: '',
        error: 'Agent 服务未初始化',
        duration: 0
      }
    }

    // assistant 模式暂不支持
    if (!ptyId) {
      return {
        success: false,
        output: '',
        error: '无终端模式（assistant）暂不支持定时任务',
        duration: 0
      }
    }

    const startTime = Date.now()
    const steps: AgentStep[] = []
    let finalOutput = ''
    let hasError = false
    let errorMessage = ''

    try {
      // 构建 Agent 上下文
      const context: AgentContext = {
        ptyId,
        terminalOutput: [],
        systemInfo: {
          os: process.platform,
          shell: process.env.SHELL || '/bin/bash'
        },
        terminalType: task.target.type === 'ssh' ? 'ssh' : 'local'
      }

      // 设置回调收集执行步骤，并发送到前端显示
      const callbacks: AgentCallbacks = {
        onStepAdded: (step: AgentStep) => {
          steps.push(step)
          // 收集最终消息
          if (step.type === 'message') {
            finalOutput += step.content + '\n'
          }
          if (step.type === 'error') {
            hasError = true
            errorMessage = step.content
          }
          // 发送步骤到前端显示
          if (this.config?.mainWindow && !this.config.mainWindow.isDestroyed()) {
            const serializedStep = JSON.parse(JSON.stringify(step))
            this.config.mainWindow.webContents.send('agent:step', { 
              agentId: `scheduler-${task.id}`, 
              ptyId, 
              step: serializedStep 
            })
          }
        },
        onStepUpdated: (step: AgentStep) => {
          const index = steps.findIndex(s => s.id === step.id)
          if (index >= 0) {
            steps[index] = step
          }
          // 发送步骤更新到前端
          if (this.config?.mainWindow && !this.config.mainWindow.isDestroyed()) {
            const serializedStep = JSON.parse(JSON.stringify(step))
            this.config.mainWindow.webContents.send('agent:step', { 
              agentId: `scheduler-${task.id}`, 
              ptyId, 
              step: serializedStep 
            })
          }
        }
      }

      // 执行 Agent
      const result = await Promise.race([
        this.config.agentService.run(
          ptyId,
          task.prompt,
          context,
          {
            enabled: true,
            maxSteps: 50,
            commandTimeout: 30000,
            autoExecuteSafe: true,
            autoExecuteModerate: true, // 定时任务自动执行中等风险命令
            executionMode: 'relaxed',
            debugMode: false
          },
          undefined, // profileId
          undefined, // workerOptions
          callbacks
        ),
        // 超时处理
        new Promise<string>((_, reject) => {
          setTimeout(() => {
            reject(new Error(`任务执行超时 (${task.options.timeout}s)`))
          }, task.options.timeout * 1000)
        })
      ])

      finalOutput = result || finalOutput

      return {
        success: !hasError,
        output: finalOutput.trim(),
        error: hasError ? errorMessage : undefined,
        duration: Date.now() - startTime,
        steps
      }

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      
      // 尝试中止运行中的 Agent
      try {
        this.config.agentService.abort(ptyId)
      } catch {
        // 忽略中止错误
      }

      return {
        success: false,
        output: finalOutput.trim(),
        error: errorMsg,
        duration: Date.now() - startTime,
        steps
      }
    }
  }

  // ==================== 调度逻辑 ====================

  /**
   * 调度任务
   */
  private scheduleTask(task: ScheduledTask): void {
    if (!cronParser) {
      console.error('[SchedulerService] cron-parser 未加载')
      return
    }

    // 取消已有的定时器
    this.cancelTaskTimer(task.id)

    try {
      const nextRun = this.calculateNextRun(task.schedule)
      
      if (!nextRun) {
        console.log(`[SchedulerService] 任务无下次执行时间: ${task.name}`)
        return
      }

      const delay = nextRun - Date.now()
      
      if (delay <= 0) {
        // 如果时间已过，立即执行
        console.log(`[SchedulerService] 任务立即执行: ${task.name}`)
        this.executeTask(task)
        return
      }

      // 更新下次执行时间
      this.store.updateTaskNextRun(task.id, nextRun)

      // 设置定时器
      const timer = setTimeout(() => {
        this.timers.delete(task.id)
        this.executeTask(task)
      }, delay)

      this.timers.set(task.id, timer)

      const nextRunDate = new Date(nextRun)
      console.log(`[SchedulerService] 任务已调度: ${task.name}, 下次执行: ${nextRunDate.toLocaleString()}`)

    } catch (error) {
      console.error(`[SchedulerService] 调度任务失败: ${task.name}`, error)
    }
  }

  /**
   * 计算下次执行时间
   */
  private calculateNextRun(schedule: ScheduleConfig): number | null {
    if (!cronParser) return null

    try {
      switch (schedule.type) {
        case 'cron': {
          const interval = cronParser.parseExpression(schedule.expression)
          return interval.next().getTime()
        }
        
        case 'interval': {
          // 解析间隔表达式，如 "30m", "1h", "2d"
          const match = schedule.expression.match(/^(\d+)(s|m|h|d)$/)
          if (!match) {
            console.error(`[SchedulerService] 无效的间隔表达式: ${schedule.expression}`)
            return null
          }
          
          const value = parseInt(match[1], 10)
          const unit = match[2]
          
          let ms = 0
          switch (unit) {
            case 's': ms = value * 1000; break
            case 'm': ms = value * 60 * 1000; break
            case 'h': ms = value * 60 * 60 * 1000; break
            case 'd': ms = value * 24 * 60 * 60 * 1000; break
          }
          
          return Date.now() + ms
        }
        
        case 'once': {
          // ISO 日期时间格式
          const timestamp = new Date(schedule.expression).getTime()
          if (isNaN(timestamp)) {
            console.error(`[SchedulerService] 无效的日期格式: ${schedule.expression}`)
            return null
          }
          // 一次性任务，如果时间已过则不执行
          return timestamp > Date.now() ? timestamp : null
        }
        
        default:
          return null
      }
    } catch (error) {
      console.error(`[SchedulerService] 计算下次执行时间失败:`, error)
      return null
    }
  }

  /**
   * 取消任务定时器
   */
  private cancelTaskTimer(taskId: string): void {
    const timer = this.timers.get(taskId)
    if (timer) {
      clearTimeout(timer)
      this.timers.delete(taskId)
    }
    this.store.updateTaskNextRun(taskId, undefined)
  }

  /**
   * 检查错过的任务
   */
  private checkMissedTasks(): void {
    const tasks = this.store.getTasks()
    const now = Date.now()

    for (const task of tasks) {
      if (!task.enabled) continue
      
      // 如果任务没有设置定时器，重新调度
      if (!this.timers.has(task.id) && !this.runningTasks.has(task.id)) {
        this.scheduleTask(task)
      }
    }
  }

  // ==================== 通知 ====================

  /**
   * 发送系统通知
   */
  private sendNotification(task: ScheduledTask, result: TaskExecutionResult): void {
    const shouldNotify = 
      (result.success && task.options.notifyOnComplete) ||
      (!result.success && task.options.notifyOnError)

    if (!shouldNotify) return

    try {
      const notification = new Notification({
        title: result.success ? '定时任务完成' : '定时任务失败',
        body: `${task.name}\n${result.success ? `耗时 ${Math.round(result.duration / 1000)} 秒` : result.error}`,
        silent: false
      })
      notification.show()
    } catch (error) {
      console.error('[SchedulerService] 发送通知失败:', error)
    }
  }

  /**
   * 通知前端任务开始
   */
  private notifyTaskStarted(taskId: string, ptyId: string | null, task: ScheduledTask): void {
    if (this.onTaskStartCallback) {
      this.onTaskStartCallback(taskId, ptyId)
    }
    
    // 通过 IPC 通知渲染进程，发送完整的任务信息以便创建 tab 并执行
    if (this.config?.mainWindow) {
      this.config.mainWindow.webContents.send('scheduler:task-started', { 
        taskId, 
        ptyId,
        taskName: task.name,
        prompt: task.prompt,  // 任务 prompt，前端用于启动 Agent
        targetType: task.target.type,
        sshSessionId: task.target.sshSessionId,
        sshSessionName: task.target.sshSessionName
      })
    }
  }

  /**
   * 通知前端任务完成
   */
  private notifyTaskCompleted(taskId: string, result: TaskExecutionResult): void {
    if (this.onTaskCompleteCallback) {
      this.onTaskCompleteCallback(taskId, result)
    }
    
    // 通过 IPC 通知渲染进程
    if (this.config?.mainWindow) {
      this.config.mainWindow.webContents.send('scheduler:task-completed', { taskId, result })
    }
  }

  /**
   * 设置任务开始回调
   */
  onTaskStart(callback: (taskId: string, ptyId: string | null) => void): void {
    this.onTaskStartCallback = callback
  }

  /**
   * 设置任务完成回调
   */
  onTaskComplete(callback: (taskId: string, result: TaskExecutionResult) => void): void {
    this.onTaskCompleteCallback = callback
  }

  /**
   * 检查任务是否正在运行
   */
  isTaskRunning(taskId: string): boolean {
    return this.runningTasks.has(taskId)
  }

  /**
   * 获取正在运行的任务列表
   */
  getRunningTasks(): string[] {
    return Array.from(this.runningTasks.keys())
  }
}

// 单例实例
let schedulerServiceInstance: SchedulerService | null = null

/**
 * 获取调度服务实例
 */
export function getSchedulerService(): SchedulerService {
  if (!schedulerServiceInstance) {
    schedulerServiceInstance = new SchedulerService()
  }
  return schedulerServiceInstance
}
