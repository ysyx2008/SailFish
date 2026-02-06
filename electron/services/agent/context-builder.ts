/**
 * 上下文构建器
 * 实现智能分层记忆：按预算填充 + 渐进式降级
 */

import type { AiMessage } from '../ai.service'
import type { TaskMemory, AgentStep } from './types'
import type { TaskMemoryStore } from './task-memory'
import { t } from './i18n'

// ==================== 类型定义 ====================

/**
 * 压缩级别
 * Level 0: 完整对话（用户请求 + 所有工具调用/结果 + AI 回复）
 * Level 1: 压缩对话（用户请求 + 压缩后的工具输出 + AI 回复）
 * Level 2: 精简对话（用户请求 + AI 最终回复）
 * Level 3: L2 摘要（命令、路径、关键发现）
 * Level 4: L1 总结（一句话概要）
 */
export type CompressionLevel = 0 | 1 | 2 | 3 | 4

/**
 * 上下文预算分配
 */
export interface ContextBudget {
  total: number              // 总预算（tokens）
  systemPrompt: number       // 系统提示基础部分
  knowledge: number          // 知识库/主机记忆
  recentTasks: number        // 最近任务区（按预算填充）
  nearTasks: number          // 较近任务摘要
  historySummary: number     // 历史任务总结
  currentConversation: number // 当前对话预留
}

/**
 * 带压缩级别的任务上下文
 */
export interface TaskWithLevel {
  taskId: string
  level: CompressionLevel    // 实际使用的压缩级别
  tokens: number             // 实际占用的 tokens
  content: AiMessage[] | string  // Level 0-2 返回消息数组，Level 3-4 返回字符串
  userRequest: string        // 用户原始请求（用于显示）
  status: 'success' | 'failed' | 'aborted' | 'pending_confirmation'
}

/**
 * 上下文构建结果
 */
export interface ContextBuildResult {
  // Level 0-2 的任务，作为消息注入
  recentTaskMessages: AiMessage[]
  // Level 3-4 的任务，作为摘要/总结写入系统提示
  taskSummarySection: string
  // 所有可用任务的ID列表（用于 recall_task 工具）
  availableTaskIds: Array<{ id: string; summary: string }>
  // 统计信息
  stats: {
    totalTasks: number
    level0Count: number
    level1Count: number
    level2Count: number
    level3Count: number
    level4Count: number
    usedTokens: number
    budget: number
  }
}

// ==================== 预算计算 ====================

/**
 * 根据模型上下文长度计算预算分配
 */
export function calculateBudget(contextLength: number): ContextBudget {
  // 总预算为上下文长度的 80%（预留 20% 给当前对话的工具调用等）
  const total = Math.floor(contextLength * 0.8)
  
  return {
    total,
    systemPrompt: 3000,                           // 固定约 3000 tokens
    knowledge: Math.floor(total * 0.15),          // 15% 给知识库
    recentTasks: Math.floor(total * 0.40),        // 40% 给最近任务（按预算填充）
    nearTasks: Math.floor(total * 0.10),          // 10% 给较近任务摘要
    historySummary: Math.floor(total * 0.05),     // 5% 给历史总结
    currentConversation: Math.floor(total * 0.10) // 10% 预留给当前对话
  }
}

// ==================== 压缩工具 ====================

/**
 * 压缩工具输出（用于 Level 1）
 */
function compressToolOutput(output: string, maxLength: number = 1500): string {
  if (output.length <= maxLength) {
    return output
  }
  
  const lines = output.split('\n')
  
  // 如果是结构化输出，保留头尾
  if (lines.length > 15) {
    const headLines = lines.slice(0, 8)
    const tailLines = lines.slice(-5)
    const omitted = lines.length - 13
    return [
      ...headLines,
      `\n... [${omitted} 行已省略] ...\n`,
      ...tailLines
    ].join('\n')
  }
  
  // 否则简单截断
  return output.substring(0, maxLength) + `\n... [已截断，原长度: ${output.length}]`
}

/**
 * 获取任务的最低压缩级别（特殊任务保护）
 * @param task 任务记忆
 * @param taskIndex 任务在时间顺序中的索引（0 = 最近一个任务）
 */
