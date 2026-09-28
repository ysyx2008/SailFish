/**
 * 上下文管理工具
 * 包括：context（查看用量 / 压缩当前对话）、归档取回实现（经 recall 入口）、manage_memory（跨任务记忆管理）
 */
import { t } from '../i18n'
import type { ToolExecutorConfig, ToolResult } from './types'
import type { CompressionLevel } from '../context-builder'
import type { AgentStep } from '@shared/types'
import type { CompressResult } from '../context-window'

type CompactStepSink = {
  addStep: (step: Partial<AgentStep>) => AgentStep
  updateStep: (stepId: string, updates: Partial<AgentStep>) => void
  removeStep: (stepId: string) => void
}

export function userCompactRequest(hint?: string): string {
  const title = t('agent.compact_tool_step')
  const extra = hint?.trim()
  return extra ? `${title}：${extra}` : title
}

export function beginUserCompactTurn(sink: CompactStepSink, hint?: string): {
  userTaskId: string
  userRequest: string
  thinkingId: string
  toolStepId: string
} {
  const userRequest = userCompactRequest(hint)
  const userTask = sink.addStep({
    type: 'user_task',
    content: userRequest
  })
  const ids = beginUserCompactSteps(sink, hint)
  return { userTaskId: userTask.id, userRequest, ...ids }
}

export function cancelUserCompactTurn(
  sink: CompactStepSink,
  ids: { userTaskId: string; thinkingId: string; toolStepId: string }
): void {
  sink.removeStep(ids.thinkingId)
  sink.removeStep(ids.toolStepId)
  sink.removeStep(ids.userTaskId)
}

export function beginUserCompactSteps(sink: CompactStepSink, hint?: string): {
  thinkingId: string
  toolStepId: string
} {
  const thinking = sink.addStep({
    type: 'thinking',
    content: t('agent.compact_in_progress'),
    isStreaming: true
  })
  const toolCallId = `compact_tool_${Date.now()}`
  const tool = sink.addStep({
    id: toolCallId,
    type: 'tool_call',
    content: t('agent.compact_tool_step'),
    toolName: 'compress_context',
    toolCallId,
    toolArgs: hint ? { user_hint: hint } : {},
    riskLevel: 'safe'
  })
  return { thinkingId: thinking.id, toolStepId: tool.id }
}

export function finishUserCompactSteps(
  sink: CompactStepSink,
  ids: { thinkingId: string; toolStepId: string },
  result: CompressResult
): void {
  sink.removeStep(ids.thinkingId)
  const output = t('context_tool.compress_success', {
    before: result.beforeTokens.toLocaleString(),
    after: result.afterTokens.toLocaleString(),
    freed: result.freedTokens.toLocaleString(),
    archiveId: result.archiveId
  })
  sink.updateStep(ids.toolStepId, {
    success: true,
    toolResult: output
  })
  sink.addStep({
    type: 'tool_result',
    content: output,
    toolName: 'compress_context',
    toolCallId: ids.toolStepId,
    toolResult: output,
    success: true
  })
}

export function failUserCompactSteps(
  sink: CompactStepSink,
  ids: { thinkingId: string; toolStepId: string },
  message: string
): void {
  sink.removeStep(ids.thinkingId)
  sink.updateStep(ids.toolStepId, {
    success: false,
    toolResult: message
  })
  sink.addStep({
    type: 'tool_result',
    content: message,
    toolName: 'compress_context',
    toolCallId: ids.toolStepId,
    toolResult: message,
    success: false
  })
}

export function finishUserCompactTurn(
  sink: CompactStepSink,
  ids: { thinkingId: string; toolStepId: string },
  result: CompressResult
): string {
  finishUserCompactSteps(sink, ids, result)
  const output = t('context_tool.compress_success', {
    before: result.beforeTokens.toLocaleString(),
    after: result.afterTokens.toLocaleString(),
    freed: result.freedTokens.toLocaleString(),
    archiveId: result.archiveId
  })
  sink.addStep({
    type: 'final_result',
    content: output
  })
  return output
}

export function failUserCompactTurn(
  sink: CompactStepSink,
  ids: { thinkingId: string; toolStepId: string },
  message: string
): string {
  failUserCompactSteps(sink, ids, message)
  const result = `❌ ${message}`
  sink.addStep({
    type: 'final_result',
    content: result
  })
  return result
}

export function resolveContextAction(args: Record<string, unknown>): 'check' | 'compress' | string {
  const action = typeof args.action === 'string' ? args.action.trim().toLowerCase() : ''
  const summary = typeof args.summary === 'string' ? args.summary.trim() : ''
  if (action === 'compress' || (action === '' && summary)) return 'compress'
  if (action === 'check' || action === '') return 'check'
  return action
}

