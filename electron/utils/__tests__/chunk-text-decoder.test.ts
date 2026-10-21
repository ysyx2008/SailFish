import { describe, expect, it } from 'vitest'
import iconv from 'iconv-lite'
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

  it('指定 GBK 时，一个汉字被切在两段中间仍能拼回', () => {
    const buf = iconv.encode('单元测试', 'gbk')
    const yuanAt = buf.indexOf(iconv.encode('元', 'gbk'))
    const decoder = new ChunkTextDecoder('gbk')
    const text = decoder.push(buf.subarray(0, yuanAt + 1)) + decoder.push(buf.subarray(yuanAt + 1)) + decoder.end()
    expect(text).toBe('单元测试')
    expect(text.includes('\uFFFD')).toBe(false)
  })

  it('指定 Shift_JIS 和 GB18030 时同样能拼回', () => {
    const cases = [
      ['shift_jis', '日本語'],
      ['gb18030', '单元测试'],
    ] as const
    for (const [encoding, sample] of cases) {
      const buf = iconv.encode(sample, encoding)
      const decoder = new ChunkTextDecoder(encoding)
      let text = ''
      for (let i = 0; i < buf.length; i++) text += decoder.push(buf.subarray(i, i + 1))
      text += decoder.end()
      expect(text).toBe(sample)
    }
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