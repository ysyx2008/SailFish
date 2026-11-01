import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import http from 'http'
import type { AddressInfo } from 'net'
import { AiService, type AiMessage, type ToolDefinition } from '../ai.service'

vi.mock('../ai-debug.service', () => ({ getAiDebugService: () => new Proxy({}, { get: () => () => {} }) }))
let server: http.Server
let apiUrl: string
const requests: Record<string, unknown>[] = []

beforeAll(async () => {
  server = http.createServer((request, response) => {
    let input = ''
    request.on('data', chunk => { input += chunk })
    request.on('end', () => {
      requests.push(JSON.parse(input))
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ id: 'fixture', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 1 } }))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/anthropic/v1/messages`
})
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())) })

it('真实HTTP请求保留稳定system断点、工具断点、历史user断点和合并tool_result末尾断点', async () => {
  const profile = { id: 'anthropic-cache-fixture', model: 'mock', name: 'mock', apiFormat: 'anthropic', apiUrl, apiKey: 'test-key', contextLength: 128000 }
  const ai = new AiService({ getAiProfiles: () => [profile], getActiveAiProfile: () => profile.id, get: () => false } as never)
  const tools: ToolDefinition[] = [{ type: 'function', function: { name: 'fixture', description: 'test', parameters: { type: 'object', properties: {} } } }]
  const messages: AiMessage[] = [
    { role: 'system', content: '通用规则\n<!-- CACHE_BREAK -->\n姓名：乙' },
    { role: 'user', content: '引用背景' },
    { role: 'user', content: '本次任务', _cacheBreakpoint: true },
  ]
  await ai.chatWithTools(messages, tools, profile.id, AbortSignal.timeout(5000))
  await ai.chatWithTools([...messages, { role: 'assistant', content: '', tool_calls: [{ id: '1', type: 'function', function: { name: 'fixture', arguments: '{}' } }, { id: '2', type: 'function', function: { name: 'fixture', arguments: '{}' } }] }, { role: 'tool', tool_call_id: '1', content: '结果甲' }, { role: 'tool', tool_call_id: '2', content: '结果乙' }], tools, profile.id, AbortSignal.timeout(5000))
  const [first, second] = requests as any[]
  expect(second.system).toEqual([{ type: 'text', text: '通用规则', cache_control: { type: 'ephemeral' } }, { type: 'text', text: '姓名：乙' }])
  expect(second.messages.slice(0, 2)).toEqual(first.messages)
  const tail = second.messages.at(-1)
  expect(tail.role).toBe('user')
  expect(tail.content).toEqual([{ type: 'tool_result', tool_use_id: '1', content: '结果甲' }, { type: 'tool_result', tool_use_id: '2', content: '结果乙', cache_control: { type: 'ephemeral' } }])
  expect((JSON.stringify(second).match(/cache_control/g) ?? [])).toHaveLength(4)
  expect(second.tools[0].cache_control).toEqual({ type: 'ephemeral' })
  expect(messages[2]._cacheBreakpoint).toBe(true)
}, 10000)
