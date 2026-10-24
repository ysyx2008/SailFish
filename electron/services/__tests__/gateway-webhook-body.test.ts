/**
 * 网关钩子：正文有上限；访问令牌不进日志，钩子令牌不进审计记录。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockLogInfo, watchHolder } = vi.hoisted(() => ({
  mockLogInfo: vi.fn(),
  watchHolder: {
    watch: null as null | { id: string; name: string; priority: number },
  },
}))

vi.mock('../../utils/logger', () => ({
  createLogger: () => ({
    info: mockLogInfo,
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

vi.mock('../web-chat.service', () => ({
  WebChatService: class {},
  VISIBLE_STEP_TYPES: new Set(),
}))

vi.mock('../watch/store', () => ({
  getWatchStore: () => ({ getWebhookWatch: () => watchHolder.watch }),
}))

vi.mock('../sensor/event-bus', () => ({
  getEventBus: () => ({ emit: vi.fn() }),
}))

import { GatewayService } from '../gateway.service'

const API_TOKEN = 'api-token-should-not-be-logged'
const HOOK_TOKEN = 'hook-token-should-not-be-in-audit'

describe('Gateway 钩子正文与令牌', () => {
  let service: GatewayService
  let baseUrl: string

  beforeEach(async () => {
    mockLogInfo.mockClear()
    watchHolder.watch = null
    service = new GatewayService()
    service.setDependencies({ webChatService: {} as never, mainWindow: null })
    const result = await service.start({
      enabled: true,
      port: 0,
      host: '127.0.0.1',
      apiToken: API_TOKEN,
    })
    expect(result.success).toBe(true)
    const address = (service as unknown as { server: { address(): { port: number } } }).server.address()
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterEach(async () => {
    await service.stop()
  })

  it('启动日志不包含访问令牌', () => {
    const logged = mockLogInfo.mock.calls.map(call => call.map(String).join(' ')).join('\n')
    expect(logged).not.toContain(API_TOKEN)
    expect(logged).toContain('Server started')
  })

  it('超过 1MB 的钩子正文停住，不进入关切', async () => {
    const response = await fetch(`${baseUrl}/hooks/${HOOK_TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'x'.repeat(1024 * 1024 + 1),
    })
    expect(response.status).toBe(413)
    expect(service.getAuditLog()).toHaveLength(0)
  })

  it('正常钩子照常排队，审计记录里没有钩子令牌', async () => {
    watchHolder.watch = { id: 'w1', name: '夜间备份', priority: 0 }
    const response = await fetch(`${baseUrl}/hooks/${HOOK_TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true }),
    })
    expect(response.status).toBe(200)
    const audit = JSON.stringify(service.getAuditLog())
    expect(audit).toContain('夜间备份')
    expect(audit).not.toContain(HOOK_TOKEN)
  })
})
