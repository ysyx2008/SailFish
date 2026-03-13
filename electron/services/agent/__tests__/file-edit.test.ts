/**
 * edit_file 多层容错匹配单元测试
 * 覆盖位置映射、容错替换、换行符保持等核心逻辑
 */
import { describe, it, expect } from 'vitest'
import {
  findEditMatch,
  replaceAllNormalized,
  preserveNewlineStyle,
} from '../tools/file'

// ==================== findEditMatch ====================

describe('findEditMatch', () => {
  it('Tier 1: exact match', () => {
    const file = 'function hello() {\n  return 1\n}\n'
    const result = findEditMatch(file, '  return 1')
    expect(result.found).toBe(true)
    expect(result.count).toBe(1)
    expect(result.normalized).toBeUndefined()
  })

  it('Tier 1: exact match — multiple occurrences', () => {
    const file = 'a = 1\nb = 1\nc = 1\n'
    const result = findEditMatch(file, ' = 1')
    expect(result.found).toBe(true)
    expect(result.count).toBe(3)
  })

  it('Tier 2: CRLF in file, LF in old_text', () => {
    const file = 'line1\r\nline2\r\nline3\r\n'
    const result = findEditMatch(file, 'line1\nline2')
    expect(result.found).toBe(true)
    expect(result.normalized).toBe(true)
    expect(result.originalStart).toBe(0)
    expect(result.originalEnd).toBe('line1\r\nline2'.length)
  })

  it('Tier 2: LF in file, CRLF in old_text', () => {
    const file = 'aaa\nbbb\nccc\n'
    const result = findEditMatch(file, 'aaa\r\nbbb')
    expect(result.found).toBe(true)
    expect(result.normalized).toBe(true)
    expect(result.originalStart).toBe(0)
    expect(result.originalEnd).toBe('aaa\nbbb'.length)
  })

  it('Tier 3: trailing whitespace tolerance', () => {
    const file = 'hello   \nworld\n'
    const result = findEditMatch(file, 'hello\nworld')
    expect(result.found).toBe(true)
    expect(result.normalized).toBe(true)
    const replaced = file.substring(0, result.originalStart!) + 'REPLACED' + file.substring(result.originalEnd!)
    expect(replaced).toBe('REPLACED\n')
  })

  it('Tier 3: CRLF + trailing whitespace combined', () => {
    const file = 'foo  \r\nbar\r\n'
    const result = findEditMatch(file, 'foo\nbar')
    expect(result.found).toBe(true)
    expect(result.normalized).toBe(true)
    const replaced = file.substring(0, result.originalStart!) + 'NEW' + file.substring(result.originalEnd!)
    expect(replaced).toBe('NEW\r\n')
  })

  it('returns closestContext when no match at all', () => {
    const file = 'const x = 1\nfunction add(a, b) {\n  return a + b\n}\nconst y = 2\n'
    const result = findEditMatch(file, 'function add(a, b) {\n  return a + b + c\n}')
    expect(result.found).toBe(false)
    expect(result.closestContext).toBeDefined()
    expect(result.closestContext).toContain('function add')
  })

  it('empty old_text returns not found', () => {
    const result = findEditMatch('some content', '')
    expect(result.found).toBe(false)
    expect(result.count).toBe(0)
  })
})

// ==================== replaceAllNormalized ====================

describe('replaceAllNormalized', () => {
  it('falls back to exact replaceAll when possible', () => {
    const file = 'foo bar foo baz foo'
    const result = replaceAllNormalized(file, 'foo', 'qux')
    expect(result).toBe('qux bar qux baz qux')
  })

  it('replaces all via CRLF + trailing whitespace tolerance', () => {
    const file = 'val = 1  \r\nval = 1  \r\nend\r\n'
    const result = replaceAllNormalized(file, 'val = 1', 'val = 2')
    expect(result).toContain('val = 2')
    expect(result).not.toContain('val = 1')
    expect(result).toContain('\r\n')
  })
})

// ==================== preserveNewlineStyle ====================

describe('preserveNewlineStyle', () => {
  it('converts LF to CRLF when file uses CRLF', () => {
    const result = preserveNewlineStyle('a\nb\nc', 'x\r\ny\r\n')
    expect(result).toBe('a\r\nb\r\nc')
  })

  it('leaves LF as-is when file uses LF', () => {
    const result = preserveNewlineStyle('a\nb\nc', 'x\ny\n')
    expect(result).toBe('a\nb\nc')
  })

  it('does not double-convert existing CRLF', () => {
    const result = preserveNewlineStyle('a\r\nb', 'x\r\ny\r\n')
    expect(result).toBe('a\r\nb')
  })
})
