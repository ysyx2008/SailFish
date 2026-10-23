/**
 * 吐字时：这一段新出来的字，按已经过去的时间折成每秒，大约每秒跳一次。
 * 停下来之后：均速是整场已经输出的 token ÷ 整场从开始到停住的时间。
 *
 * 屏幕上的输出只含这次开着之后新花的。以前的对话这次才接着聊时，
 * 整场时间也从这次接着聊开始算。
 */
import { computed, onBeforeUnmount, ref, toValue, watch, type MaybeRefOrGetter, type Ref } from 'vue'

export type OutputRateKind = 'live' | 'avg'

export interface OutputRateState {
  kind: OutputRateKind | null
  rate: number | null
}

/** 开口后至少过这么久才报速度，避免分母还没站稳就把数字打飞 */
export const OUTPUT_RATE_MIN_ELAPSED_MS = 200

/** 本页加载时刻。比这更早的对话起点不属于这次屏幕上的字数。 */
const PAGE_LOADED_AT = Date.now()

export function formatTokenRate(rate: number): string {
  if (!Number.isFinite(rate) || rate <= 0) return ''
  if (rate < 10) return rate.toFixed(1)
  return String(Math.round(rate))
}

export function computeTokenRate(tokens: number, elapsedMs: number): number | null {
  if (tokens <= 0 || elapsedMs < OUTPUT_RATE_MIN_ELAPSED_MS) return null
  return tokens / (elapsedMs / 1000)
}

/** 这场用来当均速分母的起点。过早的起点（这次打开之前的旧对话）不用。 */
export function resolveSessionStart(
  startedAt: number | undefined,
  now: number,
  observedStart: number,
  earliestKeptStart: number,
): number {
  if (
    typeof startedAt === 'number'
    && startedAt > 0
    && startedAt <= now
    && startedAt >= earliestKeptStart
  ) {
    return startedAt
  }
  return observedStart
}

export function createOutputRateTracker() {
  let lastTokens = 0
  let burstStartTokens = 0
  let burstStartAt = 0
  let outputting = false
  let state: OutputRateState = { kind: null, rate: null }

  function applyRate(kind: OutputRateKind, tokens: number, elapsedMs: number): OutputRateState {
    const next = computeTokenRate(tokens, elapsedMs)
    if (next != null) state = { kind, rate: next }
    return state
  }

  function burstTokens(): number {
    return lastTokens - burstStartTokens
  }

  function reset(tokens = 0): OutputRateState {
    lastTokens = Math.max(0, tokens)
    burstStartTokens = lastTokens
    burstStartAt = 0
    outputting = false
    state = { kind: null, rate: null }
    return state
  }

  return {
    getState(): OutputRateState {
      return state
    },

    isOutputting(): boolean {
      return outputting
    },

    reset,

    ingest(tokens: number, now: number): OutputRateState {
      const next = Math.max(0, tokens)
      if (next === 0 && lastTokens > 0) return reset(0)
      if (next < lastTokens) {
        lastTokens = next
        if (outputting && burstTokens() > 0) {
          return applyRate('live', burstTokens(), now - burstStartAt)
        }
        return state
      }
      if (next === lastTokens) return state

      if (!outputting) {
        outputting = true
        burstStartTokens = lastTokens
        burstStartAt = now
      }
      lastTokens = next
      return applyRate('live', burstTokens(), now - burstStartAt)
    },

    /** 吐字中按墙上时钟刷新，首包之后不用等下一跳也能出价 */
    tick(now: number): OutputRateState {
      if (!outputting) return state
      return applyRate('live', burstTokens(), now - burstStartAt)
    },

    /**
     * 这一段吐完了。留下的均速用整场的输出和整场的时间，
     * 不用这一段自己的速度。
     */
    settleSession(totalTokens: number, elapsedMs: number): OutputRateState {
      outputting = false
      const next = computeTokenRate(totalTokens, elapsedMs)
      if (next != null) state = { kind: 'avg', rate: next }
      return state
    },
  }
}

export function useOutputTokenRate(
  completionTokens: MaybeRefOrGetter<number>,
  isRunning: MaybeRefOrGetter<boolean>,
  sessionKey: MaybeRefOrGetter<string>,
  sessionStartedAt: MaybeRefOrGetter<number | undefined>,
  sessionEndedAt: MaybeRefOrGetter<number | undefined>,
): {
  rateKind: Ref<OutputRateKind | null>
  rateText: Ref<string>
} {
  const tracker = createOutputRateTracker()
  const snapshot = ref<OutputRateState>(tracker.getState())
  let observedStart = 0
  let idleTimer = 0
  let liveTimer = 0
  let avgTimer = 0
  const IDLE_MS = 1200
  const TICK_MS = 200

  function sync() {
    snapshot.value = { ...tracker.getState() }
  }

  function elapsedMs(now: number): number {
    const tokens = toValue(completionTokens)
    const running = toValue(isRunning)
    if (observedStart === 0 && (running || tokens > 0)) observedStart = now
    const start = resolveSessionStart(
      toValue(sessionStartedAt),
      now,
      observedStart,
      PAGE_LOADED_AT - 5000,
    )
    if (start <= 0) return 0
    if (running) return now - start
    const ended = toValue(sessionEndedAt)
    if (typeof ended === 'number' && ended >= start) return ended - start
    return now - start
  }

  function clearIdle() {
    if (!idleTimer) return
    clearTimeout(idleTimer)
    idleTimer = 0
  }

  function stopLive() {
    if (!liveTimer) return
    clearInterval(liveTimer)
    liveTimer = 0
  }

  function stopAvg() {
    if (!avgTimer) return
    clearInterval(avgTimer)
    avgTimer = 0
  }

  function settleNow() {
    clearIdle()
    stopLive()
    tracker.settleSession(toValue(completionTokens), elapsedMs(Date.now()))
    sync()
    if (toValue(isRunning) && !tracker.isOutputting()) startAvg()
    else stopAvg()
  }

  function startLive() {
    if (liveTimer) return
    stopAvg()
    liveTimer = window.setInterval(() => {
      tracker.tick(Date.now())
      sync()
    }, TICK_MS)
  }

  function startAvg() {
    if (avgTimer || tracker.isOutputting()) return
    avgTimer = window.setInterval(() => settleNow(), 1000)
  }

  function arm() {
    if (tracker.isOutputting()) {
      startLive()
      clearIdle()
      idleTimer = window.setTimeout(settleNow, IDLE_MS)
      return
    }
    stopLive()
    clearIdle()
    if (toValue(isRunning)) startAvg()
    else stopAvg()
  }

  watch(() => toValue(sessionKey), () => {
    observedStart = 0
    clearIdle()
    stopLive()
    stopAvg()
    tracker.reset(toValue(completionTokens))
    settleNow()
  }, { immediate: true })

  watch(() => toValue(completionTokens), (tokens) => {
    tracker.ingest(tokens, Date.now())
    sync()
    arm()
  })

  watch(() => toValue(isRunning), (running) => {
    if (running) {
      arm()
      return
    }
    settleNow()
  })

  watch(
    () => [toValue(sessionStartedAt), toValue(sessionEndedAt)] as const,
    () => {
      if (tracker.isOutputting()) return
      settleNow()
    },
  )

  onBeforeUnmount(() => {
    clearIdle()
    stopLive()
    stopAvg()
  })

  return {
    rateKind: computed(() => snapshot.value.kind),
    rateText: computed(() => {
      const rate = snapshot.value.rate
      return rate == null ? '' : formatTokenRate(rate)
    }),
  }
}
