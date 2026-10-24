/**
 * read_file 数行与 wc -l 同口径：末尾的换行是最后一行的结尾，不另算一行
 */
import { afterAll, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const TEST_USERDATA = path.join(os.tmpdir(), 'sailfish-read-file-lines-ud')
const rangedSize = vi.hoisted(() => ({ bytes: 0 }))

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return {
    ...actual,
    statSync(filePath: fs.PathLike, options?: fs.StatSyncOptions) {
      const stat = options === undefined ? actual.statSync(filePath) : actual.statSync(filePath, options)
      if (rangedSize.bytes > 0 && String(filePath).endsWith('ranged-huge.txt')) {
        Object.defineProperty(stat, 'size', { value: rangedSize.bytes })
      }
      return stat
    },
  }
})

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockImplementation(() => TEST_USERDATA),
    getName: vi.fn().mockReturnValue('SailFish'),
    getVersion: vi.fn().mockReturnValue('1.0.0')
  },
  BrowserWindow: vi.fn(),
  ipcMain: { on: vi.fn(), handle: vi.fn() }
}))

import { MAX_RANGED_READ_BYTES, readFile, splitTextLines } from '../tools/file'
import type { ToolExecutorConfig } from '../tools/types'

function makeExecutor(): ToolExecutorConfig & { lastResultStep: () => string } {
  const steps: Array<{ type: string; content: string }> = []
  return {
    terminalService: {} as ToolExecutorConfig['terminalService'],
    addStep: vi.fn().mockImplementation((step) => {
      steps.push(step)
      return { ...step, id: 's1', timestamp: Date.now() }
    }),
    updateStep: vi.fn(),
    waitForConfirmation: vi.fn(),
    requestSecureInput: vi.fn(),
    isAborted: () => false,
    getHostId: () => undefined,
    hasPendingUserMessage: () => false,
    peekPendingUserMessage: () => undefined,
    consumePendingUserMessage: () => undefined,
    getRealtimeTerminalOutput: () => [],
    getCurrentPlan: () => undefined,
    setCurrentPlan: vi.fn(),
    getTaskMemory: vi.fn(),
    getToolOutputBudget: () => ({ maxChars: 50_000, maxLines: 2000, critical: false, usagePercent: 10 }),
    lastResultStep: () => steps.filter(s => s.type === 'tool_result').at(-1)?.content ?? '',
  } as unknown as ToolExecutorConfig & { lastResultStep: () => string }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-read-lines-'))

function writeFile(name: string, content: string): string {
  const file = path.join(dir, name)
  fs.writeFileSync(file, content)
  return file
}

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(TEST_USERDATA, { recursive: true, force: true })
})

describe('splitTextLines', () => {
  it('末尾换行不另算一行', () => {
    expect(splitTextLines('a\nb\n')).toEqual(['a', 'b'])
    expect(splitTextLines('a\nb')).toEqual(['a', 'b'])
  })

  it('空文件 0 行；只有一个换行是 1 个空行', () => {
    expect(splitTextLines('')).toEqual([])
    expect(splitTextLines('\n')).toEqual([''])
  })

  it('末尾的空行照算', () => {
    expect(splitTextLines('a\n\n')).toEqual(['a', ''])
  })
})

describe('read_file 行数', () => {
  const threeLines = '第一行\n第二行\n第三行\n'

  it('整份读：不多编一个空行号', async () => {
    const file = writeFile('full.txt', threeLines)
    const executor = makeExecutor()
    const result = await readFile('pty1', { path: file }, {} as never, executor)
    expect(result.success).toBe(true)
    expect(result.output.split('\n')).toEqual(['   1|第一行', '   2|第二行', '   3|第三行'])
    expect(executor.lastResultStep()).toContain('实际读取: 3 行')
  })

  it('读最后 1 行拿到的是真正的最后一行', async () => {
    const file = writeFile('tail.txt', threeLines)
    const result = await readFile('pty1', { path: file, tail_lines: 1 }, {} as never, makeExecutor())
    expect(result.output).toBe('   3|第三行')
  })

  it('前 N 行正好读完整份时不说只读了一部分', async () => {
    const file = writeFile('head.txt', threeLines)
    const executor = makeExecutor()
    await readFile('pty1', { path: file, max_lines: 3 }, {} as never, executor)
    expect(executor.lastResultStep()).toContain('实际读取: 3 行')
    expect(executor.lastResultStep()).not.toMatch(/共 \d+ 行/)
  })

  it('读一段时报的总行数与 wc -l 一致', async () => {
    const file = writeFile('range.txt', threeLines)
    const executor = makeExecutor()
    await readFile('pty1', { path: file, start_line: 1, end_line: 1 }, {} as never, executor)
    expect(executor.lastResultStep()).toMatch(/共 3 行/)
  })

  it('只看信息时报的行数与 wc -l 一致', async () => {
    const file = writeFile('info.txt', threeLines)
    const result = await readFile('pty1', { path: file, info_only: true }, {} as never, makeExecutor())
    expect(result.output).toContain('**总行数**: 3 行')
  })

  it('读最后几行时行号接得上', async () => {
    const file = writeFile('tail2.txt', threeLines)
    const result = await readFile('pty1', { path: file, tail_lines: 2 }, {} as never, makeExecutor())
    expect(result.output.split('\n')).toEqual(['   2|第二行', '   3|第三行'])
  })

  it('Windows 换行同样不多算', async () => {
    const file = writeFile('crlf.txt', 'a\r\nb\r\n')
    const result = await readFile('pty1', { path: file, info_only: true }, {} as never, makeExecutor())
    expect(result.output).toContain('**总行数**: 2 行')
  })

  it('空文件明说是空的', async () => {
    const file = writeFile('empty.txt', '')
    const executor = makeExecutor()
    const result = await readFile('pty1', { path: file }, {} as never, executor)
    expect(result.success).toBe(true)
    expect(result.output).toBe('（文件是空的，0 行）')
    expect(executor.lastResultStep()).toContain('实际读取: 0 行')
  })

  it('按行读超过上限时不把整份读进来', async () => {
    const file = writeFile('ranged-huge.txt', '第一行\n第二行\n')
    rangedSize.bytes = MAX_RANGED_READ_BYTES + 1
    try {
      const result = await readFile('pty1', { path: file, start_line: 1, end_line: 1 }, {} as never, makeExecutor())
      expect(result.success).toBe(false)
      expect(result.error).toContain('这次没有读')
    } finally {
      rangedSize.bytes = 0
    }
  })

  it('末尾没有换行的文件结果不变', async () => {
    const file = writeFile('noeol.txt', '第一行\n第二行\n第三行')
    const result = await readFile('pty1', { path: file, tail_lines: 1 }, {} as never, makeExecutor())
    expect(result.output).toBe('   3|第三行')
  })
})
