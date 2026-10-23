import { describe, it, expect } from 'vitest'
import { findUnansweredToolCalls } from '../unanswered-calls'
import type { AiMessage } from '../../ai.service'

function call(id: string, name: string, args: Record<string, unknown> | string) {
  return { id, type: 'function' as const, function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } }
}

describe('找出没有记录结果的工具调用', () => {
  it('都有结果就一个也没有', () => {
    const messages: AiMessage[] = [
      { role: 'user', content: '做事' },
      { role: 'assistant', content: '', tool_calls: [call('1', 'read_file', { path: '/a' })] },
      { role: 'tool', content: 'ok', tool_call_id: '1' },
      { role: 'assistant', content: '好了' },
    ]
    expect(findUnansweredToolCalls(messages)).toEqual([])
  })

  it('同一批里有的有结果有的没有：只报没有的，带上动手的对象', () => {
    const messages: AiMessage[] = [
      { role: 'user', content: '做事' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          call('1', 'write_text_file', { path: '/a.md', content: 'x' }),
          call('2', 'exec', { command: 'npm install' }),
          call('3', 'web_search', { query: '旗鱼' }),
        ],
      },
      { role: 'tool', content: 'ok', tool_call_id: '1' },
    ]
    expect(findUnansweredToolCalls(messages)).toEqual([
      { tool: 'exec', target: 'npm install' },
      { tool: 'web_search', target: '旗鱼' },
    ])
  })

  it('参数读不出来也照样报工具名，只是没有对象', () => {
    const messages: AiMessage[] = [
      { role: 'assistant', content: '', tool_calls: [call('1', 'exec', '{坏的'), call('2', 'ping', '[]')] },
    ]
    expect(findUnansweredToolCalls(messages)).toEqual([{ tool: 'exec' }, { tool: 'ping' }])
  })

  it('没有任何调用就是空', () => {
    expect(findUnansweredToolCalls([])).toEqual([])
    expect(findUnansweredToolCalls([{ role: 'user', content: 'hi' }])).toEqual([])
  })
})
