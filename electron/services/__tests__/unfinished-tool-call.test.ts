import { describe, it, expect, vi } from 'vitest'

vi.mock('../config.service', () => ({
  getConfigService: () => ({
    get: () => undefined,
    set: () => {}
  }),
  ConfigService: class {}
}))

vi.mock('../ai-debug.service', () => ({
  getAiDebugService: () => ({
    logRequestStart: () => {},
    logResponseChunk: () => {},
    logResponseDone: () => {},
    logResponseError: () => {}
  })
}))

vi.mock('../../utils/logger', () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {}
  })
}))

import { describeUnfinishedToolCalls, type ToolCall } from '../ai.service'

function call(partial: { id?: string; name?: string; arguments?: string }): ToolCall {
  return {
    id: partial.id ?? 'tc-1',
    type: 'function',
    function: {
      name: partial.name ?? 'dispatch_agents',
      arguments: partial.arguments ?? ''
    }
  }
}

describe('describeUnfinishedToolCalls', () => {
  it('omits a call whose arguments are already valid JSON', () => {
    const note = describeUnfinishedToolCalls([
      call({ arguments: '{"tasks":["a"]}' })
    ])
    expect(note).toBe('')
  })

  it('keeps the partial arguments of a call that was cut off and says it did not run', () => {
    const note = describeUnfinishedToolCalls([
      call({ id: 'tc-9', name: 'dispatch_agents', arguments: '{"tasks":[{"prompt":"查系统' })
    ])
    expect(note).toContain('没有执行')
    expect(note).toContain('dispatch_agents')
    expect(note).toContain('{"tasks":[{"prompt":"查系统')
  })

  it('treats a call without an id as unfinished and skips complete siblings', () => {
    const note = describeUnfinishedToolCalls([
      call({ id: 'done', arguments: '{"ok":true}' }),
      call({ id: '', name: 'read_file', arguments: '{"path":"/tmp' })
    ])
    expect(note).not.toContain('"ok":true')
    expect(note).toContain('read_file')
    expect(note).toContain('{"path":"/tmp')
  })
})
