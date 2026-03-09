/**
 * 企业微信 API 会话管理
 * 复用 IM 配置中的 corpId / corpSecret，管理 access_token 并提供通用请求方法
 */

import { createLogger } from '../../../../utils/logger'

const log = createLogger('WeComSession')

const WECOM_API_BASE = 'https://qyapi.weixin.qq.com/cgi-bin'

let accessToken = ''
let tokenExpiresAt = 0
let currentCorpId = ''
let currentCorpSecret = ''

/**
 * 获取或刷新 access_token
 */
async function getAccessToken(corpId: string, corpSecret: string): Promise<string> {
  if (accessToken && Date.now() < tokenExpiresAt && currentCorpId === corpId && currentCorpSecret === corpSecret) {
    return accessToken
  }

  const url = `${WECOM_API_BASE}/gettoken?corpid=${encodeURIComponent(corpId)}&corpsecret=${encodeURIComponent(corpSecret)}`
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
  currentCorpId = corpId
  currentCorpSecret = corpSecret
  log.info('Access token refreshed')
  return accessToken
}

/**
 * 通用 API 请求（POST JSON，自动注入 access_token）
 */
export async function apiPost(
  corpId: string,
  corpSecret: string,
  apiPath: string,
  body: Record<string, unknown> = {}
): Promise<any> {
  const token = await getAccessToken(corpId, corpSecret)
  const url = `${WECOM_API_BASE}${apiPath}?access_token=${token}`

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`WeCom API ${apiPath} failed: HTTP ${response.status} ${text}`)
  }

  const result = await response.json() as any
  if (result.errcode && result.errcode !== 0) {
    throw new Error(`WeCom API ${apiPath} error: ${result.errcode} ${result.errmsg}`)
  }

  return result
}

/**
 * 通用 API 请求（GET，自动注入 access_token）
 */
export async function apiGet(
  corpId: string,
  corpSecret: string,
  apiPath: string,
  params: Record<string, string | number> = {}
): Promise<any> {
  const token = await getAccessToken(corpId, corpSecret)
  const searchParams = new URLSearchParams({ access_token: token })
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') searchParams.set(k, String(v))
  }
  const url = `${WECOM_API_BASE}${apiPath}?${searchParams.toString()}`

  const response = await fetch(url)
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`WeCom API ${apiPath} failed: HTTP ${response.status} ${text}`)
  }

  const result = await response.json() as any
  if (result.errcode && result.errcode !== 0) {
    throw new Error(`WeCom API ${apiPath} error: ${result.errcode} ${result.errmsg}`)
  }

  return result
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
  currentCorpId = ''
  currentCorpSecret = ''
  log.info('Session closed')
}
