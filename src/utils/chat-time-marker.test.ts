import { describe, expect, it } from 'vitest'
import { chatTimeParts, withChatTimeMarkers, type ChatSpeechItem } from './chat-time-marker'

const MIN = 60 * 1000

function speech(id: string, type: string, extra: Partial<ChatSpeechItem> = {}): ChatSpeechItem {
  return { id, type, ...extra }
}

describe('withChatTimeMarkers', () => {
  const steps = [
    { id: 'u1', type: 'user_task', timestamp: 0 },
    { id: 'm1', type: 'message', timestamp: 30 * 1000 },
    { id: 'tool', type: 'tool_call', timestamp: 2 * MIN },
    { id: 'm2', type: 'message', timestamp: 8 * MIN },
    { id: 'u2', type: 'user_task', timestamp: 70 * MIN },
    { id: 'notice', type: 'proactive_notice', timestamp: 80 * MIN },
    { id: 'p-user', type: 'user_task', timestamp: 90 * MIN },
    { id: 'p-final', type: 'final_result', timestamp: 91 * MIN },
  ]

  const items: ChatSpeechItem[] = [
    speech('user_u1', 'user_task', { group: { id: 'u1' } }),
    speech('fold1', 'folded_turn'),
    speech('m1', 'step', { step: { type: 'message', timestamp: 30 * 1000 }, part: 'body' }),
    speech('m1t', 'step', { step: { type: 'message', timestamp: 20 * 1000 }, part: 'thinking' }),
    speech('tool', 'step', { step: { type: 'tool_call', timestamp: 2 * MIN } }),
    speech('m2', 'step', { step: { type: 'message', timestamp: 8 * MIN }, part: 'full' }),
    speech('user_u2', 'user_task', { group: { id: 'u2' } }),
    speech('notice', 'proactive_notice', { step: { type: 'proactive_notice', timestamp: 80 * MIN } }),
    speech('proactive_p-user', 'proactive_message', { group: { id: 'p-user' } }),
  ]

  it('marks the first spoken line, then only after a five-minute gap', () => {
    const marked = withChatTimeMarkers(items, steps)
    const markers = marked.filter(item => item.type === 'time_marker')
    expect(markers.map(item => item.timestamp)).toEqual([0, 8 * MIN, 70 * MIN, 80 * MIN, 91 * MIN])
    expect(marked[0]).toMatchObject({ type: 'time_marker', id: 'time_user_u1' })
    expect(marked.find(item => item.id === 'm1t')).toBeTruthy()
    expect(marked.some(item => item.id === 'time_m1t' || item.id === 'time_tool' || item.id === 'time_fold1')).toBe(false)
  })

  it('uses the moment a proactive message finished, not the placeholder in front of it', () => {
    const marked = withChatTimeMarkers(
      [speech('proactive_p-user', 'proactive_message', { group: { id: 'p-user' } })],
      steps,
    )
    expect(marked[0]).toMatchObject({ type: 'time_marker', timestamp: 91 * MIN })
  })
})

describe('chatTimeParts', () => {
  const now = new Date(2026, 9, 1, 12, 0).getTime()

  it('shows clock time for today, yesterday, weekday, then a date', () => {
    expect(chatTimeParts(new Date(2026, 9, 1, 20, 11).getTime(), now)).toEqual({
      kind: 'clock',
      time: '20:11',
    })
    expect(chatTimeParts(new Date(2026, 8, 30, 20, 11).getTime(), now)).toEqual({
      kind: 'yesterday',
      time: '20:11',
    })
    expect(chatTimeParts(new Date(2026, 8, 28, 20, 11).getTime(), now)).toEqual({
      kind: 'weekday',
      weekday: 1,
      time: '20:11',
    })
    expect(chatTimeParts(new Date(2026, 7, 1, 9, 5).getTime(), now)).toEqual({
      kind: 'date',
      month: 8,
      day: 1,
      time: '09:05',
    })
    expect(chatTimeParts(new Date(2025, 11, 31, 8, 0).getTime(), now)).toEqual({
      kind: 'date',
      year: 2025,
      month: 12,
      day: 31,
      time: '08:00',
    })
  })
})
