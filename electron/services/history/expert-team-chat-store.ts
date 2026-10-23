/**
 * 专家团群聊全文：跟着会话存在历史目录里，一条一行追加，界面按位置翻页读。
 *
 * 布局 `<根>/<日期>/<会话>/<名字>.jsonl`，日期是开团那天，按天清理时跟会话记录一起过期。
 * 读的时候从给定位置按块往前或往后读，不把整个文件读进内存。
 */
import * as fs from 'fs'
import * as path from 'path'
import type { ExpertTeamChatCursor, ExpertTeamChatPage, ExpertTeamMessageView } from '@shared/types'
import { createLogger } from '../../utils/logger'
import { getDateString } from './date-util'
import { SessionDateTree, isSafePathSegment } from './session-date-tree'

const log = createLogger('ExpertTeamChat')

/** 一页最多这么多条、这么多字（至少一条） */
const PAGE_MAX_MESSAGES = 50
const PAGE_MAX_CHARS = 60000
/** 单条超过这么多字只给前面一段，全文在文件里 */
const MESSAGE_MAX_CHARS = 100000
const READ_CHUNK_BYTES = 64 * 1024
const NEWLINE = 0x0a
const CHAT_FILE = /^\d{4}-\d{2}-\d{2}\/[^/\\]+\/[^/\\]+\.jsonl$/

export class ExpertTeamChatStore {
  private readonly tree: SessionDateTree

  constructor(private readonly root: string) {
    this.tree = new SessionDateTree(root)
  }

  /** 给这场会话新开一份群聊文件，返回相对位置；会话号或名字不能当路径用时不开 */
  create(sessionId: string, name: string, at = Date.now()): string | undefined {
    if (!isSafePathSegment(sessionId) || !isSafePathSegment(name)) return undefined
    return `${getDateString(at)}/${sessionId}/${name}.jsonl`
  }

  append(file: string, messages: ExpertTeamMessageView[]): boolean {
    const abs = this.resolve(file)
    if (!abs || messages.length === 0) return false
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      const lines = messages.map(m => JSON.stringify(toLine(m)) + '\n').join('')
      fs.appendFileSync(abs, (endsMidLine(abs) ? '\n' : '') + lines, 'utf-8')
      return true
    } catch (err) {
      log.warn(`Expert team chat append failed (${abs}): ${err}`)
      return false
    }
  }

  read(file: string, cursor: ExpertTeamChatCursor = {}): ExpertTeamChatPage | null {
    const abs = this.resolve(file)
    if (!abs) return null
    let fd: number
    try {
      fd = fs.openSync(abs, 'r')
    } catch {
      return null
    }
    try {
      const size = fs.fstatSync(fd).size
      const page = cursor.after !== undefined
        ? readForward(fd, size, clampOffset(cursor.after, size))
        : readBackward(fd, lineBoundaryAtOrBefore(fd, clampOffset(cursor.before ?? size, size)))
      return { ...page, path: abs }
    } catch (err) {
      log.warn(`Expert team chat read failed (${abs}): ${err}`)
      return null
    } finally {
      fs.closeSync(fd)
    }
  }

  deleteSession(sessionId: string): void {
    this.tree.deleteSession(sessionId)
  }

  /** 删掉开团日期早于 cutoff（YYYY-MM-DD）的 */
  deleteBefore(cutoff: string): void {
    this.tree.deleteBefore(cutoff)
  }

  /** 删掉会话已经不在的群聊；会话可能很早开、近几天才开团，记录先按天清掉，群聊要靠这一步跟上 */
  deleteOrphans(liveSessionIds: ReadonlySet<string>, now = Date.now()): void {
    this.tree.deleteOrphans(liveSessionIds, now)
  }

  deleteAll(): void {
    this.tree.deleteAll()
  }

  private resolve(file: string): string | undefined {
    if (typeof file !== 'string' || !CHAT_FILE.test(file)) return undefined
    const abs = path.resolve(this.root, file)
    return abs.startsWith(path.resolve(this.root) + path.sep) ? abs : undefined
  }
}

type PageBody = Omit<ExpertTeamChatPage, 'path'>

function toLine(m: ExpertTeamMessageView): ExpertTeamMessageView {
  return { seq: m.seq, from: m.from, to: [...m.to], text: m.text, at: m.at }
}

function clampOffset(value: number, size: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(Math.floor(value), size)) : size
}

function parseLine(bytes: Buffer): ExpertTeamMessageView | null {
  let m: Partial<ExpertTeamMessageView>
  try {
    m = JSON.parse(bytes.toString('utf-8'))
  } catch {
    return null
  }
  if (typeof m?.seq !== 'number' || typeof m.from !== 'string' || typeof m.text !== 'string') return null
  const base = {
    seq: m.seq,
    from: m.from,
    to: Array.isArray(m.to) ? m.to.filter((n): n is string => typeof n === 'string') : [],
    at: typeof m.at === 'number' ? m.at : 0,
  }
  if (m.text.length <= MESSAGE_MAX_CHARS) return { ...base, text: m.text }
  let cut = MESSAGE_MAX_CHARS
  const code = m.text.charCodeAt(cut - 1)
  if (code >= 0xd800 && code <= 0xdbff) cut--
  return { ...base, text: m.text.slice(0, cut), omitted: m.text.length - cut }
}

