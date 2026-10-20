/**
 * 同一屏：上面是这场对话，最后一行是输入。
 * 纯函数，不碰真正的终端。
 */

export const ENTER_SCREEN = '\x1b[?1049h\x1b[?25h\x1b[?2004h'
export const LEAVE_SCREEN = '\x1b[?2004l\x1b[?1049l\x1b[?25h'

export interface FrameInput {
  columns: number
  rows: number
  title: string
  body: string
  status: string
  prompt: string
  input: string
  /** 输入框里光标所在的字符位置 */
  cursor: number
  /** 0 是跟着最新一行；越大越往上翻 */
  scroll: number
  hidden?: boolean
}

export interface Composer {
  value: string
  cursor: number
  pending: string
  paste: boolean
  swallowLf: boolean
}

export type ComposerEvent =
  | { type: 'submit'; text: string }
  | { type: 'interrupt' }
  | { type: 'exit' }
  | { type: 'page'; dir: -1 | 1 }
  | { type: 'redraw' }

export function emptyComposer(): Composer {
  return { value: '', cursor: 0, pending: '', paste: false, swallowLf: false }
}

export function renderFrame(input: FrameInput): string {
  const lines = frameLines(input)
  const row = lines.length
  const promptWidth = visualWidth(input.prompt)
  const shown = input.hidden ? '•'.repeat(codePointCount(input.input)) : input.input
  const cursor = Math.max(0, Math.min(input.cursor, input.input.length))
  const room = Math.max(1, Math.max(20, input.columns) - promptWidth)
  const windowed = windowAround(shown, input.hidden ? codePointCount(input.input) : cursor, room)
  const col = promptWidth + visualWidth(windowed.text.slice(0, windowed.cursor)) + 1
  return `\x1b[H\x1b[2J${lines.join('\n')}\x1b[${row};${col}H`
}

export function frameLines(input: FrameInput): string[] {
  const cols = Math.max(20, input.columns || 80)
  const rows = Math.max(4, input.rows || 24)
  const title = clipVisual(input.title, cols)
  const status = clipVisual(input.status, cols)
  const prompt = input.prompt
  const shown = input.hidden ? '•'.repeat(codePointCount(input.input)) : input.input
  const cursor = input.hidden ? shown.length : input.cursor
  const room = Math.max(1, cols - visualWidth(prompt))
  const windowed = windowAround(shown, cursor, room)
  const inputLine = prompt + windowed.text
  const bodyRows = rows - 3
  const wrapped = wrapText(input.body, cols)
  const maxScroll = Math.max(0, wrapped.length - bodyRows)
  const scroll = Math.max(0, Math.min(input.scroll, maxScroll))
  const end = wrapped.length - scroll
  const start = Math.max(0, end - bodyRows)
  const slice = wrapped.slice(start, end)
  while (slice.length < bodyRows) slice.unshift('')
  return [`\x1b[1m${title}\x1b[0m`, ...slice, status ? `\x1b[2m${status}\x1b[0m` : '', inputLine]
}

/** 活动行用回车盖掉上一行。收成普通的一行行文字。 */
export function flattenTerminalText(raw: string): string {
  const lines = ['']
  let i = 0
  while (i < raw.length) {
    if (raw.startsWith('\r\x1b[K', i)) {
      lines[lines.length - 1] = ''
      i += 4
      continue
    }
    const ch = raw[i]
    if (ch === '\n') {
      lines.push('')
      i++
      continue
    }
    if (ch === '\r') {
      lines[lines.length - 1] = ''
      i++
      continue
    }
    lines[lines.length - 1] += ch
    i++
  }
  return lines.join('\n')
}

