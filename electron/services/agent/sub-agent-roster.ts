/**
 * 这场 run 里活着的伙计花名册，不进会话表；每场 run 一份。
 * 每位的状态和对话由各自的存盘人记在主会话下面（花名册只告知状态变化）。
 * 这场会话以前几轮派出的伙计、已经停下的，作为「休眠」的名册外成员：不占名额、不进总览，
 * 点名再交代时从盘上叫醒，接着干。
 */
import { randomUUID } from 'crypto'
import { LEGACY_TEAM_ID } from '@shared/types'
import type { AiMessage } from '../ai.service'
import type { SubAgentResult, SubAgentToolStep, TeamReviewState, TeamVerdict, TokenUsage } from '@shared/types'
import type { ChildRecorder, ChildState, ChildStateInput } from '../history/sub-agent-record-store'
import type { AgentContext, AgentStep, RunOptions } from './types'
import { applyForkTurns, type ForkTurns } from './sanitize-parent-messages'
import { parentContextMessages, type ChildIdentity } from './sub-agent-context'
import { ExpertTeam, MAX_TEAM_SIZE, MIN_TEAM_SIZE, SECRETARY, TEAM_LEADER, tidyLabel, type TeamMessage } from './expert-team'
import type { RemoteGrant } from './remote-access/remote-grant'
import type { WorkerRemoteAccess } from './remote-access/worker-remote-access'
import { MAX_ORG_DEPTH, OrgLedger, type LeadSeat } from './org-ledger'

export type ChildStatus = 'pending' | 'running' | 'completed' | 'failed' | 'interrupted'

export interface ChildSnapshot {
  forkTurns?: ForkTurns
  teamId?: string
  name: string
  /** 派的时候指定的名字没用上（已被占用、或带了不能当名字的符号）时，当时指定的那个 */
  askedName?: string
  description: string
  prompt: string
  /** 专家角色；伙计没有 */
  role?: string
  /** 所在专家团的团名 */
  team?: string
  /** 是组长：在自己名下组人 */
  lead?: boolean
  /** 是验收人：团里交上来的东西由他给通过或打回的结论 */
  reviewer?: boolean
  status: ChildStatus
  result?: string
  error?: string
  steps: SubAgentToolStep[]
  tokensUsed?: TokenUsage
  blockedReason?: string
  /** 这会儿在缓冲池里排队等模型 */
  waitingForModel?: boolean
  /** 界面上显示的那份指令；批量写法只显示条目部分，共同指令在派出的工具参数里 */
  shownPrompt?: string
  /** 系统在本段收尾时取到的直属成员事实；不采用模型自述。 */
  directMembers?: ReadonlyArray<Pick<ChildSnapshot, 'name' | 'status'>>
}

export interface ChildAgentHandle {
  run(message: string, context: AgentContext, options?: RunOptions): Promise<string>
  addUserMessage(message: string): boolean
  abort(): boolean
  isRunning(): boolean
  seedOpeningMessages?(messages: AiMessage[]): void
  bindChildIdentity?(identity: ChildIdentity): void
  directMemberFacts?(): ReadonlyArray<Pick<ChildSnapshot, 'name' | 'status'>> | undefined
  /** 这位的存盘人；没有就不存 */
  readonly childRecorder?: ChildRecorder
  /** 进专家团：之后能在群里说话 */
  joinTeam?(seat: TeamSeat): void
  /** 成为组长：之后自己也有一份花名册，能在自己名下派人 */
  becomeLead?(seat: LeadSeat): void
  /** 给这位伙计接上远程通道（只有带了远程范围的伙计才会调用） */
  setRemoteAccess?(access: WorkerRemoteAccess): void
}

/** 这场会话里以前派出的、已经停下的伙计（存在盘上，还没被叫起来） */
export type DormantChild = Pick<ChildState,
  'name' | 'askedName' | 'description' | 'prompt' | 'shownPrompt' | 'role' | 'lead' | 'reviewer' | 'parent' | 'team' | 'teamId' | 'result' | 'error' | 'blockedReason' | 'interruptedCalls'>
  & {
    status: 'completed' | 'failed' | 'interrupted'
    /** 盘上记的还是「在干」：程序没来得及收尾就没了，最后一轮的内容不明 */
    abnormalExit?: boolean
    /** 从盘上叫醒：带着他以前的对话和卡片上的步骤 */
    revive(): { handle: ChildAgentHandle; steps: SubAgentToolStep[] }
  }

export type TeamSayResult =
  | {
      ok: true
      /** 已经停下、这次重新开了一段的 */
      woke: string[]
      /** 还在干、话转给他了的：手上这一步走完才会看到 */
      handed: string[]
      queued: string[]
      skipped: string[]
      toLeader: boolean
      /** 话带到了秘书那里（只有组织里下面几层的团才有） */
      toSecretary: boolean
      checkpointReached: boolean
    }
  | { ok: false; error: string; members?: string[] }

/** 专家在团里的座位：知道自己是谁、在哪个团，能在群里说话 */
export interface TeamSeat {
  readonly team: string
  readonly name: string
  say(to: string[], text: string, verdict?: TeamVerdict): TeamSayResult
}

export interface SpawnTask {
  name?: string
  description: string
  prompt: string
  /** 专家角色；带了就是专家 */
  role?: string
  /** 指定为组长（岗位选填）：他在自己名下组人 */
  lead?: boolean
  /** 当验收人（只在组团时有意义）：可以对交上来的东西给通过或打回的结论 */
  reviewer?: boolean
  /** 默认全带。none 不带对话，last N 只带最近几轮。 */
  forkTurns?: ForkTurns
  shownPrompt?: string
  /** 这位伙计的远程范围；不写就碰不到远程 */
  remoteGrant?: RemoteGrant
}

/** 专家团里各种时刻交给专家或组长的话 */
export interface TeamTexts {
  /** 叫醒一位专家时交给他的话。trigger 是点到他的那一条；等组长后放行的没有 */
  wake(team: ExpertTeam, member: string, unread: TeamMessage[], trigger?: TeamMessage): string
  /** 有专家点名组长 */
  leaderMention(team: ExpertTeam, message: TeamMessage): string
  /** 组织里某个团的专家点名秘书；秘书要回应就点名他，记进那个群 */
  secretaryMention(team: ExpertTeam, message: TeamMessage): string
  /** 叫醒次数满了这一段，等组长 */
  checkpoint(team: ExpertTeam, members: ChildSnapshot[]): string
  /** 整个专家团停下来了 */
  stopped(team: ExpertTeam, members: ChildSnapshot[]): string
}

