/**
 * 飞书 OAuth 用户授权
 * 通过 BrowserWindow 完成 OAuth 流程，获取 user_access_token
 * 实现"以用户身份操作"，文档/表格/日程直接出现在用户的飞书空间
 */

import { BrowserWindow } from 'electron'
import { createLogger } from '../../../../utils/logger'
import { getConfigService } from '../../../config.service'
import { setCredential, getCredential, deleteCredential } from '../../../credential.service'

const log = createLogger('FeishuOAuth')

const CREDENTIAL_KEY = 'feishu:user_oauth'
const REDIRECT_URI = 'http://localhost:19286/oauth/feishu/callback'
const AUTH_URL = 'https://open.feishu.cn/open-apis/authen/v1/index'
const TOKEN_URL = 'https://open.feishu.cn/open-apis/authen/v2/oauth/token'
const REFRESH_URL = 'https://open.feishu.cn/open-apis/authen/v2/oauth/token'
const USER_INFO_URL = 'https://open.feishu.cn/open-apis/authen/v1/user_info'
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000

export interface FeishuOAuthToken {
  accessToken: string
  refreshToken: string
  expiresAt: number
  userName?: string
  openId?: string
}

export interface FeishuOAuthStatus {
  authorized: boolean
  userName?: string
  openId?: string
  expiresAt?: number
}

let cachedToken: FeishuOAuthToken | null = null

function getAppCredentials(): { appId: string; appSecret: string } {
  const configService = getConfigService()
  const appId = (configService.get('imFeishuAppId') as string) || ''
  const appSecret = (configService.get('imFeishuAppSecret') as string) || ''
  return { appId, appSecret }
}

async function loadStoredToken(): Promise<FeishuOAuthToken | null> {
  if (cachedToken) return cachedToken
  try {
    const raw = await getCredential(CREDENTIAL_KEY)
    if (!raw) return null
    cachedToken = JSON.parse(raw) as FeishuOAuthToken
    return cachedToken
  } catch {
    return null
  }
}

async function saveToken(token: FeishuOAuthToken): Promise<void> {
  cachedToken = token
  await setCredential(CREDENTIAL_KEY, JSON.stringify(token))

  const configService = getConfigService()
  configService.set('feishuOAuthUser', token.userName || '')
  configService.set('feishuOAuthOpenId', token.openId || '')
}

/**
 * 启动飞书 OAuth 授权流程（BrowserWindow）
 */
export async function startFeishuOAuth(): Promise<FeishuOAuthStatus> {
  const { appId, appSecret } = getAppCredentials()
  if (!appId || !appSecret) {
    throw new Error('Feishu App ID / App Secret not configured')
  }

  const state = Math.random().toString(36).substring(2, 15)
  const authParams = new URLSearchParams({
    app_id: appId,
    redirect_uri: REDIRECT_URI,
    state,
  })

  const authUrl = `${AUTH_URL}?${authParams.toString()}`

  const authWindow = new BrowserWindow({
    width: 600,
    height: 700,
    show: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  })

  return new Promise<FeishuOAuthStatus>((resolve, reject) => {
    let settled = false

    const handleCallback = async (url: string) => {
      try {
        const urlObj = new URL(url)
        const code = urlObj.searchParams.get('code')
        const error = urlObj.searchParams.get('error')
        const returnedState = urlObj.searchParams.get('state')

        if (error) {
          settled = true
          authWindow.close()
          reject(new Error(`OAuth failed: ${error}`))
          return
        }

        if (returnedState && returnedState !== state) {
          settled = true
          authWindow.close()
          reject(new Error('OAuth state mismatch'))
          return
        }

        if (!code) {
          settled = true
          authWindow.close()
          reject(new Error('No authorization code received'))
          return
        }

        settled = true
        authWindow.close()

        const token = await exchangeCode(appId, appSecret, code)
        const userInfo = await fetchUserInfo(token.accessToken)

        const fullToken: FeishuOAuthToken = {
          ...token,
          userName: userInfo.name,
          openId: userInfo.openId,
        }
        await saveToken(fullToken)

        log.info(`OAuth authorized as: ${userInfo.name}`)
        resolve({
          authorized: true,
          userName: userInfo.name,
          openId: userInfo.openId,
          expiresAt: token.expiresAt,
        })
      } catch (err) {
        settled = true
        if (!authWindow.isDestroyed()) authWindow.close()
        reject(err)
      }
    }

    const isCallbackUrl = (url: string) => {
      try {
        const u = new URL(url)
        return u.origin === 'http://localhost:19286' && u.pathname === '/oauth/feishu/callback'
      } catch { return false }
    }

    authWindow.webContents.on('will-redirect', (event, url) => {
      if (isCallbackUrl(url)) {
        event.preventDefault()
        handleCallback(url)
      }
    })

    authWindow.webContents.on('will-navigate', (event, url) => {
      if (isCallbackUrl(url)) {
        event.preventDefault()
        handleCallback(url)
      }
    })

    authWindow.on('closed', () => {
      if (!settled) {
        reject(new Error('User cancelled OAuth'))
      }
    })

    authWindow.loadURL(authUrl)
  })
}

