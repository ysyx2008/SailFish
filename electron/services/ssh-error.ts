/**
 * SSH/SFTP 连接错误类型定义和解析工具
 * 用于将底层 ssh2 库的错误信息转换为用户友好的错误提示
 */

// SSH 连接错误类型
export type SshErrorType = 
  | 'auth_failed'        // 认证失败（密码或密钥错误）
  | 'timeout'            // 连接超时
  | 'connection_refused' // 连接被拒绝
  | 'host_not_found'     // 主机不存在
  | 'host_unreachable'   // 主机不可达
  | 'network_error'      // 网络错误
  | 'key_error'          // 密钥格式错误
  | 'unknown'            // 未知错误

// 错误信息映射（中文）
export const SSH_ERROR_MESSAGES_ZH: Record<SshErrorType, string> = {
  auth_failed: '认证失败：用户名或密码错误，请检查登录凭据',
  timeout: '连接超时：无法连接到服务器，请检查网络或主机地址',
  connection_refused: '连接被拒绝：服务器拒绝连接，请检查端口是否正确或SSH服务是否运行',
  host_not_found: '主机不存在：无法解析主机地址，请检查主机名是否正确',
  host_unreachable: '主机不可达：无法连接到目标主机，请检查网络连接',
  network_error: '网络错误：网络连接异常，请检查网络设置',
  key_error: '密钥错误：私钥格式不正确或密钥密码错误',
  unknown: '连接失败'
}

// 错误信息映射（英文）
export const SSH_ERROR_MESSAGES_EN: Record<SshErrorType, string> = {
  auth_failed: 'Authentication failed: Incorrect username or password, please check your credentials',
  timeout: 'Connection timeout: Unable to connect to server, please check network or host address',
  connection_refused: 'Connection refused: Server refused the connection, please check if the port is correct or SSH service is running',
  host_not_found: 'Host not found: Unable to resolve host address, please check the hostname',
  host_unreachable: 'Host unreachable: Unable to connect to target host, please check network connection',
  network_error: 'Network error: Network connection exception, please check network settings',
  key_error: 'Key error: Invalid private key format or incorrect passphrase',
  unknown: 'Connection failed'
}

/**
 * 解析 SSH/SFTP 连接错误
 * @param error 原始错误对象或错误信息
 * @returns 错误类型
 */
export function parseSshError(error: Error | string): SshErrorType {
  const message = typeof error === 'string' ? error : error.message
  const messageLower = message.toLowerCase()
  
  // 认证失败
  if (
    messageLower.includes('all configured authentication methods failed') ||
    messageLower.includes('authentication failed') ||
    messageLower.includes('auth fail') ||
    messageLower.includes('permission denied') ||
    messageLower.includes('access denied') ||
    messageLower.includes('invalid credentials') ||
    messageLower.includes('bad password') ||
    messageLower.includes('keyboard-interactive') ||
    // ssh2-sftp-client 的错误
    messageLower.includes('authentication') && messageLower.includes('failed')
  ) {
    return 'auth_failed'
  }
  
  // 密钥相关错误
  if (
    messageLower.includes('invalid key') ||
    messageLower.includes('bad passphrase') ||
    messageLower.includes('encrypted key') ||
    messageLower.includes('key parse') ||
    messageLower.includes('cannot parse') && messageLower.includes('key') ||
    messageLower.includes('privatekey') ||
    messageLower.includes('unsupported key format')
  ) {
    return 'key_error'
  }
  
  // 连接超时
  if (
    messageLower.includes('timed out') ||
    messageLower.includes('timeout') ||
    messageLower.includes('etimedout') ||
    messageLower.includes('connect timeout') ||
    messageLower.includes('handshake') && messageLower.includes('timed')
  ) {
    return 'timeout'
  }
  
  // 连接被拒绝
  if (
    messageLower.includes('econnrefused') ||
    messageLower.includes('connection refused') ||
    messageLower.includes('connect econnrefused')
  ) {
    return 'connection_refused'
  }
  
  // 主机不存在
  if (
    messageLower.includes('enotfound') ||
    messageLower.includes('getaddrinfo') ||
    messageLower.includes('hostname') && messageLower.includes('not found') ||
    messageLower.includes('name resolution') ||
    messageLower.includes('dns')
  ) {
    return 'host_not_found'
  }
  
  // 主机不可达
  if (
    messageLower.includes('ehostunreach') ||
    messageLower.includes('host unreachable') ||
    messageLower.includes('enetunreach') ||
    messageLower.includes('network unreachable') ||
    messageLower.includes('no route')
  ) {
    return 'host_unreachable'
  }
  
  // 其他网络错误
  if (
    messageLower.includes('econnreset') ||
    messageLower.includes('connection reset') ||
    messageLower.includes('epipe') ||
    messageLower.includes('broken pipe') ||
    messageLower.includes('socket') ||
    messageLower.includes('network')
  ) {
    return 'network_error'
  }
  
  return 'unknown'
}

/**
 * 获取用户友好的错误信息
 * @param error 原始错误对象或错误信息
 * @param locale 语言环境 ('zh' | 'en')，默认中文
 * @returns 用户友好的错误信息
 */
export function getSshErrorMessage(error: Error | string, locale: 'zh' | 'en' = 'zh'): string {
  const errorType = parseSshError(error)
  const messages = locale === 'zh' ? SSH_ERROR_MESSAGES_ZH : SSH_ERROR_MESSAGES_EN
  
  // 如果是未知错误，附上原始错误信息便于调试
  if (errorType === 'unknown') {
    const originalMessage = typeof error === 'string' ? error : error.message
    return `${messages.unknown}: ${originalMessage}`
  }
  
  return messages[errorType]
}

/**
 * 获取错误类型和消息
 * 方便前端根据错误类型进行不同处理
 */
export function getSshErrorInfo(error: Error | string, locale: 'zh' | 'en' = 'zh'): {
  type: SshErrorType
  message: string
  originalMessage: string
} {
  const errorType = parseSshError(error)
  const messages = locale === 'zh' ? SSH_ERROR_MESSAGES_ZH : SSH_ERROR_MESSAGES_EN
  const originalMessage = typeof error === 'string' ? error : error.message
  
  return {
    type: errorType,
    message: errorType === 'unknown' ? `${messages.unknown}: ${originalMessage}` : messages[errorType],
    originalMessage
  }
}
