import { describe, expect, it, vi } from 'vitest'

vi.mock('../config.service', () => ({
  getConfigService: () => ({
    get: () => undefined,
    set: () => {}
  }),
  ConfigService: class {}
}))

vi.mock('../ai-debug.service', () => ({
  getAiDebugService: () => ({
    logRequestStart: () => {},
    logResponseChunk: () => {},
    logResponseDone: () => {},
    logResponseError: () => {}
  })
}))

vi.mock('../agent/i18n', () => ({
  t: (key: string) => key
}))

vi.mock('../../utils/logger', () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {}
  })
}))

import { createUtf8ChunkDecoder, pushUtf8Lines } from '../ai.service'

const SAMPLE = '技能更新会把整段中文一次性交出去，不能在字中间切开。'

/** 与流式收包相同：只取出已经换行的行，末尾残行不补。 */
function takeCompleteLines(chunks: Buffer[]): string[] {
  const utf8 = createUtf8ChunkDecoder()
  let pending = ''
  const lines: string[] = []
  for (const chunk of chunks) {
    const next = pushUtf8Lines(utf8, pending, chunk)
    pending = next.pending
    lines.push(...next.lines)
  }
  return lines
}

describe('createUtf8ChunkDecoder', () => {
  it('汉字被切在两段数据中间时仍能拼回原文', () => {
    const buf = Buffer.from(SAMPLE, 'utf8')
    for (let splitAt = 1; splitAt < buf.length; splitAt++) {
      const utf8 = createUtf8ChunkDecoder()
      const text = utf8.push(buf.subarray(0, splitAt)) + utf8.push(buf.subarray(splitAt)) + utf8.end()
      expect(text).toBe(SAMPLE)
      expect(text.includes('\uFFFD')).toBe(false)
    }
  })

  it('直接 toString 会把切开口的字换成替换符，作为对照', () => {
    const buf = Buffer.from('段', 'utf8')
    const naive = buf.subarray(0, 1).toString() + buf.subarray(1).toString()
    expect(naive.includes('\uFFFD')).toBe(true)

    const utf8 = createUtf8ChunkDecoder()
    const text = utf8.push(buf.subarray(0, 1)) + utf8.push(buf.subarray(1)) + utf8.end()
    expect(text).toBe('段')
  })

  it('成行之后，行内中文被任意切开仍然完整', () => {
    const line = `data: ${JSON.stringify({ content: SAMPLE })}`
    const buf = Buffer.from(`${line}\n`, 'utf8')
    for (let splitAt = 1; splitAt < buf.length; splitAt++) {
      const lines = takeCompleteLines([buf.subarray(0, splitAt), buf.subarray(splitAt)])
      expect(lines).toEqual([line])
      expect(lines.join('\n').includes('\uFFFD')).toBe(false)
    }
  })

  it('没有换行的残行不会被提前交出去', () => {
    const buf = Buffer.from(SAMPLE, 'utf8')
    const splitAt = buf.indexOf(Buffer.from('段', 'utf8')) + 1
    expect(takeCompleteLines([buf.subarray(0, splitAt), buf.subarray(splitAt)])).toEqual([])
  })

  it('多段小块连续拼接也不丢字', () => {
    const buf = Buffer.from(SAMPLE, 'utf8')
    const utf8 = createUtf8ChunkDecoder()
    let text = ''
    for (let i = 0; i < buf.length; i += 2) {
      text += utf8.push(buf.subarray(i, Math.min(i + 2, buf.length)))
    }
    text += utf8.end()
    expect(text).toBe(SAMPLE)
  })
})
