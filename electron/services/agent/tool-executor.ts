/**
 * Agent 工具执行器
 */
import * as fs from 'fs'
import * as path from 'path'
import stripAnsi from 'strip-ansi'
import type { ToolCall } from '../ai.service'
import type { McpService } from '../mcp.service'
import type { 
  AgentConfig, 
  AgentStep, 
  ToolResult, 
  RiskLevel,
  PendingConfirmation,
  HostProfileServiceInterface 
} from './types'
import { assessCommandRisk, analyzeCommand, isSudoCommand, detectPasswordPrompt } from './risk-assessor'
import { getKnowledgeService } from '../knowledge'
import { getTerminalStateService } from '../terminal-state.service'
import { getTerminalAwarenessService, getProcessMonitor } from '../terminal-awareness'
import { getLastNLinesFromBuffer, getScreenAnalysisFromFrontend } from '../screen-content.service'
import type { UnifiedTerminalInterface } from '../unified-terminal.service'

// 错误分类
type ErrorCategory = 'transient' | 'permission' | 'not_found' | 'timeout' | 'fatal'

/**
 * 分析错误类型
 */
function categorizeError(error: string): ErrorCategory {
  const errorLower = error.toLowerCase()
  
  // 暂时性错误（可重试）
  if (errorLower.includes('connection reset') ||
      errorLower.includes('network') ||
      errorLower.includes('temporarily') ||
      errorLower.includes('busy') ||
      errorLower.includes('try again')) {
    return 'transient'
  }
  
  // 权限错误
  if (errorLower.includes('permission denied') ||
      errorLower.includes('access denied') ||
      errorLower.includes('not permitted') ||
      errorLower.includes('operation not allowed')) {
    return 'permission'
  }
  
  // 资源不存在
  if (errorLower.includes('not found') ||
      errorLower.includes('no such file') ||
      errorLower.includes('does not exist') ||
      errorLower.includes('command not found')) {
    return 'not_found'
  }
  
  // 超时
  if (errorLower.includes('timeout') ||
      errorLower.includes('timed out')) {
    return 'timeout'
  }
  
  return 'fatal'
}

/**
 * 获取错误恢复建议
 */
function getErrorRecoverySuggestion(error: string, category: ErrorCategory): string {
  switch (category) {
    case 'transient':
      return '这是一个暂时性错误，可以稍后重试。'
    case 'permission':
      return '权限不足。建议：1) 检查文件/目录权限；2) 尝试使用 sudo（如果合适）；3) 确认用户是否有相应权限。'
    case 'not_found':
      return '资源不存在。建议：1) 检查路径是否正确；2) 使用 ls 或 find 确认文件位置；3) 检查命令是否已安装。'
    case 'timeout':
      return '命令执行超时，但可能仍在运行中。建议：1) 先用 check_terminal_status 确认是否还在执行；2)  再用 get_terminal_context 查看终端最新输出，了解执行进度；3) 如果确实卡住了再用 send_control_key 发送 Ctrl+C。'
    case 'fatal':
      return '执行失败。请分析错误信息，考虑更换方法或向用户请求帮助。'
  }
}

/**
 * 带重试的异步执行
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries?: number
    retryDelay?: number
    shouldRetry?: (error: Error) => boolean
  } = {}
): Promise<T> {
  const { maxRetries = 2, retryDelay = 1000, shouldRetry } = options
  
  let lastError: Error | null = null
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error as Error
      
      // 检查是否应该重试
      if (attempt < maxRetries) {
        const category = categorizeError(lastError.message)
        const canRetry = category === 'transient' || category === 'timeout'
        
        if (shouldRetry ? shouldRetry(lastError) : canRetry) {
          // 指数退避
          const delay = retryDelay * Math.pow(2, attempt)
          await new Promise(resolve => setTimeout(resolve, delay))
          continue
        }
      }
      
      throw lastError
    }
  }
  
  throw lastError
}

// 工具执行器配置
export interface ToolExecutorConfig {
  /** 统一终端服务（支持 PTY 和 SSH） */
  terminalService: UnifiedTerminalInterface
  hostProfileService?: HostProfileServiceInterface
  mcpService?: McpService
  addStep: (step: Omit<AgentStep, 'id' | 'timestamp'>) => AgentStep
  updateStep: (stepId: string, updates: Partial<Omit<AgentStep, 'id' | 'timestamp'>>) => void
  waitForConfirmation: (
    toolCallId: string,
    toolName: string,
    toolArgs: Record<string, unknown>,
    riskLevel: RiskLevel
  ) => Promise<boolean>
  isAborted: () => boolean
  getHostId: () => string | undefined
  hasPendingUserMessage: () => boolean  // 检查是否有待处理的用户消息
  peekPendingUserMessage: () => string | undefined  // 查看（不消费）第一条待处理消息
  consumePendingUserMessage: () => string | undefined  // 消费并返回第一条待处理消息
  getRealtimeTerminalOutput: () => string[]  // 获取实时终端输出（Agent 运行期间收集）
}

/**
 * 执行工具调用
 */
export async function executeTool(
  ptyId: string,
  toolCall: ToolCall,
  config: AgentConfig,
  terminalOutput: string[],
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  if (executor.isAborted()) {
    return { success: false, output: '', error: '操作已中止' }
  }

  const { name, arguments: argsStr } = toolCall.function
  let args: Record<string, unknown>
  
  try {
    args = JSON.parse(argsStr)
  } catch {
    return { success: false, output: '', error: '工具参数解析失败' }
  }

  // 根据工具类型执行
  switch (name) {
    case 'execute_command':
      return executeCommand(ptyId, args, toolCall.id, config, executor)

    case 'get_terminal_context':
      return await getTerminalContext(ptyId, args, executor)

    case 'check_terminal_status':
      return checkTerminalStatus(ptyId, executor)

    case 'send_control_key':
      return sendControlKey(ptyId, args, executor)

    case 'send_input':
      return sendInput(ptyId, args, executor)

    case 'read_file':
      return readFile(ptyId, args, executor)

    case 'write_file':
      return writeFile(ptyId, args, toolCall.id, executor)

    case 'remember_info':
      return rememberInfo(args, executor)

    case 'search_knowledge':
      return searchKnowledge(args, executor)

    case 'wait':
      return wait(args, executor)

    case 'ask_user':
      return askUser(args, executor)

    default:
      // 检查是否是 MCP 工具调用
      if (name.startsWith('mcp_') && executor.mcpService) {
        return executeMcpTool(name, args, toolCall.id, executor)
      }
      return { success: false, output: '', error: `未知工具: ${name}` }
  }
}

/**
 * 执行 MCP 工具
 */
