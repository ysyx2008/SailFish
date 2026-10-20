/**
 * 这场 run 里活着的伙计花名册。只活在父 Agent 的当前 run，不进会话表。
 */
import type { AiMessage } from '../ai.service'
import type { SubAgentResult, SubAgentToolStep, TokenUsage } from '@shared/types'
import type { AgentContext, AgentStep, RunOptions } from './types'
import { applyForkTurns, type ForkTurns } from './sanitize-parent-messages'

export type ChildStatus = 'pending' | 'running' | 'completed' | 'failed' | 'interrupted'

export interface ChildSnapshot {
  name: string
  description: string
  prompt: string
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
}

export interface SpawnTask {
  name?: string
  description: string
  prompt: string
  /** 默认全带。none 不带对话，last N 只带最近几轮。 */
  forkTurns?: ForkTurns
  shownPrompt?: string
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
}

interface ChildSlot extends ChildSnapshot {
  handle?: ChildAgentHandle
  runPromise?: Promise<void>
  forkTurns: ForkTurns
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
    await this.settle(signal, () => this.hasLive())
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

  /** 全部立刻开工。超过保险丝整批不收，调用方应先看 room()。 */
  spawn(tasks: SpawnTask[], deps: RosterSpawnDeps): string[] {
    if (tasks.length > this.room()) {
      throw new RangeError(`伙计超过上限：没做完的 ${this.liveCount()} 个，还能派 ${this.room()} 个，这次要 ${tasks.length} 个`)
    }
    const used = new Set(this.children.keys())
    const names: string[] = []

    for (const task of tasks) {
      const name = allocateChildName(task.description, used, task.name)
      used.add(name)
      this.children.set(name, {
        name,
        description: task.description || name,
        prompt: task.prompt,
        shownPrompt: task.shownPrompt,
        status: 'pending',
        steps: [],
        forkTurns: task.forkTurns ?? { kind: 'all' },
      })
      names.push(name)
    }
    if (deps.ownedNames) {
      for (const name of names) deps.ownedNames.add(name)
    }
    deps.onProgress()

    if (!deps.isParentAborted()) {
      for (const name of names) this.startChild(name, deps)
    }
    return names
  }

  followup(name: string, message: string, deps: Pick<RosterSpawnDeps, 'getParentContext' | 'onProgress' | 'knock' | 'formatKnock' | 'archiveResult' | 'isParentAborted'>): { ok: boolean; error?: string } {
    const slot = this.children.get(name)
    if (!slot) return { ok: false, error: `没有叫 ${name} 的伙计` }
    if (!slot.handle) return { ok: false, error: `${name} 还没开工` }
    if (deps.isParentAborted()) return { ok: false, error: '已中止' }

    if (slot.handle.isRunning()) {
      slot.handle.addUserMessage(message)
      slot.status = 'running'
      deps.onProgress()
      return { ok: true }
    }

    slot.status = 'running'
    slot.error = undefined
    deps.onProgress()
    slot.runPromise = this.runExisting(slot, message, deps)
    return { ok: true }
  }

  interrupt(name: string): { ok: boolean; error?: string; finalized?: boolean } {
    const slot = this.children.get(name)
    if (!slot) return { ok: false, error: `没有叫 ${name} 的伙计` }
    if (!LIVE.has(slot.status)) return { ok: false, error: `${name} 已经不在跑了` }
    if (slot.status === 'pending' || !slot.handle) {
      slot.status = 'interrupted'
      slot.error = slot.error || '已打断'
      this.enqueueNews(slot.name)
      this.wake()
      return { ok: true, finalized: true }
    }
    slot.handle.abort()
    return { ok: true, finalized: false }
  }

  abortAll(): void {
    for (const slot of this.children.values()) {
      if (!LIVE.has(slot.status)) continue
      slot.handle?.abort()
      slot.status = 'interrupted'
    }
    this.wake()
  }

  recordStep(name: string, step: AgentStep, onProgress: () => void): void {
    const slot = this.children.get(name)
    if (!slot) return
    if (step.type !== 'tool_call' || !step.toolName) return
    const args = summarizeArgs(step.toolArgs)
    // 有 id 就认同一条，避免 skill 执行时改名成 load_skill 后又多出一行空的。
    // 没有 id 的旧步骤仍按「同名且还在跑」并到一行。
    const existing = step.id
      ? slot.steps.find(s => s.id === step.id)
      : slot.steps.find(s => s.tool === step.toolName && s.status === 'running')
    if (existing) {
      existing.tool = step.toolName
      if (step.id) existing.id = step.id
      if (args) existing.args = args
      if (step.success !== undefined) {
        existing.status = step.success === false ? 'failed' : 'completed'
        existing.result = step.toolResult
      }
    } else {
      slot.steps.push({
        id: step.id,
        tool: step.toolName,
        args,
        status: step.success === false ? 'failed' : step.success === true ? 'completed' : 'running',
        result: step.toolResult,
      })
    }
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

  private startChild(name: string, deps: RosterSpawnDeps): void {
    const slot = this.children.get(name)
    if (!slot) return
    const handle = deps.createChild(name)
    slot.handle = handle
    slot.status = 'running'
    const seed = applyForkTurns(deps.sanitize(deps.getParentMessages()), slot.forkTurns)
    handle.seedOpeningMessages?.(seed)
    deps.onProgress()
    slot.runPromise = this.runExisting(slot, slot.prompt, deps)
  }

  private async runExisting(
    slot: ChildSlot,
    message: string,
    deps: Pick<RosterSpawnDeps, 'getParentContext' | 'onProgress' | 'knock' | 'formatKnock' | 'archiveResult' | 'isParentAborted'>
  ): Promise<void> {
    const handle = slot.handle
    if (!handle) return
    try {
      const raw = await handle.run(message, deps.getParentContext(), {
        callbacks: {
          onStep: (_id, step) => this.recordStep(slot.name, step, deps.onProgress),
          onModelWait: (_id, waiting) => this.markWaiting(slot.name, waiting, deps.onProgress),
        }
      })
      if (slot.status === 'interrupted' || deps.isParentAborted()) {
        slot.status = 'interrupted'
        slot.error = slot.error || '已打断'
      } else {
        slot.status = 'completed'
        slot.result = deps.archiveResult ? deps.archiveResult(slot.name, raw) : raw
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (slot.status === 'interrupted' || deps.isParentAborted() || /abort/i.test(msg)) {
        slot.status = 'interrupted'
        slot.error = slot.error || '已打断'
      } else {
        slot.status = 'failed'
        slot.error = msg
      }
    }
    slot.waitingForModel = undefined
    deps.onProgress()
    deps.knock(deps.formatKnock(snapshotOf(slot)))
    this.enqueueNews(slot.name)
    this.wake()
  }
}

function snapshotOf(slot: ChildSlot): ChildSnapshot {
  return {
    name: slot.name,
    description: slot.description,
    prompt: slot.prompt,
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
