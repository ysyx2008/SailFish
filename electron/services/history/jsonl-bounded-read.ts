/**
 * 按行读 jsonl，超大行不装进内存、不 JSON.parse。
 * 只留开头/结尾预览，整场其余行照常解析。
 */
import * as fs from 'fs'
import type { HugeOutputStub } from '@shared/types'

// 派一大队人那一步（每人的任务、结果、最近几步 + 群聊）正常就有几百 KB，
// 上限太紧会把整步换成占位，卡片和群聊跟着丢；真正要挡的是几百 MB 的工具输出。
export const HUGE_JSONL_LINE_BYTES = 4 * 1024 * 1024
export const JSONL_PEEK_CHARS = 4096
export const HUGE_OUTPUT_PREVIEW_CHARS = 400

export type BoundedJsonlLine =
  | { kind: 'ok'; text: string }
  | { kind: 'huge'; bytes: number; head: string; tail: string }

export function createJsonlLineScanner(
  onLine: (line: BoundedJsonlLine, lineIndex: number) => void,
  maxBytes: number = HUGE_JSONL_LINE_BYTES,
): { feed: (chunk: string) => void; end: () => void } {
  let acc = ''
  let huge = false
  let bytes = 0
  let head = ''
  let tail = ''
  let lineIndex = 0

  const reset = () => {
    acc = ''
    huge = false
    bytes = 0
    head = ''
    tail = ''
  }

  const emit = () => {
    if (huge) {
      onLine({ kind: 'huge', bytes, head, tail }, lineIndex++)
    } else if (acc.length > 0) {
      onLine({ kind: 'ok', text: acc }, lineIndex++)
    }
    reset()
  }

  const absorb = (part: string) => {
    if (!part) return
    if (!huge) {
      acc += part
      const n = Buffer.byteLength(acc, 'utf8')
      if (n > maxBytes) {
        huge = true
        bytes = n
        head = acc.slice(0, JSONL_PEEK_CHARS)
        tail = acc.slice(-JSONL_PEEK_CHARS)
        acc = ''
      }
    } else {
      bytes += Buffer.byteLength(part, 'utf8')
      tail = (tail + part).slice(-JSONL_PEEK_CHARS)
    }
  }

  const feed = (chunk: string) => {
    let start = 0
    for (let i = 0; i < chunk.length; i++) {
      if (chunk.charCodeAt(i) === 10) {
        absorb(chunk.slice(start, i))
        emit()
        start = i + 1
      }
    }
    absorb(chunk.slice(start))
  }

  const end = () => {
    if (huge || acc.length > 0) emit()
  }

  return { feed, end }
}

export function forEachBoundedJsonlLineSync(
  filePath: string,
  onLine: (line: BoundedJsonlLine, lineIndex: number) => void,
  maxBytes: number = HUGE_JSONL_LINE_BYTES,
): void {
  const fd = fs.openSync(filePath, 'r')
  const scanner = createJsonlLineScanner(onLine, maxBytes)
  try {
    const buf = Buffer.alloc(64 * 1024)
    const decoder = new TextDecoder('utf-8')
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null)
      if (n === 0) {
        scanner.feed(decoder.decode())
        break
      }
      scanner.feed(decoder.decode(buf.subarray(0, n), { stream: true }))
    }
    scanner.end()
  } finally {
    fs.closeSync(fd)
  }
}

export async function forEachBoundedJsonlLineAsync(
  filePath: string,
  onLine: (line: BoundedJsonlLine, lineIndex: number) => void,
  maxBytes: number = HUGE_JSONL_LINE_BYTES,
): Promise<void> {
  const stream = fs.createReadStream(filePath, { encoding: 'utf-8', highWaterMark: 64 * 1024 })
  const scanner = createJsonlLineScanner(onLine, maxBytes)
  try {
    for await (const chunk of stream) {
      scanner.feed(chunk as string)
    }
    scanner.end()
  } finally {
    stream.destroy()
  }
}

function unescapeJsonPreview(raw: string): string {
  return raw
    .replace(/\\u0000/g, '\0')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
}

