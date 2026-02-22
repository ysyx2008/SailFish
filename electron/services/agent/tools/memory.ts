/**
 * 任务记忆工具
 * 包括：回忆任务摘要、深度回忆任务详情、搜索历史对话
 */
import { t } from '../i18n'
import { truncateFromEnd } from './utils'
import type { ToolExecutorConfig, ToolResult } from './types'

/**
 * recall_task: 回忆之前任务的摘要
 */
export function recallTask(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig,
  _ptyId: string
): ToolResult {
  const taskId = args.task_id as string
  const memoryStore = executor.getTaskMemory()
  
  // 记录工具调用
  executor.addStep({
    type: 'tool_call',
    content: taskId ? t('memory.recalling_task', { taskId }) : t('memory.listing_tasks'),
    toolName: 'recall_task',
    toolArgs: args,
    riskLevel: 'safe'
  })
  
  if (!taskId) {
    const summaries = memoryStore.getSummaries(20)
    if (summaries.length === 0) {
      const error = t('memory.task_id_required') + '\n\n' + t('memory.no_task_history')
      executor.addStep({
        type: 'tool_result',
        content: error,
        toolName: 'recall_task',
        toolResult: error
      })
      return { success: false, output: '', error }
    }
    const availableIds = summaries.map(s => `- [${s.id}] ${s.summary}`).join('\n')
    const error = t('memory.task_id_required') + '\n\n' + t('memory.available_task_ids') + '\n' + availableIds
    executor.addStep({
      type: 'tool_result',
      content: t('memory.available_task_ids'),
      toolName: 'recall_task',
      toolResult: availableIds
    })
    return { success: false, output: '', error }
  }
  
  const result = memoryStore.getDigest(taskId)
  
  if (!result) {
    const summaries = memoryStore.getSummaries(20)
    if (summaries.length === 0) {
      const error = t('memory.task_not_found', { taskId }) + '\n\n' + t('memory.no_task_history')
      executor.addStep({
        type: 'tool_result',
        content: error,
        toolName: 'recall_task',
        toolResult: error
      })
      return { 
        success: false, 
        output: '', 
        error
      }
    }
    const availableIds = summaries.map(s => `- [${s.id}] ${s.summary}`).join('\n')
    const error = t('memory.task_not_found', { taskId }) + '\n\n' + t('memory.available_task_ids') + '\n' + availableIds
    executor.addStep({
      type: 'tool_result',
      content: t('memory.task_not_found', { taskId }),
      toolName: 'recall_task',
      toolResult: availableIds
    })
    return { 
      success: false, 
      output: '', 
      error
    }
  }
  
  const lines: string[] = [
    `📋 **${t('memory.task_recall')}**: ${taskId}`,
    `**${t('memory.user_request')}**: ${result.userRequest}`,
    ''
  ]
  
  const { digest } = result
  
  if (digest.commands.length > 0) {
    lines.push(`**${t('memory.commands')}**:`)
    digest.commands.forEach(cmd => lines.push(`  • ${cmd}`))
    lines.push('')
  }
  
  if (digest.paths.length > 0) {
    lines.push(`**${t('memory.paths')}**:`)
    digest.paths.forEach(p => lines.push(`  • ${p}`))
    lines.push('')
  }
  
  if (digest.services.length > 0) {
    lines.push(`**${t('memory.services')}**: ${digest.services.join(', ')}`)
    lines.push('')
  }
  
  if (digest.errors.length > 0) {
    lines.push(`**${t('memory.errors')}**:`)
    digest.errors.forEach(e => lines.push(`  • ${e}`))
    lines.push('')
  }
  
  if (digest.keyFindings.length > 0) {
    lines.push(`**${t('memory.key_findings')}**:`)
    digest.keyFindings.forEach(f => lines.push(`  • ${f}`))
  }
  
  const output = lines.join('\n')
  
  // 记录工具结果
  executor.addStep({
    type: 'tool_result',
    content: t('memory.task_recalled', { taskId }),
    toolName: 'recall_task',
    toolResult: output
  })
  
  return { success: true, output }
}

/**
 * deep_recall: 获取任务的完整执行步骤
 */
