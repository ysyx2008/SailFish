import { describe, expect, it } from 'vitest'
import type { WebSearchSettings } from '@shared/types'
import {
  executeWebSearchSettingsAction,
  formatWebSearchDetail,
  formatWebSearchSummary,
  type WebSearchSettingsStore,
} from '../web-search-settings'

const SECRET = 'sk-search-should-not-leak'
const MODEL_SECRET = 'sk-model-should-not-leak'

function makeStore(
  initial?: Partial<WebSearchSettings>,
  profiles: WebSearchSettingsStore['getAiProfiles'] extends () => infer R ? R : never = [],
): WebSearchSettingsStore & { saved?: WebSearchSettings } {
  const store: WebSearchSettingsStore & { saved?: WebSearchSettings } = {
    saved: initial as WebSearchSettings | undefined,
    getWebSearchSettings: () => store.saved,
    setWebSearchSettings: (settings) => { store.saved = settings },
    getAiProfiles: () => profiles,
    getActiveAiProfile: () => profiles[0]?.id || '',
  }
  return store
}

describe('format web search settings', () => {
  it('shows the current provider and key status without echoing the key', () => {
    const store = makeStore({
      enabled: true,
      providerId: 'kimi',
      apiKeys: { kimi: SECRET, bocha: 'bocha-secret' },
      apiExtras: { kimi: { tier: 'pro' } },
    })
    const summary = formatWebSearchSummary(store)
    expect(summary).toContain('已开启')
    expect(summary).toContain('当前使用')
    expect(summary).toContain('kimi')
    expect(summary).toContain('搜索密钥已填')
    expect(summary).toContain('tier=pro')
    expect(summary).toContain('config_web_search')
    expect(summary).not.toContain(SECRET)
    expect(summary).not.toContain('bocha-secret')

    const detail = formatWebSearchDetail(store)
    expect(detail).not.toContain(SECRET)
    expect(detail).toContain('tier=pro')
  })

  it('says the model key is reused when the search key is empty', () => {
    const store = makeStore(
      { enabled: true, providerId: 'bocha', apiKeys: {} },
      [{ id: 'k1', apiUrl: 'https://api.moonshot.cn/v1/chat/completions', apiKey: MODEL_SECRET }],
    )
    const summary = formatWebSearchSummary(store)
    expect(summary).toContain('沿用模型密钥')
    expect(summary).not.toContain(MODEL_SECRET)
  })

  it('lists DeepSeek and says its model key is reused', () => {
    const store = makeStore(
      { enabled: true, providerId: 'deepseek', apiKeys: {} },
      [{ id: 'd1', apiUrl: 'https://api.deepseek.com/chat/completions', apiKey: MODEL_SECRET }],
    )
    const summary = formatWebSearchSummary(store)
    expect(summary).toContain('DeepSeek')
    expect(summary).toContain('`deepseek` · 当前使用 · 沿用模型密钥')
    expect(summary).not.toContain(MODEL_SECRET)
  })
})

describe('executeWebSearchSettingsAction', () => {
  it('writes one provider key without wiping the others', () => {
    const store = makeStore({
      enabled: true,
      providerId: 'bocha',
      apiKeys: { bocha: 'bocha-secret' },
    })
    const result = executeWebSearchSettingsAction(store, {
      provider: 'kimi',
      apiKey: SECRET,
      setCurrent: true,
    })
    expect(result.success).toBe(true)
    expect(result.output).not.toContain(SECRET)
    expect(result.output).not.toContain('bocha-secret')
    expect(store.saved?.providerId).toBe('kimi')
    expect(store.saved?.apiKeys.kimi).toBe(SECRET)
    expect(store.saved?.apiKeys.bocha).toBe('bocha-secret')
  })

  it('keeps the existing key when apiKey is omitted, and clears it when empty', () => {
    const store = makeStore({
      enabled: true,
      providerId: 'kimi',
      apiKeys: { kimi: SECRET },
    })
    executeWebSearchSettingsAction(store, { provider: 'kimi', tier: 'pro' })
    expect(store.saved?.apiKeys.kimi).toBe(SECRET)
    expect(store.saved?.apiExtras?.kimi?.tier).toBe('pro')

    executeWebSearchSettingsAction(store, { provider: 'kimi', apiKey: '' })
    expect(store.saved?.apiKeys.kimi).toBeUndefined()
    expect(store.saved?.apiExtras?.kimi?.tier).toBe('pro')
  })

  it('rejects an engine the provider does not have, and an unknown engine value', () => {
    const store = makeStore({ enabled: true, providerId: 'bocha', apiKeys: {} })
    const wrongProvider = executeWebSearchSettingsAction(store, { provider: 'bocha', engine: 'search_pro' })
    expect(wrongProvider.success).toBe(false)
    expect(store.saved?.providerId).toBe('bocha')

    const badValue = executeWebSearchSettingsAction(store, { provider: 'zhipu', engine: 'bing' })
    expect(badValue.success).toBe(false)
    expect(badValue.error).toContain('search_std')
  })

  it('treats null as omitted, so a null key does not clear the saved one', () => {
    const store = makeStore({
      enabled: true,
      providerId: 'kimi',
      apiKeys: { kimi: SECRET },
    })
    const result = executeWebSearchSettingsAction(store, {
      provider: 'kimi',
      apiKey: null,
      enabled: null,
      setCurrent: null,
      tier: 'basic',
    })
    expect(result.success).toBe(true)
    expect(store.saved?.apiKeys.kimi).toBe(SECRET)
    expect(store.saved?.enabled).toBe(true)
    expect(store.saved?.apiExtras?.kimi?.tier).toBe('basic')
  })

  it('can switch to DeepSeek and write its key, and clears back to reusing the model key', () => {
    const store = makeStore({ enabled: true, providerId: 'bocha', apiKeys: { bocha: 'bocha-secret' } })
    const result = executeWebSearchSettingsAction(store, { provider: 'deepseek', apiKey: SECRET, setCurrent: true })
    expect(result.success).toBe(true)
    expect(result.output).not.toContain(SECRET)
    expect(store.saved?.providerId).toBe('deepseek')
    expect(store.saved?.apiKeys.deepseek).toBe(SECRET)
    expect(store.saved?.apiKeys.bocha).toBe('bocha-secret')

    executeWebSearchSettingsAction(store, { provider: 'deepseek', apiKey: '' })
    expect(store.saved?.apiKeys.deepseek).toBeUndefined()
  })

  it('tells the user DeepSeek has no tier to set', () => {
    const store = makeStore({ enabled: true, providerId: 'deepseek', apiKeys: {} })
    const result = executeWebSearchSettingsAction(store, { provider: 'deepseek', tier: 'pro' })
    expect(result.success).toBe(false)
    expect(result.error).toContain('DeepSeek')
    expect(store.saved?.apiExtras?.deepseek).toBeUndefined()
  })

  it('does not turn search on just by switching provider', () => {
    const store = makeStore({ enabled: false, providerId: 'bocha', apiKeys: {} })
    const result = executeWebSearchSettingsAction(store, { provider: 'kimi', setCurrent: true })
    expect(result.success).toBe(true)
    expect(store.saved?.enabled).toBe(false)
    expect(store.saved?.providerId).toBe('kimi')
    expect(result.output).toContain('已关闭')
  })
})
