/**
 * 工具执行器通用工具函数
 */
import { t } from '../i18n'
import type { ErrorCategory } from './types'
import { PATH_PARAM_NAMES } from './types'
import { createLogger } from '../../../utils/logger'

const log = createLogger('ToolUtils')

/**
 * 分析错误类型
 */
export function categorizeError(error: string): ErrorCategory {
  const errorLower = error.toLowerCase()
  
  // 暂时性错误（可重试）
  if (errorLower.includes('connection reset') ||
      errorLower.includes('network') ||
      errorLower.includes('temporarily') ||
      errorLower.includes('busy') ||
      errorLower.includes('try again')) {
    return 'transient'
  }
  
  // 权限错误
  if (errorLower.includes('permission denied') ||
      errorLower.includes('access denied') ||
      errorLower.includes('not permitted') ||
      errorLower.includes('operation not allowed')) {
    return 'permission'
  }
  
  // 资源不存在
  if (errorLower.includes('not found') ||
      errorLower.includes('no such file') ||
      errorLower.includes('does not exist') ||
      errorLower.includes('command not found')) {
    return 'not_found'
  }
  
  // 超时
  if (errorLower.includes('timeout') ||
      errorLower.includes('timed out')) {
    return 'timeout'
  }
  
  return 'fatal'
}

/**
 * 获取错误恢复建议
 */
export function getErrorRecoverySuggestion(error: string, category: ErrorCategory): string {
  switch (category) {
    case 'transient':
      return t('error.transient')
    case 'permission':
      return t('error.permission')
    case 'not_found':
      return t('error.not_found')
    case 'timeout':
      return t('error.timeout')
    case 'fatal':
      return t('error.execution_failed')
  }
}

/**
 * 带重试的异步执行
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries?: number
    retryDelay?: number
    shouldRetry?: (error: Error) => boolean
  } = {}
): Promise<T> {
  const { maxRetries = 2, retryDelay = 1000, shouldRetry } = options
  
  let lastError: Error | null = null
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error as Error
      
      // 检查是否应该重试
      if (attempt < maxRetries) {
        const category = categorizeError(lastError.message)
        const canRetry = category === 'transient' || category === 'timeout'
        
        if (shouldRetry ? shouldRetry(lastError) : canRetry) {
          // 指数退避
          const delay = retryDelay * Math.pow(2, attempt)
          await new Promise(resolve => setTimeout(resolve, delay))
          continue
        }
      }
      
      throw lastError
    }
  }
  
  throw lastError
}

/**
 * 从后向前截断字符串，保留最新的内容
 */
export function truncateFromEnd(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text
  }
  
  // 按行分割，从后向前保留行
  const lines = text.split('\n')
  const result: string[] = []
  let currentLength = 0
  const ellipsisLength = 3 // '...' 的长度
  const availableLength = maxLength - ellipsisLength
  
  // 从最后一行开始向前累积
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    const isLastLine = i === lines.length - 1
    
    const lineLength = isLastLine ? line.length : line.length + 1
    const neededLength = currentLength + lineLength
    
    if (neededLength > availableLength) {
      if (isLastLine && currentLength === 0) {
        const truncatedLine = line.slice(-availableLength)
        result.unshift(truncatedLine)
        return '...' + truncatedLine
      }
      break
    }
    
    result.unshift(line)
    currentLength += lineLength
  }
  
  if (result.length < lines.length) {
    return '...' + result.join('\n')
  }
  
  return result.join('\n')
}

/**
 * 格式化文件大小
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

/**
 * 格式化剩余时间显示
 */
export function formatRemainingTime(totalSeconds: number, elapsedSeconds: number): string {
  const remaining = Math.max(0, totalSeconds - elapsedSeconds)
  const minutes = Math.floor(remaining / 60)
  const seconds = remaining % 60
  
  if (minutes > 0) {
    return t('time.minutes_seconds', { minutes, seconds })
  }
  return t('time.seconds', { seconds })
}

/**
 * 格式化总时间显示
 */
export function formatTotalTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const secs = seconds % 60
  
  if (minutes > 0) {
    return secs > 0 ? t('time.minutes_seconds', { minutes, seconds: secs }) : t('time.minutes', { minutes })
  }
  return t('time.seconds', { seconds })
}

/**
 * 解码 Python 风格的 \xXX 转义序列（仅用于路径参数）
 */
export function tryDecodePythonEscapesForPath(str: string): string {
  if (!str.includes('\\x')) {
    return str
  }
  
  const looksLikePath = str.startsWith('/') || str.startsWith('~') || /^[A-Z]:[/\\]/i.test(str)
  if (!looksLikePath) {
    return str
  }
  
  try {
    const bytes: number[] = []
    let i = 0
    let hasEscapes = false
    
    while (i < str.length) {
      if (str[i] === '\\' && str[i + 1] === 'x' && i + 3 < str.length) {
        const hex = str.substring(i + 2, i + 4)
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          const byte = parseInt(hex, 16)
          bytes.push(byte)
          hasEscapes = true
          i += 4
          continue
        }
      }
      bytes.push(str.charCodeAt(i))
      i++
    }
    
    if (!hasEscapes) {
      return str
    }
    
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes))
    
    // eslint-disable-next-line no-control-regex
    const hasNonAscii = /[^\x00-\x7F]/.test(decoded)
    if (!hasNonAscii) {
      return str
    }
    
    log.info(`Decoded Python escapes in path: "${str.substring(0, 50)}..." -> "${decoded.substring(0, 50)}..."`)
    return decoded
  } catch {
    return str
  }
}

/**
 * 处理工具参数，只对路径相关参数解码 Python 转义序列
 */
export function normalizeToolArgs(args: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string' && PATH_PARAM_NAMES.has(key.toLowerCase())) {
      result[key] = tryDecodePythonEscapesForPath(value)
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = normalizeToolArgs(value as Record<string, unknown>)
    } else {
      result[key] = value
    }
  }
  return result
}
