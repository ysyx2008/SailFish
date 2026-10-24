/**
 * 清理临时目录时，符号链接只删链接本身，不删它指向的文件。
 */
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, utimesSync, lutimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: () => path.join(tmpdir(), 'sft-scratch-cleanup-not-used'),
  },
}))

import { cleanupExpiredTree } from '../file'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 86400_000)
}

describe('cleanupExpiredTree', () => {
  it('过期的普通文件会删，没过期的留下，过期的快捷方式只删链接', () => {
    const scratch = mkdtempSync(path.join(tmpdir(), 'sft-scratch-'))
    const outside = mkdtempSync(path.join(tmpdir(), 'sft-outside-'))
    roots.push(scratch, outside)

    const oldFile = path.join(scratch, 'old.txt')
    const freshFile = path.join(scratch, 'fresh.txt')
    const keep = path.join(scratch, '.keep')
    writeFileSync(oldFile, 'old')
    writeFileSync(freshFile, 'fresh')
    writeFileSync(keep, '')
    utimesSync(oldFile, daysAgo(10), daysAgo(10))
    utimesSync(keep, daysAgo(10), daysAgo(10))

    const outsideFile = path.join(outside, 'secret.txt')
    writeFileSync(outsideFile, 'secret')
    utimesSync(outsideFile, daysAgo(10), daysAgo(10))

    const oldLink = path.join(scratch, 'old-link')
    const freshLink = path.join(scratch, 'fresh-link')
    symlinkSync(outside, oldLink, 'dir')
    symlinkSync(outside, freshLink, 'dir')
    lutimesSync(oldLink, daysAgo(10), daysAgo(10))

    const nested = path.join(scratch, 'nested')
    mkdirSync(nested)
    const nestedOld = path.join(nested, 'gone.txt')
    writeFileSync(nestedOld, 'gone')
    utimesSync(nestedOld, daysAgo(10), daysAgo(10))

    const stats = cleanupExpiredTree(scratch, 7)

    expect(existsSync(oldFile)).toBe(false)
    expect(existsSync(freshFile)).toBe(true)
    expect(existsSync(keep)).toBe(true)
    expect(existsSync(outsideFile)).toBe(true)
    expect(existsSync(oldLink)).toBe(false)
    expect(existsSync(freshLink)).toBe(true)
    expect(existsSync(nested)).toBe(false)
    expect(stats.deletedFiles).toBeGreaterThanOrEqual(2)
  })
})
