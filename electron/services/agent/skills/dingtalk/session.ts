/**
 * 钉钉 API 会话管理
 * 复用 IM 配置中的 clientId / clientSecret，管理 access_token
 * 同时支持旧 API (oapi.dingtalk.com) 和新 API (api.dingtalk.com/v1.0)
 */

import { createLogger } from '../../../../utils/logger'

const log = createLogger('DingTalkSession')

const OLD_API_BASE = 'https://oapi.dingtalk.com'
const NEW_API_BASE = 'https://api.dingtalk.com'

let accessToken = ''
let tokenExpiresAt = 0
let currentClientId = ''
let currentClientSecret = ''

/**
 * 获取或刷新 access_token
 */
async function getAccessToken(clientId: string, clientSecret: string): Promise<string> {
  if (accessToken && Date.now() < tokenExpiresAt && currentClientId === clientId && currentClientSecret === clientSecret) {
    return accessToken
  }

  const url = `${OLD_API_BASE}/gettoken?appkey=${encodeURIComponent(clientId)}&appsecret=${encodeURIComponent(clientSecret)}`
  const response = await fetch(url)

  if (!response.ok) {
    throw new Error(`Failed to get access_token: HTTP ${response.status}`)
  }

  const result = await response.json() as any
  if (result.errcode !== 0) {
    throw new Error(`Failed to get access_token: ${result.errcode} ${result.errmsg}`)
  }

  accessToken = result.access_token
  tokenExpiresAt = Date.now() + (result.expires_in - 300) * 1000
  currentClientId = clientId
  currentClientSecret = clientSecret
  log.info('Access token refreshed')
  return accessToken
}

/**
 * 旧 API 请求（oapi.dingtalk.com）
 * access_token 通过 query string 传递
 */
export async function oapi(
  clientId: string,
  clientSecret: string,
  method: 'GET' | 'POST',
  apiPath: string,
  body?: Record<string, unknown>
): Promise<any> {
  const token = await getAccessToken(clientId, clientSecret)
  const separator = apiPath.includes('?') ? '&' : '?'
  const url = `${OLD_API_BASE}${apiPath}${separator}access_token=${token}`

  const options: RequestInit = { method }
  if (method === 'POST' && body) {
    options.headers = { 'Content-Type': 'application/json' }
    options.body = JSON.stringify(body)
  }

  const response = await fetch(url, options)
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`DingTalk oapi ${apiPath} failed: HTTP ${response.status} ${text}`)
  }

  const result = await response.json() as any
  if (result.errcode && result.errcode !== 0) {
    throw new Error(`DingTalk oapi ${apiPath} error: ${result.errcode} ${result.errmsg}`)
  }

  return result
}

/**
 * 新 API 请求（api.dingtalk.com/v1.0）
 * access_token 通过 x-acs-dingtalk-access-token header 传递
 */
export async function api(
  clientId: string,
  clientSecret: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  apiPath: string,
  body?: Record<string, unknown>
): Promise<any> {
  const token = await getAccessToken(clientId, clientSecret)
  const url = `${NEW_API_BASE}${apiPath}`

  const headers: Record<string, string> = {
    'x-acs-dingtalk-access-token': token,
  }
  const options: RequestInit = { method, headers }

  if (body && (method === 'POST' || method === 'PUT')) {
    headers['Content-Type'] = 'application/json'
    options.body = JSON.stringify(body)
  }

  const response = await fetch(url, options)
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`DingTalk API ${apiPath} failed: HTTP ${response.status} ${text}`)
  }

  const contentType = response.headers.get('content-type') || ''
  if (contentType.includes('application/json')) {
    return await response.json()
  }
  return {}
}

/**
 * 提取 API 错误信息
 */
export function extractApiError(err: any): string {
  if (err?.message) return err.message
  return String(err)
}

/**
 * 关闭会话（清空 token 缓存）
 */
export function closeSession(): void {
  accessToken = ''
  tokenExpiresAt = 0
  currentClientId = ''
  currentClientSecret = ''
  log.info('Session closed')
}
