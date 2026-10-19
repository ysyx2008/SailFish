import { describe, expect, it } from 'vitest'
import { stepWarrantsNewMessageHint } from './new-message-hint'

describe('stepWarrantsNewMessageHint', () => {
  it('新的一步算新消息', () => {
    expect(stepWarrantsNewMessageHint(undefined, { type: 'tool_call', content: '派出 3 个伙计' })).toBe(true)
  })

  it('伙计进度只改卡片、正文没变，不算新消息', () => {
    const card = { type: 'tool_call', content: '派出 3 个伙计' }
    expect(stepWarrantsNewMessageHint(card, { ...card })).toBe(false)
  })

  it('同一句还在往下长，算新消息', () => {
    expect(stepWarrantsNewMessageHint(
      { type: 'message', content: '先把已经核实过' },
      { type: 'message', content: '先把已经核实过原文的给你' }
    )).toBe(true)
  })

  it('正文从过程行改成说出口的话，算新消息', () => {
    expect(stepWarrantsNewMessageHint(
      { type: 'thinking', content: '想一下' },
      { type: 'message', content: '想一下' }
    )).toBe(true)
  })
})
