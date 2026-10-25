/**
 * 伙计远程范围的授权门：派出（或补单）之前，把「哪几个伙计连哪些已存主机、跑哪些命令」
 * 判清楚、问清楚，通过了才交出 RemoteGrant。
 *
 * 顺序：参数合理 → 这类会话允许 → 主机都是已存的 → 命令都只读 → 按这场对话的审批方式确认。
 * 任何一步不过都整批退回，回执写明原因；通过之前不开工、不连任何主机。
 */
import type { ExecutionMode, JumpHostGroupRef, RemoteAccessRequest } from '@shared/types'
import { checkReadOnlyCommand } from '../command-audit'
import { t } from '../i18n'
import { RemoteGrant, type GrantedHost } from './remote-grant'

/** 一批最多这么多条命令、每条最多这么多字。只防写错量级，不管该几条 */
export const MAX_REMOTE_COMMANDS = 50
export const MAX_REMOTE_COMMAND_CHARS = 2000

/** 已存会话里授权用得到的字段（只取结构，不依赖配置服务的类型） */
export interface SavedSessionRef {
  id: string
  name: string
  host: string
  port: number
  username: string
  groupId?: string
}

export interface RemoteDispatchContext {
  sessions: readonly SavedSessionRef[]
  groups: readonly Pick<JumpHostGroupRef, 'id' | 'name'>[]
  executionMode: ExecutionMode
  /** 这类会话允许把伙计派去连远程主机（关切、唤醒不允许） */
  conversationAllows: boolean
  /** 这一轮有人能当场回答（交互界面、网页、IM 都算；没有交互终端的命令行不算） */
  attended: boolean
  /** 交给这场对话的确认渠道（含「替我审批」）；返回 true 才算批准 */
  confirm: (request: RemoteAccessRequest, toolArgs: Record<string, unknown>, displayName: string, reasons: string[]) => Promise<boolean>
}

export type GateOutcome<T> = { ok: true; value: T } | { ok: false; error: string }

/** 派出：每个伙计要连的主机 id 清单（没有就是不碰远程） */
export interface DispatchedWorkerHosts {
  hosts?: readonly string[]
}

export class RemoteDispatchGate {
  constructor(private readonly ctx: RemoteDispatchContext) {}

  /** 返回与 workers 一一对应的范围；不碰远程的伙计对应 undefined */
  async authorizeDispatch(
    workers: readonly DispatchedWorkerHosts[],
    commands: readonly string[],
  ): Promise<GateOutcome<Array<RemoteGrant | undefined>>> {
    const anyHosts = workers.some(w => (w.hosts?.length ?? 0) > 0)
    if (!anyHosts && commands.length === 0) return { ok: true, value: workers.map(() => undefined) }
    if (!anyHosts) return { ok: false, error: t('remote.need_hosts') }
    if (commands.length === 0) return { ok: false, error: t('remote.need_commands') }

    const shape = this.checkShape(commands)
    if (shape) return { ok: false, error: shape }
    if (!this.ctx.conversationAllows) return { ok: false, error: t('remote.background_denied') }

    const resolved = this.resolveHosts(workers)
    if ('error' in resolved) return { ok: false, error: resolved.error }

    const readOnly = await this.checkReadOnly(commands)
    if (readOnly) return { ok: false, error: readOnly }

    const request: RemoteAccessRequest = {
      hosts: uniqueHosts(resolved.perWorker.flat()),
      commands: [...commands],
      workerCount: resolved.perWorker.filter(h => h.length > 0).length,
    }
    const approval = await this.askApproval(request, t('remote.confirm_title_dispatch', { count: request.workerCount ?? 0 }), t('remote.rejected'))
    if (approval) return { ok: false, error: approval }

    return {
      ok: true,
      value: resolved.perWorker.map(hosts => (hosts.length > 0 ? new RemoteGrant(hosts, commands) : undefined)),
    }
  }

