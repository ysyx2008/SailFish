import { describe, expect, it } from 'vitest'
import { MASK_CHAR, maskSecret } from './mask-secret'

describe('maskSecret', () => {
  it('空值不显示任何东西', () => {
    expect(maskSecret('')).toBe('')
  })

  it('够长的密钥露开头 3 位和末尾 4 位，中间固定 8 个圆点', () => {
    expect(maskSecret('sk-abcdefghijklmnop1234')).toBe(`sk-${MASK_CHAR.repeat(8)}1234`)
  })

  it('圆点个数不随密钥长短变化', () => {
    const dots = (s: string) => maskSecret(s).split('').filter((c) => c === MASK_CHAR).length
    expect(dots('a'.repeat(16))).toBe(8)
    expect(dots('a'.repeat(40))).toBe(8)
    expect(dots('a'.repeat(200))).toBe(8)
  })

  it('太短的密钥一位都不露，只给 8 个圆点', () => {
    expect(maskSecret('abc')).toBe(MASK_CHAR.repeat(8))
    expect(maskSecret('a'.repeat(15))).toBe(MASK_CHAR.repeat(8))
  })

  it('刚好 16 位开始露头尾，且不会把明文大段露出来', () => {
    const out = maskSecret('0123456789abcdef')
    expect(out).toBe(`012${MASK_CHAR.repeat(8)}cdef`)
    expect(out).not.toContain('3456789ab')
  })

  it('不去掉首尾空白，显示的就是用户填的那一串', () => {
    expect(maskSecret(' '.repeat(3))).toBe(MASK_CHAR.repeat(8))
  })
})