async function executeMcpTool(
  fullName: string,
  args: Record<string, unknown>,
  toolCallId: string,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  if (!executor.mcpService) {
    return { success: false, output: '', error: 'MCP 服务未初始化' }
  }

  // 解析工具名称: mcp_{serverId}_{toolName}
  const parsed = executor.mcpService.parseToolCallName(fullName)
  if (!parsed) {
    return { success: false, output: '', error: `无效的 MCP 工具名称: ${fullName}` }
  }

  const { serverId, toolName } = parsed

  // 检查服务器是否已连接
  if (!executor.mcpService.isConnected(serverId)) {
    return { success: false, output: '', error: `MCP 服务器 ${serverId} 未连接` }
  }

  // 添加工具调用步骤
  executor.addStep({
    type: 'tool_call',
    content: `[MCP] 调用工具: ${toolName}`,
    toolName: fullName,
    toolArgs: args,
    riskLevel: 'moderate'
  })

  try {
    const result = await executor.mcpService.callTool(serverId, toolName, args)

    if (result.success) {
      // UI 显示截断到 500 字符（保留最新内容），但返回给 agent 的 output 是完整的
      const displayContent = result.content || ''
      const truncatedDisplay = displayContent.length > 500
        ? truncateFromEnd(displayContent, 500)
        : displayContent
      
      executor.addStep({
        type: 'tool_result',
        content: `[MCP] 工具执行成功 (${displayContent.length} 字符)`,
        toolName: fullName,
        toolResult: truncatedDisplay
      })
      // 返回完整内容给 agent，不进行截断
      return { success: true, output: result.content || '' }
    } else {
      executor.addStep({
        type: 'tool_result',
        content: `[MCP] 工具执行失败: ${result.error}`,
        toolName: fullName,
        toolResult: result.error
      })
      return { success: false, output: '', error: result.error }
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'MCP 工具执行失败'
    executor.addStep({
      type: 'tool_result',
      content: `[MCP] 错误: ${errorMsg}`,
      toolName: fullName,
      toolResult: errorMsg
    })
    return { success: false, output: '', error: errorMsg }
  }
}

/**
 * 执行命令
 */
async function executeCommand(
  ptyId: string,
  args: Record<string, unknown>,
  toolCallId: string,
  config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  let command = args.command as string
  if (!command) {
    return { success: false, output: '', error: '命令不能为空' }
  }

  // 先检查终端状态，确认是否可以执行命令
  const awarenessService = getTerminalAwarenessService()
  const preAdvice = await awarenessService.getPreExecutionAdvice(ptyId, command)
  
  if (!preAdvice.canExecute) {
    // 终端当前不能执行命令，返回详细信息给 agent
    const errorMsg = `⚠️ 无法执行命令：${preAdvice.reason}\n\n💡 ${preAdvice.suggestion}`
    executor.addStep({
      type: 'tool_call',
      content: `🚫 ${command}`,
      toolName: 'execute_command',
      toolArgs: { command },
      riskLevel: 'blocked'
    })
    executor.addStep({
      type: 'tool_result',
      content: `终端状态不允许执行: ${preAdvice.reason}`,
      toolName: 'execute_command',
      toolResult: errorMsg
    })
    return { success: false, output: '', error: errorMsg }
  }

  // 分析命令，获取处理策略
  const handling = analyzeCommand(command)

  // 策略1: 禁止执行（如 vim/nano 等全屏编辑器）
  if (handling.strategy === 'block') {
    executor.addStep({
      type: 'tool_call',
      content: `🚫 ${command}`,
      toolName: 'execute_command',
      toolArgs: { command },
      riskLevel: 'blocked'
    })
    
    const errorMsg = `无法执行: ${handling.reason}。${handling.hint}`
    executor.addStep({
      type: 'tool_result',
      content: errorMsg,
      toolName: 'execute_command',
      toolResult: errorMsg
    })
    
    return { success: false, output: '', error: errorMsg }
  }

  // 策略2: 自动修正命令（如添加 -y、-c 参数）
  if (handling.strategy === 'auto_fix' && handling.fixedCommand) {
    command = handling.fixedCommand
  }

  // 评估风险
  const riskLevel = assessCommandRisk(command)

  // 检查是否被安全策略阻止
  if (riskLevel === 'blocked') {
    return { 
      success: false, 
      output: '', 
      error: '该命令被安全策略阻止执行' 
    }
  }

  // 严格模式：所有命令都需要确认（包括自动修正和限时执行的命令）
  // 普通模式：根据风险级别决定，自动修正和限时执行的命令可以自动执行
  const needConfirm = config.strictMode || (
    handling.strategy === 'allow' && (
      (riskLevel === 'dangerous') ||
      (riskLevel === 'moderate' && !config.autoExecuteModerate) ||
      (riskLevel === 'safe' && !config.autoExecuteSafe)
    )
  )

  // 添加工具调用步骤（统一显示最终要执行的命令）
  executor.addStep({
    type: 'tool_call',
    content: handling.strategy === 'timed_execution'
      ? `⏱️ ${command} (${handling.hint})`
      : `执行命令: ${command}`,
    toolName: 'execute_command',
    toolArgs: { command },
    riskLevel
  })

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
        content: '⛔ 用户拒绝执行此命令',
        toolName: 'execute_command',
        toolResult: '已拒绝'
      })
      return { success: false, output: '', error: '用户拒绝执行该命令' }
    }
  }

  // 策略3: 限时执行（保留用于特殊场景）
  if (handling.strategy === 'timed_execution') {
    return executeTimedCommand(
      ptyId, 
      command, 
      handling.suggestedTimeout || 5000,
      handling.timeoutAction || 'ctrl_c',
      executor
    )
  }

  // 策略4: 发送即返回（如 tail -f、ping、top 等持续运行的命令）
  if (handling.strategy === 'fire_and_forget') {
    return executeFireAndForget(ptyId, command, handling, executor)
  }

  // 策略4: sudo/特权命令 - 需要等待用户输入密码
  if (isSudoCommand(command)) {
    return executeSudoCommand(ptyId, command, toolCallId, config, executor)
  }

  // 正常执行命令（带重试机制）
  // 使用 terminal-state.service 追踪命令执行，以便 get_terminal_context 可以获取实时输出
  const terminalStateService = getTerminalStateService()
  
  // 开始追踪命令执行
  terminalStateService.startCommandExecution(ptyId, command)
  
  // 注册输出监听器，将输出实时同步到 terminal-state.service
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

    // 检测是否超时
    const isTimeout = result.output.includes('[命令执行超时]')
    if (isTimeout) {
      // 超时：不移除监听器，不完成追踪（命令可能还在运行）
      // 这样后续调用 get_terminal_context 仍能获取到新输出
      
      // 从 xterm buffer 获取最后 50 行作为超时时的输出（避免用户翻页导致可视区域不准确）
      let latestOutput = result.output
      try {
        const bufferLines = await getLastNLinesFromBuffer(ptyId, 50, 3000)
        if (bufferLines && bufferLines.length > 0) {
          latestOutput = stripAnsi(bufferLines.join('\n'))
        }
      } catch {
        // 获取失败则使用原始输出
      }
      
      // 检查是否是长耗时命令（构建、编译等）
      const processMonitor = getProcessMonitor()
      const isLongRunningCommand = processMonitor.isKnownLongRunningCommand(command)
      
      if (isLongRunningCommand) {
        // 长耗时命令超时：这是正常的，不算失败
        // 返回 isRunning: true，告诉反思追踪不要计入失败
        executor.addStep({
          type: 'tool_result',
          content: `⏳ 命令仍在执行中 (已超过 ${config.commandTimeout / 1000}秒)`,
          toolName: 'execute_command',
          toolResult: latestOutput + '\n\n💡 这是一个长耗时命令，超时不代表失败。建议使用 wait 工具等待一段时间后再检查状态。'
        })
        return {
          success: true,  // 长耗时命令超时不算失败
          output: latestOutput + '\n\n💡 命令仍在后台执行中。建议：\n1. 使用 wait 工具等待一段时间（如 60-180 秒）\n2. 然后使用 check_terminal_status 确认执行状态\n3. 使用 get_terminal_context 查看最新输出',
          isRunning: true  // 标记命令仍在运行
        }
      }
      
      // 普通命令超时：可能有问题
      const errorCategory = categorizeError('timeout')
      const suggestion = getErrorRecoverySuggestion('timeout', errorCategory)

      executor.addStep({
        type: 'tool_result',
        content: `⏱️ 命令执行超时 (${config.commandTimeout / 1000}秒)`,
        toolName: 'execute_command',
        toolResult: latestOutput
      })
      return {
        success: false,
        output: latestOutput,
        error: `命令执行超时。${suggestion}`
      }
    }

    // 命令正常完成，移除监听器并完成追踪
    unsubscribe()
    terminalStateService.completeCommandExecution(ptyId, 0, 'completed')
    
    executor.addStep({
      type: 'tool_result',
      content: `命令执行完成 (耗时: ${result.duration}ms)`,
      toolName: 'execute_command',
      toolResult: result.output
    })

    return { success: true, output: result.output }
  } catch (error) {
    // 命令执行出错，移除监听器并完成追踪
    unsubscribe()
    terminalStateService.completeCommandExecution(ptyId, 1, 'failed')
    
    const errorMsg = error instanceof Error ? error.message : '命令执行失败'
    const errorCategory = categorizeError(errorMsg)
    const suggestion = getErrorRecoverySuggestion(errorMsg, errorCategory)
    
    executor.addStep({
      type: 'tool_result',
      content: `命令执行失败: ${errorMsg}`,
      toolName: 'execute_command',
      toolResult: `${errorMsg}\n\n💡 ${suggestion}`
    })
    return { success: false, output: '', error: `${errorMsg}\n\n💡 恢复建议: ${suggestion}` }
  }
}

/**
 * 执行需要特权提升的命令（sudo/su 等）
 * 检测密码提示并等待用户在终端中输入密码
 */