export function feedComposer(state: Composer, chunk: string): { state: Composer; events: ComposerEvent[] } {
  const events: ComposerEvent[] = []
  let { value, cursor, pending, paste, swallowLf } = state
  const data = pending + chunk
  pending = ''

  const insert = (text: string) => {
    if (!text) return
    value = value.slice(0, cursor) + text + value.slice(cursor)
    cursor += text.length
  }

  let i = 0
  while (i < data.length) {
    if (swallowLf) {
      swallowLf = false
      if (data[i] === '\n') {
        i++
        continue
      }
    }

    if (paste) {
      if (data[i] === '\x03') {
        events.push({ type: 'interrupt' })
        i++
        continue
      }
      const end = data.indexOf('\x1b[201~', i)
      if (end === -1) {
        const hold = suffixPrefix(data.slice(i), '\x1b[201~')
        insert(data.slice(i, data.length - hold).replace(/[\r\n]/g, ' '))
        pending = data.slice(data.length - hold)
        break
      }
      insert(data.slice(i, end).replace(/[\r\n]/g, ' '))
      i = end + '\x1b[201~'.length
      paste = false
      continue
    }

    const ch = data[i]
    if (ch === '\x03') {
      events.push({ type: 'interrupt' })
      i++
      continue
    }
    if (ch === '\x04') {
      events.push({ type: 'exit' })
      i++
      continue
    }
    if (ch === '\r') {
      events.push({ type: 'submit', text: value })
      value = ''
      cursor = 0
      swallowLf = true
      i++
      continue
    }
    if (ch === '\n') {
      events.push({ type: 'submit', text: value })
      value = ''
      cursor = 0
      i++
      continue
    }
    if (ch === '\x7f' || ch === '\x08') {
      const next = stepBack(value, cursor)
      value = value.slice(0, next) + value.slice(cursor)
      cursor = next
      i++
      continue
    }
    if (ch === '\x15') {
      value = ''
      cursor = 0
      i++
      continue
    }
    if (ch === '\x01') {
      cursor = 0
      i++
      continue
    }
    if (ch === '\x05') {
      cursor = value.length
      i++
      continue
    }
    if (ch === '\x17') {
      const before = value.slice(0, cursor).replace(/\s*\S+\s*$/, '')
      value = before + value.slice(cursor)
      cursor = before.length
      i++
      continue
    }
    if (ch === '\x1b') {
      const taken = takeControl(data, i)
      if (taken === 'partial') {
        pending = data.slice(i)
        break
      }
      if (!taken) {
        i++
        continue
      }
      i += taken.length
      if (taken.name === 'left') cursor = stepBack(value, cursor)
      else if (taken.name === 'right') cursor = stepForward(value, cursor)
      else if (taken.name === 'home') cursor = 0
      else if (taken.name === 'end') cursor = value.length
      else if (taken.name === 'delete') {
        const next = stepForward(value, cursor)
        value = value.slice(0, cursor) + value.slice(next)
      } else if (taken.name === 'page-up') events.push({ type: 'page', dir: 1 })
      else if (taken.name === 'page-down') events.push({ type: 'page', dir: -1 })
      else if (taken.name === 'paste-start') paste = true
      continue
    }
    if (ch < ' ') {
      i++
      continue
    }
    const cp = data.codePointAt(i)!
    const size = cp > 0xffff ? 2 : 1
    insert(data.slice(i, i + size))
    i += size
  }

  events.push({ type: 'redraw' })
  return { state: { value, cursor, pending, paste, swallowLf }, events }
}

export function visualWidth(text: string): number {
  const plain = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
  let width = 0
  for (const ch of plain) width += widthOf(ch.codePointAt(0)!)
  return width
}

export function clipVisual(text: string, cols: number): string {
  if (cols < 1) return ''
  let width = 0
  let end = 0
  const plain = text
  for (const ch of plain) {
    const w = widthOf(ch.codePointAt(0)!)
    if (width + w > cols) return plain.slice(0, end)
    width += w
    end += ch.length
  }
  return plain
}

function wrapText(body: string, cols: number): string[] {
  if (!body) return []
  const out: string[] = []
  for (const line of body.split('\n')) out.push(...wrapLine(line, cols))
  return out
}

