import { describe, expect, it } from 'vitest'
import { WEB_SEARCH_PROVIDERS, webSearchKeyFromModelProfiles } from '@shared/types'
import zhCN from './locales/zh-CN/settings'
import enUS from './locales/en-US/settings'

type WebSearchCopy = {
  providers: Record<string, string>
  useModelKey: Record<string, string>
  fields: Record<string, string>
  options: Record<string, string>
}

const locales: Array<[string, WebSearchCopy]> = [
  ['zh-CN', (zhCN as unknown as { settings: { webSearch: WebSearchCopy } }).settings.webSearch],
  ['en-US', (enUS as unknown as { settings: { webSearch: WebSearchCopy } }).settings.webSearch],
]

/** 能沿用模型密钥的服务商：给它一个 host 对得上的模型配置，能取到密钥 */
const sharesModelKey = (id: string) =>
  webSearchKeyFromModelProfiles(
    id,
    [
      { id: 'zhipu', apiUrl: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', apiKey: 'k' },
      { id: 'kimi', apiUrl: 'https://api.moonshot.cn/v1/chat/completions', apiKey: 'k' },
      { id: 'deepseek', apiUrl: 'https://api.deepseek.com/chat/completions', apiKey: 'k' },
    ],
  ) !== ''

describe.each(locales)('web search settings copy (%s)', (_name, copy) => {
  it('describes every search provider', () => {
    for (const provider of WEB_SEARCH_PROVIDERS) {
      expect(copy.providers[provider.id], `providers.${provider.id}`).toBeTruthy()
    }
  })

  it('has the "using the model key" hint for every provider that can reuse a model key', () => {
    for (const provider of WEB_SEARCH_PROVIDERS) {
      if (!sharesModelKey(provider.id)) continue
      expect(copy.useModelKey[provider.id], `useModelKey.${provider.id}`).toBeTruthy()
    }
  })

  it('names every extra field and every option the settings page can show', () => {
    for (const provider of WEB_SEARCH_PROVIDERS) {
      for (const field of provider.extraFields ?? []) {
        expect(copy.fields[field.key], `fields.${field.key}`).toBeTruthy()
        for (const option of field.options ?? []) {
          expect(copy.options[option.value], `options.${option.value}`).toBeTruthy()
        }
      }
    }
  })
})