export function deepRecall(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig,
  _ptyId: string
): ToolResult {
  const taskId = args.task_id as string
  const stepIndex = args.step_index as number | undefined
  const memoryStore = executor.getTaskMemory()
  
  // 记录工具调用
  const callContent = stepIndex !== undefined 
    ? t('memory.deep_recalling_step', { taskId, stepIndex })
    : taskId 
      ? t('memory.deep_recalling_task', { taskId })
      : t('memory.listing_tasks')
  
  executor.addStep({
    type: 'tool_call',
    content: callContent,
    toolName: 'deep_recall',
    toolArgs: args,
    riskLevel: 'safe'
  })
  
  if (!taskId) {
    const summaries = memoryStore.getSummaries(20)
    if (summaries.length === 0) {
      const error = t('memory.task_id_required') + '\n\n' + t('memory.no_task_history')
      executor.addStep({
        type: 'tool_result',
        content: error,
        toolName: 'deep_recall',
        toolResult: error
      })
      return { success: false, output: '', error }
    }
    const availableIds = summaries.map(s => `- [${s.id}] ${s.summary}`).join('\n')
    const error = t('memory.task_id_required') + '\n\n' + t('memory.available_task_ids') + '\n' + availableIds
    executor.addStep({
      type: 'tool_result',
      content: t('memory.available_task_ids'),
      toolName: 'deep_recall',
      toolResult: availableIds
    })
    return { success: false, output: '', error }
  }
  
  const result = memoryStore.getFullSteps(taskId, stepIndex)
  
  if (!result) {
    if (stepIndex !== undefined) {
      const error = t('memory.step_not_found', { taskId, stepIndex })
      executor.addStep({
        type: 'tool_result',
        content: error,
        toolName: 'deep_recall',
        toolResult: error
      })
      return { 
        success: false, 
        output: '', 
        error
      }
    }
    const summaries = memoryStore.getSummaries(20)
    if (summaries.length === 0) {
      const error = t('memory.task_not_found', { taskId }) + '\n\n' + t('memory.no_task_history')
      executor.addStep({
        type: 'tool_result',
        content: error,
        toolName: 'deep_recall',
        toolResult: error
      })
      return { 
        success: false, 
        output: '', 
        error
      }
    }
    const availableIds = summaries.map(s => `- [${s.id}] ${s.summary}`).join('\n')
    const error = t('memory.task_not_found', { taskId }) + '\n\n' + t('memory.available_task_ids') + '\n' + availableIds
    executor.addStep({
      type: 'tool_result',
      content: t('memory.task_not_found', { taskId }),
      toolName: 'deep_recall',
      toolResult: availableIds
    })
    return { 
      success: false, 
      output: '', 
      error
    }
  }
  
  // 如果是单个步骤
  if (!Array.isArray(result)) {
    const step = result
    const lines: string[] = [
      `📋 **${t('memory.deep_recall')}**: ${taskId} - ${t('memory.step')} ${stepIndex}`,
      '',
      `**${t('memory.step_type')}**: ${step.type}`,
    ]
    
    if (step.toolName) {
      lines.push(`**${t('memory.tool_name')}**: ${step.toolName}`)
    }
    
    if (step.toolArgs) {
      lines.push(`**${t('memory.tool_args')}**:`)
      lines.push('```json')
      lines.push(JSON.stringify(step.toolArgs, null, 2))
      lines.push('```')
    }
    
    if (step.content) {
      lines.push(`**${t('memory.content')}**:`)
      lines.push(step.content)
    }
    
    if (step.toolResult) {
      lines.push(`**${t('memory.tool_result')}**:`)
      lines.push('```')
      lines.push(step.toolResult)
      lines.push('```')
    }
    
    const output = lines.join('\n')
    
    // 记录工具结果
    executor.addStep({
      type: 'tool_result',
      content: t('memory.step_recalled', { taskId, stepIndex }),
      toolName: 'deep_recall',
      toolResult: output
    })
    
    return { success: true, output }
  }
  
  // 返回所有步骤的概览
  const steps = result
  const lines: string[] = [
    `📋 **${t('memory.deep_recall')}**: ${taskId}`,
    `**${t('memory.total_steps')}**: ${steps.length}`,
    ''
  ]
  
  steps.forEach((step, idx) => {
    let stepSummary = `${idx}. [${step.type}]`
    if (step.toolName) {
      stepSummary += ` ${step.toolName}`
      if (step.toolArgs?.command) {
        const cmd = String(step.toolArgs.command)
        stepSummary += `: ${cmd.length > 60 ? cmd.substring(0, 60) + '...' : cmd}`
      }
    } else if (step.content) {
      stepSummary += `: ${step.content.substring(0, 60)}${step.content.length > 60 ? '...' : ''}`
    }
    lines.push(stepSummary)
  })
  
  lines.push('')
  lines.push(t('memory.deep_recall_hint'))
  
  const output = lines.join('\n')
  
  // 记录工具结果
  executor.addStep({
    type: 'tool_result',
    content: t('memory.task_steps_recalled', { taskId, count: steps.length }),
    toolName: 'deep_recall',
    toolResult: output
  })
  
  return { success: true, output }
}