/**
 * context：查看用量或压缩较早过程。
 * check 只报数，不附带「该压缩了」「还很宽裕」之类的判断——怎么应对由模型自己定。
 */
export async function dispatchContext(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const resolved = resolveContextAction(args)
  if (resolved === 'compress') return compressContext(args, executor)
  if (resolved === 'check') {
    return checkContext(executor)
  }
  const error = t('context_tool.unknown_action', { action: resolved })
  executor.addStep({
    type: 'tool_call',
    content: t('context_tool.unknown_step'),
    toolName: 'context',
    toolArgs: args,
    riskLevel: 'safe'
  })
  executor.addStep({
    type: 'tool_result',
    content: error,
    toolName: 'context',
    toolResult: error
  })
  return { success: false, output: '', error }
}

/**
 * check_context: 查询当前上下文用量
 *
 * 只报数，不附带"该压缩了""还很宽裕"之类的判断——怎么应对由模型自己定。
 */
export function checkContext(executor: ToolExecutorConfig): ToolResult {
  executor.addStep({
    type: 'tool_call',
    content: t('context_tool.check_step'),
    toolName: 'context',
    toolArgs: { action: 'check' },
    riskLevel: 'safe'
  })

  if (!executor.getContextUsage) {
    const error = 'context check is not available in this context'
    executor.addStep({
      type: 'tool_result',
      content: error,
      toolName: 'context',
      toolResult: error
    })
    return { success: false, output: '', error }
  }

  const usage = executor.getContextUsage()
  const output = t('context_tool.check_result', {
    used: usage.used.toLocaleString(),
    total: usage.total.toLocaleString(),
    remaining: usage.remaining.toLocaleString(),
    percent: usage.total > 0 ? Math.round((usage.used / usage.total) * 100) : 0
  })

  executor.addStep({
    type: 'tool_result',
    content: output,
    toolName: 'context',
    toolResult: output
  })

  return { success: true, output }
}

/**
 * 和人按「压缩上下文」同一套交接。summary 只是要重点留下的补充，正文由交接自己写。
 */
export async function compressContext(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const hint = typeof args.summary === 'string' ? args.summary.trim() : ''

  executor.addStep({
    type: 'tool_call',
    content: t('agent.compact_tool_step'),
    toolName: 'context',
    toolArgs: args,
    riskLevel: 'safe'
  })

  if (!executor.compressCurrentContext) {
    const error = 'context compress is not available in this context'
    executor.addStep({
      type: 'tool_result',
      content: error,
      toolName: 'context',
      toolResult: error
    })
    return { success: false, output: '', error }
  }

  const result = await executor.compressCurrentContext(hint || undefined)

  if (!result) {
    const msg = t('context_tool.compress_nothing')
    executor.addStep({
      type: 'tool_result',
      content: msg,
      toolName: 'context',
      toolResult: msg
    })
    return { success: false, output: '', error: msg }
  }

  const output = t('context_tool.compress_success', {
    before: result.beforeTokens.toLocaleString(),
    after: result.afterTokens.toLocaleString(),
    freed: result.freedTokens.toLocaleString(),
    archiveId: result.archiveId
  })

  executor.addStep({
    type: 'tool_result',
    content: output,
    toolName: 'context',
    toolResult: output
  })

  return { success: true, output }
}

/**
 * 取回压缩归档的原始消息（经 recall(archive_id) 或旧名 recall_compressed）
 */
