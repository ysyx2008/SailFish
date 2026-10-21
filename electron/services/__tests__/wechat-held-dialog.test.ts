import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WeChatHeldByOtherInstanceError } from '../im/wechat-adapter'

const harness = vi.hoisted(() => ({
  start: vi.fn(async () => {}),
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp',
    getName: () => 'SailFish',
    getVersion: () => '0',
    isPackaged: false,
  },
  BrowserWindow: { getAllWindows: () => [] },
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

function serviceWithDesktop() {
  const sent: Array<{ channel: string; data: { title?: string; message?: string } }> = []
  const svc = new IMService()
  svc.setDependencies({
    agentService: {} as never,
    mainWindow: {
      webContents: {
        send: (channel: string, data: { title?: string; message?: string }) => {
          sent.push({ channel, data })
        },
        isDestroyed: () => false,
      },
    },
  })
  return { svc, sent }
}

describe('微信被另一个旗鱼占着', () => {
  beforeEach(() => {
    harness.start.mockReset()
  })

  it('让界面弹出说明，一句一行', async () => {
    harness.start.mockRejectedValue(new WeChatHeldByOtherInstanceError())
    const { svc, sent } = serviceWithDesktop()
    const result = await svc.startWeChat({ enabled: true, token: 'tok', baseUrl: '' })

    expect(result.success).toBe(false)
    expect(result.error).toContain('另一个旗鱼')
    expect(sent).toHaveLength(1)
    expect(sent[0].channel).toBe('im:wechatHeld')
    expect(sent[0].data.title).toBe('微信没连上')
    expect(sent[0].data.message).toBe(
      '这个微信已经在另一个旗鱼里连着了。\n'
      + '同一个微信同一时间只能连在一个旗鱼里；\n'
      + '要换到这一个，请先退出另一个，再点连接。\n'
      + '如果另一个其实已经退出了，等一分钟再试。',
    )
  })

  it('别的连接失败不弹这个对话框', async () => {
    harness.start.mockRejectedValue(new Error('network down'))
    const { svc, sent } = serviceWithDesktop()
    const result = await svc.startWeChat({ enabled: true, token: 'tok', baseUrl: '' })

    expect(result.success).toBe(false)
    expect(result.error).toBe('network down')
    expect(sent).toHaveLength(0)
  })
})