function getMinCompressionLevel(task: TaskMemory, taskIndex: number): CompressionLevel {
  // 最近 1 个任务：Level 0（完整对话），确保 AI 能理解上下文连续性
  if (taskIndex === 0) return 0
  
  // 之后 2 个任务：Level 1（压缩对话），保留工具调用摘要
  if (taskIndex <= 2) return 1
  
  // 之后 3 个任务：Level 2（精简对话），仅保留请求和回复
  if (taskIndex <= 5) return 2
  
  // 等待确认的任务：至少保留 Level 2（用户请求 + AI 确认问题）
  if (task.status === 'pending_confirmation') return 2
  
  // 被中止的任务：至少保留 Level 2（用户请求 + 中止原因）
  if (task.status === 'aborted') return 2
  
  // 失败的任务：至少保留 Level 2（用户请求 + 错误信息）
  if (task.status === 'failed') return 2
  
  // 更早的成功任务：降级为摘要，节省 token
  return 4
}

/**
 * 从 AgentStep[] 提取最终 AI 回复
 */
function extractFinalReply(steps: AgentStep[]): string {
  // 从后往前找最后一个 message 类型的步骤
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i]
    if (step.type === 'message' && step.content) {
      return step.content
    }
  }
  return ''
}

/**
 * 将任务转换为指定压缩级别的内容
 */
function compressTask(
  task: TaskMemory, 
  level: CompressionLevel
): AiMessage[] | string {
  switch (level) {
    case 0:
      // Level 0: 完整对话
      return getFullMessages(task)
    
    case 1:
      // Level 1: 压缩工具输出
      return getCompressedMessages(task)
    
    case 2:
      // Level 2: 只保留用户请求和最终回复
      return getSimplifiedMessages(task)
    
    case 3:
      // Level 3: L2 摘要
      return formatDigest(task)
    
    case 4:
      // Level 4: L1 总结
      return task.summary
    
    default:
      return task.summary
  }
}

/**
 * Level 0: 获取完整消息历史
 */
function getFullMessages(task: TaskMemory): AiMessage[] {
  const messages: AiMessage[] = []
  
  // 用户请求
  messages.push({ role: 'user', content: task.userRequest })
  
  // 遍历步骤，构建完整对话
  let currentAssistantContent = ''
  let pendingToolCalls: Array<{ id: string; name: string; arguments: string }> = []
  
  for (const step of task.fullSteps) {
    if (step.type === 'tool_call' && step.toolName) {
      // 工具调用
      pendingToolCalls.push({
        id: step.id,
        name: step.toolName,
        arguments: JSON.stringify(step.toolArgs || {})
      })
    } else if (step.type === 'tool_result' && step.toolName) {
      // 如果有待处理的工具调用，先输出 assistant 消息
      if (pendingToolCalls.length > 0) {
        messages.push({
          role: 'assistant',
          content: currentAssistantContent || '',
          tool_calls: pendingToolCalls.map(tc => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: tc.arguments }
          }))
        })
        currentAssistantContent = ''
        
        // 输出工具结果
        for (const tc of pendingToolCalls) {
          const result = tc.id === step.id ? (step.toolResult || '') : ''
          messages.push({
            role: 'tool',
            content: result,
            tool_call_id: tc.id
          })
        }
        pendingToolCalls = []
      }
    } else if (step.type === 'message') {
      // AI 消息内容
      currentAssistantContent += (currentAssistantContent ? '\n' : '') + step.content
    }
  }
  
  // 输出最后的 assistant 消息
  if (currentAssistantContent || pendingToolCalls.length > 0) {
    const msg: AiMessage = {
      role: 'assistant',
      content: currentAssistantContent
    }
    if (pendingToolCalls.length > 0) {
      msg.tool_calls = pendingToolCalls.map(tc => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: tc.arguments }
      }))
    }
    messages.push(msg)
    
    // 如果有未处理的 tool_calls，必须添加对应的 tool result 消息
    // 否则 API 会报错：'tool_calls' must be followed by tool messages responding to each 'tool_call_id'
    if (pendingToolCalls.length > 0) {
      for (const tc of pendingToolCalls) {
        messages.push({
          role: 'tool',
          content: '[任务中断，工具执行结果未记录]',
          tool_call_id: tc.id
        })
      }
    }
  }
  
  return messages
}

/**
 * Level 1: 获取压缩工具输出后的消息
 */
