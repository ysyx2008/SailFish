/**
 * 评审员的只读核查。
 *
 * 两扇门，都不改任何东西：
 * - 本机：只跑旗鱼命令审计判为只读、已解析、没有不认识子命令的命令，后台执行，不进任何终端窗格。
 * - 远程：只经 SFTP 查文件状态、列目录。远程服务器上没有「后台只读执行」的通道，
 *   借用户的终端窗格敲命令会弄乱他眼前的窗口，所以远程不跑命令。
 *
 * 工具定义固定两件、描述逐字不变，保证评审员那条线的缓存前缀稳定；这一场没有远程时，
 * 调远程那件直接说明没有。
 */
import type { ToolCall, ToolDefinition } from '../../ai.service'
import type { SftpService } from '../../sftp.service'
import type { SshConfig } from '../../ssh.service'
import { assessShellRisk, defaultAuditContext, extractAuditedCalls } from '../command-audit'

export const INSPECT_LOCAL_TOOL = 'inspect_local'
export const INSPECT_REMOTE_TOOL = 'inspect_remote'

const OUTPUT_LIMIT = 4000
const LIST_LIMIT = 100

export interface LocalInspectRunner {
  run(command: string): Promise<{ output: string; exitCode: number; timedOut: boolean }>
}

export interface RemoteInspectTarget {
  host: string
  stat(path: string): Promise<string>
  list(path: string): Promise<string>
}

export interface InspectorDeps {
  local?: LocalInspectRunner
  remote?: RemoteInspectTarget
  /** 只读就返回 null，否则返回拒绝理由 */
  checkReadOnly: (command: string) => Promise<string | null>
}

const DISCARD_TARGET = '/dev/null'

/**
 * 「安全」不等于「只读」：写到临时目录或私有目录的命令，审计也可能判为安全。
 * 所以四条都要满足：完整解析且没有不认识的子命令；整条与每个子命令本身都是安全级；
 * 没有写文件的重定向（丢弃输出除外）；只在 bash/zsh 这类能完整解析重定向的 shell 上开放。
 */
export async function checkReadOnlyCommand(command: string, cwd?: string): Promise<string | null> {
  const ctx = defaultAuditContext(cwd)
  if (ctx.shell !== 'bash') return '本机核查只支持 bash/zsh 这类 shell。'
  const assessment = await assessShellRisk(command, ctx)
  if (!assessment.parsed || assessment.hasUnknown) return '命令没能完整解析，或含不认识的子命令。'
  if (assessment.level !== 'safe' || assessment.calls.some(c => c.commandLevel !== 'safe')) {
    return `命令审计认为它不是只读（${assessment.level}）。`
  }
  const { writeRedirects } = await extractAuditedCalls(command, ctx)
  if (writeRedirects.some(r => r.target !== DISCARD_TARGET)) return '命令里有写文件的重定向。'
  return null
}

export const INSPECTOR_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: INSPECT_LOCAL_TOOL,
      description: '在用户本机后台跑一条只读命令（如 ls、stat、du、cat、find 不带删除）。写操作、不认识的命令会被拒绝。10 秒超时，输出截到 4000 字。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '只读命令' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: INSPECT_REMOTE_TOOL,
      description: '查远程服务器上一个路径：stat 看它是否存在、类型、大小、修改时间、权限；list 列目录（最多 100 条）。只读。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['stat', 'list'], description: 'stat 或 list' },
          path: { type: 'string', description: '远程绝对路径' },
        },
        required: ['action', 'path'],
      },
    },
  },
]

function clip(text: string): string {
  return text.length <= OUTPUT_LIMIT ? text : `${text.slice(0, OUTPUT_LIMIT)}\n…（已截断，原长 ${text.length} 字）`
}

