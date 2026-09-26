/**
 * 其他工具
 * 包括：等待、向用户提问、MCP 工具、技能工具
 */
import { clampAskUserTimeout } from '@shared/types/agent'
import { t } from '../i18n'
import { createLogger } from '../../../utils/logger'
const log = createLogger('tools/misc')
import { executeExcelTool } from '../skills/excel/executor'
import { executeEmailTool } from '../skills/email/executor'
import { executeBrowserTool } from '../skills/browser/executor'
import { executeWordTool } from '../skills/word/executor'
import { executeCalendarTool } from '../skills/calendar/executor'
import { executeTodoTool } from '../skills/todo/executor'
import { executeWatchTool } from '../skills/watch/executor'
import { executeConfigTool } from '../skills/config/executor'
import { executeSkillCreatorTool } from '../skills/skill-creator/executor'
import { executePersonalityTool } from '../skills/personality/executor'
import { executePdfTool } from '../skills/pdf/executor'
import { executeChartTool } from '../skills/chart/executor'
import { executePptTool } from '../skills/ppt/executor'
import { executeFeishuTool } from '../skills/feishu/executor'
import { executeWeComTool } from '../skills/wecom/executor'
import { executeDingTalkTool } from '../skills/dingtalk/executor'
import { getUserSkillService, parseUserSkillId, toUserSkillId } from '../../user-skill.service'
import { getSkillEnvMap, mapSkillEnvToDeclaredCase } from '../../credential.service'
import { getSkill } from '../skills/registry'
import { addProactiveContext } from '../proactive-store'
import { getIMService } from '../../im/im.service'
import { getConfigService } from '../../config.service'
import { formatRemainingTime, formatTotalTime, truncateFromEnd } from './utils'
import { formatMcpToolCallContent } from '../../mcp-tool-display'
import { parseMcpSkillId } from '../../mcp-progressive-constants'
import { formatToolCallPrefixFromMeta } from '../tool-metadata'
import type { ToolMeta } from '../tools'
import type { ToolExecutorConfig, AgentConfig, ToolResult } from './types'

/** talk_to_user 流式/执行卡片标题（与 tools.ts _meta.streamDisplay 对齐） */
const TALK_TO_USER_STREAM_META: ToolMeta = {
  streamDisplay: { titleKey: 'im.tool_send_notification', titleField: 'message' },
}

function buildTalkToUserDisplayContent(message: string, title?: string): string {
  return title ? `${title}\n\n${message}` : message
}

function buildTalkToUserToolCallContent(args: Record<string, unknown>): string {
  return formatToolCallPrefixFromMeta(TALK_TO_USER_STREAM_META, args)
    ?? t('im.tool_send_notification')
}

/**
 * 等待指定时间
 */
export async function wait(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const totalSeconds = args.seconds as number
  const message = args.message as string || `等待中...`
  
  if (typeof totalSeconds !== 'number' || totalSeconds <= 0) {
    return { success: false, output: '', error: t('error.wait_seconds_positive') }
  }
  
  const totalTimeDisplay = formatTotalTime(totalSeconds)
  
  const step = executor.addStep({
    type: 'waiting',
    content: `☕ ${message}\n${t('wait.planned', { total: totalTimeDisplay, remaining: totalTimeDisplay })}`,
    toolName: 'wait',
    toolArgs: { seconds: totalSeconds, message },
    riskLevel: 'safe'
  })

  const pollInterval = Math.min(5, Math.max(1, Math.floor(totalSeconds / 20)))
  let elapsedSeconds = 0
  let interrupted = false
  let interruptReason: 'aborted' | 'user_message' | '' = ''
  let userMessageContent = ''

  while (elapsedSeconds < totalSeconds) {
    await new Promise(resolve => setTimeout(resolve, pollInterval * 1000))
    elapsedSeconds += pollInterval
    
    if (executor.isAborted()) {
      interrupted = true
      interruptReason = 'aborted'
      break
    }
    
    if (executor.hasPendingUserMessage()) {
      interrupted = true
      interruptReason = 'user_message'
      userMessageContent = executor.peekPendingUserMessage() || ''
      break
    }
    
    const remainingTime = formatRemainingTime(totalSeconds, elapsedSeconds)
    const progress = Math.min(100, Math.round((elapsedSeconds / totalSeconds) * 100))
    
    executor.updateStep(step.id, {
      type: 'waiting',
      content: `☕ ${message}\n${t('wait.progress', { total: totalTimeDisplay, remaining: remainingTime, progress })}`
    })
  }

  const actualTimeDisplay = formatTotalTime(Math.min(elapsedSeconds, totalSeconds))
  const remainingSeconds = totalSeconds - elapsedSeconds
  const remainingTimeDisplay = formatTotalTime(Math.max(0, remainingSeconds))
  
  if (interrupted) {
    if (interruptReason === 'user_message') {
      executor.updateStep(step.id, {
        type: 'waiting',
        content: `☕ ${message}\n${t('wait.new_message', { elapsed: actualTimeDisplay, remaining: remainingTimeDisplay })}`
      })

      return {
        success: true,
        output: t('wait.user_message', { message: userMessageContent, elapsed: actualTimeDisplay, remaining: remainingTimeDisplay })
      }
    } else {
      executor.updateStep(step.id, {
        type: 'waiting',
        content: `☕ ${message}\n${t('wait.stopped', { elapsed: actualTimeDisplay })}`
      })

      return {
        success: true,
        output: t('wait.aborted', { elapsed: actualTimeDisplay })
      }
    }
  }

  executor.updateStep(step.id, {
    type: 'waiting',
    content: `☕ ${message}\n${t('wait.complete', { total: totalTimeDisplay })}`
  })

  return { 
    success: true, 
    output: t('wait.finished', { total: totalTimeDisplay })
  }
}

