/**
 * 联络时间线里的时间标记。
 * 只标说出口的话；隔了五分钟才再标一次。
 */

export const CHAT_TIME_GAP_MS = 5 * 60 * 1000

export interface ChatSpeechItem {
  id: string
  type: string
  part?: string
  step?: { type?: string; timestamp?: number }
  group?: { id: string }
}

export interface ChatTimeMarkerItem {
  id: string
  type: 'time_marker'
  timestamp: number
  size: number
}

interface TimedStep {
  id: string
  type: string
  timestamp: number
}

const SPEECH_STEP_TYPES = new Set([
  'message',
  'user_supplement',
  'error',
  'asking',
  'proactive_notice',
])

/** 这一格是说给对方听的话，而不是中间在干活。 */
export function isChatSpeechItem(item: ChatSpeechItem): boolean {
  if (item.type === 'user_task' || item.type === 'proactive_message' || item.type === 'proactive_notice' || item.type === 'final_result') {
    return true
  }
  if (item.type !== 'step' || !item.step) return false
  if (item.part === 'thinking') return false
  return SPEECH_STEP_TYPES.has(item.step.type ?? '')
}

/** 这一句是什么时候说的。主动消息和失败收场用说完的那个时刻。 */
export function resolveSpeechTimestamp(
  item: ChatSpeechItem,
  steps: readonly TimedStep[],
): number | undefined {
  if (item.type === 'step' || item.type === 'proactive_notice') {
    return typeof item.step?.timestamp === 'number' ? item.step.timestamp : undefined
  }
  const groupId = item.group?.id
  if (!groupId) return undefined
  const idx = steps.findIndex(step => step.id === groupId)
  if (idx < 0) return undefined
  if (item.type === 'proactive_message' || item.type === 'final_result') {
    for (let i = idx + 1; i < steps.length; i++) {
      if (steps[i].type === 'user_task') break
      if (steps[i].type === 'final_result' || steps[i].type === 'proactive_notice') {
        return steps[i].timestamp
      }
    }
  }
  return steps[idx].timestamp
}

export function withChatTimeMarkers<T extends ChatSpeechItem>(
  items: readonly T[],
  steps: readonly TimedStep[],
  gapMs = CHAT_TIME_GAP_MS,
): Array<T | ChatTimeMarkerItem> {
  const out: Array<T | ChatTimeMarkerItem> = []
  let last: number | undefined
  for (const item of items) {
    if (isChatSpeechItem(item)) {
      const ts = resolveSpeechTimestamp(item, steps)
      if (typeof ts === 'number' && (last == null || ts - last >= gapMs)) {
        out.push({
          id: `time_${item.id}`,
          type: 'time_marker',
          timestamp: ts,
          size: 32,
        })
        last = ts
      } else if (typeof ts === 'number' && (last == null || ts > last)) {
        last = ts
      }
    }
    out.push(item)
  }
  return out
}

export type ChatTimeParts =
  | { kind: 'clock'; time: string }
  | { kind: 'yesterday'; time: string }
  | { kind: 'weekday'; weekday: number; time: string }
  | { kind: 'date'; year?: number; month: number; day: number; time: string }

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function localDayStart(ms: number): number {
  const date = new Date(ms)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/** 把一个时刻拆成「今天 / 昨天 / 星期几 / 日期」再交给界面拼文案。 */
export function chatTimeParts(ts: number, now: number): ChatTimeParts {
  const date = new Date(ts)
  const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  const dayDiff = Math.round((localDayStart(now) - localDayStart(ts)) / 86_400_000)
  if (dayDiff <= 0) return { kind: 'clock', time }
  if (dayDiff === 1) return { kind: 'yesterday', time }
  if (dayDiff > 1 && dayDiff < 7) return { kind: 'weekday', weekday: date.getDay(), time }
  const nowDate = new Date(now)
  const sameYear = date.getFullYear() === nowDate.getFullYear()
  return {
    kind: 'date',
    year: sameYear ? undefined : date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
    time,
  }
}