/**
 * 搜索历史对话记录（跨会话）
 */
export async function searchHistory(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const keyword = typeof args.keyword === 'string' ? args.keyword.slice(0, 200).trim() : ''
  const limitRaw = typeof args.limit === 'number' ? args.limit : 10
  const limit = Math.min(Math.max(1, limitRaw), 30)
  const detail = args.detail === 'full' ? 'full' : 'summary'
  const startDate = typeof args.start_date === 'string' ? args.start_date.trim() : ''
  const endDate = typeof args.end_date === 'string' ? args.end_date.trim() : ''

  if (!keyword && !startDate && !endDate) {
    return { success: false, output: '', error: '请至少提供 keyword、start_date、end_date 其中之一' }
  }

  const startDateError = validateDateInput(startDate, 'start_date')
  if (startDateError) return { success: false, output: '', error: startDateError }
  const endDateError = validateDateInput(endDate, 'end_date')
  if (endDateError) return { success: false, output: '', error: endDateError }
  const startDateMs = startDate ? parseDateInputToMs(startDate) : undefined
  const endDateMs = endDate ? parseDateInputToMs(endDate) : undefined
  if (startDateMs !== undefined && endDateMs !== undefined && startDateMs > endDateMs) {
    return { success: false, output: '', error: 'start_date 不能晚于 end_date' }
  }

  executor.addStep({
    type: 'tool_call',
    content: `搜索历史对话: "${keyword || '(无关键词，仅时间过滤)'}" (${detail}${startDate || endDate ? `, ${startDate || '-'} ~ ${endDate || '-'}` : ''})`,
    toolName: 'search_history',
    toolArgs: args,
    riskLevel: 'safe'
  })

  const historyService = executor.historyService
  if (!historyService) {
    executor.addStep({
      type: 'tool_result',
      content: '历史服务不可用',
      toolName: 'search_history'
    })
    return { success: false, output: '', error: '历史服务不可用' }
  }

  try {
    const searchResult = historyService.searchAgentRecordsAdvanced({
      keyword,
      limit,
      startDate: startDate || undefined,
      endDate: endDate || undefined
    })
    const records = searchResult.records

    if (records.length === 0) {
      const noResultLabel = keyword
        ? `未找到包含"${keyword}"的历史记录`
        : `在指定时间范围内未找到历史记录`
      executor.addStep({
        type: 'tool_result',
        content: noResultLabel,
        toolName: 'search_history'
      })
      return { success: true, output: noResultLabel }
    }

    const formatted = records.map((r, i) => {
      const date = new Date(r.timestamp || 0).toLocaleString('zh-CN')
      const statusIcon = r.status === 'completed' ? '✅' : r.status === 'failed' ? '❌' : '⚠️'
      const task = r.userTask || '(无任务描述)'
      const result = r.finalResult
        ? (r.finalResult.length > 300 ? r.finalResult.substring(0, 300) + '...' : r.finalResult)
        : '(无结果)'

      const lines = [`### ${i + 1}. ${statusIcon} ${date}`, `**任务**: ${task}`]

      if (r.steps?.length > 0) {
        const supplements = r.steps.filter(s => s.type === 'user_supplement' && s.content)
        if (supplements.length > 0) {
          lines.push('**用户追加**:')
          for (const s of supplements) {
            const msg = s.content.length > 150 ? s.content.substring(0, 150) + '...' : s.content
            lines.push(`- ${msg}`)
          }
        }
      }

      lines.push(`**结果**: ${result}`)

      if (detail === 'full' && r.steps?.length > 0) {
        lines.push('', '**工具调用**:')
        const toolSteps = r.steps.filter(s => s.type === 'tool_call' && s.toolName)
        for (const step of toolSteps) {
          let entry = `- \`${step.toolName}\``
          if (step.toolArgs?.command) {
            const cmd = String(step.toolArgs.command)
            entry += `: ${cmd.length > 80 ? cmd.substring(0, 80) + '...' : cmd}`
          } else if (step.toolArgs?.path || step.toolArgs?.file_path) {
            entry += `: ${step.toolArgs.path || step.toolArgs.file_path}`
          }
          lines.push(entry)
        }
        if (toolSteps.length === 0) {
          lines.push('- (无工具调用记录)')
        }
      }

      return lines.join('\n')
    }).join('\n\n')

    const rangeLine = startDate || endDate
      ? `时间范围: ${startDate || '(最早)'} ~ ${endDate || '(最新)'}\n`
      : ''
    const moreHint = searchResult.hasMore
      ? `\n\n⚠️ 当前仅返回前 ${records.length} 条（总命中 ${searchResult.totalMatched} 条）。可缩小时间范围、提高关键词精度，或调大 limit 后重试。`
      : ''
    const output = `找到 ${records.length} 条相关历史记录（总命中 ${searchResult.totalMatched} 条）：\n${rangeLine}\n${formatted}${moreHint}`

    const displayOutput = output.length > 500
      ? truncateFromEnd(output, 500)
      : output

    executor.addStep({
      type: 'tool_result',
      content: `找到 ${records.length}/${searchResult.totalMatched} 条历史记录 (${detail})${searchResult.hasMore ? '，还有更多' : ''}`,
      toolName: 'search_history',
      toolResult: displayOutput
    })

    return { success: true, output }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : '搜索失败'
    executor.addStep({
      type: 'tool_result',
      content: `历史搜索失败: ${errorMsg}`,
      toolName: 'search_history'
    })
    return { success: false, output: '', error: errorMsg }
  }
}

