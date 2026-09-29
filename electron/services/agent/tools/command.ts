/**
 * 命令执行工具
 * 包括：执行命令、sudo 命令、限时命令、fire-and-forget 命令
 */
import stripAnsi from 'strip-ansi'
import { t } from '../i18n'
import { assessCommandRiskDetailed, analyzeCommand, isSudoCommand, detectPasswordPrompt } from '../risk-assessor'
import { auditContextFromConfig } from '../audit-context-from-config'
import { commandNeedsConfirm, isSubAgentBlocked, formatHardBlockedMessage } from '../command-audit/confirm-policy'
import { resolveCommandToolConfirmation } from '../allowlist/resolve-command-confirm'
import { getTerminalStateService } from '../../terminal-state.service'
import { getTerminalAwarenessService, getProcessMonitor } from '../../terminal-awareness'
import { getLastNLinesFromBuffer, getScreenAnalysisFromFrontend } from '../../screen-content.service'
import { categorizeError, getErrorRecoverySuggestion, withRetry, truncateFromEnd, getPtyMaxCommandLength } from './utils'
import { rejectOversizedCommand } from './command-persist'
import { externalizeToolOutput, externalizeFailedError } from '../tool-output-externalize'
import { lazyReconnectAfterDisconnect } from './pane-reconnect'
import { appendCappedTerminalOutput, collapseConsecutiveNuls } from '../../../utils/terminal-output-sanitize'
import type { ToolExecutorConfig, AgentConfig, ToolResult } from './types'

/** execute_command 输出上限（与 exec.OUTPUT_TRUNCATE 对齐），超上限全文落盘换指针 */
const COMMAND_OUTPUT_TRUNCATE = 16_384

/**
 * 命令输出的预算处理：超上限时全文落盘 scratch 换「指针 + 尾部摘录」
 * （命令输出的结论/报错通常在末尾），不做截断——截断的中间部分无法找回。
 * 上下文紧张时预算会收紧（如 85%+ 时只剩 25%），此时上限取 min(预算, 16KB)；
 * 无预算时回退到固定 16KB（保持向后兼容）。
 *
 * @throws 落盘失败时抛错（明确报错 + 建议缩小范围，禁止退回截断）
 * @internal 导出仅为单元测试，业务代码请用 executeCommand 等入口
 */
export async function applyCommandOutputBudget(raw: string, executor: ToolExecutorConfig): Promise<string> {
  const budget = executor.getToolOutputBudget?.()
  const maxChars = budget && budget.maxChars > 0
    ? Math.min(budget.maxChars, COMMAND_OUTPUT_TRUNCATE)
    : COMMAND_OUTPUT_TRUNCATE

  const trimmed = collapseConsecutiveNuls(raw).trim()
  try {
    const externalized = await externalizeToolOutput({ output: trimmed, maxChars, toolName: 'execute_command', excerpt: 'tail' })
    if (externalized) return externalized.text
  } catch (err) {
    throw new Error(externalizeFailedError(trimmed.length, err instanceof Error ? err.message : String(err)))
  }
  return trimmed
}

