/** 未显式配置时的墙钟超时（秒） */
export const DEFAULT_WATCH_TIMEOUT_SECONDS = 900

/**
 * 事件循环停了这么久，当成电脑睡了。
 * 醒着时定时器大约每秒跳一次；睡眠会把下一次回调推迟到醒来。
 */
export const SLEEP_GAP_MS = 20_000

/** 墙钟到了。用类型区分，不靠文案关键词。 */
export class WatchWallClockTimeout extends Error {
  readonly code = 'WATCH_WALL_TIMEOUT'
  constructor(message: string) {
    super(message)
    this.name = 'WatchWallClockTimeout'
  }
}

export interface AwakeTrack {
  /** 事件循环确实在走的时间 */
  awakeMs: number
  /** 相邻两次采样的最大间隔 */
  maxGapMs: number
}

export function createAwakeTrack(): AwakeTrack {
  return { awakeMs: 0, maxGapMs: 0 }
}

/** 记下这一段间隔。大段空白是睡眠，不计入醒着的时间。 */
export function noteAwakeGap(track: AwakeTrack, gapMs: number): void {
  if (gapMs >= SLEEP_GAP_MS) {
    if (gapMs > track.maxGapMs) track.maxGapMs = gapMs
    return
  }
  if (gapMs > 0) track.awakeMs += gapMs
}

/**
 * 墙钟到了，但醒着的时间不够，中间有过睡眠。
 * 醒着干满上限（模型卡住、事件循环仍在走）不是睡眠。
 */
export function timeoutWasSleep(track: AwakeTrack, timeoutMs: number): boolean {
  return track.maxGapMs >= SLEEP_GAP_MS && track.awakeMs < timeoutMs
}

/** 墙钟超时（毫秒） */
export function watchExecutionTimeoutMs(timeoutSec?: number): number {
  return (timeoutSec ?? DEFAULT_WATCH_TIMEOUT_SECONDS) * 1000
}

/** 整段执行的墙钟上限；超时后调用方须 abort 并释放锁 */
export async function raceWithTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | null = null
  try {
    return await Promise.race([
      work,
      new Promise<T>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new WatchWallClockTimeout(timeoutMessage)), timeoutMs)
      }),
    ])
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle)
  }
}
