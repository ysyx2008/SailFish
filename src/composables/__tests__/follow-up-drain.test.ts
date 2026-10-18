import { describe, expect, it } from 'vitest'
import {
  coalescePendingHandoff,
  decideFollowUpDrain,
  mergeHandbackText,
  withFailedAtHead,
  withRetried,
  turnFailureAlreadyVisible,
  mergePendingIntoQueue,
  optimisticPlaceholderConfirmedBy,
  type OptimisticStepLike,
} from '../follow-up-drain'

describe('decideFollowUpDrain', () => {
  const idle = { hasQueued: true, headEditing: false, tabAlive: true, agentRunning: false }

  it('上一轮已经空闲时开下一轮', () => {
    expect(decideFollowUpDrain(idle)).toBe('start')
  })

  it('界面还显示在忙时把队列留着，等空闲后再开', () => {
    expect(decideFollowUpDrain({ ...idle, agentRunning: true })).toBe('wait')
  })

  it('正在改、页关了、或队列空了，这一拍不动', () => {
    expect(decideFollowUpDrain({ ...idle, headEditing: true })).toBe('stop')
    expect(decideFollowUpDrain({ ...idle, tabAlive: false })).toBe('stop')
    expect(decideFollowUpDrain({ ...idle, hasQueued: false })).toBe('stop')
  })

  it('队列里有一条没送出去，整个队列停住，不往下开', () => {
    expect(decideFollowUpDrain({ ...idle, anyFailed: true })).toBe('stop')
  })
})

describe('mergeHandbackText', () => {
  it('输入框是空的，直接放回', () => {
    expect(mergeHandbackText('', '原话')).toBe('原话')
    expect(mergeHandbackText('  \n', '原话')).toBe('原话')
  })

  it('输入框里已有新打的字，放回的接在前面，不覆盖', () => {
    expect(mergeHandbackText('新打的', '原话')).toBe('原话\n新打的')
  })

  it('放回的是空话（只有图）时保留输入框原样', () => {
    expect(mergeHandbackText('新打的', '')).toBe('新打的')
  })
})

describe('没送出去的排队项', () => {
  type Item = { id: string; message: string; failed?: { reason: string } }
  const queueOf = (...ids: string[]): Item[] => ids.map(id => ({ id, message: `话-${id}` }))

  /** 模拟界面：空闲时按判定一条条取队首发送，发送出错就标成没送出去 */
  const drainAll = (initial: Item[], send: (item: Item) => void) => {
    let queue = initial
    const sent: string[] = []
    for (let guard = 0; guard < 20; guard++) {
      const decision = decideFollowUpDrain({
        hasQueued: queue.length > 0,
        headEditing: false,
        tabAlive: true,
        agentRunning: false,
        anyFailed: queue.some(item => item.failed),
      })
      if (decision !== 'start') break
      const [head, ...rest] = queue
      queue = rest
      try {
        send(head)
        sent.push(head.id)
      } catch (error) {
        queue = withFailedAtHead(queue, head, (error as Error).message)
      }
    }
    return { queue, sent }
  }

  it('三条排队、发送一直出错：只试队首一次，三条内容都还在', () => {
    let attempts = 0
    const { queue } = drainAll(queueOf('a', 'b', 'c'), () => {
      attempts++
      throw new Error('An object could not be cloned.')
    })
    expect(attempts).toBe(1)
    expect(queue.map(item => item.id)).toEqual(['a', 'b', 'c'])
    expect(queue[0].failed?.reason).toBe('An object could not be cloned.')
    expect(queue[1].failed).toBeUndefined()
  })

  it('原因消失后重试，三条按原来的顺序依次发完', () => {
    const stuck = drainAll(queueOf('a', 'b', 'c'), () => { throw new Error('x') }).queue
    const { queue, sent } = drainAll(withRetried(stuck, 'a'), () => {})
    expect(sent).toEqual(['a', 'b', 'c'])
    expect(queue).toEqual([])
  })

  it('队首之后的一条失败：重试时挪到队首，其余顺序不变', () => {
    const queue: Item[] = [
      { id: 'a', message: 'a' },
      { id: 'b', message: 'b', failed: { reason: 'x' } },
      { id: 'c', message: 'c' },
    ]
    expect(withRetried(queue, 'b').map(item => item.id)).toEqual(['b', 'a', 'c'])
    expect(withRetried(queue, 'b')[0].failed).toBeUndefined()
  })

  it('不是失败的条目，重试什么都不动', () => {
    const queue = queueOf('a', 'b')
    expect(withRetried(queue, 'b')).toBe(queue)
  })

  it('删掉失败的那条后，后面的恢复往下做', () => {
    const stuck = drainAll(queueOf('a', 'b'), () => { throw new Error('x') }).queue
    const afterRemove = stuck.filter(item => item.id !== 'a')
    const { sent } = drainAll(afterRemove, () => {})
    expect(sent).toEqual(['b'])
  })
})