async function budgetCapturedOutput(raw: string, executor: ToolExecutorConfig): Promise<string> {
  try {
    return await applyCommandOutputBudget(raw, executor)
  } catch (budgetErr) {
    return t('tool_output.externalize_failed_after_success', {
      total: raw.length.toLocaleString(),
      reason: budgetErr instanceof Error ? budgetErr.message : String(budgetErr),
    })
  }
}

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

  // 检查命令长度（PTY canonical mode 下 MAX_CANON 截断风险，按平台/模式动态阈值）
  const isSsh = !!executor.getSshConfig?.(ptyId)
  const MAX_COMMAND_LENGTH = getPtyMaxCommandLength(isSsh)
  if (command.length > MAX_COMMAND_LENGTH) {
    return rejectOversizedCommand({
      command,
      maxChars: MAX_COMMAND_LENGTH,
      toolName: 'execute_command',
      executor,
      remotePtyId: isSsh ? ptyId : undefined,
    })
  }

  // 先检查终端状态
  const awarenessService = getTerminalAwarenessService()
  const preAdvice = await awarenessService.getPreExecutionAdvice(ptyId, command)
  
  if (!preAdvice.canExecute) {
    const isBusy = preAdvice.reason?.includes('终端正在执行命令')
    
    if (isBusy) {
      const suggestion = preAdvice.suggestion || t('hint.wait_suggestions')
      const waitMsg = `⏳ ${t('hint.wait_terminal')}\n\n💡 ${suggestion}`
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
  const assessment = await assessCommandRiskDetailed(command, auditContextFromConfig(config))

  if (assessment.level === 'blocked') {
    return { success: false, output: '', error: formatHardBlockedMessage(assessment, command) }
  }

  if (isSubAgentBlocked(assessment, config.commandRiskPolicy) && executor.isSubAgent) {
    return { success: false, output: '', error: t('dispatch.command_blocked', { command }) }
  }

  const needConfirm = commandNeedsConfirm(assessment, config.executionMode, config.commandRiskPolicy)
  const riskLevel = assessment.level

  executor.addStep({
    type: 'tool_call',
    content: strategy === 'timed_execution'
      ? `⏱️ ${command} (${handling.hint})`
      : `${t('status.executing')}: ${command}`,
    toolName: 'execute_command',
    toolArgs: { command },
    riskLevel
  })

  if (needConfirm) {
    const confirm = await resolveCommandToolConfirmation(
      'execute_command',
      { command },
      assessment,
      config,
      toolCallId,
      riskLevel,
      executor,
    )
    if (!confirm.proceed) {
      executor.addStep({
        type: 'tool_result',
        content: `⛔ ${t('status.user_rejected')}`,
        toolName: 'execute_command',
        toolResult: t('status.user_rejected'),
        rejected: true
      })
      return confirm.result
    }
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

    // 窗格不存在：先尝试 SSH 懒重连（可见、不重跑命令）；窗格已关则 paneGone
    if (result.status === 'no_instance') {
      unsubscribe()
      terminalStateService.completeCommandExecution(ptyId, 1, 'failed')
      const goneResult = await lazyReconnectAfterDisconnect(result.ptyId, executor)
      executor.addStep({
        type: 'tool_result',
        content: `⚠️ ${goneResult.briefError || goneResult.error}`,
        toolName: 'execute_command',
        toolResult: goneResult.briefError || goneResult.error
      })
      return goneResult
    }

    const isTimeout = result.status === 'timeout'
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
      
      // 运行时检测：进程还在跑就不算"超时错误"，区分有输出/无输出给不同提示
      let runtimeStatus: 'active' | 'waiting' | 'unknown' = 'unknown'
      if (!isLongRunningCommand) {
        try {
          const RECENT_OUTPUT_THRESHOLD_MS = 5000
          const processState = await processMonitor.getProcessState(ptyId)
          const isRunning = processState.status === 'running_streaming'
            || processState.status === 'running_silent'
            || processState.status === 'running_interactive'
          if (isRunning) {
            const hasRecentOutput = processState.status === 'running_streaming'
              || (processState.outputRate !== undefined && processState.outputRate > 0)
              || (processState.lastOutputTime !== undefined && Date.now() - processState.lastOutputTime < RECENT_OUTPUT_THRESHOLD_MS)
            runtimeStatus = hasRecentOutput ? 'active' : 'waiting'
          }
        } catch {
          // 检测失败走 unknown，回退到原有超时逻辑
        }
      }

      latestOutput = await budgetCapturedOutput(latestOutput, executor)

      if (isLongRunningCommand || runtimeStatus === 'active') {
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

      if (runtimeStatus === 'waiting') {
        const hint = t('hint.command_may_wait_input')
        executor.addStep({
          type: 'tool_result',
          content: `⏳ ${t('status.command_running')} (${config.commandTimeout / 1000}${t('misc.seconds')})`,
          toolName: 'execute_command',
          toolResult: latestOutput + '\n\n💡 ' + hint
        })
        return {
          success: true,
          output: latestOutput + '\n\n💡 ' + hint,
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

    // 检测 shell 续行提示符（如 dquote>、quote> 等）
    // 这些表示命令中有未闭合的引号/括号，shell 在等待更多输入
    const continuationPromptDetected = detectContinuationPrompt(result.output)
    if (continuationPromptDetected) {
      // 发送 Ctrl+C 恢复终端到正常状态，等待 shell 处理中断信号
      executor.terminalService.write(ptyId, '\x03')
      const CTRL_C_RECOVERY_MS = 300
      await new Promise(r => setTimeout(r, CTRL_C_RECOVERY_MS))

      terminalStateService.completeCommandExecution(ptyId, 1, 'failed')
      const errorMsg = t('error.continuation_prompt', { prompt: continuationPromptDetected })
      executor.addStep({
        type: 'tool_result',
        content: `⚠️ ${errorMsg}`,
        toolName: 'execute_command',
        toolResult: errorMsg
      })
      return {
        success: false,
        output: result.output,
        error: errorMsg
      }
    }

    terminalStateService.completeCommandExecution(ptyId, 0, 'completed')

    // 按上下文预算处理输出：超预算全文落盘换指针。
    // 落盘失败必须就地消化——命令已成功，若抛给外层 catch 会把终端状态错误覆盖成 failed，
    // 还会让 AI 误以为命令没执行（对非幂等命令可能重复执行）
    const rawOutput = result.output
    let output: string
    try {
      output = await applyCommandOutputBudget(rawOutput, executor)
    } catch (budgetErr) {
      output = t('tool_output.externalize_failed_after_success', {
        total: rawOutput.length.toLocaleString(),
        reason: budgetErr instanceof Error ? budgetErr.message : String(budgetErr)
      })
    }

    executor.addStep({
      type: 'tool_result',
      content: `${t('status.command_complete')} (${t('misc.duration')}: ${result.duration}ms)`,
      toolName: 'execute_command',
      toolResult: output
    })

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
    output = appendCappedTerminalOutput(output, data)
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

  // 写入失败说明窗格已经不存在了——若不立刻 bail，下面的轮询会一直空转直到 sudoTimeout
  if (!executor.terminalService.write(ptyId, command + '\r')) {
    unsubscribe()
    terminalStateService.completeCommandExecution(ptyId, 1, 'failed')
    const result = await lazyReconnectAfterDisconnect(ptyId, executor)
    executor.addStep({
      type: 'tool_result',
      content: `⚠️ ${result.briefError || result.error}`,
      toolName: 'execute_command',
      toolResult: result.briefError || result.error
    })
    return result
  }

  const sudoTimeout = 5 * 60 * 1000
  const startTime = Date.now()
  const pollInterval = 500
  let outputLengthAtPasswordPrompt = 0
  
  try {
    // eslint-disable-next-line no-constant-condition
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
          const sudoOut = await budgetCapturedOutput(stripAnsi(output), executor)
          
          executor.addStep({
            type: 'tool_result',
            content: `⏱️ ${t('password.sudo_timeout')} (${sudoTimeout / 1000}${t('misc.seconds')})`,
            toolName: 'execute_command',
            toolResult: sudoOut
          })
          
          return {
            success: false,
            output: sudoOut,
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

    // 与 executeCommand 同理：落盘失败就地消化，不能把已成功的命令覆盖成 failed
    let sudoOutput: string
    try {
      sudoOutput = await applyCommandOutputBudget(cleanOutput, executor)
    } catch (budgetErr) {
      sudoOutput = t('tool_output.externalize_failed_after_success', {
        total: cleanOutput.length.toLocaleString(),
        reason: budgetErr instanceof Error ? budgetErr.message : String(budgetErr)
      })
    }

    executor.addStep({
      type: 'tool_result',
      content: t('status.command_complete'),
      toolName: 'execute_command',
      toolResult: sudoOutput
    })

    return { success: true, output: sudoOutput }
    
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
  // 写入失败说明窗格已不存在；不能再骗 Agent "命令已启动"——把这条转成明确错误
  if (!executor.terminalService.write(ptyId, command + '\r')) {
    const result = await lazyReconnectAfterDisconnect(ptyId, executor)
    executor.addStep({
      type: 'tool_result',
      content: `⚠️ ${result.briefError || result.error}`,
      toolName: 'execute_command',
      toolResult: result.briefError || result.error
    })
    return result
  }

  await new Promise(resolve => setTimeout(resolve, 1000))
  
  let initialOutput = ''
  try {
    const bufferLines = await getLastNLinesFromBuffer(ptyId, 20, 2000)
    if (bufferLines && bufferLines.length > 0) {
      initialOutput = await budgetCapturedOutput(stripAnsi(bufferLines.join('\n')), executor)
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
      output = appendCappedTerminalOutput(output, data)
    }
    const unsubscribe = executor.terminalService.onData(ptyId, dataHandler)

    // 写入失败说明窗格已不存在；放弃后续的等待 + 退出键序列，直接报错
    if (!executor.terminalService.write(ptyId, command + '\r')) {
      unsubscribe()
      lazyReconnectAfterDisconnect(ptyId, executor)
        .then(result => {
          executor.addStep({
            type: 'tool_result',
            content: `⚠️ ${result.briefError || result.error}`,
            toolName: 'execute_command',
            toolResult: result.briefError || result.error
          })
          resolve(result)
        })
        .catch(err => {
          resolve({
            success: false,
            output: '',
            error: err instanceof Error ? err.message : String(err)
          })
        })
      return
    }

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

      const finalOutput = await budgetCapturedOutput(meaningfulLines.join('\n').trim(), executor)

      executor.addStep({
        type: 'tool_result',
        content: `✓ ${t('timed.command_executed', { seconds: timeout/1000, chars: finalOutput.length })}`,
        toolName: 'execute_command',
        toolResult: finalOutput
      })

      resolve({ 
        success: true, 
        output: finalOutput || t('command.no_output', { seconds: timeout/1000 })
      })
    }, timeout)
  })
}

/**
 * 检测命令输出中是否包含 shell 续行提示符
 * zsh 的续行提示符格式为 "xxx>"，如 dquote>、quote>、cmdsubst> 等
 * 这些出现时表示命令有未闭合的引号/括号/语法结构
 * 
 * @returns 匹配到的续行提示符，如 "dquote>"；未匹配返回 null
 */
function detectContinuationPrompt(output: string): string | null {
  const cleanOutput = stripAnsi(output).replace(/\r/g, '')
  const lines = cleanOutput.split('\n').filter(l => l.trim())
  
  // 检查最后几行（续行提示符通常出现在输出末尾）
  const lastLines = lines.slice(-3)
  const pattern = /^(dquote|quote|bquote|cmdsubst|heredoc|pipe|then|do|else|elif|while|until|for|repeat|brace|subshell)(\s\w+)*>\s*$/

  for (const line of lastLines) {
    const trimmed = line.trim()
    if (pattern.test(trimmed)) {
      return trimmed
    }
  }
  return null
}
