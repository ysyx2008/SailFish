/**
 * 这场 run 里活着的伙计花名册，不进会话表；每场 run 一份。
 * 每位的状态和对话由各自的存盘人记在主会话下面（花名册只告知状态变化）。
 * 这场会话以前几轮派出的伙计、已经停下的，作为「休眠」的名册外成员：不占名额、不进总览，
 * 点名再交代时从盘上叫醒，接着干。
 */
import type { AiMessage } from '../ai.service'
import type { SubAgentResult, SubAgentToolStep, TokenUsage } from '@shared/types'
import type { ChildRecorder, ChildState, ChildStateInput } from '../history/sub-agent-record-store'
import type { AgentContext, AgentStep, RunOptions } from './types'
import { applyForkTurns, type ForkTurns } from './sanitize-parent-messages'
import { ExpertTeam, MAX_TEAM_SIZE, MIN_TEAM_SIZE, TEAM_LEADER, tidyLabel, type TeamMessage } from './expert-team'

export type ChildStatus = 'pending' | 'running' | 'completed' | 'failed' | 'interrupted'

export interface ChildSnapshot {
  name: string
  /** 派的时候指定的名字没用上（已被占用、或带了不能当名字的符号）时，当时指定的那个 */
  askedName?: string
  description: string
  prompt: string
  /** 专家角色；伙计没有 */
  role?: string
  /** 所在专家团的团名 */
  team?: string
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
}

export interface ChildAgentHandle {
  run(message: string, context: AgentContext, options?: RunOptions): Promise<string>
  addUserMessage(message: string): boolean
  abort(): boolean
  isRunning(): boolean
  seedOpeningMessages?(messages: AiMessage[]): void
  /** 这位的存盘人；没有就不存 */
  readonly childRecorder?: ChildRecorder
  /** 进专家团：之后能在群里说话 */
  joinTeam?(seat: TeamSeat): void
}

/** 这场会话里以前派出的、已经停下的伙计（存在盘上，还没被叫起来） */
export type DormantChild = Pick<ChildState,
  'name' | 'askedName' | 'description' | 'prompt' | 'shownPrompt' | 'role' | 'result' | 'error' | 'blockedReason' | 'interruptedCalls'>
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
      checkpointReached: boolean
    }
  | { ok: false; error: string; members?: string[] }

/** 专家在团里的座位：知道自己是谁、在哪个团，能在群里说话 */
export interface TeamSeat {
  readonly team: string
  readonly name: string
  say(to: string[], text: string): TeamSayResult
}

export interface SpawnTask {
  name?: string
  description: string
  prompt: string
  /** 专家角色；带了就是专家 */
  role?: string
  /** 默认全带。none 不带对话，last N 只带最近几轮。 */
  forkTurns?: ForkTurns
  shownPrompt?: string
}

/** 专家团里各种时刻交给专家或组长的话 */
export interface TeamTexts {
  /** 叫醒一位专家时交给他的话。trigger 是点到他的那一条；等组长后放行的没有 */
  wake(team: ExpertTeam, member: string, unread: TeamMessage[], trigger?: TeamMessage): string
  /** 有专家点名组长 */
  leaderMention(team: ExpertTeam, message: TeamMessage): string
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
  /** 叫醒休眠的伙计时，开口前先告诉他上次的情形；没什么要说的返回空 */
  resumeNotice?: (child: DormantChild) => string
}

type RunDeps = Pick<RosterSpawnDeps,
  'getParentContext' | 'onProgress' | 'knock' | 'formatKnock' | 'archiveResult' | 'isParentAborted' | 'teamTexts' | 'restoreDormant' | 'resumeNotice'>

interface ChildSlot extends ChildSnapshot {
  handle?: ChildAgentHandle
  runPromise?: Promise<void>
  forkTurns: ForkTurns
  /** 第几段；每次开跑加一 */
  segment: number
  /** 这一段被打断了：它收干净回来时记成已打断，不管它是抛错还是照常返回 */
  interruptRequested?: boolean
}