describe('turnFailureAlreadyVisible', () => {
  it('更早那场的收场不能把这一轮的失败藏掉', () => {
    expect(turnFailureAlreadyVisible([
      { id: 'old_user', type: 'user_task' },
      { id: 'old_final', type: 'final_result' },
      { id: 'new_user', type: 'user_task' },
    ], 'new_user')).toBe(false)
  })

  it('这一轮自己已经收场就不用再补', () => {
    expect(turnFailureAlreadyVisible([
      { id: 'old_final', type: 'final_result' },
      { id: 'new_user', type: 'user_task' },
      { id: 'new_final', type: 'final_result' },
    ], 'new_user')).toBe(true)
  })

  it('临时气泡已经被正式步骤换掉时不再补一张', () => {
    expect(turnFailureAlreadyVisible([
      { id: 'old_final', type: 'final_result' },
      { id: 'real_user', type: 'user_task' },
    ], 'missing_optimistic')).toBe(true)
  })
})

describe('coalescePendingHandoff', () => {
  it('旧的纯文字也能收成下一轮', () => {
    expect(coalescePendingHandoff(['你这个图画的一般啊'])).toEqual({
      message: '你这个图画的一般啊',
    })
  })

  it('图和附件跟文字一起留下', () => {
    const handoff = coalescePendingHandoff([{
      message: '你这个图画的一般啊',
      images: ['data:image/png;base64,abc'],
      attachments: [{ filename: 'image.png', fileSize: 131600, fileType: 'png' }],
    }])
    expect(handoff?.message).toBe('你这个图画的一般啊')
    expect(handoff?.images).toEqual(['data:image/png;base64,abc'])
    expect(handoff?.attachments?.[0]?.filename).toBe('image.png')
  })

  it('只有空白时不开下一轮', () => {
    expect(coalescePendingHandoff(['  ', { message: '' }])).toBeNull()
  })

  it('用户自己的图和 PDF 页面图各归各位，给模型的图仍是全部', () => {
    const handoff = coalescePendingHandoff([{
      message: '看这份',
      images: ['user-1', 'page-1', 'page-2'],
      previewImages: ['user-1'],
      docPreviewImages: ['page-1', 'page-2'],
    }])
    expect(handoff?.images).toEqual(['user-1', 'page-1', 'page-2'])
    expect(handoff?.previewImages).toEqual(['user-1'])
    expect(handoff?.docPreviewImages).toEqual(['page-1', 'page-2'])
  })

  it('合并多条补话时，页面图不会混进用户的图里，顺序也不乱', () => {
    const handoff = coalescePendingHandoff([
      { message: '第一句', images: ['u1', 'p1'], previewImages: ['u1'], docPreviewImages: ['p1'] },
      { message: '第二句', images: ['u2', 'p2'], previewImages: ['u2'], docPreviewImages: ['p2'] },
    ])
    expect(handoff?.images).toEqual(['u1', 'p1', 'u2', 'p2'])
    expect(handoff?.previewImages).toEqual(['u1', 'u2'])
    expect(handoff?.docPreviewImages).toEqual(['p1', 'p2'])
  })

  it('用户没贴图、全是页面图：显示的图是空的，不退回去显示全部', () => {
    const handoff = coalescePendingHandoff([{
      message: '看这份',
      images: ['page-1'],
      previewImages: [],
      docPreviewImages: ['page-1'],
    }])
    expect(handoff?.previewImages).toEqual([])
    expect(handoff?.docPreviewImages).toEqual(['page-1'])
  })

  it('没说明怎么显示的老形状，图全部显示、没有页面图', () => {
    const handoff = coalescePendingHandoff([{ message: '看图', images: ['a', 'b'] }])
    expect(handoff?.previewImages).toEqual(['a', 'b'])
    expect(handoff?.docPreviewImages).toBeUndefined()
  })
})

