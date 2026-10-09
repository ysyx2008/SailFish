import { describe, expect, it } from 'vitest'
import { takeQueuedUserReply } from '../pending-user-reply'
import type { PendingUserMessage } from '../types'

const image = 'data:image/jpeg;base64,QQ=='

describe('takeQueuedUserReply', () => {
  it('只有图也算开口，整条留着当追加消息', () => {
    const queued: PendingUserMessage[] = [{ message: '', images: [image] }]
    const taken = takeQueuedUserReply(queued)
    expect(taken.take).toEqual({ kind: 'message' })
    expect(taken.queue).toEqual([{ ...queued[0], consumedAsReply: true }])
  })

  it('字和图一起发时不把字当成答案，整条原样留着', () => {
    const queued: PendingUserMessage[] = [{
      message: '就用这张',
      images: [image],
      attachments: [{ filename: 'a.jpg', filePath: '/tmp/a.jpg', fileSize: 1, fileType: 'jpg' }],
    }]
    const taken = takeQueuedUserReply(queued)
    expect(taken.take).toEqual({ kind: 'message' })
    expect(taken.queue).toEqual([{ ...queued[0], consumedAsReply: true }])
  })

  it('输入框里的纯文字也整条留着', () => {
    const taken = takeQueuedUserReply([{ message: '再调一版' }])
    expect(taken.take).toEqual({ kind: 'message' })
    expect(taken.queue).toEqual([{ message: '再调一版', consumedAsReply: true }])
  })

  it('同一条不能再结束下一次等待', () => {
    const first = takeQueuedUserReply([{ message: '再调一版', images: [image] }])
    const second = takeQueuedUserReply(first.queue)
    expect(second.take).toBeUndefined()
    expect(second.queue[0]?.message).toBe('再调一版')
    expect(second.queue[0]?.images).toEqual([image])
  })

  it('点选项是答案，同时排队的图仍留着', () => {
    const taken = takeQueuedUserReply([
      { message: '', images: [image] },
      { message: '就用这张', silent: true },
    ])
    expect(taken.take).toEqual({ kind: 'answer', text: '就用这张' })
    expect(taken.queue).toEqual([{ message: '', images: [image] }])
  })

  it('只有点选时不留成追加消息', () => {
    const taken = takeQueuedUserReply([{ message: '就用这张', silent: true }])
    expect(taken.take).toEqual({ kind: 'answer', text: '就用这张' })
    expect(taken.queue).toEqual([])
  })

  it('什么都没发不算开口', () => {
    const taken = takeQueuedUserReply([{ message: '   ' }])
    expect(taken.take).toBeUndefined()
    expect(taken.queue).toEqual([{ message: '   ' }])
  })

  it('后台通知不算开口', () => {
    const notice: PendingUserMessage = { message: '命令结束了', backgroundNotice: true }
    const taken = takeQueuedUserReply([notice])
    expect(taken.take).toBeUndefined()
    expect(taken.queue).toEqual([notice])
  })
})
