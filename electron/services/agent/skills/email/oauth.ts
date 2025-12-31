/**
 * OAuth2 认证支持
 * 支持 Gmail 和 Outlook 的 OAuth2 认证流程
 * 
 * 注意：完整的 OAuth2 实现需要：
 * 1. 在 Google Cloud Console / Azure Portal 注册应用获取 Client ID/Secret
 * 2. 在 Electron 中打开 BrowserWindow 进行用户授权
 * 3. 处理回调 URL 获取授权码
 * 4. 交换授权码获取 access_token 和 refresh_token
 * 5. 定期刷新 token
 * 
 * 当前版本先实现框架，后续可扩展完整 OAuth2 流程
 */

import { BrowserWindow } from 'electron'

/**
 * OAuth2 配置
 */
export interface OAuth2Config {
  clientId: string
  clientSecret: string
  authUrl: string
  tokenUrl: string
  redirectUri: string
  scopes: string[]
}

/**
 * OAuth2 Token
 */
export interface OAuth2Token {
  accessToken: string
  refreshToken?: string
  expiresAt?: number
  tokenType?: string
}

/**
 * Gmail OAuth2 配置
 * 注意：需要用户自行在 Google Cloud Console 创建 OAuth2 凭据
 */
export const GMAIL_OAUTH_CONFIG: Partial<OAuth2Config> = {
  authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  redirectUri: 'http://localhost:8765/oauth/callback',
  scopes: [
    'https://mail.google.com/',  // 完整邮箱访问
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/gmail.readonly'
  ]
}

/**
 * Outlook OAuth2 配置
 * 注意：需要用户自行在 Azure Portal 创建应用注册
 */
export const OUTLOOK_OAUTH_CONFIG: Partial<OAuth2Config> = {
  authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
  tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
  redirectUri: 'http://localhost:8765/oauth/callback',
  scopes: [
    'https://outlook.office.com/IMAP.AccessAsUser.All',
    'https://outlook.office.com/SMTP.Send',
    'offline_access'
  ]
}

/**
 * 启动 OAuth2 认证流程
 * 在 BrowserWindow 中打开授权页面
 */
export async function startOAuth2Flow(
  provider: 'gmail' | 'outlook',
  clientId: string,
  clientSecret: string
): Promise<OAuth2Token> {
  const config = provider === 'gmail' ? GMAIL_OAUTH_CONFIG : OUTLOOK_OAUTH_CONFIG
  
  if (!config.authUrl || !config.tokenUrl) {
    throw new Error('OAuth2 配置不完整')
  }

  // 构建授权 URL
  const authParams = new URLSearchParams({
    client_id: clientId,
    redirect_uri: config.redirectUri!,
    response_type: 'code',
    scope: config.scopes!.join(' '),
    access_type: 'offline',
    prompt: 'consent'
  })

  const authUrl = `${config.authUrl}?${authParams.toString()}`

  // 创建授权窗口
  const authWindow = new BrowserWindow({
    width: 600,
    height: 700,
    show: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  })

  return new Promise((resolve, reject) => {
    // 监听重定向
    authWindow.webContents.on('will-redirect', async (event, url) => {
      try {
        const urlObj = new URL(url)
        if (urlObj.origin === 'http://localhost:8765' && urlObj.pathname === '/oauth/callback') {
          event.preventDefault()
          
          const code = urlObj.searchParams.get('code')
          const error = urlObj.searchParams.get('error')

          if (error) {
            authWindow.close()
            reject(new Error(`OAuth2 认证失败: ${error}`))
            return
          }

          if (code) {
            authWindow.close()
            
            // 交换授权码获取 token
            const token = await exchangeCodeForToken(
              code,
              clientId,
              clientSecret,
              config.tokenUrl!,
              config.redirectUri!
            )
            
            resolve(token)
          }
        }
      } catch (err) {
        authWindow.close()
        reject(err)
      }
    })

    authWindow.on('closed', () => {
      reject(new Error('用户取消了授权'))
    })

    // 加载授权页面
    authWindow.loadURL(authUrl)
  })
}

/**
 * 交换授权码获取 token
 */
async function exchangeCodeForToken(
  code: string,
  clientId: string,
  clientSecret: string,
  tokenUrl: string,
  redirectUri: string
): Promise<OAuth2Token> {
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code'
    })
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`获取 token 失败: ${error}`)
  }

  const data = await response.json()
  
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
    tokenType: data.token_type
  }
}

/**
 * 刷新 access_token
 */
export async function refreshAccessToken(
  provider: 'gmail' | 'outlook',
  clientId: string,
  clientSecret: string,
  refreshToken: string
): Promise<OAuth2Token> {
  const config = provider === 'gmail' ? GMAIL_OAUTH_CONFIG : OUTLOOK_OAUTH_CONFIG
  
  if (!config.tokenUrl) {
    throw new Error('OAuth2 配置不完整')
  }

  const response = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    })
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`刷新 token 失败: ${error}`)
  }

  const data = await response.json()
  
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,  // 有些提供商不会返回新的 refresh_token
    expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
    tokenType: data.token_type
  }
}

/**
 * 生成 XOAUTH2 认证字符串
 * 用于 IMAP/SMTP 的 XOAUTH2 认证
 */
export function generateXOAuth2Token(email: string, accessToken: string): string {
  const authString = `user=${email}\x01auth=Bearer ${accessToken}\x01\x01`
  return Buffer.from(authString).toString('base64')
}