const ASK_OPTIONS_MIN = 2
const ASK_OPTIONS_MAX = 10

/** 更倾向的那一项须是选项里已有的；没有或对不上则视为不标。 */
export function resolveAskDefault(raw: unknown, options: string[]): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed || !options.includes(trimmed)) return null
  return trimmed
}

/** 清洗推荐选项：至少 2 个互不相同的非空字符串，最多 10 个。不合规则返回 null。 */
export function normalizeAskOptions(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null
  const seen = new Set<string>()
  const options: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    options.push(trimmed)
    if (options.length >= ASK_OPTIONS_MAX) break
  }
  if (options.length < ASK_OPTIONS_MIN) return null
  return options
}

/**
 * 向用户提问并等待回复
 */
export async function askUser(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const question = args.question as string
  const allowMultiple = args.allow_multiple as boolean | undefined
  
  if (!question || typeof question !== 'string') {
    return { success: false, output: '', error: t('error.question_required') }
  }

  const rawOptions = args.options
  const omittedOptions = rawOptions === undefined || rawOptions === null
    || (Array.isArray(rawOptions) && rawOptions.length === 0)
  let options: string[] = []
  let defaultValue: string | null = null

  if (!omittedOptions) {
    const normalizedOptions = normalizeAskOptions(rawOptions)
    if (!normalizedOptions) {
      return { success: false, output: '', error: t('error.ask_options_required') }
    }
    defaultValue = resolveAskDefault(args.default_value, normalizedOptions)
    options = defaultValue
      ? [defaultValue, ...normalizedOptions.filter(option => option !== defaultValue)]
      : normalizedOptions
  }

  const maxWaitSeconds = clampAskUserTimeout(args.timeout)

  const step = executor.addStep({
    type: 'asking',
    content: question,
    toolName: 'ask_user',
    toolArgs: { question, options, allow_multiple: allowMultiple, default_value: defaultValue ?? undefined, timeout: maxWaitSeconds },
    toolResult: t('ask.waiting_reply'),
    askingStatus: 'waiting',
    riskLevel: 'safe'
  })
  const deadline = Date.now() + maxWaitSeconds * 1000
  const pollIntervalMs = 2000
  let userResponse: string | undefined

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (executor.isAborted()) {
      executor.updateStep(step.id, {
        toolResult: t('ask.cancelled'),
        askingStatus: 'cancelled'
      })
      return { success: false, output: '', error: t('error.operation_aborted') }
    }

    if (executor.hasPendingUserMessage()) {
      userResponse = executor.consumePendingUserMessage()
      break
    }

    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) break

    await new Promise(resolve => setTimeout(resolve, Math.min(pollIntervalMs, remainingMs)))

    const remainingSeconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000))
    const remainingMinutes = Math.floor(remainingSeconds / 60)
    const remainingSecs = remainingSeconds % 60
    const remainingDisplay = remainingMinutes > 0
      ? t('time.minutes_seconds', { minutes: remainingMinutes, seconds: remainingSecs })
      : t('time.seconds', { seconds: remainingSecs })

    executor.updateStep(step.id, {
      toolResult: t('ask.waiting_remaining', { remaining: remainingDisplay }),
      askingStatus: 'waiting'
    })
  }

  if (userResponse !== undefined) {
    let finalResponse = userResponse.trim()
    
    let selectedOptions: string[] = []
    if (finalResponse.startsWith('[') && finalResponse.endsWith(']')) {
      try {
        selectedOptions = JSON.parse(finalResponse)
        if (Array.isArray(selectedOptions)) {
          finalResponse = selectedOptions.join(', ')
        }
      } catch {
        // 不是有效的 JSON
      }
    }
    
    if (selectedOptions.length === 0) {
      const numMatch = finalResponse.match(/^(\d+)$/)
      if (numMatch) {
        const idx = parseInt(numMatch[1], 10) - 1
        if (idx >= 0 && idx < options.length) {
          finalResponse = options[idx]
        }
      }
    }

    const userChosen = finalResponse
    if (!finalResponse && defaultValue) {
      finalResponse = defaultValue
    }

    executor.updateStep(step.id, {
      toolResult: t('ask.received', { response: finalResponse || t('ask.empty') }),
      askingStatus: 'received',
      ...(userChosen ? { askingAnswer: userChosen } : {})
    })

    return {
      success: true,
      output: t('ask.user_replied', { response: finalResponse || t('ask.user_no_content') })
    }
  } else {
    executor.updateStep(step.id, {
      toolResult: t('ask.timeout'),
      askingStatus: 'timeout'
    })

    if (defaultValue) {
      return {
        success: true,
        output: t('ask.using_default', { default: defaultValue })
      }
    }

    return {
      success: false,
      output: '',
      error: t('error.user_reply_timeout')
    }
  }
}

/**
 * 发送文件到当前 IM 聊天（异步）
 * 立即返回 task_id，Agent 通过 await_file_transfer 等待结果。
 */
export async function sendFileToChat(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const filePath = args.file_path as string
  const fileName = args.file_name as string | undefined

  if (!filePath || typeof filePath !== 'string') {
    return { success: false, output: '', error: t('im.tool_file_path_required') }
  }

  const imService = getIMService()

  if (!imService.hasActiveSession()) {
    return { success: false, output: '', error: t('im.tool_no_active_session') }
  }

  let fileSizeDisplay = ''
  try {
    const { statSync } = await import('fs')
    const stat = statSync(filePath)
    const sizeMB = stat.size / 1024 / 1024
    fileSizeDisplay = sizeMB >= 1
      ? ` (${sizeMB.toFixed(1)}MB)`
      : ` (${(stat.size / 1024).toFixed(0)}KB)`
  } catch { /* ignore */ }

  const displayName = fileName || filePath.split('/').pop() || filePath

  const taskId = imService.startFileSend(filePath, fileName)

  executor.addStep({
    type: 'tool_call',
    content: t('im.tool_sending_file', { name: displayName, size: fileSizeDisplay }),
    toolName: 'send_file_to_chat',
    toolArgs: { file_path: filePath, file_name: fileName },
    riskLevel: 'safe'
  })
  executor.addStep({
    type: 'tool_result',
    content: t('im.tool_file_uploading', { name: displayName, taskId }),
    toolName: 'send_file_to_chat',
    toolResult: t('im.tool_file_uploading', { name: displayName, taskId })
  })

  return {
    success: true,
    output: t('im.tool_file_upload_started', { name: displayName, taskId })
  }
}

