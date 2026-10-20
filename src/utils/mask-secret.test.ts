import { describe, expect, it } from 'vitest'
import { maskSecret } from './mask-secret'

describe('maskSecret', () => {
  it('shows only the start and the end of a normal key', () => {
    const masked = maskSecret('sk-0123456789abcdef0123456789abcdef')
    expect(masked).toBe('sk-••••••••cdef')
    expect(masked).not.toContain('0123456789')
  })

  it('ignores surrounding whitespace', () => {
    expect(maskSecret('  sk-0123456789abcdef  ')).toBe('sk-••••••••cdef')
  })

  it('reveals nothing for a key too short to hide anything', () => {
    expect(maskSecret('abc123')).toBe('••••••••')
    expect(maskSecret('abcdefghijklmno')).toBe('••••••••')
    expect(maskSecret('abcdefghijklmnop')).toBe('abc••••••••mnop')
  })

  it('returns an empty string for an empty key', () => {
    expect(maskSecret('')).toBe('')
    expect(maskSecret('   ')).toBe('')
  })
})
