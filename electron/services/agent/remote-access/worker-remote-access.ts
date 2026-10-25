/**
 * 伙计手里的远程通道：只在他的范围里、只跑单上的命令，结果截短交给他，完整输出落盘。
 *
 * 范围和命令单是派出（或补单）时用户批准过的，这里只做核对，不再判风险。
 */
import type { RemoteExecPool, RemoteExecResult, RemoteHost } from '../../remote-exec'
import { t } from '../i18n'
import { truncateSandwichWithNotice } from '../tools/utils'
import { REMOTE_OUTPUT_INLINE_CHARS, REMOTE_TIMEOUT_DEFAULT_SECONDS, REMOTE_TIMEOUT_MAX_SECONDS } from './limits'
import type { RemoteGrant } from './remote-grant'
import type { RemoteOpRecorder } from './remote-op-recorder'

export interface WorkerRemoteAccessDeps {
  workerName: string
  grant: RemoteGrant
  pool: RemoteExecPool
  /** 按已存会话 id 取登录信息；会话被删了返回 undefined */
  resolveHost: (hostId: string) => RemoteHost | undefined
  recorder: RemoteOpRecorder
}

export interface RemoteRunOutcome {
  /** 命令真的在远程跑完了（不论退出码）。被拒绝、没连上、超时、中止都是 false */
  ranToCompletion: boolean
  text: string
}

export class WorkerRemoteAccess {
  private seq = 0

  constructor(private readonly deps: WorkerRemoteAccessDeps) {}

  get grant(): RemoteGrant {
    return this.deps.grant
  }

  async run(
    hostId: string,
    command: string,
    timeoutSeconds: number | undefined,
    signal?: AbortSignal,
  ): Promise<RemoteRunOutcome> {
    const { grant, pool, recorder, workerName } = this.deps
    const trimmed = command.trim()

    const granted = grant.findHost(hostId)
    if (!granted) {
      return refused(t('remote.tool_host_out_of_scope', { host: hostId, list: formatHosts(grant) }))
    }
    if (!trimmed || !grant.permitsCommand(trimmed)) {
      return refused(t('remote.tool_command_not_listed', { list: formatCommands(grant) }))
    }
    const host = this.deps.resolveHost(hostId)
    if (!host) return refused(t('remote.tool_host_gone', { name: granted.name }))

    const seconds = clampTimeout(timeoutSeconds)
    const result = await pool.exec(host, trimmed, { timeoutMs: seconds * 1000, signal })

    const seq = ++this.seq
    const outputFile = result.output ? await recorder.saveOutput(workerName, seq, result.output) : undefined
    const failure = describeFailure(result, seconds)
    // 留痕写完再把结果交给伙计：伙计看到的每条结果，操作记录里都已经有了
    await recorder.record({
      at: Date.now(),
      worker: workerName,
      hostId,
      hostName: granted.name,
      command: trimmed,
      exitCode: result.exitCode,
      ...(failure ? { failure } : {}),
      durationMs: result.durationMs,
      ...(outputFile ? { outputFile } : {}),
    })

    return {
      ranToCompletion: !failure && result.exitCode !== null,
      text: formatResult(granted.name, granted.address, trimmed, result, failure, outputFile),
    }
  }
}

function refused(text: string): RemoteRunOutcome {
  return { ranToCompletion: false, text }
}

function clampTimeout(value: number | undefined): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return REMOTE_TIMEOUT_DEFAULT_SECONDS
  return Math.min(Math.floor(n), REMOTE_TIMEOUT_MAX_SECONDS)
}

export function formatHosts(grant: RemoteGrant): string {
  return grant.hosts
    .map(h => `- ${h.name}（sessionId: ${h.id}，${h.address}${h.group ? `，分组：${h.group}` : ''}）`)
    .join('\n')
}

export function formatCommands(grant: RemoteGrant): string {
  return grant.commands.map((c, i) => `${i + 1}. \`${c}\``).join('\n')
}

/** 没正常跑完的原因；跑完了（不论退出码）返回 undefined */
function describeFailure(result: RemoteExecResult, timeoutSeconds: number): string | undefined {
  if (result.error) return t('remote.tool_connect_failed', { message: result.error.message })
  if (result.timedOut) return t('remote.tool_timeout', { seconds: timeoutSeconds })
  if (result.aborted) return t('remote.tool_aborted')
  if (result.exitCode === null && result.signal) return t('remote.tool_signal', { signal: result.signal })
  return undefined
}

function formatResult(
  name: string,
  address: string,
  command: string,
  result: RemoteExecResult,
  failure: string | undefined,
  outputFile: string | undefined,
): string {
  const seconds = (result.durationMs / 1000).toFixed(1)
  const lines = [
    t('remote.tool_host_line', { name, address }),
    t('remote.tool_command_line', { command }),
    failure
      ? t('remote.tool_failure_line', { failure, seconds })
      : t('remote.tool_exit_line', { code: result.exitCode ?? '-', seconds }),
  ]
  if (!result.output) {
    lines.push(t('remote.tool_no_output'))
    return lines.join('\n')
  }
  lines.push(t('remote.tool_output_title'))
  lines.push(truncateSandwichWithNotice(result.output, REMOTE_OUTPUT_INLINE_CHARS, stats =>
    t('remote.tool_output_clipped', { total: stats.originalLength, path: outputFile ?? '-' })))
  if (result.outputTruncated) lines.push(t('remote.tool_output_dropped'))
  return lines.join('\n')
}
