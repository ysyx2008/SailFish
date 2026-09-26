import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/mock/user/data'),
    getName: vi.fn().mockReturnValue('SailFish'),
    getVersion: vi.fn().mockReturnValue('1.0.0')
  },
  BrowserWindow: vi.fn(),
  ipcMain: { on: vi.fn(), handle: vi.fn() }
}))

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
    readFileSync: vi.fn().mockReturnValue(''),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn().mockReturnValue([])
  }
})

import { getAgentTools } from '../../tools'
import { managePaneTool } from '../split-pane'

vi.mock('../../../split-pane-bridge.service', () => ({
  splitPaneBridge: {
    exec: vi.fn()
  }
}))

import { splitPaneBridge } from '../../../split-pane-bridge.service'

const exec = vi.mocked(splitPaneBridge.exec)

describe('manage_pane action=open', () => {
  beforeEach(() => {
    exec.mockReset()
  })

  it('opens a local terminal and sets current ptyId', async () => {
    exec.mockResolvedValue({
      ok: true,
      data: { ptyId: 'pty-1', panes: [{ ptyId: 'pty-1', label: '主窗格', isActive: true, terminalType: 'local' }] }
    })
    const setCurrentPtyId = vi.fn()
    const result = await managePaneTool(
      { action: 'open', target: 'local' },
      'assistant-1',
      { setCurrentPtyId } as never
    )
    expect(result.success).toBe(true)
    expect(result.output).toContain('execute_command')
    expect(setCurrentPtyId).toHaveBeenCalledWith('pty-1')
    expect(exec).toHaveBeenCalledWith({ type: 'open', target: { kind: 'local' } }, 'assistant-1')
  })

  it('rejects invalid target', async () => {
    const result = await managePaneTool({ action: 'open', target: 'ftp:x' }, 'assistant-1')
    expect(result.success).toBe(false)
    expect(exec).not.toHaveBeenCalled()
  })
})

describe('manage_pane action=split', () => {
  beforeEach(() => {
    exec.mockReset()
  })

  it('returns the new pane ptyId and sets it as current', async () => {
    const newPtyId = 'pty-new'
    exec.mockResolvedValue({
      ok: true,
      data: {
        tabId: 'tab-1',
        ptyId: newPtyId,
        newPaneId: newPtyId,
        panes: [
          { ptyId: 'pty-old', label: '左侧', isActive: false, terminalType: 'local' },
          { ptyId: newPtyId, label: '右侧', isActive: true, terminalType: 'local' }
        ]
      }
    })
    const setCurrentPtyId = vi.fn()
    const result = await managePaneTool(
      { action: 'split', direction: 'horizontal' },
      'tab-1',
      { setCurrentPtyId } as never
    )
    expect(result.success).toBe(true)
    expect(result.output).toContain(`pane_id=${newPtyId}`)
    const payload = JSON.parse(result.output.slice(result.output.indexOf('{'))) as {
      ptyId: string
      newPaneId: string
      panes: Array<{ ptyId: string }>
    }
    expect(payload.ptyId).toBe(newPtyId)
    expect(payload.newPaneId).toBe(newPtyId)
    expect(payload.panes.map(p => p.ptyId)).toContain(newPtyId)
    expect(setCurrentPtyId).toHaveBeenCalledWith(newPtyId)
    expect(exec).toHaveBeenCalledWith(
      { type: 'split', direction: 'horizontal', target: undefined },
      'tab-1'
    )
  })

  it('accepts newPaneId as ptyId when ptyId field is missing', async () => {
    exec.mockResolvedValue({
      ok: true,
      data: {
        newPaneId: 'pty-from-alias',
        panes: [{ ptyId: 'pty-from-alias', label: '右侧', isActive: true, terminalType: 'local' }]
      }
    })
    const setCurrentPtyId = vi.fn()
    const result = await managePaneTool(
      { action: 'split', direction: 'vertical', target: 'local' },
      'tab-1',
      { setCurrentPtyId } as never
    )
    expect(result.success).toBe(true)
    expect(result.output).toContain('pane_id=pty-from-alias')
    expect(setCurrentPtyId).toHaveBeenCalledWith('pty-from-alias')
  })

  it('rejects invalid direction', async () => {
    const result = await managePaneTool({ action: 'split', direction: 'diagonal' }, 'tab-1')
    expect(result.success).toBe(false)
    expect(exec).not.toHaveBeenCalled()
  })

  it('does not set current ptyId when split fails', async () => {
    exec.mockResolvedValue({ ok: false, error: 'Split failed: no active tab' })
    const setCurrentPtyId = vi.fn()
    const result = await managePaneTool(
      { action: 'split', direction: 'horizontal' },
      'tab-1',
      { setCurrentPtyId } as never
    )
    expect(result.success).toBe(false)
    expect(setCurrentPtyId).not.toHaveBeenCalled()
  })
})

describe('manage_pane action=ensure_connected', () => {
  beforeEach(() => {
    exec.mockReset()
  })

  it('does not start a second reconnect when the pane is already connecting', async () => {
    exec.mockResolvedValue({
      ok: true,
      data: {
        tabId: 'tab-1',
        mode: 'split',
        panes: [
          { ptyId: 'pty-local', label: '左侧', isActive: false, terminalType: 'local' },
          {
            ptyId: 'pty-ssh',
            label: '右侧',
            isActive: true,
            terminalType: 'ssh',
            connecting: true
          }
        ]
      }
    })
    const result = await managePaneTool(
      { action: 'ensure_connected', pane_id: 'pty-ssh' },
      'tab-1',
      { getCurrentPtyId: () => 'pty-local' } as never
    )
    expect(result.success).toBe(true)
    expect(result.output).toContain('pty-ssh')
    expect(exec).toHaveBeenCalledTimes(1)
    expect(exec).toHaveBeenCalledWith({ type: 'list' }, 'tab-1')
  })
})

describe('getAgentTools assistant hosted terminal', () => {
  it('exposes manage_pane open and execute_command in assistant mode', () => {
    const tools = getAgentTools(undefined, { mode: 'assistant' })
    const names = tools.map(t => t.function.name)
    expect(names).toContain('manage_pane')
    expect(names).toContain('list_ssh_sessions')
    expect(names).toContain('execute_command')
    const manage = tools.find(t => t.function.name === 'manage_pane')!
    const action = (manage.function.parameters as unknown as { properties: { action: { enum: string[] } } }).properties.action
    expect(action.enum).toContain('open')
  })
})
