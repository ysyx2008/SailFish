/**
 * DeepSeek 联网搜索
 * API: POST https://api.deepseek.com/v1/tools/search
 *
 * 与对话模型分开的搜索接口，只有一档，鉴权和对话用同一把密钥。
 * 给模型读的是接口专门准备的长摘要；不请求网页正文——正文会随对话记录落盘。
 * 查询词接口上限 128 个字符，超出部分截掉再搜。
 */

import type { WebSearchProvider, WebSearchOptions, WebSearchResult } from '../types'
import { createLogger } from '../../../utils/logger'

const log = createLogger('WebSearch:DeepSeek')
const ENDPOINT = 'https://api.deepseek.com/v1/tools/search'
const QUERY_MAX_CHARS = 128
const COUNT_MAX = 50
const TIMEOUT_MS = 30_000

export class DeepSeekProvider implements WebSearchProvider {
  id = 'deepseek'
  name = 'DeepSeek'

  constructor(private apiKeyGetter: () => string) {}

  async search(query: string, options?: WebSearchOptions): Promise<WebSearchResult[]> {
    const apiKey = this.apiKeyGetter()
    if (!apiKey) throw new Error('DeepSeek API key is not configured')

    const searchQuery = clipQuery(query)
    if (!searchQuery) throw new Error('DeepSeek search query is empty')
    if (searchQuery !== query.trim()) {
      log.warn(`Query truncated to ${QUERY_MAX_CHARS} characters`)
    }

    const count = Math.min(Math.max(options?.maxResults ?? 5, 1), COUNT_MAX)

    const timeout = AbortSignal.timeout(TIMEOUT_MS)
    const resp = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: searchQuery, count, need_content: false }),
      signal: options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    })

    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new Error(`DeepSeek search failed: ${resp.status} ${readErrorDetail(text)}`)
    }

    const rawText = await resp.text()
    let data: DeepSeekResponse | null
    try {
      data = JSON.parse(rawText) as DeepSeekResponse | null
    } catch {
      throw new Error(`DeepSeek returned non-JSON response: ${rawText.slice(0, 200)}`)
    }
    // 没搜到时接口返回空数组。结构对不上不能当成没搜到，否则真正的原因就看不见了
    if (!Array.isArray(data?.results)) {
      throw new Error(`DeepSeek returned unexpected response: ${rawText.slice(0, 200)}`)
    }
    return mapResults(data.results).slice(0, count)
  }
}

function clipQuery(query: string): string {
  return Array.from(query.trim()).slice(0, QUERY_MAX_CHARS).join('')
}

/** 长摘要是给模型读的，优先用；没有时退回短摘要 */
function mapResults(items: unknown[]): WebSearchResult[] {
  return items
    .filter((item): item is DeepSeekHit => typeof item === 'object' && item !== null)
    .map(item => ({
      title: item.title || '',
      url: item.url || '',
      snippet: item.summary?.trim() || item.snippet?.trim() || '',
    }))
}

function readErrorDetail(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } }
    if (parsed.error?.message) return parsed.error.message
  } catch { /* 保留原文 */ }
  return text
}

interface DeepSeekHit {
  title?: string
  url?: string
  /** 短摘要，100~200 字，面向界面展示 */
  snippet?: string
  /** 长摘要，600~800 字，面向模型阅读 */
  summary?: string
}

interface DeepSeekResponse {
  results?: DeepSeekHit[]
}
