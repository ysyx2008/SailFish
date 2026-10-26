/**
 * 伙计远程范围的授权门：派出（或补单）之前，把「哪几个伙计连哪些已存主机、跑哪些命令」
 * 判清楚、问清楚，通过了才交出 RemoteGrant。
 *
 * 顺序：参数合理 → 这类会话允许 → 主机都是已存的 → 按这场对话的审批方式处理：
 * 严格、宽松直接问用户；替我审批、自由由运维专家判断。
 * 任何一步不过都整批退回，回执写明原因；通过之前不开工、不连任何主机。
 */
import type { ExecutionMode, JumpHostGroupRef, RemoteAccessAssignment, RemoteAccessRequest } from '@shared/types'
import { checkReadOnlyCommand } from '../command-audit'
import { t } from '../i18n'
import { partialFromVerdict, type ExpertInput, type ExpertPartial, type ExpertResult } from './expert'
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
  /** 运维专家；没有就按原来的只读判定。只在替我审批和自由模式下用到 */
  expert?: { judge: (input: ExpertInput) => Promise<ExpertResult> }
  /** 这场对话开着替我审批（执行档仍是宽松）。严格、宽松每批都由用户看，不请专家 */
  autoReview?: boolean
  /** 专家没让用户点头就放行了：把它的理由留在这场对话的过程里 */
  onExpertAllowed?: (note: string, request: RemoteAccessRequest) => void
  /**
   * 替我审批下没放行，先在确认卡前面留一行再问用户。
   * note 是专家写的话；没有就是没给出结论。
   */
  onExpertHandedOver?: (note: string | undefined, request: RemoteAccessRequest) => void
  /**
   * 专家还在写的时候刷新界面上那一行。
   * looking：刚开始看，结论还没到。writing：结论已到，说明可能还在长。
   * settled：写完了。failed：没给出能用的结论。stop：这一轮停了，或自由模式下改走别的判定。
   */
  onExpertLive?: (update: ExpertLiveUpdate, request: RemoteAccessRequest) => void
}

export type ExpertLiveUpdate =
  | { kind: 'looking' }
  | { kind: 'writing'; partial: ExpertPartial }
  | { kind: 'settled'; partial: ExpertPartial }
  | { kind: 'failed' }
  | { kind: 'stop'; why: 'cancelled' | 'fallback' }

export type GateOutcome<T> = { ok: true; value: T } | { ok: false; error: string }

/** 派出：每个伙计要连的主机 id 清单，和他自己的命令（没有就是不碰远程） */
export interface DispatchedWorkerHosts {
  hosts?: readonly string[]
  /** 只属于这个伙计的命令；整批共有的另给 */
  commands?: readonly string[]
}

export class RemoteDispatchGate {
  constructor(private readonly ctx: RemoteDispatchContext) {}

