/**
 * 定时任务存储服务
 * 使用 electron-store 持久化任务配置和执行历史
 */
import Store from 'electron-store'

// ==================== 类型定义 ====================

/**
 * 任务执行状态
 */
export type TaskRunStatus = 'success' | 'failed' | 'timeout' | 'cancelled' | 'running'

/**
 * 调度类型
 */
export type ScheduleType = 'cron' | 'interval' | 'once'

/**
 * 执行目标类型
 */
export type TargetType = 'local' | 'ssh' | 'assistant'

/**
 * 调度配置
 */
export interface ScheduleConfig {
  type: ScheduleType
  expression: string  // cron: "0 9 * * *", interval: "30m", once: "2024-02-01T15:00"
}

/**
 * 执行目标配置
 */
export interface TargetConfig {
  type: TargetType
  sshSessionId?: string      // 引用 SshSession.id
  sshSessionName?: string    // 显示用
  workingDirectory?: string  // 本地模式工作目录
}

/**
 * 执行选项
 */
export interface TaskOptions {
  timeout: number            // 超时时间（秒），默认 300
  requireConfirm: boolean    // 是否需要用户确认，默认 false
  notifyOnComplete: boolean  // 完成时通知
  notifyOnError: boolean     // 失败时通知
}

/**
 * 执行记录
 */
export interface TaskRunRecord {
  at: number                 // 执行时间戳
  status: TaskRunStatus      // 执行状态
  duration: number           // 执行时长（毫秒）
  output?: string            // 输出内容（截断）
  error?: string             // 错误信息
}

/**
 * 定时任务定义
 */
export interface ScheduledTask {
  id: string
  name: string
  description?: string
  enabled: boolean
  
  // 调度配置
  schedule: ScheduleConfig
  
  // 执行内容
  prompt: string
  
  // 执行目标
  target: TargetConfig
  
  // 执行选项
  options: TaskOptions
  
  // 元数据
  createdAt: number
  updatedAt: number
  
  // 运行时状态（不持久化到任务配置，而是在内存中管理）
  lastRun?: TaskRunRecord
  nextRun?: number
}

/**
 * 执行历史记录（带任务信息）
 */
export interface TaskHistoryRecord extends TaskRunRecord {
  id: string           // 记录 ID
  taskId: string       // 任务 ID
  taskName: string     // 任务名称（冗余，方便显示）
}

/**
 * 存储模式定义
 */
interface SchedulerStoreSchema {
  tasks: ScheduledTask[]
  history: TaskHistoryRecord[]
}

// ==================== 默认配置 ====================

const DEFAULT_TASK_OPTIONS: TaskOptions = {
  timeout: 300,
  requireConfirm: false,
  notifyOnComplete: false,
  notifyOnError: true
}

const defaultSchema: SchedulerStoreSchema = {
  tasks: [],
  history: []
}

// 历史记录最大保存条数
const MAX_HISTORY_RECORDS = 200

// ==================== 存储服务类 ====================

export class SchedulerStore {
  private store: Store<SchedulerStoreSchema>

  constructor() {
    this.store = new Store<SchedulerStoreSchema>({
      name: 'qiyu-terminal-scheduler',
      defaults: defaultSchema
    })
  }

  // ==================== 任务 CRUD ====================

  /**
   * 获取所有任务
   */
  getTasks(): ScheduledTask[] {
    return this.store.get('tasks') || []
  }

  /**
   * 获取单个任务
   */
  getTask(id: string): ScheduledTask | undefined {
    const tasks = this.getTasks()
    return tasks.find(t => t.id === id)
  }

  /**
   * 创建任务
   */
  createTask(task: Omit<ScheduledTask, 'id' | 'createdAt' | 'updatedAt'>): ScheduledTask {
    const now = Date.now()
    const newTask: ScheduledTask = {
      ...task,
      id: this.generateId(),
      createdAt: now,
      updatedAt: now,
      options: {
        ...DEFAULT_TASK_OPTIONS,
        ...task.options
      }
    }
    
    const tasks = this.getTasks()
    tasks.push(newTask)
    this.store.set('tasks', tasks)
    
    return newTask
  }