  /** 补单：同一批主机，新增几条命令。通过后由调用方追加进 grant */
  async authorizeFollowup(
    workerName: string,
    grant: RemoteGrant | undefined,
    commands: readonly string[],
  ): Promise<GateOutcome<void>> {
    if (commands.length === 0) return { ok: true, value: undefined }
    if (!grant?.hasHosts()) return { ok: false, error: t('remote.followup_no_scope', { name: workerName }) }

    const shape = this.checkShape(commands)
    if (shape) return { ok: false, error: shape }
    if (!this.ctx.conversationAllows) return { ok: false, error: t('remote.background_denied_followup') }

    const readOnly = await this.checkReadOnly(commands)
    if (readOnly) return { ok: false, error: readOnly }

    const request: RemoteAccessRequest = {
      hosts: [...grant.hosts],
      commands: [...commands],
      forWorker: workerName,
    }
    const approval = await this.askApproval(request, t('remote.confirm_title_followup', { name: workerName }), t('remote.followup_rejected', { name: workerName }))
    if (approval) return { ok: false, error: approval }
    return { ok: true, value: undefined }
  }

  private checkShape(commands: readonly string[]): string | null {
    if (commands.length > MAX_REMOTE_COMMANDS) {
      return t('remote.too_many_commands', { max: MAX_REMOTE_COMMANDS, count: commands.length })
    }
    const tooLong = commands.findIndex(c => c.length > MAX_REMOTE_COMMAND_CHARS)
    if (tooLong >= 0) return t('remote.command_too_long', { index: tooLong + 1, max: MAX_REMOTE_COMMAND_CHARS })
    return null
  }

  private resolveHosts(workers: readonly DispatchedWorkerHosts[]): { perWorker: GrantedHost[][] } | { error: string } {
    const byId = new Map(this.ctx.sessions.map(s => [s.id, s]))
    const groupName = new Map(this.ctx.groups.map(g => [g.id, g.name]))
    const unknown = new Set<string>()
    const perWorker = workers.map(worker => {
      const hosts: GrantedHost[] = []
      for (const id of worker.hosts ?? []) {
        const session = byId.get(id)
        if (!session) {
          unknown.add(id)
          continue
        }
        if (hosts.some(h => h.id === id)) continue
        const group = session.groupId ? groupName.get(session.groupId) : undefined
        hosts.push({
          id: session.id,
          name: session.name,
          address: `${session.username}@${session.host}:${session.port}`,
          ...(group ? { group } : {}),
        })
      }
      return hosts
    })
    if (unknown.size > 0) return { error: t('remote.unknown_hosts', { ids: [...unknown].join('、') }) }
    return { perWorker }
  }

  private async checkReadOnly(commands: readonly string[]): Promise<string | null> {
    for (let i = 0; i < commands.length; i++) {
      const reason = await checkReadOnlyCommand(commands[i]!, { kind: 'remote' })
      if (reason) return t('remote.not_read_only', { index: i + 1, command: commands[i]!, reason })
    }
    return null
  }

  /** 批准返回 null，否则返回给模型的原因 */
  private async askApproval(request: RemoteAccessRequest, displayName: string, rejectedText: string): Promise<string | null> {
    // 自由模式是用户选的「不问」；批准后单子照样限定范围
    if (this.ctx.executionMode === 'free') return null
    if (!this.ctx.attended) return t('remote.nobody_to_confirm')
    const toolArgs: Record<string, unknown> = {
      hosts: request.hosts.map(h => ({ name: h.name, address: h.address, ...(h.group ? { group: h.group } : {}) })),
      remote_commands: request.commands,
      ...(request.workerCount !== undefined ? { workers: request.workerCount } : {}),
      ...(request.forWorker ? { worker: request.forWorker } : {}),
    }
    const approved = await this.ctx.confirm(request, toolArgs, displayName, [t('remote.reason_scope'), t('remote.reason_output')])
    return approved ? null : rejectedText
  }
}

function uniqueHosts(hosts: readonly GrantedHost[]): GrantedHost[] {
  const seen = new Map<string, GrantedHost>()
  for (const h of hosts) if (!seen.has(h.id)) seen.set(h.id, h)
  return [...seen.values()]
}