/**
 * 等待异步文件传输任务完成
 */
export async function awaitFileTransfer(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const taskId = typeof args.task_id === 'string' ? args.task_id : ''
  if (!taskId) {
    return { success: false, output: '', error: t('im.tool_file_task_id_required') }
  }

  const waitSeconds = Math.min(Math.max(Number(args.wait_seconds) || 30, 1), 300)

  const imService = getIMService()
  const task = imService.getFileTransferTask(taskId)
  if (!task) {
    return { success: false, output: '', error: t('im.tool_file_task_not_found', { taskId }) }
  }

  executor.addStep({
    type: 'tool_call',
    content: t('im.tool_file_awaiting', { name: task.displayName, taskId }),
    toolName: 'await_file_transfer',
    toolArgs: { task_id: taskId, wait_seconds: waitSeconds },
    riskLevel: 'safe'
  })

  const reason = await imService.waitFileTransfer(
    taskId,
    waitSeconds * 1000,
    () => executor.isAborted()
  )

  const elapsed = task.finishedAt
    ? `${((task.finishedAt - task.startedAt) / 1000).toFixed(1)}s`
    : `>${waitSeconds}s`

  if (reason === 'done') {
    executor.addStep({
      type: 'tool_result',
      content: t('im.tool_file_sent', { name: task.displayName }),
      toolName: 'await_file_transfer',
      toolResult: t('im.tool_file_sent_output', { name: task.displayName })
    })
    return {
      success: true,
      output: t('im.tool_file_transfer_done', { name: task.displayName, elapsed })
    }
  }

  if (reason === 'failed') {
    executor.addStep({
      type: 'tool_result',
      content: t('im.tool_file_send_failed', { error: task.error || '' }),
      toolName: 'await_file_transfer',
      toolResult: task.error || t('error.unknown')
    })
    return {
      success: false,
      output: '',
      error: task.error || t('im.tool_file_send_failed_output')
    }
  }

  if (reason === 'aborted') {
    executor.addStep({
      type: 'tool_result',
      content: t('im.tool_file_awaiting_aborted', { name: task.displayName }),
      toolName: 'await_file_transfer',
      toolResult: t('im.tool_file_awaiting_aborted', { name: task.displayName })
    })
    return { success: false, output: '', error: t('error.operation_aborted') }
  }

  // timeout：任务仍在进行
  executor.addStep({
    type: 'tool_result',
    content: t('im.tool_file_awaiting_timeout', { name: task.displayName, elapsed: `${waitSeconds}s` }),
    toolName: 'await_file_transfer',
    toolResult: t('im.tool_file_awaiting_timeout', { name: task.displayName, elapsed: `${waitSeconds}s` })
  })
  return {
    success: true,
    output: t('im.tool_file_still_uploading', { taskId }),
    isRunning: true,
  }
}

/**
 * send_to_chat 统一入口：根据 type 分发到 sendFileToChat / sendImageToChat
 */
export async function sendToChat(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const type = (args.type as string) || 'file'
  if (type === 'image') {
    return sendImageToChat(args, executor)
  }
  return sendFileToChat(args, executor)
}

/**
 * 发送图片到当前 IM 聊天（内联显示）
 */
/** 常见图片文件扩展名 */
const IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tiff', '.tif', '.svg', '.ico', '.heic', '.heif', '.avif'
])

export async function sendImageToChat(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const filePath = args.file_path as string

  if (!filePath || typeof filePath !== 'string') {
    return { success: false, output: '', error: t('im.tool_file_path_required') }
  }

  const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase()
  if (!IMAGE_EXTENSIONS.has(ext)) {
    return { success: false, output: '', error: t('im.tool_unsupported_image_format', { ext }) }
  }

  const imService = getIMService()

  if (!imService.hasActiveSession()) {
    return { success: false, output: '', error: t('im.tool_no_active_session') }
  }

  let fileSizeDisplay = ''
  try {
    const { statSync } = await import('fs')
    const stat = statSync(filePath)
    const sizeMB = stat.size / 1024 / 1024
    fileSizeDisplay = sizeMB >= 1
      ? ` (${sizeMB.toFixed(1)}MB)`
      : ` (${(stat.size / 1024).toFixed(0)}KB)`
  } catch { /* ignore */ }

  const displayName = filePath.split('/').pop() || filePath

  executor.addStep({
    type: 'tool_call',
    content: t('im.tool_sending_image', { name: displayName, size: fileSizeDisplay }),
    toolName: 'send_image_to_chat',
    toolArgs: { file_path: filePath },
    riskLevel: 'safe'
  })

  const result = await imService.sendImageForCurrentSession(filePath)

  if (result.success) {
    executor.addStep({
      type: 'tool_result',
      content: t('im.tool_image_sent', { name: displayName }),
      toolName: 'send_image_to_chat',
      toolResult: t('im.tool_image_sent_output', { name: displayName })
    })
    return { success: true, output: t('im.tool_image_sent_to_chat', { name: displayName }) }
  } else {
    executor.addStep({
      type: 'tool_result',
      content: t('im.tool_image_send_failed', { error: result.error || '' }),
      toolName: 'send_image_to_chat',
      toolResult: result.error || t('error.unknown')
    })
    return { success: false, output: '', error: result.error || t('im.tool_image_send_failed_output') }
  }
}

