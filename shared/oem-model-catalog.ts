/**
 * 公司模型清单：把一份小文档收成可放入的模型，并决定哪些该跟着清单走、哪些已经被用户改过。
 * 不联网。取清单和写入用户配置在主进程里做。
 */
import type { AiProfile, ApiFormat } from '@shared/types'

export interface OemCatalogModel {
  id: string
  name: string
  apiUrl: string
  model: string
  kind: 'text' | 'vision'
  /** 文本模型在对话里出现图片时改用的视觉模型，填对方在清单里的 id */
  vision?: string
  contextLength?: number
  maxOutputTokens?: number
  apiFormat?: ApiFormat
}

export interface OemModelSyncState {
  /** null = 还没成功看过清单，下次还要再试 */
  decided: 'seed' | 'skip' | null
  /** 用户删掉或改到不再跟随的清单 id，不再塞回来 */
  dismissed: string[]
  /** 上次清单写进这条时的内容摘要，用来认出用户后来改过 */
  fingerprints: Record<string, string>
}

export type OemModelNotice = '' | 'need-login' | 'unavailable'

export type BundledAuthDecision =
  | { type: 'passthrough' }
  | { type: 'omit' }
  | { type: 'bearer'; token: string }

const ID_RE = /^[A-Za-z0-9._-]{1,64}$/

export function emptyOemModelSync(): OemModelSyncState {
  return { decided: null, dismissed: [], fingerprints: {} }
}

export function profileIdForCatalog(catalogId: string): string {
  return `oem:${catalogId}`
}

export function normalizeOemModelSync(raw: unknown): OemModelSyncState {
  const empty = emptyOemModelSync()
  if (!raw || typeof raw !== 'object') return empty
  const value = raw as Partial<OemModelSyncState>
  const decided = value.decided === 'seed' || value.decided === 'skip' ? value.decided : null
  const dismissed = Array.isArray(value.dismissed)
    ? [...new Set(value.dismissed.filter((id): id is string => typeof id === 'string' && ID_RE.test(id)))]
    : []
  const fingerprints: Record<string, string> = {}
  if (value.fingerprints && typeof value.fingerprints === 'object') {
    for (const [id, fp] of Object.entries(value.fingerprints)) {
      if (ID_RE.test(id) && typeof fp === 'string') fingerprints[id] = fp
    }
  }
  return { decided, dismissed, fingerprints }
}

function optionalPositive(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return value
}

function optionalFormat(value: unknown): ApiFormat | undefined {
  if (value === 'auto' || value === 'openai' || value === 'anthropic') return value
  return undefined
}

function parseItem(raw: unknown, seen: Set<string>): OemCatalogModel | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Record<string, unknown>
  if (typeof item.id !== 'string' || !ID_RE.test(item.id) || seen.has(item.id)) return null
  if (typeof item.name !== 'string' || !item.name.trim()) return null
  if (typeof item.apiUrl !== 'string' || !item.apiUrl.trim()) return null
  if (typeof item.model !== 'string' || !item.model.trim()) return null
  if (item.kind !== 'text' && item.kind !== 'vision') return null
  try {
    const url = new URL(item.apiUrl.trim())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  } catch {
    return null
  }
  seen.add(item.id)
  const parsed: OemCatalogModel = {
    id: item.id,
    name: item.name.trim(),
    apiUrl: item.apiUrl.trim(),
    model: item.model.trim(),
    kind: item.kind,
  }
  if (typeof item.vision === 'string' && ID_RE.test(item.vision)) parsed.vision = item.vision
  const contextLength = optionalPositive(item.contextLength)
  if (contextLength !== undefined) parsed.contextLength = contextLength
  const maxOutputTokens = optionalPositive(item.maxOutputTokens)
  if (maxOutputTokens !== undefined) parsed.maxOutputTokens = maxOutputTokens
  const apiFormat = optionalFormat(item.apiFormat)
  if (apiFormat) parsed.apiFormat = apiFormat
  return parsed
}

function takeItems(list: unknown[]): OemCatalogModel[] {
  const seen = new Set<string>()
  const items = list
    .map(item => parseItem(item, seen))
    .filter((item): item is OemCatalogModel => item !== null)
  const byId = new Map(items.map(item => [item.id, item]))
  return items.map(item => {
    if (item.kind !== 'text' || !item.vision) return { ...item, vision: undefined }
    const target = byId.get(item.vision)
    if (!target || target.kind !== 'vision' || target.id === item.id) return { ...item, vision: undefined }
    return item
  })
}

/** 公司放在地址上的文档。没有一条能用就抛错，好让调用方改用上次的副本。 */
export function parseOemCatalogDocument(json: unknown): OemCatalogModel[] {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new Error('catalog document is not an object')
  }
  const models = (json as { models?: unknown }).models
  if (!Array.isArray(models)) throw new Error('catalog document has no models')
  const items = takeItems(models)
  if (items.length === 0) throw new Error('catalog document has no usable models')
  return items
}

/** 上次成功取到、存在本机的副本。坏了就当没有。 */
export function sanitizeCachedCatalog(json: unknown): OemCatalogModel[] {
  if (!Array.isArray(json)) return []
  return takeItems(json)
}

function toProfile(item: OemCatalogModel): AiProfile {
  return {
    id: profileIdForCatalog(item.id),
    oemCatalogId: item.id,
    name: item.name,
    apiUrl: item.apiUrl,
    apiKey: '',
    model: item.model,
    modelType: item.kind === 'vision' ? 'vision' : 'general',
    visionProfileId: item.kind === 'text' && item.vision ? profileIdForCatalog(item.vision) : undefined,
    contextLength: item.contextLength,
    maxOutputTokens: item.maxOutputTokens,
    apiFormat: item.apiFormat ?? 'auto',
  }
}

export interface ApplyOemCatalogResult {
  profiles: AiProfile[]
  activeId: string
  changed: boolean
}

/**
 * 公司模型和个人模型放在一起，互不覆盖。
 * 公司的按清单整份对齐：新的补上，改过的跟着清单变，清单里没有的去掉。
 * 个人的原样留下。当前默认还在就不动；没有可用的默认时，用第一条文本模型。
 */
export function applyOemCatalog(
  profiles: AiProfile[],
  activeId: string,
  catalog: OemCatalogModel[],
): ApplyOemCatalogResult {
  const personal = profiles.filter(profile => !profile.oemCatalogId)
  const company = catalog.map(item => toProfile(item))
  const nextProfiles = [...company, ...personal]
  const ids = new Set(nextProfiles.map(profile => profile.id))
  let nextActive = activeId
  if (!nextActive || !ids.has(nextActive)) {
    const firstText = company.find(profile => profile.modelType !== 'vision')
    nextActive = firstText?.id ?? company[0]?.id ?? personal[0]?.id ?? ''
  }
  const changed = nextActive !== activeId || JSON.stringify(profiles) !== JSON.stringify(nextProfiles)
  return { profiles: nextProfiles, activeId: nextActive, changed }
}

/**
 * 公司清单里的模型、用户又没另填钥匙时，对话带什么。
 * passthrough = 仍按用户自己填的钥匙走原来的请求头。
 */
export function bundledRequestAuth(
  profile: { apiKey?: string; oemCatalogId?: string },
  mode: 'none' | 'login',
  token: string | null,
): BundledAuthDecision {
  if (!profile.oemCatalogId || (profile.apiKey ?? '').trim()) return { type: 'passthrough' }
  if (mode !== 'login' || !token) return { type: 'omit' }
  return { type: 'bearer', token }
}
