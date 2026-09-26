/**
 * 这场对话答应了要接着盯的后台工作（例如被用户插话打断的那条命令）。
 *
 * - 还有欠着结果的，这一轮不收工，闲下来专门等它
 * - 等的时候用户说话、结果送到、伙计敲门，都要把这一轮叫醒
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
  /** 这一轮被叫醒（结果到了、用户说话、伙计敲门） */
  holdEnded(): void
  /** 不再盯，也不停（这场对话不要了） */
  release(): void
  /**
   * 用户按停：停掉它。返回下一轮要带给模型的交代，取的时候再生成，
   * 好把停下之后收尾的输出也带上；没有可交代的返回 undefined。
   */
  stop(): (() => string) | undefined
}

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

  /** 等到被叫醒，或这一轮被取消 */
  waitForWake(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve()
        return
      }
      const done = () => {
        this.wakers.delete(done)
        signal.removeEventListener('abort', done)
        resolve()
      }
      this.wakers.add(done)
      signal.addEventListener('abort', done, { once: true })
    })
  }

  beginHold(): void {
    if (this.held.length > 0) return
    this.prune()
    this.held = [...this.watches.values()]
    for (const watch of this.held) watch.holdStarted()
  }

  endHold(): void {
    const held = this.held.splice(0)
    for (const watch of held) watch.holdEnded()
    this.prune()
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
