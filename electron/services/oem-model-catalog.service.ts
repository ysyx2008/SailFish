/**
 * 按 OEM 配置里的清单地址取公司模型，并放进这个人的模型列表。
 * 取不到且没有上次的副本时，不改他已有的模型，只记下界面上要说的那句话。
 */
import http from 'node:http'
import https from 'node:https'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'
import { oemResolved } from '@shared/oem-resolve'
import {
  applyOemCatalog,
  parseOemCatalogDocument,
  sanitizeCachedCatalog,
  type OemCatalogModel,
  type OemModelNotice,
} from '@shared/oem-model-catalog'
import { createLogger } from '../utils/logger'
import type { ConfigService } from './config.service'

const log = createLogger('OemModels')
const CATALOG_TIMEOUT_MS = 15_000
const CATALOG_MAX_CHARS = 1_000_000

function proxyAgent(proxyUrl: string | undefined): HttpsProxyAgent<string> | SocksProxyAgent | undefined {
  if (!proxyUrl) return undefined
  return proxyUrl.startsWith('socks') ? new SocksProxyAgent(proxyUrl) : new HttpsProxyAgent(proxyUrl)
}

function readCatalogResponse(
  url: string,
  headers: Record<string, string>,
  proxyUrl: string | undefined,
): Promise<{ status: number; location?: string; text: string }> {
  return new Promise((resolve, reject) => {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch (err) {
      reject(err)
      return
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      reject(new Error('catalog url must be http(s)'))
      return
    }
    const lib = parsed.protocol === 'https:' ? https : http
    const req = lib.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers,
      timeout: CATALOG_TIMEOUT_MS,
      agent: proxyAgent(proxyUrl),
    }, (res) => {
      const length = Number(res.headers['content-length'])
      if (Number.isFinite(length) && length > CATALOG_MAX_CHARS) {
        req.destroy()
        reject(new Error('catalog too large'))
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > CATALOG_MAX_CHARS) {
          req.destroy()
          reject(new Error('catalog too large'))
          return
        }
        chunks.push(chunk)
      })
      res.on('end', () => {
        const location = res.headers.location
        resolve({
          status: res.statusCode ?? 0,
          location: Array.isArray(location) ? location[0] : location,
          text: Buffer.concat(chunks).toString('utf8'),
        })
      })
    })
    req.on('timeout', () => {
      req.destroy()
      reject(new Error('ETIMEDOUT'))
    })
    req.on('error', reject)
    req.end()
  })
}

async function fetchText(url: string, headers: Record<string, string>, proxyUrl: string | undefined, redirects = 0): Promise<string> {
  if (redirects > 3) throw new Error('too many redirects')
  const response = await readCatalogResponse(url, headers, proxyUrl)
  if (response.status >= 300 && response.status < 400 && response.location) {
    const next = new URL(response.location, url)
    if (next.protocol !== 'http:' && next.protocol !== 'https:') throw new Error('bad redirect')
    const nextHeaders = { ...headers }
    if (next.host !== new URL(url).host) delete nextHeaders.Authorization
    return fetchText(next.toString(), nextHeaders, proxyUrl, redirects + 1)
  }
  if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`)
  return response.text
}

async function fetchCatalog(
  url: string,
  auth: 'none' | 'login',
  proxyUrl: string | undefined,
): Promise<{ items: OemCatalogModel[] | null; notice: OemModelNotice }> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (auth === 'login') {
    const { getAuthService } = await import('./auth/auth.service')
    const authService = getAuthService()
    await authService.restoreSession()
    const token = await authService.getAccessToken()
    if (!token) return { items: null, notice: 'need-login' }
    headers.Authorization = `Bearer ${token}`
  }
  const text = await fetchText(url, headers, proxyUrl)
  return { items: parseOemCatalogDocument(JSON.parse(text)), notice: '' }
}

/** @returns 这次有没有改到用户能看见的配置。没改就不必通知界面重载。 */
export async function syncOemModelCatalog(config: ConfigService): Promise<boolean> {
  const { catalogUrl, auth } = oemResolved.models
  if (!catalogUrl) {
    if (config.get('oemModelNotice')) {
      config.set('oemModelNotice', '')
      return true
    }
    return false
  }

  const proxy = config.getProxySettings()
  const proxyUrl = proxy.enabled && proxy.url.trim() ? proxy.url.trim() : undefined

  let notice: OemModelNotice = ''
  let fresh: OemCatalogModel[] | null = null
  try {
    const fetched = await fetchCatalog(catalogUrl, auth, proxyUrl)
    notice = fetched.notice
    fresh = fetched.items
  } catch (err) {
    log.warn('公司模型清单没有取到:', err)
    notice = 'unavailable'
  }

  let notify = false
  let items = fresh
  if (!items) {
    const cached = sanitizeCachedCatalog(config.get('oemModelCatalogCache'))
    if (cached.length > 0 && notice !== 'need-login') {
      items = cached
      notice = ''
    }
  } else if (JSON.stringify(config.get('oemModelCatalogCache')) !== JSON.stringify(items)) {
    config.set('oemModelCatalogCache', items)
  }

  if (config.get('oemModelNotice') !== notice) {
    config.set('oemModelNotice', notice)
    notify = true
  }
  if (!items) return notify

  const result = applyOemCatalog(
    config.getAiProfiles(),
    config.getActiveAiProfile(),
    items,
  )
  if (!result.changed) return notify
  config.setAiProfiles(result.profiles)
  config.setActiveAiProfile(result.activeId)
  return true
}
