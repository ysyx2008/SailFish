/**
 * 命令执行工具
 * 包括：执行命令、sudo 命令、限时命令、fire-and-forget 命令
 */
import stripAnsi from 'strip-ansi'
import { t } from '../i18n'
import { assessCommandRisk, analyzeCommand, isSudoCommand, detectPasswordPrompt } from '../risk-assessor'
import { getTerminalStateService } from '../../terminal-state.service'
import { getTerminalAwarenessService, getProcessMonitor } from '../../terminal-awareness'
import { getLastNLinesFromBuffer, getScreenAnalysisFromFrontend } from '../../screen-content.service'
import { categorizeError, getErrorRecoverySuggestion, withRetry, truncateFromEnd } from './utils'
import type { ToolExecutorConfig, AgentConfig, ToolResult } from './types'

/**
 * 执行命令
 */
export async function executeCommand(
  ptyId: string,
  args: Record<string, unknown>,
  toolCallId: string,
  config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  let command = args.command as string
  if (!command) {
    return { success: false, output: '', error: t('hint.command_empty') }
  }

  // 检查命令长度
  const MAX_COMMAND_LENGTH = 800
  if (command.length > MAX_COMMAND_LENGTH) {
    const errorMsg = t('hint.command_too_long', { length: command.length, max: MAX_COMMAND_LENGTH })
    executor.addStep({
      type: 'tool_call',
      content: `🚫 ${command.slice(0, 100)}...`,
      toolName: 'execute_command',
      toolArgs: { command: command.slice(0, 100) + '...' },
      riskLevel: 'blocked'
    })
    executor.addStep({
      type: 'tool_result',
      content: errorMsg,
      toolName: 'execute_command',
      toolResult: errorMsg
    })
    return { success: false, output: '', error: errorMsg }
  }

  // 先检查终端状态
  const awarenessService = getTerminalAwarenessService()
  const preAdvice = await awarenessService.getPreExecutionAdvice(ptyId, command)
  
  if (!preAdvice.canExecute) {
    const isBusy = preAdvice.reason?.includes('终端正在执行命令')
    
    if (isBusy) {
      const waitMsg = `⏳ ${t('hint.wait_terminal')}\n\n💡 ${t('hint.wait_suggestions')}`
      executor.addStep({
        type: 'tool_call',
        content: `⏳ ${command}`,
        toolName: 'execute_command',
        toolArgs: { command },
        riskLevel: 'safe'
      })
      executor.addStep({
        type: 'tool_result',
        content: t('status.terminal_busy'),
        toolName: 'execute_command',
        toolResult: waitMsg
      })
      return { success: false, output: waitMsg, error: waitMsg, isRunning: true }
    }
    
    const errorMsg = `⚠️ ${t('hint.cannot_execute_reason')}：${preAdvice.reason}\n\n💡 ${preAdvice.suggestion}`
    executor.addStep({
      type: 'tool_call',
      content: `🚫 ${command}`,
      toolName: 'execute_command',
      toolArgs: { command },
      riskLevel: 'blocked'
    })
    executor.addStep({
      type: 'tool_result',
      content: `${t('status.terminal_not_allowed')}: ${preAdvice.reason}`,
      toolName: 'execute_command',
      toolResult: errorMsg
    })
    return { success: false, output: '', error: errorMsg }
  }

  // 分析命令
  const handling = analyzeCommand(command)
  const strategy: 'allow' | 'auto_fix' | 'timed_execution' | 'fire_and_forget' | 'block' = handling.strategy

  // 策略1: 禁止执行
  if (strategy === 'block') {
    executor.addStep({
      type: 'tool_call',
      content: `🚫 ${command}`,
      toolName: 'execute_command',
      toolArgs: { command },
      riskLevel: 'blocked'
    })
    
    const errorMsg = `${t('hint.command_cannot_execute')}: ${handling.reason}。${handling.hint}`
    executor.addStep({
      type: 'tool_result',
      content: errorMsg,
      toolName: 'execute_command',
      toolResult: errorMsg
    })
    
    return { success: false, output: '', error: errorMsg }
  }

  // 策略2: 自动修正命令
  if (strategy === 'auto_fix' && handling.fixedCommand) {
    command = handling.fixedCommand
  }

  // 评估风险
  const riskLevel = assessCommandRisk(command)

  if (riskLevel === 'blocked') {
    return { 
      success: false, 
      output: '', 
      error: t('hint.security_blocked')
    }
  }

  // 根据执行模式决定是否需要确认
  let needConfirm = false
  if (config.executionMode === 'strict') {
    needConfirm = true
  } else if (config.executionMode === 'relaxed') {
    needConfirm = riskLevel === 'dangerous'
  }

  executor.addStep({
    type: 'tool_call',
    content: strategy === 'timed_execution'
      ? `⏱️ ${command} (${handling.hint})`
      : `${t('status.executing')}: ${command}`,
    toolName: 'execute_command',
    toolArgs: { command },
    riskLevel
  })

  let userApproved = false
  
  if (needConfirm) {
    const approved = await executor.waitForConfirmation(
      toolCallId, 
      'execute_command', 
      { command }, 
      riskLevel
    )
    if (!approved) {
      executor.addStep({
        type: 'tool_result',
        content: `⛔ ${t('status.user_rejected')}`,
        toolName: 'execute_command',
        toolResult: t('status.user_rejected')
      })
      return { success: false, output: '', error: t('error.user_rejected_command') }
    }
    userApproved = true
  }

  // 策略3: 限时执行
  if (strategy === 'timed_execution') {
    return executeTimedCommand(
      ptyId, 
      command, 
      handling.suggestedTimeout || 5000,
      handling.timeoutAction || 'ctrl_c',
      executor
    )
  }

  // 策略4: 发送即返回
  if (strategy === 'fire_and_forget') {
    return executeFireAndForget(ptyId, command, handling, executor)
  }

  // 策略5: sudo 命令
  if (isSudoCommand(command)) {
    return executeSudoCommand(ptyId, command, toolCallId, config, executor)
  }

  // 正常执行命令
  const terminalStateService = getTerminalStateService()
  
  terminalStateService.startCommandExecution(ptyId, command, {
    source: 'agent',
    agentStepTitle: (strategy as string) === 'timed_execution'
      ? `⏱️ ${command}`
      : command
  })
  
  const outputHandler = (data: string) => {
    terminalStateService.appendCommandOutput(ptyId, data)
  }
  const unsubscribe = executor.terminalService.onData(ptyId, outputHandler)
  
  try {
    const result = await withRetry(
      () => executor.terminalService.executeInTerminal(ptyId, command, config.commandTimeout),
      {
        maxRetries: 1,
        retryDelay: 500,
        shouldRetry: (err) => {
          const category = categorizeError(err.message)
          return category === 'transient'
        }
      }
    )

    const isTimeout = result.output.includes('[命令执行超时]')
    if (isTimeout) {
      let latestOutput = result.output
      try {
        const bufferLines = await getLastNLinesFromBuffer(ptyId, 50, 3000)
        if (bufferLines && bufferLines.length > 0) {
          latestOutput = stripAnsi(bufferLines.join('\n'))
        }
      } catch {
        // 获取失败则使用原始输出
      }
      
      const processMonitor = getProcessMonitor()
      const isLongRunningCommand = processMonitor.isKnownLongRunningCommand(command)
      
      if (isLongRunningCommand) {
        executor.addStep({
          type: 'tool_result',
          content: `⏳ ${t('status.command_running')} (${config.commandTimeout / 1000}${t('misc.seconds')})`,
          toolName: 'execute_command',
          toolResult: latestOutput + '\n\n💡 ' + t('hint.long_running_command')
        })
        return {
          success: true,
          output: latestOutput + '\n\n💡 ' + t('error.command_still_running'),
          isRunning: true
        }
      }
      
      const errorCategory = categorizeError('timeout')
      const suggestion = getErrorRecoverySuggestion('timeout', errorCategory)

      executor.addStep({
        type: 'tool_result',
        content: `⏱️ ${t('status.command_timeout')} (${config.commandTimeout / 1000}${t('misc.seconds')})`,
        toolName: 'execute_command',
        toolResult: latestOutput
      })
      return {
        success: false,
        output: latestOutput,
        error: t('error.command_timeout_with_hint', { suggestion })
      }
    }

    unsubscribe()
    terminalStateService.completeCommandExecution(ptyId, 0, 'completed')
    
    if (config.debugMode) {
      executor.addStep({
        type: 'tool_result',
        content: `${t('status.command_complete')} (${t('misc.duration')}: ${result.duration}ms)`,
        toolName: 'execute_command',
        toolResult: result.output
      })
    }

    const output = userApproved 
      ? `[${t('status.user_approved')}]\n${result.output}`
      : result.output
    return { success: true, output }
  } catch (error) {
    unsubscribe()
    terminalStateService.completeCommandExecution(ptyId, 1, 'failed')
    
    const errorMsg = error instanceof Error ? error.message : t('status.command_failed')
    const errorCategory = categorizeError(errorMsg)
    const suggestion = getErrorRecoverySuggestion(errorMsg, errorCategory)
    
    executor.addStep({
      type: 'tool_result',
      content: `${t('status.command_failed')}: ${errorMsg}`,
      toolName: 'execute_command',
      toolResult: `${errorMsg}\n\n💡 ${suggestion}`
    })
    return { success: false, output: '', error: t('error.recovery_hint', { error: errorMsg, suggestion }) }
  }
}

