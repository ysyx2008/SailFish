import { afterEach, describe, expect, it, vi } from 'vitest'
import { ZhipuProvider } from '../providers/zhipu'
import { KimiProvider } from '../providers/kimi'

function mockFetch(body: unknown, status = 200) {
  const fn = vi.fn(async (_url: string, _init?: RequestInit) => new Response(
    typeof body === 'string' ? body : JSON.stringify(body),
    { status, headers: { 'Content-Type': 'application/json' } },
  ))
  vi.stubGlobal('fetch', fn)
  return fn
}

function sentBody(fn: ReturnType<typeof mockFetch>): Record<string, unknown> {
  const init = fn.mock.calls[0]?.[1] as unknown as RequestInit
  return JSON.parse(String(init.body)) as Record<string, unknown>
}

function sentUrl(fn: ReturnType<typeof mockFetch>): string {
  return String(fn.mock.calls[0]?.[0])
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ZhipuProvider', () => {
  it('maps search results and defaults to the basic engine', async () => {
    const fn = mockFetch({
      search_result: [
        { title: '标题', link: 'https://example.com/a', content: '摘要' },
      ],
    })
    const provider = new ZhipuProvider(() => 'key', () => '')
    const results = await provider.search('旗鱼')
    expect(sentUrl(fn)).toBe('https://open.bigmodel.cn/api/paas/v4/web_search')
    expect(sentBody(fn)).toEqual({
      search_query: '旗鱼',
      search_engine: 'search_std',
      search_intent: false,
      count: 5,
    })
    expect(results).toEqual([{ title: '标题', url: 'https://example.com/a', snippet: '摘要' }])
  })

  it('truncates queries longer than 70 characters', async () => {
    const fn = mockFetch({ search_result: [] })
    const provider = new ZhipuProvider(() => 'key', () => 'search_pro')
    const query = '智'.repeat(80)
    await provider.search(query)
    expect(sentBody(fn).search_query).toBe('智'.repeat(70))
    expect(sentBody(fn).search_engine).toBe('search_pro')
  })

  it('snaps Sogou result count up to the next allowed step and still returns the requested size', async () => {
    const pages = Array.from({ length: 10 }, (_, i) => ({
      title: `t${i}`,
      link: `https://example.com/${i}`,
      content: 's',
    }))
    const fn = mockFetch({ search_result: pages })
    const provider = new ZhipuProvider(() => 'key', () => 'search_pro_sogou')
    const results = await provider.search('新闻', { maxResults: 5 })
    expect(sentBody(fn).count).toBe(10)
    expect(results).toHaveLength(5)
  })

  it('does not send a result count to Quark', async () => {
    const fn = mockFetch({ search_result: [] })
    const provider = new ZhipuProvider(() => 'key', () => 'search_pro_quark')
    await provider.search('新闻', { maxResults: 5 })
    expect(sentBody(fn).count).toBeUndefined()
    expect(sentBody(fn).content_size).toBeUndefined()
  })

  it('rejects a missing key and surfaces the API error message', async () => {
    const provider = new ZhipuProvider(() => '', () => '')
    await expect(provider.search('旗鱼')).rejects.toThrow('Zhipu API key is not configured')

    mockFetch(JSON.stringify({ error: { message: '余额不足' } }), 429)
    const withKey = new ZhipuProvider(() => 'key', () => 'not-an-engine')
    await expect(withKey.search('旗鱼')).rejects.toThrow('Zhipu search failed: 429 余额不足')
  })
})

describe('KimiProvider', () => {
  it('calls Basic by default and maps title, url, and snippet', async () => {
    const fn = mockFetch({
      search_results: [
        { title: '页面', url: 'https://example.com', snippet: '摘要', text: '正文' },
      ],
    })
    const provider = new KimiProvider(() => 'key', () => '')
    const results = await provider.search('旗鱼')
    expect(sentUrl(fn)).toBe('https://api.moonshot.cn/v1/tools/search')
    expect(sentBody(fn)).toMatchObject({
      text_query: '旗鱼',
      limit: 5,
      include_content: false,
    })
    expect(results).toEqual([{
      title: '页面',
      url: 'https://example.com',
      snippet: '摘要',
      content: '正文',
    }])
  })

  it('calls Pro and keeps the relevant passages as content', async () => {
    const fn = mockFetch({
      search_results: [
        {
          title: '页面',
          url: 'https://example.com',
          snippet: '摘要',
          chunks: [{ text: '第一段' }, { text: '第二段' }],
        },
      ],
    })
    const provider = new KimiProvider(() => 'key', () => 'pro')
    const results = await provider.search('旗鱼', { maxResults: 3 })
    expect(sentUrl(fn)).toBe('https://api.moonshot.cn/v1/tools/search_pro')
    expect(sentBody(fn).limit).toBe(3)
    expect(sentBody(fn).include_content).toBeUndefined()
    expect(results).toEqual([{
      title: '页面',
      url: 'https://example.com',
      snippet: '摘要',
      content: '第一段\n\n第二段',
    }])
  })

  it('uses passages as the snippet when Pro omits the summary, without repeating them', async () => {
    mockFetch({
      search_results: [
        { title: '页面', url: 'https://example.com', chunks: [{ text: '只有片段' }] },
      ],
    })
    const provider = new KimiProvider(() => 'key', () => 'pro')
    await expect(provider.search('旗鱼')).resolves.toEqual([{
      title: '页面',
      url: 'https://example.com',
      snippet: '只有片段',
    }])
  })

  it('rejects a missing key and surfaces the API error message', async () => {
    const provider = new KimiProvider(() => '', () => 'pro')
    await expect(provider.search('旗鱼')).rejects.toThrow('Kimi API key is not configured')

    mockFetch(JSON.stringify({ error: { message: 'invalid api key' } }), 401)
    const withKey = new KimiProvider(() => 'key', () => 'basic')
    await expect(withKey.search('旗鱼')).rejects.toThrow('Kimi search failed: 401 invalid api key')
  })
})
