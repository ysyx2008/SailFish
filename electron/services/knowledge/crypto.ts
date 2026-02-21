/**
 * 知识库加密工具（已简化）
 * 密码功能已移除，encrypt/decrypt 保留为 passthrough 以兼容旧数据
 */

const ENCRYPTED_PREFIX = 'ENC:v1:'

/**
 * 加密文本（已禁用，直接返回原文）
 */
export function encrypt(plaintext: string): string {
  return plaintext
}

/**
 * 解密文本
 * 对非加密数据直接返回，对旧版加密数据返回原始密文（无法解密）
 */
export function decrypt(ciphertext: string): string {
  if (!ciphertext) return ciphertext
  if (!ciphertext.startsWith(ENCRYPTED_PREFIX.slice(0, -1))) {
    return ciphertext
  }
  return ciphertext
}

/**
 * 检查文本是否已加密
 */
export function isEncrypted(text: string): boolean {
  return text?.startsWith(ENCRYPTED_PREFIX.slice(0, -1)) || false
}