export interface RosterSpawnDeps {
  createChild: (name: string) => ChildAgentHandle
  getParentMessages: () => AiMessage[]
  getParentContext: () => AgentContext
  knock: (message: string) => void
  /** 有人变了；要看现状自己读 list()，调用很频繁，别在这里做重活 */
  onProgress: () => void
  isParentAborted: () => boolean
  sanitize: (messages: AiMessage[]) => AiMessage[]
  formatKnock: (child: ChildSnapshot) => string
  archiveResult?: (name: string, text: string) => string
  /** 按名字和范围造出这位伙计的远程通道 */
  remoteAccessFor?: (name: string, grant: RemoteGrant) => WorkerRemoteAccess
  /**
   * 这一批派出的名字。spawn 在刷新进度前写入。
   * 进度回调只该更新这几位，后一批不能把前一张卡片刷成整场花名册。
   */
  ownedNames?: Set<string>
  /** 开工时交给他的第一条话；不给就是他的指令本身 */
  openingFor?: (child: ChildSnapshot, team?: ExpertTeam) => string
  /** 派专家团时必须给 */
  teamTexts?: TeamTexts
  /** 这场会话以前派出的、已经停下的伙计；每份花名册只读一次 */
  restoreDormant?: () => DormantChild[]
  /** 冷恢复的枝使用独立工作区和进度通道，但不启动负责人模型。 */
  forRestoredBranch?: (roster: SubAgentRoster) => RosterSpawnDeps
  /** 叫醒休眠的伙计时，开口前先告诉他上次的情形；没什么要说的返回空 */
  resumeNotice?: (child: DormantChild) => string
  /** 以前那个团的样子：重建时接上群聊文件、条数和最后一次验收结论 */
  teamHistoryFor?: (teamName: string) => TeamHistory | undefined
  /** 重建的团接上以前的群聊文件 */
  adoptTeamHistory?: (teamName: string, history: TeamHistory) => void
}

/** 以前那个团留下来的东西：叫醒团里的人时用来接着显示和写盘 */
export interface TeamHistory {
  messageCount: number
  chatFile?: string
  transcriptPath?: string
  review: TeamReviewState
  reviewers: string[]
}

type RunDeps = Pick<RosterSpawnDeps,
  'getParentContext' | 'onProgress' | 'knock' | 'formatKnock' | 'archiveResult' | 'isParentAborted' | 'teamTexts' | 'restoreDormant' | 'resumeNotice' | 'teamHistoryFor' | 'adoptTeamHistory' | 'forRestoredBranch'>

interface ChildSlot extends ChildSnapshot {
  handle?: ChildAgentHandle
  runPromise?: Promise<void>
  forkTurns: ForkTurns
  /** 第几段；每次开跑加一 */
  segment: number
  /** 这一段被打断了：它收干净回来时记成已打断，不管它是抛错还是照常返回 */
  interruptRequested?: boolean
  remoteGrant?: RemoteGrant
  /** 派出他的组长；秘书直接派的没有 */
  parent?: string
}

interface TeamEntry {
  team: ExpertTeam
  /** 派出这个团时的那份；团里叫醒人、组长再交代都用它，进度一直推到派出那一步 */
  deps: RunDeps
}

const LIVE: ReadonlySet<ChildStatus> = new Set(['pending', 'running'])

/** 一场任务里同时没做完的伙计最多这么多个。只防失控，不管该派几个。 */
export const MAX_LIVE_CHILDREN = 1000

/** 第一声敲门之后再等这么久，让陆续做完的一起进来，主人只被叫醒一次 */
const KNOCK_SETTLE_MS = 1500

export interface WaitNews {
  /** 这次新到的，一次领走 */
  arrived: ChildSnapshot[]
  /** 等的那几位现在的样子 */
  targets: ChildSnapshot[]
}

export function allocateChildName(description: string, used: Set<string>, explicit?: string): string {
  const raw = (explicit || description || 'worker').trim()
  const base = raw
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'worker'
  let name = base
  let i = 2
  while (used.has(name)) {
    name = `${base}(${i++})`
  }
  return name
}

function uniqueName(base: string, used: (name: string) => boolean): string {
  let name = base
  let i = 2
  while (used(name)) name = `${base}-${i++}`
  return name
}

export function childToSubAgentResult(child: ChildSnapshot): SubAgentResult {
  return {
    id: child.name,
    teamId: child.teamId,
    name: child.name,
    description: child.description,
    prompt: child.prompt,
    status: child.status,
    result: child.result,
    error: child.error,
    steps: child.steps,
    tokensUsed: child.tokensUsed,
    blockedReason: child.blockedReason,
  }
}

export class SubAgentRoster {
  private children = new Map<string, ChildSlot>()
  /** 以前几轮派出的、已经停下的；叫醒后进 children */
  private dormant = new Map<string, DormantChild>()
  private dormantRestored = false
  private readonly dormantIndex = new Map<string, DormantChild>()
  private restoredSeatOnly = false
  private ownerKnock?: (message: string) => void
  private teams = new Map<string, TeamEntry>()
  private waiters: Array<() => void> = []
  /** 还没被 waitForNews 领走的敲门，按先后排队。 */
  private unreadNews: string[] = []
  private readonly knockSettleMs: number
  private readonly abortHooks: Array<() => void> = []
  private readonly releaseHooks: Array<() => void> = []
  /** 项目组织的账本；没有组长时没有 */
  private ledger?: OrgLedger
  /** 这份花名册是谁的：组长的名字，秘书的没有 */
  private ownerName?: string
  /** 这份花名册在第几层，秘书的是 0 */
  private depth = 0
  private assignedTeamId?: string
  /** 盘上属于别的花名册的人，只占着名字 */
  /** 别的组长名下的人（盘上记着、不在这份名册里）：名字对应他们的组长 */
  private foreignNames = new Map<string, string | undefined>()
  /** 最近一次派人、再交代时用的那份；别的花名册替他再交代时用 */
  private lastDeps?: RunDeps

  constructor(options?: { knockSettleMs?: number }) {
    this.knockSettleMs = options?.knockSettleMs ?? KNOCK_SETTLE_MS
  }

  /** 挂进组长所在的账本：这份是他名下的花名册 */
  attachLedger(ledger: OrgLedger, owner: string | undefined, depth: number, teamId?: string): void {
    this.ledger = ledger
    this.ownerName = owner
    this.depth = depth
    this.assignedTeamId = teamId ?? (owner ? ledger.root()?.teamIdOf(owner) : undefined)
    ledger.register(this, owner, depth)
    const root = ledger.root()
    if (owner && root && root !== this && root.dormantIndex.size) {
      this.ensureDormant({ restoreDormant: () => [...root.dormantIndex.values()] })
    }
  }

  /** 真正的负责人回来时接管同一份花名册，保留已经叫醒的下级。 */
  bindOwner(knock: (message: string) => void): void {
    this.ownerKnock = knock
    this.restoredSeatOnly = false
  }

