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
      return '命令执行超时。建议：1) 检查网络连接；2) 使用 check_terminal_status 查看终端状态；3) 可能需要 send_control_key 发送 Ctrl+C。'
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
  waitForConfirmation: (
    toolCallId: string,
    toolName: string,
    toolArgs: Record<string, unknown>,
    riskLevel: RiskLevel
  ) => Promise<boolean>
  isAborted: () => boolean
  getHostId: () => string | undefined
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
      return getTerminalContext(args, terminalOutput, executor)

    case 'check_terminal_status':
      return checkTerminalStatus(ptyId, executor)

    case 'send_control_key':
      return sendControlKey(ptyId, args, executor)

    case 'read_file':
      return readFile(args, executor)

    case 'write_file':
      return writeFile(args, toolCall.id, executor)

    case 'remember_info':
      return rememberInfo(args, executor)

    case 'report_progress':
      return reportProgress(args, executor)

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
      executor.addStep({
        type: 'tool_result',
        content: `[MCP] 工具执行成功`,
        toolName: fullName,
        toolResult: result.content?.substring(0, 500) + (result.content && result.content.length > 500 ? '...' : '')
      })
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

    executor.addStep({
      type: 'tool_result',
      content: `命令执行完成 (耗时: ${result.duration}ms)`,
      toolName: 'execute_command',
      toolResult: result.output
    })

    return { success: true, output: result.output }
  } catch (error) {
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

      executor.addStep({
        type: 'tool_result',
        content: `✓ 命令执行了 ${timeout/1000} 秒`,
        toolName: 'execute_command',
        toolResult: finalOutput.substring(0, 500) + (finalOutput.length > 500 ? '...' : '')
      })

      resolve({ 
        success: true, 
        output: finalOutput || `命令执行了 ${timeout/1000} 秒，但没有输出内容。`
      })
    }, timeout)
  })
}

/**
 * 获取终端上下文
 */
function getTerminalContext(
  args: Record<string, unknown>,
  terminalOutput: string[],
  executor: ToolExecutorConfig
): ToolResult {
  const lines = parseInt(args.lines as string) || 50
  const output = terminalOutput.slice(-lines).join('\n')
  
  executor.addStep({
    type: 'tool_result',
    content: `获取终端最近 ${lines} 行输出`,
    toolName: 'get_terminal_context',
    toolResult: output.substring(0, 500) + (output.length > 500 ? '...' : '')
  })

  return { success: true, output: output || '(终端输出为空)' }
}

/**
 * 检查终端状态
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
    const status = await executor.ptyService.getTerminalStatus(ptyId)
    
    let statusText = ''
    if (status.isIdle) {
      statusText = `✓ 终端空闲，等待用户输入`
    } else {
      statusText = `⏳ 终端忙碌`
      if (status.foregroundProcess) {
        statusText += `，正在执行: ${status.foregroundProcess}`
      }
      if (status.foregroundPid) {
        statusText += ` (PID: ${status.foregroundPid})`
      }
    }
    
    const details = [
      `状态: ${status.isIdle ? '空闲' : '忙碌'}`,
      status.stateDescription,
      status.shellPid ? `Shell PID: ${status.shellPid}` : null,
      status.foregroundProcess ? `前台进程: ${status.foregroundProcess}` : null,
    ].filter(Boolean).join('\n')

    executor.addStep({
      type: 'tool_result',
      content: statusText,
      toolName: 'check_terminal_status',
      toolResult: details
    })

    return { 
      success: true, 
      output: `${statusText}\n\n详情:\n${details}\n\n${status.isIdle 
        ? '可以执行新命令。' 
        : '建议：使用 send_control_key 发送 ctrl+c 中断当前命令，或等待命令完成。'}`
    }
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
 * 读取文件
 */
function readFile(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): ToolResult {
  const filePath = args.path as string
  if (!filePath) {
    return { success: false, output: '', error: '文件路径不能为空' }
  }

  executor.addStep({
    type: 'tool_call',
    content: `读取文件: ${filePath}`,
    toolName: 'read_file',
    toolArgs: args,
    riskLevel: 'safe'
  })

  try {
    const content = fs.readFileSync(filePath, 'utf-8')
    executor.addStep({
      type: 'tool_result',
      content: `文件读取成功 (${content.length} 字符)`,
      toolName: 'read_file',
      toolResult: content.substring(0, 500) + (content.length > 500 ? '...' : '')
    })
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
 * 报告任务进度
 */
function reportProgress(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): ToolResult {
  const status = args.status as string
  const currentStep = args.current_step as string
  const findings = args.findings as string | undefined
  const nextAction = args.next_action as string | undefined
  const blockedReason = args.blocked_reason as string | undefined

  if (!status || !currentStep) {
    return { success: false, output: '', error: '必须提供 status 和 current_step' }
  }

  // 构建进度报告
  const statusIcons: Record<string, string> = {
    started: '🚀',
    in_progress: '🔄',
    completed: '✅',
    blocked: '⚠️'
  }

  const icon = statusIcons[status] || '📋'
  let progressReport = `${icon} **${currentStep}**\n`

  if (findings) {
    progressReport += `\n**发现**: ${findings}`
  }

  if (status === 'blocked' && blockedReason) {
    progressReport += `\n**阻碍原因**: ${blockedReason}`
  }

  if (nextAction && status !== 'completed') {
    progressReport += `\n**下一步**: ${nextAction}`
  }

  executor.addStep({
    type: 'tool_call',
    content: `进度报告: ${status}`,
    toolName: 'report_progress',
    toolArgs: args,
    riskLevel: 'safe'
  })

  executor.addStep({
    type: 'tool_result',
    content: progressReport,
    toolName: 'report_progress',
    toolResult: progressReport
  })

  return { 
    success: true, 
    output: `进度已记录。状态: ${status}, 当前步骤: ${currentStep}` 
  }
}
