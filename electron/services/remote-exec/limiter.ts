/**
 * 异步限流器：同时只放 limit 个，多的排队，按先来后到。
 * 记下排队峰值和同时占用的峰值，端到端验证用。
 */
export class AsyncLimiter {
  private active = 0
  private peakActive = 0
  private readonly queue: Array<{ grant: () => void; cancelled: boolean }> = []

  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error(`限流上限要是正整数：${limit}`)
  }

  /** 同时占用的峰值 */
  get peak(): number {
    return this.peakActive
  }

  get inUse(): number {
    return this.active
  }

  get waiting(): number {
    return this.queue.filter(w => !w.cancelled).length
  }

  /**
   * 占一个名额，返回释放函数（可重复调用，只生效一次）。
   * signal 触发时放弃排队并以 abortError 结束。
   */
  acquire(signal?: AbortSignal, abortError: () => Error = () => new Error('已中止')): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(abortError())
    return new Promise((resolve, reject) => {
      const waiter = {
        cancelled: false,
        grant: () => {
          signal?.removeEventListener('abort', onAbort)
          this.active++
          this.peakActive = Math.max(this.peakActive, this.active)
          let released = false
          resolve(() => {
            if (released) return
            released = true
            this.active--
            this.drain()
          })
        },
      }
      const onAbort = () => {
        waiter.cancelled = true
        const i = this.queue.indexOf(waiter)
        if (i >= 0) this.queue.splice(i, 1)
        reject(abortError())
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.queue.push(waiter)
      this.drain()
    })
  }

  private drain(): void {
    while (this.active < this.limit && this.queue.length > 0) {
      const next = this.queue.shift()!
      if (!next.cancelled) next.grant()
    }
  }
}
