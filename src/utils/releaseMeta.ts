import type { LocaleType } from '../i18n'
import { releaseMetaUrls } from '@shared/oem-resolve'

export interface ReleaseMeta {
  version: string
  summary: {
    zh: string
    en: string
  }
}

let cached: ReleaseMeta | null = null
let fetchPromise: Promise<ReleaseMeta | null> | null = null

export function getLocalizedSummary(meta: ReleaseMeta, locale: LocaleType): string | undefined {
  const text = locale === 'zh-CN' ? meta.summary.zh : meta.summary.en
  const trimmed = text?.replace(/^>\s*/, '').trim()
  return trimmed || undefined
}

export async function fetchReleaseMeta(force = false): Promise<ReleaseMeta | null> {
  if (!force && cached) return cached
  if (!force && fetchPromise) return fetchPromise

  fetchPromise = (async () => {
    for (const url of releaseMetaUrls()) {
      try {
        const res = await fetch(url, { cache: 'no-store' })
        if (!res.ok) continue
        const data = (await res.json()) as ReleaseMeta
        if (data?.version && (data.summary?.zh || data.summary?.en)) {
          cached = data
          return data
        }
      } catch {
        // 尝试下一个源
      }
    }
    return null
  })()

  const result = await fetchPromise
  if (!result) {
    fetchPromise = null
  }
  return result
}

export async function getReleaseSummary(version: string, locale: LocaleType): Promise<string | undefined> {
  const meta = await fetchReleaseMeta()
  if (!meta || meta.version !== version) return undefined
  return getLocalizedSummary(meta, locale)
}