/** 上次写到一半断了（文件不以换行结尾） */
function endsMidLine(abs: string): boolean {
  let fd: number | undefined
  try {
    fd = fs.openSync(abs, 'r')
    const size = fs.fstatSync(fd).size
    if (size === 0) return false
    const last = Buffer.alloc(1)
    fs.readSync(fd, last, 0, 1, size - 1)
    return last[0] !== NEWLINE
  } catch {
    return false
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

/** 往前读时一次读多少：至少一块，已经攒下的越多读得越多，超长的一行不至于反复拷贝 */
function chunkSize(held: number, room: number): number {
  return Math.min(Math.max(READ_CHUNK_BYTES, held), room)
}

/** 这一页再装一条会不会超；一条都没有时总能装 */
function full(count: number, chars: number, next: number): boolean {
  return count > 0 && (count >= PAGE_MAX_MESSAGES || chars + next > PAGE_MAX_CHARS)
}

/** 从 end 往前读一页；end 落在行尾或文件尾 */
function readBackward(fd: number, end: number): PageBody {
  const picked: ExpertTeamMessageView[] = []
  let chars = 0
  /** data 是文件 [pos, cut) 这一段 */
  let data = Buffer.alloc(0)
  let pos = end
  let cut = end

  while (cut > 0) {
    const lineEnd = () => (cut > pos && data[cut - 1 - pos] === NEWLINE ? cut - 1 : cut)
    let nl = -1
    for (;;) {
      if (pos < cut) {
        const from = lineEnd() - 1 - pos
        nl = from >= 0 ? data.lastIndexOf(NEWLINE, from) : -1
        if (nl >= 0 || pos === 0) break
      }
      const n = chunkSize(data.length, pos)
      const chunk = Buffer.alloc(n)
      fs.readSync(fd, chunk, 0, n, pos - n)
      data = Buffer.concat([chunk, data])
      pos -= n
    }
    const start = nl >= 0 ? pos + nl + 1 : 0
    const message = parseLine(data.subarray(start - pos, lineEnd() - pos))
    // 写断后重写过的同一批会重复，往前读 seq 只该越来越小
    const repeated = message && picked.length > 0 && message.seq >= picked[picked.length - 1].seq
    if (message && !repeated) {
      if (full(picked.length, chars, message.text.length)) break
      picked.push(message)
      chars += message.text.length
    }
    cut = start
    data = data.subarray(0, cut - pos)
  }

  return { messages: picked.reverse(), start: cut, end, hasEarlier: cut > 0, hasLater: false }
}

/** 从 start 往后读一页，只要以换行结束的整行 */
function readForward(fd: number, size: number, start: number): PageBody {
  const picked: ExpertTeamMessageView[] = []
  let chars = 0
  let data = Buffer.alloc(0)
  let pos = start
  let cut = start

  outer:
  while (cut < size) {
    let nl = data.indexOf(NEWLINE)
    while (nl < 0) {
      if (pos >= size) break outer
      const n = chunkSize(data.length, size - pos)
      const chunk = Buffer.alloc(n)
      fs.readSync(fd, chunk, 0, n, pos)
      pos += n
      data = Buffer.concat([data, chunk])
      nl = data.indexOf(NEWLINE)
    }
    const message = parseLine(data.subarray(0, nl))
    const repeated = message && picked.length > 0 && message.seq <= picked[picked.length - 1].seq
    if (message && !repeated) {
      if (full(picked.length, chars, message.text.length)) break
      picked.push(message)
      chars += message.text.length
    }
    cut += nl + 1
    data = data.subarray(nl + 1)
  }

  return { messages: picked, start, end: cut, hasEarlier: start > 0, hasLater: hasCompleteLine(fd, size, cut) }
}

/** offset 不在行首时（末尾一行还没写完）退到上一个换行之后 */
function lineBoundaryAtOrBefore(fd: number, offset: number): number {
  const chunk = Buffer.alloc(READ_CHUNK_BYTES)
  for (let end = offset; end > 0;) {
    const n = Math.min(READ_CHUNK_BYTES, end)
    fs.readSync(fd, chunk, 0, n, end - n)
    if (end === offset && chunk[n - 1] === NEWLINE) return offset
    const nl = chunk.subarray(0, n).lastIndexOf(NEWLINE)
    if (nl >= 0) return end - n + nl + 1
    end -= n
  }
  return 0
}

function hasCompleteLine(fd: number, size: number, from: number): boolean {
  if (from >= size) return false
  const chunk = Buffer.alloc(Math.min(READ_CHUNK_BYTES, size - from))
  for (let pos = from; pos < size; pos += chunk.length) {
    const n = fs.readSync(fd, chunk, 0, Math.min(chunk.length, size - pos), pos)
    if (chunk.subarray(0, n).includes(NEWLINE)) return true
  }
  return false
}