  deliverToOwner(message: string): boolean {
    let holder: SubAgentRoster | undefined = this
    const seen = new Set<SubAgentRoster>()
    while (holder && !seen.has(holder)) {
      seen.add(holder)
      if (holder.ownerKnock) { holder.ownerKnock(message); return true }
      holder = this.ledger?.parentOf(holder)
    }
    return false
  }

  private ensureLedger(): OrgLedger {
    if (!this.ledger) this.attachLedger(new OrgLedger(), this.ownerName, this.depth)
    return this.ledger!
  }

  /** 这份花名册用完了：从账本里退出（组长这一轮收工时） */
  release(): void {
    for (const hook of this.releaseHooks.splice(0)) {
      try { hook() } catch { /* 收尾的记录失败不挡着退出 */ }
    }
    for (const roster of this.ledger?.branchRosters(this) ?? []) {
      if (roster !== this && roster.restoredSeatOnly) roster.release()
    }
    this.ownerKnock = undefined
    this.ledger?.unregister(this)
  }

  /** 退出账本之前做一次收尾（比如把最后的样子记进组织看板）；只在下一次 release 时执行 */
  onRelease(hook: () => void): void {
    this.releaseHooks.push(hook)
  }

  /** 这份花名册里还能不能再指定组长：层数到顶就不行 */
  canAppointLeads(): boolean {
    return this.depth < MAX_ORG_DEPTH
  }

  /** 这份花名册的主人：秘书的是 undefined，组长的是他的名字 */
  get owner(): string | undefined {
    return this.ownerName
  }

  /** 团队归属不改变管理权限；深层成员只供秘书显式定位团队。 */
  teamIdOf(name: string, deps?: Pick<RosterSpawnDeps, 'restoreDormant'>): string | undefined {
    if (deps) this.ensureDormant(deps)
    const holder = this.ledger?.rosterOf(name)
    const child = this.children.get(name) ?? this.dormant.get(name) ?? this.dormantIndex.get(name) ?? (holder && holder !== this ? holder.get(name) : undefined)
    return child ? child.teamId ?? LEGACY_TEAM_ID : undefined
  }

  get inheritedTeamId(): string | undefined { return this.assignedTeamId }

  /** 组织里秘书的花名册；没有组织时是 undefined */
  orgRoot(): SubAgentRoster | undefined {
    return this.ledger?.root()
  }

  /** 订阅组织里任何一层的变化（界面刷新用）；没有组织时先建出账本 */
  onOrgChange(listener: () => void): () => void {
    return this.ensureLedger().subscribe(listener)
  }

  /** 这份花名册里有人变了，告诉订阅的人；没有组织时什么也不做 */
  notifyOrg(): void {
    this.ledger?.notify()
  }

  /** 组织里每一份花名册和它的位置，从上到下；没有组织时是空的 */
  orgEntries(): Array<{ roster: SubAgentRoster; owner?: string; depth: number; reportsTo?: string }> {
    return this.ledger?.entries() ?? []
  }

  /** 秘书下面第几层（秘书自己是 0） */
  get orgDepth(): number {
    return this.depth
  }

  childNames(): string[] {
    return [...this.children.keys()]
  }

  /** 当前可等待的成员：仍在运行，或本名册尚未领取他的敲门。 */
  waitingNames(consumeNews = true): string[] {
    return [...this.children.values()]
      .filter(child => LIVE.has(child.status) || (consumeNews && this.unreadNews.includes(child.name)))
      .map(child => child.name)
  }

  hasChild(name: string): boolean {
    return this.children.has(name)
  }

  /** 在这份名册里的人：在干的和已经停下、等着被叫醒的 */
  hasMember(name: string): boolean {
    return this.children.has(name) || this.dormant.has(name)
  }

  /** 这份名册占着的所有名字 */
  memberNames(): string[] {
    return [...this.children.keys(), ...this.dormant.keys()]
  }

  private enqueueNews(name: string): void {
    this.unreadNews.push(name)
  }

  private hasUnread(targets: string[]): boolean {
    return this.unreadNews.some(name => targets.includes(name))
  }

  private takeAllUnread(targets: string[]): string[] {
    const taken = this.unreadNews.filter(name => targets.includes(name))
    this.unreadNews = this.unreadNews.filter(name => !targets.includes(name))
    return [...new Set(taken)]
  }

