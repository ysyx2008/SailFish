import * as fs from 'fs'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// vi.mock 调用会被 hoist 到文件顶部，引用的变量必须用 vi.hoisted。
const mocks = vi.hoisted(() => {
  class MockStreamingMarkdownFilter {
    feed = vi.fn((s: string) => s)
    flush = vi.fn(() => '')
  }
  return {
    sendMessageWeixin: vi.fn(),
    sendWeixinMediaFile: vi.fn(),
    vendoredGetUpdates: vi.fn(),
    apiGetFetch: vi.fn(),
    sendTyping: vi.fn(),
    getConfig: vi.fn(),
    getForUser: vi.fn(),
    invalidateUser: vi.fn(),
    pauseSession: vi.fn(),
    assertSessionActive: vi.fn(),
    downloadAndDecryptBuffer: vi.fn(),
    downloadPlainCdnBuffer: vi.fn(),
    notifyStop: vi.fn(),
    clearContextTokensForAccount: vi.fn(),
    StreamingMarkdownFilter: MockStreamingMarkdownFilter,
  }
})
const sendMessageWeixinMock = mocks.sendMessageWeixin
const sendWeixinMediaFileMock = mocks.sendWeixinMediaFile
const pauseSessionMock = mocks.pauseSession
const assertSessionActiveMock = mocks.assertSessionActive
const sendTypingMock = mocks.sendTyping
const getConfigMock = mocks.getConfig
const getForUserMock = mocks.getForUser
const invalidateUserMock = mocks.invalidateUser
const getUpdatesMock = mocks.vendoredGetUpdates
const downloadAndDecryptBufferMock = mocks.downloadAndDecryptBuffer

vi.mock('../im/wechat/messaging/send', () => ({
  sendMessageWeixin: mocks.sendMessageWeixin,
  StreamingMarkdownFilter: mocks.StreamingMarkdownFilter,
}))
vi.mock('../im/wechat/messaging/send-media', () => ({
  sendWeixinMediaFile: mocks.sendWeixinMediaFile,
}))
vi.mock('../im/wechat/api/api', () => ({
  apiGetFetch: mocks.apiGetFetch,
  getUpdates: mocks.vendoredGetUpdates,
  sendTyping: mocks.sendTyping,
  getConfig: mocks.getConfig,
  notifyStart: vi.fn().mockResolvedValue({ ret: 0 }),
  notifyStop: mocks.notifyStop,
}))
vi.mock('../im/wechat/api/config-cache', () => ({
  WeixinConfigManager: class {
    getForUser = mocks.getForUser
    invalidateUser = mocks.invalidateUser
  },
}))
vi.mock('../im/wechat/api/session-guard', () => ({
  STALE_TOKEN_ERRCODE: -14,
  assertSessionActive: mocks.assertSessionActive,
  pauseSession: mocks.pauseSession,
  getRemainingPauseMs: vi.fn(() => 0),
}))
vi.mock('../im/wechat/cdn/pic-decrypt', () => ({
  downloadAndDecryptBuffer: mocks.downloadAndDecryptBuffer,
  downloadPlainCdnBuffer: mocks.downloadPlainCdnBuffer,
}))
vi.mock('../im/wechat/storage/state-dir', () => ({
  resolveStateDir: () => '/tmp/sf-wechat-adapter-test-state',
}))
vi.mock('../im/wechat/messaging/inbound', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../im/wechat/messaging/inbound')>()
  return {
    ...actual,
    setContextToken: vi.fn(),
    restoreContextTokens: vi.fn(),
    clearContextTokensForAccount: mocks.clearContextTokensForAccount,
  }
})

