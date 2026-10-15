/**
 * 用户话里提到的联系人：认出来，写成名片附给模型。
 * 只比对用户记下的姓名、简称、邮箱、电话，不按意思猜。
 */
import type { Contact, ContactChannel } from '@sailfish/shared-types'
import type { UserMessageNoteContext } from '../types'
import { normalizeChannelValue, normalizeContactKey } from './store'

export const MAX_MENTION_CARDS = 5
const NOTE_PREVIEW_CHARS = 120
/** 一个字太容易落在别的词里 */
const MIN_NAME_CHARS = 2
const MIN_PHONE_DIGITS = 7
/** 带不带国家码都认：两边都够长、只差国家码那几位时比后 11 位 */
const PHONE_TAIL_DIGITS = 11
const MAX_COUNTRY_CODE_DIGITS = 3

const ASCII_ONLY = /^[ -~]+$/
const WORD_CHAR = /[a-z0-9]/
const EMAIL_CHAR = /[a-z0-9._%+-]/
/** 号码可以用空格、横线分段，但不跨行 */
const PHONE_RUN = /\+?\d[\d \t-]{5,}\d/g

interface Span {
  start: number
  end: number
  contactId: string
}

function occurrences(haystack: string, needle: string): number[] {
  const found: number[] = []
  if (!needle) return found
  let from = 0
  for (;;) {
    const index = haystack.indexOf(needle, from)
    if (index < 0) return found
    found.push(index)
    from = index + 1
  }
}

function isWordBounded(text: string, start: number, end: number): boolean {
  return !WORD_CHAR.test(text[start - 1] ?? '') && !WORD_CHAR.test(text[end] ?? '')
}

/** 句末的点不算邮箱的一部分；点后面还接着字母数字才算 */
function isEmailBounded(text: string, start: number, end: number): boolean {
  if (EMAIL_CHAR.test(text[start - 1] ?? '')) return false
  const after = text[end] ?? ''
  if (after === '.') return !WORD_CHAR.test(text[end + 1] ?? '')
  return !EMAIL_CHAR.test(after)
}

function digitsOf(value: string): string {
  return value.replace(/\D/g, '')
}

function samePhone(a: string, b: string): boolean {
  if (a === b) return true
  return a.length >= PHONE_TAIL_DIGITS && b.length >= PHONE_TAIL_DIGITS
    && Math.abs(a.length - b.length) <= MAX_COUNTRY_CODE_DIGITS
    && a.slice(-PHONE_TAIL_DIGITS) === b.slice(-PHONE_TAIL_DIGITS)
}

function nameSpans(contact: Contact, text: string): Span[] {
  const keys = new Set([contact.name, ...(contact.aliases ?? [])].map(normalizeContactKey))
  const spans: Span[] = []
  for (const key of keys) {
    if ([...key].length < MIN_NAME_CHARS) continue
    const ascii = ASCII_ONLY.test(key)
    for (const start of occurrences(text, key)) {
      const end = start + key.length
      if (ascii && !isWordBounded(text, start, end)) continue
      spans.push({ start, end, contactId: contact.id })
    }
  }
  return spans
}

function emailSpans(contact: Contact, text: string): Span[] {
  const spans: Span[] = []
  for (const channel of contact.channels ?? []) {
    if (channel.kind !== 'email') continue
    const email = normalizeChannelValue('email', channel.value)
    if (!email) continue
    for (const start of occurrences(text, email)) {
      const end = start + email.length
      if (isEmailBounded(text, start, end)) spans.push({ start, end, contactId: contact.id })
    }
  }
  return spans
}