async function executeSudoCommand(
  ptyId: string,
  command: string,
  toolCallId: string,
  config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const terminalStateService = getTerminalStateService()
  
  // 开始追踪命令执行
  terminalStateService.startCommandExecution(ptyId, command)
  
  // 输出收集
  let output = ''
  let passwordPromptDetected = false
  let passwordStepId: string | null = null
  let lastOutputTime = Date.now()
  
  // 注册输出监听器
  const outputHandler = (data: string) => {
    output += data
    lastOutputTime = Date.now()
    terminalStateService.appendCommandOutput(ptyId, data)
    
    // 检测密码提示（只检测一次）
    if (!passwordPromptDetected) {
      const cleanOutput = stripAnsi(output)
      const detection = detectPasswordPrompt(cleanOutput)
      if (detection.detected) {
        passwordPromptDetected = true
        // 添加密码等待步骤
        const step = executor.addStep({
          type: 'waiting_password',
          content: `请在终端中输入密码\n提示: ${detection.prompt || 'Password:'}`,
          toolName: 'execute_command',
          toolArgs: { command },
          riskLevel: 'moderate'
        })
        passwordStepId = step.id
      }
    }
  }
  const unsubscribe = executor.terminalService.onData(ptyId, outputHandler)
  
  // 发送命令到终端（不等待完成）
  executor.terminalService.write(ptyId, command + '\r')
  
  // sudo 命令的超时时间：5分钟（等待用户输入密码）
  const sudoTimeout = 5 * 60 * 1000
  const startTime = Date.now()
  const pollInterval = 500  // 每 500ms 检查一次
  
  // 记录检测到密码提示时的输出长度，用于判断用户是否已输入
  let outputLengthAtPasswordPrompt = 0
  
  try {
    // 轮询等待命令完成
    while (true) {
      // 检查是否被中止
      if (executor.isAborted()) {
        unsubscribe()
        terminalStateService.completeCommandExecution(ptyId, 130, 'cancelled')
        return { success: false, output: stripAnsi(output), error: '操作已中止' }
      }
      
      // 检查终端是否回到空闲状态（命令执行完成）
      const status = await executor.terminalService.getTerminalStatus(ptyId)
      const timeSinceLastOutput = Date.now() - lastOutputTime
      const elapsed = Date.now() - startTime
      
      // 如果检测到密码提示，需要等待用户输入
      if (passwordPromptDetected) {
        // 记录检测到密码时的输出长度
        if (outputLengthAtPasswordPrompt === 0) {
          outputLengthAtPasswordPrompt = output.length
        }
        
        // 判断用户是否已输入密码：有新的输出产生（不只是密码提示）
        const hasNewOutputAfterPrompt = output.length > outputLengthAtPasswordPrompt + 10
        
        // 只有在用户输入密码后（有新输出），且终端空闲时才认为完成
        if (hasNewOutputAfterPrompt && status.isIdle && timeSinceLastOutput > 1000) {
          break
        }
        
        // 检查是否用户取消了（Ctrl+C 会产生特定输出或终端回到空闲但无新输出）
        const cleanOutput = stripAnsi(output)
        if (cleanOutput.includes('Sorry, try again') || 
            cleanOutput.includes('sudo: ') && cleanOutput.includes('incorrect password') ||
            cleanOutput.includes('Authentication failure') ||
            cleanOutput.includes('Permission denied')) {
          // 密码错误或认证失败，继续等待（可能会再次提示输入）
          outputLengthAtPasswordPrompt = output.length  // 重置，等待下一次输入
        }
        
        // 超时处理（等待密码的超时）
        if (elapsed > sudoTimeout) {
          if (passwordStepId) {
            executor.updateStep(passwordStepId, {
              content: `请在终端中输入密码\n⏰ 已等待较长时间，请尽快输入或按 Ctrl+C 取消`
            })
          }
        }
      } else {
        // 未检测到密码提示的正常流程
        // 命令完成的判断：终端空闲且超过 1 秒没有新输出
        if (status.isIdle && timeSinceLastOutput > 1000) {
          break
        }
        
        // 检查超时
        if (elapsed > sudoTimeout) {
          // 超时处理
          unsubscribe()
          terminalStateService.completeCommandExecution(ptyId, 124, 'timeout')
          
          executor.addStep({
            type: 'tool_result',
            content: `⏱️ sudo 命令执行超时 (${sudoTimeout / 1000}秒)`,
            toolName: 'execute_command',
            toolResult: stripAnsi(output)
          })
          
          return {
            success: false,
            output: stripAnsi(output),
            error: '命令执行超时。请检查终端状态。'
          }
        }
      }
      
      // 等待下一次轮询
      await new Promise(resolve => setTimeout(resolve, pollInterval))
    }
    
    // 命令完成
    unsubscribe()
    
    // 清理输出
    const cleanOutput = stripAnsi(output).replace(/\r/g, '').trim()
    
    terminalStateService.completeCommandExecution(ptyId, 0, 'completed')
    
    // 更新密码等待步骤（如果有）
    if (passwordStepId) {
      executor.updateStep(passwordStepId, {
        type: 'tool_result',
        content: `密码验证完成`
      })
    }
    
    executor.addStep({
      type: 'tool_result',
      content: `命令执行完成`,
      toolName: 'execute_command',
      toolResult: cleanOutput
    })
    
    return { success: true, output: cleanOutput }
    
  } catch (error) {
    unsubscribe()
    terminalStateService.completeCommandExecution(ptyId, 1, 'failed')
    
    const errorMsg = error instanceof Error ? error.message : '命令执行失败'
    executor.addStep({
      type: 'tool_result',
      content: `命令执行失败: ${errorMsg}`,
      toolName: 'execute_command',
      toolResult: errorMsg
    })
    return { success: false, output: '', error: errorMsg }
  }
}

/**
 * 执行"发送即返回"命令（如 tail -f、ping、top 等）
 * 发送命令后立即返回，让 Agent 自己控制何时停止
 */
async function executeFireAndForget(
  ptyId: string,
  command: string,
  handling: { reason?: string; hint?: string },
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  // 发送命令到终端
  executor.terminalService.write(ptyId, command + '\r')
  
  // 等待一小段时间让命令启动并产生一些初始输出
  await new Promise(resolve => setTimeout(resolve, 1000))
  
  // 获取初始输出（从 xterm buffer 读取最后 20 行）
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
    content: `🚀 ${handling.reason || '命令已启动'}`,
    toolName: 'execute_command',
    toolResult: initialOutput ? `初始输出:\n${truncateFromEnd(initialOutput, 300)}\n\n💡 ${hint}` : `💡 ${hint}`
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
 * 执行限时命令（用于 tail -f 等持续运行的命令）
 * 在执行期间实时收集输出，然后返回
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
    let dataHandler: ((data: string) => void) | null = null
    
    // 注册输出收集器
    dataHandler = (data: string) => {
      output += data
    }
    executor.terminalService.onData(ptyId, dataHandler)
    
    // 发送命令
    executor.terminalService.write(ptyId, command + '\r')
    
    // 设置超时后发送退出信号
    setTimeout(async () => {
      // 发送退出信号
      const exitKeys: Record<string, string> = {
        'ctrl_c': '\x03',
        'ctrl_d': '\x04',
        'q': 'q'
      }
      executor.terminalService.write(ptyId, exitKeys[exitAction])
      
      // 等待程序退出
      await new Promise(r => setTimeout(r, 500))
      
      // 如果是 q，可能还需要回车
      if (exitAction === 'q') {
        executor.terminalService.write(ptyId, '\r')
        await new Promise(r => setTimeout(r, 200))
      }

      // 清理输出（移除 ANSI 转义序列）
      const cleanOutput = stripAnsi(output)
        .replace(/\r/g, '')
        .trim()

      // 提取有意义的输出（移除命令回显和结尾提示符）
      const lines = cleanOutput.split('\n')
      const meaningfulLines = lines.filter((line, idx) => {
        // 跳过第一行（可能是命令回显）
        if (idx === 0 && line.includes(command.slice(0, 20))) return false
        // 跳过空行
        if (!line.trim()) return false
        // 跳过提示符行
        if (/[$#%>❯]\s*$/.test(line)) return false
        return true
      })

      const finalOutput = meaningfulLines.join('\n').trim()

      // UI 显示截断到 500 字符（保留最新内容），但返回给 agent 的 output 是完整的
      const truncatedDisplay = truncateFromEnd(finalOutput, 500)

      executor.addStep({
        type: 'tool_result',
        content: `✓ 命令执行了 ${timeout/1000} 秒 (${finalOutput.length} 字符)`,
        toolName: 'execute_command',
        toolResult: truncatedDisplay
      })

      // 返回完整输出给 agent，不进行截断
      resolve({ 
        success: true, 
        output: finalOutput || `命令执行了 ${timeout/1000} 秒，但没有输出内容。`
      })
    }, timeout)
  })
}

/**
 * 从后向前截断字符串，保留最新的内容
 * @param text 要截断的文本
 * @param maxLength 最大长度
 * @returns 截断后的文本（如果超长，前面会加上省略号）
 */
