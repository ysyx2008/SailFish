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

function compressCounts(result: CompressResult): { before: string; after: string; freed: string } {
  return {
    before: result.beforeTokens.toLocaleString(),
    after: result.afterTokens.toLocaleString(),
    freed: result.freedTokens.toLocaleString(),
  }
}

function compressLineForUser(result: CompressResult): string {
  return t('context_tool.compress_done', compressCounts(result))
}

function compressLineForModel(result: CompressResult): string {
  return t('context_tool.compress_success', {
    ...compressCounts(result),
    archiveId: result.archiveId,
  })
}

export function archiveLineForModel(arc: { id: string; summary: string; messageCount: number }): string {
  return `- **${arc.id}**: ${arc.summary} (${arc.messageCount} messages)`
}

export function archiveLineForUser(arc: { summary: string; messageCount: number }): string {
  const name = arc.summary.trim()
  const text = name
    ? t('context_tool.archive_item', { summary: name, count: arc.messageCount })
    : t('context_tool.archive_unnamed', { count: arc.messageCount })
  return `- ${text}`
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
  const shown = compressLineForUser(result)
  sink.updateStep(ids.toolStepId, {
    success: true,
    toolResult: shown
  })
  sink.addStep({
    type: 'tool_result',
    content: shown,
    toolName: 'compress_context',
    toolCallId: ids.toolStepId,
    toolResult: shown,
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
  const shown = compressLineForUser(result)
  sink.addStep({
    type: 'final_result',
    content: shown
  })
  return shown
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

  const output = compressLineForModel(result)
  const shown = compressLineForUser(result)

  executor.addStep({
    type: 'tool_result',
    content: shown,
    toolName: 'context',
    toolResult: shown
  })

  return { success: true, output }
}

/** 整份归档一览时每条内容、每个工具入参露出的开头字数；要全文用 message_index 单取 */
const ARCHIVE_PREVIEW_CONTENT_CHARS = 500
const ARCHIVE_PREVIEW_ARGS_CHARS = 200
/** 单取一条时每次给出的字数；更长的用 offset 接着读 */
const ARCHIVE_MESSAGE_PAGE_CHARS = 20_000

type ArchivedMessage = import('../../ai.service').AiMessage

/** 没给 → undefined；给了但不是非负整数 → null（调用方报错，不悄悄当成 0） */
function parseIndexArg(value: unknown): number | undefined | null {
  if (value === undefined || value === null || value === '') return undefined
  const n = typeof value === 'string' ? Number(value.trim()) : value
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) return null
  return n
}

function roleLabelOf(msg: ArchivedMessage): string {
  return msg.role === 'assistant' ? '🤖 Assistant' : msg.role === 'tool' ? '🔧 Tool' : `📝 ${msg.role}`
}

function renderMessagePreview(
  msg: ArchivedMessage,
  index: number,
  archiveId: string,
  pushBoth: (line: string) => void,
  pushModelOnly: (line: string) => void
): void {
  pushBoth(`### ${index}. ${roleLabelOf(msg)}`)
  let cut = false

  for (const tc of msg.tool_calls ?? []) {
    pushBoth(`**Tool Call**: ${tc.function.name}`)
    const argsStr = tc.function.arguments
    if (!argsStr) continue
    if (argsStr.length <= ARCHIVE_PREVIEW_ARGS_CHARS) {
      pushBoth(`**Args**: ${argsStr}`)
    } else {
      cut = true
      pushBoth(`**Args**: ${argsStr.substring(0, ARCHIVE_PREVIEW_ARGS_CHARS)}... [Args total ${argsStr.length} chars]`)
    }
  }

  if (msg.content) {
    if (msg.content.length > ARCHIVE_PREVIEW_CONTENT_CHARS) {
      cut = true
      pushBoth(msg.content.substring(0, ARCHIVE_PREVIEW_CONTENT_CHARS))
      pushBoth(`... [content total ${msg.content.length} chars]`)
    } else {
      pushBoth(msg.content)
    }
  }

  if (cut) pushBoth(`(only the beginning is shown; full text: recall(archive_id: "${archiveId}", message_index: ${index}))`)
  if (msg.tool_call_id) pushModelOnly(`*(tool_call_id: ${msg.tool_call_id})*`)
  pushBoth('')
}

/** 单取一条时的全文：工具调用（含完整入参）在前，正文在后 */
function archivedMessageBody(msg: ArchivedMessage): string {
  const parts: string[] = []
  for (const tc of msg.tool_calls ?? []) {
    parts.push(`**Tool Call**: ${tc.function.name}`)
    if (tc.function.arguments) parts.push(`**Args**: ${tc.function.arguments}`)
  }
  if (msg.content) parts.push(msg.content)
  return parts.join('\n')
}

function renderMessageFull(
  msg: ArchivedMessage,
  index: number,
  archiveId: string,
  offset: number,
  pushBoth: (line: string) => void,
  pushModelOnly: (line: string) => void
): void {
  pushBoth(`### ${index}. ${roleLabelOf(msg)}`)
  const body = archivedMessageBody(msg)

  const page = body.slice(offset, offset + ARCHIVE_MESSAGE_PAGE_CHARS)
  pushBoth(page)
  const end = offset + page.length
  if (offset > 0 || end < body.length) {
    pushBoth(`... [chars ${offset}–${end} of ${body.length}]`)
  }
  if (end < body.length) {
    pushBoth(`(continue: recall(archive_id: "${archiveId}", message_index: ${index}, offset: ${end}))`)
  }
  if (msg.tool_call_id) pushModelOnly(`*(tool_call_id: ${msg.tool_call_id})*`)
  pushBoth('')
}

/**
 * 取回压缩归档的原始消息（经 recall(archive_id) 或旧名 recall_compressed）。
 * 归档里存的是完整原文；整份一览只露每条的开头，message_index 单取一条给全文。
 */
export function recallCompressed(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): ToolResult {
  const archiveId = args.archive_id as string | undefined

  executor.addStep({
    type: 'tool_call',
    content: archiveId
      ? t('context_tool.recall_step')
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

    const modelLines = [t('context_tool.recall_list'), '']
    const userLines = [t('context_tool.recall_list'), '']
    for (const arc of archives) {
      modelLines.push(archiveLineForModel(arc))
      userLines.push(archiveLineForUser(arc))
    }
    const output = modelLines.join('\n')

    executor.addStep({
      type: 'tool_result',
      content: t('context_tool.recall_list'),
      toolName: 'recall',
      toolResult: userLines.join('\n')
    })

    return { success: true, output }
  }

  // 查看指定归档
  if (!executor.getCompressedArchive) {
    const shown = t('context_tool.recall_missing')
    const error = t('context_tool.recall_not_found', { archiveId })
    executor.addStep({
      type: 'tool_result',
      content: shown,
      toolName: 'recall',
      toolResult: shown
    })
    return { success: false, output: '', error }
  }

  const messages = executor.getCompressedArchive(archiveId)
  if (!messages) {
    const shown = t('context_tool.recall_missing')
    const error = t('context_tool.recall_not_found', { archiveId })
    executor.addStep({
      type: 'tool_result',
      content: shown,
      toolName: 'recall',
      toolResult: shown
    })
    return { success: false, output: '', error }
  }

  const modelLines: string[] = [`📋 **Compressed Archive: ${archiveId}**`]
  const userLines: string[] = [`📋 **${t('context_tool.recall_body')}**`]
  const pushBoth = (line: string) => {
    modelLines.push(line)
    userLines.push(line)
  }

  const refuse = (error: string): ToolResult => {
    executor.addStep({ type: 'tool_result', content: error, toolName: 'recall', toolResult: error })
    return { success: false, output: '', error }
  }
  const messageIndex = parseIndexArg(args.message_index)
  const offsetArg = parseIndexArg(args.offset)
  if (messageIndex === null) return refuse(t('context_tool.recall_arg_invalid', { name: 'message_index', value: String(args.message_index) }))
  if (offsetArg === null) return refuse(t('context_tool.recall_arg_invalid', { name: 'offset', value: String(args.offset) }))
  if (messageIndex !== undefined) {
    const msg = messages[messageIndex]
    if (!msg) {
      return refuse(t('context_tool.recall_index_out_of_range', { archiveId, count: messages.length, index: messageIndex }))
    }
    const offset = offsetArg ?? 0
    const length = archivedMessageBody(msg).length
    if (offset > 0 && offset >= length) {
      return refuse(t('context_tool.recall_offset_out_of_range', { index: messageIndex, length, offset }))
    }
    pushBoth(`**Message ${messageIndex} / ${messages.length}**`)
    pushBoth('')
    renderMessageFull(msg, messageIndex, archiveId, offset, pushBoth, line => modelLines.push(line))
  } else {
    pushBoth(`**Messages**: ${messages.length}`)
    pushBoth('')
    for (let i = 0; i < messages.length; i++) {
      renderMessagePreview(messages[i], i, archiveId, pushBoth, line => modelLines.push(line))
    }
  }

  const output = modelLines.join('\n')

  executor.addStep({
    type: 'tool_result',
    content: t('context_tool.recall_step'),
    toolName: 'recall',
    toolResult: userLines.join('\n')
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
  let missedCount = 0

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
        missedCount++
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
        missedCount++
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
    outputLines.push(t('context_tool.manage_none'))
  }

  const output = outputLines.join('\n')
  const shownLines: string[] = []
  if (updatedCount > 0) shownLines.push(t('context_tool.manage_updated', { count: updatedCount }))
  if (discardedCount > 0) shownLines.push(t('context_tool.manage_discarded', { count: discardedCount }))
  if (missedCount > 0) shownLines.push(t('context_tool.manage_missed', { count: missedCount }))
  if (shownLines.length === 0) shownLines.push(t('context_tool.manage_none'))
  const shown = shownLines.join('\n')

  executor.addStep({
    type: 'tool_result',
    content: shown,
    toolName: 'manage_memory',
    toolResult: shown
  })

  return { success: true, output }
}
