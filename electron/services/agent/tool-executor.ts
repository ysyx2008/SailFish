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
  HostProfileServiceInterface,
  AgentPlan,
  AgentPlanStep,
  PlanStepStatus
} from './types'
import { assessCommandRisk, analyzeCommand, isSudoCommand, detectPasswordPrompt } from './risk-assessor'
import { t } from './i18n'
import { getKnowledgeService } from '../knowledge'
import { getDocumentParserService } from '../document-parser.service'
import { getTerminalStateService } from '../terminal-state.service'
import { getTerminalAwarenessService, getProcessMonitor } from '../terminal-awareness'
import { getLastNLinesFromBuffer, getScreenAnalysisFromFrontend } from '../screen-content.service'
import type { UnifiedTerminalInterface } from '../unified-terminal.service'
import type { SftpService } from '../sftp.service'
import type { SshConfig } from '../ssh.service'
import type { SkillSession } from './skills'

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
      return t('error.transient')
    case 'permission':
      return t('error.permission')
    case 'not_found':
      return t('error.not_found')
    case 'timeout':
      return t('error.timeout')
    case 'fatal':
      return t('error.execution_failed')
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
  // Plan/Todo 功能
  getCurrentPlan: () => AgentPlan | undefined  // 获取当前计划
  setCurrentPlan: (plan: AgentPlan | undefined) => void  // 设置当前计划
  // SFTP 功能（用于 SSH 终端的文件写入）
  getSftpService?: () => SftpService | undefined  // 获取 SFTP 服务
  getSshConfig?: (terminalId: string) => SshConfig | null  // 获取 SSH 连接配置
  // 技能系统
  skillSession?: SkillSession  // 技能会话管理器
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
    return { success: false, output: '', error: t('error.operation_aborted') }
  }

  const { name, arguments: argsStr } = toolCall.function
  let args: Record<string, unknown>
  
  try {
    args = JSON.parse(argsStr)
  } catch {
    return { success: false, output: '', error: t('error.tool_param_parse_failed') }
  }

  // 根据工具类型执行
  switch (name) {
    case 'execute_command':
      return executeCommand(ptyId, args, toolCall.id, config, executor)

    case 'get_terminal_context':
      return await getTerminalContext(ptyId, args, executor)

    case 'check_terminal_status':
      return checkTerminalStatus(ptyId, config, executor)

    case 'send_control_key':
      return sendControlKey(ptyId, args, config, executor)

    case 'send_input':
      return sendInput(ptyId, args, config, executor)

    case 'read_file':
      return await readFile(ptyId, args, config, executor)

    case 'write_file':
      return writeFile(ptyId, args, toolCall.id, config, executor)

    case 'remember_info':
      return await rememberInfo(args, config, executor)

    case 'search_knowledge':
      return searchKnowledge(args, executor)

    case 'get_knowledge_doc':
      return getKnowledgeDoc(args, executor)

    case 'wait':
      return wait(args, executor)

    case 'ask_user':
      return askUser(args, executor)

    case 'create_plan':
      return createPlan(args, executor)

    case 'update_plan':
      return updatePlan(args, executor)

    case 'clear_plan':
      return clearPlan(args, executor)

    case 'load_skill':
      return await loadSkillTool(args, executor)

    default:
      // 检查是否是技能工具调用
      if (executor.skillSession) {
        const skillTools = executor.skillSession.getAvailableTools()
        const skillTool = skillTools.find(t => t.function.name === name)
        if (skillTool) {
          return await executeSkillTool(name, ptyId, args, toolCall.id, config, executor)
        }
      }
      
      // 检查是否是 MCP 工具调用
      if (name.startsWith('mcp_') && executor.mcpService) {
        return executeMcpTool(name, args, toolCall.id, executor)
      }
      return { success: false, output: '', error: t('error.unknown_tool', { name }) }
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
    return { success: false, output: '', error: t('error.mcp_not_initialized') }
  }

  // 解析工具名称: mcp_{serverId}_{toolName}
  const parsed = executor.mcpService.parseToolCallName(fullName)
  if (!parsed) {
    return { success: false, output: '', error: t('error.invalid_mcp_tool_name', { name: fullName }) }
  }

  const { serverId, toolName } = parsed

  // 检查服务器是否已连接
  if (!executor.mcpService.isConnected(serverId)) {
    return { success: false, output: '', error: t('error.mcp_server_not_connected', { server: serverId }) }
  }

  // 添加工具调用步骤
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
      // UI 显示截断到 500 字符（保留最新内容），但返回给 agent 的 output 是完整的
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
      // 返回完整内容给 agent，不进行截断
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
    return { success: false, output: '', error: t('hint.command_empty') }
  }

  // 先检查终端状态，确认是否可以执行命令
  const awarenessService = getTerminalAwarenessService()
  const preAdvice = await awarenessService.getPreExecutionAdvice(ptyId, command)
  
  if (!preAdvice.canExecute) {
    // 终端当前不能执行命令
    const isBusy = preAdvice.reason?.includes('终端正在执行命令')
    
    if (isBusy) {
      // 终端正在执行命令：命令确实没执行，但这不是 Agent 的错误，是需要等待的状态
      // 返回 isRunning: true，不计入失败统计，避免触发无意义的重试循环
      const waitMsg = `⏳ ${t('hint.wait_terminal')}\n\n💡 ${t('hint.wait_suggestions')}`
      executor.addStep({
        type: 'tool_call',
        content: `⏳ ${command}`,
        toolName: 'execute_command',
        toolArgs: { command },
        riskLevel: 'safe'  // 不是 blocked，只是需要等待
      })
      executor.addStep({
        type: 'tool_result',
        content: t('status.terminal_busy'),
        toolName: 'execute_command',
        toolResult: waitMsg
      })
      // success: false（命令确实没执行）
      // isRunning: true（但不计入失败统计，因为这是外部状态导致的，不是 Agent 决策错误）
      return { success: false, output: waitMsg, error: waitMsg, isRunning: true }
    }
    
    // 其他原因（等待输入、卡死等）：返回错误让 agent 处理
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

  // 分析命令，获取处理策略
  const handling = analyzeCommand(command)
  // 保存 strategy 避免 TypeScript 类型收窄问题
  const strategy: 'allow' | 'auto_fix' | 'timed_execution' | 'fire_and_forget' | 'block' = handling.strategy

  // 策略1: 禁止执行（如 vim/nano 等全屏编辑器）
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

  // 策略2: 自动修正命令（如添加 -y、-c 参数）
  if (strategy === 'auto_fix' && handling.fixedCommand) {
    command = handling.fixedCommand
  }

  // 评估风险
  const riskLevel = assessCommandRisk(command)

  // 检查是否被安全策略阻止
  if (riskLevel === 'blocked') {
    return { 
      success: false, 
      output: '', 
      error: t('hint.security_blocked')
    }
  }

  // 根据执行模式决定是否需要确认
  // strict: 所有命令都需要确认
  // relaxed: 只有危险命令需要确认
  // free: 不需要任何确认（危险！）
  let needConfirm = false
  if (config.executionMode === 'strict') {
    // 严格模式：所有命令需要确认
    needConfirm = true
  } else if (config.executionMode === 'relaxed') {
    // 宽松模式：只有危险命令需要确认
    needConfirm = riskLevel === 'dangerous'
  }
  // free 模式：不需要任何确认（needConfirm 保持 false）

  // 添加工具调用步骤（统一显示最终要执行的命令）
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
  }

  // 策略3: 限时执行（保留用于特殊场景）
  if (strategy === 'timed_execution') {
    return executeTimedCommand(
      ptyId, 
      command, 
      handling.suggestedTimeout || 5000,
      handling.timeoutAction || 'ctrl_c',
      executor
    )
  }

  // 策略4: 发送即返回（如 tail -f、ping、top 等持续运行的命令）
  if (strategy === 'fire_and_forget') {
    return executeFireAndForget(ptyId, command, handling, executor)
  }

  // 策略4: sudo/特权命令 - 需要等待用户输入密码
  if (isSudoCommand(command)) {
    return executeSudoCommand(ptyId, command, toolCallId, config, executor)
  }

  // 正常执行命令（带重试机制）
  // 使用 terminal-state.service 追踪命令执行，以便 get_terminal_context 可以获取实时输出
  const terminalStateService = getTerminalStateService()
  
  // 开始追踪命令执行（标记为 Agent 来源，前端可据此显示卡片）
  terminalStateService.startCommandExecution(ptyId, command, {
    source: 'agent',
    agentStepTitle: (strategy as string) === 'timed_execution'
      ? `⏱️ ${command}`
      : command
  })
  
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
            content: `⏳ ${t('status.command_running')} (${config.commandTimeout / 1000}${t('misc.seconds')})`,
            toolName: 'execute_command',
            toolResult: latestOutput + '\n\n💡 ' + t('hint.long_running_command')
          })
        return {
          success: true,  // 长耗时命令超时不算失败
          output: latestOutput + '\n\n💡 ' + t('error.command_still_running'),
          isRunning: true  // 标记命令仍在运行
        }
      }
      
      // 普通命令超时：可能有问题
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

    // 命令正常完成，移除监听器并完成追踪
    unsubscribe()
    terminalStateService.completeCommandExecution(ptyId, 0, 'completed')
    
    // 只在调试模式显示完成步骤（非调试模式下终端输出已可见）
    if (config.debugMode) {
      executor.addStep({
        type: 'tool_result',
        content: `${t('status.command_complete')} (${t('misc.duration')}: ${result.duration}ms)`,
        toolName: 'execute_command',
        toolResult: result.output
      })
    }

    return { success: true, output: result.output }
  } catch (error) {
    // 命令执行出错，移除监听器并完成追踪
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
        return { success: false, output: stripAnsi(output), error: t('error.operation_aborted') }
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
        
        const cleanOutput = stripAnsi(output)
        
        // 主要依赖前端屏幕分析来判断状态（让前端的智能检测来决定）
        // 避免后端使用正则硬编码，因为 shell 提示符格式千变万化
        const screenAnalysis = await getScreenAnalysisFromFrontend(ptyId, 1000)
        if (screenAnalysis) {
          // 如果前端检测到当前是 prompt 状态（shell 提示符），命令已完成
          if (screenAnalysis.input.type === 'prompt' && screenAnalysis.input.confidence > 0.7) {
            break
          }
          // 如果前端不再检测到密码等待状态，且终端空闲，认为命令已完成
          // 即使判断有误，Agent 后续可以通过 check_terminal_status 自行确认
          if (screenAnalysis.input.type !== 'password' && status.isIdle && timeSinceLastOutput > 500) {
            break
          }
        }
        
        // 备用判断：如果前端分析不可用，使用简单的启发式规则
        // 有新输出 + 终端空闲 + 输出稳定一段时间 = 可能完成
        const hasNewOutputAfterPrompt = output.length > outputLengthAtPasswordPrompt
        if (hasNewOutputAfterPrompt && status.isIdle && timeSinceLastOutput > 1000) {
          // 宁可早返回，让 Agent 自己通过 check_terminal_status 确认
          break
        }
        
        // 检查是否用户取消了或密码错误
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
              content: `${t('password.enter_in_terminal')}\n⏰ ${t('password.waiting_long')}`
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
        content: t('password.verification_complete')
      })
    }
    
    // 只在调试模式显示完成步骤
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
    
    // 注册输出收集器并保存 unsubscribe 函数
    const dataHandler = (data: string) => {
      output += data
    }
    const unsubscribe = executor.terminalService.onData(ptyId, dataHandler)
    
    // 发送命令
    executor.terminalService.write(ptyId, command + '\r')
    
    // 设置超时后发送退出信号
    setTimeout(async () => {
      // 清理监听器（重要：防止内存泄漏）
      unsubscribe()
      
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
        content: `✓ ${t('timed.command_executed', { seconds: timeout/1000, chars: finalOutput.length })}`,
        toolName: 'execute_command',
        toolResult: truncatedDisplay
      })

      // 返回完整输出给 agent，不进行截断
      resolve({ 
        success: true, 
        output: finalOutput || t('command.no_output', { seconds: timeout/1000 })
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
    const errorMsg = e instanceof Error ? e.message : t('error.unknown')
    return { success: false, output: '', error: t('error.get_terminal_output_failed', { error: errorMsg }) }
  }
  
  if (!bufferLines || bufferLines.length === 0) {
    return { success: true, output: t('error.terminal_output_empty') }
  }
  
  const output = stripAnsi(bufferLines.join('\n'))
  
  executor.addStep({
    type: 'tool_result',
    content: `${t('context.get_output')}: ${bufferLines.length}`,
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
  config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  // 只在调试模式显示"正在检查"步骤
  if (config.debugMode) {
    executor.addStep({
      type: 'tool_call',
      content: t('terminal.checking_status'),
      toolName: 'check_terminal_status',
      toolArgs: {},
      riskLevel: 'safe'
    })
  }

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
      displayStatus = t('input.waiting_for', { type: screenAnalysis.input.type })
    } else if (isSsh) {
      displayStatus = t('terminal.check_output')
    }
    executor.addStep({
      type: 'tool_result',
      content: `${t('terminal.status')}: ${displayStatus}`,
      toolName: 'check_terminal_status',
      toolResult: terminalOutput.length > 0 ? t('terminal.output_lines', { count: terminalOutput.length }) : t('terminal.no_output')
    })

    return { success: true, output: outputText }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : t('terminal.status_detection_failed')
    executor.addStep({
      type: 'tool_result',
      content: `${t('terminal.status_detection_failed')}: ${errorMsg}`,
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
  config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const key = args.key as string
  if (!key) {
    return { success: false, output: '', error: t('error.control_key_required') }
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
    return { success: false, output: '', error: t('error.control_key_not_supported', { key }) }
  }

  executor.addStep({
    type: 'tool_call',
    content: `${t('control.send_key')}: ${key}`,
    toolName: 'send_control_key',
    toolArgs: { key },
    riskLevel: 'safe'
  })

  try {
    // 直接写入 PTY
    executor.terminalService.write(ptyId, keySequence)
    
    // 等待终端输出稳定（适应网络延迟）
    const terminalOutput = await waitForStableOutput(ptyId)

    // 只在调试模式显示完成步骤
    if (config.debugMode) {
      executor.addStep({
        type: 'tool_result',
        content: `${t('control.key_sent')} ${key}`,
        toolName: 'send_control_key',
        toolResult: terminalOutput ? truncateFromEnd(terminalOutput, 300) : t('control.key_sent_result')
      })
    }

    return { 
      success: true, 
      output: terminalOutput 
        ? t('control.key_sent_with_output', { key, output: terminalOutput })
        : t('control.key_sent_output', { key })
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : t('control.send_failed')
    return { success: false, output: '', error: errorMsg }
  }
}

/**
 * 发送文本输入到终端
 */
async function sendInput(
  ptyId: string,
  args: Record<string, unknown>,
  config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const text = args.text as string
  const pressEnter = args.press_enter !== false // 默认 true

  if (text === undefined || text === null) {
    return { success: false, output: '', error: t('error.input_text_required') }
  }

  // 安全检查：限制输入长度，防止发送过长的内容
  if (text.length > 1000) {
    return { success: false, output: '', error: t('error.input_text_too_long') }
  }

  executor.addStep({
    type: 'tool_call',
    content: `${t('input.send')}: "${text}"${pressEnter ? ' + Enter' : ''}`,
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
    
    // 只在调试模式显示完成步骤
    if (config.debugMode) {
      executor.addStep({
        type: 'tool_result',
        content: `${t('input.sent')}: ${inputDesc}`,
        toolName: 'send_input',
        toolResult: terminalOutput ? truncateFromEnd(terminalOutput, 300) : t('input.sent')
      })
    }

    return { 
      success: true, 
      output: terminalOutput 
        ? t('input.sent_with_output', { input: inputDesc, output: terminalOutput })
        : t('input.sent_output', { input: inputDesc })
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : t('input.send_failed')
    return { success: false, output: '', error: errorMsg }
  }
}

/**
 * 检测是否为文档类型（PDF、Word 等需要特殊解析的文件）
 */
function isDocumentType(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase()
  return ['.pdf', '.docx', '.doc'].includes(ext)
}

/**
 * 读取文件
 * 支持多种读取方式：完整读取、按行范围读取、从开头/末尾读取、仅查询文件信息
 * 对于 PDF、Word 等文档格式，会自动使用文档解析器提取文本内容
 */
async function readFile(
  ptyId: string,
  args: Record<string, unknown>,
  config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  let filePath = args.path as string
  if (!filePath) {
    return { success: false, output: '', error: t('error.file_path_required') }
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

  // 只在调试模式显示"正在读取"步骤
  if (config.debugMode) {
    executor.addStep({
      type: 'tool_call',
      content: infoOnly ? `${t('file.reading_info_only')}: ${filePath}` : `${t('file.reading')}: ${filePath}`,
      toolName: 'read_file',
      toolArgs: args,
      riskLevel: 'safe'
    })
  }

  try {
    const stats = fs.statSync(filePath)
    const fileSize = stats.size
    const sizeMB = (fileSize / (1024 * 1024)).toFixed(2)

    // 检测是否为文档类型（PDF、Word 等）
    if (isDocumentType(filePath) && !infoOnly) {
      return await readDocumentFile(filePath, fileSize, executor)
    }
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

      const info = `## ${t('file.info_header')}
- **${t('file.info_path')}**: ${filePath}
- **${t('file.info_size')}**: ${t('file.info_size_value', { sizeMB, sizeBytes: fileSize.toLocaleString() })}
- **${t('file.info_lines')}**: ${t('file.info_lines_value', { count: totalLines.toLocaleString() })}${estimated ? ` ${t('file.info_estimated')}` : ''}
- **${t('file.info_suggestion')}**: ${fileSize > 500 * 1024 ? t('file.info_suggestion_large') : t('file.info_suggestion_small')}

${sampleContent ? `### ${t('file.info_preview')}\n\`\`\`\n${sampleContent}\n\`\`\`` : ''}`

      executor.addStep({
        type: 'tool_result',
        content: `${t('file.file_info')}: ${sizeMB} MB, ${totalLines.toLocaleString()}`,
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
        const errorMsg = t('file.too_large_error', { size: sizeMB })
        executor.addStep({
          type: 'tool_result',
          content: `${t('file.read_failed')}: ${t('file.file_too_large')}`,
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
      readInfo.push(t('file.read_line_range', { start: startLine || 1, end: endLine || t('file.end_of_file') }))
    } else if (maxLines !== undefined) {
      readInfo.push(t('file.read_first_n', { count: maxLines }))
    } else if (tailLines !== undefined) {
      readInfo.push(t('file.read_last_n', { count: tailLines }))
    } else {
      readInfo.push(t('file.full_read'))
    }
    readInfo.push(t('file.actual_read', { lines: actualLines.length, chars: content.length.toLocaleString() }))

    executor.addStep({
      type: 'tool_result',
      content: `${t('file.read_success')}: ${readInfo.join(', ')}`,
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
      content: `${t('file.read_failed')}: ${errorMsg}`,
      toolName: 'read_file',
      toolResult: `${errorMsg}\n\n💡 ${suggestion}`
    })
    return { success: false, output: '', error: t('error.recovery_hint', { error: errorMsg, suggestion }) }
  }
}

/**
 * 读取文档文件（PDF、Word 等）
 * 使用 DocumentParserService 提取文本内容
 */
async function readDocumentFile(
  filePath: string,
  fileSize: number,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const ext = path.extname(filePath).toLowerCase()
  const fileName = path.basename(filePath)
  
  try {
    const documentParser = getDocumentParserService()
    
    // 解析文档
    const result = await documentParser.parseDocument({
      name: fileName,
      path: filePath,
      size: fileSize
    }, {
      maxFileSize: 10 * 1024 * 1024, // 10MB
      maxTextLength: 100000 // 100K 字符
    })
    
    if (result.error) {
      executor.addStep({
        type: 'tool_result',
        content: `${t('file.read_failed')}: ${result.error}`,
        toolName: 'read_file',
        toolResult: result.error
      })
      return { success: false, output: '', error: result.error }
    }
    
    // 构建返回信息
    const docInfo: string[] = []
    docInfo.push(`📄 ${ext.toUpperCase().slice(1)} ${t('file.document_parsed')}`)
    if (result.pageCount) {
      docInfo.push(`${t('file.page_count')}: ${result.pageCount}`)
    }
    docInfo.push(`${t('file.content_length')}: ${result.content.length.toLocaleString()} ${t('file.chars')}`)
    
    executor.addStep({
      type: 'tool_result',
      content: `${t('file.read_success')}: ${docInfo.join(', ')}`,
      toolName: 'read_file',
      toolResult: truncateFromEnd(result.content, 500)
    })
    
    return { success: true, output: result.content }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : t('file.parse_failed')
    executor.addStep({
      type: 'tool_result',
      content: `${t('file.read_failed')}: ${errorMsg}`,
      toolName: 'read_file',
      toolResult: errorMsg
    })
    return { success: false, output: '', error: errorMsg }
  }
}

/**
 * 加载技能工具
 */
async function loadSkillTool(
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
    const toolsList = result.toolsAdded?.join(', ') || ''
    const output = t('skill.loaded', { 
      name: result.skillName || skillId, 
      tools: toolsList 
    })
    
    executor.addStep({
      type: 'tool_result',
      content: output,
      toolName: 'load_skill',
      toolResult: output
    })
    
    return { success: true, output }
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
 * 执行技能工具
 * 路由到具体的技能执行器
 */
async function executeSkillTool(
  toolName: string,
  ptyId: string,
  args: Record<string, unknown>,
  toolCallId: string,
  config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  // Excel 技能工具
  if (toolName.startsWith('excel_')) {
    const { executeExcelTool } = await import('./skills/excel/executor')
    return executeExcelTool(toolName, ptyId, args, toolCallId, config, executor)
  }
  
  // 未知技能工具
  return { success: false, output: '', error: t('error.unknown_tool', { name: toolName }) }
}

/**
 * 通过 SFTP 写入远程文件（用于 SSH 终端）
 * 在终端显示写入提示，让用户感知操作过程
 */
async function writeFileViaSftp(
  ptyId: string,
  filePath: string,
  content: string,
  mode: 'overwrite' | 'create' | 'append',
  toolCallId: string,
  config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const sftpService = executor.getSftpService?.()
  const sshConfig = executor.getSshConfig?.(ptyId)

  // 检查 SFTP 服务是否可用
  if (!sftpService) {
    return { 
      success: false, 
      output: '', 
      error: t('error.sftp_not_initialized') 
    }
  }

  if (!sshConfig) {
    return { 
      success: false, 
      output: '', 
      error: t('error.ssh_config_unavailable') 
    }
  }


  const contentLength = content.length
  const contentSizeKB = (contentLength / 1024).toFixed(1)

  // 在终端显示写入提示
  executor.terminalService.write(ptyId, `echo "📝 ${t('file.writing_remote', { path: filePath, size: contentSizeKB })}"\r`)
  
  // 等待 echo 命令执行
  await new Promise(resolve => setTimeout(resolve, 300))

  try {
    // 确保 SFTP 连接已建立
    if (!sftpService.hasSession(ptyId)) {
      executor.addStep({
        type: 'tool_result',
        content: t('file.establishing_sftp'),
        toolName: 'write_file',
        isStreaming: true
      })

      // 构建 SFTP 配置（从 SSH 配置转换）
      const sftpConfig = {
        host: sshConfig.host,
        port: sshConfig.port,
        username: sshConfig.username,
        password: sshConfig.password,
        privateKey: sshConfig.privateKey,
        privateKeyPath: sshConfig.privateKeyPath,
        passphrase: sshConfig.passphrase
      }

      await sftpService.connect(ptyId, sftpConfig)
    }

    // 根据模式写入文件
    let resultMsg: string
    if (mode === 'create') {
      // 新建模式：检查文件是否存在
      let fileExists = false
      try {
        await sftpService.readFile(ptyId, filePath)
        fileExists = true
      } catch {
        // 文件不存在，可以创建
      }
      if (fileExists) {
        return { success: false, output: '', error: t('error.file_exists_cannot_create', { path: filePath }) }
      }
      await sftpService.writeFile(ptyId, filePath, content)
      resultMsg = `${t('file.result_remote_created')}: ${filePath}`
    } else if (mode === 'append') {
      // 追加模式：先读取现有内容，再写入
      let existingContent = ''
      try {
        existingContent = await sftpService.readFile(ptyId, filePath)
      } catch {
        // 文件不存在，忽略错误
      }
      await sftpService.writeFile(ptyId, filePath, existingContent + content)
      resultMsg = `${t('file.result_remote_appended')}: ${filePath}`
    } else {
      // 覆盖模式
      await sftpService.writeFile(ptyId, filePath, content)
      resultMsg = `${t('file.result_remote_written')}: ${filePath}`
    }

    // 在终端显示完成提示
    executor.terminalService.write(ptyId, `echo "✅ ${t('file.write_success')}: ${filePath}"\r`)
    
    // 等待 echo 命令执行
    await new Promise(resolve => setTimeout(resolve, 300))

    executor.addStep({
      type: 'tool_result',
      content: resultMsg,
      toolName: 'write_file'
    })

    return { success: true, output: resultMsg }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : t('file.remote_write_failed')
    
    // 在终端显示错误提示
    executor.terminalService.write(ptyId, `echo "❌ ${t('file.write_failed')}: ${errorMsg}"\r`)
    
    executor.addStep({
      type: 'tool_result',
      content: `${t('file.remote_write_failed')}: ${errorMsg}`,
      toolName: 'write_file',
      toolResult: errorMsg
    })

    return { success: false, output: '', error: `${t('file.remote_write_failed')}: ${errorMsg}` }
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
  config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  let filePath = args.path as string
  const content = args.content as string | undefined
  const mode = (args.mode as string) || 'create'
  const insertAtLine = args.insert_at_line as number | undefined
  const startLine = args.start_line as number | undefined
  const endLine = args.end_line as number | undefined
  const pattern = args.pattern as string | undefined
  const replacement = args.replacement as string | undefined
  const replaceAll = args.replace_all !== false // 默认 true

  if (!filePath) {
    return { success: false, output: '', error: t('error.file_path_required') }
  }

  // 验证模式和必要参数
  const validModes = ['overwrite', 'create', 'append', 'insert', 'replace_lines', 'regex_replace']
  if (!validModes.includes(mode)) {
    return { success: false, output: '', error: t('error.invalid_write_mode', { mode, modes: validModes.join(', ') }) }
  }

  // 验证各模式的必要参数
  if (mode === 'overwrite' || mode === 'create' || mode === 'append') {
    if (content === undefined) {
      return { success: false, output: '', error: t('error.content_required_for_mode', { mode }) }
    }
  } else if (mode === 'insert') {
    if (content === undefined) {
      return { success: false, output: '', error: t('error.insert_content_required') }
    }
    if (insertAtLine === undefined || insertAtLine < 1) {
      return { success: false, output: '', error: t('error.insert_line_required') }
    }
  } else if (mode === 'replace_lines') {
    if (content === undefined) {
      return { success: false, output: '', error: t('error.replace_content_required') }
    }
    if (startLine === undefined || startLine < 1) {
      return { success: false, output: '', error: t('error.replace_start_line_required') }
    }
    if (endLine === undefined || endLine < startLine) {
      return { success: false, output: '', error: t('error.replace_end_line_required') }
    }
  } else if (mode === 'regex_replace') {
    if (pattern === undefined) {
      return { success: false, output: '', error: t('error.regex_pattern_required') }
    }
    if (replacement === undefined) {
      return { success: false, output: '', error: t('error.regex_replacement_required') }
    }
  }

  // 检测终端类型，SSH 终端使用 SFTP 写入
  const terminalType = executor.terminalService.getTerminalType(ptyId)
  if (terminalType === 'ssh') {
    // SSH 终端只支持 overwrite、create 和 append 模式
    if (mode !== 'overwrite' && mode !== 'create' && mode !== 'append') {
      return { success: false, output: '', error: t('error.ssh_mode_not_supported', { mode }) }
    }
    if (content === undefined) {
      return { success: false, output: '', error: t('error.ssh_content_required') }
    }
    return writeFileViaSftp(ptyId, filePath, content, mode, toolCallId, config, executor)
  }

  // 本地终端：使用本地文件系统
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
      operationDesc = `${t('file.overwrite')}: ${filePath}`
      break
    case 'create':
      operationDesc = `${t('file.create')}: ${filePath}`
      break
    case 'append':
      operationDesc = `${t('file.append')}: ${filePath}`
      break
    case 'insert':
      operationDesc = `${t('file.insert_at_line', { line: insertAtLine! })}: ${filePath}`
      break
    case 'replace_lines':
      operationDesc = `${t('file.replace_lines', { start: startLine!, end: endLine! })}: ${filePath}`
      break
    case 'regex_replace':
      operationDesc = `${t('file.regex_replace', { scope: replaceAll ? t('file.regex_scope_all') : t('file.regex_scope_first') })}: ${filePath}`
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

  // 严格模式下需要确认文件写入操作
  if (config.executionMode === 'strict') {
    const approved = await executor.waitForConfirmation(
      toolCallId, 
      'write_file', 
      args, 
      'moderate'
    )
    if (!approved) {
      return { success: false, output: '', error: t('file.user_rejected_write') }
    }
  }

  // 计算内容大小，用于进度提示
  const contentLength = content?.length || 0
  const contentSizeKB = (contentLength / 1024).toFixed(1)
  const isLargeContent = contentLength > 10000 // 10KB 以上显示进度

  // 对于大文件，添加写入进度提示
  let progressStepId: string | undefined
  if (isLargeContent) {
    const progressStep =       executor.addStep({
        type: 'tool_result',
        content: `⏳ ${t('file.writing_progress')}（${contentSizeKB} KB）`,
        toolName: 'write_file',
      isStreaming: true
    })
    progressStepId = progressStep.id
    // 给前端一点时间显示进度提示
    await new Promise(resolve => setTimeout(resolve, 50))
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
        resultMsg = `${fileExists ? t('file.result_overwritten') : t('file.result_created')}: ${filePath}`
        break
      }
      case 'create': {
        if (fileExists) {
          return { success: false, output: '', error: t('error.file_exists_cannot_create', { path: filePath }) }
        }
        fs.writeFileSync(filePath, content!, 'utf-8')
        resultMsg = `${t('file.result_created')}: ${filePath}`
        break
      }
      case 'append': {
        fs.appendFileSync(filePath, content!, 'utf-8')
        resultMsg = `${t('file.result_appended')}: ${filePath}`
        break
      }
      case 'insert': {
        if (!fileExists) {
          return { success: false, output: '', error: t('error.file_not_exists_for_insert') }
        }
        const lines = fs.readFileSync(filePath, 'utf-8').split('\n')
        const insertIndex = Math.min(insertAtLine! - 1, lines.length)
        const contentLines = content!.split('\n')
        lines.splice(insertIndex, 0, ...contentLines)
        fs.writeFileSync(filePath, lines.join('\n'), 'utf-8')
        resultMsg = `${t('file.result_inserted', { line: insertAtLine!, count: contentLines.length })}: ${filePath}`
        break
      }
      case 'replace_lines': {
        if (!fileExists) {
          return { success: false, output: '', error: t('error.file_not_exists_for_replace') }
        }
        const lines = fs.readFileSync(filePath, 'utf-8').split('\n')
        const totalLines = lines.length
        if (startLine! > totalLines) {
          return { success: false, output: '', error: t('error.start_line_exceeds_total', { start: startLine!, total: totalLines }) }
        }
        const actualEndLine = Math.min(endLine!, totalLines)
        const deleteCount = actualEndLine - startLine! + 1
        const contentLines = content!.split('\n')
        lines.splice(startLine! - 1, deleteCount, ...contentLines)
        fs.writeFileSync(filePath, lines.join('\n'), 'utf-8')
        resultMsg = `${t('file.result_replaced_lines', { start: startLine!, end: actualEndLine, deleteCount, newCount: contentLines.length })}: ${filePath}`
        break
      }
      case 'regex_replace': {
        if (!fileExists) {
          return { success: false, output: '', error: t('error.file_not_exists_for_regex') }
        }
        const fileContent = fs.readFileSync(filePath, 'utf-8')
        let regex: RegExp
        try {
          regex = new RegExp(pattern!, replaceAll ? 'g' : '')
        } catch (e) {
          return { success: false, output: '', error: t('error.invalid_regex_pattern', { pattern: pattern! }) }
        }
        const matches = fileContent.match(regex)
        if (!matches || matches.length === 0) {
          return { success: false, output: '', error: t('error.regex_no_match', { pattern: pattern! }) }
        }
        const newContent = fileContent.replace(regex, replacement!)
        fs.writeFileSync(filePath, newContent, 'utf-8')
        resultMsg = `${t('file.result_regex_replaced', { count: matches.length })}: ${filePath}`
        break
      }
    }

    // 如果有进度步骤，更新为完成状态
    if (progressStepId) {
      executor.updateStep(progressStepId, {
        type: 'tool_result',
        content: `✅ ${resultMsg}`,
        toolName: 'write_file',
        isStreaming: false
      })
    } else {
      executor.addStep({
        type: 'tool_result',
        content: resultMsg,
        toolName: 'write_file'
      })
    }
    return { success: true, output: resultMsg }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : t('file.write_failed')
    const errorCategory = categorizeError(errorMsg)
    const suggestion = getErrorRecoverySuggestion(errorMsg, errorCategory)
    
    // 如果有进度步骤，更新为错误状态
    if (progressStepId) {
      executor.updateStep(progressStepId, {
        type: 'tool_result',
        content: `❌ ${t('file.write_failed')}: ${errorMsg}`,
        toolName: 'write_file',
        toolResult: `${errorMsg}\n\n💡 ${suggestion}`,
        isStreaming: false
      })
    } else {
        executor.addStep({
          type: 'tool_result',
          content: `${t('file.write_failed')}: ${errorMsg}`,
          toolName: 'write_file',
        toolResult: `${errorMsg}\n\n💡 ${suggestion}`
      })
    }
    return { success: false, output: '', error: t('error.recovery_hint', { error: errorMsg, suggestion }) }
  }
}

/**
 * 记住信息
 * 使用知识库存储主机记忆，支持语义搜索和智能去重
 */
async function rememberInfo(
  args: Record<string, unknown>,
  config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const info = args.info as string
  if (!info) {
    return { success: false, output: '', error: t('error.info_required') }
  }

  // 只过滤纯粹的动态数据（非常短且只包含动态值）
  const pureDynamicPatterns = [
    /^(cpu|内存|磁盘|memory|disk)\s*(使用率|usage|占用)?\s*[:：]?\s*\d+(\.\d+)?%$/i,  // 纯使用率
    /^pid\s*[:=]?\s*\d+$/i,   // 纯进程 ID
    /^(uptime|运行时间)\s*[:：]?\s*[\d\s]+$/i,  // 纯运行时间
  ]
  
  const isPureDynamic = pureDynamicPatterns.some(p => p.test(info.trim()))
  
  // 只跳过纯动态数据（很短且只有动态值）
  if (isPureDynamic) {
    executor.addStep({
      type: 'tool_result',
      content: `${t('memory.skip_dynamic')}: "${info}"`,
      toolName: 'remember_info'
    })
    return { success: true, output: t('success.dynamic_data_skip') }
  }

  executor.addStep({
    type: 'tool_call',
    content: `${t('memory.remember')}: ${info}`,
    toolName: 'remember_info',
    toolArgs: args,
    riskLevel: 'safe'
  })

  // 优先保存到知识库（使用智能去重）
  const hostId = executor.getHostId()
  let savedToKnowledge = false
  
  if (hostId) {
    try {
      const knowledgeService = getKnowledgeService()
      if (knowledgeService && knowledgeService.isEnabled()) {
        // 使用智能添加（带语义去重和 AI 冲突解决）
        const result = await knowledgeService.addHostMemorySmart(hostId, info)
        
        if (result.success) {
          savedToKnowledge = true
          const memoryCount = knowledgeService.getHostMemoryCount(hostId)
          
          // 根据不同的操作类型显示不同的消息
          let resultMessage = ''
          switch (result.action) {
            case 'skip':
              resultMessage = `${t('memory.skip_duplicate')}: ${result.message}`
              break
            case 'update':
              resultMessage = `${t('memory.merged')}: ${result.message}`
              break
            case 'replace':
              resultMessage = `${t('memory.replaced')}: ${result.message}`
              break
            case 'keep_both':
              resultMessage = `${t('memory.remembered')}: ${info} ${t('memory.remembered_knowledge', { count: memoryCount })}`
              break
            case 'save':
            default:
              resultMessage = `${t('memory.remembered')}: ${info} ${t('memory.remembered_knowledge', { count: memoryCount })}`
              break
          }
          
          // 只在调试模式显示成功的 tool_result
          if (config.debugMode) {
            executor.addStep({
              type: 'tool_result',
              content: resultMessage,
              toolName: 'remember_info'
            })
          }
          
          return { success: true, output: result.message }
        }
      }
    } catch (error) {
      console.error('[rememberInfo] 保存到知识库失败:', error)
    }
  }

  // 知识库不可用时，提示用户
  if (!savedToKnowledge) {
    executor.addStep({
      type: 'tool_result',
      content: t('memory.cannot_save'),
      toolName: 'remember_info'
    })
    return { success: false, output: '', error: t('error.knowledge_not_available') }
  }

  return { success: false, output: '', error: t('error.cannot_save_unknown_host') }
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
    return { success: false, output: '', error: t('error.query_required') }
  }

  executor.addStep({
    type: 'tool_call',
    content: `${t('knowledge.search')}: "${query}"`,
    toolName: 'search_knowledge',
    toolArgs: args,
    riskLevel: 'safe'
  })

  try {
    const knowledgeService = getKnowledgeService()
    
    if (!knowledgeService) {
      executor.addStep({
        type: 'tool_result',
        content: t('knowledge.not_initialized'),
        toolName: 'search_knowledge'
      })
      return { success: false, output: '', error: t('error.knowledge_not_initialized') }
    }

    if (!knowledgeService.isEnabled()) {
      executor.addStep({
        type: 'tool_result',
        content: t('knowledge.not_enabled'),
        toolName: 'search_knowledge'
      })
      return { success: false, output: '', error: t('error.knowledge_not_enabled') }
    }

    const results = await knowledgeService.search(query, { 
      limit,
      hostId: executor.getHostId()
    })

    if (results.length === 0) {
      executor.addStep({
        type: 'tool_result',
        content: t('knowledge.no_results'),
        toolName: 'search_knowledge'
      })
      return { success: true, output: t('success.no_knowledge_found') }
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
      content: t('knowledge.found_results', { count: results.length, chars: output.length }),
      toolName: 'search_knowledge',
      toolResult: displayOutput
    })

    // 返回完整结果给 agent（但每个结果的内容已截断到 2000 字符）
    return { success: true, output }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : '搜索失败'
    executor.addStep({
      type: 'tool_result',
      content: `${t('knowledge.search_failed')}: ${errorMsg}`,
      toolName: 'search_knowledge'
    })
    return { success: false, output: '', error: errorMsg }
  }
}

/**
 * 按 ID 获取知识库文档
 */
async function getKnowledgeDoc(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const docId = args.doc_id as string
  
  if (!docId) {
    return { success: false, output: '', error: '缺少 doc_id 参数' }
  }

  executor.addStep({
    type: 'tool_call',
    content: t('knowledge.getting_doc', { id: docId }),
    toolName: 'get_knowledge_doc',
    toolArgs: args,
    riskLevel: 'safe'
  })

  try {
    const knowledgeService = getKnowledgeService()
    
    if (!knowledgeService) {
      executor.addStep({
        type: 'tool_result',
        content: t('knowledge.not_initialized'),
        toolName: 'get_knowledge_doc'
      })
      return { success: false, output: '', error: t('error.knowledge_not_initialized') }
    }

    const doc = knowledgeService.getDocument(docId)
    
    if (!doc) {
      executor.addStep({
        type: 'tool_result',
        content: t('knowledge.doc_not_found', { id: docId }),
        toolName: 'get_knowledge_doc'
      })
      return { success: false, output: '', error: `文档不存在: ${docId}` }
    }

    const output = `## ${doc.filename}\n\n${doc.content}`
    
    // 截断显示内容
    const maxDisplayLength = 500
    const displayContent = doc.content.length > maxDisplayLength 
      ? doc.content.substring(0, maxDisplayLength) + `\n\n... [内容已截断，完整内容共 ${doc.content.length} 字符]`
      : doc.content

    executor.addStep({
      type: 'tool_result',
      content: t('knowledge.doc_retrieved', { filename: doc.filename, chars: doc.content.length }),
      toolName: 'get_knowledge_doc',
      toolResult: `## ${doc.filename}\n\n${displayContent}`
    })

    return { success: true, output }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : '获取文档失败'
    executor.addStep({
      type: 'tool_result',
      content: `${t('knowledge.get_doc_failed')}: ${errorMsg}`,
      toolName: 'get_knowledge_doc'
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
    return t('time.minutes_seconds', { minutes, seconds })
  }
  return t('time.seconds', { seconds })
}

/**
 * 格式化总时间显示
 */
function formatTotalTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const secs = seconds % 60
  
  if (minutes > 0) {
    return secs > 0 ? t('time.minutes_seconds', { minutes, seconds: secs }) : t('time.minutes', { minutes })
  }
  return t('time.seconds', { seconds })
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
    return { success: false, output: '', error: t('error.wait_seconds_positive') }
  }
  
  const totalTimeDisplay = formatTotalTime(totalSeconds)
  
  // 添加等待步骤，显示计划等待时间
  const step = executor.addStep({
    type: 'waiting',
    content: `☕ ${message}\n${t('wait.planned', { total: totalTimeDisplay, remaining: totalTimeDisplay })}`,
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
      content: `☕ ${message}\n${t('wait.progress', { total: totalTimeDisplay, remaining: remainingTime, progress })}`
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
        content: `☕ ${message}\n${t('wait.new_message', { elapsed: actualTimeDisplay, remaining: remainingTimeDisplay })}`
      })

      return {
        success: true,
        output: t('wait.user_message', { message: userMessageContent, elapsed: actualTimeDisplay, remaining: remainingTimeDisplay })
      }
    } else {
      // abort 中断
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

  // 正常完成
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
    return { success: false, output: '', error: t('error.question_required') }
  }

  // 限制选项数量为 10 个
  if (options && options.length > 10) {
    options = options.slice(0, 10)
  }

  // 读取超时参数，限制在 30-600 秒范围内，默认 120 秒
  const timeout = args.timeout as number | undefined
  const maxWaitSeconds = Math.min(600, Math.max(30, timeout ?? 120))

  // 添加提问步骤（content 只保存问题，状态信息通过 toolResult 显示）
  const step = executor.addStep({
    type: 'asking',
    content: question,
    toolName: 'ask_user',
    toolArgs: { question, options, allow_multiple: allowMultiple, default_value: defaultValue, timeout },
    toolResult: t('ask.waiting_reply'),
    riskLevel: 'safe'
  })
  const pollInterval = 2  // 每 2 秒检查一次
  let elapsedSeconds = 0
  let userResponse: string | undefined

  while (elapsedSeconds < maxWaitSeconds) {
    // 检查是否被中止
    if (executor.isAborted()) {
      executor.updateStep(step.id, {
        toolResult: t('ask.cancelled')
      })
      return { success: false, output: '', error: t('error.operation_aborted') }
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
      ? t('time.minutes_seconds', { minutes: remainingMinutes, seconds: remainingSecs })
      : t('time.seconds', { seconds: remainingSecs })
    
    executor.updateStep(step.id, {
      toolResult: t('ask.waiting_remaining', { remaining: remainingDisplay })
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

    // 添加用户回复步骤到对话中（让用户看到自己的回复）
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
    // 超时
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

// ==================== Plan/Todo 工具实现 ====================

/**
 * 生成唯一 ID
 */
function generatePlanId(): string {
  return `plan_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`
}

/**
 * 检查计划是否已完成（所有步骤都已完成、失败或跳过）
 */
function isPlanFinished(plan: AgentPlan): boolean {
  return plan.steps.every(s => 
    s.status === 'completed' || s.status === 'failed' || s.status === 'skipped'
  )
}

/**
 * 创建任务执行计划
 */
function createPlan(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): ToolResult {
  const title = args.title as string
  const stepsInput = args.steps as Array<{ title: string; description?: string }>
  
  // 参数校验
  if (!title || typeof title !== 'string') {
    return { success: false, output: '', error: t('error.plan_title_required') }
  }
  
  if (!Array.isArray(stepsInput) || stepsInput.length === 0) {
    return { success: false, output: '', error: t('error.plan_steps_required') }
  }
  
  if (stepsInput.length > 10) {
    return { success: false, output: '', error: t('error.plan_steps_max') }
  }
  
  // 检查是否已有计划
  const existingPlan = executor.getCurrentPlan()
  if (existingPlan) {
    // 如果现有计划已完成或全部失败，自动归档并允许创建新计划
    if (isPlanFinished(existingPlan)) {
      // 计算旧计划进度
      const completedCount = existingPlan.steps.filter(s => s.status === 'completed').length
      const failedCount = existingPlan.steps.filter(s => s.status === 'failed').length
      const totalCount = existingPlan.steps.length
      const statusParts = [`${completedCount}/${totalCount} ${t('plan.status_completed')}`]
      if (failedCount > 0) statusParts.push(`${failedCount} ${t('plan.status_failed')}`)
      const statusSummary = statusParts.join(', ')
      
      // 归档旧计划到步骤中
      executor.addStep({
        type: 'plan_archived',
        content: `${existingPlan.title} (${statusSummary})`,
        toolName: 'create_plan',
        plan: { ...existingPlan },  // 保存完整计划数据
        riskLevel: 'safe'
      })
      
      executor.setCurrentPlan(undefined)
    } else {
      // 计划还在进行中，不允许创建新计划
      return { 
        success: false, 
        output: '', 
        error: t('error.plan_exists_use_clear', { title: existingPlan.title }) 
      }
    }
  }
  
  // 创建计划
  const now = Date.now()
  const plan: AgentPlan = {
    id: generatePlanId(),
    title,
    steps: stepsInput.map((step, index) => ({
      id: `step_${index}`,
      title: step.title,
      description: step.description,
      status: 'pending' as PlanStepStatus
    })),
    createdAt: now,
    updatedAt: now
  }
  
  // 保存计划
  executor.setCurrentPlan(plan)
  
  // 添加步骤（包含计划数据）
  executor.addStep({
    type: 'plan_created',
    content: `${t('plan.create')}: ${title}`,
    toolName: 'create_plan',
    toolArgs: { title, steps: stepsInput.length },
    plan: plan,
    riskLevel: 'safe'
  })
  
  // 构建返回信息
  const stepsList = plan.steps.map((s, i) => `${i + 1}. ${s.title}`).join('\n')
  const output = `${t('plan.created', { title })}\n\n${t('plan.created_steps')}:\n${stepsList}\n\n${t('plan.created_hint')}`
  
  return { success: true, output }
}

/**
 * 更新计划步骤状态
 */
function updatePlan(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): ToolResult {
  const stepIndex = args.step_index as number
  const status = args.status as PlanStepStatus
  const result = args.result as string | undefined
  
  // 参数校验
  if (typeof stepIndex !== 'number' || stepIndex < 0) {
    return { success: false, output: '', error: t('error.step_index_positive') }
  }
  
  const validStatuses: PlanStepStatus[] = ['pending', 'in_progress', 'completed', 'failed', 'skipped']
  if (!validStatuses.includes(status)) {
    return { success: false, output: '', error: t('error.invalid_plan_status', { statuses: validStatuses.join(', ') }) }
  }
  
  // 获取当前计划
  const plan = executor.getCurrentPlan()
  if (!plan) {
    return { success: false, output: '', error: t('error.no_active_plan') }
  }
  
  if (stepIndex >= plan.steps.length) {
    return { success: false, output: '', error: t('error.step_index_out_of_range', { count: plan.steps.length, max: plan.steps.length - 1 }) }
  }
  
  // 更新步骤状态
  const step = plan.steps[stepIndex]
  const oldStatus = step.status
  step.status = status
  step.result = result
  
  // 记录时间戳
  const now = Date.now()
  if (status === 'in_progress' && !step.startedAt) {
    step.startedAt = now
  }
  if (status === 'completed' || status === 'failed' || status === 'skipped') {
    step.completedAt = now
  }
  
  plan.updatedAt = now
  
  // 更新计划
  executor.setCurrentPlan(plan)
  
  // 构建状态图标
  const statusIcons: Record<PlanStepStatus, string> = {
    pending: '○',
    in_progress: '●',
    completed: '✓',
    failed: '✗',
    skipped: '–'
  }
  
  // 添加更新步骤
  const stepInfo = `${t('plan.step_prefix', { index: stepIndex + 1 })}: ${step.title}`
  const statusText = `${statusIcons[status]} ${status}`
  const resultText = result ? ` - ${result}` : ''
  
  executor.addStep({
    type: 'plan_updated',
    content: `${stepInfo} → ${statusText}${resultText}`,
    toolName: 'update_plan',
    toolArgs: { step_index: stepIndex, status, result },
    plan: plan,
    riskLevel: 'safe'
  })
  
  // 计算进度
  const completedCount = plan.steps.filter(s => s.status === 'completed').length
  const totalCount = plan.steps.length
  const progressPercent = Math.round((completedCount / totalCount) * 100)
  
  // 检查计划是否完成
  const allDone = plan.steps.every(s => 
    s.status === 'completed' || s.status === 'failed' || s.status === 'skipped'
  )
  
  let output = t('plan.updated', { step: stepInfo, status })
  if (result) output += `\n${t('plan.result', { result })}`
  output += `\n\n${t('plan.progress', { completed: completedCount, total: totalCount, percent: progressPercent })}`
  
  if (allDone) {
    const failedCount = plan.steps.filter(s => s.status === 'failed').length
    if (failedCount > 0) {
      output += `\n\n⚠️ ${t('plan.complete_with_failures', { count: failedCount })}`
    } else {
      output += `\n\n✅ ${t('plan.complete_success')}`
    }
    output += `\n\n💡 ${t('plan.complete_hint')}`
  } else {
    // 提示下一步
    const nextPendingIndex = plan.steps.findIndex(s => s.status === 'pending')
    if (nextPendingIndex !== -1) {
      output += `\n\n${t('plan.next_step', { index: nextPendingIndex + 1, title: plan.steps[nextPendingIndex].title })}`
    }
  }
  
  return { success: true, output }
}

/**
 * 归档当前计划（保存到步骤中供查看）
 */
function clearPlan(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): ToolResult {
  const reason = args.reason as string | undefined
  
  // 获取当前计划
  const plan = executor.getCurrentPlan()
  if (!plan) {
    return { success: true, output: t('plan.no_active_plan_to_clear') }
  }
  
  // 计算进度统计
  const completedCount = plan.steps.filter(s => s.status === 'completed').length
  const failedCount = plan.steps.filter(s => s.status === 'failed').length
  const skippedCount = plan.steps.filter(s => s.status === 'skipped').length
  const totalCount = plan.steps.length
  const progressPercent = Math.round((completedCount / totalCount) * 100)
  
  // 构建状态摘要
  const statusParts = [`${completedCount}/${totalCount} ${t('plan.status_completed')}`]
  if (failedCount > 0) statusParts.push(`${failedCount} ${t('plan.status_failed')}`)
  if (skippedCount > 0) statusParts.push(`${skippedCount} ${t('plan.status_skipped')}`)
  const statusSummary = statusParts.join(', ')
  const reasonText = reason ? ` - ${reason}` : ''
  
  // 归档计划到步骤中（保存完整的计划数据供查看）
  executor.addStep({
    type: 'plan_archived',
    content: `${plan.title} (${statusSummary})${reasonText}`,
    toolName: 'clear_plan',
    toolArgs: { reason },
    plan: { ...plan },  // 保存完整计划数据
    riskLevel: 'safe'
  })
  
  // 清除当前计划
  executor.setCurrentPlan(undefined)
  
  let output = `${t('plan.archived', { title: plan.title })}\n${t('plan.archived_progress', { percent: progressPercent, summary: statusSummary })}`
  if (reason) output += `\n${t('plan.archived_reason', { reason })}`
  output += `\n\n${t('plan.archived_hint')}`
  
  return { 
    success: true, 
    output
  }
}
