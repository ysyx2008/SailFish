import { afterEach, describe, expect, it, vi } from 'vitest'
import { DeepSeekProvider } from '../providers/deepseek'

function mockFetch(body: unknown, status = 200) {
  const fn = vi.fn(async (_url: string, _init?: RequestInit) => new Response(
    typeof body === 'string' ? body : JSON.stringify(body),
    { status, headers: { 'Content-Type': 'application/json' } },
  ))
  vi.stubGlobal('fetch', fn)
  return fn
}

function sentInit(fn: ReturnType<typeof mockFetch>): RequestInit {
  return fn.mock.calls[0]?.[1] as unknown as RequestInit
}

function sentBody(fn: ReturnType<typeof mockFetch>): Record<string, unknown> {
  return JSON.parse(String(sentInit(fn).body)) as Record<string, unknown>
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('DeepSeekProvider', () => {
  it('sends the key as a Bearer token and asks for results without page text', async () => {
    const fn = mockFetch({ results: [] })
    const provider = new DeepSeekProvider(() => 'sk-key')
    await provider.search('旗鱼')
    expect(String(fn.mock.calls[0]?.[0])).toBe('https://api.deepseek.com/v1/tools/search')
    expect((sentInit(fn).headers as Record<string, string>).Authorization).toBe('Bearer sk-key')
    expect(sentBody(fn)).toEqual({ query: '旗鱼', count: 5, need_content: false })
  })

  it('gives the model the long summary and keeps the order of the results', async () => {
    mockFetch({
      results: [
        {
          rerank_score: 2.4,
          title: '第一条',
          url: 'https://example.com/a',
          snippet: '短摘要',
          summary: '长摘要',
          content: '',
          site_name: null,
          date: null,
          authority: 3,
        },
        { title: '第二条', url: 'https://example.com/b', snippet: '只有短摘要', summary: '' },
      ],
    })
    const results = await new DeepSeekProvider(() => 'key').search('旗鱼')
    expect(results).toEqual([
      { title: '第一条', url: 'https://example.com/a', snippet: '长摘要' },
      { title: '第二条', url: 'https://example.com/b', snippet: '只有短摘要' },
    ])
  })

  it('never passes page text on, even if the API returns it', async () => {
    mockFetch({
      results: [{ title: 't', url: 'https://example.com', summary: 's', content: '整页正文'.repeat(1000) }],
    })
    const [first] = await new DeepSeekProvider(() => 'key').search('旗鱼')
    expect(first.content).toBeUndefined()
  })

  it('truncates queries longer than 128 characters', async () => {
    const fn = mockFetch({ results: [] })
    await new DeepSeekProvider(() => 'key').search('智'.repeat(200))
    expect(sentBody(fn).query).toBe('智'.repeat(128))
  })

  it('counts characters, not UTF-16 units, when truncating', async () => {
    const fn = mockFetch({ results: [] })
    await new DeepSeekProvider(() => 'key').search('😀'.repeat(130))
    expect(Array.from(String(sentBody(fn).query))).toHaveLength(128)
  })

  it('keeps the result count within what the API accepts', async () => {
    const fn = mockFetch({ results: [] })
    const provider = new DeepSeekProvider(() => 'key')
    await provider.search('旗鱼', { maxResults: 500 })
    await provider.search('旗鱼', { maxResults: 0 })
    expect(JSON.parse(String(fn.mock.calls[0]?.[1]?.body)).count).toBe(50)
    expect(JSON.parse(String(fn.mock.calls[1]?.[1]?.body)).count).toBe(1)
  })

  it('returns no more than the requested number of results', async () => {
    const hits = Array.from({ length: 10 }, (_, i) => ({ title: `t${i}`, url: `https://example.com/${i}`, summary: 's' }))
    mockFetch({ results: hits })
    const results = await new DeepSeekProvider(() => 'key').search('旗鱼', { maxResults: 3 })
    expect(results).toHaveLength(3)
  })

  it('treats an empty result list as a normal answer', async () => {
    mockFetch({ results: [] })
    await expect(new DeepSeekProvider(() => 'key').search('冷门')).resolves.toEqual([])
  })

  it('rejects a missing key and an empty query without calling the API', async () => {
    const fn = mockFetch({ results: [] })
    await expect(new DeepSeekProvider(() => '').search('旗鱼')).rejects.toThrow('DeepSeek API key is not configured')
    await expect(new DeepSeekProvider(() => 'key').search('   ')).rejects.toThrow('DeepSeek search query is empty')
    expect(fn).not.toHaveBeenCalled()
  })

  it('surfaces the reason when the API refuses', async () => {
    mockFetch(JSON.stringify({ error: { message: 'Insufficient Balance', type: 'invalid_request_error', param: null } }), 402)
    await expect(new DeepSeekProvider(() => 'key').search('旗鱼')).rejects.toThrow('DeepSeek search failed: 402 Insufficient Balance')

    mockFetch('rate limited', 429)
    await expect(new DeepSeekProvider(() => 'key').search('旗鱼')).rejects.toThrow('DeepSeek search failed: 429 rate limited')
  })

  it('does not mistake an unexpected 200 answer for "nothing found"', async () => {
    const provider = new DeepSeekProvider(() => 'key')
    for (const body of ['null', '{}', '{"error":{"message":"gateway says no"}}', '{"results":"oops"}']) {
      mockFetch(body)
      await expect(provider.search('旗鱼')).rejects.toThrow('DeepSeek returned unexpected response')
    }
    mockFetch('{"error":{"message":"gateway says no"}}')
    await expect(provider.search('旗鱼')).rejects.toThrow('gateway says no')
  })

  it('skips entries in the list that are not objects', async () => {
    mockFetch({ results: [null, 'x', { title: '有效', url: 'https://example.com', summary: 's' }] })
    const results = await new DeepSeekProvider(() => 'key').search('旗鱼')
    expect(results).toEqual([{ title: '有效', url: 'https://example.com', snippet: 's' }])
  })

  it('reports a non-JSON answer with the start of the body', async () => {
    mockFetch('<html>gateway</html>')
    await expect(new DeepSeekProvider(() => 'key').search('旗鱼')).rejects.toThrow('DeepSeek returned non-JSON response: <html>gateway</html>')
  })

  it('still stops on its own timeout when the caller passes a signal, and follows the caller abort', async () => {
    const fn = mockFetch({ results: [] })
    const caller = new AbortController()
    await new DeepSeekProvider(() => 'key').search('旗鱼', { signal: caller.signal })
    const sent = sentInit(fn).signal as AbortSignal
    expect(sent.aborted).toBe(false)
    expect(sent).not.toBe(caller.signal)
    caller.abort()
    expect(sent.aborted).toBe(true)
  })
})
