/**
 * 这场对话答应了要接着盯的后台工作（例如转了后台、还没跑完的命令）。
 *
 * - 还有欠着结果的，这一轮不收工，闲下来专门等它
 * - 等的时候用户说话、结果送到、伙计敲门，都要把这一轮叫醒
 * - 闲着等久了也叫醒一次，把进度交给模型判断接着等、放手还是停掉
 * - 用户按停：它正在等或正在盯的，一起停掉，并留下交代给下一轮
 *
 * 具体盯的是什么由工具实现，这里只管「欠没欠、叫醒、停」。
 */

export interface BackgroundWatch {
  /** 同一件后台工作只登记一次 */
  readonly key: string
  /** 还欠这场对话一个结果 */
  isPending(): boolean
  /** 这一轮闲下来专门等它 */
  holdStarted(): void
  /** 这一轮被叫醒（结果到了、用户说话、伙计敲门，或到了检查点） */
  holdEnded(checkpoint: boolean): void
  /** 到了检查点还没了结：交给模型看的进度，由它判断接着等、放手还是停掉 */
  checkpoint(): string | undefined
  /** 不再盯，也不停（这场对话不要了） */
  release(): void
  /**
   * 用户按停：停掉它。返回下一轮要带给模型的交代，取的时候再生成，
   * 好把停下之后收尾的输出也带上；没有可交代的返回 undefined。
   */
  stop(): (() => string) | undefined
}

/**
 * 闲着等这么久还没被叫醒，就叫醒模型看一眼进度。
 * 要卡在模型缓存的有效期（常见 5 分钟）以内：隔太久每次叫醒都要把整段上下文全价重算。
 */
export const HOLD_CHECKPOINT_MS = 3 * 60_000

/** 工具里单次等一条命令的上限：同样不闭眼超过一个检查点 */
export const MAX_WAIT_SECONDS = Math.max(1, Math.floor(HOLD_CHECKPOINT_MS / 1000))

export type HoldWake = 'woken' | 'checkpoint'

export class BackgroundWatchList {
  private readonly watches = new Map<string, BackgroundWatch>()
  private readonly wakers = new Set<() => void>()
  private held: BackgroundWatch[] = []

  add(watch: BackgroundWatch): void {
    this.watches.set(watch.key, watch)
  }

  get(key: string): BackgroundWatch | undefined {
    return this.watches.get(key)
  }

  hasPending(): boolean {
    this.prune()
    return this.watches.size > 0
  }

  /** 叫醒正在等的这一轮 */
  wake(): void {
    const wakers = [...this.wakers]
    this.wakers.clear()
    for (const wake of wakers) wake()
  }

  /** 等到被叫醒、到了检查点，或这一轮被取消 */
  waitForWake(signal: AbortSignal, checkpointMs?: number): Promise<HoldWake> {
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve('woken')
        return
      }
      let timer: NodeJS.Timeout | undefined
      const finish = (wake: HoldWake) => {
        if (timer) clearTimeout(timer)
        this.wakers.delete(done)
        signal.removeEventListener('abort', done)
        resolve(wake)
      }
      const done = () => finish('woken')
      this.wakers.add(done)
      signal.addEventListener('abort', done, { once: true })
      if (checkpointMs !== undefined) {
        timer = setTimeout(() => finish('checkpoint'), checkpointMs)
        timer.unref?.()
      }
    })
  }

  beginHold(): void {
    if (this.held.length > 0) return
    this.prune()
    this.held = [...this.watches.values()]
    for (const watch of this.held) watch.holdStarted()
  }

  endHold(checkpoint = false): void {
    const held = this.held.splice(0)
    for (const watch of held) watch.holdEnded(checkpoint)
    this.prune()
  }

  /** 到了检查点：还没了结的各自交出进度 */
  checkpointNotes(): string[] {
    this.prune()
    const notes: string[] = []
    for (const watch of this.watches.values()) {
      const note = watch.checkpoint()
      if (note) notes.push(note)
    }
    return notes
  }

  /** 用户按停：全部停掉，返回要留给下一轮的交代 */
  stopAll(): Array<() => string> {
    this.held = []
    const notes: Array<() => string> = []
    for (const watch of this.watches.values()) {
      const note = watch.stop()
      if (note) notes.push(note)
    }
    this.watches.clear()
    this.wake()
    return notes
  }

  /** 这场对话不要了：不再盯，也不停（关掉对话不等于要停命令） */
  clear(): void {
    this.held = []
    for (const watch of this.watches.values()) watch.release()
    this.watches.clear()
    this.wake()
  }

  private prune(): void {
    for (const [key, watch] of this.watches) {
      if (!watch.isPending()) this.watches.delete(key)
    }
  }
}