  /**
   * 返回与 workers 一一对应的范围；不碰远程的伙计对应 undefined。
   * 每个伙计的命令 = 整批共有的 + 他自己的，去重；他只能跑这一份。
   */
  async authorizeDispatch(
    workers: readonly DispatchedWorkerHosts[],
    sharedCommands: readonly string[],
  ): Promise<GateOutcome<Array<RemoteGrant | undefined>>> {
    const anyHosts = workers.some(w => (w.hosts?.length ?? 0) > 0)
    const anyCommands = sharedCommands.length > 0 || workers.some(w => (w.commands?.length ?? 0) > 0)
    if (!anyHosts && !anyCommands) return { ok: true, value: workers.map(() => undefined) }
    if (!anyHosts) return { ok: false, error: t('remote.need_hosts') }

    const commandsOf = workers.map(w => [...new Set([...sharedCommands, ...(w.commands ?? [])])])
    for (let i = 0; i < workers.length; i++) {
      const hasHosts = (workers[i]!.hosts?.length ?? 0) > 0
      if (!hasHosts && (workers[i]!.commands?.length ?? 0) > 0) return { ok: false, error: t('remote.worker_commands_without_hosts', { index: i + 1 }) }
      if (hasHosts && commandsOf[i]!.length === 0) return { ok: false, error: t('remote.need_commands', { index: i + 1 }) }
    }

    for (let i = 0; i < workers.length; i++) {
      if ((workers[i]!.hosts?.length ?? 0) === 0) continue
      const shape = this.checkShape(commandsOf[i]!)
      if (shape) return { ok: false, error: shape }
    }
    if (!this.ctx.conversationAllows) return { ok: false, error: t('remote.background_denied') }

    const resolved = this.resolveHosts(workers)
    if ('error' in resolved) return { ok: false, error: resolved.error }

    const members = resolved.perWorker
      .map((hosts, i) => ({ hosts, commands: commandsOf[i]! }))
      .filter(m => m.hosts.length > 0)
    const assignments = splitByCommands(members)
    const request: RemoteAccessRequest = {
      hosts: uniqueHosts(members.flatMap(m => m.hosts)),
      commands: [...new Set(members.flatMap(m => m.commands))],
      workerCount: members.length,
      ...(assignments.length > 1 ? { assignments } : {}),
    }
    const verdict = await this.vet(request, t('remote.confirm_title_dispatch', { count: request.workerCount ?? 0 }), t('remote.rejected'))
    if (verdict) return { ok: false, error: verdict }

    return {
      ok: true,
      value: resolved.perWorker.map((hosts, i) => (hosts.length > 0 ? new RemoteGrant(hosts, commandsOf[i]!) : undefined)),
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

    const request: RemoteAccessRequest = {
      hosts: [...grant.hosts],
      commands: [...commands],
      forWorker: workerName,
    }
    const verdict = await this.vet(request, t('remote.confirm_title_followup', { name: workerName }), t('remote.followup_rejected', { name: workerName }))
    if (verdict) return { ok: false, error: verdict }
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

  /**
   * 这一批能不能去做。通过返回 null，否则返回给模型的原因。
   *
   * 谁来判，跟这场对话的审批方式走：
   * - 严格、宽松：每批都由用户看，直接弹卡，不请专家，也不要求命令只读
   * - 替我审批：请专家。放行直接过并留痕；没放行先在卡前面留一行再弹卡；拒绝退回
   * - 自由：请专家，不问人。放行直接过；问用户或拒绝都退回
   * - 专家没给出结论（出错、超时、看不懂）：替我审批弹卡交给用户；自由退回只读判定
   * - 没有人在场且不是自由：没人能批，不必再问专家
   * 没有专家可用（取不到模型通道）时，自由和替我审批退回原来的做法：命令都只读，再按审批方式确认。
   */
  private async vet(request: RemoteAccessRequest, title: string, rejectedText: string): Promise<string | null> {
    const expert = this.ctx.expert
    const mode = this.ctx.executionMode
    if (mode !== 'free' && !this.ctx.autoReview) return this.askApproval(request, title, rejectedText)
    if (!expert) {
      const readOnly = await this.checkReadOnly(request.commands)
      return readOnly ?? await this.askApproval(request, title, rejectedText)
    }

    if (mode !== 'free' && !this.ctx.attended) return t('remote.nobody_to_confirm')

    this.ctx.onExpertLive?.({ kind: 'looking' }, request)
    const result = await expert.judge({
      hosts: request.hosts,
      commands: request.commands,
      ...(request.workerCount !== undefined ? { workerCount: request.workerCount } : {}),
      ...(request.assignments ? { assignments: request.assignments } : {}),
      ...(request.forWorker ? { forWorker: request.forWorker } : {}),
      approval: mode === 'free' ? 'free' : 'autoReview',
      attended: this.ctx.attended,
      onPartial: (partial) => this.ctx.onExpertLive?.({ kind: 'writing', partial }, request),
    })

    if (result.kind === 'cancelled') {
      this.ctx.onExpertLive?.({ kind: 'stop', why: 'cancelled' }, request)
      return t('remote.expert_cancelled')
    }
    if (result.kind === 'unavailable') {
      if (mode !== 'free') {
        this.ctx.onExpertLive?.({ kind: 'failed' }, request)
        return this.handToUser(request, undefined, title, rejectedText)
      }
      this.ctx.onExpertLive?.({ kind: 'stop', why: 'fallback' }, request)
      return this.checkReadOnly(request.commands)
    }

    const { verdict } = result
    this.ctx.onExpertLive?.({ kind: 'settled', partial: partialFromVerdict(verdict) }, request)
    if (verdict.outcome === 'refuse') return t('remote.expert_refused', { reason: verdict.reason })
    if (verdict.outcome === 'ask_user') {
      if (mode === 'free') return t('remote.expert_cannot_ask', { card: verdict.card })
      return this.handToUser(request, verdict.card, title, rejectedText)
    }
    this.ctx.onExpertAllowed?.(verdict.note, request)
    return null
  }

  private async checkReadOnly(commands: readonly string[]): Promise<string | null> {
    for (let i = 0; i < commands.length; i++) {
      const reason = await checkReadOnlyCommand(commands[i]!, { kind: 'remote' })
      if (reason) return t('remote.not_read_only', { index: i + 1, command: commands[i]!, reason })
    }
    return null
  }

  /** 替我审批要问用户：先在卡前面留一行（和原来交给你定一样），卡上不重复写专家的话 */
  private async handToUser(
    request: RemoteAccessRequest,
    note: string | undefined,
    title: string,
    rejectedText: string,
  ): Promise<string | null> {
    this.ctx.onExpertHandedOver?.(note, request)
    return this.askApproval(request, title, rejectedText)
  }

  /** 批准返回 null，否则返回给模型的原因 */
  private async askApproval(request: RemoteAccessRequest, displayName: string, rejectedText: string): Promise<string | null> {
    // 自由模式是用户选的「不问」；批准后单子照样限定范围
    if (this.ctx.executionMode === 'free') return null
    if (!this.ctx.attended) return t('remote.nobody_to_confirm')
    const toolArgs: Record<string, unknown> = {
      hosts: request.hosts.map(h => ({ name: h.name, address: h.address, ...(h.group ? { group: h.group } : {}) })),
      remote_commands: request.commands,
      ...(request.assignments ? { assignments: request.assignments.map(b => ({ workers: b.workerCount, hosts: b.hosts.map(h => h.name), remote_commands: b.commands })) } : {}),
      ...(request.workerCount !== undefined ? { workers: request.workerCount } : {}),
      ...(request.forWorker ? { worker: request.forWorker } : {}),
    }
    const approved = await this.ctx.confirm(request, toolArgs, displayName, [t('remote.reason_scope'), t('remote.reason_output')])
    return approved ? null : rejectedText
  }
}

/** 命令清单相同（不看顺序）的伙计归一块，块按首次出现的顺序排 */
function splitByCommands(members: ReadonlyArray<{ hosts: readonly GrantedHost[]; commands: readonly string[] }>): RemoteAccessAssignment[] {
  const blocks = new Map<string, { workerCount: number; hosts: GrantedHost[]; commands: string[] }>()
  for (const member of members) {
    const key = JSON.stringify([...member.commands].sort())
    const block = blocks.get(key) ?? { workerCount: 0, hosts: [], commands: [...member.commands] }
    block.workerCount++
    block.hosts.push(...member.hosts)
    blocks.set(key, block)
  }
  return [...blocks.values()].map(b => ({ ...b, hosts: uniqueHosts(b.hosts) }))
}

function uniqueHosts(hosts: readonly GrantedHost[]): GrantedHost[] {
  const seen = new Map<string, GrantedHost>()
  for (const h of hosts) if (!seen.has(h.id)) seen.set(h.id, h)
  return [...seen.values()]
}
