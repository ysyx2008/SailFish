import { describe, expect, it } from 'vitest'
import {
  coalescePendingHandoff,
  decideFollowUpDrain,
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

  it('不是同一句时插到队首', () => {
    const queue = [{ id: 'q1', message: '后面那条' }]
    const pending = coalescePendingHandoff(['先说这句'])!
    const merged = mergePendingIntoQueue(queue, pending, (item) => ({ id: 'new', ...item }))
    expect(merged.map(item => item.message)).toEqual(['先说这句', '后面那条'])
  })
})