function takePreview(text: string): string {
  const visible = text.replace(/\0/g, '')
  if (!visible.trim() && text.includes('\0')) return ''
  return visible.slice(0, HUGE_OUTPUT_PREVIEW_CHARS)
}

function payloadAfterKey(head: string, key: string): string | null {
  const needle = `"${key}":"`
  const idx = head.indexOf(needle)
  if (idx === -1) return null
  return unescapeJsonPreview(head.slice(idx + needle.length))
}

function payloadBeforeClose(tail: string): string {
  const quote = tail.lastIndexOf('"')
  const slice = quote === -1 ? tail : tail.slice(0, quote)
  return unescapeJsonPreview(slice)
}

export function previewHugeJsonlPayload(head: string, tail: string): { head: string; tail: string } {
  const rawHead = payloadAfterKey(head, 'toolResult')
    ?? payloadAfterKey(head, 'content')
    ?? unescapeJsonPreview(head)
  return {
    head: takePreview(rawHead),
    tail: takePreview(payloadBeforeClose(tail)),
  }
}

function matchJsonString(head: string, key: string): string | undefined {
  const re = new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`)
  const m = head.match(re)
  return m?.[1]
}

function matchJsonNumber(head: string, key: string): number | undefined {
  const re = new RegExp(`"${key}"\\s*:\\s*(-?\\d+)`)
  const m = head.match(re)
  return m ? Number(m[1]) : undefined
}

export function stubHugeJsonlLine(
  huge: { bytes: number; head: string; tail: string },
  filePath: string,
  lineIndex: number,
): Record<string, unknown> {
  const preview = previewHugeJsonlPayload(huge.head, huge.tail)
  const notice = `[omitted ${huge.bytes.toLocaleString()} bytes]`
  const stub: HugeOutputStub = {
    bytes: huge.bytes,
    skipped: true,
    head: preview.head || undefined,
    tail: preview.tail || undefined,
    sourceFile: filePath,
    sourceLine: lineIndex,
  }

  const role = matchJsonString(huge.head, 'role')
  if (role) {
    return {
      role,
      content: notice,
      tool_call_id: matchJsonString(huge.head, 'tool_call_id'),
      hugeOutput: stub,
    }
  }

  return {
    id: matchJsonString(huge.head, 'id') || `huge-line-${lineIndex}`,
    type: matchJsonString(huge.head, 'type') || 'tool_result',
    content: matchJsonString(huge.head, 'content') || notice,
    toolName: matchJsonString(huge.head, 'toolName'),
    toolCallId: matchJsonString(huge.head, 'toolCallId'),
    timestamp: matchJsonNumber(huge.head, 'timestamp') || 0,
    success: true,
    toolResult: notice,
    hugeOutput: stub,
  }
}

/**
 * 把指定行流式拷到 dest，不把整行装进内存。
 */
export async function exportJsonlLineToFile(
  filePath: string,
  lineIndex: number,
  destPath: string,
): Promise<{ bytes: number }> {
  const stream = fs.createReadStream(filePath, { encoding: 'utf-8', highWaterMark: 64 * 1024 })
  const out = fs.createWriteStream(destPath)
  let current = 0
  let bytes = 0
  let copying = lineIndex === 0
  try {
    for await (const chunk of stream) {
      const text = chunk as string
      let start = 0
      for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) === 10) {
          if (copying) {
            const piece = text.slice(start, i)
            if (piece) {
              bytes += Buffer.byteLength(piece, 'utf8')
              if (!out.write(piece)) await waitDrain(out)
            }
            return { bytes }
          }
          current++
          start = i + 1
          copying = current === lineIndex
        }
      }
      const rest = text.slice(start)
      if (copying && rest) {
        bytes += Buffer.byteLength(rest, 'utf8')
        if (!out.write(rest)) await waitDrain(out)
      }
    }
    if (copying) return { bytes }
    throw new Error(`jsonl line ${lineIndex} not found`)
  } finally {
    stream.destroy()
    await new Promise<void>((resolve, reject) => {
      out.end(() => resolve())
      out.on('error', reject)
    })
  }
}

function waitDrain(stream: fs.WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.once('drain', resolve)
    stream.once('error', reject)
  })
}