  /**
   * 更新任务
   */
  updateTask(id: string, updates: Partial<Omit<ScheduledTask, 'id' | 'createdAt'>>): ScheduledTask | null {
    const tasks = this.getTasks()
    const index = tasks.findIndex(t => t.id === id)
    
    if (index === -1) {
      return null
    }
    
    const updatedTask: ScheduledTask = {
      ...tasks[index],
      ...updates,
      updatedAt: Date.now()
    }
    
    tasks[index] = updatedTask
    this.store.set('tasks', tasks)
    
    return updatedTask
  }

  /**
   * 删除任务
   */
  deleteTask(id: string): boolean {
    const tasks = this.getTasks()
    const filtered = tasks.filter(t => t.id !== id)
    
    if (filtered.length === tasks.length) {
      return false
    }
    
    this.store.set('tasks', filtered)
    return true
  }

  /**
   * 切换任务启用状态
   */
  toggleTask(id: string): ScheduledTask | null {
    const task = this.getTask(id)
    if (!task) {
      return null
    }
    
    return this.updateTask(id, { enabled: !task.enabled })
  }

  /**
   * 更新任务的最后执行信息
   */
  updateTaskLastRun(id: string, lastRun: TaskRunRecord): void {
    const task = this.getTask(id)
    if (task) {
      this.updateTask(id, { lastRun })
    }
  }

  /**
   * 更新任务的下次执行时间
   */
  updateTaskNextRun(id: string, nextRun: number | undefined): void {
    const task = this.getTask(id)
    if (task) {
      this.updateTask(id, { nextRun })
    }
  }

  // ==================== 执行历史 ====================

  /**
   * 获取执行历史
   * @param taskId 可选，指定任务 ID 过滤
   * @param limit 返回条数，默认 50
   */
  getHistory(taskId?: string, limit: number = 50): TaskHistoryRecord[] {
    let history = this.store.get('history') || []
    
    if (taskId) {
      history = history.filter(h => h.taskId === taskId)
    }
    
    // 按时间倒序，最新的在前
    history.sort((a, b) => b.at - a.at)
    
    return history.slice(0, limit)
  }

  /**
   * 添加执行历史记录
   */
  addHistory(record: Omit<TaskHistoryRecord, 'id'>): TaskHistoryRecord {
    const history = this.store.get('history') || []
    
    const newRecord: TaskHistoryRecord = {
      ...record,
      id: this.generateId()
    }
    
    history.push(newRecord)
    
    // 限制历史记录数量
    if (history.length > MAX_HISTORY_RECORDS) {
      // 按时间排序，删除最旧的
      history.sort((a, b) => b.at - a.at)
      history.splice(MAX_HISTORY_RECORDS)
    }
    
    this.store.set('history', history)
    
    return newRecord
  }

  /**
   * 清除指定任务的历史记录
   */
  clearHistory(taskId?: string): void {
    if (taskId) {
      const history = this.store.get('history') || []
      const filtered = history.filter(h => h.taskId !== taskId)
      this.store.set('history', filtered)
    } else {
      this.store.set('history', [])
    }
  }

  // ==================== 辅助方法 ====================

  /**
   * 生成唯一 ID
   */
  private generateId(): string {
    const timestamp = Date.now().toString(36)
    const random = Math.random().toString(36).substring(2, 8)
    return `${timestamp}-${random}`
  }

  /**
   * 导出所有数据（用于备份）
   */
  exportData(): SchedulerStoreSchema {
    return {
      tasks: this.getTasks(),
      history: this.store.get('history') || []
    }
  }

  /**
   * 导入数据（用于恢复）
   */
  importData(data: Partial<SchedulerStoreSchema>): void {
    if (data.tasks) {
      this.store.set('tasks', data.tasks)
    }
    if (data.history) {
      this.store.set('history', data.history)
    }
  }
}

// 单例实例
let schedulerStoreInstance: SchedulerStore | null = null

/**
 * 获取调度器存储服务实例
 */
export function getSchedulerStore(): SchedulerStore {
  if (!schedulerStoreInstance) {
    schedulerStoreInstance = new SchedulerStore()
  }
  return schedulerStoreInstance
}
