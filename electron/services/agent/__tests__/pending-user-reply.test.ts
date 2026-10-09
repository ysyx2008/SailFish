import { describe, expect, it } from 'vitest'
import { takeQueuedUserReply } from '../pending-user-reply'
import type { PendingUserMessage } from '../types'

const image = 'data:image/jpeg;base64,QQ=='

describe('takeQueuedUserReply', () => {
  it('只有图、没有字时不算回答，整条留着当追加消息', () => {
    const queued: PendingUserMessage[] = [{ message: '', images: [image] }]
    const taken = takeQueuedUserReply(queued)
    expect(taken.reply).toBeUndefined()
    expect(taken.queue).toEqual(queued)
  })

  it('字和图一起发时，字用来答题，整条原样留着', () => {
    const queued: PendingUserMessage[] = [{
      message: '就用这张',
      images: [image],
      attachments: [{ filename: 'a.jpg', filePath: '/tmp/a.jpg', fileSize: 1, fileType: 'jpg' }],
    }]
    const taken = takeQueuedUserReply(queued)
    expect(taken.reply).toBe('就用这张')
    expect(taken.queue).toEqual([{ ...queued[0], consumedAsReply: true }])
  })

  it('输入框里的纯文字也整条留着，不会被答题收走', () => {
    const taken = takeQueuedUserReply([{ message: '再调一版' }])
    expect(taken.reply).toBe('再调一版')
    expect(taken.queue).toEqual([{ message: '再调一版', consumedAsReply: true }])
  })

  it('同一条字不能再答下一题', () => {
    const first = takeQueuedUserReply([{ message: '再调一版', images: [image] }])
    const second = takeQueuedUserReply(first.queue)
    expect(second.reply).toBeUndefined()
    expect(second.queue[0]?.message).toBe('再调一版')
    expect(second.queue[0]?.images).toEqual([image])
  })

  it('图排在前面时，跳过它去取后面的文字，两条都还在', () => {
    const taken = takeQueuedUserReply([
      { message: '  ', images: [image] },
      { message: '就用这张' },
    ])
    expect(taken.reply).toBe('就用这张')
    expect(taken.queue[0]).toEqual({ message: '  ', images: [image] })
    expect(taken.queue[1]).toEqual({ message: '就用这张', consumedAsReply: true })
  })

  it('点选项只答题，不留成追加消息', () => {
    const taken = takeQueuedUserReply([
      { message: '', images: [image] },
      { message: '就用这张', silent: true },
    ])
    expect(taken.reply).toBe('就用这张')
    expect(taken.queue).toEqual([{ message: '', images: [image] }])
  })

  it('后台通知不算回答', () => {
    const notice: PendingUserMessage = { message: '命令结束了', backgroundNotice: true }
    const taken = takeQueuedUserReply([notice])
    expect(taken.reply).toBeUndefined()
    expect(taken.queue).toEqual([notice])
  })
})