/**
 * 执行 sudo 命令
 */
async function executeSudoCommand(
  ptyId: string,
  command: string,
  toolCallId: string,
  config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const terminalStateService = getTerminalStateService()
  
  terminalStateService.startCommandExecution(ptyId, command)
  
  let output = ''
  let passwordPromptDetected = false
  let passwordStepId: string | null = null
  let lastOutputTime = Date.now()
  
  const outputHandler = (data: string) => {
    output += data
    lastOutputTime = Date.now()
    terminalStateService.appendCommandOutput(ptyId, data)
    
    if (!passwordPromptDetected) {
      const cleanOutput = stripAnsi(output)
      const detection = detectPasswordPrompt(cleanOutput)
      if (detection.detected) {
        passwordPromptDetected = true
        const step = executor.addStep({
          type: 'waiting_password',
          content: `${t('password.enter_in_terminal')}\n${t('password.prompt')}: ${detection.prompt || 'Password:'}`,
          toolName: 'execute_command',
          toolArgs: { command },
          riskLevel: 'moderate'
        })
        passwordStepId = step.id
      }
    }
  }
  const unsubscribe = executor.terminalService.onData(ptyId, outputHandler)
  
  executor.terminalService.write(ptyId, command + '\r')
  
  const sudoTimeout = 5 * 60 * 1000
  const startTime = Date.now()
  const pollInterval = 500
  let outputLengthAtPasswordPrompt = 0
  
  try {
    while (true) {
      if (executor.isAborted()) {
        unsubscribe()
        terminalStateService.completeCommandExecution(ptyId, 130, 'cancelled')
        return { success: false, output: stripAnsi(output), error: t('error.operation_aborted') }
      }
      
      const status = await executor.terminalService.getTerminalStatus(ptyId)
      const timeSinceLastOutput = Date.now() - lastOutputTime
      const elapsed = Date.now() - startTime
      
      if (passwordPromptDetected) {
        if (outputLengthAtPasswordPrompt === 0) {
          outputLengthAtPasswordPrompt = output.length
        }
        
        const cleanOutput = stripAnsi(output)
        
        const screenAnalysis = await getScreenAnalysisFromFrontend(ptyId, 1000)
        if (screenAnalysis) {
          if (screenAnalysis.input.type === 'prompt' && screenAnalysis.input.confidence > 0.7) {
            break
          }
          if (screenAnalysis.input.type !== 'password' && status.isIdle && timeSinceLastOutput > 500) {
            break
          }
        }
        
        const hasNewOutputAfterPrompt = output.length > outputLengthAtPasswordPrompt
        if (hasNewOutputAfterPrompt && status.isIdle && timeSinceLastOutput > 1000) {
          break
        }
        
        if (cleanOutput.includes('Sorry, try again') || 
            cleanOutput.includes('sudo: ') && cleanOutput.includes('incorrect password') ||
            cleanOutput.includes('Authentication failure') ||
            cleanOutput.includes('Permission denied')) {
          outputLengthAtPasswordPrompt = output.length
        }
        
        if (elapsed > sudoTimeout) {
          if (passwordStepId) {
            executor.updateStep(passwordStepId, {
              content: `${t('password.enter_in_terminal')}\n⏰ ${t('password.waiting_long')}`
            })
          }
        }
      } else {
        if (status.isIdle && timeSinceLastOutput > 1000) {
          break
        }
        
        if (elapsed > sudoTimeout) {
          unsubscribe()
          terminalStateService.completeCommandExecution(ptyId, 124, 'timeout')
          
          executor.addStep({
            type: 'tool_result',
            content: `⏱️ ${t('password.sudo_timeout')} (${sudoTimeout / 1000}${t('misc.seconds')})`,
            toolName: 'execute_command',
            toolResult: stripAnsi(output)
          })
          
          return {
            success: false,
            output: stripAnsi(output),
            error: t('error.check_terminal_status')
          }
        }
      }
      
      await new Promise(resolve => setTimeout(resolve, pollInterval))
    }
    
    unsubscribe()
    
    const cleanOutput = stripAnsi(output).replace(/\r/g, '').trim()
    
    terminalStateService.completeCommandExecution(ptyId, 0, 'completed')
    
    if (passwordStepId) {
      executor.updateStep(passwordStepId, {
        type: 'tool_result',
        content: t('password.verification_complete')
      })
    }
    
    if (config.debugMode) {
      executor.addStep({
        type: 'tool_result',
        content: t('status.command_complete'),
        toolName: 'execute_command',
        toolResult: cleanOutput
      })
    }
    
    return { success: true, output: cleanOutput }
    
  } catch (error) {
    unsubscribe()
    terminalStateService.completeCommandExecution(ptyId, 1, 'failed')
    
    const errorMsg = error instanceof Error ? error.message : t('status.command_failed')
    executor.addStep({
      type: 'tool_result',
      content: `${t('status.command_failed')}: ${errorMsg}`,
      toolName: 'execute_command',
      toolResult: errorMsg
    })
    return { success: false, output: '', error: errorMsg }
  }
}

