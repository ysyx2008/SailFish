import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  WechatProgressBuffer,
  WECHAT_PROGRESS_FLUSH_INTERVAL_MS,
  formatWechatProgressDigest,
} from '../im/wechat/progress-buffer'

describe('formatWechatProgressDigest', () => {
  it('joins tool lines with bullet prefix', () => {
    expect(
      formatWechatProgressDigest([
        { kind: 'tool', text: '🔧 read_file' },
        { kind: 'tool', text: '❌ calendar 失败' },
      ]),
    ).toBe('· 🔧 read_file\n· ❌ calendar 失败')
  })

  it('renders body entries without bullet prefix', () => {
    expect(
      formatWechatProgressDigest([
        { kind: 'tool', text: '🔧 read_file' },
        { kind: 'body', text: '我来查一下' },
      ]),
    ).toBe('· 🔧 read_file\n我来查一下')
  })

  it('returns empty string for no entries', () => {
    expect(formatWechatProgressDigest([])).toBe('')
  })
})

describe('WechatProgressBuffer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('flushes accumulated tool lines after interval', async () => {
    const send = vi.fn().mockResolvedValue(undefined)
    const buffer = new WechatProgressBuffer(send, {})

    buffer.push('🔧 a')
    buffer.push('🔧 b')
    expect(send).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(WECHAT_PROGRESS_FLUSH_INTERVAL_MS)
    await buffer.flush()

    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0]).toBe('· 🔧 a\n· 🔧 b')
  })

  it('dedupes consecutive identical tool lines', async () => {
    const send = vi.fn().mockResolvedValue(undefined)
    const buffer = new WechatProgressBuffer(send, {})

    buffer.push('🔧 same')
    buffer.push('🔧 same')
    await buffer.flush()

    expect(send.mock.calls[0][0]).toBe('· 🔧 same')
  })

  it('flush immediately when max tool lines reached', async () => {
    const send = vi.fn().mockResolvedValue(undefined)
    const buffer = new WechatProgressBuffer(send, { maxLines: 3 })

    buffer.push('1')
    buffer.push('2')
    buffer.push('3')
    await buffer.flush()

    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0]).toContain('· 1')
    expect(send.mock.calls[0][0]).toContain('· 3')
  })

  it('dispose flushes remaining without scheduling another timer', async () => {
    const send = vi.fn().mockResolvedValue(undefined)
    const buffer = new WechatProgressBuffer(send, {})

    buffer.push('pending')
    await buffer.dispose()

    expect(send).toHaveBeenCalledTimes(1)
    buffer.push('ignored')
    await buffer.flush()
    expect(send).toHaveBeenCalledTimes(1)
  })

  describe('body boundary-aware flush', () => {
    it('pushBody flushes existing tool progress before enqueuing body', async () => {
      const send = vi.fn().mockResolvedValue(undefined)
      const buffer = new WechatProgressBuffer(send, {})

      buffer.push('🔧 tool-a')
      buffer.push('🔧 tool-b')
      buffer.pushBody('我来查一下')

      // 工具进度先 flush，首条 body 紧接着即时 flush；await flush() 排空发送链
      await buffer.flush()
      expect(send).toHaveBeenCalledTimes(2)
      expect(send.mock.calls[0][0]).toBe('· 🔧 tool-a\n· 🔧 tool-b')
      expect(send.mock.calls[1][0]).toBe('我来查一下')
    })

    it('first pushBody flushes immediately so user gets quick feedback', async () => {
      const send = vi.fn().mockResolvedValue(undefined)
      const buffer = new WechatProgressBuffer(send, {})

      buffer.pushBody('正文')
      await buffer.flush()

      expect(send).toHaveBeenCalledTimes(1)
      expect(send.mock.calls[0][0]).toBe('正文')
    })

    it('subsequent pushBody still schedules flush timer for throttling', async () => {
      const send = vi.fn().mockResolvedValue(undefined)
      const buffer = new WechatProgressBuffer(send, {})

      buffer.pushBody('首条')
      await buffer.flush()
      expect(send).toHaveBeenCalledTimes(1)

      buffer.pushBody('后续正文')
      expect(send).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(WECHAT_PROGRESS_FLUSH_INTERVAL_MS)
      expect(send).toHaveBeenCalledTimes(2)
      expect(send.mock.calls[1][0]).toBe('后续正文')
    })

    it('subsequent body followed by tool progress within interval merges into one digest', async () => {
      const send = vi.fn().mockResolvedValue(undefined)
      const buffer = new WechatProgressBuffer(send, {})

      buffer.pushBody('首条')
      await buffer.flush()
      expect(send).toHaveBeenCalledTimes(1)

      buffer.pushBody('后续正文')
      buffer.push('🔧 read_file')

      expect(send).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(WECHAT_PROGRESS_FLUSH_INTERVAL_MS)
      await buffer.flush()

      expect(send).toHaveBeenCalledTimes(2)
      expect(send.mock.calls[1][0]).toBe('后续正文\n· 🔧 read_file')
    })

    it('body does not count toward maxLines', async () => {
      const send = vi.fn().mockResolvedValue(undefined)
      const buffer = new WechatProgressBuffer(send, { maxLines: 2 })

      buffer.pushBody('正文一')
      await buffer.flush()
      expect(send).toHaveBeenCalledTimes(1)
      expect(send.mock.calls[0][0]).toBe('正文一')

      buffer.pushBody('正文二')
      buffer.pushBody('正文三')
      // 后续 body 不触发 maxLines flush，仍等 timer / 显式 flush
      expect(send).toHaveBeenCalledTimes(1)

      await buffer.flush()
      expect(send).toHaveBeenCalledTimes(2)
      expect(send.mock.calls[1][0]).toBe('正文二\n正文三')
    })

    it('consecutive identical body lines are NOT deduped (each is a distinct message)', async () => {
      const send = vi.fn().mockResolvedValue(undefined)
      const buffer = new WechatProgressBuffer(send, {})

      // body 去重仅对工具进度生效，正文每段都是独立消息，不去重
      buffer.pushBody('我来查一下')
      await buffer.flush()
      expect(send).toHaveBeenCalledTimes(1)

      buffer.pushBody('我来查一下')
      await buffer.flush()

      expect(send).toHaveBeenCalledTimes(2)
      expect(send.mock.calls[0][0]).toBe('我来查一下')
      expect(send.mock.calls[1][0]).toBe('我来查一下')
    })

    it('fire-and-forget flush swallows send errors so later flushes still run', async () => {
      const send = vi.fn()
        .mockRejectedValueOnce(new Error('sendMessage ret=-2 errmsg=prepare failed'))
        .mockResolvedValue(undefined)
      const buffer = new WechatProgressBuffer(send, {})

      buffer.pushBody('首条')
      await expect(buffer.flush()).resolves.toBeUndefined()
      expect(send).toHaveBeenCalledTimes(1)

      buffer.pushBody('第二条')
      await buffer.flush()

      expect(send).toHaveBeenCalledTimes(2)
      expect(send.mock.calls[1][0]).toBe('第二条')
    })

    it('beginUserWait flushes what is already buffered and stops throttling until the user replies', async () => {
      const send = vi.fn().mockResolvedValue(undefined)
      const buffer = new WechatProgressBuffer(send, {})

      buffer.pushBody('首条')
      await buffer.flush()
      expect(send).toHaveBeenCalledTimes(1)

      buffer.pushBody('建好了：今晚和张翌吃饭。')
      expect(send).toHaveBeenCalledTimes(1)

      buffer.beginUserWait()
      await buffer.flush()
      expect(send).toHaveBeenCalledTimes(2)
      expect(send.mock.calls[1][0]).toBe('建好了：今晚和张翌吃饭。')

      buffer.pushBody('还在等你选')
      await buffer.flush()
      expect(send).toHaveBeenCalledTimes(3)
      expect(send.mock.calls[2][0]).toBe('还在等你选')

      buffer.endUserWait()
      buffer.pushBody('你选完了，这条再攒一会儿')
      expect(send).toHaveBeenCalledTimes(3)

      await vi.advanceTimersByTimeAsync(WECHAT_PROGRESS_FLUSH_INTERVAL_MS)
      expect(send).toHaveBeenCalledTimes(4)
      expect(send.mock.calls[3][0]).toBe('你选完了，这条再攒一会儿')
    })

    it('flushProgress (flush) on task end sends subsequent body even without follow-up tool', async () => {
      const send = vi.fn().mockResolvedValue(undefined)
      const buffer = new WechatProgressBuffer(send, {})

      buffer.pushBody('首条即时')
      await buffer.flush()

      // 模拟 ReAct 结束：后续 body 后没来工具通知，任务结束 flushProgress 切走
      buffer.pushBody('任务完成的最终正文')
      await buffer.flush()

      expect(send).toHaveBeenCalledTimes(2)
      expect(send.mock.calls[1][0]).toBe('任务完成的最终正文')
    })
  })
})
