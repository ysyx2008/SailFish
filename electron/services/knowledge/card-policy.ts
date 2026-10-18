/**
 * 检索说明（卡片）的状态。队列就是「还没写好的那些文档」，不另建队列文件。
 */

import type { CardStatus } from './types'

export const CARD_DAILY_LIMIT = 20
export const CARD_TICK_LIMIT = 1
export const CARD_VECTOR_BACKFILL_PER_TICK = 5
export const CARD_SOURCE_CHARS = 12_000

export interface CardFields {
  cardStatus: CardStatus
  cardSummary?: string
  cardSourceHash?: string
  cardHumanEdited?: boolean
  cardTouchedAt?: number
  cardError?: string
}

export function clampCardSummary(raw: string): string {
  const one = raw.replace(/\s+/g, ' ').trim()
  if (!one) return ''
  return one.length <= 300 ? one : one.slice(0, 300)
}

export function initialCard(): CardFields {
  return { cardStatus: 'pending', cardHumanEdited: false }
}

export function resumeInterrupted(card: CardFields): CardFields {
  if (card.cardStatus !== 'generating') return card
  return { ...card, cardStatus: 'pending' }
}

/** 原文换版。人改过的说明留着，并标明脱节；没人改过的作废重写。 */
export function onContentReplaced(card: CardFields): CardFields {
  if (card.cardHumanEdited && card.cardSummary) {
    return { ...card, cardStatus: 'stale', cardError: undefined }
  }
  return {
    cardStatus: 'pending',
    cardHumanEdited: false,
    cardSummary: undefined,
    cardSourceHash: undefined,
    cardError: undefined,
    cardTouchedAt: card.cardTouchedAt,
  }
}

export function onGenerateStart(card: CardFields): CardFields {
  return { ...card, cardStatus: 'generating', cardError: undefined }
}

export function onGenerateFail(card: CardFields, error: string): CardFields {
  return { ...card, cardStatus: 'failed', cardError: error }
}

export function onGenerateSuccess(
  card: CardFields,
  summary: string,
  hashAtStart: string,
  hashNow: string
): CardFields {
  const text = clampCardSummary(summary)
  if (!text) return onGenerateFail(card, '说明是空的')
  if (hashAtStart !== hashNow || card.cardHumanEdited) {
    if (card.cardHumanEdited && card.cardSummary) {
      return { ...card, cardStatus: card.cardSourceHash && card.cardSourceHash !== hashNow ? 'stale' : 'ready' }
    }
    return { ...card, cardStatus: 'pending', cardError: undefined }
  }
  return {
    cardStatus: 'ready',
    cardSummary: text,
    cardSourceHash: hashNow,
    cardHumanEdited: false,
    cardError: undefined,
    cardTouchedAt: undefined,
  }
}

export function onHumanEdit(card: CardFields, summary: string, contentHash: string | undefined): CardFields {
  const text = clampCardSummary(summary)
  if (!text) return card
  if (!card.cardSourceHash && contentHash) {
    return {
      cardStatus: 'ready',
      cardSummary: text,
      cardSourceHash: contentHash,
      cardHumanEdited: true,
      cardError: undefined,
    }
  }
  const drifted = !!card.cardSourceHash && !!contentHash && card.cardSourceHash !== contentHash
  return {
    ...card,
    cardSummary: text,
    cardHumanEdited: true,
    cardStatus: drifted || card.cardStatus === 'stale' ? 'stale' : 'ready',
    cardError: undefined,
  }
}

/** 人确认：这份说明仍然对得上现在的原文。 */
export function onHumanConfirm(card: CardFields, contentHash: string): CardFields {
  return {
    ...card,
    cardStatus: 'ready',
    cardSourceHash: contentHash,
    cardHumanEdited: true,
    cardError: undefined,
  }
}

export interface QueueCandidate {
  id: string
  cardStatus: CardStatus
  cardTouchedAt?: number
  createdAt: number
}

export function pickNextCard(
  docs: QueueCandidate[],
  limits: { remainingToday: number; remainingThisTick: number }
): QueueCandidate | undefined {
  if (limits.remainingToday <= 0 || limits.remainingThisTick <= 0) return undefined
  const eligible = docs.filter(doc => doc.cardStatus === 'pending' || doc.cardStatus === 'failed')
  eligible.sort((a, b) => {
    const touched = (b.cardTouchedAt ?? 0) - (a.cardTouchedAt ?? 0)
    if (touched !== 0) return touched
    return a.createdAt - b.createdAt
  })
  return eligible[0]
}

export function buildCardPrompt(filename: string, folder: string, content: string): string {
  const truncated = content.length > CARD_SOURCE_CHARS
  const body = truncated ? content.slice(0, CARD_SOURCE_CHARS) : content
  const lines = [
    '下面是用户放进知识库的一份原文。写一段导航说明，用来以后按语意找回这份文件：它讲什么、适用于什么范围、有哪些关键概念和数字。',
    '保留原文里的专有名词。这段说明不能代替原文。不要加标题，一段话，三百字以内。',
    '',
    `文件名：${filename}`,
  ]
  if (folder) lines.push(`目录：${folder}`)
  if (truncated) lines.push('原文更长，这里只给出开头。')
  lines.push('', '原文：', body)
  return lines.join('\n')
}

export function isQuietHour(now: Date, quiet: { start: string; end: string } | null | undefined): boolean {
  if (!quiet?.start || !quiet?.end) return false
  const toMin = (value: string): number | null => {
    const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
    if (!match) return null
    const hour = Number(match[1])
    const minute = Number(match[2])
    if (hour > 23 || minute > 59) return null
    return hour * 60 + minute
  }
  const start = toMin(quiet.start)
  const end = toMin(quiet.end)
  if (start === null || end === null || start === end) return false
  const cur = now.getHours() * 60 + now.getMinutes()
  if (start < end) return cur >= start && cur < end
  return cur >= start || cur < end
}

export function dayKey(now: Date): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}