/**
 * 执行"发送即返回"命令
 */
async function executeFireAndForget(
  ptyId: string,
  command: string,
  handling: { reason?: string; hint?: string },
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  executor.terminalService.write(ptyId, command + '\r')
  
  await new Promise(resolve => setTimeout(resolve, 1000))
  
  let initialOutput = ''
  try {
    const bufferLines = await getLastNLinesFromBuffer(ptyId, 20, 2000)
    if (bufferLines && bufferLines.length > 0) {
      initialOutput = stripAnsi(bufferLines.join('\n'))
    }
  } catch {
    // 获取失败，继续
  }
  
  const hint = handling.hint || '用 get_terminal_context 查看输出，用 send_control_key("ctrl+c") 停止'
  
  executor.addStep({
    type: 'tool_result',
    content: `🚀 ${handling.reason || t('status.command_started')}`,
    toolName: 'execute_command',
    toolResult: initialOutput ? t('command.initial_output', { output: truncateFromEnd(initialOutput, 300), hint }) : `💡 ${hint}`
  })
  
  return {
    success: true,
    output: initialOutput 
      ? `命令已启动，正在持续运行。\n\n初始输出:\n${initialOutput}\n\n💡 ${hint}`
      : `命令已启动，正在持续运行。\n\n💡 ${hint}`,
    isRunning: true
  }
}

