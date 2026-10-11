import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AiMessage, ChatWithToolsResult, ToolDefinition } from '../../ai.service'
import { MemoryRefresher, type MemoryRefreshDeps } from '../memory-refresh'

function conversation(chars: number): AiMessage[] {
  return [
    { role: 'system', content: '系统说明' },
    { role: 'user', content: 'x'.repeat(chars) },
    { role: 'assistant', content: '好的' },
  ]
}

function setup(reply: (call: number) => ChatWithToolsResult = () => ({ content: '<memory id="personal">\n## 偏好\n简洁\n</memory>' })) {
  let call = 0
  const chatWithTools = vi.fn(async (
    _messages: AiMessage[],
    _tools: ToolDefinition[],
    _profileId?: string,
    _signal?: AbortSignal,
    _options?: { toolChoice?: 'auto' | 'none'; maxOutputTokens?: number },
  ) => reply(call++))
  const applyRefreshResponse = vi.fn((_response: string, _ids: readonly string[]) => ['personal'])
  const buildRefreshInstruction = vi.fn((_ids: readonly string[], _visible: string) => '更新记忆')
  const deps: MemoryRefreshDeps = {
    chatWithTools,
    getTools: () => [],
    getProfileId: () => 'p',
    // 一个字符算一个 token，便于直观设门槛
    measurePrompt: msgs => msgs.reduce((n, m) => n + m.content.length, 0),
    measureFixed: msgs => msgs.filter(m => m.role === 'system').reduce((n, m) => n + m.content.length, 0),
    inputLimit: () => 1_000_000,
    knowledge: { buildRefreshInstruction, applyRefreshResponse, getMaxDocChars: () => 5000 },
  }
  const refresher = new MemoryRefresher(deps, { refreshEveryTokens: 1000, idleDelayMs: 50 })
  return { refresher, chatWithTools, applyRefreshResponse, buildRefreshInstruction }
}

const settle = () => new Promise(r => setImmediate(r))

