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

  if (!keyword) {
    return { success: false, output: '', error: '缺少 keyword 参数' }
  }

  executor.addStep({
    type: 'tool_call',
    content: `搜索历史对话: "${keyword}" (${detail})`,
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
    const records = historyService.searchAgentRecords(keyword, limit)

    if (records.length === 0) {
      executor.addStep({
        type: 'tool_result',
        content: `未找到包含"${keyword}"的历史记录`,
        toolName: 'search_history'
      })
      return { success: true, output: `未找到包含"${keyword}"的历史记录` }
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

    const output = `找到 ${records.length} 条相关历史记录：\n\n${formatted}`

    const displayOutput = output.length > 500
      ? truncateFromEnd(output, 500)
      : output

    executor.addStep({
      type: 'tool_result',
      content: `找到 ${records.length} 条历史记录 (${detail})`,
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
