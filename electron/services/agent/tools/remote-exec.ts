/**
 * remote_exec：伙计在派给他的远程主机上后台跑单上的命令。
 * 范围和命令单的核对、输出截短与留痕都在 WorkerRemoteAccess 里。
 */
import type { ToolResult, ToolExecutorConfig } from './types'
import { t } from '../i18n'

export async function remoteExecTool(args: Record<string, unknown>, executor: ToolExecutorConfig): Promise<ToolResult> {
  const access = executor.getRemoteAccess?.()
  if (!access) return { success: false, output: '', error: t('remote.tool_no_scope') }

  const host = typeof args.host === 'string' ? args.host.trim() : ''
  const command = typeof args.command === 'string' ? args.command : ''
  if (!host || !command.trim()) return { success: false, output: '', error: t('remote.tool_args_required') }
  const timeout = typeof args.timeout_seconds === 'number' ? args.timeout_seconds : undefined

  const outcome = await access.run(host, command, timeout, executor.getAbortSignal?.())
  return outcome.ranToCompletion
    ? { success: true, output: outcome.text }
    : { success: false, output: '', error: outcome.text }
}
