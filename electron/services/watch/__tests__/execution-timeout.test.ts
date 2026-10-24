import { describe, it, expect } from 'vitest'
import {
  WatchWallClockTimeout,
  createAwakeTrack,
  noteAwakeGap,
  raceWithTimeout,
  timeoutWasSleep,
  watchExecutionTimeoutMs,
} from '../execution-timeout'

describe('watchExecutionTimeoutMs', () => {
  it('defaults to 900s', () => {
    expect(watchExecutionTimeoutMs()).toBe(900_000)
  })

  it('uses explicit seconds', () => {
    expect(watchExecutionTimeoutMs(30)).toBe(30_000)
  })
})

describe('raceWithTimeout', () => {
  it('resolves when work finishes first', async () => {
    const value = await raceWithTimeout(Promise.resolve('ok'), 200, 'timeout')
    expect(value).toBe('ok')
  })

  it('rejects when work hangs past the wall clock', async () => {
    const hang = new Promise<string>(() => { /* never settles */ })
    await expect(raceWithTimeout(hang, 30, 'Watch timeout (0s)')).rejects.toThrow(WatchWallClockTimeout)
    await expect(raceWithTimeout(hang, 30, 'Watch timeout (0s)')).rejects.toThrow('Watch timeout (0s)')
  })
})

describe('timeoutWasSleep', () => {
  it('treats a long freeze with little awake time as sleep', () => {
    const track = createAwakeTrack()
    noteAwakeGap(track, 45_000)
    noteAwakeGap(track, 15 * 60_000)
    expect(timeoutWasSleep(track, 900_000)).toBe(true)
  })

  it('does not treat a full awake overrun as sleep', () => {
    const track = createAwakeTrack()
    for (let i = 0; i < 900; i++) noteAwakeGap(track, 1000)
    expect(timeoutWasSleep(track, 900_000)).toBe(false)
  })

  it('ignores short pauses', () => {
    const track = createAwakeTrack()
    noteAwakeGap(track, 3_000)
    noteAwakeGap(track, 1000)
    expect(timeoutWasSleep(track, 900_000)).toBe(false)
  })
})
