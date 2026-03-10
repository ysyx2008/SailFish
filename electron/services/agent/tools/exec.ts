/**
 * 轻量命令执行器（基于 child_process）
 * 
 * 用于无终端的 Agent 模式，直接执行 shell 命令并返回结果。
 * 与 PTY 版（command.ts）不同：
 * - 不需要终端会话，不追踪终端状态
 * - 同步等待命令完成（非交互式）
 * - 不支持 sudo、续行检测等终端特有交互
 */
import { exec } from 'child_process'
import { t } from '../i18n'
import { assessCommandRisk, analyzeCommand } from '../risk-assessor'
import { truncateFromEnd } from './utils'
import { getDefaultShell } from '../../../utils/platform'
import type { ToolExecutorConfig, AgentConfig, ToolResult } from './types'

const DEFAULT_TIMEOUT = 60_000
const MAX_TIMEOUT = 600_000
const MAX_BUFFER = 10 * 1024 * 1024  // 10MB

export async function executeCommandDirect(
  args: Record<string, unknown>,
  toolCallId: string,
  config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const command = args.command as string
  if (!command) {
    return { success: false, output: '', error: t('hint.command_empty') }
  }

  const MAX_COMMAND_LENGTH = 800
  if (command.length > MAX_COMMAND_LENGTH) {
    const errorMsg = t('hint.command_too_long', { length: command.length, max: MAX_COMMAND_LENGTH })
    executor.addStep({
      type: 'tool_call',
      content: `🚫 ${command.slice(0, 100)}...`,
      toolName: 'exec',
      toolArgs: { command: command.slice(0, 100) + '...' },
      riskLevel: 'blocked'
    })
    executor.addStep({
      type: 'tool_result',
      content: errorMsg,
      toolName: 'exec',
      toolResult: errorMsg
    })
    return { success: false, output: '', error: errorMsg }
  }

  const handling = analyzeCommand(command)
  if (handling.strategy === 'block') {
    executor.addStep({
      type: 'tool_call',
      content: `🚫 ${command}`,
      toolName: 'exec',
      toolArgs: { command },
      riskLevel: 'blocked'
    })
    const errorMsg = `${t('hint.command_cannot_execute')}: ${handling.reason}。${handling.hint}`
    executor.addStep({
      type: 'tool_result',
      content: errorMsg,
      toolName: 'exec',
      toolResult: errorMsg
    })
    return { success: false, output: '', error: errorMsg }
  }

  const riskLevel = assessCommandRisk(command)
  if (riskLevel === 'blocked') {
    return { success: false, output: '', error: t('hint.security_blocked') }
  }

  let needConfirm = false
  if (config.executionMode === 'strict') {
    needConfirm = true
  } else if (config.executionMode === 'relaxed') {
    needConfirm = riskLevel === 'dangerous'
  }

  executor.addStep({
    type: 'tool_call',
    content: `${t('status.executing')}: ${command}`,
    toolName: 'exec',
    toolArgs: { command },
    riskLevel
  })

  let userApproved = false
  if (needConfirm) {
    const approved = await executor.waitForConfirmation(
      toolCallId, 'exec', { command }, riskLevel
    )
    if (!approved) {
      executor.addStep({
        type: 'tool_result',
        content: `⛔ ${t('status.user_rejected')}`,
        toolName: 'exec',
        toolResult: t('status.user_rejected')
      })
      return { success: false, output: '', error: t('error.user_rejected_command') }
    }
    userApproved = true
  }

  const cwd = (args.cwd as string) || undefined

  // timeout 优先级：工具参数 > config.commandTimeout > DEFAULT_TIMEOUT
  const rawTimeoutSec = args.timeout as number | undefined
  let timeout: number
  if (typeof rawTimeoutSec === 'number' && Number.isFinite(rawTimeoutSec) && rawTimeoutSec > 0) {
    timeout = Math.min(rawTimeoutSec * 1000, MAX_TIMEOUT)
  } else {
    timeout = config.commandTimeout || DEFAULT_TIMEOUT
  }

  return new Promise<ToolResult>((resolve) => {
    exec(command, { cwd, timeout, maxBuffer: MAX_BUFFER, shell: getDefaultShell() }, (error, stdout, stderr) => {
      const combined = [stdout, stderr].filter(Boolean).join('\n').trim()
      const exitCode = error?.code ?? (error ? 1 : 0)

      if (error && (error as NodeJS.ErrnoException).signal === 'SIGTERM') {
        const output = truncateFromEnd(combined, 4000)
        executor.addStep({
          type: 'tool_result',
          content: `⏱️ ${t('status.command_timeout')} (${timeout / 1000}${t('misc.seconds')})`,
          toolName: 'exec',
          toolResult: output
        })
        resolve({
          success: false,
          output,
          error: t('error.command_timeout_with_hint', { suggestion: 'increase timeout or split command' })
        })
        return
      }

      const output = truncateFromEnd(combined, 8000)
      if (config.debugMode) {
        executor.addStep({
          type: 'tool_result',
          content: `${t('status.command_complete')} (exit: ${exitCode})`,
          toolName: 'exec',
          toolResult: output
        })
      }

      const finalOutput = userApproved ? `[${t('status.user_approved')}]\n${output}` : output

      if (exitCode !== 0) {
        resolve({
          success: false,
          output: finalOutput,
          error: `exit code ${exitCode}: ${truncateFromEnd(combined, 500)}`
        })
      } else {
        resolve({ success: true, output: finalOutput })
      }
    })
  })
}
