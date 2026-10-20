import { describe, it, expect, beforeEach } from 'vitest'
import {
  ModelRequestBuffer,
  modelRequestKey,
  type BufferClock,
  type ModelRequestPermit,
  type ModelRequestPriority,
} from '../model-request-buffer'

class FakeClock implements BufferClock {
  private t = 0
  private timers: Array<{ at: number; fn: () => void; id: number }> = []
  private nextId = 1

  now(): number { return this.t }
  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++
    this.timers.push({ at: this.t + ms, fn, id })
    return id
  }
  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter(timer => timer.id !== handle)
  }
  advance(ms: number): void {
    const target = this.t + ms
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at)
      const next = this.timers[0]
      if (!next || next.at > target) break
      this.timers.shift()
      this.t = next.at
      next.fn()
    }
    this.t = target
  }
}

const KEY = 'k'
const flush = () => new Promise<void>(resolve => setImmediate(resolve))

function tracker(buffer: ModelRequestBuffer) {
  const granted: ModelRequestPermit[] = []
  const take = (priority: ModelRequestPriority, options: { signal?: AbortSignal; onWait?: (w: boolean) => void } = {}) => {
    const p = buffer.acquire(KEY, priority, options).then(permit => {
      granted.push(permit)
      return permit
    })
    p.catch(() => {})
    return p
  }
  return { granted, take }
}