function truncateFromEnd(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text
  }
  
  // 按行分割，从后向前保留行
  const lines = text.split('\n')
  const result: string[] = []
  let currentLength = 0
  const ellipsisLength = 3 // '...' 的长度
  const availableLength = maxLength - ellipsisLength // 可用于内容的长度
  
  // 从最后一行开始向前累积
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    const isLastLine = i === lines.length - 1
    
    // 计算加上这一行后的总长度（最后一行不需要换行符）
    const lineLength = isLastLine ? line.length : line.length + 1 // +1 for \n
    const neededLength = currentLength + lineLength
    
    if (neededLength > availableLength) {
      // 如果加上这一行会超长
      if (isLastLine && currentLength === 0) {
        // 这是最后一行且还没有任何内容，必须从行尾截取
        const truncatedLine = line.slice(-availableLength)
        result.unshift(truncatedLine)
        return '...' + truncatedLine
      }
      // 否则停止，不再添加更多行
      break
    }
    
    result.unshift(line)
    currentLength += lineLength
  }
  
  // 如果截断了，在前面加上省略号
  if (result.length < lines.length) {
    return '...' + result.join('\n')
  }
  
  return result.join('\n')
}

/**
 * 获取终端上下文（从末尾读取 N 行）
 * 直接从 xterm buffer 实时读取
 */
async function getTerminalContext(
  ptyId: string,
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const lines = Math.min(Math.max((args.lines as number) || 50, 1), 500) // 限制 1-500 行
  
  // 从 xterm buffer 实时读取
  let bufferLines: string[] | null = null
  try {
    bufferLines = await getLastNLinesFromBuffer(ptyId, lines, 3000)
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : '未知错误'
    return { success: false, output: '', error: `获取终端输出失败: ${errorMsg}` }
  }
  
  if (!bufferLines || bufferLines.length === 0) {
    return { success: true, output: '(终端输出为空)' }
  }
  
  const output = stripAnsi(bufferLines.join('\n'))
  
  executor.addStep({
    type: 'tool_result',
    content: `获取终端输出: ${bufferLines.length} 行`,
    toolName: 'get_terminal_context',
    toolResult: truncateFromEnd(output, 500)
  })

  return { success: true, output }
}

/**
 * 检查终端状态
 * 结合进程检测和屏幕分析，提供准确的终端状态
 */
async function checkTerminalStatus(
  ptyId: string,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  executor.addStep({
    type: 'tool_call',
    content: '检查终端状态',
    toolName: 'check_terminal_status',
    toolArgs: {},
    riskLevel: 'safe'
  })

  try {
    const awarenessService = getTerminalAwarenessService()
    const awareness = await awarenessService.getAwareness(ptyId)
    const terminalType = awareness.terminalState?.type || 'local'
    const isSsh = terminalType === 'ssh'
    
    // 1. 从前端获取完整的屏幕分析（输入等待、输出类型、环境信息）
    let screenAnalysis = await getScreenAnalysisFromFrontend(ptyId, 2000)
    
    // 2. 从 xterm buffer 获取最后 50 行（不受用户滚动窗口影响）
    let terminalOutput: string[] = []
    try {
      const bufferLines = await getLastNLinesFromBuffer(ptyId, 50, 3000)
      if (bufferLines && bufferLines.length > 0) {
        terminalOutput = bufferLines.map(line => stripAnsi(line))
        while (terminalOutput.length > 0 && terminalOutput[terminalOutput.length - 1].trim() === '') {
          terminalOutput.pop()
        }
      }
    } catch {
      // 获取失败，继续
    }
    
    // 构建输出
    const output: string[] = []
    
    // 1. 基本信息
    output.push(`## 终端信息`)
    output.push(`- 类型: ${isSsh ? 'SSH 远程终端' : '本地终端'}`)
    if (awareness.terminalState?.cwd) {
      output.push(`- 当前目录: ${awareness.terminalState.cwd}`)
    }
    if (awareness.terminalState?.lastCommand) {
      output.push(`- 最近命令: ${awareness.terminalState.lastCommand}`)
    }
    // 环境信息（来自屏幕分析）
    if (screenAnalysis?.context) {
      const ctx = screenAnalysis.context
      if (ctx.user || ctx.hostname) {
        output.push(`- 用户@主机: ${ctx.user || '?'}@${ctx.hostname || '?'}${ctx.isRoot ? ' (root)' : ''}`)
      }
      if (ctx.activeEnvs.length > 0) {
        output.push(`- 活跃环境: ${ctx.activeEnvs.join(', ')}`)
      }
      if (ctx.sshDepth > 0) {
        output.push(`- SSH 嵌套层数: ${ctx.sshDepth}`)
      }
    }
    
    // 2. 状态判断
    output.push('')
    output.push(`## 状态`)
    
    // 2.1 输入等待检测（来自屏幕分析，优先级最高）
    if (screenAnalysis?.input.isWaiting && screenAnalysis.input.confidence > 0.5) {
      const input = screenAnalysis.input
      let inputStatus = ''
      switch (input.type) {
        case 'password':
          inputStatus = `🔐 等待密码输入`
          break
        case 'confirmation':
          inputStatus = `❓ 等待确认 (${input.prompt || 'y/n'})`
          break
        case 'selection':
          inputStatus = `📋 等待选择`
          if (input.options && input.options.length > 0) {
            inputStatus += `: ${input.options.slice(0, 5).join(', ')}${input.options.length > 5 ? '...' : ''}`
          }
          break
        case 'pager':
          inputStatus = `📖 分页器模式 (按 q 退出, 空格翻页)`
          break
        case 'editor':
          inputStatus = `📝 编辑器模式 (无法通过 Agent 操作)`
          break
        case 'prompt':
          inputStatus = `⌨️ 等待输入: ${input.prompt || ''}`
          break
        case 'custom_input':
          inputStatus = `⌨️ 等待自定义输入: ${input.prompt || ''}`
          break
        default:
          inputStatus = `⌨️ 等待输入`
      }
      output.push(`- 状态: ${inputStatus}`)
      if (input.suggestedResponse) {
        output.push(`- 建议响应: ${input.suggestedResponse}`)
      }
      output.push(`- 可执行命令: 否（需要先响应当前输入）`)
    } else if (isSsh) {
      // SSH 终端：基于屏幕分析判断
      output.push(`- 状态: **请根据下方终端输出判断**`)
      output.push(`- 说明: SSH 终端状态需要根据输出内容判断`)
    } else {
      // 本地终端：基于进程检测
      let statusText = ''
      switch (awareness.status) {
        case 'idle':
          statusText = '✅ 空闲，可以执行命令'
          break
        case 'busy':
          statusText = '⏳ 忙碌'
          if (awareness.process.foregroundProcess) {
            statusText += `，正在执行: ${awareness.process.foregroundProcess}`
          }
          if (awareness.process.runningTime) {
            statusText += ` (${Math.round(awareness.process.runningTime / 1000)}秒)`
          }
          break
        case 'waiting_input':
          statusText = `⌨️ 等待输入 (${awareness.input.type})`
          break
        case 'stuck':
          statusText = '⚠️ 可能卡死（长时间无输出）'
          break
      }
      output.push(`- 状态: ${statusText}`)
      output.push(`- 可执行命令: ${awareness.canExecuteCommand ? '是' : '否'}`)
    }
    
    // 2.2 输出模式识别（来自屏幕分析）
    if (screenAnalysis && screenAnalysis.output.type !== 'normal' && (screenAnalysis.output.confidence ?? 0) > 0.5) {
      const out = screenAnalysis.output
      output.push('')
      output.push(`## 输出类型`)
      switch (out.type) {
        case 'progress':
          output.push(`- 📊 进度输出${out.details?.progress !== undefined ? ` (${out.details.progress}%)` : ''}`)
          if (out.details?.eta) output.push(`- 预计剩余: ${out.details.eta}`)
          break
        case 'compilation':
          output.push(`- 🔨 编译输出`)
          if (out.details?.errorCount) output.push(`- 错误数: ${out.details.errorCount}`)
          break
        case 'test':
          output.push(`- 🧪 测试输出`)
          if (out.details?.testsPassed !== undefined) output.push(`- 通过: ${out.details.testsPassed}`)
          if (out.details?.testsFailed !== undefined) output.push(`- 失败: ${out.details.testsFailed}`)
          break
        case 'log_stream':
          output.push(`- 📜 日志流`)
          break
        case 'error':
          output.push(`- ❌ 错误输出`)
          break
        case 'table':
          output.push(`- 📋 表格输出`)
          break
      }
    }
    
    // 3. 最近终端输出
    output.push('')
    output.push(`## 最近终端输出（最后 ${terminalOutput.length} 行）`)
    if (terminalOutput.length > 0) {
      output.push('```')
      output.push(terminalOutput.join('\n'))
      output.push('```')
    } else {
      output.push('(无法获取终端输出)')
    }
    
    const outputText = output.join('\n')
    
    // UI 显示简化版本
    let displayStatus: string = awareness.status
    if (screenAnalysis?.input.isWaiting && screenAnalysis.input.confidence > 0.5) {
      displayStatus = `等待${screenAnalysis.input.type}`
    } else if (isSsh) {
      displayStatus = '查看输出判断'
    }
    executor.addStep({
      type: 'tool_result',
      content: `终端状态: ${displayStatus}`,
      toolName: 'check_terminal_status',
      toolResult: terminalOutput.length > 0 ? `输出 ${terminalOutput.length} 行` : '(无输出)'
    })

    return { success: true, output: outputText }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : '状态检测失败'
    executor.addStep({
      type: 'tool_result',
      content: `状态检测失败: ${errorMsg}`,
      toolName: 'check_terminal_status',
      toolResult: errorMsg
    })
    return { success: false, output: '', error: errorMsg }
  }
}

