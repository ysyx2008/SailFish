/**
 * read_file 混合/超大 PDF：要说清大部分是扫描页，超限要当失败而不是当成正文。
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const TEST_USERDATA = path.join(os.tmpdir(), 'sailfish-read-file-pdf-mixed-ud')
const TEST_DIR = path.join(os.tmpdir(), 'sailfish-read-file-pdf-mixed-src')

const { parseDocument } = vi.hoisted(() => ({
  parseDocument: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockImplementation(() => TEST_USERDATA),
    getName: vi.fn().mockReturnValue('SailFish'),
    getVersion: vi.fn().mockReturnValue('1.0.0')
  },
  BrowserWindow: vi.fn(),
  ipcMain: { on: vi.fn(), handle: vi.fn() }
}))

vi.mock('../../document-parser.service', () => ({
  getDocumentParserService: () => ({ parseDocument })
}))

import { readFile } from '../tools/file'
import type { ToolExecutorConfig } from '../tools/types'

const PDF_PATH = path.join(TEST_DIR, 'audit.pdf')

function makeExecutor(skillSession?: { loadSkill: ReturnType<typeof vi.fn> }): ToolExecutorConfig {
  return {
    terminalService: {} as ToolExecutorConfig['terminalService'],
    addStep: vi.fn().mockImplementation((step) => ({ ...step, id: 's1', timestamp: Date.now() })),
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
    skillSession: skillSession && { getWorkingDirectory: () => undefined, ...skillSession }
  } as unknown as ToolExecutorConfig
}

beforeEach(() => {
  parseDocument.mockReset()
  fs.mkdirSync(TEST_DIR, { recursive: true })
  fs.writeFileSync(PDF_PATH, '%PDF-fake')
})

afterAll(() => {
  fs.rmSync(TEST_USERDATA, { recursive: true, force: true })
  fs.rmSync(TEST_DIR, { recursive: true, force: true })
})

describe('read_file 混合 PDF', () => {
  it('封面有字的混合件应说明大部分是扫描页，并附图', async () => {
    parseDocument.mockResolvedValue({
      content: '封面目录',
      pageCount: 78,
      totalPages: 78,
      images: ['data:image/jpeg;base64,QQ=='],
      metadata: { pdfType: 'Mixed' }
    })
    const loadSkill = vi.fn().mockResolvedValue(undefined)
    const result = await readFile('pty1', { path: PDF_PATH }, {} as never, makeExecutor({ loadSkill }))

    expect(result.success).toBe(true)
    expect(result.output).toContain('大部分是扫描页')
    expect(result.output).toContain('封面目录')
    expect(result.output).toContain('pdf_view_page')
    expect(result.images).toEqual(['data:image/jpeg;base64,QQ=='])
    expect(loadSkill).toHaveBeenCalledWith('pdf')
  })

  it('整份跳过应失败，不当成已读正文', async () => {
    parseDocument.mockResolvedValue({
      skipped: true,
      content: '[audit.pdf 文件较大（72.2 MB），已跳过内容读取]'
    })
    const result = await readFile('pty1', { path: PDF_PATH }, {} as never, makeExecutor())

    expect(result.success).toBe(false)
    expect(result.error).toContain('已跳过内容读取')
    expect(result.output).toBe('')
  })
})
