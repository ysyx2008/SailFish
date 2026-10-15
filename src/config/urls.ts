import type { LocaleType } from '../i18n'
import { oemResolved } from '@shared/oem-resolve'

function websiteBase(): string | null {
  const base = oemResolved.links.website
  if (!base) return null
  return base.replace(/\/$/, '')
}

/** 官网语言路径：zh-CN → /zh，en-US → 根路径 */
function websitePathForLocale(locale?: LocaleType): string {
  return locale === 'zh-CN' ? '/zh' : ''
}

/** 官网首页。写成空则没有官网。 */
export function getWebsiteUrl(locale?: LocaleType): string | null {
  const base = websiteBase()
  if (!base) return null
  const path = websitePathForLocale(locale)
  return path ? `${base}${path}/` : `${base}/`
}

/** 官网下载页（含 GitHub / 阿里云双源切换） */
export function getDownloadPageUrl(locale?: LocaleType): string | null {
  const base = websiteBase()
  if (!base) return null
  const path = websitePathForLocale(locale)
  return path ? `${base}${path}/#download` : `${base}/#download`
}

/** 官网更新日志页 */
export function getChangelogPageUrl(locale?: LocaleType): string | null {
  const base = websiteBase()
  if (!base) return null
  const path = websitePathForLocale(locale)
  return path ? `${base}${path}/changelog` : `${base}/changelog`
}