/**
 * 等待终端输出稳定（用于发送输入/控制键后获取响应）
 * 采用轮询方式，等待输出不再变化，适应网络延迟场景
 */
async function waitForStableOutput(
  ptyId: string,
  options: {
    minWait?: number      // 最小等待时间（ms），默认 300
    maxWait?: number      // 最大等待时间（ms），默认 2000
    pollInterval?: number // 轮询间隔（ms），默认 200
    stableCount?: number  // 输出稳定次数，默认 2
  } = {}
): Promise<string> {
  const {
    minWait = 300,
    maxWait = 2000,
    pollInterval = 200,
    stableCount = 2
  } = options

  // 先等待最小时间
  await new Promise(resolve => setTimeout(resolve, minWait))

  let lastOutput = ''
  let stableCounter = 0
  const startTime = Date.now()

  // 轮询等待输出稳定
  while (Date.now() - startTime < maxWait) {
    try {
      const bufferLines = await getLastNLinesFromBuffer(ptyId, 15, 1000)
      const currentOutput = bufferLines ? stripAnsi(bufferLines.join('\n')) : ''

      if (currentOutput === lastOutput) {
        stableCounter++
        if (stableCounter >= stableCount) {
          // 输出已稳定
          return currentOutput
        }
      } else {
        // 有新输出，重置计数
        stableCounter = 0
        lastOutput = currentOutput
      }
    } catch {
      // 获取失败，继续等待
    }

    await new Promise(resolve => setTimeout(resolve, pollInterval))
  }

  // 超时，返回最后获取到的输出
  return lastOutput
}

/**
 * 发送控制键到终端
 */
