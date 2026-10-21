/**
 * 发往同一个接口账号、同一款模型的请求，共用一个自适应的放行窗口。
 *
 * 没被限流就逐步放开；被限流就收窄窗口、整组先缓一缓，缓完只放一个探路，
 * 探路成功才接着放。当面等的请求不排队，只计数、参与限流判断。
 * 详见 docs/plans/done-2026-10-20-sub-agent-scale-design.md §3.2。
 */
import { createHash } from 'crypto'
import { createLogger } from '../utils/logger'

const log = createLogger('ModelBuffer')

/**
 * urgent：用户当面等的，不排队。
 * urgentRetry：当面等的撞了限流再试。排在所有排队的前面，窗口里有空位就发，不等暂停结束；
 *   不再硬挤，免得接口被伙计占满时一次次撞限流、把重试次数用光。
 * continuing：已经开工的伙计接着发的，排队里优先。
 * queued：伙计第一次请求、关切、唤醒、后台整理。
 */
export type ModelRequestPriority = 'urgent' | 'urgentRetry' | 'continuing' | 'queued'

export interface ModelRequestBufferTuning {
  initialWindow: number
  pauseBaseMs: number
  pauseMaxMs: number
  /** 接口给的 Retry-After 最多认多久 */
  retryAfterMaxMs: number
}

export const DEFAULT_BUFFER_TUNING: ModelRequestBufferTuning = {
  initialWindow: 8,
  pauseBaseMs: 3_000,
  pauseMaxMs: 60_000,
  retryAfterMaxMs: 120_000,
}

export interface BufferClock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const SYSTEM_CLOCK: BufferClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms)
    handle.unref?.()
    return handle
  },
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
}

export interface AcquireOptions {
  signal?: AbortSignal
  /** 开始排队时 true，拿到名额或放弃时 false。不排队就不调。 */
  onWait?: (waiting: boolean) => void
}

export interface ModelBufferSnapshot {
  window: number
  inFlight: number
  queued: number
  pausedForMs: number
  recovering: boolean
}

export class BufferAbortError extends Error {
  constructor() {
    super('aborted while waiting for a model request slot')
    this.name = 'AbortError'
  }
}

/** 一个请求拿到的名额。放名额只生效一次。 */
export class ModelRequestPermit {
  private released = false

  constructor(
    private readonly group: BufferGroup,
    readonly generation: number,
    readonly isProbe: boolean,
  ) {}

  reportSuccess(): void {
    this.group.onSuccess(this)
  }

  reportThrottled(retryAfterMs?: number): void {
    this.group.onThrottled(this, retryAfterMs)
  }

  release(): void {
    if (this.released) return
    this.released = true
    this.group.onRelease(this)
  }
}

interface Waiter {
  resolve: (permit: ModelRequestPermit) => void
  reject: (err: Error) => void
  options: AcquireOptions
  /** 已经告诉过调用方「在等」 */
  waiting: boolean
  detach: () => void
}

class BufferGroup {
  private window: number
  private inFlight = 0
  /** 第一次被限流前每成功一个就 +1，之后每成功一整窗口才 +1 */
  private fastGrowth = true
  private steadySuccesses = 0
  /** 每次因限流调整就换一代；上一代放出去的请求再撞限流不重复算 */
  private generation = 0
  private consecutiveThrottles = 0
  private pausedUntil = 0
  private pauseTimer: unknown
  /** 被限流后还没有这一代的请求成功过 */
  private recovering = false
  private probeOutstanding = false
  private readonly front: Waiter[] = []
  private readonly continuing: Waiter[] = []
  private readonly queued: Waiter[] = []

  constructor(
    private readonly tuning: ModelRequestBufferTuning,
    private readonly clock: BufferClock,
    private readonly label: string,
  ) {
    this.window = tuning.initialWindow
  }