/**
 * 执行 MCP 工具
 */
export async function executeMcpTool(
  fullName: string,
  args: Record<string, unknown>,
  toolCallId: string,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  if (!executor.mcpService) {
    return { success: false, output: '', error: t('error.mcp_not_initialized') }
  }

  const parsed = executor.mcpService.parseToolCallName(fullName)
  if (!parsed) {
    return { success: false, output: '', error: t('error.invalid_mcp_tool_name', { name: fullName }) }
  }

  const { serverId, toolName } = parsed
  const displayLabel = executor.mcpService.getToolDisplayLabel(fullName) ?? toolName

  // 渐进披露兜底：未 load 该 server 却调用 → 整包 load 该 server，请模型重试
  if (
    executor.mcpService.shouldDeferTools() &&
    executor.mcpToolSession &&
    !executor.mcpToolSession.isServerLoaded(serverId)
  ) {
    if (!executor.mcpService.isConnected(serverId)) {
      return { success: false, output: '', error: t('error.mcp_server_not_connected', { server: serverId }) }
    }
    executor.mcpToolSession.loadServer(serverId)
    const defs = executor.mcpService.getToolDefinitionsByServerIds([serverId])
    const msg = t('mcp.server_loaded_retry', {
      name: displayLabel,
      count: defs.length
    })
    executor.addStep({
      type: 'tool_call',
      content: formatMcpToolCallContent(displayLabel),
      toolName: fullName,
      toolArgs: args,
      riskLevel: 'moderate'
    })
    executor.addStep({
      type: 'tool_result',
      content: msg,
      toolName: fullName,
      toolResult: msg
    })
    return { success: false, output: msg, error: msg }
  }

  if (!executor.mcpService.isConnected(serverId)) {
    return { success: false, output: '', error: t('error.mcp_server_not_connected', { server: serverId }) }
  }

  executor.addStep({
    type: 'tool_call',
    content: formatMcpToolCallContent(displayLabel),
    toolName: fullName,
    toolArgs: args,
    riskLevel: 'moderate'
  })

  try {
    const result = await executor.mcpService.callTool(serverId, toolName, args)

    if (result.success) {
      const displayContent = result.content || ''
      const truncatedDisplay = displayContent.length > 500
        ? truncateFromEnd(displayContent, 500)
        : displayContent
      
      executor.addStep({
        type: 'tool_result',
        content: `${t('mcp.tool_success')} (${displayContent.length} ${t('misc.characters')})`,
        toolName: fullName,
        toolResult: truncatedDisplay
      })
      return { success: true, output: result.content || '' }
    } else {
      executor.addStep({
        type: 'tool_result',
        content: `${t('mcp.tool_failed')}: ${result.error}`,
        toolName: fullName,
        toolResult: result.error
      })
      return { success: false, output: '', error: result.error }
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : t('mcp.tool_failed')
    executor.addStep({
      type: 'tool_result',
      content: `${t('mcp.error')}: ${errorMsg}`,
      toolName: fullName,
      toolResult: errorMsg
    })
    return { success: false, output: '', error: errorMsg }
  }
}

/**
 * 按 MCP server 整包加载工具定义（渐进披露；由 skill load mcp:… 或遗留 mcp_load 调用）
 */
export async function loadMcpServer(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig,
  options?: { viaSkill?: boolean; skillId?: string }
): Promise<ToolResult> {
  if (!executor.mcpService) {
    return { success: false, output: '', error: t('error.mcp_not_initialized') }
  }
  if (!executor.mcpToolSession) {
    return { success: false, output: '', error: t('error.mcp_not_initialized') }
  }

  const serverRef = typeof args.server === 'string'
    ? args.server.trim()
    : (typeof args.skill_id === 'string' ? args.skill_id.trim() : '')
  if (!serverRef) {
    return { success: false, output: '', error: 'server is required' }
  }

  const toolName = options?.viaSkill ? 'skill' : 'mcp_load'
  let resolved = executor.mcpService.resolveServerRef(serverRef)
  const configured = executor.mcpService.findConfiguredServer(
    serverRef,
    getConfigService().getMcpServers()
  )
  // 卡片展示用人类可读名称，勿只露 mcp:uuid
  const displayLabel = resolved?.name || configured?.name || options?.skillId || serverRef

  executor.addStep({
    type: 'tool_call',
    content: `${t('mcp.load')}: ${displayLabel}`,
    toolName,
    toolArgs: options?.viaSkill
      ? { action: 'load', skill_id: options.skillId || serverRef }
      : { server: serverRef },
    riskLevel: 'safe'
  })

  if (!resolved && configured && configured.enabled === false) {
    const err = t('mcp.load_server_disabled', { name: configured.name })
    executor.addStep({
      type: 'tool_result',
      content: err,
      toolName,
      toolResult: err
    })
    return { success: false, output: '', error: err }
  }

  if (!resolved && configured && configured.enabled !== false) {
    try {
      await executor.mcpService.ensureConnected(configured)
      resolved = executor.mcpService.resolveServerRef(configured.id)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const fail = t('mcp.load_connect_failed', { name: configured.name, error: msg })
      executor.addStep({
        type: 'tool_result',
        content: fail,
        toolName,
        toolResult: fail
      })
      return { success: false, output: '', error: fail }
    }
  }

  if (!resolved) {
    const catalog = executor.mcpService.getServerCatalogText()
    const err = t('mcp.load_server_not_found', { server: serverRef }) + '\n\n' + catalog
    executor.addStep({
      type: 'tool_result',
      content: t('mcp.load_server_not_found', { server: serverRef }),
      toolName,
      toolResult: err
    })
    return { success: false, output: '', error: err }
  }

  executor.mcpToolSession.loadServer(resolved.serverId)
  const defs = executor.mcpService.getToolDefinitionsByServerIds([resolved.serverId])
  const names = defs.map(d => d.function.name)

  const parts: string[] = [
    t('mcp.server_loaded', {
      name: resolved.name,
      count: defs.length
    })
  ]
  if (names.length > 0) {
    parts.push('\n' + names.map(n => `- ${n}`).join('\n'))
    parts.push('\n' + t('mcp.server_loaded_hint'))
  }
  const output = parts.join('\n')

  executor.addStep({
    type: 'tool_result',
    content: t('mcp.server_loaded', { name: resolved.name, count: defs.length }),
    toolName,
    toolResult: output.length > 800 ? truncateFromEnd(output, 800) : output
  })
  return { success: true, output }
}

/**
 * skill unload mcp:… → 从 McpToolSession 移除
 */
async function unloadMcpServerSkill(
  skillId: string,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  if (!executor.mcpService || !executor.mcpToolSession) {
    return { success: false, output: '', error: t('error.mcp_not_initialized') }
  }

  const resolved = executor.mcpService.resolveServerRef(skillId)
  const displayLabel = resolved?.name || skillId

  executor.addStep({
    type: 'tool_call',
    content: t('skill.unloading', { id: displayLabel }),
    toolName: 'skill',
    toolArgs: { action: 'unload', skill_id: skillId },
    riskLevel: 'safe'
  })

  if (!resolved) {
    const err = t('mcp.load_server_not_found', { server: skillId })
    executor.addStep({
      type: 'tool_result',
      content: err,
      toolName: 'skill',
      toolResult: err
    })
    return { success: false, output: '', error: err }
  }

  if (!executor.mcpToolSession.isServerLoaded(resolved.serverId)) {
    const output = t('skill.not_loaded', { id: displayLabel })
    executor.addStep({
      type: 'tool_result',
      content: output,
      toolName: 'skill',
      toolResult: output
    })
    return { success: true, output }
  }

  executor.mcpToolSession.unloadServer(resolved.serverId)
  const output = t('skill.unloaded', { id: displayLabel })
  executor.addStep({
    type: 'tool_result',
    content: output,
    toolName: 'skill',
    toolResult: output
  })
  return { success: true, output }
}

/**
 * skill 工具统一入口：根据 action 分发到 load / unload
 */
export async function dispatchSkill(
  args: Record<string, unknown>,
  config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const action = args.action as string
  switch (action) {
    case 'load':
      return loadSkillTool(args, config, executor)
    case 'unload':
      return unloadSkillTool(args, executor)
    default:
      return { success: false, output: '', error: `Unknown skill action: ${action}. Use "load" or "unload".` }
  }
}

/**
 * 加载技能工具（含 mcp:<serverId>）
 */
export async function loadSkillTool(
  args: Record<string, unknown>,
  config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const skillId = args.skill_id as string
  
  if (!skillId) {
    return { success: false, output: '', error: t('skill.id_required') }
  }

  // MCP 虚拟 skill：mcp:<id>，或已连接 / 已配置（含尚未连上）的裸 id / 显示名
  const mcpSkillId = parseMcpSkillId(skillId)
  const mcpConfigured = executor.mcpService?.findConfiguredServer(
    skillId,
    getConfigService().getMcpServers()
  )
  if (
    mcpSkillId ||
    ((executor.mcpService?.resolveServerRef(skillId) || mcpConfigured) && !getSkill(skillId))
  ) {
    return loadMcpServer(
      { server: skillId, skill_id: skillId },
      executor,
      { viaSkill: true, skillId }
    )
  }

  const explicitUserId = parseUserSkillId(skillId)
  if (explicitUserId || (!getSkill(skillId) && resolveUserSkillRawId(skillId))) {
    return loadUserSkillTool(args, executor)
  }

  if (!executor.skillSession) {
    return { success: false, output: '', error: t('skill.session_not_initialized') }
  }

  const disabledSkills = getConfigService().get('disabledBuiltinSkills') || []
  if (disabledSkills.includes(skillId)) {
    return { success: false, output: '', error: `Skill "${skillId}" is disabled` }
  }

  executor.addStep({
    type: 'tool_call',
    content: t('skill.loading', { id: skillId }),
    toolName: 'load_skill',
    toolArgs: args,
    riskLevel: 'safe'
  })

  const result = await executor.skillSession.loadSkill(skillId)
  
  if (result.success) {
    const skillName = result.skillName || skillId
    const toolsList = result.toolsAdded?.join(', ') || ''
    const skill = getSkill(skillId)
    const skillContent = skill?.content || ''
    const simpleOutput = t('skill.loaded_simple', { name: skillName })
    const detailOutput = skillContent
      ? `## ${skillName}\n\n${skillContent}`
      : t('skill.loaded', { name: skillName, tools: toolsList })
    
    executor.addStep({
      type: 'tool_result',
      content: simpleOutput,
      toolName: 'load_skill',
      toolResult: skillContent || toolsList || undefined
    })

    executor.markBuiltinSkillLoaded?.(skillId)
    
    return { success: true, output: detailOutput }
  } else {
    executor.addStep({
      type: 'tool_result',
      content: `${t('skill.load_failed')}: ${result.error}`,
      toolName: 'load_skill',
      toolResult: result.error || ''
    })
    
    return { success: false, output: '', error: result.error }
  }
}

/**
 * 卸载技能工具
 * 卸载已加载的技能，释放工具槽位
 */
export async function unloadSkillTool(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const skillId = args.skill_id as string
  
  if (!skillId) {
    return { success: false, output: '', error: t('skill.id_required') }
  }

  const mcpSkillId = parseMcpSkillId(skillId)
  if (mcpSkillId || (executor.mcpService?.resolveServerRef(skillId) && !getSkill(skillId))) {
    return unloadMcpServerSkill(skillId, executor)
  }

  const explicitUserId = parseUserSkillId(skillId)
  const builtinLoaded = executor.skillSession?.getLoadedSkills().includes(skillId) ?? false
  if (explicitUserId || (!builtinLoaded && (executor.isUserSkillLoaded?.(skillId) || resolveUserSkillRawId(skillId)))) {
    return unloadUserSkillTool(skillId, executor)
  }

  if (!executor.skillSession) {
    return { success: false, output: '', error: t('skill.session_not_initialized') }
  }

  // 检查技能是否已加载
  const loadedSkills = executor.skillSession.getLoadedSkills()
  if (!loadedSkills.includes(skillId)) {
    const output = t('skill.not_loaded', { id: skillId })
    executor.addStep({
      type: 'tool_result',
      content: output,
      toolName: 'unload_skill',
      toolResult: output
    })
    return { success: true, output }
  }

  executor.addStep({
    type: 'tool_call',
    content: t('skill.unloading', { id: skillId }),
    toolName: 'unload_skill',
    toolArgs: args,
    riskLevel: 'safe'
  })

  try {
    await executor.skillSession.unloadSkill(skillId)
    executor.markSkillUnloaded?.(skillId)
    
    const output = t('skill.unloaded', { id: skillId })
    executor.addStep({
      type: 'tool_result',
      content: output,
      toolName: 'unload_skill',
      toolResult: output
    })
    
    return { success: true, output }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    executor.addStep({
      type: 'tool_result',
      content: `${t('skill.unload_failed')}: ${errorMsg}`,
      toolName: 'unload_skill',
      toolResult: errorMsg
    })
    
    return { success: false, output: '', error: errorMsg }
  }
}

function resolveUserSkillRawId(skillId: string): string | null {
  const prefixed = parseUserSkillId(skillId)
  if (prefixed) return prefixed
  return getUserSkillService().getSkill(skillId) ? skillId : null
}

async function unloadUserSkillTool(
  skillId: string,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const rawId = resolveUserSkillRawId(skillId) ?? skillId
  const loaded = executor.isUserSkillLoaded?.(rawId) || executor.isUserSkillLoaded?.(toUserSkillId(rawId))

  if (!loaded) {
    const output = t('skill.not_loaded', { id: rawId })
    executor.addStep({
      type: 'tool_result',
      content: output,
      toolName: 'skill',
      toolResult: output
    })
    return { success: true, output }
  }

  executor.addStep({
    type: 'tool_call',
    content: t('skill.unloading', { id: rawId }),
    toolName: 'skill',
    toolArgs: { action: 'unload', skill_id: rawId },
    riskLevel: 'safe'
  })

  executor.markSkillUnloaded?.(toUserSkillId(rawId))
  const output = t('skill.unloaded', { id: rawId })
  executor.addStep({
    type: 'tool_result',
    content: output,
    toolName: 'skill',
    toolResult: output
  })
  return { success: true, output }
}

/**
 * 加载用户技能工具
 */
export async function loadUserSkillTool(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const skillId = args.skill_id as string
  
  if (!skillId) {
    return { success: false, output: '', error: t('user_skill.id_required') }
  }

  const rawId = parseUserSkillId(skillId) ?? skillId

  executor.addStep({
    type: 'tool_call',
    content: t('skill.loading', { id: rawId }),
    toolName: 'skill',
    toolArgs: { action: 'load', skill_id: rawId },
    riskLevel: 'safe'
  })

  const userSkillService = getUserSkillService()
  const skill = userSkillService.getSkill(rawId)
  
  if (!skill) {
    const errorMsg = t('user_skill.not_found', { id: rawId })
    executor.addStep({
      type: 'tool_result',
      content: errorMsg,
      toolName: 'skill',
      toolResult: errorMsg
    })
    return { success: false, output: '', error: errorMsg }
  }
  
  if (!skill.enabled) {
    const errorMsg = t('user_skill.disabled', { id: rawId })
    executor.addStep({
      type: 'tool_result',
      content: errorMsg,
      toolName: 'skill',
      toolResult: errorMsg
    })
    return { success: false, output: '', error: errorMsg }
  }

  const content = userSkillService.getSkillContent(rawId)
  if (!content) {
    const errorMsg = t('user_skill.content_empty', { id: rawId })
    executor.addStep({
      type: 'tool_result',
      content: errorMsg,
      toolName: 'skill',
      toolResult: errorMsg
    })
    return { success: false, output: '', error: errorMsg }
  }

  const sections: string[] = []
  sections.push(`## ${skill.name}`)
  if (skill.description) sections.push(`\n> ${skill.description}`)

  // 附属文件和运行环境信息（ClawHub 兼容技能包）
  const hasFiles = skill.files && skill.files.length > 0
  const hasEnvRequirements = (skill.requires?.env?.length ?? 0) > 0
  if (hasFiles || skill.requires) {
    sections.push('\n### Skill Bundle Info')
    sections.push(`- **baseDir**: \`${skill.baseDir}\``)
    if (skill.requires?.bins?.length) {
      sections.push(`- **requires**: ${skill.requires.bins.map(b => `\`${b}\``).join(', ')}`)
    }
    if (hasEnvRequirements) {
      // 显示每个 env key 的配置状态
      const envStatuses = await userSkillService.getSkillEnvStatus(rawId)
      const envLines = envStatuses.map(s =>
        `\`${s.name}\` ${s.configured ? '✅已配置' : '❌未配置'}`
      )
      sections.push(`- **env keys**: ${envLines.join(', ')}`)
      const missing = envStatuses.filter(s => !s.configured)
      if (missing.length > 0) {
        sections.push(`\n> ⚠️ 缺少 ${missing.length} 个 key：${missing.map(s => `\`${s.name}\``).join(', ')}。请用 \`skill_set_env("${rawId}", "KEY_NAME")\` 配置，或告诉 Agent key 的值。`)
      } else {
        // 有终端（local/ssh 模式）时，自动把已配置的 key export 进当前 shell session
        const ptyId = executor.getCurrentPtyId?.()
        if (ptyId) {
          // credential 层统一大写存储，按 SKILL.md 声明的原始大小写映射后再 export，
          // 保证技能脚本能用声明的变量名（可能是 api_key 而非 API_KEY）读到
          const declaredEnvs = skill.requires?.env ?? []
          const envMap = await getSkillEnvMap(rawId)
          const envEntries = Object.entries(
            mapSkillEnvToDeclaredCase(envMap, declaredEnvs)
          )
          if (envEntries.length > 0) {
            // 用单引号包裹值，处理特殊字符；export 多个 key 写成一行
            const exportCmd = 'export ' + envEntries
              .map(([k, v]) => `${k}='${v.replace(/'/g, "'\\''")}'`)
              .join(' ')
            executor.terminalService.write(ptyId, exportCmd + '\n')
            executor.addStep({
              type: 'tool_result',
              content: `🔑 已注入 ${envEntries.length} 个环境变量`,
              toolName: 'skill',
              toolResult: `已将 ${envEntries.map(([k]) => `\`${k}\``).join(', ')} export 到当前 shell session`
            })
            sections.push(`\n> 💡 已自动 export ${envEntries.length} 个 key 到当前 shell，直接用 \`execute_command\` 运行脚本即可。`)
          }
        } else {
          // assistant 模式：用 exec + skill_id 注入
          sections.push(`\n> 💡 执行本技能脚本时请用 \`exec(command, skill_id="${rawId}")\` 自动注入 key，勿明文传递。`)
        }
      }
    }
    if (hasFiles) {
      sections.push(`- **files** (${skill.files!.length}): ${skill.files!.join(', ')}`)
    }
  }

  sections.push(`\n${content}`)
  const output = sections.join('\n')
  
  executor.addStep({
    type: 'tool_result',
    content: t('skill.loaded_simple', { name: skill.name }),
    toolName: 'skill',
    toolResult: output
  })

  executor.markUserSkillLoaded?.(toUserSkillId(rawId))
  
  return { success: true, output }
}

