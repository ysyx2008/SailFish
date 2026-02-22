import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IMPlatform } from '../im/types'

const persistedState: { imLastContacts: Record<string, unknown> } = {
  imLastContacts: {}
}

vi.mock('../config.service', () => ({
  getConfigService: () => ({
    get: (key: string) => {
      if (key === 'imLastContacts') return persistedState.imLastContacts
      return undefined
    },
    set: (key: string, value: Record<string, unknown>) => {
      if (key === 'imLastContacts') persistedState.imLastContacts = value
    }
  })
}))

vi.mock('../agent/i18n', () => ({
  t: (key: string) => key
}))

import { IMService, type IMLastContact } from '../im/im.service'

type MockAdapter = {
  isConnected: ReturnType<typeof vi.fn>
  sendText: ReturnType<typeof vi.fn>
  sendMarkdown: ReturnType<typeof vi.fn>
}

function createContact(platform: IMPlatform, updatedAt: number): IMLastContact {
  return {
    platform,
    replyContext: { chatId: `${platform}-chat` },
    userId: 'user-1',
    userName: 'single-user',
    chatId: `${platform}-chat`,
    chatType: 'single',
    updatedAt
  }
}

function createAdapter(connected: boolean): MockAdapter {
  return {
    isConnected: vi.fn().mockReturnValue(connected),
    sendText: vi.fn().mockResolvedValue(undefined),
    sendMarkdown: vi.fn().mockResolvedValue(undefined)
  }
}

describe('IMService proactive notification routing', () => {
  beforeEach(() => {
    persistedState.imLastContacts = {}
    vi.clearAllMocks()
  })

  it('上次是钉钉但当前仅飞书在线时，应自动切换到飞书发送', async () => {
    const service = new IMService() as any
    const dingtalkAdapter = createAdapter(false)
    const feishuAdapter = createAdapter(true)

    service.dingtalkAdapter = dingtalkAdapter
    service.feishuAdapter = feishuAdapter

    const now = Date.now()
    const dingtalkContact = createContact('dingtalk', now - 10_000)
    const feishuContact = createContact('feishu', now - 5_000)

    service.lastContact = dingtalkContact
    service.contactsByPlatform = {
      dingtalk: dingtalkContact,
      feishu: feishuContact
    }

    const result = await service.sendNotification('hello')

    expect(result.success).toBe(true)
    expect(result.platform).toBe('feishu')
    expect(feishuAdapter.sendText).toHaveBeenCalledTimes(1)
    expect(dingtalkAdapter.sendText).not.toHaveBeenCalled()
  })

  it('lastContact 平台在线时应优先该平台，不跨渠道跳转', async () => {
    const service = new IMService() as any
    const dingtalkAdapter = createAdapter(true)
    const feishuAdapter = createAdapter(true)

    service.dingtalkAdapter = dingtalkAdapter
    service.feishuAdapter = feishuAdapter

    const now = Date.now()
    const dingtalkContact = createContact('dingtalk', now - 10_000)
    const feishuContact = createContact('feishu', now - 1_000)

    service.lastContact = dingtalkContact
    service.contactsByPlatform = {
      dingtalk: dingtalkContact,
      feishu: feishuContact
    }

    const result = await service.sendNotification('hello')

    expect(result.success).toBe(true)
    expect(result.platform).toBe('dingtalk')
    expect(dingtalkAdapter.sendText).toHaveBeenCalledTimes(1)
    expect(feishuAdapter.sendText).not.toHaveBeenCalled()
  })
})
