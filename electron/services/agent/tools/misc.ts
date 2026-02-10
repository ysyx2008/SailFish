/**
 * 其他工具
 * 包括：等待、向用户提问、MCP 工具、技能工具
 */
import { t } from '../i18n'
import { executeExcelTool } from '../skills/excel/executor'
import { executeEmailTool } from '../skills/email/executor'
import { executeBrowserTool } from '../skills/browser/executor'
import { executeWordTool } from '../skills/word/executor'
import { executeCalendarTool } from '../skills/calendar/executor'
import { executeSchedulerTool } from '../skills/scheduler/executor'
import { executeSkillCreatorTool } from '../skills/skill-creator/executor'
import { getUserSkillService } from '../../user-skill.service'
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
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const skillId = args.skill_id as string
  
  if (!skillId) {
    return { success: false, output: '', error: t('skill.id_required') }
  }

  if (!executor.skillSession) {
    return { success: false, output: '', error: t('skill.session_not_initialized') }
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
    // 简化显示用于 UI，完整信息放在气泡详情里
    const simpleOutput = t('skill.loaded_simple', { name: skillName })
    const detailOutput = t('skill.loaded', { name: skillName, tools: toolsList })
    
    executor.addStep({
      type: 'tool_result',
      content: simpleOutput,
      toolName: 'load_skill',
      toolResult: detailOutput
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

  if (toolName.startsWith('schedule_')) {
    return executeSchedulerTool(toolName, ptyId, args, toolCallId, config, executor)
  }

  if (toolName.startsWith('skill_')) {
    return executeSkillCreatorTool(toolName, ptyId, args, toolCallId, config, executor)
  }
  
  return { success: false, output: '', error: t('error.unknown_tool', { name: toolName }) }
}