function getCompressedMessages(task: TaskMemory): AiMessage[] {
  const messages: AiMessage[] = []
  
  // 用户请求
  messages.push({ role: 'user', content: task.userRequest })
  
  // 构建压缩后的 assistant 消息
  let assistantContent = ''
  
  // 提取关键工具调用摘要
  const toolSummaries: string[] = []
  for (const step of task.fullSteps) {
    if (step.type === 'tool_call' && step.toolName) {
      let summary = `[${step.toolName}]`
      if (step.toolArgs?.command) {
        const cmd = String(step.toolArgs.command)
        summary += ` ${cmd.length > 80 ? cmd.substring(0, 80) + '...' : cmd}`
      } else if (step.toolArgs?.path) {
        summary += ` ${step.toolArgs.path}`
      }
      toolSummaries.push(summary)
    } else if (step.type === 'tool_result' && step.toolResult) {
      // 压缩工具输出
      const compressed = compressToolOutput(step.toolResult)
      if (toolSummaries.length > 0) {
        toolSummaries[toolSummaries.length - 1] += `\n→ ${compressed}`
      }
    } else if (step.type === 'message' && step.content) {
      assistantContent = step.content  // 保留最后一个消息
    }
  }
  
  // 构建 assistant 回复
  let fullAssistantContent = ''
  if (toolSummaries.length > 0) {
    fullAssistantContent = `**执行摘要:**\n${toolSummaries.join('\n')}\n\n`
  }
  fullAssistantContent += assistantContent
  
  messages.push({ role: 'assistant', content: fullAssistantContent })
  
  return messages
}

/**
 * Level 2: 只保留用户请求和最终回复
 */
function getSimplifiedMessages(task: TaskMemory): AiMessage[] {
  const finalReply = extractFinalReply(task.fullSteps)
  
  // 添加状态标记
  let statusNote = ''
  if (task.status === 'aborted') {
    statusNote = '\n\n[任务已被用户中止]'
  } else if (task.status === 'failed') {
    statusNote = '\n\n[任务执行失败]'
  }
  
  return [
    { role: 'user', content: task.userRequest },
    { role: 'assistant', content: finalReply + statusNote }
  ]
}

/**
 * Level 3: 格式化 L2 摘要
 */
function formatDigest(task: TaskMemory): string {
  const { digest } = task
  const lines: string[] = [`[${task.id}] ${task.userRequest}`]
  
  if (digest.commands.length > 0) {
    lines.push(`• 命令: ${digest.commands.slice(0, 5).join(', ')}`)
  }
  if (digest.paths.length > 0) {
    lines.push(`• 路径: ${digest.paths.slice(0, 5).join(', ')}`)
  }
  if (digest.services.length > 0) {
    lines.push(`• 服务: ${digest.services.join(', ')}`)
  }
  if (digest.errors.length > 0) {
    lines.push(`• 错误: ${digest.errors.slice(0, 2).join('; ')}`)
  }
  if (digest.keyFindings.length > 0) {
    lines.push(`• 发现: ${digest.keyFindings.slice(0, 2).join('; ')}`)
  }
  
  const statusIcon = task.status === 'success' ? '✓' 
    : task.status === 'failed' ? '✗' 
    : task.status === 'pending_confirmation' ? '⏳'
    : '⊘'
  lines.push(`• 状态: ${statusIcon} ${task.status}`)
  
  return lines.join('\n')
}

// ==================== Token 估算 ====================

/**
 * 估算文本的 token 数
 */
function estimateTokens(text: string | null | undefined): number {
  if (!text) return 0
  // 中文字符约 1.5 tokens/字
  // 非中文内容约 0.5 tokens/字符（URL、JSON、特殊字符等 tokenizer 切分较碎）
  const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length
  const otherChars = text.length - chineseChars
  return Math.ceil(chineseChars * 1.5 + otherChars * 0.5)
}

/**
 * 估算消息数组的 token 数
 */
function estimateMessagesTokens(messages: AiMessage[]): number {
  return messages.reduce((sum, msg) => {
    let tokens = estimateTokens(msg.content)
    if (msg.tool_calls) {
      tokens += msg.tool_calls.reduce((t, tc) => 
        t + estimateTokens(tc.function.name) + estimateTokens(tc.function.arguments), 0)
    }
    return sum + tokens
  }, 0)
}

/**
 * 估算任务在指定压缩级别的 token 数
 */
function estimateTaskTokens(task: TaskMemory, level: CompressionLevel): number {
  const content = compressTask(task, level)
  if (Array.isArray(content)) {
    return estimateMessagesTokens(content)
  }
  return estimateTokens(content)
}

