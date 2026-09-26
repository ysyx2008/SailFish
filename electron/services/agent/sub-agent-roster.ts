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
}

export interface RosterSpawnDeps {
  createChild: (name: string) => ChildAgentHandle
  getParentMessages: () => AiMessage[]
  getParentContext: () => AgentContext
  knock: (message: string) => void
  onProgress: (children: ChildSnapshot[]) => void
  isParentAborted: () => boolean
  sanitize: (messages: AiMessage[]) => AiMessage[]
  formatKnock: (child: ChildSnapshot) => string
  archiveResult?: (name: string, text: string) => string
  maxConcurrent?: number
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
  /** 派出这一位时的依赖。排队开工也得用它，不能被后一批的进度卡片接走。 */
  launchDeps: RosterSpawnDeps
}

const LIVE: ReadonlySet<ChildStatus> = new Set(['pending', 'running'])

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
  private startQueued?: () => void
  /** 还没被 waitForNews 领走的敲门，按先后排队。 */
  private unreadNews: string[] = []

  private enqueueNews(name: string): void {
    this.unreadNews.push(name)
  }

  private takeUnread(targets: string[]): string | undefined {
    const idx = this.unreadNews.findIndex(name => targets.includes(name))
    if (idx < 0) return undefined
    return this.unreadNews.splice(idx, 1)[0]
  }

  hasLive(): boolean {
    for (const child of this.children.values()) {
      if (LIVE.has(child.status)) return true
    }
    return false
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

  waitForKnock(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
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

  /** 等下一条还没领走的敲门，不是「只要有人已经做完」。 */
  waitForNews(names: string[] | undefined, signal: AbortSignal): Promise<ChildSnapshot[]> {
    const targets = names?.length ? names : [...this.children.keys()]
    const noneLeft = () => targets.every(name => {
      const child = this.children.get(name)
      return !child || !LIVE.has(child.status)
    })
    const snapshots = () => targets.map(name => this.get(name)).filter((c): c is ChildSnapshot => !!c)
    return new Promise((resolve) => {
      const check = () => {
        if (signal.aborted) {
          signal.removeEventListener('abort', check)
          resolve(snapshots())
          return
        }
        if (this.takeUnread(targets) || noneLeft()) {
          signal.removeEventListener('abort', check)
          resolve(snapshots())
          return
        }
        this.waiters.push(check)
      }
      signal.addEventListener('abort', check)
      check()
    })
  }

  spawn(tasks: SpawnTask[], deps: RosterSpawnDeps): string[] {
    const used = new Set(this.children.keys())
    const names: string[] = []
    const maxConcurrent = Math.min(Math.max(1, deps.maxConcurrent ?? 5), 10)

    for (const task of tasks) {
      const name = allocateChildName(task.description, used, task.name)
      used.add(name)
      this.children.set(name, {
        name,
        description: task.description || name,
        prompt: task.prompt,
        status: 'pending',
        steps: [],
        forkTurns: task.forkTurns ?? { kind: 'all' },
        launchDeps: deps,
      })
      names.push(name)
    }
    if (deps.ownedNames) {
      for (const name of names) deps.ownedNames.add(name)
    }
    deps.onProgress(this.list())

    const startNext = () => {
      if (deps.isParentAborted()) return
      const running = [...this.children.values()].filter(c => c.status === 'running').length
      if (running >= maxConcurrent) return
      const next = [...this.children.values()].find(c => c.status === 'pending' && !c.runPromise)
      if (!next) return
      this.startChild(next.name, next.launchDeps)
      startNext()
    }
    this.startQueued = startNext
    startNext()
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
      deps.onProgress(this.list())
      return { ok: true }
    }

    slot.status = 'running'
    slot.error = undefined
    deps.onProgress(this.list())
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

  recordStep(name: string, step: AgentStep, onProgress: (children: ChildSnapshot[]) => void): void {
    const slot = this.children.get(name)
    if (!slot) return
    if (step.type !== 'tool_call' || !step.toolName) return
    const existing = slot.steps.find(s => s.tool === step.toolName && s.status === 'running')
    const args = summarizeArgs(step.toolArgs)
    if (existing && step.success === undefined) {
      existing.args = args ?? existing.args
    } else if (existing && step.success !== undefined) {
      existing.status = step.success === false ? 'failed' : 'completed'
      existing.result = step.toolResult
      existing.args = args ?? existing.args
    } else {
      slot.steps.push({
        tool: step.toolName,
        args,
        status: step.success === false ? 'failed' : step.success === true ? 'completed' : 'running',
        result: step.toolResult,
      })
    }
    if (step.success === false && step.toolResult) {
      slot.blockedReason = step.toolResult
    }
    onProgress(this.list())
  }

  private startChild(name: string, deps: RosterSpawnDeps): void {
    const slot = this.children.get(name)
    if (!slot) return
    const handle = deps.createChild(name)
    slot.handle = handle
    slot.status = 'running'
    const seed = applyForkTurns(deps.sanitize(deps.getParentMessages()), slot.forkTurns)
    handle.seedOpeningMessages?.(seed)
    deps.onProgress(this.list())
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
    deps.onProgress(this.list())
    deps.knock(deps.formatKnock(snapshotOf(slot)))
    this.enqueueNews(slot.name)
    this.wake()
    this.startQueued?.()
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
  }
}

function summarizeArgs(args?: Record<string, unknown>): string | undefined {
  if (!args) return undefined
  for (const key of ['path', 'command', 'query', 'url', 'file_path']) {
    const value = args[key]
    if (typeof value === 'string' && value) return value
  }
  return undefined
}