export function recallCompressed(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): ToolResult {
  const archiveId = args.archive_id as string | undefined

  executor.addStep({
    type: 'tool_call',
    content: archiveId
      ? t('context_tool.recall_step', { archiveId })
      : t('context_tool.recall_list'),
    toolName: 'recall',
    toolArgs: args,
    riskLevel: 'safe'
  })

  // 列出所有归档
  if (!archiveId) {
    if (!executor.getCompressedArchives) {
      const msg = t('context_tool.recall_empty')
      executor.addStep({
        type: 'tool_result',
        content: msg,
        toolName: 'recall',
        toolResult: msg
      })
      return { success: true, output: msg }
    }

    const archives = executor.getCompressedArchives()
    if (archives.length === 0) {
      const msg = t('context_tool.recall_empty')
      executor.addStep({
        type: 'tool_result',
        content: msg,
        toolName: 'recall',
        toolResult: msg
      })
      return { success: true, output: msg }
    }

    const lines = [t('context_tool.recall_list'), '']
    for (const arc of archives) {
      lines.push(`- **${arc.id}**: ${arc.summary} (${arc.messageCount} messages)`)
    }
    const output = lines.join('\n')

    executor.addStep({
      type: 'tool_result',
      content: t('context_tool.recall_list'),
      toolName: 'recall',
      toolResult: output
    })

    return { success: true, output }
  }

  // 查看指定归档
  if (!executor.getCompressedArchive) {
    const msg = t('context_tool.recall_not_found', { archiveId })
    executor.addStep({
      type: 'tool_result',
      content: msg,
      toolName: 'recall',
      toolResult: msg
    })
    return { success: false, output: '', error: msg }
  }

  const messages = executor.getCompressedArchive(archiveId)
  if (!messages) {
    const msg = t('context_tool.recall_not_found', { archiveId })
    executor.addStep({
      type: 'tool_result',
      content: msg,
      toolName: 'recall',
      toolResult: msg
    })
    return { success: false, output: '', error: msg }
  }

  // 格式化归档消息为可读文本
  const lines: string[] = [`📋 **Compressed Archive: ${archiveId}**`, `**Messages**: ${messages.length}`, '']

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    const roleLabel = msg.role === 'assistant' ? '🤖 Assistant' : msg.role === 'tool' ? '🔧 Tool' : `📝 ${msg.role}`
    lines.push(`### ${i}. ${roleLabel}`)

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      for (const tc of msg.tool_calls) {
        lines.push(`**Tool Call**: ${tc.function.name}`)
        const argsStr = tc.function.arguments
        if (argsStr && argsStr.length <= 200) {
          lines.push(`**Args**: ${argsStr}`)
        } else if (argsStr) {
          lines.push(`**Args**: ${argsStr.substring(0, 200)}...`)
        }
      }
    }

    if (msg.content) {
      const content = msg.content.length > 500
        ? msg.content.substring(0, 500) + `\n... [truncated, total ${msg.content.length} chars]`
        : msg.content
      lines.push(content)
    }

    if (msg.tool_call_id) {
      lines.push(`*(tool_call_id: ${msg.tool_call_id})*`)
    }

    lines.push('')
  }

  const output = lines.join('\n')

  executor.addStep({
    type: 'tool_result',
    content: t('context_tool.recall_step', { archiveId }),
    toolName: 'recall',
    toolResult: output
  })

  return { success: true, output }
}

/**
 * manage_memory: 管理会话记忆（跨任务压缩级别建议 + 丢弃）
 */
export function manageMemory(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): ToolResult {
  const suggestions = args.suggestions as Array<{ task_id: string; level: number; reason?: string }> | undefined
  const discardList = args.discard as string[] | undefined

  executor.addStep({
    type: 'tool_call',
    content: t('context_tool.manage_step'),
    toolName: 'manage_memory',
    toolArgs: args,
    riskLevel: 'safe'
  })

  const memoryStore = executor.getTaskMemory()
  const results: string[] = []
  let updatedCount = 0
  let discardedCount = 0

  // 处理压缩级别建议
  if (suggestions && Array.isArray(suggestions)) {
    for (const suggestion of suggestions) {
      const { task_id, level, reason } = suggestion
      if (!task_id || level === undefined) continue

      const validLevel = Math.max(0, Math.min(4, Math.round(level))) as CompressionLevel
      const success = memoryStore.updateSuggestedLevel(task_id, validLevel)

      if (success) {
        updatedCount++
        const msg = t('context_tool.manage_level_updated', { taskId: task_id, level: validLevel })
        results.push(`✓ ${msg}${reason ? ` (${reason})` : ''}`)
      } else {
        results.push(`✗ ${t('context_tool.manage_task_not_found', { taskId: task_id })}`)
      }
    }
  }

  // 处理丢弃
  if (discardList && Array.isArray(discardList)) {
    for (const taskId of discardList) {
      const success = memoryStore.removeTask(taskId)
      if (success) {
        discardedCount++
        results.push(`✓ ${t('context_tool.manage_task_discarded', { taskId })}`)
      } else {
        results.push(`✗ ${t('context_tool.manage_task_not_found', { taskId })}`)
      }
    }
  }

  // 构建输出
  const outputLines: string[] = []
  if (updatedCount > 0) {
    outputLines.push(t('context_tool.manage_updated', { count: updatedCount }))
  }
  if (discardedCount > 0) {
    outputLines.push(t('context_tool.manage_discarded', { count: discardedCount }))
  }
  if (results.length > 0) {
    outputLines.push('')
    outputLines.push(...results)
  }
  if (outputLines.length === 0) {
    outputLines.push('No changes made')
  }

  const output = outputLines.join('\n')

  executor.addStep({
    type: 'tool_result',
    content: output,
    toolName: 'manage_memory',
    toolResult: output
  })

  return { success: true, output }
}