/**
 * 发消息给用户（通过可用渠道：IM、应用内通知等）
 *
 * 桌面通知统一使用 __companion__ agentId：
 * - talk_to_user 可能由任意 Agent（如 __watch__）调用，但用户回复（无论 IM 还是应用内）
 *   始终路由到 companion agent，使用统一 agentId 确保 tab 复用和上下文连贯
 * - 调用方 Agent 的工具执行步骤仍保留在其自身的 tab/上下文中
 */
export async function messageUser(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const message = args.message as string
  const title = typeof args.title === 'string' && args.title.trim() ? args.title : undefined

  if (!message || typeof message !== 'string') {
    return { success: false, output: '', error: t('im.tool_message_required') }
  }

  const toolArgs: Record<string, unknown> = title ? { message, title } : { message }
  const displayContent = buildTalkToUserDisplayContent(message, title)
  executor.addStep({
    type: 'tool_call',
    content: buildTalkToUserToolCallContent(toolArgs),
    toolName: 'talk_to_user',
    toolArgs,
    riskLevel: 'safe',
  })

  const deliveredVia: string[] = []
  const failedChannels: { platform: string; error: string }[] = []
  // 与 AgentService.COMPANION_AGENT_ID 保持一致（不直接 import 以避免循环依赖）
  const companionAgentId = '__companion__'

  // 尝试通过 IM 渠道发送
  try {
    const imService = getIMService()
    const lastContact = imService.getLastContact()

    if (lastContact) {
      const result = await imService.sendNotification(message, {
        markdown: !!title,
        title,
      })
      if (result.failedPlatforms?.length) {
        for (const f of result.failedPlatforms) {
          failedChannels.push(f)
        }
      }
      if (result.success) {
        deliveredVia.push(result.platform || 'IM')
        if (result.failedPlatforms?.length) {
          const failedNames = result.failedPlatforms.map(f => f.platform).join(', ')
          executor.addStep({
            type: 'tool_result',
            content: t('im.tool_im_fallback_success', { failed: failedNames, succeeded: result.platform! }),
            toolName: 'talk_to_user',
            toolResult: result.failedPlatforms.map(f => `${f.platform}: ${f.error}`).join('; ')
          })
        }
      } else if (result.error) {
        const failedInfo = result.failedPlatforms?.map(f => `${f.platform}: ${f.error}`).join('; ') || result.error
        executor.addStep({
          type: 'tool_result',
          content: t('im.tool_im_delivery_failed', { platform: result.failedPlatforms?.map(f => f.platform).join(', ') || 'IM', error: result.error }),
          toolName: 'talk_to_user',
          toolResult: failedInfo
        })
      }
    }
  } catch (e) {
    log.debug('messageUser: IM delivery unavailable:', e)
  }

  // 应用内：发送待展示消息（不创建标签页，用户点击通知后才展开）
  let windowFocused = false
  try {
    const electron = require('electron')
    const windows = electron.BrowserWindow?.getAllWindows?.()
    if (windows?.length > 0) {
      const mainWindow = windows[0]
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send('watch:proactive-message', {
          agentId: companionAgentId,
          message,
          watchName: title || ''
        })
        deliveredVia.push('app')
        windowFocused = mainWindow.isFocused()
      }
    }
  } catch (e) {
    log.debug('messageUser: app delivery failed:', e)
  }

  // 窗口不存在或没有焦点时，发系统通知；点击通知时激活应用并展开对话
  if (!windowFocused) {
    try {
      const electron = require('electron')
      const { Notification } = electron
      if (Notification.isSupported()) {
        const notification = new Notification({
          title: title || 'SailFish',
          body: message.length > 200 ? message.substring(0, 200) + '...' : message
        })
        notification.on('click', () => {
          const windows = electron.BrowserWindow?.getAllWindows?.()
          if (windows?.length > 0) {
            const win = windows[0]
            if (!win.isDestroyed()) {
              win.show()
              win.focus()
              if (process.platform === 'win32') {
                win.webContents.focus()
              }
              win.webContents.send('watch:activate-message', { agentId: companionAgentId })
            }
          }
        })
        notification.show()
      }
    } catch (e) {
      log.debug('messageUser: system notification failed:', e)
    }
  }

  if (deliveredVia.length > 0) {
    addProactiveContext(companionAgentId, message, title)

    // 将主动消息持久化到 __companion__ 历史：重启后 restoreCompanionHistoryIfNeeded
    // 从 history.getRecentByAgentKey('__companion__') 恢复时才能看到这条消息。
    // 不依赖 companion Agent 是否正在运行，直接写一条最小 AgentRecord。
    if (executor.historyService) {
      try {
        const ts = Date.now()
        const uid = `proactive-${ts}-${Math.random().toString(36).slice(2, 8)}`
        executor.historyService.saveAgentRecord({
          id: `${uid}-session`,
          timestamp: ts,
          terminalId: '',
          agentKey: companionAgentId,
          terminalType: 'assistant',
          userTask: '__proactive__',
          steps: [
            { id: `${uid}-notice`, type: 'proactive_notice', content: message, timestamp: ts },
          ],
          finalResult: message,
          duration: 0,
          status: 'completed',
        })
        // 失效 Watch 10s 联络上下文缓存，否则连触发（里程碑 + 上线）会重复 talk_to_user
        try {
          const { getWatchService } = require('../../watch/watch.service')
          getWatchService().invalidateCompanionContextCache()
        } catch { /* watch 未初始化时跳过 */ }
      } catch (e) {
        log.debug('messageUser: 保存主动消息历史失败:', e)
      }
    }

    const channels = deliveredVia.join(', ')
    const timeStr = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    const truncatedMsg = message.length > 200 ? message.substring(0, 200) + '...' : message
    let output = `<notification_delivered>
<time>${timeStr}</time>
<channels>${channels}</channels>
<content>${truncatedMsg}</content>
</notification_delivered>`
    if (failedChannels.length > 0) {
      const failedInfo = failedChannels.map(f => `${f.platform}: ${f.error}`).join('; ')
      output += `\n<im_delivery_failed>${failedInfo}</im_delivery_failed>`
    }
    executor.addStep({
      type: 'tool_result',
      content: t('im.tool_notification_sent_step', { platform: channels }),
      toolName: 'talk_to_user',
      toolResult: displayContent,
    })
    return { success: true, output }
  } else {
    const failedInfo = failedChannels.length > 0
      ? failedChannels.map(f => `${f.platform}: ${f.error}`).join('; ')
      : ''
    const error = failedInfo || t('im.tool_no_contact')
    executor.addStep({
      type: 'tool_result',
      content: t('im.tool_notification_failed', { error }),
      toolName: 'talk_to_user',
      toolResult: error
    })
    return { success: false, output: '', error }
  }
}


