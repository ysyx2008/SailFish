import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WeChatHeldByOtherInstanceError } from '../im/wechat-adapter'

const harness = vi.hoisted(() => ({
  start: vi.fn(async () => {}),
  showMessageBox: vi.fn(async () => ({ response: 0 })),
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp',
    getName: () => 'SailFish',
    getVersion: () => '0',
    isPackaged: false,
  },
  dialog: { showMessageBox: harness.showMessageBox },
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false }],
  },
}))

vi.mock('../config.service', () => ({
  getConfigService: () => ({
    get: () => undefined,
    set: () => {},
    getLanguage: () => 'zh-CN',
  }),
}))

vi.mock('../im/wechat-adapter', async () => {
  const actual = await vi.importActual<typeof import('../im/wechat-adapter')>('../im/wechat-adapter')
  class FakeWeChatAdapter {
    onMessage: unknown = null
    onSoftSendFailure: unknown = null
    onConnectionChange: unknown = null
    isConnected() { return false }
    async stop() {}
    start() { return harness.start() }
  }
  return { ...actual, WeChatAdapter: FakeWeChatAdapter }
})

import { IMService } from '../im/im.service'

describe('微信被另一个旗鱼占着', () => {
  beforeEach(() => {
    harness.start.mockReset()
    harness.showMessageBox.mockClear()
  })

  it('弹出对话框，并把说明交给调用方', async () => {
    harness.start.mockRejectedValue(new WeChatHeldByOtherInstanceError())
    const result = await new IMService().startWeChat({ enabled: true, token: 'tok', baseUrl: '' })

    expect(result.success).toBe(false)
    expect(result.error).toContain('另一个旗鱼')
    expect(harness.showMessageBox).toHaveBeenCalledTimes(1)
    const options = harness.showMessageBox.mock.calls[0][1]
    expect(options.message).toContain('另一个旗鱼')
    expect(options.title).toBe('微信没连上')
    expect(options.buttons).toEqual(['知道了'])
  })

  it('别的连接失败不弹这个对话框', async () => {
    harness.start.mockRejectedValue(new Error('network down'))
    const result = await new IMService().startWeChat({ enabled: true, token: 'tok', baseUrl: '' })

    expect(result.success).toBe(false)
    expect(result.error).toBe('network down')
    expect(harness.showMessageBox).not.toHaveBeenCalled()
  })
})
