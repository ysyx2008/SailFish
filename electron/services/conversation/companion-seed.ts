/**
 * 联络「从这里创建任务」的 AI 挑选：把候选各段编号写成简述，交给模型挑相关的，
 * 再把模型回的序号还原成各段的 id。
 *
 * 只管「说明怎么写 / 回复怎么读」，不碰请求怎么发（缓存前缀、模型选择归 Agent）。
 * 设计目标见 SPEC.md「由 AI 挑相关的对话」。
 */
import { t } from '../agent/i18n'
import type { CompanionPickCandidate } from './conversation'
import { sanitizeConversationTitle } from './title-generator'

/** 单行简述里每句话最多保留的字数（按字符，不切坏 emoji） */
const BRIEF_TEXT_MAX_CHARS = 80
/** 只接受数字与分隔符的一行；这一行之外只允许再有一行标题 */
const STRICT_ORDINAL_REPLY = /^[\d\s,，、;；]+$/
/** 等待提示里只留思考过程的末尾这些字 */
const THINKING_PREVIEW_CHARS = 160
/** 思考增量交出的间隔；第一次不等 */
const THINKING_EMIT_INTERVAL_MS = 200

/** 思考过程可能很长，提示里只留最近一段（按字符，不切坏 emoji） */
export function thinkingPreview(text: string): string {
  const trimmed = text.replace(/\r/g, '').trimEnd()
  const chars = Array.from(trimmed)
  if (chars.length <= THINKING_PREVIEW_CHARS) return trimmed
  return '…' + chars.slice(-THINKING_PREVIEW_CHARS).join('')
}

/**
 * 把思考增量攒一攒再交出去：第一次立刻交，之后大约每 200ms 一次，结束时再交一次。
 * 交出的是末尾预览，不是全文。
 */
export function createThinkingFeed(emit: (preview: string) => void) {
  let buf = ''
  let timer: ReturnType<typeof setTimeout> | undefined
  let last = ''
  const flush = () => {
    const preview = thinkingPreview(buf)
    if (!preview || preview === last) return
    last = preview
    emit(preview)
  }
  return {
    push(delta: string) {
      if (!delta) return
      buf += delta
      // 只要末尾预览。缓冲一直涨的话，每拍都把整段拆成字符数组
      if (buf.length > THINKING_PREVIEW_CHARS * 8) {
        buf = Array.from(buf).slice(-THINKING_PREVIEW_CHARS * 2).join('')
      }
      if (timer) return
      flush()
      timer = setTimeout(() => {
        timer = undefined
        flush()
      }, THINKING_EMIT_INTERVAL_MS)
    },
    flush() {
      if (timer) {
        clearTimeout(timer)
        timer = undefined
      }
      flush()
    }
  }
}

/** 挑选回复：要带上的各段，以及可选的侧栏短标题 */
export interface CompanionPickReply {
  stepIds: string[]
  title?: string
}

export class CompanionSeedPicker {
  /** 候选上限：取最靠近锚点的这些段，避免简述本身过长 */
  static readonly MAX_CANDIDATES = 60
  /** 已按时间升序编号（序号 = 下标 + 1），最后一项恒为锚点 */
  private readonly candidates: CompanionPickCandidate[]

  /** @param candidates 锚点之前的各段用户对话，按时间升序，最后一项是锚点 */
  constructor(candidates: CompanionPickCandidate[]) {
    this.candidates = candidates.slice(-CompanionSeedPicker.MAX_CANDIDATES)
  }

  /** 实际交给模型挑选的段数（超过上限时只算保留的） */
  get size(): number {
    return this.candidates.length
  }

  /** 追加在联络对话末尾（或单独发出）的挑选说明 */
  buildInstruction(): string {
    const anchor = this.candidates.length
    const list = this.candidates
      .map((c, i) => CompanionSeedPicker.formatLine(c, i + 1))
      .join('\n')
    return t('agent.companion_pick_prompt', { anchor, list })
  }

  /**
   * 把模型回复还原成被挑中各段的 id（按序号升序、去重），并取出侧栏短标题。
   * 段号占一行；标题另占一行。没有标题行时仍返回段号。
   * 段号和标题以外还有别的文字、或没有任何有效序号 → null（调用方回退时间窗口）。
   * 超出范围的序号忽略；锚点是否出现在回复里无所谓，抽取时锚点恒带。
   */
  parseReply(reply: string | null | undefined): CompanionPickReply | null {
    const text = reply?.trim()
    if (!text) return null
    const lines = text
      .replace(/\r/g, '')
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0 && !line.startsWith('```'))

    const ordinalLines: string[] = []
    const otherLines: string[] = []
    for (const line of lines) {
      if (STRICT_ORDINAL_REPLY.test(line)) ordinalLines.push(line)
      else otherLines.push(line)
    }
    if (ordinalLines.length === 0 || otherLines.length > 1) return null

    const ordinals = new Set<number>()
    for (const line of ordinalLines) {
      for (const token of line.split(/[\s,，、;；]+/)) {
        if (!token) continue
        const n = Number(token)
        if (Number.isInteger(n) && n >= 1 && n <= this.candidates.length) ordinals.add(n)
      }
    }
    if (ordinals.size === 0) return null

    const stepIds = [...ordinals].sort((a, b) => a - b).map(n => this.candidates[n - 1].stepId)
    const title = otherLines.length === 1 ? sanitizeConversationTitle(otherLines[0]) ?? undefined : undefined
    return title ? { stepIds, title } : { stepIds }
  }

  private static formatLine(c: CompanionPickCandidate, n: number): string {
    const user = CompanionSeedPicker.oneLine(c.userText)
    const result = CompanionSeedPicker.oneLine(c.resultText)
    const params = { n, time: CompanionSeedPicker.formatTime(c.timestamp), user, result }
    return result
      ? t('agent.companion_pick_line_result', params)
      : t('agent.companion_pick_line', params)
  }

  private static oneLine(text: string): string {
    const flat = text.replace(/\s+/g, ' ').trim()
    const chars = Array.from(flat)
    return chars.length <= BRIEF_TEXT_MAX_CHARS ? flat : chars.slice(0, BRIEF_TEXT_MAX_CHARS).join('') + '…'
  }

  private static formatTime(timestamp: number): string {
    const d = new Date(timestamp)
    const pad = (v: number) => String(v).padStart(2, '0')
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  }
}