vi.mock('../../utils/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

import { WeChatAdapter } from '../im/wechat-adapter'

describe('WeChatAdapter', () => {
  beforeEach(() => {
    sendMessageWeixinMock.mockReset()
    sendWeixinMediaFileMock.mockReset()
    pauseSessionMock.mockReset()
    assertSessionActiveMock.mockReset()
    sendTypingMock.mockReset()
    getConfigMock.mockReset()
    getForUserMock.mockReset()
    invalidateUserMock.mockReset()
    getUpdatesMock.mockReset()
    downloadAndDecryptBufferMock.mockReset()
    mocks.notifyStop.mockReset()
    mocks.notifyStop.mockResolvedValue({ ret: 0 })
    mocks.clearContextTokensForAccount.mockReset()
    sendMessageWeixinMock.mockResolvedValue({ messageId: 'cid-1' })
    sendWeixinMediaFileMock.mockResolvedValue({ messageId: 'cid-2' })
    sendTypingMock.mockResolvedValue(undefined)
    getConfigMock.mockResolvedValue({ ret: 0, typing_ticket: 'ticket-1' })
    getForUserMock.mockResolvedValue({ typingTicket: 'ticket-1' })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('sendText reports soft failure once until a new inbound arrives', async () => {
    sendMessageWeixinMock.mockResolvedValue({ messageId: 'cid-1', softFailed: true })
    const adapter = new WeChatAdapter({ token: 'tok' } as any)
    const onSoft = vi.fn()
    adapter.onSoftSendFailure = onSoft

    await adapter.sendText({ userId: 'u1', contextToken: 'ctx' }, 'hello')
    await adapter.sendText({ userId: 'u1', contextToken: 'ctx' }, 'again')
    expect(onSoft).toHaveBeenCalledTimes(1)
    expect(onSoft).toHaveBeenCalledWith('u1')

    await (adapter as any).dispatchInbound(
      { from_user_id: 'u1', context_token: 'ctx', item_list: [{ type: 1, text_item: { text: 'hi' } }] },
      [],
    )
    await adapter.sendText({ userId: 'u1', contextToken: 'ctx' }, 'after inbound')
    expect(onSoft).toHaveBeenCalledTimes(2)
  })

  it('empty inbound does not reset the soft-failure notice', async () => {
    sendMessageWeixinMock.mockResolvedValue({ messageId: 'cid-1', softFailed: true })
    const adapter = new WeChatAdapter({ token: 'tok' } as any)
    const onSoft = vi.fn()
    adapter.onSoftSendFailure = onSoft

    await adapter.sendText({ userId: 'u1', contextToken: 'ctx' }, 'hello')
    expect(onSoft).toHaveBeenCalledTimes(1)

    await (adapter as any).dispatchInbound(
      { from_user_id: 'u1', context_token: 'ctx', item_list: [] },
      [],
    )
    await adapter.sendText({ userId: 'u1', contextToken: 'ctx' }, 'still failing')
    expect(onSoft).toHaveBeenCalledTimes(1)
  })

  it('sendText forwards to vendored sendMessageWeixin with contextToken', async () => {
    const adapter = new WeChatAdapter({ token: 'tok-12345678' } as any)

    await adapter.sendText({ userId: 'u1', contextToken: 'ctx-abc' }, 'hello')

    expect(sendMessageWeixinMock).toHaveBeenCalledTimes(1)
    const arg = sendMessageWeixinMock.mock.calls[0][0]
    expect(arg.to).toBe('u1')
    expect(arg.text).toBe('hello')
    expect(arg.opts.contextToken).toBe('ctx-abc')
    expect(arg.opts.token).toBe('tok-12345678')
  })

  it('sendText truncates messages longer than 4000 chars', async () => {
    const adapter = new WeChatAdapter({ token: 'tok' } as any)
    const longText = 'a'.repeat(5000)

    await adapter.sendText({ userId: 'u1' }, longText)

    const arg = sendMessageWeixinMock.mock.calls[0][0]
    expect(arg.text.length).toBeLessThanOrEqual(4000)
    expect(arg.text.endsWith('(已截断)')).toBe(true)
  })

  it('sendImage forwards to vendored sendWeixinMediaFile', async () => {
    const adapter = new WeChatAdapter({ token: 'tok' } as any)

    await adapter.sendImage({ userId: 'u1', contextToken: 'ctx' }, '/tmp/x.jpg')

    expect(sendWeixinMediaFileMock).toHaveBeenCalledTimes(1)
    const arg = sendWeixinMediaFileMock.mock.calls[0][0]
    expect(arg.filePath).toBe('/tmp/x.jpg')
    expect(arg.to).toBe('u1')
    expect(arg.opts.contextToken).toBe('ctx')
    expect(arg.cdnBaseUrl).toContain('weixin.qq.com')
  })

  it('sendText surfaces send failure without pausing on errcode=-14 (pause handled in pollLoop)', async () => {
    sendMessageWeixinMock.mockRejectedValueOnce(
      new Error('sendMessage 200: {"ret":-14,"errmsg":"session expired"}'),
    )
    const adapter = new WeChatAdapter({ token: 'tok-abc' } as any)

    await expect(
      adapter.sendText({ userId: 'u1' }, 'hi'),
    ).rejects.toThrow(/session expired/)

    // 对齐官方 SDK：发送路径不再解析 body errcode，-14（会话过期）只由 pollLoop
    // 通过 resp.ret 统一处理，sendText 仅原样透传异常、不暂停会话。
    expect(pauseSessionMock).not.toHaveBeenCalled()
    expect(sendMessageWeixinMock).toHaveBeenCalledTimes(1)
  })

  it('sendText does NOT pause session for other errors', async () => {
    sendMessageWeixinMock.mockRejectedValue(
      new Error('sendMessage 500: {"errcode":-99,"errmsg":"unknown"}'),
    )
    const adapter = new WeChatAdapter({ token: 'tok' } as any)

    await expect(
      adapter.sendText({ userId: 'u1' }, 'hi'),
    ).rejects.toThrow()

    expect(pauseSessionMock).not.toHaveBeenCalled()
  })

  it('sendText calls assertSessionActive before vendored call', async () => {
    const calls: string[] = []
    assertSessionActiveMock.mockImplementation(() => calls.push('assert'))
    sendMessageWeixinMock.mockImplementation(async () => {
      calls.push('send')
      return { messageId: 'x' }
    })
    const adapter = new WeChatAdapter({ token: 'tok' } as any)

    await adapter.sendText({ userId: 'u1' }, 'hi')

    expect(calls).toEqual(['assert', 'send'])
  })

  it('sendText surfaces session-paused exception from assert', async () => {
    assertSessionActiveMock.mockImplementation(() => {
      throw new Error('session paused')
    })
    const adapter = new WeChatAdapter({ token: 'tok' } as any)

    await expect(adapter.sendText({ userId: 'u1' }, 'hi')).rejects.toThrow(/session paused/)
    expect(sendMessageWeixinMock).not.toHaveBeenCalled()
  })

  it('start throws when no token is set', async () => {
    const adapter = new WeChatAdapter({} as any)
    await expect(adapter.start()).rejects.toThrow(/login first/)
  })

  it('isConnected reports false initially', () => {
    const adapter = new WeChatAdapter({ token: 'tok' } as any)
    expect(adapter.isConnected()).toBe(false)
  })

  it('getCredentials returns current token and baseUrl', () => {
    const adapter = new WeChatAdapter({
      token: 'tok-xyz',
      baseUrl: 'https://example.test',
    } as any)
    expect(adapter.getCredentials()).toEqual({
      token: 'tok-xyz',
      baseUrl: 'https://example.test',
    })
  })

  it('sendText does NOT retry on errcode=-2 (aligned with official SDK)', async () => {
    // api 层把 -2 收成 softFailed，适配器不再刷新 config 后重试，sendmessage 只调用一次。
    sendMessageWeixinMock.mockResolvedValueOnce({ messageId: 'cid-1', softFailed: true })
    const adapter = new WeChatAdapter({ token: 'tok' } as any)

    await expect(
      adapter.sendText({ userId: 'u1', contextToken: 'ctx-1' }, 'hello'),
    ).resolves.toBeUndefined()

    expect(sendMessageWeixinMock).toHaveBeenCalledTimes(1)
  })

  it('beginOutboundSession and endOutboundSession are exposed on adapter', async () => {
    const adapter = new WeChatAdapter({ token: 'tok' } as any)
    expect(typeof adapter.beginOutboundSession).toBe('function')
    expect(typeof adapter.endOutboundSession).toBe('function')
    await expect(adapter.beginOutboundSession({ userId: 'u1' })).resolves.toBeUndefined()
    adapter.endOutboundSession({ userId: 'u1' })
  })

  it('beginOutboundSession fires sendTyping immediately and endOutboundSession sends CANCEL', async () => {
    const adapter = new WeChatAdapter({ token: 'tok' } as any)
    await adapter.beginOutboundSession({ userId: 'u1', contextToken: 'ctx-1' })

    // 等 fire() 的微任务跑完
    await new Promise((r) => setImmediate(r))

    // 至少 fire 一次（status=TYPING=1）
    expect(sendTypingMock).toHaveBeenCalled()
    const typingCalls = sendTypingMock.mock.calls.filter((c) => c[0]?.body?.status === 1)
    expect(typingCalls.length).toBeGreaterThanOrEqual(1)
    expect(typingCalls[0][0].body.typing_ticket).toBe('ticket-1')

    adapter.endOutboundSession({ userId: 'u1' })
    await new Promise((r) => setImmediate(r))

    // CANCEL=2 应被发出
    const cancelCalls = sendTypingMock.mock.calls.filter((c) => c[0]?.body?.status === 2)
    expect(cancelCalls.length).toBe(1)
  })

  it('keepalive keeps firing on sendTyping failures without self-heal (aligned with official SDK)', async () => {
    // 让 fire 永远抛错；CANCEL 不算失败
    sendTypingMock.mockImplementation(({ body }: any) => {
      if (body?.status === 2) return Promise.resolve(undefined)
      return Promise.reject(
        new Error('/ilink/bot/sendtyping: errcode=-2 errmsg=invalid context'),
      )
    })

    vi.useFakeTimers()
    const adapter = new WeChatAdapter({ token: 'tok' } as any)
    await adapter.beginOutboundSession({ userId: 'u1', contextToken: 'ctx-1' })
    // 让初始 fire 的 .catch 链跑完
    await Promise.resolve(); await Promise.resolve()

    // begin 阶段会调用 getForUser（出站会话 + keepalive 各一次），之后失败不应再触发刷新
    const getForUserCallsAfterBegin = getForUserMock.mock.calls.length

    // 推进多次 5s interval：每次都按固定 ticket 重发，下次 interval 自然重试即可
    await vi.advanceTimersByTimeAsync(5_000)
    await vi.advanceTimersByTimeAsync(5_000)
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()

    const typingCalls = sendTypingMock.mock.calls.filter((c) => c[0]?.body?.status === 1)
    // 初始 fire + 2 次 interval = 至少 3 次
    expect(typingCalls.length).toBeGreaterThanOrEqual(3)
    // 失败只 log，不再 invalidateUser / 重新 getForUser 自愈重启
    expect(invalidateUserMock).not.toHaveBeenCalled()
    expect(getForUserMock.mock.calls.length).toBe(getForUserCallsAfterBegin)

    adapter.endOutboundSession({ userId: 'u1' })
    vi.useRealTimers()
  })

  it('sendText with active session does NOT retry or refresh ticket on errcode=-2', async () => {
    const adapter = new WeChatAdapter({ token: 'tok' } as any)
    await adapter.beginOutboundSession({ userId: 'u1', contextToken: 'ctx-1' })
    await Promise.resolve(); await Promise.resolve()

    sendMessageWeixinMock.mockResolvedValueOnce({ messageId: 'cid-1', softFailed: true })
    invalidateUserMock.mockClear()
    const getForUserCallsBefore = getForUserMock.mock.calls.length

    // 对齐官方 SDK：-2 不再重试，也不刷新 keepalive ticket
    await expect(
      adapter.sendText({ userId: 'u1', contextToken: 'ctx-1' }, 'hello'),
    ).resolves.toBeUndefined()

    expect(sendMessageWeixinMock).toHaveBeenCalledTimes(1)
    expect(invalidateUserMock).not.toHaveBeenCalled()
    expect(getForUserMock.mock.calls.length).toBe(getForUserCallsBefore)

    adapter.endOutboundSession({ userId: 'u1' })
  })

  it('sendProgressText buffers until flushProgress when bufferProgress enabled', async () => {
    vi.useFakeTimers()
    const adapter = new WeChatAdapter({ token: 'tok' } as any)
    await adapter.beginOutboundSession(
      { userId: 'u1', contextToken: 'ctx-1' },
      { bufferProgress: true },
    )
    await Promise.resolve()

    await adapter.sendProgressText({ userId: 'u1' }, '🔧 a')
    await adapter.sendProgressText({ userId: 'u1' }, '🔧 b')
    expect(sendMessageWeixinMock).not.toHaveBeenCalled()

    await adapter.flushProgress({ userId: 'u1' })
    await Promise.resolve()

    expect(sendMessageWeixinMock).toHaveBeenCalledTimes(1)
    expect(sendMessageWeixinMock.mock.calls[0][0].text).toContain('🔧 a')

    adapter.endOutboundSession({ userId: 'u1' })
    vi.useRealTimers()
  })

  it('downloads inbound media in parallel without blocking the next poll, then dispatches in order', async () => {
    const downloadStartedAt: number[] = []
    const downloadFinishedAt: number[] = []
    let pollCount = 0
    let secondPollAt = 0
    let releasePoll: (() => void) | undefined
    let pollingStopped = false

    downloadAndDecryptBufferMock.mockImplementation(async () => {
      downloadStartedAt.push(Date.now())
      await new Promise(r => setTimeout(r, 80))
      downloadFinishedAt.push(Date.now())
      return Buffer.from('media')
    })

    const aesKey = Buffer.alloc(16, 1).toString('base64')
    const imageMsg = (id: string) => ({
      from_user_id: 'u1',
      context_token: `ctx-${id}`,
      item_list: [{
        type: 2,
        image_item: { media: { full_url: `https://cdn.example/${id}`, aes_key: aesKey } },
      }],
    })
    const fileMsg = {
      from_user_id: 'u1',
      context_token: 'ctx-file',
      item_list: [{
        type: 4,
        file_item: {
          file_name: 'notes.pdf',
          media: { full_url: 'https://cdn.example/file', aes_key: aesKey },
        },
      }],
    }
    const textMsg = {
      from_user_id: 'u1',
      context_token: 'ctx-text',
      item_list: [{ type: 1, text_item: { text: '看这些' } }],
    }

    getUpdatesMock.mockImplementation(async () => {
      pollCount++
      if (pollCount === 1) {
        return {
          ret: 0,
          get_updates_buf: 'buf-1',
          msgs: [imageMsg('a'), fileMsg, imageMsg('b'), textMsg],
        }
      }
      if (pollCount === 2) secondPollAt = Date.now()
      if (pollingStopped) return { ret: 0, msgs: [] }
      await new Promise<void>(resolve => {
        releasePoll = () => {
          pollingStopped = true
          resolve()
        }
      })
      return { ret: 0, msgs: [] }
    })

    const received: Array<{ text: string; files: string[] }> = []
    const adapter = new WeChatAdapter({ token: 'tok' } as any)
    adapter.onMessage = (msg) => {
      received.push({
        text: msg.text,
        files: (msg.attachments ?? []).map(a => a.fileName),
      })
    }

    await adapter.start()
    await vi.waitFor(() => expect(received).toHaveLength(4), { timeout: 3000 })

    expect(downloadAndDecryptBufferMock).toHaveBeenCalledTimes(3)
    expect(downloadStartedAt[1]).toBeLessThan(downloadFinishedAt[0])
    expect(secondPollAt).toBeGreaterThan(0)
    expect(secondPollAt).toBeLessThan(Math.max(...downloadFinishedAt))

    expect(received[0].files[0]).toMatch(/^wechat_image_/)
    expect(received[1].files[0]).toBe('notes.pdf')
    expect(received[2].files[0]).toMatch(/^wechat_image_/)
    expect(received[3]).toEqual({ text: '看这些', files: [] })

    releasePoll?.()
    await adapter.stop()
  })

  describe('同一个微信只让先到的实例连', () => {
    const STATE_DIR = '/tmp/sf-wechat-adapter-test-state'
    const lockPathFor = (accountKey: string) =>
      path.join(STATE_DIR, 'openclaw-weixin', 'accounts', `${accountKey}.lock`)
    const lockPath = lockPathFor('sf-wechat-tok')

    /** 模拟本机另一个还活着的旗鱼实例（用父进程的进程号充当「另一个活着的进程」）。 */
    function plantForeignHolder(file = lockPath, pid = process.ppid) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify({ owner: 'other-instance', pid, startedAt: Date.now() }))
    }

    beforeEach(() => {
      fs.rmSync(lockPath, { force: true, recursive: true })
      // 长轮询一直挂着，不制造空转
      getUpdatesMock.mockImplementation(() => new Promise(() => {}))
    })
    afterEach(() => {
      fs.rmSync(lockPath, { force: true, recursive: true })
      fs.rmSync(lockPathFor('sf-wechat-other-account-12'), { force: true })
    })

    it('另一个旗鱼已经连着时：不连、不拉消息，并用人话说明原因', async () => {
      plantForeignHolder()
      const adapter = new WeChatAdapter({ token: 'tok' } as any)

      await expect(adapter.start()).rejects.toThrow(/另一个旗鱼里连着/)

      expect(getUpdatesMock).not.toHaveBeenCalled()
      expect(adapter.isConnected()).toBe(false)
    })

    it('没连上的实例退出时：不告诉微信下线、不清回信凭据、不动先到那个的租约', async () => {
      plantForeignHolder()
      const adapter = new WeChatAdapter({ token: 'tok' } as any)
      await adapter.start().catch(() => {})

      await adapter.stop()

      expect(mocks.notifyStop).not.toHaveBeenCalled()
      expect(mocks.clearContextTokensForAccount).not.toHaveBeenCalled()
      expect(JSON.parse(fs.readFileSync(lockPath, 'utf-8')).owner).toBe('other-instance')
    })

    it('连着的实例退出时：告诉微信下线并交还，之后别的实例能连上', async () => {
      const first = new WeChatAdapter({ token: 'tok' } as any)
      await first.start()
      expect(fs.existsSync(lockPath)).toBe(true)

      await first.stop()

      expect(mocks.notifyStop).toHaveBeenCalledTimes(1)
      expect(mocks.clearContextTokensForAccount).toHaveBeenCalledTimes(1)
      expect(fs.existsSync(lockPath)).toBe(false)

      const next = new WeChatAdapter({ token: 'tok' } as any)
      await expect(next.start()).resolves.toBeUndefined()
      await next.stop()
    })

    it('心跳之间租约已被别人接走：本实例退出时不告诉微信下线、不清回信凭据', async () => {
      const adapter = new WeChatAdapter({ token: 'tok' } as any)
      await adapter.start()
      // 租约在下一次心跳之前就被另一个实例换成了它的
      fs.writeFileSync(lockPath, JSON.stringify({ owner: 'other-instance', pid: process.ppid, startedAt: Date.now() }))

      await adapter.stop()

      expect(mocks.notifyStop).not.toHaveBeenCalled()
      expect(mocks.clearContextTokensForAccount).not.toHaveBeenCalled()
      expect(JSON.parse(fs.readFileSync(lockPath, 'utf-8')).owner).toBe('other-instance')
    })

    it('租约文件读写不了（权限等）：不挡着微信连接', async () => {
      // 把租约文件的位置占成一个目录：读它会报 EISDIR，属于意料之外的 IO 错误
      fs.mkdirSync(lockPath, { recursive: true })
      const adapter = new WeChatAdapter({ token: 'tok' } as any)

      await expect(adapter.start()).resolves.toBeUndefined()
      expect(adapter.isConnected()).toBe(true)

      await adapter.stop()
      fs.rmSync(lockPath, { recursive: true, force: true })
    })

    it('先到的实例崩了（进程已不在）：新来的直接连上，不用清任何文件', async () => {
      plantForeignHolder(lockPath, 2_147_483_646)
      const adapter = new WeChatAdapter({ token: 'tok' } as any)

      await expect(adapter.start()).resolves.toBeUndefined()

      await adapter.stop()
    })

    it('换了微信账号互不相干', async () => {
      plantForeignHolder()
      const adapter = new WeChatAdapter({ token: 'other-account-1234' } as any)

      await expect(adapter.start()).resolves.toBeUndefined()

      await adapter.stop()
    })
  })
})
