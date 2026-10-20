/**
 * Web Search 服务
 * 管理搜索 Provider 注册、选择、代理设置
 */

import type { WebSearchProvider, WebSearchOptions, WebSearchResult } from './types'
import type { WebSearchSettings, WebSearchProviderId } from '@shared/types'
import { DEFAULT_WEB_SEARCH_SETTINGS, WEB_SEARCH_PROVIDERS, webSearchKeyFromModelProfiles } from '@shared/types'
import { getConfigService } from '../config.service'
import { createLogger } from '../../utils/logger'
import { BochaProvider } from './providers/bocha'
import { ZhipuProvider } from './providers/zhipu'
import { KimiProvider } from './providers/kimi'
import { DeepSeekProvider } from './providers/deepseek'
import { JinaProvider } from './providers/jina'
import { TavilyProvider } from './providers/tavily'
import { GoogleProvider } from './providers/google'

const log = createLogger('WebSearch')

const providers = new Map<string, WebSearchProvider>()
let currentSettings: WebSearchSettings = { ...DEFAULT_WEB_SEARCH_SETTINGS }

export function registerProvider(provider: WebSearchProvider): void {
  const old = providers.get(provider.id)
  if (old) {
    old.dispose?.()
  }
  providers.set(provider.id, provider)
  log.info(`Registered provider: ${provider.id}`)
}

export function removeProvider(id: string): void {
  const p = providers.get(id)
  if (p) {
    p.dispose?.()
    providers.delete(id)
  }
}

export function getProvider(id?: string): WebSearchProvider | undefined {
  return providers.get(id || currentSettings.providerId)
}

export function updateSettings(settings: WebSearchSettings): void {
  currentSettings = { ...settings }
}

export function getSettings(): WebSearchSettings {
  return { ...currentSettings }
}

/** 获取指定 provider 的 API Key。搜索没单独填时，智谱、Kimi、DeepSeek 沿用已配置的模型密钥。 */
export function getApiKey(providerId?: string): string {
  const id = providerId || currentSettings.providerId
  const own = currentSettings.apiKeys?.[id as WebSearchProviderId]?.trim() || ''
  if (own) return own
  try {
    const config = getConfigService()
    return webSearchKeyFromModelProfiles(id, config.getAiProfiles(), config.getActiveAiProfile())
  } catch (error) {
    log.warn('Failed to reuse model API key:', error)
    return ''
  }
}

/** 获取指定 provider 的额外配置字段（如 Google 的 cx） */
export function getApiExtra(providerId: string, key: string): string {
  return currentSettings.apiExtras?.[providerId as WebSearchProviderId]?.[key] || ''
}

export function isConfigured(): boolean {
  if (!currentSettings.enabled) return false
  const providerMeta = WEB_SEARCH_PROVIDERS.find(p => p.id === currentSettings.providerId)
  if (!providerMeta) return false
  if (providerMeta.requiresApiKey && !getApiKey()) return false
  if (providerMeta.extraFields) {
    for (const f of providerMeta.extraFields) {
      if (f.defaultValue) continue
      if (!getApiExtra(currentSettings.providerId, f.key)) return false
    }
  }
  return providers.has(currentSettings.providerId)
}

/**
 * 执行搜索。成功和失败都写入运行日志：哪一家、搜了什么、返回了哪些标题和链接。
 * 整页正文只留开头一段，避免一次搜索把日志撑满。
 */
export async function search(query: string, options?: WebSearchOptions): Promise<WebSearchResult[]> {
  const providerId = currentSettings.providerId
  const provider = providers.get(providerId)
  const asked = clipForLog(query, 500)
  if (!provider) {
    log.warn(`Search failed: provider=${providerId} not found, query=${asked}`)
    throw new Error(`Web search provider "${providerId}" not found`)
  }
  const started = Date.now()
  try {
    const results = await provider.search(query, options)
    const hits = results.map((result, index) => formatHit(result, index + 1)).join('\n')
    log.info(`Search ok: provider=${providerId}, ${Date.now() - started}ms, results=${results.length}, query=${asked}${hits ? `\n${hits}` : ''}`)
    return results
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.warn(`Search failed: provider=${providerId}, ${Date.now() - started}ms, query=${asked}: ${message}`)
    throw error
  }
}

function formatHit(result: WebSearchResult, index: number): string {
  const lines = [`  [${index}] ${clipForLog(result.title, 160)}`, `      ${result.url}`]
  if (result.snippet) lines.push(`      ${clipForLog(result.snippet, 240)}`)
  if (result.content) lines.push(`      content: ${clipForLog(result.content, 240)}`)
  return lines.join('\n')
}

function clipForLog(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, max)}…(${flat.length})`
}

/**
 * 初始化内置 provider
 */
export async function initWebSearch(settings: WebSearchSettings): Promise<void> {
  // Migrate removed providers to default
  const removed = ['duckduckgo', 'bing']
  if (removed.includes(settings.providerId as string)) {
    settings = { ...settings, providerId: DEFAULT_WEB_SEARCH_SETTINGS.providerId }
  }
  // Migrate legacy single apiKey → per-provider apiKeys
  if (settings.apiKey && (!settings.apiKeys || Object.keys(settings.apiKeys).length === 0)) {
    settings = { ...settings, apiKeys: { [settings.providerId]: settings.apiKey }, apiKey: undefined }
  }
  if (!settings.apiExtras) {
    settings = { ...settings, apiExtras: {} }
  }
  updateSettings(settings)

  registerProvider(new BochaProvider(() => getApiKey('bocha')))
  registerProvider(new ZhipuProvider(
    () => getApiKey('zhipu'),
    () => getApiExtra('zhipu', 'engine'),
  ))
  registerProvider(new KimiProvider(
    () => getApiKey('kimi'),
    () => getApiExtra('kimi', 'tier'),
  ))
  registerProvider(new DeepSeekProvider(() => getApiKey('deepseek')))
  registerProvider(new JinaProvider(() => getApiKey('jina')))
  registerProvider(new TavilyProvider(() => getApiKey('tavily')))
  registerProvider(new GoogleProvider(
    () => getApiKey('google'),
    () => getApiExtra('google', 'cx'),
  ))

  log.info(`Initialized with provider: ${settings.providerId}`)
}

export function dispose(): void {
  for (const p of providers.values()) {
    p.dispose?.()
  }
  providers.clear()
}