  /** 第一声敲门之后再等一小会儿，让陆续做完的一起进来；要等的都不在干了就不等。 */
  private settle(signal: AbortSignal, stillWorking: () => boolean): Promise<void> {
    if (this.knockSettleMs <= 0 || signal.aborted || !stillWorking()) return Promise.resolve()
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', finish)
        this.waiters = this.waiters.filter(w => w !== check)
        resolve()
      }
      const check = () => {
        if (!stillWorking()) finish()
        else this.waiters.push(check)
      }
      const timer = setTimeout(finish, this.knockSettleMs)
      signal.addEventListener('abort', finish, { once: true })
      this.waiters.push(check)
    })
  }

  /** 已经有人敲过门：再等一小会儿把陆续回来的一起领。没人在干了、或 stillApplies 不成立就不等。 */
  settleKnocks(signal: AbortSignal, stillApplies: () => boolean): Promise<void> {
    return this.settle(signal, () => this.hasLive() && stillApplies())
  }

  hasLive(): boolean {
    if (this.ledger) return this.ledger.branchRosters(this).some(roster => roster.liveCount() > 0)
    for (const child of this.children.values()) {
      if (LIVE.has(child.status)) return true
    }
    return false
  }

  liveCount(): number {
    let n = 0
    for (const child of this.children.values()) {
      if (LIVE.has(child.status)) n++
    }
    return n
  }

  /** 保险丝之内还能再派几个。 */
  room(): number {
    return Math.max(0, MAX_LIVE_CHILDREN - (this.ledger?.liveCount() ?? this.liveCount()))
  }

  /** 全组织没做完的人数；没有组织就是自己这份 */
  orgLiveCount(): number {
    return this.ledger?.liveCount() ?? this.liveCount()
  }

  list(): ChildSnapshot[] {
    return [...this.children.values()].map(snapshotOf)
  }

  /** 组织图还需保留已停止、尚未叫醒的历史成员。 */
  organizationMembers(): ChildSnapshot[] {
    return [...this.list(), ...[...this.dormant.values()].map(child => snapshotOf({ ...child, steps: [], forkTurns: { kind: 'all' }, segment: 0 }))]
  }

  /** 仅在显式查询或交回时补全盘上的直属成员，不用于高频进度刷新。 */
  knownMembers(deps?: Pick<RosterSpawnDeps, 'restoreDormant'>): ChildSnapshot[] {
    if (deps) this.ensureDormant(deps)
    return this.organizationMembers()
  }

  /** 名册负责判断可寻址范围，工具层负责文案及工作区路径。 */
  targetIssue(name: string, deps?: Pick<RosterSpawnDeps, 'restoreDormant'>): { kind: 'self' | 'missing' | 'foreign'; owner?: string } | undefined {
    if (this.ownerName !== undefined && name === this.ownerName) return { kind: 'self' }
    if (deps) this.ensureDormant(deps)
    if (this.children.has(name) || this.dormant.has(name)) return
    const holder = this.ledger?.rosterOf(name)
    if (this.depth === 0 && (holder || this.dormantIndex.has(name))) return
    const owner = holder?.owner ?? this.foreignNames.get(name)
    return holder || this.foreignNames.has(name) ? { kind: 'foreign', owner: owner ?? SECRETARY } : { kind: 'missing' }
  }

  /** 只要名字、角色和状态的名单：界面标题要认「这几位是不是专家」，不必把每人的步骤都复制一遍 */
  brief(): Array<Pick<ChildSnapshot, 'name' | 'role' | 'status'>> {
    return [...this.children.values()].map(({ name, role, status }) => ({ name, role, status }))
  }

  get(name: string): ChildSnapshot | undefined {
    const slot = this.children.get(name)
    return slot ? snapshotOf(slot) : undefined
  }

  /** 这位伙计的远程范围；没有就是不碰远程 */
  remoteGrantOf(name: string): RemoteGrant | undefined {
    return this.children.get(name)?.remoteGrant
  }

  /** 整场被打断时要一起收尾的东西（比如远程通道）。abortAll 时各调用一次 */
  onAbortAll(hook: () => void): void {
    this.abortHooks.push(hook)
  }

  asSubAgentResults(): SubAgentResult[] {
    return this.list().map(childToSubAgentResult)
  }

  wake(): void {
    const waiters = this.waiters.splice(0)
    for (const wake of waiters) wake()
    this.ledger?.parentOf(this)?.wake()
  }

  /** 等到有人敲门、没人在干了或中止。把陆续回来的攒一攒，在主人接着跑之前做（见 settleKnocks），这里不再等 */
  async waitForKnock(signal: AbortSignal): Promise<void> {
    await new Promise<void>((resolve) => {
      if (!this.hasLive() || signal.aborted) {
        resolve()
        return
      }
      const done = () => {
        signal.removeEventListener('abort', done)
        this.waiters = this.waiters.filter(w => w !== done)
        resolve()
      }
      this.waiters.push(done)
      signal.addEventListener('abort', done, { once: true })
      if (!this.hasLive() || signal.aborted) done()
    })
  }

  waitUntil(names: string[] | undefined, signal: AbortSignal): Promise<ChildSnapshot[]> {
    const targets = names?.length ? names : [...this.children.keys()]
    const finished = () => targets.every(name => {
      const child = this.children.get(name)
      return !child || !LIVE.has(child.status)
    })
    const snapshots = () => targets.map(name => this.get(name)).filter((c): c is ChildSnapshot => !!c)
    return new Promise((resolve) => {
      if (finished() || signal.aborted) {
        resolve(snapshots())
        return
      }
      const check = () => {
        if (finished() || signal.aborted) {
          signal.removeEventListener('abort', check)
          resolve(snapshots())
          return
        }
        this.waiters.push(check)
      }
      this.waiters.push(check)
      signal.addEventListener('abort', check)
      if (finished() || signal.aborted) check()
    })
  }

  /**
   * 等下一批还没领走的敲门，不是「只要有人已经做完」。
   * 第一声到了再稍等一会儿，然后把已经到的一次领走。
   * consume=false：只等这些人停下，不领走敲门（别人名册上的消息仍归别人）。
   */
  async waitForNews(names: string[] | undefined, signal: AbortSignal, options: { consume?: boolean } = {}): Promise<WaitNews> {
    const consume = options.consume !== false
    const targets = names?.length ? names : [...this.children.keys()]
    const stillWorking = () => targets.some(name => {
      const child = this.children.get(name)
      return !!child && LIVE.has(child.status)
    })
    await new Promise<void>((resolve) => {
      const check = () => {
        if (signal.aborted || (consume && this.hasUnread(targets)) || !stillWorking()) {
          signal.removeEventListener('abort', check)
          this.waiters = this.waiters.filter(w => w !== check)
          resolve()
          return
        }
        this.waiters.push(check)
      }
      signal.addEventListener('abort', check)
      check()
    })
    if (consume && this.hasUnread(targets)) await this.settle(signal, stillWorking)
    const arrived = consume
      ? this.takeAllUnread(targets)
        .map(name => this.get(name))
        .filter((c): c is ChildSnapshot => !!c)
      : []
    const snapshots = targets.map(name => this.get(name)).filter((c): c is ChildSnapshot => !!c)
    return { arrived, targets: snapshots }
  }

  /** 第一次要用到这场会话的老伙计时读一次盘。这一轮已经有的名字以内存里的为准 */
  private ensureDormant(deps: Pick<RosterSpawnDeps, 'restoreDormant'>, refresh = false): void {
    if (this.dormantRestored && !refresh) return
    this.dormantRestored = true
    for (const restored of deps.restoreDormant?.() ?? []) {
      const child = { ...restored, teamId: restored.teamId ?? LEGACY_TEAM_ID }
      if (this.depth === 0) this.dormantIndex.set(child.name, child)
      if (child.parent !== this.ownerName) {
        this.foreignNames.set(child.name, child.parent)
        continue
      }
      if (!this.children.has(child.name)) this.dormant.set(child.name, child)
    }
  }

  /** 秘书直接点深层成员：只恢复汇报链上的座位，不运行中间负责人。 */
  private restoreDormantHolder(name: string, deps: RunDeps): SubAgentRoster | undefined {
    if (this.depth !== 0) return undefined
    this.ensureDormant(deps, true)
    let current = this.dormantIndex.get(name)
    if (!current?.parent) return undefined
    const chain: DormantChild[] = []
    const visited = new Set([name])
    while (current.parent) {
      if (visited.has(current.parent) || chain.length >= MAX_ORG_DEPTH) return undefined
      visited.add(current.parent)
      const parent = this.dormantIndex.get(current.parent)
      if (!parent?.lead) return undefined
      chain.unshift(parent)
      current = parent
    }
    const ledger = this.ensureLedger()
    let holder: SubAgentRoster | undefined
    for (const [index, parent] of chain.entries()) {
      holder = ledger.rosterOwnedBy(parent.name)
      if (!holder) {
        holder = new SubAgentRoster({ knockSettleMs: this.knockSettleMs })
        holder.attachLedger(ledger, parent.name, index + 1, parent.teamId)
        holder.restoredSeatOnly = true
      }
      if (!holder.lastDeps) {
        const branch = holder
        holder.lastDeps = deps.forRestoredBranch?.(branch) ?? {
          ...deps,
          onProgress: () => { deps.onProgress(); branch.notifyOrg() },
          knock: (message) => { if (!branch.deliverToOwner(message)) deps.knock(message) },
        }
      }
    }
    return holder
  }

  /** 名册里没有这个名字：盘上记着他在别的组长名下时，说明他归哪位组长 */
  private unknownError(name: string): string {
    const lead = this.foreignNames.get(name)
    return lead
      ? `${name} 是 ${lead} 名下的人，${lead} 现在没在干；再交代 ${lead}，他会从盘上叫起自己名下的人`
      : `没有叫 ${name} 的伙计`
  }

  /** 全组织已经占着的名字：存盘目录按名字放，重名会把别人的对话盖掉 */
  private takenNames(): Set<string> {
    return new Set([
      ...this.children.keys(), ...this.dormant.keys(), ...this.foreignNames.keys(),
      ...(this.ledger?.usedNames() ?? []),
    ])
  }

  /**
   * 全部立刻开工。超过保险丝整批不收，调用方应先看 room()。
   * 给了team就让这一批组成协作小组（岗位选填，人数在团的上下限之内）。
   */
  spawn(tasks: SpawnTask[], deps: RosterSpawnDeps, options?: { team?: string; teamId?: string }): string[] {
    if (tasks.length > this.room()) {
      throw new RangeError(`伙计超过上限：全组织没做完的 ${this.orgLiveCount()} 个，还能派 ${this.room()} 个，这次要 ${tasks.length} 个`)
    }
    const teamName = options?.team?.trim()
    if (teamName) {
      if (tasks.length < MIN_TEAM_SIZE || tasks.length > MAX_TEAM_SIZE) {
        throw new RangeError(`专家团要 ${MIN_TEAM_SIZE} 到 ${MAX_TEAM_SIZE} 位，这次 ${tasks.length} 位`)
      }
      if (!deps.teamTexts) throw new Error('派专家团缺少 teamTexts')
    }
    if (tasks.some(t => t.reviewer)) {
      if (!teamName) throw new Error('验收人要在专家团里：带 team 才能指定')
      if (tasks.every(t => t.reviewer)) throw new Error('团里不能人人都是验收人，总得有人做事')
    }
    if (tasks.some(t => t.lead)) {
      if (!this.canAppointLeads()) throw new RangeError(`组织最多 ${MAX_ORG_DEPTH} 层，这里已经是第 ${this.depth} 层，不能再指定组长`)
      this.ensureLedger()
    }
    this.lastDeps = deps
    this.ensureDormant(deps)
    const teamId = this.ownerName ? this.assignedTeamId ?? this.ledger?.root()?.teamIdOf(this.ownerName) ?? LEGACY_TEAM_ID : options?.teamId ?? `team-${randomUUID()}`
    // 老伙计的名字也占着：同名会把他盘上的对话盖掉
    const used = this.takenNames()
    // 「秘书」留给顶层：现在没有组织，后面也可能指定组长，别把顶层的名字占了
    used.add(SECRETARY)
    used.add(TEAM_LEADER)
    const names: string[] = []

    for (const task of tasks) {
      const name = allocateChildName(task.description, used, task.name)
      used.add(name)
      const asked = task.name ? tidyLabel(task.name) : ''
      this.children.set(name, {
        name,
        teamId,
        askedName: asked && asked !== name ? asked : undefined,
        description: task.description || name,
        prompt: task.prompt,
        role: task.role,
        ...(task.lead ? { lead: true } : {}),
        ...(task.reviewer ? { reviewer: true } : {}),
        ...(this.ownerName ? { parent: this.ownerName } : {}),
        shownPrompt: task.shownPrompt,
        status: 'pending',
        steps: [],
        forkTurns: task.forkTurns ?? { kind: 'all' },
        segment: 0,
        ...(task.remoteGrant ? { remoteGrant: task.remoteGrant } : {}),
      })
      names.push(name)
    }

    let team: ExpertTeam | undefined
    if (teamName) {
      const finalName = uniqueName(teamName, n => this.teams.has(n) || [...this.dormant.values()].some(child => child.team === n))
      team = new ExpertTeam(finalName, names.map(n => {
        const slot = this.children.get(n)!
        return { name: n, askedName: slot.askedName, role: slot.role ?? '', description: slot.description, ...(slot.reviewer ? { reviewer: true } : {}) }
      }), this.ownerName)
      this.teams.set(finalName, { team, deps })
      for (const n of names) this.children.get(n)!.team = finalName
    }

    if (deps.ownedNames) {
      for (const name of names) deps.ownedNames.add(name)
    }
    deps.onProgress()

    if (!deps.isParentAborted()) {
      for (const name of names) this.startChild(name, deps, team)
    }
    return names
  }

  /** 这个名字所在的专家团 */
  teamOf(name: string): ExpertTeam | undefined {
    const teamName = this.children.get(name)?.team
    return teamName ? this.teams.get(teamName)?.team : undefined
  }

  getTeam(teamName: string): ExpertTeam | undefined {
    return this.teams.get(teamName)?.team
  }

  listTeams(): ExpertTeam[] {
    return [...this.teams.values()].map(e => e.team)
  }

  teamMembers(team: ExpertTeam): ChildSnapshot[] {
    return team.memberNames().map(n => this.get(n)).filter((c): c is ChildSnapshot => !!c)
  }

  /** 团里没人在干了（等组长期间被点到、还没叫醒的不算在干） */
  isTeamStopped(team: ExpertTeam): boolean {
    return team.memberNames().every(n => {
      const slot = this.children.get(n)
      return !slot || !LIVE.has(slot.status)
    })
  }

  /**
   * 专家在群里说一句：记进群里，点到的专家叫醒（在跑的先记下，等手上这一步走完再看），
   * 点到组长就敲门，满了这一段就停下来等组长。
   */
  teamSay(from: string, to: string[], text: string, verdict?: TeamVerdict): TeamSayResult {
    const entry = this.entryOf(from)
    if (!entry) return { ok: false, error: `${from} 不在专家团里` }
    const { team, deps } = entry
    to = team.resolveRecipients(to)
    // 没有组织、或者这份花名册就是秘书的：群里没有「秘书」这个人
    const unknown = team.unknownNames(to).concat(this.depth === 0 ? to.filter(n => n === SECRETARY) : [])
    if (unknown.length > 0) {
      const reachable = this.depth > 0 ? [TEAM_LEADER, SECRETARY] : [TEAM_LEADER]
      return { ok: false, error: `群里没有 ${unknown.join('、')}`, members: [...reachable, ...(team.leaderName ? [team.leaderName] : []), ...team.memberNames()] }
    }
    if (verdict && !team.isReviewer(from)) return { ok: false, error: '只有验收人能给验收结论' }
    if (deps.isParentAborted()) return { ok: false, error: '已中止' }

    const outcome = team.post(from, to, text, this.interruptedIn(team), verdict)
    const woke: string[] = []
    const handed: string[] = []
    for (const name of outcome.wakeNow) {
      const delivered = this.deliverToMember(name, team, deps, outcome.message)
      if (delivered === 'started') woke.push(name)
      else if (delivered === 'handed') handed.push(name)
    }
    const texts = deps.teamTexts!
    // 最上面一层的团里，秘书就是组长
    const toLeader = outcome.toLeader
    if (toLeader) {
      deps.knock(texts.leaderMention(team, outcome.message))
      this.enqueueNews(from)
    }
    if (outcome.toSecretary && this.depth > 0) this.reachSecretary(texts.secretaryMention(team, outcome.message))
    if (outcome.checkpointReached) {
      deps.knock(texts.checkpoint(team, this.teamMembers(team)))
      this.enqueueNews(from)
    }
    deps.onProgress()
    if (toLeader || outcome.checkpointReached) this.wake()
    return {
      ok: true,
      woke,
      handed,
      queued: outcome.queued,
      skipped: outcome.skipped,
      toLeader,
      toSecretary: outcome.toSecretary && this.depth > 0,
      checkpointReached: outcome.checkpointReached,
    }
  }

  /**
   * 下面几层的团里有人点名秘书：话送到秘书的花名册，由它敲秘书的门。
   * 记在秘书直接派的那位组长名下，秘书正在 wait_agents 时也会被叫醒。
   */
  private reachSecretary(text: string): void {
    const root = this.ledger?.root()
    const under = this.ledger?.ancestorUnderRoot(this)
    if (!root?.lastDeps || !under) return
    root.lastDeps.knock(text)
    root.enqueueNews(under)
    root.wake()
  }

  /** from：说话的人。不写就是这份花名册的主人（秘书或组长）；秘书越过组长回应时写秘书 */
  followup(name: string, message: string, deps: RunDeps, from?: string): { ok: boolean; error?: string } {
    this.ensureDormant(deps)
    this.lastDeps = deps
    const slot = this.children.get(name)
    if (!slot) {
      const sleeper = this.dormant.get(name)
      if (sleeper) return this.wakeDormant(sleeper, message, deps, from)
      // 只有秘书能越过组长对别的组长名下的人说话；组长只管自己这一枝
      const owner = this.depth === 0 ? this.ledger?.rosterOf(name) ?? this.restoreDormantHolder(name, deps) : undefined
      if (owner && owner !== this && owner.lastDeps) return owner.followup(name, message, owner.lastDeps, SECRETARY)
      return { ok: false, error: this.unknownError(name) }
    }
    if (!slot.handle) return { ok: false, error: `${name} 还没开工` }
    if (deps.isParentAborted()) return { ok: false, error: '已中止' }

    const entry = this.entryOf(name)
    if (entry) return this.leaderFollowup(slot, entry, message, from)

    if (slot.handle.isRunning()) {
      slot.handle.addUserMessage(message)
      slot.status = 'running'
      deps.onProgress()
      return { ok: true }
    }

    if (!LIVE.has(slot.status) && this.room() <= 0) {
      return { ok: false, error: `全组织没做完的伙计已有 ${this.orgLiveCount()} 个，等有人做完再追问 ${name}` }
    }
    this.beginSegment(slot)
    deps.onProgress()
    slot.runPromise = this.runExisting(slot, message, deps)
    return { ok: true }
  }

  /**
   * 叫醒以前几轮停下的伙计：从盘上接回他的对话，开口前先告诉他上次的情形，再交代这一句。
   * 保留原团的身份；秘书越级交代时，发言仍以秘书记入原群。
   */
  private wakeDormant(sleeper: DormantChild, message: string, deps: RunDeps, from?: string): { ok: boolean; error?: string } {
    const { name } = sleeper
    if (deps.isParentAborted()) return { ok: false, error: '已中止' }
    if (this.room() <= 0) {
      return { ok: false, error: `全组织没做完的伙计已有 ${this.orgLiveCount()} 个，等有人做完再追问 ${name}` }
    }
    let revived: ReturnType<DormantChild['revive']>
    try {
      revived = sleeper.revive()
    } catch (err) {
      return { ok: false, error: `${name} 以前的对话读不回来：${err instanceof Error ? err.message : String(err)}` }
    }
    this.dormant.delete(name)
    const slot: ChildSlot = {
      name,
      teamId: sleeper.teamId ?? LEGACY_TEAM_ID,
      askedName: sleeper.askedName,
      description: sleeper.description,
      prompt: sleeper.prompt,
      shownPrompt: sleeper.shownPrompt,
      role: sleeper.role,
      ...(sleeper.lead ? { lead: true } : {}),
      ...(sleeper.reviewer ? { reviewer: true } : {}),
      ...(this.ownerName ? { parent: this.ownerName } : {}),
      ...(sleeper.team ? { team: sleeper.team } : {}),
      status: 'running',
      result: sleeper.result,
      steps: revived.steps,
      handle: revived.handle,
      forkTurns: { kind: 'all' },
      segment: 0,
    }
    this.children.set(name, slot)
    if (sleeper.team) {
      this.ensureTeamAfterWake(sleeper.team, deps)
      const team = this.getTeam(sleeper.team)
      if (team) this.bindTeamSeat(slot, team)
    }
    if (slot.lead) revived.handle.becomeLead?.({ ledger: this.ensureLedger(), name, depth: this.depth + 1, teamId: slot.teamId })
    revived.handle.bindChildIdentity?.({ name, role: slot.role, parent: this.ownerName, lead: !!slot.lead })
    persistSlot(slot)
    deps.onProgress()
    const entry = this.entryOf(name)
    const said = from && entry ? entry.team.outsiderSpoke(from, name, message) : undefined
    const task = said && entry && deps.teamTexts
      ? deps.teamTexts.wake(entry.team, name, entry.team.takeUnread(name), said)
      : message
    const notice = deps.resumeNotice?.(sleeper)
    slot.runPromise = this.runExisting(slot, notice ? `${notice}\n\n${task}` : task, deps)
    return { ok: true }
  }

  /**
   * 以前团里的人被叫醒时把团补回来：成员从现名册和还没叫醒的休眠记录里找。
   * 团里的旧消息还在群聊文件里；这里恢复的是团本身，让 teamSay / 团聊能接着用。
   */
  private ensureTeamAfterWake(teamName: string, deps: RunDeps): void {
    if (this.teams.has(teamName)) return
    const history = deps.teamHistoryFor?.(teamName)
    const reviewers = new Set(history?.reviewers ?? [])
    const members = [...this.children.values(), ...this.dormant.values()]
      .filter(m => m.team === teamName)
      .map(m => ({
        name: m.name,
        ...(m.askedName ? { askedName: m.askedName } : {}),
        role: m.role ?? '',
        description: m.description,
        ...(m.reviewer || reviewers.has(m.name) ? { reviewer: true } : {}),
      }))
    if (members.length === 0) return
    const team = new ExpertTeam(teamName, members, this.ownerName)
    if (history) {
      team.seedHistory(history.messageCount)
      team.seedReview(history.review)
      deps.adoptTeamHistory?.(teamName, history)
    }
    this.teams.set(teamName, { team, deps })
  }

  /** 组长对专家再交代：进群里，重新数叫醒次数，并叫醒等组长期间被点到的人（期间被打断的不叫） */
  private leaderFollowup(slot: ChildSlot, entry: TeamEntry, message: string, from?: string): { ok: boolean; error?: string } {
    if (!LIVE.has(slot.status) && this.room() <= 0) {
      return { ok: false, error: `全组织没做完的伙计已有 ${this.orgLiveCount()} 个，等有人做完再追问 ${slot.name}` }
    }
    const { team, deps } = entry
    if (from) {
      // 组长之外的人（秘书）回应：只记进群里、送到被点名的人，不算组长看过
      const said = team.outsiderSpoke(from, slot.name, message)
      this.deliverToMember(slot.name, team, deps, said)
      deps.onProgress()
      return { ok: true }
    }
    const { message: said, release } = team.leaderSpoke(slot.name, message)
    this.deliverToMember(slot.name, team, deps, said)
    const interrupted = this.interruptedIn(team)
    for (const name of release) {
      if (!interrupted.has(name)) this.deliverToMember(name, team, deps)
    }
    deps.onProgress()
    return { ok: true }
  }

  /** 被打断的专家：同伴点名不叫醒，组长再交代才接着干 */
  private interruptedIn(team: ExpertTeam): Set<string> {
    return new Set(team.memberNames().filter(n => this.children.get(n)?.status === 'interrupted'))
  }

  /**
   * 叫醒一位专家：交给他点到他的那条和他没看过的群消息。在跑就先记下，已停就在同一条线上接着跑。
   * 返回这句话怎么到的：重新开了一段 / 转给了还在干的人 / 没送到（还没有开工的人）。
   */
  private deliverToMember(name: string, team: ExpertTeam, deps: RunDeps, trigger?: TeamMessage): 'started' | 'handed' | 'none' {
    const slot = this.children.get(name)
    if (!slot?.handle) return 'none'
    const text = deps.teamTexts!.wake(team, name, team.takeUnread(name), trigger)
    if (slot.handle.isRunning()) {
      slot.handle.addUserMessage(text)
      slot.status = 'running'
      return 'handed'
    }
    this.beginSegment(slot)
    slot.runPromise = this.runExisting(slot, text, deps)
    return 'started'
  }

  /** 已停的人再开一段：上一段的失败和被拦原因不带过来 */
  private beginSegment(slot: ChildSlot): void {
    slot.status = 'running'
    slot.error = undefined
    slot.blockedReason = undefined
    persistSlot(slot)
  }

  private entryOf(name: string): TeamEntry | undefined {
    const teamName = this.children.get(name)?.team
    return teamName ? this.teams.get(teamName) : undefined
  }

  interrupt(name: string, deps?: Pick<RosterSpawnDeps, 'restoreDormant'>): { ok: boolean; error?: string; finalized?: boolean } {
    const slot = this.children.get(name)
    if (!slot) {
      if (deps) this.ensureDormant(deps)
      if (this.dormant.has(name) || (this.depth === 0 && this.dormantIndex.has(name))) return { ok: false, error: `${name} 已经不在跑了` }
      const owner = this.depth === 0 ? this.ledger?.rosterOf(name) : undefined
      if (owner && owner !== this) return owner.interrupt(name)
      return { ok: false, error: this.unknownError(name) }
    }
    if (!LIVE.has(slot.status)) return { ok: false, error: `${name} 已经不在跑了` }
    if (slot.status === 'pending' || !slot.handle) {
      slot.status = 'interrupted'
      slot.error = slot.error || '已打断'
      persistSlot(slot)
      this.enqueueNews(slot.name)
      this.wake()
      return { ok: true, finalized: true }
    }
    slot.interruptRequested = true
    slot.handle.abort()
    return { ok: true, finalized: false }
  }

  abortAll(): void {
    for (const roster of this.ledger?.branchRosters(this) ?? []) {
      if (roster !== this && roster.restoredSeatOnly) roster.abortAll()
    }
    for (const slot of this.children.values()) {
      if (!LIVE.has(slot.status)) continue
      slot.handle?.abort()
      slot.status = 'interrupted'
      persistSlot(slot)
    }
    for (const hook of this.abortHooks) {
      try { hook() } catch { /* 收尾失败不挡住别的收尾 */ }
    }
    this.wake()
  }

  /** 每位当前这一段都收尾（该写的盘都写完）之后兑现；不会拒绝。已经收尾的立刻兑现 */
  settled(): Promise<void> {
    const pending: Promise<unknown>[] = [...this.children.values()]
      .map(slot => slot.runPromise)
      .filter((p): p is Promise<void> => !!p)
    for (const roster of this.ledger?.branchRosters(this) ?? []) {
      if (roster !== this && roster.restoredSeatOnly) pending.push(roster.settled())
    }
    return Promise.allSettled(pending).then(() => undefined)
  }

  recordStep(name: string, step: AgentStep, onProgress: () => void): void {
    const slot = this.children.get(name)
    if (!slot) return
    if (!foldToolStep(slot.steps, step)) return
    if (step.success === false && step.toolResult) {
      slot.blockedReason = step.toolResult
    }
    onProgress()
  }

  private markWaiting(name: string, waiting: boolean, onProgress: () => void): void {
    const slot = this.children.get(name)
    if (!slot || !!slot.waitingForModel === waiting) return
    slot.waitingForModel = waiting || undefined
    onProgress()
  }

  private startChild(name: string, deps: RosterSpawnDeps, team?: ExpertTeam): void {
    const slot = this.children.get(name)
    if (!slot) return
    const handle = deps.createChild(name)
    slot.handle = handle
    if (slot.lead) handle.becomeLead?.({ ledger: this.ensureLedger(), name, depth: this.depth + 1, teamId: slot.teamId })
    handle.bindChildIdentity?.({ name, role: slot.role, parent: this.ownerName, lead: !!slot.lead })
    if (slot.remoteGrant && deps.remoteAccessFor) handle.setRemoteAccess?.(deps.remoteAccessFor(name, slot.remoteGrant))
    slot.status = 'running'
    if (team) this.bindTeamSeat(slot, team)
    const seed = applyForkTurns(deps.sanitize(deps.getParentMessages()), slot.forkTurns)
    handle.seedOpeningMessages?.(parentContextMessages(seed, this.ownerName))
    handle.childRecorder?.noteOpening(seed)
    persistSlot(slot)
    deps.onProgress()
    const opening = deps.openingFor ? deps.openingFor(snapshotOf(slot), team) : slot.prompt
    slot.runPromise = this.runExisting(slot, opening, deps)
  }

  /** 首次派出和恢复都从实际名册绑定身份，成员不能自己选择发件人。 */
  private bindTeamSeat(slot: ChildSlot, team: ExpertTeam): void {
    const name = slot.name
    slot.handle?.joinTeam?.({
      team: team.name,
      name,
      say: (to, text, verdict) => this.teamSay(name, to, text, verdict),
    })
  }

  private async runExisting(
    slot: ChildSlot,
    message: string,
    deps: RunDeps
  ): Promise<void> {
    const handle = slot.handle
    if (!handle) return
    // 上一段刚跑完、还没记账时又被叫起一段：旧的这段回来时不再改状态、不再敲门
    const segment = ++slot.segment
    slot.interruptRequested = false
    try {
      const raw = await handle.run(message, deps.getParentContext(), {
        callbacks: {
          onStep: (_id, step) => this.recordStep(slot.name, step, deps.onProgress),
          onModelWait: (_id, waiting) => this.markWaiting(slot.name, waiting, deps.onProgress),
        }
      })
      if (segment !== slot.segment) return
      if (slot.interruptRequested || slot.status === 'interrupted' || deps.isParentAborted()) {
        slot.status = 'interrupted'
        slot.error = slot.error || '已打断'
      } else {
        slot.status = 'completed'
        slot.result = deps.archiveResult ? deps.archiveResult(slot.name, raw) : raw
      }
    } catch (err) {
      if (segment !== slot.segment) return
      const msg = err instanceof Error ? err.message : String(err)
      if (slot.interruptRequested || slot.status === 'interrupted' || deps.isParentAborted() || /abort/i.test(msg)) {
        slot.status = 'interrupted'
        slot.error = slot.error || '已打断'
      } else {
        slot.status = 'failed'
        slot.error = msg
      }
    }
    slot.waitingForModel = undefined
    if (slot.lead) slot.directMembers = handle.directMemberFacts?.()
    persistSlot(slot)
    deps.onProgress()
    this.reportFinished(slot, deps)
    this.wake()
  }

  /**
   * 伙计、不组团的专家：做完、失败、打断都敲门。
   * 专家团里的：干完一段不敲门；失败、打断照常敲门；整个团停下来时敲一次门交代全团。
   */
  private reportFinished(slot: ChildSlot, deps: RunDeps): void {
    const entry = this.entryOf(slot.name)
    if (entry && this.isTeamStopped(entry.team)) {
      const texts = entry.deps.teamTexts ?? deps.teamTexts
      const members = this.teamMembers(entry.team)
      if (texts) deps.knock(texts.stopped(entry.team, members))
      for (const member of members) this.enqueueNews(member.name)
      return
    }
    if (entry && slot.status === 'completed') return
    deps.knock(deps.formatKnock(snapshotOf(slot)))
    this.enqueueNews(slot.name)
  }
}

