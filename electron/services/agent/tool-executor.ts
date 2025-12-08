/**
 * Agent 工具执行器
 */
import * as fs from 'fs'
import * as path from 'path'
import stripAnsi from 'strip-ansi'
import type { ToolCall } from '../ai.service'
import type { PtyService } from '../pty.service'
import type { McpService } from '../mcp.service'
import type { 
  AgentConfig, 
  AgentStep, 
  ToolResult, 
  RiskLevel,
  PendingConfirmation,
  HostProfileServiceInterface 
} from './types'
import { assessCommandRisk, analyzeCommand } from './risk-assessor'
import { getKnowledgeService } from '../knowledge'
import { getTerminalStateService } from '../terminal-state.service'
import { getTerminalAwarenessService, getProcessMonitor } from '../terminal-awareness'

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
  ptyService: PtyService
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
      return getTerminalContext(ptyId, args, terminalOutput, executor)

    case 'check_terminal_status':
      return checkTerminalStatus(ptyId, executor)

    case 'send_control_key':
      return sendControlKey(ptyId, args, executor)

    case 'send_input':
      return sendInput(ptyId, args, executor)

    case 'read_file':
      return readFile(args, executor)

    case 'write_file':
      return writeFile(args, toolCall.id, executor)

    case 'remember_info':
      return rememberInfo(args, executor)

    case 'search_knowledge':
      return searchKnowledge(args, executor)

    case 'get_terminal_state':
      return getTerminalState(ptyId, args, executor)

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

  // 策略3: 限时执行（如 top、tail -f）
  if (handling.strategy === 'timed_execution') {
    return executeTimedCommand(
      ptyId, 
      command, 
      handling.suggestedTimeout || 5000,
      handling.timeoutAction || 'ctrl_c',
      executor
    )
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
  const unsubscribe = executor.ptyService.onData(ptyId, outputHandler)
  
  try {
    const result = await withRetry(
      () => executor.ptyService.executeInTerminal(ptyId, command, config.commandTimeout),
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
          toolResult: result.output + '\n\n💡 这是一个长耗时命令，超时不代表失败。建议使用 wait 工具等待一段时间后再检查状态。'
        })
        return {
          success: true,  // 长耗时命令超时不算失败
          output: result.output + '\n\n💡 命令仍在后台执行中。建议：\n1. 使用 wait 工具等待一段时间（如 60-180 秒）\n2. 然后使用 check_terminal_status 确认执行状态\n3. 使用 get_terminal_context 查看最新输出',
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
        toolResult: result.output
      })
      return {
        success: false,
        output: result.output,
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
    executor.ptyService.onData(ptyId, dataHandler)
    
    // 发送命令
    executor.ptyService.write(ptyId, command + '\r')
    
    // 设置超时后发送退出信号
    setTimeout(async () => {
      // 发送退出信号
      const exitKeys: Record<string, string> = {
        'ctrl_c': '\x03',
        'ctrl_d': '\x04',
        'q': 'q'
      }
      executor.ptyService.write(ptyId, exitKeys[exitAction])
      
      // 等待程序退出
      await new Promise(r => setTimeout(r, 500))
      
      // 如果是 q，可能还需要回车
      if (exitAction === 'q') {
        executor.ptyService.write(ptyId, '\r')
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
 * 获取终端上下文
 * 支持多种读取方式：按行数、按字符数、从开头读取
 * 
 * 数据来源优先级：
 * 1. 当前正在执行的命令输出（从 terminal-state.service 获取，实时）
 * 2. 实时终端输出缓冲区（Agent 运行期间收集的）
 * 3. 传入的 terminalOutput（Agent 启动时的快照，作为最后的 fallback）
 */
function getTerminalContext(
  ptyId: string,
  args: Record<string, unknown>,
  terminalOutput: string[],
  executor: ToolExecutorConfig
): ToolResult {
  const lines = args.lines as number | undefined
  const maxChars = args.max_chars as number | undefined
  const fromStartLines = args.from_start_lines as number | undefined
  
  // 获取输出数据
  // 优先级：1. 当前执行的命令输出 2. 实时缓冲区 3. Agent 启动时的快照
  let allOutput: string[] = []
  let dataSource = 'unknown'
  
  try {
    const terminalStateService = getTerminalStateService()
    const currentExecution = terminalStateService.getCurrentExecution(ptyId)
    
    if (currentExecution?.output && currentExecution.output.length > 0) {
      // 有当前执行的命令输出，使用它（实时数据）
      allOutput = currentExecution.output.split('\n')
      dataSource = 'current_execution'
    } else {
      // 没有当前执行，优先使用实时缓冲区（Agent 运行期间收集的最新输出）
      const realtimeOutput = executor.getRealtimeTerminalOutput()
      if (realtimeOutput && realtimeOutput.length > 0) {
        allOutput = realtimeOutput
        dataSource = 'realtime_buffer'
      } else {
        // 实时缓冲区也为空，尝试获取最近完成的命令输出
        const lastExecution = terminalStateService.getLastExecution(ptyId)
        if (lastExecution?.output && lastExecution.output.length > 0) {
          allOutput = lastExecution.output.split('\n')
          dataSource = 'last_execution'
        } else {
          // 都没有，使用传入的 terminalOutput（Agent 启动时的快照）
          allOutput = terminalOutput
          dataSource = 'initial_snapshot'
        }
      }
    }
  } catch (e) {
    // 如果获取失败，使用传入的 terminalOutput
    allOutput = terminalOutput
    dataSource = 'fallback_snapshot'
  }
  
  let output = ''
  let readInfo = ''
  
  // 从开头读取
  if (fromStartLines !== undefined) {
    const startLines = Math.max(1, fromStartLines)
    const selectedLines = allOutput.slice(0, startLines)
    output = selectedLines.join('\n')
    readInfo = `从开头读取 ${startLines} 行`
  }
  // 按字符数读取（从末尾）
  else if (maxChars !== undefined) {
    const maxCharsValue = Math.max(100, Math.min(maxChars, 10000)) // 限制在 100-50000 之间
    // 从后向前累积行，直到达到字符数限制
    let charCount = 0
    const selectedLines: string[] = []
    for (let i = allOutput.length - 1; i >= 0; i--) {
      const line = allOutput[i]
      const lineWithNewline = (selectedLines.length > 0 ? '\n' : '') + line
      if (charCount + lineWithNewline.length > maxCharsValue) {
        break
      }
      selectedLines.unshift(line)
      charCount += lineWithNewline.length
    }
    output = selectedLines.join('\n')
    readInfo = `从末尾读取约 ${maxCharsValue} 字符 (实际 ${output.length} 字符, ${selectedLines.length} 行)`
  }
  // 按行数读取（从末尾，默认）
  else {
    const linesValue = lines || 50
    const selectedLines = allOutput.slice(-linesValue)
    output = selectedLines.join('\n')
    readInfo = `从末尾读取 ${selectedLines.length} 行`
  }
  
  // 清理 ANSI 转义序列
  const cleanOutput = stripAnsi(output)
  
  // UI 显示截断到 500 字符（保留最新内容），避免超出上下文限制
  // 注意：返回给 agent 的 output 字段是完整的，但建议使用 max_chars 参数控制大小
  const truncatedForDisplay = truncateFromEnd(cleanOutput, 500)
  
  executor.addStep({
    type: 'tool_result',
    content: `获取终端输出: ${readInfo} (${cleanOutput.length} 字符)`,
    toolName: 'get_terminal_context',
    toolResult: truncatedForDisplay
  })

  // 返回完整输出给 agent
  // 注意：如果输出很大，建议 agent 使用 max_chars 参数限制大小
  return { success: true, output: cleanOutput || '(终端输出为空)' }
}

/**
 * 检查终端状态（增强版）
 * 使用终端感知服务提供更丰富的状态信息
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
    // 使用增强的终端感知服务
    const awarenessService = getTerminalAwarenessService()
    const awareness = await awarenessService.getAwareness(ptyId)
    
    // 构建状态文本
    let statusIcon = ''
    let statusText = ''
    
    switch (awareness.status) {
      case 'idle':
        statusIcon = '✓'
        statusText = '终端空闲，可以执行命令'
        break
      case 'busy':
        statusIcon = '⏳'
        statusText = '终端忙碌'
        if (awareness.process.foregroundProcess) {
          statusText += `，正在执行: ${awareness.process.foregroundProcess}`
        }
        break
      case 'waiting_input':
        statusIcon = '⌨️'
        statusText = `终端等待输入 (${awareness.input.type})`
        if (awareness.input.prompt) {
          statusText += `\n提示: "${awareness.input.prompt}"`
        }
        break
      case 'stuck':
        statusIcon = '⚠️'
        statusText = '终端可能卡死'
        break
    }

    // 构建详情
    const details: string[] = [
      `## 终端状态: ${statusIcon} ${awareness.status === 'idle' ? '空闲' : awareness.status === 'busy' ? '忙碌' : awareness.status === 'waiting_input' ? '等待输入' : '可能卡死'}`
    ]

    // 输入等待信息
    if (awareness.input.isWaiting && awareness.input.type !== 'prompt' && awareness.input.type !== 'none') {
      details.push('')
      details.push('### 输入等待')
      details.push(`- 类型: ${awareness.input.type}`)
      if (awareness.input.prompt) {
        details.push(`- 提示: ${awareness.input.prompt}`)
      }
      if (awareness.input.options && awareness.input.options.length > 0) {
        details.push(`- 选项: ${awareness.input.options.slice(0, 5).join(', ')}${awareness.input.options.length > 5 ? '...' : ''}`)
      }
      if (awareness.input.suggestedResponse) {
        details.push(`- 建议响应: ${awareness.input.suggestedResponse}`)
      }
    }

    // 进程信息
    if (awareness.process.status !== 'idle') {
      details.push('')
      details.push('### 进程状态')
      details.push(`- 状态: ${awareness.process.status}`)
      if (awareness.process.foregroundProcess) {
        details.push(`- 前台进程: ${awareness.process.foregroundProcess}`)
      }
      if (awareness.process.runningTime) {
        details.push(`- 运行时长: ${Math.round(awareness.process.runningTime / 1000)}秒`)
      }
      if (awareness.process.outputRate !== undefined) {
        details.push(`- 输出速率: ${awareness.process.outputRate.toFixed(1)} 行/秒`)
      }
    }

    // 环境信息
    if (awareness.terminalState?.cwd || awareness.context.activeEnvs.length > 0) {
      details.push('')
      details.push('### 环境')
      if (awareness.terminalState?.cwd) {
        details.push(`- 当前目录: ${awareness.terminalState.cwd}`)
      }
      if (awareness.context.user) {
        details.push(`- 用户: ${awareness.context.user}${awareness.context.isRoot ? ' (root)' : ''}`)
      }
      if (awareness.context.activeEnvs.length > 0) {
        details.push(`- 激活环境: ${awareness.context.activeEnvs.join(', ')}`)
      }
    }

    // 最后命令信息
    if (awareness.terminalState?.lastCommand) {
      details.push('')
      details.push('### 最近命令')
      details.push(`- 命令: ${awareness.terminalState.lastCommand}`)
      if (awareness.terminalState.lastExitCode !== undefined) {
        details.push(`- 退出码: ${awareness.terminalState.lastExitCode}`)
      }
    }

    // 输出模式
    if (awareness.output.type !== 'normal' && awareness.output.confidence > 0.6) {
      details.push('')
      details.push('### 输出模式')
      details.push(`- 类型: ${awareness.output.type}`)
      if (awareness.output.details?.progress !== undefined) {
        details.push(`- 进度: ${awareness.output.details.progress}%`)
      }
      if (awareness.output.details?.eta) {
        details.push(`- 预计剩余: ${awareness.output.details.eta}`)
      }
      if (awareness.output.details?.testsPassed !== undefined || awareness.output.details?.testsFailed !== undefined) {
        details.push(`- 测试: ${awareness.output.details.testsPassed || 0} 通过, ${awareness.output.details.testsFailed || 0} 失败`)
      }
    }

    const detailsText = details.join('\n')

    executor.addStep({
      type: 'tool_result',
      content: `${statusIcon} ${statusText}`,
      toolName: 'check_terminal_status',
      toolResult: detailsText
    })

    // 构建完整输出
    const output = `${statusIcon} ${statusText}\n\n${detailsText}\n\n---\n**建议**: ${awareness.suggestion}\n**可执行命令**: ${awareness.canExecuteCommand ? '是' : '否'}\n**需要用户输入**: ${awareness.needsUserInput ? '是' : '否'}`

    return { success: true, output }
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
    executor.ptyService.write(ptyId, keySequence)
    
    // 等待一小段时间让终端响应
    await new Promise(resolve => setTimeout(resolve, 300))

    executor.addStep({
      type: 'tool_result',
      content: `已发送 ${key}`,
      toolName: 'send_control_key',
      toolResult: '控制键已发送'
    })

    return { 
      success: true, 
      output: `已发送 ${key}。请使用 get_terminal_context 查看终端当前状态。`
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
    executor.ptyService.write(ptyId, text)
    
    // 如果需要按回车
    if (pressEnter) {
      executor.ptyService.write(ptyId, '\r')
    }
    
    // 等待一小段时间让终端响应
    await new Promise(resolve => setTimeout(resolve, 300))

    executor.addStep({
      type: 'tool_result',
      content: `已发送: "${text}"${pressEnter ? ' + Enter' : ''}`,
      toolName: 'send_input',
      toolResult: '输入已发送'
    })

    return { 
      success: true, 
      output: `已发送输入 "${text}"${pressEnter ? ' 并按下回车' : ''}。请使用 get_terminal_context 查看终端响应。`
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
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): ToolResult {
  const filePath = args.path as string
  if (!filePath) {
    return { success: false, output: '', error: '文件路径不能为空' }
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
 */
async function writeFile(
  args: Record<string, unknown>,
  toolCallId: string,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const filePath = args.path as string
  const content = args.content as string
  if (!filePath) {
    return { success: false, output: '', error: '文件路径不能为空' }
  }

  // 文件写入需要确认
  executor.addStep({
    type: 'tool_call',
    content: `写入文件: ${filePath}`,
    toolName: 'write_file',
    toolArgs: { path: filePath, content: content?.substring(0, 100) + '...' },
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
    fs.writeFileSync(filePath, content, 'utf-8')
    executor.addStep({
      type: 'tool_result',
      content: `文件写入成功`,
      toolName: 'write_file'
    })
    return { success: true, output: `文件已写入: ${filePath}` }
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
 * 获取终端完整状态
 */
async function getTerminalState(
  ptyId: string,
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const includeHistory = args.include_history === true
  const historyLimit = typeof args.history_limit === 'number' ? args.history_limit : 5

  executor.addStep({
    type: 'tool_call',
    content: '获取终端状态',
    toolName: 'get_terminal_state',
    toolArgs: args,
    riskLevel: 'safe'
  })

  try {
    const terminalStateService = getTerminalStateService()
    const state = terminalStateService.getState(ptyId)
    const ptyStatus = await executor.ptyService.getTerminalStatus(ptyId)

    if (!state) {
      executor.addStep({
        type: 'tool_result',
        content: '终端状态未初始化',
        toolName: 'get_terminal_state',
        toolResult: '未找到终端状态'
      })
      return { success: false, output: '', error: '终端状态未初始化' }
    }

    const lines: string[] = [
      '## 终端状态',
      '',
      `- **运行状态**: ${ptyStatus.isIdle ? '空闲' : '忙碌'}`,
      `- **当前目录 (CWD)**: ${state.cwd}`,
      `- **最后命令**: ${state.lastCommand || '无'}`,
      `- **最后退出码**: ${state.lastExitCode !== undefined ? state.lastExitCode : '无'}`,
    ]

    if (ptyStatus.foregroundProcess) {
      lines.push(`- **前台进程**: ${ptyStatus.foregroundProcess} (PID: ${ptyStatus.foregroundPid})`)
    }

    // 如果有正在执行的命令
    const currentExecution = terminalStateService.getCurrentExecution(ptyId)
    if (currentExecution) {
      lines.push('')
      lines.push('## 正在执行的命令')
      lines.push(`- **命令**: ${currentExecution.command}`)
      lines.push(`- **开始时间**: ${new Date(currentExecution.startTime).toLocaleString()}`)
      lines.push(`- **执行目录**: ${currentExecution.cwdBefore}`)
      if (currentExecution.output) {
        const outputPreview = currentExecution.output.slice(-500)
        lines.push(`- **输出预览** (最后500字符):`)
        lines.push('```')
        lines.push(outputPreview)
        lines.push('```')
      }
    }

    // 如果需要历史记录
    if (includeHistory) {
      const history = terminalStateService.getExecutionHistory(ptyId, historyLimit)
      if (history.length > 0) {
        lines.push('')
        lines.push(`## 最近 ${history.length} 条命令历史`)
        for (const exec of history) {
          const duration = exec.duration ? `${exec.duration}ms` : '未知'
          const status = exec.exitCode === 0 ? '✓' : `✗ (退出码: ${exec.exitCode})`
          lines.push(`- ${status} \`${exec.command}\` (耗时: ${duration})`)
        }
      }
    }

    const output = lines.join('\n')

    executor.addStep({
      type: 'tool_result',
      content: `CWD: ${state.cwd}, 状态: ${ptyStatus.isIdle ? '空闲' : '忙碌'}`,
      toolName: 'get_terminal_state',
      toolResult: output
    })

    return { success: true, output }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : '获取状态失败'
    executor.addStep({
      type: 'tool_result',
      content: `获取状态失败: ${errorMsg}`,
      toolName: 'get_terminal_state',
      toolResult: errorMsg
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
  const options = args.options as string[] | undefined
  const defaultValue = args.default_value as string | undefined
  
  // 参数校验
  if (!question || typeof question !== 'string') {
    return { success: false, output: '', error: '问题不能为空' }
  }

  // 添加提问步骤（content 只保存问题，状态信息通过 toolResult 显示）
  const step = executor.addStep({
    type: 'asking',
    content: question,
    toolName: 'ask_user',
    toolArgs: { question, options, default_value: defaultValue },
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
    // 处理选项回复：如果用户输入的是数字，尝试匹配选项
    let finalResponse = userResponse.trim()
    if (options && options.length > 0) {
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