// ==================== 上下文引用检测 ====================

/**
 * 检测用户是否引用之前的上下文
 */
export function detectContextReference(userMessage: string): boolean {
  const patterns = [
    /刚才|刚刚|上次|之前|继续|接着|上一个|前面/,
    /那个|这个|同样的|一样的|类似的/,
    /再试|重试|再来|再做/,
    /again|continue|previous|last|same|retry|redo/i
  ]
  return patterns.some(p => p.test(userMessage))
}

// ==================== 核心构建函数 ====================

/**
 * 按预算构建最近任务上下文（渐进式降级）
 */
export function buildRecentTasksContext(
  taskMemoryStore: TaskMemoryStore,
  budget: number,
  userMessage?: string
): ContextBuildResult {
  const result: ContextBuildResult = {
    recentTaskMessages: [],
    taskSummarySection: '',
    availableTaskIds: [],
    stats: {
      totalTasks: 0,
      level0Count: 0,
      level1Count: 0,
      level2Count: 0,
      level3Count: 0,
      level4Count: 0,
      usedTokens: 0,
      budget
    }
  }
  
  // 检测是否需要更详细的上下文
  const needsDetailedContext = userMessage ? detectContextReference(userMessage) : false
  const effectiveBudget = needsDetailedContext 
    ? Math.min(budget * 1.3, budget + 5000)  // 最多增加 30% 或 5000 tokens
    : budget
  
  let usedTokens = 0
  const processedTasks: TaskWithLevel[] = []
  const summaryLines: string[] = []
  
  // 获取按时间顺序的任务（最近的在前）
  const tasks = taskMemoryStore.getTasksInOrder()
  result.stats.totalTasks = tasks.length
  
  for (let taskIndex = 0; taskIndex < tasks.length; taskIndex++) {
    const task = tasks[taskIndex]
    const minLevel = getMinCompressionLevel(task, taskIndex)
    let placed = false
    
    // 尝试各个压缩级别（从完整到精简）
    for (let level = 0 as CompressionLevel; level <= 4; level++) {
      // 跳过不允许的级别（特殊任务保护）
      if (level < minLevel && level < 3) continue
      
      const tokens = estimateTaskTokens(task, level)
      
      if (usedTokens + tokens <= effectiveBudget) {
        processedTasks.push({
          taskId: task.id,
          level,
          tokens,
          content: compressTask(task, level),
          userRequest: task.userRequest,
          status: task.status
        })
        usedTokens += tokens
        placed = true
        
        // 更新统计
        switch (level) {
          case 0: result.stats.level0Count++; break
          case 1: result.stats.level1Count++; break
          case 2: result.stats.level2Count++; break
          case 3: result.stats.level3Count++; break
          case 4: result.stats.level4Count++; break
        }
        break
      }
    }
    
    // 如果所有级别都放不下（即使是 L4），跳过这个任务
    if (!placed) {
      // 预算基本用尽，停止处理
      if (usedTokens >= effectiveBudget * 0.95) break
    }
  }
  
  result.stats.usedTokens = usedTokens
  
  // 分类处理：Level 0-2 作为消息，Level 3-4 作为摘要
  // processedTasks 是从新到旧的顺序，需要反转为自然时间顺序（从旧到新）
  const reversedTasks = [...processedTasks].reverse()
  
  for (const task of reversedTasks) {
    if (task.level <= 2) {
      // 作为消息注入（从旧到新，符合对话顺序）
      const messages = task.content as AiMessage[]
      result.recentTaskMessages.push(...messages)
    } else {
      // 作为摘要（从旧到新，符合自然阅读顺序）
      summaryLines.push(task.content as string)
    }
  }
  
  if (summaryLines.length > 0) {
    result.taskSummarySection = summaryLines.join('\n\n')
  }
  
  // 填充所有可用任务的ID列表（从旧到新，自然时间顺序）
  const summaries = taskMemoryStore.getSummaries(50)
  result.availableTaskIds = summaries.map(s => ({ id: s.id, summary: s.summary })).reverse()
  
  return result
}

/**
 * 完整的上下文构建入口
 */
export function buildTaskHistoryContext(
  taskMemoryStore: TaskMemoryStore,
  contextLength: number,
  userMessage: string
): ContextBuildResult {
  const budget = calculateBudget(contextLength)
  return buildRecentTasksContext(taskMemoryStore, budget.recentTasks, userMessage)
}