/**
 * 执行限时命令
 */
async function executeTimedCommand(
  ptyId: string,
  command: string,
  timeout: number,
  exitAction: 'ctrl_c' | 'ctrl_d' | 'q',
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  return new Promise((resolve) => {
    let output = ''
    
    const dataHandler = (data: string) => {
      output += data
    }
    const unsubscribe = executor.terminalService.onData(ptyId, dataHandler)
    
    executor.terminalService.write(ptyId, command + '\r')
    
    setTimeout(async () => {
      unsubscribe()
      
      const exitKeys: Record<string, string> = {
        'ctrl_c': '\x03',
        'ctrl_d': '\x04',
        'q': 'q'
      }
      executor.terminalService.write(ptyId, exitKeys[exitAction])
      
      await new Promise(r => setTimeout(r, 500))
      
      if (exitAction === 'q') {
        executor.terminalService.write(ptyId, '\r')
        await new Promise(r => setTimeout(r, 200))
      }

      const cleanOutput = stripAnsi(output)
        .replace(/\r/g, '')
        .trim()

      const lines = cleanOutput.split('\n')
      const meaningfulLines = lines.filter((line, idx) => {
        if (idx === 0 && line.includes(command.slice(0, 20))) return false
        if (!line.trim()) return false
        if (/[$#%>❯]\s*$/.test(line)) return false
        return true
      })

      const finalOutput = meaningfulLines.join('\n').trim()
      const truncatedDisplay = truncateFromEnd(finalOutput, 500)

      executor.addStep({
        type: 'tool_result',
        content: `✓ ${t('timed.command_executed', { seconds: timeout/1000, chars: finalOutput.length })}`,
        toolName: 'execute_command',
        toolResult: truncatedDisplay
      })

      resolve({ 
        success: true, 
        output: finalOutput || t('command.no_output', { seconds: timeout/1000 })
      })
    }, timeout)
  })
}