async function exchangeCode(
  appId: string, appSecret: string, code: string
): Promise<{ accessToken: string; refreshToken: string; expiresAt: number }> {
  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: appId,
      client_secret: appSecret,
      code,
      redirect_uri: REDIRECT_URI,
    }),
  })

  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`Token exchange failed (${resp.status}): ${text}`)
  }

  const data = await resp.json()
  if (data.code && data.code !== 0) {
    throw new Error(`Token exchange error: ${data.msg || JSON.stringify(data)}`)
  }

  const accessToken = data.access_token || data.data?.access_token
  const refreshToken = data.refresh_token || data.data?.refresh_token
  const expiresIn = data.expires_in || data.data?.expires_in || 6900

  if (!accessToken) {
    throw new Error('No access_token in response')
  }

  return {
    accessToken,
    refreshToken: refreshToken || '',
    expiresAt: Date.now() + expiresIn * 1000,
  }
}

async function fetchUserInfo(accessToken: string): Promise<{ name: string; openId: string }> {
  const resp = await fetch(USER_INFO_URL, {
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}` },
  })

  if (!resp.ok) {
    log.warn('Failed to fetch user info, using defaults')
    return { name: 'Feishu User', openId: '' }
  }

  const data = await resp.json()
  const user = data.data || data
  return {
    name: user.name || user.en_name || 'Feishu User',
    openId: user.open_id || '',
  }
}

/**
 * 用 refresh_token 静默续期
 */
async function refreshToken(
  appId: string, appSecret: string, refreshTokenStr: string
): Promise<{ accessToken: string; refreshToken: string; expiresAt: number }> {
  const resp = await fetch(REFRESH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: appId,
      client_secret: appSecret,
      refresh_token: refreshTokenStr,
    }),
  })

  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`Token refresh failed (${resp.status}): ${text}`)
  }

  const data = await resp.json()
  if (data.code && data.code !== 0) {
    throw new Error(`Token refresh error: ${data.msg || JSON.stringify(data)}`)
  }

  const accessToken = data.access_token || data.data?.access_token
  const newRefreshToken = data.refresh_token || data.data?.refresh_token
  const expiresIn = data.expires_in || data.data?.expires_in || 6900

  if (!accessToken) {
    throw new Error('No access_token in refresh response')
  }

  return {
    accessToken,
    refreshToken: newRefreshToken || refreshTokenStr,
    expiresAt: Date.now() + expiresIn * 1000,
  }
}

/**
 * 获取当前有效的 user_access_token
 * 过期前自动刷新；无授权时返回 null
 */
export async function getValidUserToken(): Promise<string | null> {
  const token = await loadStoredToken()
  if (!token) return null

  if (Date.now() < token.expiresAt - TOKEN_REFRESH_MARGIN_MS) {
    return token.accessToken
  }

  if (!token.refreshToken) {
    log.warn('Token expired and no refresh_token available')
    return null
  }

  try {
    const { appId, appSecret } = getAppCredentials()
    if (!appId || !appSecret) return null

    log.info('Refreshing user_access_token...')
    const refreshed = await refreshToken(appId, appSecret, token.refreshToken)

    const updated: FeishuOAuthToken = {
      ...token,
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresAt: refreshed.expiresAt,
    }
    await saveToken(updated)
    log.info('Token refreshed successfully')
    return updated.accessToken
  } catch (err) {
    log.error('Failed to refresh token:', err)
    return null
  }
}

/**
 * 清除 OAuth 授权
 */
export async function revokeFeishuOAuth(): Promise<void> {
  cachedToken = null
  await deleteCredential(CREDENTIAL_KEY)
  const configService = getConfigService()
  configService.set('feishuOAuthUser', '')
  configService.set('feishuOAuthOpenId', '')
  log.info('OAuth revoked')
}

/**
 * 获取当前 OAuth 状态
 */
export async function getFeishuOAuthStatus(): Promise<FeishuOAuthStatus> {
  const token = await loadStoredToken()
  if (!token) {
    return { authorized: false }
  }
  return {
    authorized: true,
    userName: token.userName,
    openId: token.openId,
    expiresAt: token.expiresAt,
  }
}