function parseArgs(call: ToolCall): Record<string, unknown> {
  try {
    const v = JSON.parse(call.function.arguments || '{}')
    return v && typeof v === 'object' ? v as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

async function inspectLocal(args: Record<string, unknown>, deps: InspectorDeps): Promise<string> {
  const command = typeof args.command === 'string' ? args.command.trim() : ''
  if (!command) return '拒绝：没有给命令。'
  if (!deps.local) return '这场任务没有可用的本机核查。'
  let refusal: string | null
  try {
    refusal = await deps.checkReadOnly(command)
  } catch (e) {
    return `拒绝：命令审计失败（${e instanceof Error ? e.message : String(e)}）。`
  }
  if (refusal) return `拒绝：只能跑只读命令。${refusal}`
  const r = await deps.local.run(command)
  const status = r.timedOut ? '超时被终止' : `退出码 ${r.exitCode}`
  return `${status}\n${clip(r.output || '（无输出）')}`
}

async function inspectRemote(args: Record<string, unknown>, deps: InspectorDeps): Promise<string> {
  const action = args.action
  const path = typeof args.path === 'string' ? args.path.trim() : ''
  if (!deps.remote) return '这场任务没有可查的远程服务器。'
  if (!path) return '拒绝：没有给路径。'
  try {
    if (action === 'stat') return `主机 ${deps.remote.host}\n${clip(await deps.remote.stat(path))}`
    if (action === 'list') return `主机 ${deps.remote.host}\n${clip(await deps.remote.list(path))}`
    return '拒绝：action 只能是 stat 或 list。'
  } catch (e) {
    return `查询失败：${e instanceof Error ? e.message : String(e)}`
  }
}

export async function runInspection(call: ToolCall, deps: InspectorDeps): Promise<string> {
  const args = parseArgs(call)
  switch (call.function.name) {
    case INSPECT_LOCAL_TOOL:
      return inspectLocal(args, deps)
    case INSPECT_REMOTE_TOOL:
      return inspectRemote(args, deps)
    default:
      return `没有这个工具：${call.function.name}`
  }
}

// ==================== 真实环境的两扇门 ====================

type ExecuteCommand = (command: string, cwd: string | undefined, timeoutMs: number) => Promise<{ output: string; exitCode: number; aborted?: boolean }>

export interface InspectorEnvironment {
  execute: ExecuteCommand
  /** 本机核查的工作目录；远程任务里当前目录是远程的，不能拿来当本机目录 */
  localCwd?: string
  remote?: { sftp: SftpService; ssh: SshConfig; ptyId: string }
}

export function buildInspectorDeps(env: InspectorEnvironment): InspectorDeps {
  return {
    local: createLocalRunner(env.execute, env.localCwd),
    remote: env.remote ? createSftpTarget(env.remote.sftp, env.remote.ssh, env.remote.ptyId) : undefined,
    checkReadOnly: command => checkReadOnlyCommand(command, env.localCwd),
  }
}

export function createLocalRunner(execute: ExecuteCommand, cwd?: string): LocalInspectRunner {
  return {
    async run(command) {
      const r = await execute(command, cwd, 10_000)
      return { output: r.output, exitCode: r.exitCode, timedOut: r.aborted === true }
    },
  }
}

/** 批准动作若点名了某个窗格就查那台，否则查这场任务当前的窗格。 */
export function resolveInspectPtyId(args: Record<string, unknown>, fallback: string | undefined): string | undefined {
  return typeof args.pane_id === 'string' && args.pane_id ? args.pane_id : fallback
}

function formatMode(mode: number | undefined): string {
  return typeof mode === 'number' ? (mode & 0o7777).toString(8).padStart(4, '0') : '?'
}

export function createSftpTarget(sftp: SftpService, ssh: SshConfig, ptyId: string): RemoteInspectTarget {
  const ensure = async () => {
    if (sftp.hasSession(ptyId)) return
    await sftp.connect(ptyId, {
      host: ssh.host,
      port: ssh.port,
      username: ssh.username,
      password: ssh.password,
      privateKey: ssh.privateKey,
      privateKeyPath: ssh.privateKeyPath,
      passphrase: ssh.passphrase,
    })
  }
  return {
    host: ssh.host,
    async stat(path) {
      await ensure()
      const st = await sftp.stat(ptyId, path)
      if (!st) return `${path}：不存在`
      const kind = st.isDirectory ? '目录' : st.isSymbolicLink ? '符号链接' : st.isFile ? '文件' : '其他'
      return `${path}：${kind}，${st.size} 字节，修改于 ${new Date(st.modifyTime).toISOString()}，权限 ${formatMode(st.mode)}`
    },
    async list(path) {
      await ensure()
      const { files, resolvedPath } = await sftp.list(ptyId, path)
      const shown = files.slice(0, LIST_LIMIT).map(f =>
        `${f.isDirectory ? 'd' : f.isSymlink ? 'l' : '-'} ${String(f.size).padStart(10)} ${new Date(f.modifyTime).toISOString()} ${f.name}`,
      )
      const more = files.length > LIST_LIMIT ? `\n…还有 ${files.length - LIST_LIMIT} 条未列出` : ''
      return `${resolvedPath}（共 ${files.length} 条）\n${shown.join('\n')}${more}`
    },
  }
}