/** 这位的状态变了：交给他的存盘人记下来。没有存盘人（没有会话、或不存盘）就什么也不做 */
function persistSlot(slot: ChildSlot): void {
  const recorder = slot.handle?.childRecorder
  if (!recorder) return
  const input: ChildStateInput = {
    name: slot.name,
    teamId: slot.teamId,
    askedName: slot.askedName,
    description: slot.description,
    prompt: slot.prompt,
    shownPrompt: slot.shownPrompt,
    role: slot.role,
    lead: slot.lead,
    reviewer: slot.reviewer,
    parent: slot.parent,
    team: slot.team,
    status: slot.status,
    result: slot.result,
    error: slot.error,
    blockedReason: slot.blockedReason,
  }
  recorder.saveState(input)
}

function snapshotOf(slot: ChildSlot): ChildSnapshot {
  return {
    ...(slot.directMembers ? { directMembers: slot.directMembers.map(member => ({ ...member })) } : {}),
    forkTurns: slot.forkTurns,
    name: slot.name,
    teamId: slot.teamId,
    askedName: slot.askedName,
    description: slot.description,
    prompt: slot.prompt,
    role: slot.role,
    team: slot.team,
    lead: slot.lead,
    reviewer: slot.reviewer,
    status: slot.status,
    result: slot.result,
    error: slot.error,
    steps: slot.steps.map(s => ({ ...s })),
    tokensUsed: slot.tokensUsed,
    blockedReason: slot.blockedReason,
    waitingForModel: slot.waitingForModel,
    shownPrompt: slot.shownPrompt,
  }
}

