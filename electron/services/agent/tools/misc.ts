/**
 * 其他工具
 * 包括：等待、向用户提问、MCP 工具、技能工具
 */
import { t } from '../i18n'
import { createLogger } from '../../../utils/logger'
const log = createLogger('tools/misc')
import { executeExcelTool } from '../skills/excel/executor'
import { executeEmailTool } from '../skills/email/executor'
import { executeBrowserTool } from '../skills/browser/executor'
import { executeWordTool } from '../skills/word/executor'
import { executeCalendarTool } from '../skills/calendar/executor'
import { executeWatchTool } from '../skills/watch/executor'
import { executeConfigTool } from '../skills/config/executor'
import { executeSkillCreatorTool } from '../skills/skill-creator/executor'
import { executePersonalityTool } from '../skills/personality/executor'
import { executePdfTool } from '../skills/pdf/executor'
import { getUserSkillService } from '../../user-skill.service'
import { addProactiveContext } from '../proactive-store'
import { getConfigService } from '../../config.service'
import { formatRemainingTime, formatTotalTime, truncateFromEnd } from './utils'
import type { ToolExecutorConfig, AgentConfig, ToolResult } from './types'

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

/**
 * 向用户提问并等待回复
 */
export async function askUser(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const question = args.question as string
  let options = args.options as string[] | undefined
  const allowMultiple = args.allow_multiple as boolean | undefined
  const defaultValue = args.default_value as string | undefined
  
  if (!question || typeof question !== 'string') {
    return { success: false, output: '', error: t('error.question_required') }
  }

  if (options && options.length > 10) {
    options = options.slice(0, 10)
  }

  const timeout = args.timeout as number | undefined
  const maxWaitSeconds = Math.min(600, Math.max(30, timeout ?? 120))

  const step = executor.addStep({
    type: 'asking',
    content: question,
    toolName: 'ask_user',
    toolArgs: { question, options, allow_multiple: allowMultiple, default_value: defaultValue, timeout },
    toolResult: t('ask.waiting_reply'),
    riskLevel: 'safe'
  })
  const pollInterval = 2
  let elapsedSeconds = 0
  let userResponse: string | undefined

  while (elapsedSeconds < maxWaitSeconds) {
    if (executor.isAborted()) {
      executor.updateStep(step.id, {
        toolResult: t('ask.cancelled')
      })
      return { success: false, output: '', error: t('error.operation_aborted') }
    }

    if (executor.hasPendingUserMessage()) {
      userResponse = executor.consumePendingUserMessage()
      break
    }

    await new Promise(resolve => setTimeout(resolve, pollInterval * 1000))
    elapsedSeconds += pollInterval

    const remainingSeconds = maxWaitSeconds - elapsedSeconds
    const remainingMinutes = Math.floor(remainingSeconds / 60)
    const remainingSecs = remainingSeconds % 60
    const remainingDisplay = remainingMinutes > 0 
      ? t('time.minutes_seconds', { minutes: remainingMinutes, seconds: remainingSecs })
      : t('time.seconds', { seconds: remainingSecs })
    
    executor.updateStep(step.id, {
      toolResult: t('ask.waiting_remaining', { remaining: remainingDisplay })
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
    
    if (options && options.length > 0 && selectedOptions.length === 0) {
      const numMatch = finalResponse.match(/^(\d+)$/)
      if (numMatch) {
        const idx = parseInt(numMatch[1], 10) - 1
        if (idx >= 0 && idx < options.length) {
          finalResponse = options[idx]
        }
      }
    }

    if (!finalResponse && defaultValue) {
      finalResponse = defaultValue
    }

    if (finalResponse) {
      executor.addStep({
        type: 'user_supplement',
        content: finalResponse,
        riskLevel: 'safe'
      })
    }

    executor.updateStep(step.id, {
      toolResult: t('ask.received', { response: finalResponse || t('ask.empty') })
    })

    return {
      success: true,
      output: t('ask.user_replied', { response: finalResponse || t('ask.user_no_content') })
    }
  } else {
    executor.updateStep(step.id, {
      toolResult: t('ask.timeout')
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
 * 发送文件到当前 IM 聊天
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

  const { getIMService } = await import('../../im/im.service')
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

  executor.addStep({
    type: 'tool_call',
    content: t('im.tool_sending_file', { name: displayName, size: fileSizeDisplay }),
    toolName: 'send_file_to_chat',
    toolArgs: { file_path: filePath, file_name: fileName },
    riskLevel: 'safe'
  })

  const result = await imService.sendFileForCurrentSession(filePath, fileName)

  if (result.success) {
    executor.addStep({
      type: 'tool_result',
      content: t('im.tool_file_sent', { name: displayName }),
      toolName: 'send_file_to_chat',
      toolResult: t('im.tool_file_sent_output', { name: displayName })
    })
    return { success: true, output: t('im.tool_file_sent_to_chat', { name: displayName }) }
  } else {
    executor.addStep({
      type: 'tool_result',
      content: t('im.tool_file_send_failed', { error: result.error || '' }),
      toolName: 'send_file_to_chat',
      toolResult: result.error || t('error.unknown')
    })
    return { success: false, output: '', error: result.error || t('im.tool_file_send_failed_output') }
  }
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

  const { getIMService } = await import('../../im/im.service')
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

  if (!executor.mcpService.isConnected(serverId)) {
    return { success: false, output: '', error: t('error.mcp_server_not_connected', { server: serverId }) }
  }

  executor.addStep({
    type: 'tool_call',
    content: `${t('mcp.calling_tool')}: ${toolName}`,
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
 * 加载技能工具
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
    const simpleOutput = t('skill.loaded_simple', { name: skillName })
    const detailOutput = t('skill.loaded', { name: skillName, tools: toolsList })
    
    executor.addStep({
      type: 'tool_result',
      content: simpleOutput,
      toolName: 'load_skill',
      // 仅调试模式下显示工具列表（不重复技能名）
      toolResult: config.debugMode && toolsList ? toolsList : undefined
    })
    
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

  executor.addStep({
    type: 'tool_call',
    content: t('user_skill.loading', { id: skillId }),
    toolName: 'load_user_skill',
    toolArgs: args,
    riskLevel: 'safe'
  })

  const userSkillService = getUserSkillService()
  const skill = userSkillService.getSkill(skillId)
  
  if (!skill) {
    const errorMsg = t('user_skill.not_found', { id: skillId })
    executor.addStep({
      type: 'tool_result',
      content: errorMsg,
      toolName: 'load_user_skill',
      toolResult: errorMsg
    })
    return { success: false, output: '', error: errorMsg }
  }
  
  if (!skill.enabled) {
    const errorMsg = t('user_skill.disabled', { id: skillId })
    executor.addStep({
      type: 'tool_result',
      content: errorMsg,
      toolName: 'load_user_skill',
      toolResult: errorMsg
    })
    return { success: false, output: '', error: errorMsg }
  }

  const content = userSkillService.getSkillContent(skillId)
  if (!content) {
    const errorMsg = t('user_skill.content_empty', { id: skillId })
    executor.addStep({
      type: 'tool_result',
      content: errorMsg,
      toolName: 'load_user_skill',
      toolResult: errorMsg
    })
    return { success: false, output: '', error: errorMsg }
  }

  const output = `## ${skill.name}\n\n${skill.description ? `> ${skill.description}\n\n` : ''}${content}`
  
  executor.addStep({
    type: 'tool_result',
    content: t('user_skill.loaded', { name: skill.name }),
    toolName: 'load_user_skill',
    toolResult: output
  })
  
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
  const title = typeof args.title === 'string' ? args.title : undefined

  if (!message || typeof message !== 'string') {
    return { success: false, output: '', error: t('im.tool_message_required') }
  }

  const deliveredVia: string[] = []
  // 与 AgentService.COMPANION_AGENT_ID 保持一致（不直接 import 以避免循环依赖）
  const companionAgentId = '__companion__'

  // 尝试通过 IM 渠道发送
  try {
    const { getIMService } = await import('../../im/im.service')
    const imService = getIMService()
    const lastContact = imService.getLastContact()

    if (lastContact) {
      executor.addStep({
        type: 'tool_call',
        content: t('im.tool_sending_notification', { platform: lastContact.platform }),
        toolName: 'talk_to_user',
        toolArgs: { message: message.substring(0, 100), title },
        riskLevel: 'safe'
      })

      const result = await imService.sendNotification(message, {
        markdown: !!title,
        title,
      })
      if (result.success) {
        deliveredVia.push(result.platform || 'IM')
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
    const output = t('im.tool_notification_sent', { platform: deliveredVia.join(', ') })
    executor.addStep({
      type: 'tool_result',
      content: t('im.tool_notification_sent_step', { platform: deliveredVia.join(', ') }),
      toolName: 'talk_to_user',
      toolResult: output
    })
    return { success: true, output }
  } else {
    const error = t('im.tool_no_contact')
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
  ptyId: string,
  args: Record<string, unknown>,
  toolCallId: string,
  config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  if (toolName.startsWith('excel_')) {
    return executeExcelTool(toolName, ptyId, args, toolCallId, config, executor)
  }

  if (toolName.startsWith('email_')) {
    return executeEmailTool(toolName, ptyId, args, toolCallId, config, executor)
  }

  if (toolName.startsWith('browser_')) {
    return executeBrowserTool(toolName, ptyId, args, toolCallId, config, executor)
  }

  if (toolName.startsWith('word_')) {
    return executeWordTool(toolName, ptyId, args, toolCallId, config, executor)
  }

  if (toolName.startsWith('calendar_') || toolName.startsWith('todo_')) {
    return executeCalendarTool(toolName, ptyId, args, toolCallId, config, executor)
  }

  if (toolName.startsWith('watch_')) {
    return executeWatchTool(toolName, ptyId, args, toolCallId, config, executor)
  }

  if (toolName.startsWith('config_') || toolName === 'im_connect') {
    return executeConfigTool(toolName, ptyId, args, toolCallId, config, executor)
  }

  if (toolName.startsWith('skill_')) {
    return executeSkillCreatorTool(toolName, ptyId, args, toolCallId, config, executor)
  }

  if (toolName.startsWith('personality_')) {
    return executePersonalityTool(toolName, ptyId, args, toolCallId, config, executor)
  }

  if (toolName.startsWith('pdf_')) {
    return executePdfTool(toolName, ptyId, args, toolCallId, config, executor)
  }

  return { success: false, output: '', error: t('error.unknown_tool', { name: toolName }) }
}