function validateDateInput(value: string, field: 'start_date' | 'end_date'): string | null {
  if (!value) return null

  const parsed = parseDateInputToMs(value, 'start')
  if (parsed === undefined) {
    return `${field} 格式无效，请使用 YYYY-MM-DD、YYYY-MM-DD HH、YYYY-MM-DD HH:mm 或带时区的 ISO 时间`
  }
  return null
}

function parseDateInputToMs(value: string, boundary: 'start' | 'end' = 'start'): number | undefined {
  if (!value) return undefined
  const text = value.trim()
  if (!text) return undefined

  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (dateMatch) {
    const [_, y, m, d] = dateMatch
    return createLocalDateMs(
      Number(y),
      Number(m),
      Number(d),
      boundary === 'start' ? 0 : 23,
      boundary === 'start' ? 0 : 59,
      boundary === 'start' ? 0 : 59,
      boundary === 'start' ? 0 : 999
    )
  }

  const hourMatch = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2})$/.exec(text)
  if (hourMatch) {
    const [_, y, m, d, hh] = hourMatch
    return createLocalDateMs(
      Number(y),
      Number(m),
      Number(d),
      Number(hh),
      boundary === 'start' ? 0 : 59,
      boundary === 'start' ? 0 : 59,
      boundary === 'start' ? 0 : 999
    )
  }

  const minuteMatch = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(text)
  if (minuteMatch) {
    const [_, y, m, d, hh, mm] = minuteMatch
    return createLocalDateMs(
      Number(y),
      Number(m),
      Number(d),
      Number(hh),
      Number(mm),
      boundary === 'start' ? 0 : 59,
      boundary === 'start' ? 0 : 999
    )
  }

  // ISO 时间仅接受带时区的形式，避免环境相关歧义
  if (/T/.test(text) && (/[zZ]$/.test(text) || /[+-]\d{2}:\d{2}$/.test(text))) {
    const parsed = new Date(text)
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.getTime()
  }

  return undefined
}

function createLocalDateMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  millisecond: number
): number | undefined {
  const date = new Date(year, month - 1, day, hour, minute, second, millisecond)
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day ||
    date.getHours() !== hour ||
    date.getMinutes() !== minute ||
    date.getSeconds() !== second ||
    date.getMilliseconds() !== millisecond
  ) {
    return undefined
  }
  return date.getTime()
}