async function sendControlKey(
  ptyId: string,
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const key = args.key as string
  if (!key) {
    return { success: false, output: '', error: '必须指定要发送的控制键' }
  }

  // 控制键映射
  const keyMap: Record<string, string> = {
    'ctrl+c': '\x03',   // ETX - 中断
    'ctrl+d': '\x04',   // EOT - 文件结束
    'ctrl+z': '\x1a',   // SUB - 暂停
    'enter': '\r',      // 回车
    'q': 'q'            // 字母q (退出less/more)
  }

  const keySequence = keyMap[key.toLowerCase()]
  if (!keySequence) {
    return { success: false, output: '', error: `不支持的控制键: ${key}` }
  }

  executor.addStep({
    type: 'tool_call',
    content: `发送控制键: ${key}`,
    toolName: 'send_control_key',
    toolArgs: { key },
    riskLevel: 'safe'
  })

  try {
    // 直接写入 PTY
    executor.terminalService.write(ptyId, keySequence)
    
    // 等待终端输出稳定（适应网络延迟）
    const terminalOutput = await waitForStableOutput(ptyId)

    executor.addStep({
      type: 'tool_result',
      content: `已发送 ${key}`,
      toolName: 'send_control_key',
      toolResult: terminalOutput ? truncateFromEnd(terminalOutput, 300) : '控制键已发送'
    })

    return { 
      success: true, 
      output: terminalOutput 
        ? `已发送 ${key}。\n\n终端最新输出:\n${terminalOutput}`
        : `已发送 ${key}。`
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : '发送失败'
    return { success: false, output: '', error: errorMsg }
  }
}

/**
 * 发送文本输入到终端
 */
async function sendInput(
  ptyId: string,
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const text = args.text as string
  const pressEnter = args.press_enter !== false // 默认 true

  if (text === undefined || text === null) {
    return { success: false, output: '', error: '必须指定要发送的文本' }
  }

  // 安全检查：限制输入长度，防止发送过长的内容
  if (text.length > 1000) {
    return { success: false, output: '', error: '输入文本过长（最大 1000 字符），请使用 write_file 工具处理大量内容' }
  }

  executor.addStep({
    type: 'tool_call',
    content: `发送输入: "${text}"${pressEnter ? ' + Enter' : ''}`,
    toolName: 'send_input',
    toolArgs: { text, press_enter: pressEnter },
    riskLevel: 'safe'
  })

  try {
    // 发送文本
    executor.terminalService.write(ptyId, text)
    
    // 如果需要按回车
    if (pressEnter) {
      executor.terminalService.write(ptyId, '\r')
    }
    
    // 等待终端输出稳定（适应网络延迟）
    const terminalOutput = await waitForStableOutput(ptyId)

    const inputDesc = `"${text}"${pressEnter ? ' + Enter' : ''}`
    
    executor.addStep({
      type: 'tool_result',
      content: `已发送: ${inputDesc}`,
      toolName: 'send_input',
      toolResult: terminalOutput ? truncateFromEnd(terminalOutput, 300) : '输入已发送'
    })

    return { 
      success: true, 
      output: terminalOutput 
        ? `已发送输入 ${inputDesc}。\n\n终端最新输出:\n${terminalOutput}`
        : `已发送输入 ${inputDesc}。`
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : '发送失败'
    return { success: false, output: '', error: errorMsg }
  }
}

/**
 * 读取文件
 * 支持多种读取方式：完整读取、按行范围读取、从开头/末尾读取、仅查询文件信息
 */
function readFile(
  ptyId: string,
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): ToolResult {
  let filePath = args.path as string
  if (!filePath) {
    return { success: false, output: '', error: '文件路径不能为空' }
  }

  // 如果是相对路径，基于终端当前工作目录解析
  if (!path.isAbsolute(filePath)) {
    const terminalStateService = getTerminalStateService()
    const cwd = terminalStateService.getCwd(ptyId)
    filePath = path.resolve(cwd, filePath)
  }

  const infoOnly = args.info_only === true
  const startLine = args.start_line as number | undefined
  const endLine = args.end_line as number | undefined
  const maxLines = args.max_lines as number | undefined
  const tailLines = args.tail_lines as number | undefined

  executor.addStep({
    type: 'tool_call',
    content: `读取文件: ${filePath}${infoOnly ? ' (仅查询信息)' : ''}`,
    toolName: 'read_file',
    toolArgs: args,
    riskLevel: 'safe'
  })

  try {
    const stats = fs.statSync(filePath)
    const fileSize = stats.size
    const sizeMB = (fileSize / (1024 * 1024)).toFixed(2)
    const sizeKB = (fileSize / 1024).toFixed(2)

    // 如果只查询文件信息
    if (infoOnly) {
      // 尝试读取文件前部分来计算行数和预览
      let totalLines = 0
      let sampleContent = ''
      let estimated = false
      
      try {
        // 对于小文件，直接读取全部
        if (fileSize <= 10 * 1024 * 1024) { // 10MB 以下
          const fullContent = fs.readFileSync(filePath, 'utf-8')
          const lines = fullContent.split('\n')
          totalLines = lines.length
          sampleContent = lines.slice(0, 10).join('\n') // 前10行作为预览
        } else {
          // 对于大文件，只读取前 100KB 来估算
          const sampleSize = Math.min(100 * 1024, fileSize)
          const buffer = Buffer.alloc(sampleSize)
          const fd = fs.openSync(filePath, 'r')
          fs.readSync(fd, buffer, 0, sampleSize, 0)
          fs.closeSync(fd)
          
          const sample = buffer.toString('utf-8')
          const sampleLines = sample.split('\n')
          // 基于采样估算总行数
          const avgLineLength = sample.length / sampleLines.length
          totalLines = Math.floor(fileSize / avgLineLength)
          estimated = true
          sampleContent = sampleLines.slice(0, 10).join('\n')
        }
      } catch (err) {
        // 如果读取失败，使用粗略估算
        totalLines = Math.floor(fileSize / 80) // 假设平均每行80字符
        estimated = true
      }

      const info = `## 文件信息
- **路径**: ${filePath}
- **大小**: ${sizeMB} MB (${fileSize.toLocaleString()} 字节)
- **总行数**: ${totalLines.toLocaleString()} 行${estimated ? ' (估算值)' : ''}
- **建议**: ${fileSize > 500 * 1024 ? '文件较大，建议使用以下方式读取特定部分：\n  - `start_line` 和 `end_line`: 读取指定行范围\n  - `max_lines`: 读取前N行（如 `max_lines: 100`）\n  - `tail_lines`: 读取最后N行（如 `tail_lines: 50`）' : '文件大小在限制内，可以完整读取'}

${sampleContent ? `### 文件预览（前10行）\n\`\`\`\n${sampleContent}\n\`\`\`` : ''}`

      executor.addStep({
        type: 'tool_result',
        content: `文件信息: ${sizeMB} MB, ${totalLines.toLocaleString()} 行`,
        toolName: 'read_file',
        toolResult: info
      })
      return { success: true, output: info }
    }

    // 读取文件内容
    let content = ''
    let actualLines: string[] = []

    // 如果指定了行范围
    if (startLine !== undefined || endLine !== undefined) {
      const fullContent = fs.readFileSync(filePath, 'utf-8')
      const allLines = fullContent.split('\n')
      const start = startLine !== undefined ? Math.max(1, startLine) - 1 : 0 // 转换为0-based索引
      const end = endLine !== undefined ? Math.min(allLines.length, endLine) : allLines.length
      actualLines = allLines.slice(start, end)
      content = actualLines.join('\n')
    }
    // 如果指定了最大行数（从开头读取）
    else if (maxLines !== undefined) {
      const fullContent = fs.readFileSync(filePath, 'utf-8')
      const allLines = fullContent.split('\n')
      actualLines = allLines.slice(0, maxLines)
      content = actualLines.join('\n')
    }
    // 如果指定了从末尾读取的行数
    else if (tailLines !== undefined) {
      const fullContent = fs.readFileSync(filePath, 'utf-8')
      const allLines = fullContent.split('\n')
      actualLines = allLines.slice(-tailLines)
      content = actualLines.join('\n')
    }
    // 完整读取（仅当文件小于 500KB 时）
    else {
      const maxFileSize = 500 * 1024 // 500KB
      if (fileSize > maxFileSize) {
        const errorMsg = `文件过大 (${sizeMB} MB)，超过完整读取限制 (500KB)。请使用以下方式之一：
1. 设置 info_only=true 查看文件信息
2. 使用 start_line 和 end_line 读取指定行范围
3. 使用 max_lines 读取前N行
4. 使用 tail_lines 读取最后N行`
        executor.addStep({
          type: 'tool_result',
          content: `文件读取失败: 文件过大`,
          toolName: 'read_file',
          toolResult: errorMsg
        })
        return { success: false, output: '', error: errorMsg }
      }
      content = fs.readFileSync(filePath, 'utf-8')
      actualLines = content.split('\n')
    }

    // 构建返回信息
    const readInfo: string[] = []
    if (startLine !== undefined || endLine !== undefined) {
      readInfo.push(`读取行范围: ${startLine || 1}-${endLine || '末尾'}`)
    } else if (maxLines !== undefined) {
      readInfo.push(`读取前 ${maxLines} 行`)
    } else if (tailLines !== undefined) {
      readInfo.push(`读取最后 ${tailLines} 行`)
    } else {
      readInfo.push('完整读取')
    }
    readInfo.push(`实际读取: ${actualLines.length} 行, ${content.length.toLocaleString()} 字符`)

    executor.addStep({
      type: 'tool_result',
      content: `文件读取成功: ${readInfo.join(', ')}`,
      toolName: 'read_file',
      toolResult: truncateFromEnd(content, 500) // UI 显示截断到 500 字符（保留最新内容）
    })
    
    // 返回完整内容给 agent（UI 显示已截断）
    return { success: true, output: content }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : '读取失败'
    const errorCategory = categorizeError(errorMsg)
    const suggestion = getErrorRecoverySuggestion(errorMsg, errorCategory)
    
    executor.addStep({
      type: 'tool_result',
      content: `文件读取失败: ${errorMsg}`,
      toolName: 'read_file',
      toolResult: `${errorMsg}\n\n💡 ${suggestion}`
    })
    return { success: false, output: '', error: `${errorMsg}\n\n💡 恢复建议: ${suggestion}` }
  }
}

/**
 * 写入文件
 * 支持多种模式：overwrite（覆盖）、append（追加）、insert（插入）、replace_lines（行替换）、regex_replace（正则替换）
 */
async function writeFile(
  ptyId: string,
  args: Record<string, unknown>,
  toolCallId: string,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  let filePath = args.path as string
  const content = args.content as string | undefined
  const mode = (args.mode as string) || 'overwrite'
  const insertAtLine = args.insert_at_line as number | undefined
  const startLine = args.start_line as number | undefined
  const endLine = args.end_line as number | undefined
  const pattern = args.pattern as string | undefined
  const replacement = args.replacement as string | undefined
  const replaceAll = args.replace_all !== false // 默认 true

  if (!filePath) {
    return { success: false, output: '', error: '文件路径不能为空' }
  }

  // 验证模式和必要参数
  const validModes = ['overwrite', 'append', 'insert', 'replace_lines', 'regex_replace']
  if (!validModes.includes(mode)) {
    return { success: false, output: '', error: `无效的写入模式: ${mode}，支持的模式: ${validModes.join(', ')}` }
  }

  // 验证各模式的必要参数
  if (mode === 'overwrite' || mode === 'append') {
    if (content === undefined) {
      return { success: false, output: '', error: `${mode} 模式需要提供 content 参数` }
    }
  } else if (mode === 'insert') {
    if (content === undefined) {
      return { success: false, output: '', error: 'insert 模式需要提供 content 参数' }
    }
    if (insertAtLine === undefined || insertAtLine < 1) {
      return { success: false, output: '', error: 'insert 模式需要提供有效的 insert_at_line 参数（从1开始）' }
    }
  } else if (mode === 'replace_lines') {
    if (content === undefined) {
      return { success: false, output: '', error: 'replace_lines 模式需要提供 content 参数' }
    }
    if (startLine === undefined || startLine < 1) {
      return { success: false, output: '', error: 'replace_lines 模式需要提供有效的 start_line 参数（从1开始）' }
    }
    if (endLine === undefined || endLine < startLine) {
      return { success: false, output: '', error: 'replace_lines 模式需要提供有效的 end_line 参数（必须 >= start_line）' }
    }
  } else if (mode === 'regex_replace') {
    if (pattern === undefined) {
      return { success: false, output: '', error: 'regex_replace 模式需要提供 pattern 参数' }
    }
    if (replacement === undefined) {
      return { success: false, output: '', error: 'regex_replace 模式需要提供 replacement 参数' }
    }
  }

  // 如果是相对路径，基于终端当前工作目录解析
  if (!path.isAbsolute(filePath)) {
    const terminalStateService = getTerminalStateService()
    const cwd = terminalStateService.getCwd(ptyId)
    filePath = path.resolve(cwd, filePath)
  }

  // 生成操作描述
  let operationDesc = ''
  switch (mode) {
    case 'overwrite':
      operationDesc = `覆盖写入文件: ${filePath}`
      break
    case 'append':
      operationDesc = `追加写入文件: ${filePath}`
      break
    case 'insert':
      operationDesc = `在第 ${insertAtLine} 行插入内容: ${filePath}`
      break
    case 'replace_lines':
      operationDesc = `替换第 ${startLine}-${endLine} 行: ${filePath}`
      break
    case 'regex_replace':
      operationDesc = `正则替换 (${replaceAll ? '全部' : '首个'}): ${filePath}`
      break
  }

  // 文件写入需要确认
  executor.addStep({
    type: 'tool_call',
    content: operationDesc,
    toolName: 'write_file',
    toolArgs: { 
      path: filePath, 
      mode,
      ...(content !== undefined && { content: content.length > 100 ? content.substring(0, 100) + '...' : content }),
      ...(insertAtLine !== undefined && { insert_at_line: insertAtLine }),
      ...(startLine !== undefined && { start_line: startLine }),
      ...(endLine !== undefined && { end_line: endLine }),
      ...(pattern !== undefined && { pattern }),
      ...(replacement !== undefined && { replacement })
    },
    riskLevel: 'moderate'
  })

  // 等待确认
  const approved = await executor.waitForConfirmation(
    toolCallId, 
    'write_file', 
    args, 
    'moderate'
  )
  if (!approved) {
    return { success: false, output: '', error: '用户拒绝写入文件' }
  }

  try {
    // 确保目录存在
    const dir = path.dirname(filePath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    let resultMsg = ''
    const fileExists = fs.existsSync(filePath)

    switch (mode) {
      case 'overwrite': {
        fs.writeFileSync(filePath, content!, 'utf-8')
        resultMsg = `文件已${fileExists ? '覆盖' : '创建'}: ${filePath}`
        break
      }
      case 'append': {
        fs.appendFileSync(filePath, content!, 'utf-8')
        resultMsg = `内容已追加到: ${filePath}`
        break
      }
      case 'insert': {
        if (!fileExists) {
          return { success: false, output: '', error: '文件不存在，无法执行插入操作' }
        }
        const lines = fs.readFileSync(filePath, 'utf-8').split('\n')
        const insertIndex = Math.min(insertAtLine! - 1, lines.length)
        const contentLines = content!.split('\n')
        lines.splice(insertIndex, 0, ...contentLines)
        fs.writeFileSync(filePath, lines.join('\n'), 'utf-8')
        resultMsg = `已在第 ${insertAtLine} 行插入 ${contentLines.length} 行内容: ${filePath}`
        break
      }
      case 'replace_lines': {
        if (!fileExists) {
          return { success: false, output: '', error: '文件不存在，无法执行行替换操作' }
        }
        const lines = fs.readFileSync(filePath, 'utf-8').split('\n')
        const totalLines = lines.length
        if (startLine! > totalLines) {
          return { success: false, output: '', error: `起始行 ${startLine} 超出文件总行数 ${totalLines}` }
        }
        const actualEndLine = Math.min(endLine!, totalLines)
        const deleteCount = actualEndLine - startLine! + 1
        const contentLines = content!.split('\n')
        lines.splice(startLine! - 1, deleteCount, ...contentLines)
        fs.writeFileSync(filePath, lines.join('\n'), 'utf-8')
        resultMsg = `已替换第 ${startLine}-${actualEndLine} 行（共 ${deleteCount} 行）为 ${contentLines.length} 行新内容: ${filePath}`
        break
      }
      case 'regex_replace': {
        if (!fileExists) {
          return { success: false, output: '', error: '文件不存在，无法执行正则替换操作' }
        }
        const fileContent = fs.readFileSync(filePath, 'utf-8')
        let regex: RegExp
        try {
          regex = new RegExp(pattern!, replaceAll ? 'g' : '')
        } catch (e) {
          return { success: false, output: '', error: `无效的正则表达式: ${pattern}` }
        }
        const matches = fileContent.match(regex)
        if (!matches || matches.length === 0) {
          return { success: false, output: '', error: `未找到匹配的内容: ${pattern}` }
        }
        const newContent = fileContent.replace(regex, replacement!)
        fs.writeFileSync(filePath, newContent, 'utf-8')
        resultMsg = `已替换 ${matches.length} 处匹配内容: ${filePath}`
        break
      }
    }

    executor.addStep({
      type: 'tool_result',
      content: resultMsg,
      toolName: 'write_file'
    })
    return { success: true, output: resultMsg }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : '写入失败'
    const errorCategory = categorizeError(errorMsg)
    const suggestion = getErrorRecoverySuggestion(errorMsg, errorCategory)
    
    executor.addStep({
      type: 'tool_result',
      content: `文件写入失败: ${errorMsg}`,
      toolName: 'write_file',
      toolResult: `${errorMsg}\n\n💡 ${suggestion}`
    })
    return { success: false, output: '', error: `${errorMsg}\n\n💡 恢复建议: ${suggestion}` }
  }
}

/**
 * 记住信息
 */
function rememberInfo(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): ToolResult {
  const info = args.info as string
  if (!info) {
    return { success: false, output: '', error: '信息不能为空' }
  }

  // 过滤动态信息
  const dynamicPatterns = [
    /端口/i, /port/i, /监听/i, /listen/i,
    /进程/i, /process/i, /pid/i,
    /运行中/i, /running/i, /stopped/i, /状态/i,
    /使用率/i, /占用/i, /usage/i,
    /\d+%/, /\d+mb/i, /\d+gb/i,
    /连接/i, /connection/i
  ]
  
  const isDynamic = dynamicPatterns.some(p => p.test(info))
  const hasPath = info.includes('/') || info.includes('\\')
  
  if (isDynamic || !hasPath) {
    executor.addStep({
      type: 'tool_result',
      content: `跳过: "${info}" (动态信息或非路径)`,
      toolName: 'remember_info'
    })
    return { success: true, output: '此信息为动态信息，不适合长期记忆' }
  }

  executor.addStep({
    type: 'tool_call',
    content: `记住信息: ${info}`,
    toolName: 'remember_info',
    toolArgs: args,
    riskLevel: 'safe'
  })

  // 保存到主机档案
  const hostId = executor.getHostId()
  if (hostId && executor.hostProfileService) {
    executor.hostProfileService.addNote(hostId, info)
  }

  executor.addStep({
    type: 'tool_result',
    content: `已记住: ${info}`,
    toolName: 'remember_info'
  })

  return { success: true, output: `信息已保存到主机档案` }
}

/**
 * 搜索知识库
 */
async function searchKnowledge(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const query = args.query as string
  const limit = Math.min(Math.max(1, (args.limit as number) || 5), 20)
  
  if (!query) {
    return { success: false, output: '', error: '查询内容不能为空' }
  }

  executor.addStep({
    type: 'tool_call',
    content: `搜索知识库: "${query}"`,
    toolName: 'search_knowledge',
    toolArgs: args,
    riskLevel: 'safe'
  })

  try {
    const knowledgeService = getKnowledgeService()
    
    if (!knowledgeService) {
      executor.addStep({
        type: 'tool_result',
        content: '知识库服务未初始化',
        toolName: 'search_knowledge'
      })
      return { success: false, output: '', error: '知识库服务未初始化' }
    }

    if (!knowledgeService.isEnabled()) {
      executor.addStep({
        type: 'tool_result',
        content: '知识库未启用',
        toolName: 'search_knowledge'
      })
      return { success: false, output: '', error: '知识库未启用，请在设置中开启' }
    }

    const results = await knowledgeService.search(query, { 
      limit,
      hostId: executor.getHostId()
    })

    if (results.length === 0) {
      executor.addStep({
        type: 'tool_result',
        content: '未找到相关内容',
        toolName: 'search_knowledge'
      })
      return { success: true, output: '知识库中未找到与查询相关的内容' }
    }

    // 格式化结果，对每个结果的内容进行截断（避免单个结果过长）
    const maxContentLength = 1000 // 每个结果最多 2000 字符
    const formattedResults = results.map((r, i) => {
      const content = r.content.length > maxContentLength
        ? r.content.substring(0, maxContentLength) + `\n\n... [内容已截断，完整内容共 ${r.content.length} 字符]`
        : r.content
      return `### ${i + 1}. ${r.metadata.filename}\n${content}`
    }).join('\n\n')

    const output = `找到 ${results.length} 条相关内容：\n\n${formattedResults}`
    
    // UI 显示截断到 500 字符（保留最新内容）
    const displayOutput = output.length > 500
      ? truncateFromEnd(output, 500)
      : output

    executor.addStep({
      type: 'tool_result',
      content: `找到 ${results.length} 条相关内容 (${output.length} 字符)`,
      toolName: 'search_knowledge',
      toolResult: displayOutput
    })

    // 返回完整结果给 agent（但每个结果的内容已截断到 2000 字符）
    return { success: true, output }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : '搜索失败'
    executor.addStep({
      type: 'tool_result',
      content: `搜索失败: ${errorMsg}`,
      toolName: 'search_knowledge'
    })
    return { success: false, output: '', error: errorMsg }
  }
}

/**
 * 格式化剩余时间显示
 */
function formatRemainingTime(totalSeconds: number, elapsedSeconds: number): string {
  const remaining = Math.max(0, totalSeconds - elapsedSeconds)
  const minutes = Math.floor(remaining / 60)
  const seconds = remaining % 60
  
  if (minutes > 0) {
    return `${minutes}分${seconds}秒`
  }
  return `${seconds}秒`
}

/**
 * 格式化总时间显示
 */
function formatTotalTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const secs = seconds % 60
  
  if (minutes > 0) {
    return secs > 0 ? `${minutes}分${secs}秒` : `${minutes}分钟`
  }
  return `${seconds}秒`
}


/**
 * 等待指定时间
 * 让 Agent 可以主动等待，避免频繁轮询消耗步骤
 * 支持：
 * - 显示等待进度（计划等待多久，还剩多久）
 * - 用户发送消息时立即中断等待
 */
async function wait(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const totalSeconds = args.seconds as number
  const message = args.message as string || `等待中...`
  
  // 参数校验
  if (typeof totalSeconds !== 'number' || totalSeconds <= 0) {
    return { success: false, output: '', error: '等待秒数必须是正数' }
  }
  
  const totalTimeDisplay = formatTotalTime(totalSeconds)
  
  // 添加等待步骤，显示计划等待时间
  const step = executor.addStep({
    type: 'waiting',
    content: `☕ ${message}\n⏱️ 计划等待 ${totalTimeDisplay}，剩余 ${totalTimeDisplay}`,
    toolName: 'wait',
    toolArgs: { seconds: totalSeconds, message },
    riskLevel: 'safe'
  })

  // 轮询间隔（秒），用于更新进度和检查中断
  const pollInterval = Math.min(5, Math.max(1, Math.floor(totalSeconds / 20)))
  let elapsedSeconds = 0
  let interrupted = false
  let interruptReason: 'aborted' | 'user_message' | '' = ''
  let userMessageContent = ''

  // 轮询等待，支持中断
  while (elapsedSeconds < totalSeconds) {
    // 等待一个间隔
    await new Promise(resolve => setTimeout(resolve, pollInterval * 1000))
    elapsedSeconds += pollInterval
    
    // 检查是否被中止
    if (executor.isAborted()) {
      interrupted = true
      interruptReason = 'aborted'
      break
    }
    
    // 检查是否有用户消息
    if (executor.hasPendingUserMessage()) {
      interrupted = true
      interruptReason = 'user_message'
      // 查看用户消息内容（不消费，让 Agent 循环来处理）
      userMessageContent = executor.peekPendingUserMessage() || ''
      break
    }
    
    // 更新进度显示
    const remainingTime = formatRemainingTime(totalSeconds, elapsedSeconds)
    const progress = Math.min(100, Math.round((elapsedSeconds / totalSeconds) * 100))
    
    executor.updateStep(step.id, {
      type: 'waiting',
      content: `☕ ${message}\n⏱️ 计划等待 ${totalTimeDisplay}，剩余 ${remainingTime} (${progress}%)`
    })
  }

  // 等待完成或被中断
  const actualTimeDisplay = formatTotalTime(Math.min(elapsedSeconds, totalSeconds))
  const remainingSeconds = totalSeconds - elapsedSeconds
  const remainingTimeDisplay = formatTotalTime(Math.max(0, remainingSeconds))
  
  if (interrupted) {
    if (interruptReason === 'user_message') {
      // 用户发消息中断 - 把消息内容告诉 Agent，让它决定怎么做
      executor.updateStep(step.id, {
        type: 'waiting',
        content: `☕ ${message}\n📨 收到新消息！已等待 ${actualTimeDisplay}，原计划还剩 ${remainingTimeDisplay}`
      })

      return {
        success: true,
        output: `用户发来消息："${userMessageContent}"\n\n已等待 ${actualTimeDisplay}，原计划还剩 ${remainingTimeDisplay}。\n请根据用户消息决定下一步：如果用户说不用等了/快好了，可以立即检查终端状态；如果用户说还要等/没那么快，可以再次调用 wait 继续等待。`
      }
    } else {
      // abort 中断
      executor.updateStep(step.id, {
        type: 'waiting',
        content: `☕ ${message}\n🛑 好的，停下来了。已等待 ${actualTimeDisplay}`
      })

      return {
        success: true,
        output: `操作已中止，等待了 ${actualTimeDisplay}。`
      }
    }
  }

  // 正常完成
  executor.updateStep(step.id, {
    type: 'waiting',
    content: `☕ ${message}\n✅ 等待完成，共等待 ${totalTimeDisplay}`
  })

  return { 
    success: true, 
    output: `已等待 ${totalTimeDisplay}，继续执行。现在你可以检查终端状态或继续其他操作。`
  }
}

/**
 * 向用户提问并等待回复
 * 让 Agent 可以主动向用户获取更多信息
 */
async function askUser(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const question = args.question as string
  let options = args.options as string[] | undefined
  const allowMultiple = args.allow_multiple as boolean | undefined
  const defaultValue = args.default_value as string | undefined
  
  // 参数校验
  if (!question || typeof question !== 'string') {
    return { success: false, output: '', error: '问题不能为空' }
  }

  // 限制选项数量为 10 个
  if (options && options.length > 10) {
    options = options.slice(0, 10)
  }

  // 添加提问步骤（content 只保存问题，状态信息通过 toolResult 显示）
  const step = executor.addStep({
    type: 'asking',
    content: question,
    toolName: 'ask_user',
    toolArgs: { question, options, allow_multiple: allowMultiple, default_value: defaultValue },
    toolResult: '⏳ 等待回复中...',
    riskLevel: 'safe'
  })

  // 等待用户回复（最长 5 分钟）
  const maxWaitSeconds = 300  // 5 分钟
  const pollInterval = 2  // 每 2 秒检查一次
  let elapsedSeconds = 0
  let userResponse: string | undefined

  while (elapsedSeconds < maxWaitSeconds) {
    // 检查是否被中止
    if (executor.isAborted()) {
      executor.updateStep(step.id, {
        toolResult: '🛑 已取消'
      })
      return { success: false, output: '', error: '操作已中止' }
    }

    // 检查是否有用户回复
    if (executor.hasPendingUserMessage()) {
      userResponse = executor.consumePendingUserMessage()
      break
    }

    // 等待一个间隔
    await new Promise(resolve => setTimeout(resolve, pollInterval * 1000))
    elapsedSeconds += pollInterval

    // 更新等待状态显示（通过 toolResult 字段）
    const remainingSeconds = maxWaitSeconds - elapsedSeconds
    const remainingMinutes = Math.floor(remainingSeconds / 60)
    const remainingSecs = remainingSeconds % 60
    const remainingDisplay = remainingMinutes > 0 
      ? `${remainingMinutes}分${remainingSecs}秒` 
      : `${remainingSecs}秒`
    
    executor.updateStep(step.id, {
      toolResult: `⏳ 等待回复中...（剩余 ${remainingDisplay}）`
    })
  }

  // 处理用户回复或超时
  if (userResponse !== undefined) {
    // 用户回复了
    let finalResponse = userResponse.trim()
    
    // 尝试解析多选回复（JSON 数组格式）
    let selectedOptions: string[] = []
    if (finalResponse.startsWith('[') && finalResponse.endsWith(']')) {
      try {
        selectedOptions = JSON.parse(finalResponse)
        if (Array.isArray(selectedOptions)) {
          finalResponse = selectedOptions.join(', ')
        }
      } catch {
        // 不是有效的 JSON，保持原样
      }
    }
    
    // 处理选项回复：如果用户输入的是数字，尝试匹配选项
    if (options && options.length > 0 && selectedOptions.length === 0) {
      const numMatch = finalResponse.match(/^(\d+)$/)
      if (numMatch) {
        const idx = parseInt(numMatch[1], 10) - 1
        if (idx >= 0 && idx < options.length) {
          finalResponse = options[idx]
        }
      }
    }

    // 空回复使用默认值
    if (!finalResponse && defaultValue) {
      finalResponse = defaultValue
    }

    executor.updateStep(step.id, {
      toolResult: `✅ ${finalResponse || '(空)'}`
    })

    return {
      success: true,
      output: `用户回复：${finalResponse || '(用户未提供内容)'}\n\n请根据用户的回复继续执行任务。`
    }
  } else {
    // 超时
    executor.updateStep(step.id, {
      toolResult: '⏰ 等待超时'
    })

    if (defaultValue) {
      return {
        success: true,
        output: `用户未在 5 分钟内回复，使用默认值：${defaultValue}\n\n请使用默认值继续执行任务。`
      }
    }

    return {
      success: false,
      output: '',
      error: '等待用户回复超时（5分钟）。你可以：1) 再次询问用户；2) 采用合理的默认方案；3) 向用户说明需要更多信息才能继续。'
    }
  }
}
