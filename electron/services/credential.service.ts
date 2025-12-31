/**
 * 凭据存储服务
 * 使用系统密钥链安全存储敏感信息
 * - macOS: Keychain
 * - Windows: Credential Manager
 * - Linux: Secret Service (libsecret)
 */

const SERVICE_NAME = 'SFTerminal'

// keytar 模块（延迟加载）
let keytarModule: typeof import('keytar') | null = null

/**
 * 初始化 keytar 模块
 */
async function getKeytar(): Promise<typeof import('keytar')> {
  if (!keytarModule) {
    const imported = await import('keytar')
    // 处理 ESM 默认导出
    keytarModule = imported.default || imported
  }
  return keytarModule
}

/**
 * 存储凭据到系统密钥链
 * @param key 凭据键名（如 email 账户 ID）
 * @param secret 凭据值（如密码或 token）
 */
export async function setCredential(key: string, secret: string): Promise<void> {
  try {
    const kt = await getKeytar()
    await kt.setPassword(SERVICE_NAME, key, secret)
    console.log(`[CredentialService] Credential stored: ${key}`)
  } catch (error) {
    console.error(`[CredentialService] Failed to store credential: ${key}`, error)
    throw new Error(`无法存储凭据: ${error instanceof Error ? error.message : '未知错误'}`)
  }
}

/**
 * 从系统密钥链获取凭据
 * @param key 凭据键名
 * @returns 凭据值，如果不存在返回 null
 */
export async function getCredential(key: string): Promise<string | null> {
  try {
    const kt = await getKeytar()
    const secret = await kt.getPassword(SERVICE_NAME, key)
    return secret
  } catch (error) {
    console.error(`[CredentialService] Failed to get credential: ${key}`, error)
    return null
  }
}

/**
 * 从系统密钥链删除凭据
 * @param key 凭据键名
 * @returns 是否删除成功
 */
export async function deleteCredential(key: string): Promise<boolean> {
  try {
    const kt = await getKeytar()
    const result = await kt.deletePassword(SERVICE_NAME, key)
    if (result) {
      console.log(`[CredentialService] Credential deleted: ${key}`)
    }
    return result
  } catch (error) {
    console.error(`[CredentialService] Failed to delete credential: ${key}`, error)
    return false
  }
}

/**
 * 获取所有存储的凭据键名
 * @param prefix 可选前缀过滤
 * @returns 凭据键名列表
 */
export async function listCredentials(prefix?: string): Promise<string[]> {
  try {
    const kt = await getKeytar()
    const credentials = await kt.findCredentials(SERVICE_NAME)
    let keys = credentials.map(c => c.account)
    if (prefix) {
      keys = keys.filter(k => k.startsWith(prefix))
    }
    return keys
  } catch (error) {
    console.error(`[CredentialService] Failed to list credentials`, error)
    return []
  }
}

// ============ 邮箱专用方法 ============

const EMAIL_PREFIX = 'email:'

/**
 * 存储邮箱账户凭据
 * @param accountId 邮箱账户 ID
 * @param credential 凭据（密码或 OAuth2 token JSON）
 */
export async function setEmailCredential(accountId: string, credential: string): Promise<void> {
  await setCredential(`${EMAIL_PREFIX}${accountId}`, credential)
}

/**
 * 获取邮箱账户凭据
 * @param accountId 邮箱账户 ID
 * @returns 凭据，如果不存在返回 null
 */
export async function getEmailCredential(accountId: string): Promise<string | null> {
  return await getCredential(`${EMAIL_PREFIX}${accountId}`)
}

/**
 * 删除邮箱账户凭据
 * @param accountId 邮箱账户 ID
 */
export async function deleteEmailCredential(accountId: string): Promise<boolean> {
  return await deleteCredential(`${EMAIL_PREFIX}${accountId}`)
}

/**
 * OAuth2 Token 结构
 */
export interface OAuth2Token {
  accessToken: string
  refreshToken?: string
  expiresAt?: number  // Unix 时间戳
  tokenType?: string
}

/**
 * 存储 OAuth2 Token
 * @param accountId 邮箱账户 ID
 * @param token OAuth2 Token 对象
 */
export async function setOAuth2Token(accountId: string, token: OAuth2Token): Promise<void> {
  await setEmailCredential(accountId, JSON.stringify(token))
}

/**
 * 获取 OAuth2 Token
 * @param accountId 邮箱账户 ID
 * @returns OAuth2 Token 对象，如果不存在或已过期返回 null
 */
export async function getOAuth2Token(accountId: string): Promise<OAuth2Token | null> {
  const credential = await getEmailCredential(accountId)
  if (!credential) return null
  
  try {
    const token = JSON.parse(credential) as OAuth2Token
    
    // 检查是否过期（提前 5 分钟判断）
    if (token.expiresAt && Date.now() > (token.expiresAt - 5 * 60 * 1000)) {
      console.log(`[CredentialService] OAuth2 token expired for: ${accountId}`)
      // 返回 token 以便调用者使用 refreshToken 刷新
      return token
    }
    
    return token
  } catch {
    // 不是 JSON 格式，可能是普通密码
    return null
  }
}