  acquire(priority: ModelRequestPriority, options: AcquireOptions): Promise<ModelRequestPermit> {
    if (options.signal?.aborted) return Promise.reject(new BufferAbortError())
    if (priority === 'urgent') return Promise.resolve(this.grant(false))

    return new Promise((resolve, reject) => {
      const lane = priority === 'urgentRetry' ? this.front : priority === 'continuing' ? this.continuing : this.queued
      const waiter: Waiter = { resolve, reject, options, waiting: false, detach: () => {} }
      const onAbort = () => {
        const idx = lane.indexOf(waiter)
        if (idx < 0) return
        lane.splice(idx, 1)
        this.stopWaiting(waiter)
        reject(new BufferAbortError())
        this.pump()
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })
      waiter.detach = () => options.signal?.removeEventListener('abort', onAbort)
      lane.push(waiter)
      this.pump()
      if (lane.includes(waiter)) {
        waiter.waiting = true
        options.onWait?.(true)
      }
    })
  }

  private stopWaiting(waiter: Waiter): void {
    waiter.detach()
    if (!waiter.waiting) return
    waiter.waiting = false
    waiter.options.onWait?.(false)
  }

  onSuccess(permit: ModelRequestPermit): void {
    if (permit.generation !== this.generation) return
    const wasRecovering = this.recovering
    this.recovering = false
    this.probeOutstanding = false
    this.consecutiveThrottles = 0
    this.pausedUntil = Math.min(this.pausedUntil, this.clock.now())
    if (this.inFlight + this.queuedCount() >= this.window) {
      if (this.fastGrowth) {
        this.window++
      } else if (++this.steadySuccesses >= this.window) {
        this.window++
        this.steadySuccesses = 0
      }
    }
    if (wasRecovering) {
      log.info(`${this.label} 恢复放行：窗口 ${this.window}，在途 ${this.inFlight}，排队 ${this.queuedCount()}`)
    }
    this.pump()
  }

  onThrottled(permit: ModelRequestPermit, retryAfterMs?: number): void {
    if (permit.generation !== this.generation) return
    const previousWindow = this.window
    this.generation++
    this.window = Math.max(1, Math.floor(this.window / 2))
    this.fastGrowth = false
    this.steadySuccesses = 0
    this.consecutiveThrottles++
    this.recovering = true
    this.probeOutstanding = false
    const backoff = Math.min(
      this.tuning.pauseMaxMs,
      this.tuning.pauseBaseMs * 2 ** (this.consecutiveThrottles - 1),
    )
    const pause = retryAfterMs && retryAfterMs > 0
      ? Math.min(this.tuning.retryAfterMaxMs, retryAfterMs)
      : backoff
    this.pausedUntil = Math.max(this.pausedUntil, this.clock.now() + pause)
    log.info(
      `${this.label} 被限流：窗口 ${previousWindow}→${this.window}，暂停 ${(pause / 1000).toFixed(1)}s`
      + `（连续第 ${this.consecutiveThrottles} 次${retryAfterMs ? '，接口给了等待时间' : ''}），在途 ${this.inFlight}，排队 ${this.queuedCount()}`,
    )
    this.pump()
  }

  onRelease(permit: ModelRequestPermit): void {
    this.inFlight = Math.max(0, this.inFlight - 1)
    if (permit.isProbe && permit.generation === this.generation && this.recovering) {
      this.probeOutstanding = false
    }
    this.pump()
  }

  snapshot(): ModelBufferSnapshot {
    return {
      window: this.window,
      inFlight: this.inFlight,
      queued: this.queuedCount(),
      pausedForMs: Math.max(0, this.pausedUntil - this.clock.now()),
      recovering: this.recovering,
    }
  }

  private queuedCount(): number {
    return this.front.length + this.continuing.length + this.queued.length
  }

  private grant(fromQueue: boolean): ModelRequestPermit {
    const isProbe = fromQueue && this.recovering
    if (isProbe) this.probeOutstanding = true
    this.inFlight++
    return new ModelRequestPermit(this, this.generation, isProbe)
  }

  private canGrantQueued(): boolean {
    if (this.clock.now() < this.pausedUntil) return false
    if (this.inFlight >= this.window) return false
    if (this.recovering && this.probeOutstanding) return false
    return true
  }

  private tryGrantHead(): boolean {
    if (this.front.length > 0) {
      if (this.inFlight >= this.window) return false
      const waiter = this.front.shift()!
      this.stopWaiting(waiter)
      waiter.resolve(this.grant(false))
      return true
    }
    if (!this.canGrantQueued()) return false
    const waiter = this.continuing.shift() ?? this.queued.shift()
    if (!waiter) return false
    this.stopWaiting(waiter)
    waiter.resolve(this.grant(true))
    return true
  }

  private pump(): void {
    while (this.queuedCount() > 0 && this.tryGrantHead()) { /* 放到放不动为止 */ }
    this.schedulePauseEnd()
  }

  private schedulePauseEnd(): void {
    if (this.pauseTimer !== undefined) {
      this.clock.clearTimeout(this.pauseTimer)
      this.pauseTimer = undefined
    }
    const wait = this.pausedUntil - this.clock.now()
    if (wait <= 0 || this.queuedCount() === 0) return
    this.pauseTimer = this.clock.setTimeout(() => {
      this.pauseTimer = undefined
      this.pump()
    }, wait)
  }
}

export class ModelRequestBuffer {
  private readonly groups = new Map<string, BufferGroup>()

  constructor(
    private readonly tuning: ModelRequestBufferTuning = DEFAULT_BUFFER_TUNING,
    private readonly clock: BufferClock = SYSTEM_CLOCK,
  ) {}

  acquire(key: string, priority: ModelRequestPriority, options: AcquireOptions = {}): Promise<ModelRequestPermit> {
    return this.group(key).acquire(priority, options)
  }

  snapshot(key: string): ModelBufferSnapshot | undefined {
    return this.groups.get(key)?.snapshot()
  }

  private group(key: string): BufferGroup {
    let group = this.groups.get(key)
    if (!group) {
      group = new BufferGroup(this.tuning, this.clock, bufferLabel(key))
      this.groups.set(key, group)
    }
    return group
  }
}

/** 额度按「接口地址 + 密钥 + 模型」算。密钥只取摘要，键只活在内存里。 */
export function modelRequestKey(profile: { apiUrl?: string; apiKey?: string; model?: string }): string {
  const keyDigest = createHash('sha256').update(profile.apiKey ?? '').digest('hex').slice(0, 16)
  return `${(profile.apiUrl ?? '').trim()}|${keyDigest}|${(profile.model ?? '').trim()}`
}

/** 日志里只露模型和接口主机，不带密钥摘要 */
function bufferLabel(key: string): string {
  const [apiUrl = '', , model = ''] = key.split('|')
  let host = ''
  try {
    host = new URL(apiUrl).host
  } catch {
    // 解析不出主机就不写，免得把地址里的参数带进日志
  }
  return `[${model || '?'}@${host || '?'}]`
}

let shared: ModelRequestBuffer | undefined

export function getModelRequestBuffer(): ModelRequestBuffer {
  if (!shared) shared = new ModelRequestBuffer()
  return shared
}
