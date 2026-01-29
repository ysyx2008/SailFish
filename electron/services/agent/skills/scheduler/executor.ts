/**
 * 定时任务技能执行器
 */
import { getSchedulerService } from '../../../scheduler.service'
import type { ScheduleConfig, TargetConfig } from '../../../scheduler.store'
import type { ToolResult, ToolExecutorConfig, AgentConfig } from '../../tools/types'

/**
 * 执行定时任务技能工具
 */
export async function executeSchedulerTool(
  toolName: string,
  ptyId: string,
  args: Record<string, unknown>,
  toolCallId: string,
  config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  switch (toolName) {
    case 'schedule_list':
      return listTasks(args)
    case 'schedule_create':
      return createTask(args)
    case 'schedule_delete':
      return deleteTask(args)
    case 'schedule_toggle':
      return toggleTask(args)
    case 'schedule_run':
      return runTask(args, executor)
    case 'schedule_history':
      return getHistory(args)
    case 'schedule_ssh_sessions':
      return listSshSessions()
    default:
      return { success: false, output: '', error: `未知的定时任务工具: ${toolName}` }
  }
}

/**
 * 列出所有定时任务
 */
async function listTasks(args: Record<string, unknown>): Promise<ToolResult> {
  const includeDisabled = args.include_disabled as boolean ?? true
  
  try {
    const scheduler = getSchedulerService()
    let tasks = scheduler.getTasks()
    
    if (!includeDisabled) {
      tasks = tasks.filter(t => t.enabled)
    }
    
    if (tasks.length === 0) {
      return {
        success: true,
        output: '暂无定时任务。使用 schedule_create 创建新任务。'
      }
    }
    
    const taskList = tasks.map(task => {
      const status = task.enabled ? '✓ 启用' : '○ 禁用'
      const targetDesc = task.target.type === 'local' 
        ? '本地终端' 
        : task.target.type === 'ssh' 
          ? `SSH: ${task.target.sshSessionName || task.target.sshSessionId}`
          : '无终端'
      const nextRun = task.nextRun 
        ? new Date(task.nextRun).toLocaleString('zh-CN')
        : '未调度'
      
      return `- **${task.name}** [${status}]
  ID: ${task.id}
  调度: ${formatScheduleExpression(task.schedule)}
  目标: ${targetDesc}
  下次执行: ${nextRun}
  指令: ${task.prompt.substring(0, 50)}${task.prompt.length > 50 ? '...' : ''}`
    }).join('\n\n')
    
    return {
      success: true,
      output: `共 ${tasks.length} 个定时任务：\n\n${taskList}`
    }
  } catch (error) {
    return {
      success: false,
      output: '',
      error: `获取任务列表失败: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}

/**
 * 创建定时任务
 */
async function createTask(args: Record<string, unknown>): Promise<ToolResult> {
  const name = args.name as string
  const prompt = args.prompt as string
  const scheduleType = args.schedule_type as 'cron' | 'interval' | 'once'
  const scheduleExpression = args.schedule_expression as string
  const targetType = (args.target_type as string) || 'local'
  const sshSessionId = args.ssh_session_id as string | undefined
  const description = args.description as string | undefined
  const timeout = args.timeout as number | undefined
  const enabled = args.enabled as boolean ?? true
  
  // 验证必要参数
  if (!name?.trim()) {
    return { success: false, output: '', error: '任务名称不能为空' }
  }
  if (!prompt?.trim()) {
    return { success: false, output: '', error: '任务指令不能为空' }
  }
  if (!scheduleType || !['cron', 'interval', 'once'].includes(scheduleType)) {
    return { success: false, output: '', error: '调度类型必须是 cron、interval 或 once' }
  }
  if (!scheduleExpression?.trim()) {
    return { success: false, output: '', error: '调度表达式不能为空' }
  }
  
  // 验证目标类型
  if (targetType === 'ssh' && !sshSessionId) {
    return { success: false, output: '', error: 'SSH 目标需要指定 ssh_session_id' }
  }
  if (targetType === 'assistant') {
    return { success: false, output: '', error: '无终端模式暂不支持定时任务' }
  }
  
  try {
    const scheduler = getSchedulerService()
    
    // 构建调度配置
    const schedule: ScheduleConfig = {
      type: scheduleType,
      expression: scheduleExpression
    }
    
    // 构建目标配置
    const target: TargetConfig = {
      type: targetType as 'local' | 'ssh',
      sshSessionId: sshSessionId,
      sshSessionName: sshSessionId ? scheduler.getSshSession(sshSessionId)?.name : undefined
    }
    
    // 创建任务
    const task = scheduler.createTask({
      name: name.trim(),
      description: description?.trim(),
      schedule,
      prompt: prompt.trim(),
      target,
      options: {
        timeout: timeout ?? 300,
        notifyOnComplete: false,
        notifyOnError: true
      },
      enabled
    })
    
    const nextRunStr = task.nextRun 
      ? new Date(task.nextRun).toLocaleString('zh-CN')
      : '未调度'
    
    return {
      success: true,
      output: `✅ 定时任务创建成功\n名称：${task.name}\nID：${task.id}\n下次执行：${nextRunStr}`
    }
  } catch (error) {
    return {
      success: false,
      output: '',
      error: `创建任务失败: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}

/**
 * 删除定时任务
 */
async function deleteTask(args: Record<string, unknown>): Promise<ToolResult> {
  const taskId = args.task_id as string
  
  if (!taskId?.trim()) {
    return { success: false, output: '', error: '任务 ID 不能为空' }
  }
  
  try {
    const scheduler = getSchedulerService()
    const task = scheduler.getTask(taskId)
    
    if (!task) {
      return { success: false, output: '', error: `任务不存在: ${taskId}` }
    }
    
    const taskName = task.name
    const deleted = scheduler.deleteTask(taskId)
    
    if (deleted) {
      return {
        success: true,
        output: `✅ 已删除任务：${taskName}`
      }
    } else {
      return { success: false, output: '', error: '删除失败' }
    }
  } catch (error) {
    return {
      success: false,
      output: '',
      error: `删除任务失败: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}

/**
 * 启用/禁用定时任务
 */
async function toggleTask(args: Record<string, unknown>): Promise<ToolResult> {
  const taskId = args.task_id as string
  
  if (!taskId?.trim()) {
    return { success: false, output: '', error: '任务 ID 不能为空' }
  }
  
  try {
    const scheduler = getSchedulerService()
    const task = scheduler.toggleTask(taskId)
    
    if (!task) {
      return { success: false, output: '', error: `任务不存在: ${taskId}` }
    }
    
    const status = task.enabled ? '启用' : '禁用'
    const nextRunStr = task.nextRun 
      ? new Date(task.nextRun).toLocaleString('zh-CN')
      : '无'
    
    return {
      success: true,
      output: `✅ 任务 "${task.name}" 已${status}\n下次执行：${nextRunStr}`
    }
  } catch (error) {
    return {
      success: false,
      output: '',
      error: `切换任务状态失败: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}

/**
 * 立即执行定时任务
 */
async function runTask(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const taskId = args.task_id as string
  
  if (!taskId?.trim()) {
    return { success: false, output: '', error: '任务 ID 不能为空' }
  }
  
  try {
    const scheduler = getSchedulerService()
    const task = scheduler.getTask(taskId)
    
    if (!task) {
      return { success: false, output: '', error: `任务不存在: ${taskId}` }
    }
    
    // 添加执行步骤
    const step = executor.addStep({
      type: 'tool_call',
      content: `正在执行定时任务: ${task.name}...`,
      toolName: 'schedule_run',
      toolArgs: { task_id: taskId },
      riskLevel: 'safe'
    })
    
    const result = await scheduler.runTask(taskId)
    
    executor.updateStep(step.id, {
      content: result.success 
        ? `定时任务执行完成: ${task.name}\n耗时: ${Math.round(result.duration / 1000)}s`
        : `定时任务执行失败: ${task.name}\n错误: ${result.error}`
    })
    
    if (result.success) {
      return {
        success: true,
        output: `✅ 任务 "${task.name}" 执行完成，耗时 ${Math.round(result.duration / 1000)} 秒` + 
          (result.output ? `\n\n输出:\n${result.output}` : '')
      }
    } else {
      return {
        success: false,
        output: result.output || '',
        error: result.error
      }
    }
  } catch (error) {
    return {
      success: false,
      output: '',
      error: `执行任务失败: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}

/**
 * 获取任务执行历史
 */
async function getHistory(args: Record<string, unknown>): Promise<ToolResult> {
  const taskId = args.task_id as string | undefined
  const limit = args.limit as number ?? 10
  
  try {
    const scheduler = getSchedulerService()
    const history = scheduler.getHistory(taskId, limit)
    
    if (history.length === 0) {
      return {
        success: true,
        output: taskId 
          ? `任务 ${taskId} 暂无执行记录`
          : '暂无执行记录'
      }
    }
    
    const historyList = history.map(record => {
      const statusIcon = {
        success: '✓',
        failed: '✗',
        timeout: '⏱',
        cancelled: '⊘',
        running: '●'
      }[record.status] || '?'
      
      const time = new Date(record.at).toLocaleString('zh-CN')
      const duration = record.duration < 1000 
        ? `${record.duration}ms`
        : `${(record.duration / 1000).toFixed(1)}s`
      
      return `${statusIcon} **${record.taskName}** - ${time}
  耗时: ${duration}${record.error ? `\n  错误: ${record.error}` : ''}`
    }).join('\n\n')
    
    return {
      success: true,
      output: `最近 ${history.length} 条执行记录:\n\n${historyList}`
    }
  } catch (error) {
    return {
      success: false,
      output: '',
      error: `获取历史记录失败: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}

/**
 * 获取可用的 SSH 会话列表
 */
async function listSshSessions(): Promise<ToolResult> {
  try {
    const scheduler = getSchedulerService()
    const sessions = scheduler.getSshSessions()
    
    if (sessions.length === 0) {
      return {
        success: true,
        output: '暂无已保存的 SSH 会话。创建定时任务时可以使用 target_type="local" 在本地终端执行。'
      }
    }
    
    const sessionList = sessions.map(s => 
      `- **${s.name}** (ID: ${s.id})\n  ${s.username}@${s.host}:${s.port}`
    ).join('\n')
    
    return {
      success: true,
      output: `可用的 SSH 会话:\n\n${sessionList}\n\n创建定时任务时，使用 ssh_session_id 参数指定目标会话。`
    }
  } catch (error) {
    return {
      success: false,
      output: '',
      error: `获取 SSH 会话列表失败: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}

// ==================== 辅助函数 ====================

/**
 * 格式化调度表达式为人类可读格式
 */
function formatScheduleExpression(schedule: ScheduleConfig): string {
  if (schedule.type === 'cron') {
    return `Cron: ${schedule.expression}`
  } else if (schedule.type === 'interval') {
    const match = schedule.expression.match(/^(\d+)(s|m|h|d)$/)
    if (match) {
      const value = match[1]
      const unitMap: Record<string, string> = { s: '秒', m: '分钟', h: '小时', d: '天' }
      return `每 ${value} ${unitMap[match[2]]}`
    }
    return schedule.expression
  } else {
    return `一次性: ${new Date(schedule.expression).toLocaleString('zh-CN')}`
  }
}