interface TeamEntry {
  team: ExpertTeam
  /** 派出这个团时的那份；团里叫醒人、组长再交代都用它，进度一直推到派出那一步 */
  deps: RunDeps
}

const LIVE: ReadonlySet<ChildStatus> = new Set(['pending', 'running'])

/** 一场任务里同时没做完的伙计最多这么多个。只防失控，不管该派几个。 */
export const MAX_LIVE_CHILDREN = 200

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
    name = `${base}-${i++}`
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
  private teams = new Map<string, TeamEntry>()
  private waiters: Array<() => void> = []
  /** 还没被 waitForNews 领走的敲门，按先后排队。 */
  private unreadNews: string[] = []
  private readonly knockSettleMs: number

  constructor(options?: { knockSettleMs?: number }) {
    this.knockSettleMs = options?.knockSettleMs ?? KNOCK_SETTLE_MS
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
    return Math.max(0, MAX_LIVE_CHILDREN - this.liveCount())
  }

  list(): ChildSnapshot[] {
    return [...this.children.values()].map(snapshotOf)
  }

  /** 只要名字、角色和状态的名单：界面标题要认「这几位是不是专家」，不必把每人的步骤都复制一遍 */
  brief(): Array<Pick<ChildSnapshot, 'name' | 'role' | 'status'>> {
    return [...this.children.values()].map(({ name, role, status }) => ({ name, role, status }))
  }

  get(name: string): ChildSnapshot | undefined {
    const slot = this.children.get(name)
    return slot ? snapshotOf(slot) : undefined
  }

  asSubAgentResults(): SubAgentResult[] {
    return this.list().map(childToSubAgentResult)
  }

  wake(): void {
    const waiters = this.waiters.splice(0)
    for (const wake of waiters) wake()
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
   */
  async waitForNews(names: string[] | undefined, signal: AbortSignal): Promise<WaitNews> {
    const targets = names?.length ? names : [...this.children.keys()]
    const stillWorking = () => targets.some(name => {
      const child = this.children.get(name)
      return !!child && LIVE.has(child.status)
    })
    await new Promise<void>((resolve) => {
      const check = () => {
        if (signal.aborted || this.hasUnread(targets) || !stillWorking()) {
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
    if (this.hasUnread(targets)) await this.settle(signal, stillWorking)
    const arrived = this.takeAllUnread(targets)
      .map(name => this.get(name))
      .filter((c): c is ChildSnapshot => !!c)
    const snapshots = targets.map(name => this.get(name)).filter((c): c is ChildSnapshot => !!c)
    return { arrived, targets: snapshots }
  }

  /** 第一次要用到这场会话的老伙计时读一次盘。这一轮已经有的名字以内存里的为准 */
  private ensureDormant(deps: Pick<RosterSpawnDeps, 'restoreDormant'>): void {
    if (this.dormantRestored) return
    this.dormantRestored = true
    for (const child of deps.restoreDormant?.() ?? []) {
      if (!this.children.has(child.name)) this.dormant.set(child.name, child)
    }
  }

  /**
   * 全部立刻开工。超过保险丝整批不收，调用方应先看 room()。
   * 给了 team 就让这一批组成专家团（每位都要带角色，人数在团的上下限之内）。
   */
  spawn(tasks: SpawnTask[], deps: RosterSpawnDeps, options?: { team?: string }): string[] {
    if (tasks.length > this.room()) {
      throw new RangeError(`伙计超过上限：没做完的 ${this.liveCount()} 个，还能派 ${this.room()} 个，这次要 ${tasks.length} 个`)
    }
    const teamName = options?.team?.trim()
    if (teamName) {
      if (tasks.length < MIN_TEAM_SIZE || tasks.length > MAX_TEAM_SIZE) {
        throw new RangeError(`专家团要 ${MIN_TEAM_SIZE} 到 ${MAX_TEAM_SIZE} 位，这次 ${tasks.length} 位`)
      }
      if (!deps.teamTexts) throw new Error('派专家团缺少 teamTexts')
      if (tasks.some(t => !t.role)) throw new Error('专家团里每位都要有专家角色')
    }
    this.ensureDormant(deps)
    // 老伙计的名字也占着：同名会把他盘上的对话盖掉
    const used = new Set([...this.children.keys(), ...this.dormant.keys()])
    if (tasks.some(t => t.role)) used.add(TEAM_LEADER)
    const names: string[] = []

    for (const task of tasks) {
      const name = allocateChildName(task.description, used, task.name)
      used.add(name)
      const asked = task.name ? tidyLabel(task.name) : ''
      this.children.set(name, {
        name,
        askedName: asked && asked !== name ? asked : undefined,
        description: task.description || name,
        prompt: task.prompt,
        role: task.role,
        shownPrompt: task.shownPrompt,
        status: 'pending',
        steps: [],
        forkTurns: task.forkTurns ?? { kind: 'all' },
        segment: 0,
      })
      names.push(name)
    }

    let team: ExpertTeam | undefined
    if (teamName) {
      const finalName = uniqueName(teamName, n => this.teams.has(n))
      team = new ExpertTeam(finalName, names.map(n => {
        const slot = this.children.get(n)!
        return { name: n, askedName: slot.askedName, role: slot.role!, description: slot.description }
      }))
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
  teamSay(from: string, to: string[], text: string): TeamSayResult {
    const entry = this.entryOf(from)
    if (!entry) return { ok: false, error: `${from} 不在专家团里` }
    const { team, deps } = entry
    const unknown = team.unknownNames(to)
    if (unknown.length > 0) {
      return { ok: false, error: `群里没有 ${unknown.join('、')}`, members: [TEAM_LEADER, ...team.memberNames()] }
    }
    if (deps.isParentAborted()) return { ok: false, error: '已中止' }

    const outcome = team.post(from, to, text, this.interruptedIn(team))
    const woke: string[] = []
    const handed: string[] = []
    for (const name of outcome.wakeNow) {
      const delivered = this.deliverToMember(name, team, deps, outcome.message)
      if (delivered === 'started') woke.push(name)
      else if (delivered === 'handed') handed.push(name)
    }
    const texts = deps.teamTexts!
    if (outcome.toLeader) {
      deps.knock(texts.leaderMention(team, outcome.message))
      this.enqueueNews(from)
    }
    if (outcome.checkpointReached) {
      deps.knock(texts.checkpoint(team, this.teamMembers(team)))
      this.enqueueNews(from)
    }
    deps.onProgress()
    if (outcome.toLeader || outcome.checkpointReached) this.wake()
    return {
      ok: true,
      woke,
      handed,
      queued: outcome.queued,
      skipped: outcome.skipped,
      toLeader: outcome.toLeader,
      checkpointReached: outcome.checkpointReached,
    }
  }

  followup(name: string, message: string, deps: RunDeps): { ok: boolean; error?: string } {
    this.ensureDormant(deps)
    const slot = this.children.get(name)
    if (!slot) {
      const sleeper = this.dormant.get(name)
      return sleeper ? this.wakeDormant(sleeper, message, deps) : { ok: false, error: `没有叫 ${name} 的伙计` }
    }
    if (!slot.handle) return { ok: false, error: `${name} 还没开工` }
    if (deps.isParentAborted()) return { ok: false, error: '已中止' }

    const entry = this.entryOf(name)
    if (entry) return this.leaderFollowup(slot, entry, message)

    if (slot.handle.isRunning()) {
      slot.handle.addUserMessage(message)
      slot.status = 'running'
      deps.onProgress()
      return { ok: true }
    }

    if (!LIVE.has(slot.status) && this.room() <= 0) {
      return { ok: false, error: `没做完的伙计已有 ${MAX_LIVE_CHILDREN} 个，等有人做完再追问 ${name}` }
    }
    this.beginSegment(slot)
    deps.onProgress()
    slot.runPromise = this.runExisting(slot, message, deps)
    return { ok: true }
  }

  /**
   * 叫醒以前几轮停下的伙计：从盘上接回他的对话，开口前先告诉他上次的情形，再交代这一句。
   * 不带过去的团：他单独接着干。
   */
  private wakeDormant(sleeper: DormantChild, message: string, deps: RunDeps): { ok: boolean; error?: string } {
    const { name } = sleeper
    if (deps.isParentAborted()) return { ok: false, error: '已中止' }
    if (this.room() <= 0) {
      return { ok: false, error: `没做完的伙计已有 ${MAX_LIVE_CHILDREN} 个，等有人做完再追问 ${name}` }
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
      askedName: sleeper.askedName,
      description: sleeper.description,
      prompt: sleeper.prompt,
      shownPrompt: sleeper.shownPrompt,
      role: sleeper.role,
      status: 'running',
      result: sleeper.result,
      steps: revived.steps,
      handle: revived.handle,
      forkTurns: { kind: 'all' },
      segment: 0,
    }
    this.children.set(name, slot)
    persistSlot(slot)
    deps.onProgress()
    const notice = deps.resumeNotice?.(sleeper)
    slot.runPromise = this.runExisting(slot, notice ? `${notice}\n\n${message}` : message, deps)
    return { ok: true }
  }

  /** 组长对专家再交代：进群里，重新数叫醒次数，并叫醒等组长期间被点到的人（期间被打断的不叫） */
  private leaderFollowup(slot: ChildSlot, entry: TeamEntry, message: string): { ok: boolean; error?: string } {
    if (!LIVE.has(slot.status) && this.room() <= 0) {
      return { ok: false, error: `没做完的伙计已有 ${MAX_LIVE_CHILDREN} 个，等有人做完再追问 ${slot.name}` }
    }
    const { team, deps } = entry
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
      if (this.dormant.has(name)) return { ok: false, error: `${name} 已经不在跑了` }
      return { ok: false, error: `没有叫 ${name} 的伙计` }
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
    for (const slot of this.children.values()) {
      if (!LIVE.has(slot.status)) continue
      slot.handle?.abort()
      slot.status = 'interrupted'
      persistSlot(slot)
    }
    this.wake()
  }

  /** 每位当前这一段都收尾（该写的盘都写完）之后兑现；不会拒绝。已经收尾的立刻兑现 */
  settled(): Promise<void> {
    const pending = [...this.children.values()]
      .map(slot => slot.runPromise)
      .filter((p): p is Promise<void> => !!p)
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
    slot.status = 'running'
    if (team) {
      handle.joinTeam?.({
        team: team.name,
        name,
        say: (to, text) => this.teamSay(name, to, text),
      })
    }
    const seed = applyForkTurns(deps.sanitize(deps.getParentMessages()), slot.forkTurns)
    handle.seedOpeningMessages?.(seed)
    handle.childRecorder?.noteOpening(seed)
    persistSlot(slot)
    deps.onProgress()
    const opening = deps.openingFor ? deps.openingFor(snapshotOf(slot), team) : slot.prompt
    slot.runPromise = this.runExisting(slot, opening, deps)
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
    askedName: slot.askedName,
    description: slot.description,
    prompt: slot.prompt,
    shownPrompt: slot.shownPrompt,
    role: slot.role,
    status: slot.status,
    result: slot.result,
    error: slot.error,
    blockedReason: slot.blockedReason,
  }
  recorder.saveState(input)
}

function snapshotOf(slot: ChildSlot): ChildSnapshot {
  return {
    name: slot.name,
    askedName: slot.askedName,
    description: slot.description,
    prompt: slot.prompt,
    role: slot.role,
    team: slot.team,
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
