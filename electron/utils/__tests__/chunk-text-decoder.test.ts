import { describe, expect, it } from 'vitest'
import { ChunkTextDecoder } from '../encoding'

const SAMPLE = '单元测试'

describe('ChunkTextDecoder', () => {
  it('一个汉字被切在两段中间时仍能拼回原文', () => {
    const buf = Buffer.from(SAMPLE, 'utf8')
    for (let splitAt = 1; splitAt < buf.length; splitAt++) {
      const decoder = new ChunkTextDecoder()
      const text = decoder.push(buf.subarray(0, splitAt)) + decoder.push(buf.subarray(splitAt)) + decoder.end()
      expect(text).toBe(SAMPLE)
      expect(text.includes('\uFFFD')).toBe(false)
    }
  })

  it('连续多段小块也不丢字', () => {
    const buf = Buffer.from(SAMPLE, 'utf8')
    const decoder = new ChunkTextDecoder()
    let text = ''
    for (let i = 0; i < buf.length; i++) {
      text += decoder.push(buf.subarray(i, i + 1))
    }
    text += decoder.end()
    expect(text).toBe(SAMPLE)
  })

  it('中间有非法字节时不把后面的字留到下一段', () => {
    const decoder = new ChunkTextDecoder()
    decoder.push(Buffer.from([0x68, 0xFF, 0x69]))
    const text = decoder.push(Buffer.from('元', 'utf8')) + decoder.end()
    expect(text).toBe('元')
  })

  it('流结束时还没写完的字不再等待', () => {
    const decoder = new ChunkTextDecoder()
    const buf = Buffer.from('元', 'utf8')
    expect(decoder.push(buf.subarray(0, 1))).toBe('')
    const rest = decoder.end()
    expect(rest.includes('\uFFFD')).toBe(true)
    expect(decoder.push(Buffer.from('测试', 'utf8'))).toBe('测试')
  })
})