describe('optimisticPlaceholderConfirmedBy', () => {
  const imageMessage: OptimisticStepLike = {
    id: '__optimistic_user_supplement_1',
    type: 'user_supplement',
    content: '你这个图画的一般啊',
    images: ['preview-png'],
    attachments: [{ filename: 'image.png' }],
  }

  it('另一句话接不住已经上墙的这句', () => {
    expect(optimisticPlaceholderConfirmedBy(imageMessage, {
      id: 'user_task_q',
      type: 'user_task',
      content: '？',
    })).toBe(false)
  })

  it('同一句但没带上图，也接不住', () => {
    expect(optimisticPlaceholderConfirmedBy(imageMessage, {
      id: 'user_task_text',
      type: 'user_task',
      content: '你这个图画的一般啊',
    })).toBe(false)
  })

  it('同一句而且图和附件都在，才换成正式的那条', () => {
    expect(optimisticPlaceholderConfirmedBy(imageMessage, {
      id: 'user_task_ok',
      type: 'user_task',
      content: '你这个图画的一般啊',
      images: ['full-png'],
      attachments: [{ filename: 'image.png' }],
    })).toBe(true)
    expect(optimisticPlaceholderConfirmedBy(imageMessage, {
      id: 'user_supplement_ok',
      type: 'user_supplement',
      content: '你这个图画的一般啊',
      images: ['full-png'],
      attachments: [{ filename: 'image.png' }],
    })).toBe(true)
  })

  it('正式的补充不会换掉另一条临时任务', () => {
    expect(optimisticPlaceholderConfirmedBy({
      id: '__optimistic_user_task_1',
      type: 'user_task',
      content: '你这个图画的一般啊',
    }, {
      id: 'user_supplement_other',
      type: 'user_supplement',
      content: '你这个图画的一般啊',
    })).toBe(false)
  })
})

describe('mergePendingIntoQueue', () => {
  it('同一句已经在队首时，把缺的图补上，不另起一条', () => {
    const queue = [{ id: 'q1', message: '你这个图画的一般啊' }]
    const pending = coalescePendingHandoff([{
      message: '你这个图画的一般啊',
      images: ['data:image/png;base64,abc'],
    }])!
    const merged = mergePendingIntoQueue(queue, pending, (item) => ({ id: 'new', ...item }))
    expect(merged).toHaveLength(1)
    expect(merged[0]?.images).toEqual(['data:image/png;base64,abc'])
    expect(merged[0]?.previewImages).toEqual(['data:image/png;base64,abc'])
  })

  it('补到队首那条上时，页面图也跟着补上，且不当成用户的图', () => {
    const queue = [{ id: 'q1', message: '看这份' }]
    const pending = coalescePendingHandoff([{
      message: '看这份',
      images: ['u1', 'p1'],
      previewImages: ['u1'],
      docPreviewImages: ['p1'],
    }])!
    const merged = mergePendingIntoQueue(queue, pending, (item) => ({ id: 'new', ...item }))
    expect(merged).toHaveLength(1)
    expect(merged[0]?.images).toEqual(['u1', 'p1'])
    expect(merged[0]?.previewImages).toEqual(['u1'])
    expect(merged[0]?.docPreviewImages).toEqual(['p1'])
  })

  it('不是同一句时插到队首', () => {
    const queue = [{ id: 'q1', message: '后面那条' }]
    const pending = coalescePendingHandoff(['先说这句'])!
    const merged = mergePendingIntoQueue(queue, pending, (item) => ({ id: 'new', ...item }))
    expect(merged.map(item => item.message)).toEqual(['先说这句', '后面那条'])
  })
})