describe('ModelRequestBuffer', () => {
  let clock: FakeClock
  let buffer: ModelRequestBuffer

  beforeEach(() => {
    clock = new FakeClock()
    buffer = new ModelRequestBuffer(
      { initialWindow: 4, pauseBaseMs: 1_000, pauseMaxMs: 8_000, retryAfterMaxMs: 120_000 },
      clock,
    )
  })

  it('起步窗口内直接放，超出的排队', async () => {
    const { granted, take } = tracker(buffer)
    for (let i = 0; i < 6; i++) void take('queued')
    await flush()
    expect(granted).toHaveLength(4)
    expect(buffer.snapshot(KEY)).toMatchObject({ inFlight: 4, queued: 2 })
  })

  it('需求顶满窗口时，没被限流前每成功一个窗口 +1', async () => {
    const { granted, take } = tracker(buffer)
    for (let i = 0; i < 10; i++) void take('queued')
    await flush()
    granted[0].reportSuccess()
    granted[0].release()
    await flush()
    expect(buffer.snapshot(KEY)?.window).toBe(5)
    expect(buffer.snapshot(KEY)?.inFlight).toBe(5)
  })

  it('需求没顶满窗口时不涨窗口', async () => {
    const { granted, take } = tracker(buffer)
    void take('queued')
    await flush()
    granted[0].reportSuccess()
    granted[0].release()
    expect(buffer.snapshot(KEY)?.window).toBe(4)
  })

  it('被限流：窗口减半、整组暂停，同一批再撞只算一次', async () => {
    const { granted, take } = tracker(buffer)
    for (let i = 0; i < 6; i++) void take('queued')
    await flush()
    granted[0].reportThrottled()
    granted[1].reportThrottled()
    granted[2].reportThrottled()
    const snap = buffer.snapshot(KEY)!
    expect(snap.window).toBe(2)
    expect(snap.pausedForMs).toBe(1_000)
    expect(snap.recovering).toBe(true)
  })

  it('暂停期间不放排队的；暂停结束只放一个探路', async () => {
    const { granted, take } = tracker(buffer)
    for (let i = 0; i < 8; i++) void take('queued')
    await flush()
    granted[0].reportThrottled()
    for (const p of granted.slice(0, 4)) p.release()
    await flush()
    expect(granted).toHaveLength(4)

    clock.advance(999)
    await flush()
    expect(granted).toHaveLength(4)

    clock.advance(1)
    await flush()
    expect(granted).toHaveLength(5)
    expect(buffer.snapshot(KEY)?.inFlight).toBe(1)
  })

  it('探路成功才接着放；缓之前放出去的成功不算恢复', async () => {
    const { granted, take } = tracker(buffer)
    for (let i = 0; i < 8; i++) void take('queued')
    await flush()
    granted[0].reportThrottled()
    granted[1].reportSuccess()
    expect(buffer.snapshot(KEY)?.recovering).toBe(true)
    for (const p of granted.slice(0, 4)) p.release()
    clock.advance(1_000)
    await flush()
    const probe = granted[4]
    expect(granted).toHaveLength(5)

    probe.reportSuccess()
    await flush()
    expect(buffer.snapshot(KEY)?.recovering).toBe(false)
    expect(granted.length).toBeGreaterThan(5)
  })

  it('探路又被限流：缓得更久', async () => {
    const { granted, take } = tracker(buffer)
    for (let i = 0; i < 8; i++) void take('queued')
    await flush()
    granted[0].reportThrottled()
    for (const p of granted.slice(0, 4)) p.release()
    clock.advance(1_000)
    await flush()
    granted[4].reportThrottled()
    expect(buffer.snapshot(KEY)?.pausedForMs).toBe(2_000)
    expect(buffer.snapshot(KEY)?.window).toBe(1)
  })

  it('连续限流暂停翻倍并封顶；一次成功归零', async () => {
    const { granted, take } = tracker(buffer)
    for (let i = 0; i < 20; i++) void take('queued')
    await flush()
    const pauses: number[] = []
    let probe = granted[0]
    for (let round = 0; round < 5; round++) {
      probe.reportThrottled()
      pauses.push(buffer.snapshot(KEY)!.pausedForMs)
      for (const p of [...granted]) p.release()
      clock.advance(pauses[pauses.length - 1])
      await flush()
      probe = granted[granted.length - 1]
    }
    expect(pauses).toEqual([1_000, 2_000, 4_000, 8_000, 8_000])

    probe.reportSuccess()
    probe.release()
    await flush()
    const next = granted[granted.length - 1]
    next.reportThrottled()
    expect(buffer.snapshot(KEY)?.pausedForMs).toBe(1_000)
  })

  it('接口给了 Retry-After 就按它缓', async () => {
    const { granted, take } = tracker(buffer)
    void take('queued')
    await flush()
    granted[0].reportThrottled(15_000)
    expect(buffer.snapshot(KEY)?.pausedForMs).toBe(15_000)
  })

  it('当面等的请求不排队，暂停中、窗口满也直接放', async () => {
    const { granted, take } = tracker(buffer)
    for (let i = 0; i < 6; i++) void take('queued')
    await flush()
    granted[0].reportThrottled()
    const onWait: boolean[] = []
    await take('urgent', { onWait: w => onWait.push(w) })
    expect(granted).toHaveLength(5)
    expect(onWait).toEqual([])
  })

  it('当面请求在暂停后成功，也算接口恢复', async () => {
    const { granted, take } = tracker(buffer)
    for (let i = 0; i < 6; i++) void take('queued')
    await flush()
    granted[0].reportThrottled()
    const urgent = await take('urgent')
    urgent.reportSuccess()
    expect(buffer.snapshot(KEY)?.recovering).toBe(false)
  })

  it('已开工伙计接着发的，排在新排上的前面', async () => {
    const { granted, take } = tracker(buffer)
    for (let i = 0; i < 4; i++) void take('queued')
    await flush()
    const order: string[] = []
    void take('queued').then(() => order.push('queued-a'))
    void take('queued').then(() => order.push('queued-b'))
    void take('continuing').then(() => order.push('continuing'))
    await flush()
    granted[0].release()
    granted[1].release()
    await flush()
    expect(order).toEqual(['continuing', 'queued-a'])
  })

  it('当面请求撞了限流再试：窗口满时等空位，空出来先给它', async () => {
    const { granted, take } = tracker(buffer)
    for (let i = 0; i < 4; i++) void take('queued')
    await flush()
    const order: string[] = []
    void take('continuing').then(() => order.push('continuing'))
    void take('urgentRetry').then(() => order.push('urgentRetry'))
    await flush()
    expect(order).toEqual([])
    granted[0].release()
    await flush()
    expect(order).toEqual(['urgentRetry'])
  })

  it('当面请求撞了限流再试：窗口有空位就发，不等暂停结束', async () => {
    const { granted, take } = tracker(buffer)
    for (let i = 0; i < 4; i++) void take('queued')
    await flush()
    granted[0].reportThrottled()
    for (const p of granted.slice(0, 3)) p.release()
    await flush()
    expect(buffer.snapshot(KEY)?.pausedForMs).toBeGreaterThan(0)
    void take('queued')
    void take('urgentRetry')
    await flush()
    expect(granted).toHaveLength(5)
    expect(buffer.snapshot(KEY)).toMatchObject({ inFlight: 2, queued: 1 })
  })

  it('排队中点停止：从队里拿掉、报中止，不占名额', async () => {
    const { take } = tracker(buffer)
    for (let i = 0; i < 4; i++) void take('queued')
    const controller = new AbortController()
    const waits: boolean[] = []
    const pending = take('queued', { signal: controller.signal, onWait: w => waits.push(w) })
    await flush()
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(waits).toEqual([true, false])
    expect(buffer.snapshot(KEY)).toMatchObject({ inFlight: 4, queued: 0 })
  })

  it('已经中止的信号直接拒绝', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(buffer.acquire(KEY, 'queued', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('放名额只生效一次', async () => {
    const { granted, take } = tracker(buffer)
    void take('queued')
    void take('queued')
    await flush()
    granted[0].release()
    granted[0].release()
    granted[0].release()
    expect(buffer.snapshot(KEY)?.inFlight).toBe(1)
  })

  it('不排队就不报「在等」；排过队拿到名额时报一对', async () => {
    const { granted, take } = tracker(buffer)
    const immediate: boolean[] = []
    void take('queued', { onWait: w => immediate.push(w) })
    for (let i = 0; i < 3; i++) void take('queued')
    const queuedWaits: boolean[] = []
    void take('queued', { onWait: w => queuedWaits.push(w) })
    await flush()
    expect(immediate).toEqual([])
    expect(queuedWaits).toEqual([true])
    granted[0].release()
    await flush()
    expect(queuedWaits).toEqual([true, false])
  })

  it('模拟压测：只能同时接 10 个的接口，200 个请求排进缓冲池比各自冲撞少得多', async () => {
    async function simulate(priority: ModelRequestPriority) {
      const simClock = new FakeClock()
      const sim = new ModelRequestBuffer(
        { initialWindow: 8, pauseBaseMs: 3_000, pauseMaxMs: 60_000, retryAfterMaxMs: 120_000 },
        simClock,
      )
      const CAPACITY = 10
      const SERVICE_MS = 2_000
      let active = 0
      let throttled = 0
      let done = 0
      const sleepSim = (ms: number) => new Promise<void>(resolve => simClock.setTimeout(resolve, ms))

      const client = async () => {
        for (let attempt = 0; ; attempt++) {
          const permit = await sim.acquire(KEY, priority)
          if (active >= CAPACITY) {
            throttled++
            permit.reportThrottled()
            permit.release()
            await sleepSim(Math.min(60_000, 5_000 * 2 ** attempt))
            continue
          }
          active++
          permit.reportSuccess()
          await sleepSim(SERVICE_MS)
          active--
          permit.release()
          done++
          return
        }
      }
      for (let i = 0; i < 200; i++) void client()
      for (let step = 0; step < 20_000 && done < 200; step++) {
        await flush()
        simClock.advance(100)
      }
      return { throttled, done, elapsedMs: simClock.now() }
    }

    const rushing = await simulate('urgent')
    const buffered = await simulate('queued')
    expect(buffered.done).toBe(200)
    expect(buffered.throttled).toBeLessThan(rushing.throttled / 20)
    expect(buffered.elapsedMs).toBeLessThan(rushing.elapsedMs / 5)
    expect(buffered.elapsedMs).toBeLessThan(60_000)
  })

  it('不同账号或模型互不影响', async () => {
    const a = modelRequestKey({ apiUrl: 'https://x', apiKey: 'k1', model: 'm' })
    const b = modelRequestKey({ apiUrl: 'https://x', apiKey: 'k2', model: 'm' })
    expect(a).not.toBe(b)
    expect(a).not.toContain('k1')
    const pa = await buffer.acquire(a, 'queued')
    pa.reportThrottled()
    const pb = await buffer.acquire(b, 'queued')
    expect(pb).toBeDefined()
    expect(buffer.snapshot(b)?.recovering).toBe(false)
  })
})