function phoneSpans(contacts: Contact[], text: string): Span[] {
  const phones: Array<{ contactId: string, digits: string }> = []
  for (const contact of contacts) {
    for (const channel of contact.channels ?? []) {
      if (channel.kind !== 'phone') continue
      const digits = digitsOf(channel.value)
      if (digits.length >= MIN_PHONE_DIGITS) phones.push({ contactId: contact.id, digits })
    }
  }
  if (phones.length === 0) return []
  const spans: Span[] = []
  for (const match of text.matchAll(PHONE_RUN)) {
    const digits = digitsOf(match[0])
    if (digits.length < MIN_PHONE_DIGITS) continue
    const start = match.index ?? 0
    for (const phone of phones) {
      if (samePhone(digits, phone.digits)) spans.push({ start, end: start + match[0].length, contactId: phone.contactId })
    }
  }
  return spans
}

/**
 * 整段落在更长一段里面的不算：「沈义君」认出来了，里面的「义君」不再单算。
 * 只是交叠（「张伟明」里的「张伟」和「伟明」）、或同一段对上几个人（同名），都算——分不清就都带上。
 */
function resolveOverlaps(spans: Span[]): Span[] {
  const length = (span: Span) => span.end - span.start
  return spans.filter(span => !spans.some(other =>
    other.start <= span.start && span.end <= other.end && length(other) > length(span)))
}

/** 按在话里第一次出现的先后排 */
export function findMentionedContacts(contacts: Contact[], text: string): Contact[] {
  const lower = text.toLowerCase()
  const spans = resolveOverlaps([
    ...contacts.flatMap(contact => [...nameSpans(contact, lower), ...emailSpans(contact, lower)]),
    ...phoneSpans(contacts, lower),
  ])
  const firstSeen = new Map<string, number>()
  for (const span of spans) {
    const seen = firstSeen.get(span.contactId)
    if (seen === undefined || span.start < seen) firstSeen.set(span.contactId, span.start)
  }
  const byId = new Map(contacts.map(contact => [contact.id, contact]))
  return [...firstSeen.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([id]) => byId.get(id))
    .filter((contact): contact is Contact => !!contact)
}

function channelText(channel: ContactChannel): string {
  const label = channel.label ? `（${channel.label}）` : ''
  if (channel.kind === 'email') return `邮箱 ${channel.value}${label}`
  if (channel.kind === 'phone') return `电话 ${channel.value}${label}`
  return `${channel.platform || '即时通讯'} ${channel.value}${label}`
}

function notePreview(note: string): string {
  const oneLine = note.replace(/\s+/g, ' ').trim()
  const chars = [...oneLine]
  return chars.length > NOTE_PREVIEW_CHARS ? `${chars.slice(0, NOTE_PREVIEW_CHARS).join('')}……` : oneLine
}

/** 同一个人、信息没变时写出来一字不差，用来判断这场里是否已经带过 */
export function formatMentionCard(contact: Contact): string {
  const parts = [[contact.kind === 'org' ? '机构' : '人', contact.organization, contact.role].filter(Boolean).join(' · ')]
  if (contact.address) parts.push(`地址：${contact.address}`)
  if (contact.aliases?.length) parts.push(`简称：${contact.aliases.join('、')}`)
  for (const channel of contact.channels ?? []) parts.push(channelText(channel))
  if (contact.note) parts.push(`备注：${notePreview(contact.note)}`)
  return `- ${contact.name}〔联系人 ${contact.id}〕${parts.join('；')}`
}

export function buildMentionNote(contacts: Contact[], text: string, ctx: UserMessageNoteContext): string | undefined {
  const fresh = findMentionedContacts(contacts, text)
    .map(contact => ({ contact, card: formatMentionCard(contact) }))
    .filter(item => !ctx.alreadyInConversation(item.card))
  if (fresh.length === 0) return undefined
  const shown = fresh.slice(0, MAX_MENTION_CARDS)
  const rest = [...new Set(fresh.slice(MAX_MENTION_CARDS).map(item => item.contact.name))]
  const lines = ['这句话里出现的名字或联系方式，联系人里记着：', ...shown.map(item => item.card)]
  if (rest.length) lines.push(`另外还提到：${rest.join('、')}（未展开，contact 技能里可查）`)
  return lines.join('\n')
}
