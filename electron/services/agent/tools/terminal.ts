/**
 * 终端操作工具
 * 包括：获取终端上下文、检查终端状态、发送控制键、发送输入等
 */
import stripAnsi from 'strip-ansi'
import { t } from '../i18n'
import { getTerminalAwarenessService } from '../../terminal-awareness'
import { getLastNLinesFromBuffer, getScreenAnalysisFromFrontend } from '../../screen-content.service'
import { truncateFromEnd } from './utils'
import type { ToolExecutorConfig, AgentConfig, ToolResult } from './types'

/**
 * 获取终端上下文（从末尾读取 N 行）
 */
export async function getTerminalContext(
  ptyId: string,
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const lines = Math.min(Math.max((args.lines as number) || 50, 1), 500)
  
  // 添加工具调用步骤
  executor.addStep({
    type: 'tool_call',
    content: t('context.getting_output', { lines }),
    toolName: 'get_terminal_context',
    toolArgs: { lines },
    riskLevel: 'safe'
  })
  
  let bufferLines: string[] | null = null
  try {
    bufferLines = await getLastNLinesFromBuffer(ptyId, lines, 3000)
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : t('error.unknown')
    executor.addStep({
      type: 'tool_result',
      content: t('error.get_terminal_output_failed', { error: errorMsg }),
      toolName: 'get_terminal_context',
      toolResult: errorMsg
    })
    return { success: false, output: '', error: t('error.get_terminal_output_failed', { error: errorMsg }) }
  }
  
  if (!bufferLines || bufferLines.length === 0) {
    executor.addStep({
      type: 'tool_result',
      content: t('error.terminal_output_empty'),
      toolName: 'get_terminal_context',
      toolResult: t('error.terminal_output_empty')
    })
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
 */
export async function checkTerminalStatus(
  ptyId: string,
  config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
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
    
    const screenAnalysis = await getScreenAnalysisFromFrontend(ptyId, 2000)
    
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
      output.push(`- 状态: **请根据下方终端输出判断**`)
      output.push(`- 说明: SSH 终端状态需要根据输出内容判断`)
    } else {
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
    
    // 2.2 输出模式识别
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
 * 等待终端输出稳定
 */
export async function waitForStableOutput(
  ptyId: string,
  options: {
    minWait?: number
    maxWait?: number
    pollInterval?: number
    stableCount?: number
  } = {}
): Promise<string> {
  const {
    minWait = 300,
    maxWait = 2000,
    pollInterval = 200,
    stableCount = 2
  } = options

  await new Promise(resolve => setTimeout(resolve, minWait))

  let lastOutput = ''
  let stableCounter = 0
  const startTime = Date.now()

  while (Date.now() - startTime < maxWait) {
    try {
      const bufferLines = await getLastNLinesFromBuffer(ptyId, 15, 1000)
      const currentOutput = bufferLines ? stripAnsi(bufferLines.join('\n')) : ''

      if (currentOutput === lastOutput) {
        stableCounter++
        if (stableCounter >= stableCount) {
          return currentOutput
        }
      } else {
        stableCounter = 0
        lastOutput = currentOutput
      }
    } catch {
      // 获取失败，继续等待
    }

    await new Promise(resolve => setTimeout(resolve, pollInterval))
  }

  return lastOutput
}

/**
 * 发送控制键到终端
 */
export async function sendControlKey(
  ptyId: string,
  args: Record<string, unknown>,
  config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const key = args.key as string
  if (!key) {
    return { success: false, output: '', error: t('error.control_key_required') }
  }

  const keyMap: Record<string, string> = {
    'ctrl+c': '\x03',
    'ctrl+d': '\x04',
    'ctrl+z': '\x1a',
    'enter': '\r',
    'q': 'q'
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
    executor.terminalService.write(ptyId, keySequence)
    
    const terminalOutput = await waitForStableOutput(ptyId)

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
export async function sendInput(
  ptyId: string,
  args: Record<string, unknown>,
  config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const text = args.text as string
  const pressEnter = args.press_enter !== false

  if (text === undefined || text === null) {
    return { success: false, output: '', error: t('error.input_text_required') }
  }

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
    executor.terminalService.write(ptyId, text)
    
    if (pressEnter) {
      executor.terminalService.write(ptyId, '\r')
    }
    
    const terminalOutput = await waitForStableOutput(ptyId)

    const inputDesc = `"${text}"${pressEnter ? ' + Enter' : ''}`
    
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
