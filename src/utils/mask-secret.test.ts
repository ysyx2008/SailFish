import { describe, expect, it } from 'vitest'
import { MASK_CHAR, maskSecret } from './mask-secret'

const dots = (n: number) => MASK_CHAR.repeat(n)

describe('maskSecret', () => {
  it('空值不显示任何东西', () => {
    expect(maskSecret('')).toBe('')
  })

  it('够长的密钥露开头 3 位和末尾 4 位，中间圆点补满', () => {
    // 23 位：头 3 + 中间 16 + 尾 4
    expect(maskSecret('sk-abcdefghijklmnop1234')).toBe(`sk-${dots(16)}1234`)
  })

  it('显示出来的长度和密钥原来的长度一样（短的、长的都是）', () => {
    for (const n of [1, 5, 15, 16, 17, 40, 200]) {
      expect(maskSecret('a'.repeat(n))).toHaveLength(n)
    }
  })

  it('太短的密钥一位都不露，全是圆点，长度和原来一样', () => {
    expect(maskSecret('abc')).toBe(dots(3))
    expect(maskSecret('a'.repeat(15))).toBe(dots(15))
  })

  it('刚好 16 位开始露头尾，且不会把明文大段露出来', () => {
    const out = maskSecret('0123456789abcdef')
    expect(out).toBe(`012${dots(9)}cdef`)
    expect(out).not.toContain('3456789ab')
  })

  it('首尾空白不算密钥的一部分：复制时多带的空格、换行不会顶掉真正的末尾 4 位，也不多算长度', () => {
    expect(maskSecret('  sk-abcdefghijklmnop1234 \n')).toBe(`sk-${dots(16)}1234`)
  })

  it('全是空白等于没填', () => {
    expect(maskSecret('   \n ')).toBe('')
  })
})