function wrapLine(line: string, cols: number): string[] {
  if (!line) return ['']
  const out: string[] = []
  let current = ''
  let width = 0
  let i = 0
  while (i < line.length) {
    if (line[i] === '\x1b') {
      const mark = /^\x1b\[[0-9;]*[A-Za-z]/.exec(line.slice(i))
      if (mark) {
        current += mark[0]
        i += mark[0].length
        continue
      }
    }
    const cp = line.codePointAt(i)!
    const len = cp > 0xffff ? 2 : 1
    const w = widthOf(cp)
    if (width + w > cols && current) {
      out.push(current)
      current = ''
      width = 0
    }
    current += line.slice(i, i + len)
    width += w
    i += len
  }
  out.push(current)
  return out
}

function windowAround(text: string, cursor: number, room: number): { text: string; cursor: number } {
  const point = Math.max(0, Math.min(cursor, text.length))
  if (visualWidth(text) <= room) return { text, cursor: point }
  let start = point
  let width = 0
  while (start > 0 && width < room) {
    const prev = stepBack(text, start)
    const w = visualWidth(text.slice(prev, start))
    if (width + w > room) break
    width += w
    start = prev
  }
  let end = point
  while (end < text.length && width < room) {
    const next = stepForward(text, end)
    const w = visualWidth(text.slice(end, next))
    if (width + w > room) break
    width += w
    end = next
  }
  return { text: text.slice(start, end), cursor: point - start }
}

function widthOf(cp: number): number {
  if (cp < 0x20 || cp === 0x7f) return 0
  if (
    (cp >= 0x1100 && cp <= 0x115f)
    || (cp >= 0x2e80 && cp <= 0xa4cf)
    || (cp >= 0xac00 && cp <= 0xd7a3)
    || (cp >= 0xf900 && cp <= 0xfaff)
    || (cp >= 0xfe10 && cp <= 0xfe6f)
    || (cp >= 0xff01 && cp <= 0xff60)
    || (cp >= 0xffe0 && cp <= 0xffe6)
  ) return 2
  return 1
}

function codePointCount(text: string): number {
  return [...text].length
}

function stepBack(text: string, index: number): number {
  if (index <= 0) return 0
  const prev = index - 1
  const code = text.charCodeAt(prev)
  if (code >= 0xdc00 && code <= 0xdfff && index >= 2) return index - 2
  return index - 1
}

function stepForward(text: string, index: number): number {
  if (index >= text.length) return text.length
  const code = text.charCodeAt(index)
  if (code >= 0xd800 && code <= 0xdbff) return Math.min(text.length, index + 2)
  return index + 1
}

function suffixPrefix(text: string, needle: string): number {
  const max = Math.min(text.length, needle.length - 1)
  for (let n = max; n > 0; n--) {
    if (needle.startsWith(text.slice(text.length - n))) return n
  }
  return 0
}

function takeControl(data: string, index: number): { length: number; name: string } | 'partial' | null {
  if (data[index] !== '\x1b') return null
  const rest = data.slice(index)
  if (rest.length === 1) return 'partial'
  if (rest[1] === 'O') {
    if (rest.length < 3) return 'partial'
    return { length: 3, name: arrowName(rest[2]) }
  }
  if (rest[1] !== '[') return { length: 2, name: 'ignore' }
  let j = 2
  while (j < rest.length && j < 24) {
    const code = rest.charCodeAt(j)
    if (code >= 0x40 && code <= 0x7e) {
      return { length: j + 1, name: csiName(rest.slice(0, j + 1)) }
    }
    j++
  }
  if (j >= 24) return { length: 1, name: 'ignore' }
  return 'partial'
}

function arrowName(key: string): string {
  if (key === 'D') return 'left'
  if (key === 'C') return 'right'
  if (key === 'H') return 'home'
  if (key === 'F') return 'end'
  return 'ignore'
}

function csiName(seq: string): string {
  if (seq === '\x1b[200~') return 'paste-start'
  if (seq === '\x1b[201~') return 'paste-end'
  if (seq === '\x1b[D' || seq === '\x1b[1D') return 'left'
  if (seq === '\x1b[C' || seq === '\x1b[1C') return 'right'
  if (seq === '\x1b[H' || seq === '\x1b[1~' || seq === '\x1b[7~') return 'home'
  if (seq === '\x1b[F' || seq === '\x1b[4~' || seq === '\x1b[8~') return 'end'
  if (seq === '\x1b[3~') return 'delete'
  if (seq === '\x1b[5~') return 'page-up'
  if (seq === '\x1b[6~') return 'page-down'
  return 'ignore'
}
