/**
 * 上下文管理工具
 * 包括：compress_context（压缩当前对话）、recall_compressed（找回归档）、manage_memory（跨任务记忆管理）
 */
import { t } from '../i18n'
import type { ToolExecutorConfig, ToolResult } from './types'
import type { CompressionLevel } from '../context-builder'

/**
 * compress_context: 压缩当前对话中较早的工具调用和结果
 */
export function compressContext(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): ToolResult {
  const summary = args.summary as string
  const keepRecent = (args.keep_recent as number) || 4

  if (!summary) {
    return { success: false, output: '', error: 'Parameter "summary" is required' }
  }

  executor.addStep({
    type: 'tool_call',
    content: t('context_tool.compress_step', { keepRecent }),
    toolName: 'compress_context',
    toolArgs: args,
    riskLevel: 'safe'
  })

  if (!executor.compressCurrentContext) {
    const error = 'compress_context is not available in this context'
    executor.addStep({
      type: 'tool_result',
      content: error,
      toolName: 'compress_context',
      toolResult: error
    })
    return { success: false, output: '', error }
  }

  const result = executor.compressCurrentContext(summary, keepRecent)

  if (!result) {
    const msg = t('context_tool.compress_nothing')
    executor.addStep({
      type: 'tool_result',
      content: msg,
      toolName: 'compress_context',
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
    toolName: 'compress_context',
    toolResult: output
  })

  return { success: true, output }
}

/**
 * recall_compressed: 找回被压缩归档的原始消息
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
    toolName: 'recall_compressed',
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
        toolName: 'recall_compressed',
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
        toolName: 'recall_compressed',
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
      toolName: 'recall_compressed',
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
      toolName: 'recall_compressed',
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
      toolName: 'recall_compressed',
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
    toolName: 'recall_compressed',
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
