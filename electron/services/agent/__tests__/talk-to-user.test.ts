import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: vi.fn().mockReturnValue('/mock/user/data'), getName: vi.fn(), getVersion: vi.fn() },
  BrowserWindow: { getAllWindows: vi.fn().mockReturnValue([]) },
  ipcMain: { on: vi.fn(), handle: vi.fn() },
}))
vi.mock('../../im/im.service', () => ({ getIMService: vi.fn().mockReturnValue(null) }))
vi.mock('../proactive-deliver', () => ({ deliverProactiveMessage: vi.fn() }))

import { messageUser } from '../tools/misc'
import { deliverProactiveMessage } from '../proactive-deliver'
import type { ToolExecutorConfig } from '../tools/types'

const deliver = vi.mocked(deliverProactiveMessage)

function executor(inReceiptTurn: boolean) {
  const addStep = vi.fn((step: Record<string, unknown>) => ({ id: 'x', timestamp: 0, content: '', ...step }))
  return { addStep, config: { agentId: '__companion__', inReceiptTurn, addStep } as unknown as ToolExecutorConfig }
}

describe('talk_to_user：用户不在对话里的那一轮', () => {
  beforeEach(() => {
    deliver.mockReset()
  })

  it('送到了：记一条对用户说的话', async () => {
    deliver.mockResolvedValue({ deliveredVia: ['wechat', 'app'], failedChannels: [] })
    const { addStep, config } = executor(true)

    await messageUser({ message: '算好了：391' }, config)

    expect(addStep).toHaveBeenCalledWith({ type: 'proactive_notice', content: '算好了：391' })
    expect(addStep.mock.calls.at(-1)?.[0].type).toBe('proactive_notice')
  })

  it('没送到：不记', async () => {
    deliver.mockResolvedValue({ deliveredVia: [], failedChannels: [] })
    const { addStep, config } = executor(true)

    await messageUser({ message: '算好了：391' }, config)

    expect(addStep.mock.calls.some(([s]) => s.type === 'proactive_notice')).toBe(false)
  })

  it('平时聊天的那一轮：照旧只有工具记录', async () => {
    deliver.mockResolvedValue({ deliveredVia: ['app'], failedChannels: [] })
    const { addStep, config } = executor(false)

    await messageUser({ message: '算好了：391' }, config)

    expect(addStep.mock.calls.some(([s]) => s.type === 'proactive_notice')).toBe(false)
  })
})
