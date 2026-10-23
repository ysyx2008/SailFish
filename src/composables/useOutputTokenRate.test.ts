import { describe, expect, it } from 'vitest'
import {
  computeTokenRate,
  createOutputRateTracker,
  formatTokenRate,
  OUTPUT_RATE_MIN_ELAPSED_MS,
  resolveSessionStart,
} from './useOutputTokenRate'

describe('formatTokenRate', () => {
  it('小于 10 留一位小数', () => {
    expect(formatTokenRate(3.24)).toBe('3.2')
  })

  it('大于等于 10 取整', () => {
    expect(formatTokenRate(42.4)).toBe('42')
  })

  it('非正数不显示', () => {
    expect(formatTokenRate(0)).toBe('')
    expect(formatTokenRate(-1)).toBe('')
  })
})

describe('computeTokenRate', () => {
  it('开口太短不报', () => {
    expect(computeTokenRate(80, OUTPUT_RATE_MIN_ELAPSED_MS - 1)).toBeNull()
  })

  it('按秒换算', () => {
    expect(computeTokenRate(80, 1000)).toBe(80)
    expect(computeTokenRate(603_007, 2_383_000)).toBeCloseTo(253, 0)
  })
})

describe('resolveSessionStart', () => {
  it('用这场自己的起点', () => {
    expect(resolveSessionStart(1_000, 5_000, 4_000, 0)).toBe(1_000)
  })

  it('这次打开之前的旧对话，从这次看见它算起', () => {
    expect(resolveSessionStart(500, 10_000, 9_000, 8_000)).toBe(9_000)
  })
})

describe('createOutputRateTracker', () => {
  it('已有存量时不会把旧账当成这一段', () => {
    const tracker = createOutputRateTracker()
    tracker.reset(10_000)
    expect(tracker.ingest(10_000, 0)).toEqual({ kind: null, rate: null })
  })

  it('吐字中跟上这一段的速度', () => {
    const tracker = createOutputRateTracker()
    tracker.reset(1000)
    expect(tracker.ingest(1100, 1000)).toEqual({ kind: null, rate: null })
    expect(tracker.ingest(1300, 2000)).toEqual({ kind: 'live', rate: 300 })
  })

  it('停下来之后均速是整场输出除以整场时间', () => {
    const tracker = createOutputRateTracker()
    tracker.reset(0)
    tracker.ingest(20_000, 0)
    expect(tracker.tick(200)).toEqual({ kind: 'live', rate: 100_000 })
    expect(tracker.settleSession(603_007, 2_383_000)).toEqual({ kind: 'avg', rate: 603_007 / 2_383 })
  })

  it('首包之后用墙上时钟也能出价', () => {
    const tracker = createOutputRateTracker()
    tracker.reset(0)
    tracker.ingest(80, 0)
    expect(tracker.tick(200)).toEqual({ kind: 'live', rate: 400 })
  })

  it('停住后再吐字另起一段，停下来仍回到整场', () => {
    const tracker = createOutputRateTracker()
    tracker.reset(0)
    tracker.ingest(200, 0)
    expect(tracker.ingest(400, 1000)).toEqual({ kind: 'live', rate: 400 })
    expect(tracker.settleSession(400, 10_000)).toEqual({ kind: 'avg', rate: 40 })
    expect(tracker.ingest(460, 2500).kind).toBe('avg')
    expect(tracker.ingest(520, 3000)).toEqual({ kind: 'live', rate: 240 })
    expect(tracker.settleSession(520, 12_000)).toEqual({ kind: 'avg', rate: 520 / 12 })
  })

  it('数字回零就清空', () => {
    const tracker = createOutputRateTracker()
    tracker.reset(0)
    tracker.ingest(80, 1000)
    expect(tracker.ingest(0, 1500)).toEqual({ kind: null, rate: null })
  })

  it('估算回纠变小不清空已有速度', () => {
    const tracker = createOutputRateTracker()
    tracker.reset(0)
    tracker.ingest(2500, 0)
    expect(tracker.tick(1000)).toEqual({ kind: 'live', rate: 2500 })
    const corrected = tracker.ingest(2333, 1100)
    expect(corrected.kind).toBe('live')
    expect(corrected.rate).not.toBeNull()
    expect(tracker.settleSession(2333, 10_000).kind).toBe('avg')
  })

  it('整场时间还太短时，先留着这一段的速度', () => {
    const tracker = createOutputRateTracker()
    tracker.reset(0)
    tracker.ingest(80, 0)
    expect(tracker.tick(200)).toEqual({ kind: 'live', rate: 400 })
    expect(tracker.settleSession(80, OUTPUT_RATE_MIN_ELAPSED_MS - 1)).toEqual({ kind: 'live', rate: 400 })
  })

  it('已有输出时，结算直接给出整场均速', () => {
    const tracker = createOutputRateTracker()
    tracker.reset(50)
    expect(tracker.settleSession(50, 10_000)).toEqual({ kind: 'avg', rate: 5 })
  })
})