/** 一条步骤记录里和卡片有关的那几项（实时的步骤和盘上的步骤记录都合这个形状） */
export interface ToolStepLike {
  id?: string
  type: string
  toolName?: string
  toolArgs?: Record<string, unknown>
  success?: boolean
  toolResult?: string
}

/**
 * 把一条工具步骤并进这位的步骤行：有 id 就认同一条，避免 skill 执行时改名成 load_skill 后又多出一行空的；
 * 没有 id 的旧步骤仍按「同名且还在跑」并到一行。不是工具调用返回 false。
 */
export function foldToolStep(steps: SubAgentToolStep[], step: ToolStepLike): boolean {
  if (step.type !== 'tool_call' || !step.toolName) return false
  const args = summarizeArgs(step.toolArgs)
  const existing = step.id
    ? steps.find(s => s.id === step.id)
    : steps.find(s => s.tool === step.toolName && s.status === 'running')
  if (existing) {
    existing.tool = step.toolName
    if (step.id) existing.id = step.id
    if (args) existing.args = args
    if (step.success !== undefined) {
      existing.status = step.success === false ? 'failed' : 'completed'
      existing.result = step.toolResult
    }
  } else {
    steps.push({
      id: step.id,
      tool: step.toolName,
      args,
      status: step.success === false ? 'failed' : step.success === true ? 'completed' : 'running',
      result: step.toolResult,
    })
  }
  return true
}

/** 这位的卡片步骤，按盘上的步骤记录重建 */
export function toolStepsFromRecords(records: readonly ToolStepLike[]): SubAgentToolStep[] {
  const steps: SubAgentToolStep[] = []
  for (const record of records) foldToolStep(steps, record)
  return steps
}

/** 这一下动手的对象。先看路径、命令、搜索词这类主字段，再看技能、选择器。 */
const SUMMARY_ARG_FIELDS = ['path', 'command', 'query', 'url', 'file_path', 'skill_id', 'pattern'] as const

function stringArg(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

export function summarizeArgs(args?: Record<string, unknown>): string | undefined {
  if (!args) return undefined
  for (const key of SUMMARY_ARG_FIELDS) {
    const value = stringArg(args[key])
    if (value) return value
  }
  const selector = stringArg(args.selector)
  const text = stringArg(args.text)
  if (selector && text) return `${selector} ${text}`
  return selector || text
}
