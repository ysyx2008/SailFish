import { beforeEach, describe, expect, it, vi } from 'vitest'

const { store } = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/sf-config-set-test',
    getName: () => 'SailFish',
    getVersion: () => '0.0.0',
    isPackaged: false,
  },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { on: vi.fn(), handle: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => false },
}))

vi.mock('../../../../config.service', () => ({
  getConfigService: () => ({
    get: (key: string) => store.get(key),
    set: (key: string, value: unknown) => { store.set(key, value) },
  }),
}))

import { executeConfigTool } from '../executor'
import type { AgentConfig, ToolExecutorConfig } from '../../../tools/types'

const CONFIRM_KEYS: Array<{ key: string; value: unknown }> = [
  { key: 'aiRules', value: '不要删生产库' },
  { key: 'imExecutionMode', value: 'free' },
  { key: 'gatewayHost', value: '0.0.0.0' },
  { key: 'gatewayAutoStart', value: true },
  { key: 'imDingTalkClientSecret', value: 'ding-secret' },
  { key: 'imFeishuAppSecret', value: 'feishu-secret' },
  { key: 'imSlackBotToken', value: 'xoxb-token' },
  { key: 'imSlackAppToken', value: 'xapp-token' },
  { key: 'imTelegramBotToken', value: 'tg-token' },
  { key: 'imWeComSecret', value: 'wecom-secret' },
]

function executor(approved: boolean) {
  const waitForConfirmation = vi.fn(async () => approved)
  return {
    waitForConfirmation,
    executor: { waitForConfirmation } as unknown as ToolExecutorConfig,
  }
}

async function setKey(exec: ToolExecutorConfig, key: string, value: unknown) {
  return executeConfigTool('config_set', '', { key, value }, 'call-1', {} as AgentConfig, exec)
}

describe('config_set confirmation', () => {
  beforeEach(() => {
    store.clear()
  })

  it('does not write a sensitive key until the user confirms', async () => {
    for (const item of CONFIRM_KEYS) {
      store.clear()
      const { waitForConfirmation, executor: exec } = executor(false)
      const result = await setKey(exec, item.key, item.value)
      expect(result.success).toBe(false)
      expect(result.error).toContain('未确认')
      expect(store.has(item.key.split('.')[0])).toBe(false)
      expect(waitForConfirmation).toHaveBeenCalledWith(
        'call-1',
        'config_set',
        { key: item.key, value: item.value },
        'dangerous',
        expect.any(String),
      )
    }
  })

  it('writes a sensitive key after confirmation', async () => {
    const { executor: exec } = executor(true)
    const result = await setKey(exec, 'aiRules', '不要删生产库')
    expect(result.success).toBe(true)
    expect(store.get('aiRules')).toBe('不要删生产库')
  })

  it('writes font size and theme without asking', async () => {
    const { waitForConfirmation, executor: exec } = executor(false)
    const font = await setKey(exec, 'terminalSettings.fontSize', 16)
    const theme = await setKey(exec, 'uiTheme', 'dark')
    expect(font.success).toBe(true)
    expect(theme.success).toBe(true)
    expect(store.get('terminalSettings')).toEqual({ fontSize: 16 })
    expect(store.get('uiTheme')).toBe('dark')
    expect(waitForConfirmation).not.toHaveBeenCalled()
  })

  it('rejects an invalid execution mode before asking', async () => {
    const { waitForConfirmation, executor: exec } = executor(true)
    const result = await setKey(exec, 'imExecutionMode', 'yolo')
    expect(result.success).toBe(false)
    expect(store.has('imExecutionMode')).toBe(false)
    expect(waitForConfirmation).not.toHaveBeenCalled()
  })
})
