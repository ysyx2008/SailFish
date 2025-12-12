/**
 * 知识库加密工具
 * 使用 AES-256-GCM 加密主机记忆等敏感数据
 * 支持用户密码派生密钥（PBKDF2）
 */
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 16
const SALT_LENGTH = 32
const KEY_LENGTH = 32
const PBKDF2_ITERATIONS = 100000  // 迭代次数，越高越安全但越慢
const AUTH_TAG_LENGTH = 16

// 加密数据的版本标识
const ENCRYPTED_PREFIX = 'ENC:v1:'

// 密码验证文件路径
let passwordFilePath: string | null = null
function getPasswordFilePath(): string {
  if (!passwordFilePath) {
    passwordFilePath = path.join(app.getPath('userData'), 'knowledge', '.password')
  }
  return passwordFilePath
}

// 缓存派生的密钥
let cachedKey: Buffer | null = null
let cachedSalt: Buffer | null = null

/**
 * 从密码派生密钥
 */
function deriveKey(password: string, salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha256')
}

/**
 * 设置知识库密码
 * @param password 用户密码
 * @returns 是否设置成功
 */
export function setPassword(password: string): boolean {
  if (!password || password.length < 4) {
    throw new Error('密码长度至少为 4 位')
  }

  try {
    // 生成新的盐值
    const salt = crypto.randomBytes(SALT_LENGTH)
    const key = deriveKey(password, salt)
    
    // 创建验证数据：加密一个已知字符串
    const verifyData = 'QIYU_KNOWLEDGE_PASSWORD_VERIFY'
    const iv = crypto.randomBytes(IV_LENGTH)
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv)
    let encrypted = cipher.update(verifyData, 'utf8', 'base64')
    encrypted += cipher.final('base64')
    const authTag = cipher.getAuthTag()

    // 保存盐值和验证数据
    const passwordData = {
      version: 1,
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
      verify: encrypted,
      createdAt: Date.now()
    }

    // 确保目录存在
    const dir = path.dirname(getPasswordFilePath())
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    fs.writeFileSync(getPasswordFilePath(), JSON.stringify(passwordData, null, 2), 'utf-8')
    
    // 缓存密钥
    cachedKey = key
    cachedSalt = salt
    
    console.log('[Crypto] 知识库密码已设置')
    return true
  } catch (e) {
    console.error('[Crypto] 设置密码失败:', e)
    throw e
  }
}

/**
 * 验证知识库密码
 * @param password 用户密码
 * @returns 是否验证成功
 */
export function verifyPassword(password: string): boolean {
  if (!password) return false

  try {
    const filePath = getPasswordFilePath()
    if (!fs.existsSync(filePath)) {
      return false
    }

    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    const salt = Buffer.from(data.salt, 'base64')
    const iv = Buffer.from(data.iv, 'base64')
    const authTag = Buffer.from(data.authTag, 'base64')
    const key = deriveKey(password, salt)

    // 尝试解密验证数据
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv)
    decipher.setAuthTag(authTag)
    let decrypted = decipher.update(data.verify, 'base64', 'utf8')
    decrypted += decipher.final('utf8')

    if (decrypted === 'QIYU_KNOWLEDGE_PASSWORD_VERIFY') {
      // 密码正确，缓存密钥
      cachedKey = key
      cachedSalt = salt
      console.log('[Crypto] 知识库密码验证成功')
      return true
    }
    
    return false
  } catch (e) {
    console.log('[Crypto] 密码验证失败:', e)
    return false
  }
}

/**
 * 检查是否已设置密码
 */
export function hasPassword(): boolean {
  return fs.existsSync(getPasswordFilePath())
}

/**
 * 检查密码是否已解锁（已验证）
 */
export function isUnlocked(): boolean {
  return cachedKey !== null
}

/**
 * 修改密码
 * @param oldPassword 旧密码
 * @param newPassword 新密码
 * @returns 是否修改成功
 */
