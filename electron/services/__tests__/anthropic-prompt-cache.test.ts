import { expect, it } from 'vitest'
import { cacheAnthropicMessageTail, normalizeAnthropicMessage } from '../anthropic-prompt-cache'

it('用户背景与工具结果均可作为缓存边界，后续请求前缀内容不改变', () => {
  const first: Record<string, unknown>[] = [{ role: 'user', content: '共同背景' }]
  first.forEach(message => normalizeAnthropicMessage(message, true))
  cacheAnthropicMessageTail(first)
  const second: Record<string, unknown>[] = [{ role: 'user', content: '共同背景' }, { role: 'assistant', content: [{ type: 'tool_use', id: '1', name: 'test', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: '1', content: '工具真实结果' }] }]
  second.forEach((message, i) => normalizeAnthropicMessage(message, i === 0))
  cacheAnthropicMessageTail(second)
  expect(second[0]).toEqual(first[0])
  expect((second[2].content as Record<string, unknown>[])[0].cache_control).toEqual({ type: 'ephemeral' })
  expect(second[2].content).toEqual([{ type: 'tool_result', tool_use_id: '1', content: '工具真实结果', cache_control: { type: 'ephemeral' } }])
})

it('只保留消息最近旧边界和末尾两个断点，为system和tools保留位置', () => {
  const messages = Array.from({ length: 10 }, (_, i) => ({ role: 'user', content: [{ type: 'text', text: `记录${i}`, cache_control: { type: 'ephemeral' } }] }))
  messages.push({ role: 'assistant', content: [{ type: 'text', text: '最新记录' }] } as typeof messages[number])
  cacheAnthropicMessageTail(messages)
  expect(messages.flatMap(message => message.content).filter(block => block.cache_control)).toHaveLength(2)
  expect(messages[9].content[0].cache_control).toEqual({ type: 'ephemeral' })
  expect(messages[10].content[0].cache_control).toEqual({ type: 'ephemeral' })
})

it('空消息不创建无效缓存块', () => {
  const messages = [{ role: 'assistant', content: '' }]
  normalizeAnthropicMessage(messages[0], true)
  cacheAnthropicMessageTail(messages)
  expect(messages[0].content).toEqual([{ type: 'text', text: '' }])
})
