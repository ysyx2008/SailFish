/**
 * 本场新建的 Word / Excel 再覆盖按低风险；本场开始前已有的仍是高风险。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue(path.join(os.tmpdir(), 'sailfish-office-risk-ud')),
    getName: () => 'SailFish',
    getVersion: () => '1.0.0',
    isPackaged: false,
  },
}))

import { executeWordTool } from '../word/executor'
import { closeAllSessions as closeWordSessions } from '../word/session'
import { executeExcelTool } from '../excel/executor'
import { closeAllSessions as closeExcelSessions } from '../excel/session'
import { resetOfficeBackupStateForTest } from '../office-file-backup'
import type { ToolExecutorConfig } from '../../tools/types'
import type { AgentConfig } from '../../types'

const relaxed = { executionMode: 'relaxed' } as AgentConfig

function makeExecutor(conversationId = 'conv-1'): ToolExecutorConfig & {
  waitForConfirmation: ReturnType<typeof vi.fn>
  addStep: ReturnType<typeof vi.fn>
} {
  const executor = {
    addStep: vi.fn().mockImplementation((step) => ({ ...step, id: 's1', timestamp: Date.now() })),
    waitForConfirmation: vi.fn().mockResolvedValue(true),
    getDocumentConversationId: () => conversationId,
  }
  return executor as unknown as ToolExecutorConfig & {
    waitForConfirmation: ReturnType<typeof vi.fn>
    addStep: ReturnType<typeof vi.fn>
  }
}

function lastRisk(executor: { addStep: ReturnType<typeof vi.fn> }): string | undefined {
  const calls = executor.addStep.mock.calls.map((c) => c[0] as { type?: string; riskLevel?: string })
  return [...calls].reverse().find((s) => s.type === 'tool_call')?.riskLevel
}

describe('本场新建的办公文件再覆盖', () => {
  let tmpDir: string

  afterEach(async () => {
    await closeWordSessions()
    await closeExcelSessions()
    resetOfficeBackupStateForTest()
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('Word 整篇重写：本场新建的第二次不再问，开始前已有的仍是高风险', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sft-office-risk-'))
    const created = path.join(tmpDir, '评审意见.docx')
    const markdown = '# 评审意见\n\n第一稿'
    const first = makeExecutor()

    const createdOnce = await executeWordTool(
      'word_from_markdown', 'pty1', { path: created, markdown }, 'tc1', relaxed, first
    )
    expect(createdOnce.success).toBe(true)
    expect(first.waitForConfirmation).not.toHaveBeenCalled()
    expect(lastRisk(first)).toBe('safe')

    const again = makeExecutor()
    const createdTwice = await executeWordTool(
      'word_from_markdown', 'pty1', { path: created, markdown: '# 评审意见\n\n整篇重写' }, 'tc2', relaxed, again
    )
    expect(createdTwice.success).toBe(true)
    expect(again.waitForConfirmation).not.toHaveBeenCalled()
    expect(lastRisk(again)).toBe('safe')

    const existing = path.join(tmpDir, '原来就有.docx')
    fs.writeFileSync(existing, '用户的稿')
    const overwriteOld = makeExecutor()
    overwriteOld.waitForConfirmation.mockResolvedValue(false)
    const refused = await executeWordTool(
      'word_from_markdown', 'pty1', { path: existing, markdown }, 'tc3', relaxed, overwriteOld
    )
    expect(refused.success).toBe(false)
    expect(overwriteOld.waitForConfirmation).toHaveBeenCalledTimes(1)
    expect(overwriteOld.waitForConfirmation.mock.calls[0][3]).toBe('dangerous')
    expect(lastRisk(overwriteOld)).toBe('dangerous')
    expect(fs.readFileSync(existing, 'utf-8')).toBe('用户的稿')
  })

  it('Excel 整篇重写：本场新建的第二次不再问，换一场仍是高风险', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sft-office-risk-'))
    const created = path.join(tmpDir, '表.xlsx')
    const markdown = '| 列A |\n| --- |\n| 1 |'
    const first = makeExecutor('conv-1')

    const createdOnce = await executeExcelTool(
      'excel_from_markdown', 'pty1', { path: created, markdown }, 'tc1', relaxed, first
    )
    expect(createdOnce.success).toBe(true)
    expect(first.waitForConfirmation).not.toHaveBeenCalled()

    const again = makeExecutor('conv-1')
    const createdTwice = await executeExcelTool(
      'excel_from_markdown', 'pty1', { path: created, markdown: '| 列A |\n| --- |\n| 2 |' }, 'tc2', relaxed, again
    )
    expect(createdTwice.success).toBe(true)
    expect(again.waitForConfirmation).not.toHaveBeenCalled()
    expect(lastRisk(again)).toBe('safe')

    const otherTalk = makeExecutor('conv-2')
    otherTalk.waitForConfirmation.mockResolvedValue(false)
    const refused = await executeExcelTool(
      'excel_from_markdown', 'pty1', { path: created, markdown }, 'tc3', relaxed, otherTalk
    )
    expect(refused.success).toBe(false)
    expect(otherTalk.waitForConfirmation.mock.calls[0][3]).toBe('dangerous')
  })
})
