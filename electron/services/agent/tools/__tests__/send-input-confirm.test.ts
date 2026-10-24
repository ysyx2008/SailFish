import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-send-input-'))
  return {
    app: {
      getPath: () => dir,
      getName: () => 'SailFish',
      getVersion: () => '0.0.0',
      isPackaged: false,
    },
    BrowserWindow: { getAllWindows: () => [] },
    ipcMain: { on: vi.fn(), handle: vi.fn() },
    safeStorage: { isEncryptionAvailable: () => false },
  }
})

vi.mock('../../../screen-content.service', () => ({
  getLastNLinesFromBuffer: async () => null,
  getScreenAnalysisFromFrontend: async () => null,
}))

vi.mock('../../../terminal-awareness', () => ({
  getTerminalAwarenessService: vi.fn(),
  getProcessMonitor: vi.fn(),
}))

import { assessCommandRiskDetailed } from '../../risk-assessor'
import { auditContextFromConfig } from '../../audit-context-from-config'
import { commandNeedsConfirm } from '../../command-audit/confirm-policy'
import { sendInput } from '../terminal'
import type { AgentConfig, ToolExecutorConfig } from '../types'
import type { ExecutionMode } from '@shared/types'

function harness(mode: ExecutionMode, approved = false) {
  const writes: string[] = []
  const waitForConfirmation = vi.fn(async () => approved)
  const executor = {
    isSubAgent: false,
    terminalService: {
      write: (_ptyId: string, data: string) => {
        writes.push(data)
        return true
      },
    },
    addStep: vi.fn((step) => ({ id: 's', timestamp: 0, ...step })),
    waitForConfirmation,
  } as unknown as ToolExecutorConfig
  const config = { executionMode: mode } as AgentConfig
  return { writes, waitForConfirmation, executor, config }
}

describe('send_input confirmation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('blocks a hard-blocked command with enter the same way execute would, and does not write', async () => {
    const { writes, waitForConfirmation, executor, config } = harness('relaxed')
    // 这里没有终端。一旦真去写，测试会直接失败，命令没有地方可跑。
    executor.terminalService.write = () => {
      throw new Error('blocked input must not be written')
    }
    const text = 'rm -rf /'
    const assessment = await assessCommandRiskDetailed(text, auditContextFromConfig(config))
    expect(assessment.level).toBe('blocked')

    const result = await sendInput('pty-1', { text, press_enter: true }, 'call-1', config, executor)

    expect(result.success).toBe(false)
    expect(result.error).toContain(text)
    expect(writes).toEqual([])
    expect(waitForConfirmation).not.toHaveBeenCalled()
  })

  it('asks before a dangerous command with enter, and does not write when declined', async () => {
    const { writes, waitForConfirmation, executor, config } = harness('relaxed', false)
    executor.terminalService.write = () => {
      throw new Error('declined input must not be written')
    }
    const text = 'rm -rf /etc'
    const assessment = await assessCommandRiskDetailed(text, auditContextFromConfig(config))
    expect(assessment.level).toBe('dangerous')
    expect(commandNeedsConfirm(assessment, config.executionMode, config.commandRiskPolicy)).toBe(true)

    const result = await sendInput('pty-1', { text }, 'call-1', config, executor)

    expect(result.success).toBe(false)
    expect(writes).toEqual([])
    expect(waitForConfirmation).toHaveBeenCalledWith(
      'call-1',
      'send_input',
      { text, press_enter: true },
      'dangerous',
      undefined,
      expect.any(Array),
      undefined,
    )
  })

  it('writes a dangerous command with enter after it is approved', async () => {
    const { writes, executor, config } = harness('relaxed', true)
    const result = await sendInput('pty-1', { text: 'rm -rf /etc', press_enter: true }, 'call-1', config, executor)
    expect(result.success).toBe(true)
    expect(writes).toEqual(['rm -rf /etc', '\r'])
  })

  it('writes the same dangerous text without enter and does not ask', async () => {
    const { writes, waitForConfirmation, executor, config } = harness('relaxed')
    const result = await sendInput(
      'pty-1',
      { text: 'rm -rf /etc', press_enter: false },
      'call-1',
      config,
      executor,
    )
    expect(result.success).toBe(true)
    expect(waitForConfirmation).not.toHaveBeenCalled()
    expect(writes).toEqual(['rm -rf /etc'])
  })

  it('does not ask for a short reply with enter under the relaxed policy', async () => {
    const { writes, waitForConfirmation, executor, config } = harness('relaxed')
    const text = 'yes'
    const assessment = await assessCommandRiskDetailed(text, auditContextFromConfig(config))
    expect(commandNeedsConfirm(assessment, 'relaxed', config.commandRiskPolicy)).toBe(false)

    const result = await sendInput('pty-1', { text, press_enter: true }, 'call-1', config, executor)

    expect(result.success).toBe(true)
    expect(waitForConfirmation).not.toHaveBeenCalled()
    expect(writes).toEqual(['yes', '\r'])
  })

  it('still skips confirmation for a dangerous command in free mode', async () => {
    const { writes, waitForConfirmation, executor, config } = harness('free', false)
    const text = 'rm -rf /etc'
    const assessment = await assessCommandRiskDetailed(text, auditContextFromConfig(config))
    expect(commandNeedsConfirm(assessment, 'free', config.commandRiskPolicy)).toBe(false)

    const result = await sendInput('pty-1', { text, press_enter: true }, 'call-1', config, executor)

    expect(result.success).toBe(true)
    expect(waitForConfirmation).not.toHaveBeenCalled()
    expect(writes).toEqual([text, '\r'])
  })
})