/**
 * 执行技能工具
 */
export async function executeSkillTool(
  toolName: string,
  ptyId: string | undefined,
  args: Record<string, unknown>,
  toolCallId: string,
  config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const id = ptyId ?? ''

  if (toolName.startsWith('excel_')) {
    return executeExcelTool(toolName, id, args, toolCallId, config, executor)
  }

  if (toolName.startsWith('email_')) {
    return executeEmailTool(toolName, id, args, toolCallId, config, executor)
  }

  if (toolName.startsWith('browser_')) {
    return executeBrowserTool(toolName, id, args, toolCallId, config, executor)
  }

  if (toolName.startsWith('word_')) {
    return executeWordTool(toolName, id, args, toolCallId, config, executor)
  }

  if (toolName.startsWith('ppt_')) {
    return executePptTool(toolName, id, args, toolCallId, config, executor)
  }

  if (toolName.startsWith('todo_')) {
    return executeTodoTool(toolName, id, args, toolCallId, config, executor)
  }

  if (toolName.startsWith('calendar_')) {
    return executeCalendarTool(toolName, id, args, toolCallId, config, executor)
  }

  if (toolName.startsWith('watch_')) {
    return executeWatchTool(toolName, id, args, toolCallId, config, executor)
  }

  if (toolName.startsWith('config_') || toolName === 'im_connect') {
    return executeConfigTool(toolName, id, args, toolCallId, config, executor)
  }

  if (toolName.startsWith('skill_')) {
    return executeSkillCreatorTool(toolName, id, args, toolCallId, config, executor)
  }

  if (toolName.startsWith('personality_') || toolName === 'soul_craft' || toolName === 'user_craft') {
    return executePersonalityTool(toolName, id, args, toolCallId, config, executor)
  }

  if (toolName.startsWith('pdf_')) {
    return executePdfTool(toolName, id, args, toolCallId, config, executor)
  }

  if (toolName === 'generate_chart' || toolName === 'render_echarts_option' || toolName === 'inspect_chart_file') {
    return executeChartTool(toolName, id, args, toolCallId, config, executor)
  }

  if (toolName.startsWith('feishu_')) {
    return executeFeishuTool(toolName, id, args, toolCallId, config, executor)
  }

  if (toolName.startsWith('wecom_')) {
    return executeWeComTool(toolName, id, args, toolCallId, config, executor)
  }

  if (toolName.startsWith('dingtalk_')) {
    return executeDingTalkTool(toolName, id, args, toolCallId, config, executor)
  }

  return { success: false, output: '', error: t('error.unknown_tool', { name: toolName }) }
}