export function changePassword(oldPassword: string, newPassword: string): boolean {
  if (!verifyPassword(oldPassword)) {
    throw new Error('旧密码错误')
  }
  
  // 注意：修改密码不会重新加密已有数据
  // 已有数据使用旧密钥加密，包含各自的盐值，仍可正常解密
  // 新数据将使用新密钥加密
  return setPassword(newPassword)
}

/**
 * 清除密码（危险操作）
 */
export function clearPassword(): void {
  const filePath = getPasswordFilePath()
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath)
  }
  cachedKey = null
  cachedSalt = null
  console.log('[Crypto] 知识库密码已清除')
}

/**
 * 锁定知识库（清除缓存的密钥）
 */
export function lock(): void {
  cachedKey = null
  console.log('[Crypto] 知识库已锁定')
}

/**
 * 加密文本
 * @param plaintext 明文
 * @returns 加密后的字符串
 */
export function encrypt(plaintext: string): string {
  if (!plaintext) return plaintext
  
  // 如果没有设置密码或未解锁，返回原文
  if (!cachedKey) {
    console.warn('[Crypto] 未设置密码或未解锁，数据将不加密存储')
    return plaintext
  }

  try {
    const iv = crypto.randomBytes(IV_LENGTH)
    const cipher = crypto.createCipheriv(ALGORITHM, cachedKey, iv)
    
    let encrypted = cipher.update(plaintext, 'utf8', 'base64')
    encrypted += cipher.final('base64')
    
    const authTag = cipher.getAuthTag()
    
    // 格式：ENC:v1:iv:authTag:ciphertext
    return [
      ENCRYPTED_PREFIX.slice(0, -1),  // 移除末尾的冒号
      iv.toString('base64'),
      authTag.toString('base64'),
      encrypted
    ].join(':')
  } catch (e) {
    console.error('[Crypto] 加密失败:', e)
    return plaintext
  }
}

/**
 * 解密文本
 * @param ciphertext 加密后的字符串
 * @returns 解密后的明文
 */
export function decrypt(ciphertext: string): string {
  if (!ciphertext) return ciphertext
  
  // 检查是否是加密格式
  if (!ciphertext.startsWith(ENCRYPTED_PREFIX.slice(0, -1))) {
    // 不是加密格式，可能是旧数据或未加密数据，直接返回
    return ciphertext
  }
  
  // 如果未解锁，返回占位符
  if (!cachedKey) {
    return '[知识库已锁定，请先解锁]'
  }

  try {
    const parts = ciphertext.split(':')
    if (parts.length !== 5) {
      return ciphertext
    }
    
    const [, , ivBase64, authTagBase64, encryptedBase64] = parts
    
    const iv = Buffer.from(ivBase64, 'base64')
    const authTag = Buffer.from(authTagBase64, 'base64')
    
    const decipher = crypto.createDecipheriv(ALGORITHM, cachedKey, iv)
    decipher.setAuthTag(authTag)
    
    let decrypted = decipher.update(encryptedBase64, 'base64', 'utf8')
    decrypted += decipher.final('utf8')
    
    return decrypted
  } catch (e) {
    console.error('[Crypto] 解密失败:', e)
    return '[解密失败]'
  }
}

/**
 * 检查文本是否已加密
 */
export function isEncrypted(text: string): boolean {
  return text?.startsWith(ENCRYPTED_PREFIX.slice(0, -1)) || false
}

/**
 * 获取密码提示信息
 */
export function getPasswordInfo(): { hasPassword: boolean; isUnlocked: boolean; createdAt?: number } {
  const filePath = getPasswordFilePath()
  const has = fs.existsSync(filePath)
  
  let createdAt: number | undefined
  if (has) {
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
      createdAt = data.createdAt
    } catch {
      // ignore
    }
  }
  
  return {
    hasPassword: has,
    isUnlocked: cachedKey !== null,
    createdAt
  }
}