describe('MemoryRefresher', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }))
  afterEach(() => vi.useRealTimers())

  it('攒够量：一轮跑完立刻问，前缀原样带上、指令接在末尾', async () => {
    const { refresher, chatWithTools } = setup()
    const prefix = conversation(2000)
    refresher.onRunEnd({ conversationId: 'c1', prefix, targets: ['personal'] })
    await vi.waitFor(() => expect(chatWithTools).toHaveBeenCalledTimes(1))
    const sent = chatWithTools.mock.calls[0][0] as AiMessage[]
    expect(sent.slice(0, prefix.length)).toEqual(prefix)
    expect(sent[sent.length - 1]).toEqual({ role: 'user', content: '更新记忆' })
  })

  it('没攒够：不立刻问，一阵没人说话再问', async () => {
    const { refresher, chatWithTools } = setup()
    refresher.onRunEnd({ conversationId: 'c1', prefix: conversation(100), targets: ['personal'] })
    await settle()
    expect(chatWithTools).not.toHaveBeenCalled()
    vi.advanceTimersByTime(50)
    await vi.waitFor(() => expect(chatWithTools).toHaveBeenCalledTimes(1))
  })

  it('新一轮开始就作罢空闲那次，跨轮累计到门槛再问', async () => {
    const { refresher, chatWithTools } = setup()
    refresher.onRunEnd({ conversationId: 'c1', prefix: conversation(600), targets: ['personal'] })
    refresher.onRunStart()
    vi.advanceTimersByTime(100)
    await settle()
    expect(chatWithTools).not.toHaveBeenCalled()
    refresher.onRunEnd({ conversationId: 'c1', prefix: conversation(1200), targets: ['local'] })
    await vi.waitFor(() => expect(chatWithTools).toHaveBeenCalledTimes(1))
  })

  it('几轮攒下的几份记忆一次问完', async () => {
    const { refresher, buildRefreshInstruction } = setup()
    refresher.onRunEnd({ conversationId: 'c1', prefix: conversation(100), targets: ['personal'] })
    refresher.onRunStart()
    refresher.onRunEnd({ conversationId: 'c1', prefix: conversation(2000), targets: ['root@prod'] })
    await vi.waitFor(() => expect(buildRefreshInstruction).toHaveBeenCalledTimes(1))
    expect(buildRefreshInstruction.mock.calls[0][0]).toEqual(['personal', 'root@prod'])
  })

  it('开头的系统说明已在里面的，交给记忆服务判断是否重附', async () => {
    const { refresher, buildRefreshInstruction } = setup()
    refresher.onRunEnd({ conversationId: 'c1', prefix: conversation(2000), targets: ['personal'] })
    await vi.waitFor(() => expect(buildRefreshInstruction).toHaveBeenCalled())
    expect(buildRefreshInstruction.mock.calls[0][1]).toBe('系统说明')
  })

  it('交接之前必问一次，哪怕没攒够', async () => {
    const { refresher, chatWithTools } = setup()
    const conv = conversation(10)
    await refresher.beforeHandoff(conv, ['personal'])
    expect(chatWithTools).toHaveBeenCalledTimes(1)
    expect((chatWithTools.mock.calls[0][0] as AiMessage[]).slice(0, conv.length)).toEqual(conv)
  })

  it('交接那一轮不按缩水后的规模倒算，不会立刻又问一次', async () => {
    const { refresher, chatWithTools } = setup()
    refresher.onRunEnd({ conversationId: 'c1', prefix: conversation(900), targets: ['personal'] })
    refresher.onRunStart()
    await refresher.beforeHandoff(conversation(1500), ['personal'])
    expect(chatWithTools).toHaveBeenCalledTimes(1)
    refresher.onRunEnd({ conversationId: 'c1', prefix: conversation(300), targets: ['personal'] })
    await settle()
    expect(chatWithTools).toHaveBeenCalledTimes(1)
  })

  it('换会话前把没记的补上，然后从头计数', async () => {
    const { refresher, chatWithTools } = setup()
    const prefix = conversation(100)
    refresher.onRunEnd({ conversationId: 'c1', prefix, targets: ['personal'] })
    await refresher.flush(prefix)
    expect(chatWithTools).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(100)
    await settle()
    expect(chatWithTools).toHaveBeenCalledTimes(1)
  })

  it('没有待记的：换会话不发请求', async () => {
    const { refresher, chatWithTools } = setup()
    await refresher.flush(conversation(100))
    expect(chatWithTools).not.toHaveBeenCalled()
  })

  it('模型转头去调工具：禁止调用后再要一次', async () => {
    const { refresher, chatWithTools, applyRefreshResponse } = setup(call => call === 0
      ? { content: '', tool_calls: [{ id: 't', type: 'function', function: { name: 'x', arguments: '{}' } }] }
      : { content: 'NO_CHANGE' })
    await refresher.beforeHandoff(conversation(10), ['personal'])
    expect(chatWithTools).toHaveBeenCalledTimes(2)
    expect(chatWithTools.mock.calls[1][4]).toMatchObject({ toolChoice: 'none' })
    expect(applyRefreshResponse).toHaveBeenCalledWith('NO_CHANGE', ['personal'])
  })

  it('请求失败：留到下次，不丢', async () => {
    const { refresher, chatWithTools } = setup(call => {
      if (call === 0) throw new Error('网络断了')
      return { content: 'NO_CHANGE' }
    })
    refresher.onRunEnd({ conversationId: 'c1', prefix: conversation(2000), targets: ['personal'] })
    await vi.waitFor(() => expect(chatWithTools).toHaveBeenCalledTimes(1))
    await settle()
    refresher.onRunStart()
    refresher.onRunEnd({ conversationId: 'c1', prefix: conversation(2010), targets: [] })
    vi.advanceTimersByTime(50)
    await vi.waitFor(() => expect(chatWithTools).toHaveBeenCalledTimes(2))
  })

  it('前一笔没回来：后一笔排在它后面', async () => {
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const order: string[] = []
    const { refresher, chatWithTools } = setup()
    chatWithTools.mockImplementationOnce(async () => {
      await gate
      order.push('first')
      return { content: 'NO_CHANGE' }
    })
    chatWithTools.mockImplementationOnce(async () => {
      order.push('second')
      return { content: 'NO_CHANGE' }
    })
    const first = refresher.beforeHandoff(conversation(10), ['personal'])
    const second = refresher.beforeHandoff(conversation(20), ['local'])
    release()
    await Promise.all([first, second])
    expect(order).toEqual(['first', 'second'])
  })

  it('上下文放不下这次请求：不硬发，待记的留到下次', async () => {
    const { refresher, chatWithTools, buildRefreshInstruction } = setup()
    const deps = (refresher as unknown as { deps: MemoryRefreshDeps }).deps
    deps.inputLimit = () => 10
    refresher.onRunEnd({ conversationId: 'c1', prefix: conversation(10), targets: ['personal'] })
    refresher.onRunStart()
    await refresher.beforeHandoff(conversation(2000), [])
    expect(chatWithTools).not.toHaveBeenCalled()

    deps.inputLimit = () => 1_000_000
    refresher.onRunEnd({ conversationId: 'c1', prefix: conversation(10), targets: [] })
    vi.advanceTimersByTime(50)
    await vi.waitFor(() => expect(chatWithTools).toHaveBeenCalledTimes(1))
    expect(buildRefreshInstruction.mock.calls.at(-1)?.[0]).toEqual(['personal'])
  })

  it('交接前那次失败：当场再试一次，原文还在手上', async () => {
    const { refresher, chatWithTools, applyRefreshResponse } = setup(call => {
      if (call === 0) throw new Error('网络抖了一下')
      return { content: 'NO_CHANGE' }
    })
    const conv = conversation(10)
    await refresher.beforeHandoff(conv, ['personal'])
    expect(chatWithTools).toHaveBeenCalledTimes(2)
    expect((chatWithTools.mock.calls[1][0] as AiMessage[]).slice(0, conv.length)).toEqual(conv)
    expect(applyRefreshResponse).toHaveBeenCalledTimes(1)
  })
})
