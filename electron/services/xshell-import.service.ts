import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

export interface XshellSession {
  name: string
  host: string
  port: number
  username: string
  password?: string
  privateKeyPath?: string
  group?: string
}

export interface ImportResult {
  success: boolean
  sessions: XshellSession[]
  errors: string[]
  debug?: {
    totalFiles: number
    parsedFiles: number
    failedFiles: number
  }
}

/**
 * Xshell 会话导入服务
 * 支持解析 .xsh 文件（INI 格式，UTF-16 编码）
 */
export class XshellImportService {
  /**
   * 解析单个 .xsh 文件
   * @returns XshellSession 或者 { error: string } 表示解析失败
   */
  parseXshFile(filePath: string): XshellSession | { error: string } {
    try {
      // 读取文件，尝试不同编码
      let content: string
      try {
        content = this.readFileWithEncoding(filePath)
      } catch (readError) {
        return { error: `读取文件失败: ${readError}` }
      }
      
      const fileName = path.basename(filePath, '.xsh')
      
      // 解析 INI 格式
      const sections = this.parseIni(content)
      
      // 调试：记录找到的节名称
      const sectionNames = Object.keys(sections)
      console.log(`[Xshell] 文件 ${fileName} 的节: ${sectionNames.join(', ')}`)
      
      // 连接信息在 [CONNECTION] 节
      const connectionSection = sections['CONNECTION'] || sections['Connection'] || {}
      
      // 认证信息在 [CONNECTION:AUTHENTICATION] 节
      const authSection = sections['CONNECTION:AUTHENTICATION'] || 
                          sections['Connection:Authentication'] || {}
      
      // SSH 特定信息在 [CONNECTION:SSH] 节
      const sshSection = sections['CONNECTION:SSH'] || sections['Connection:SSH'] || {}
      
      // 会话信息
      const sessionInfo = sections['SessionInfo'] || sections['SESSIONINFO'] || {}
      
      // 获取主机信息
      const host = connectionSection['Host'] || connectionSection['host'] || 
                   sshSection['Host'] || sshSection['host'] || ''
      
      if (!host) {
        // 提供更详细的调试信息
        const connKeys = Object.keys(connectionSection)
        const sshKeys = Object.keys(sshSection)
        console.warn(`[Xshell] 文件 ${fileName} 无主机信息`)
        console.warn(`[Xshell] CONNECTION 键: ${connKeys.join(', ') || '(空)'}`)
        console.warn(`[Xshell] CONNECTION:SSH 键: ${sshKeys.join(', ') || '(空)'}`)
        return { error: `无主机信息 (节: ${sectionNames.slice(0, 5).join(', ')}${sectionNames.length > 5 ? '...' : ''})` }
      }
      
      // 获取端口
      const port = parseInt(
        connectionSection['Port'] || connectionSection['port'] || 
        sshSection['Port'] || sshSection['port'] || '22', 
        10
      )
      
      // 获取用户名（在 AUTHENTICATION 节）
      const username = authSection['UserName'] || authSection['username'] ||
                       authSection['User'] || authSection['user'] || 
                       sshSection['UserName'] || 'root'
      
      // 获取私钥路径（如果有）- Xshell 密码是加密的，我们不导入
      const userKey = authSection['UserKey'] || authSection['userKey'] || ''
      const privateKeyPath = userKey || undefined
      
      // 获取会话名称，优先使用文件名
      const name = fileName || sessionInfo['SessionName'] || sessionInfo['Name'] || host
      
      return {
        name,
        host,
        port,
        username,
        password: undefined, // Xshell 密码是加密的，无法直接使用
        privateKeyPath,
        group: undefined
      }
    } catch (error) {
      console.error(`[Xshell] 解析文件 ${filePath} 失败:`, error)
      return { error: `解析异常: ${error}` }
    }
  }

  /**
   * 读取文件，自动处理 UTF-16 编码
   */
  private readFileWithEncoding(filePath: string): string {
    const buffer = fs.readFileSync(filePath)
    
    // 检查 BOM 判断编码
    // UTF-16 LE: FF FE
    // UTF-16 BE: FE FF
    // UTF-8 BOM: EF BB BF
    if (buffer[0] === 0xFF && buffer[1] === 0xFE) {
      // UTF-16 LE
      return buffer.toString('utf16le').slice(1) // 跳过 BOM
    } else if (buffer[0] === 0xFE && buffer[1] === 0xFF) {
      // UTF-16 BE - 需要转换字节序
      const swapped = Buffer.alloc(buffer.length)
      for (let i = 0; i < buffer.length; i += 2) {
        swapped[i] = buffer[i + 1]
        swapped[i + 1] = buffer[i]
      }
      return swapped.toString('utf16le').slice(1)
    } else if (buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
      // UTF-8 with BOM
      return buffer.toString('utf-8').slice(1)
    }
    
    // 尝试检测是否是无 BOM 的 UTF-16（Xshell 可能使用这种格式）
    // 如果大量字节是 0x00，可能是 UTF-16
    let nullCount = 0
    const checkLength = Math.min(100, buffer.length)
    for (let i = 0; i < checkLength; i++) {
      if (buffer[i] === 0x00) nullCount++
    }
    
    if (nullCount > checkLength * 0.3) {
      // 可能是 UTF-16，尝试 UTF-16 LE
      return buffer.toString('utf16le')
    }
    
    // 默认 UTF-8
    return buffer.toString('utf-8')
  }

  /**
   * 简单的 INI 解析器
   */
  private parseIni(content: string): Record<string, Record<string, string>> {
    const result: Record<string, Record<string, string>> = {}
    let currentSection = ''
    
    const lines = content.split(/\r?\n/)
    
    for (const line of lines) {
      // 清理可能的空字符
      const trimmedLine = line.replace(/\0/g, '').trim()
      
      // 跳过空行和注释
      if (!trimmedLine || trimmedLine.startsWith(';') || trimmedLine.startsWith('#')) {
        continue
      }
      
      // 检查是否是节头
      const sectionMatch = trimmedLine.match(/^\[(.+)\]$/)
      if (sectionMatch) {
        currentSection = sectionMatch[1]
        result[currentSection] = {}
        continue
      }
      
      // 解析键值对
      const kvMatch = trimmedLine.match(/^([^=]+)=(.*)$/)
      if (kvMatch && currentSection) {
        const key = kvMatch[1].trim()
        const value = kvMatch[2].trim()
        result[currentSection][key] = value
      }
    }
    
    return result
  }

  /**
   * 导入目录中的所有 .xsh 文件
   */
  importFromDirectory(dirPath: string): ImportResult {
    const sessions: XshellSession[] = []
    const errors: string[] = []
    const stats = { totalFiles: 0, parsedFiles: 0, failedFiles: 0 }
    
    console.log(`[Xshell] 开始导入目录: ${dirPath}`)
    
    try {
      this.scanDirectory(dirPath, sessions, errors, '', stats)
      
      console.log(`[Xshell] 导入完成: 总文件 ${stats.totalFiles}, 成功 ${stats.parsedFiles}, 失败 ${stats.failedFiles}`)
      
      return {
        success: sessions.length > 0,
        sessions,
        errors,
        debug: stats
      }
    } catch (error) {
      console.error(`[Xshell] 导入目录失败:`, error)
      return {
        success: false,
        sessions: [],
        errors: [`无法读取目录: ${error}`],
        debug: stats
      }
    }
  }

  /**
   * 导入多个目录中的所有 .xsh 文件
   */
  importFromDirectories(dirPaths: string[]): ImportResult {
    const sessions: XshellSession[] = []
    const errors: string[] = []
    const totalStats = { totalFiles: 0, parsedFiles: 0, failedFiles: 0 }
    
    console.log(`[Xshell] 开始导入 ${dirPaths.length} 个目录`)
    
    for (const dirPath of dirPaths) {
      const result = this.importFromDirectory(dirPath)
      sessions.push(...result.sessions)
      errors.push(...result.errors)
      if (result.debug) {
        totalStats.totalFiles += result.debug.totalFiles
        totalStats.parsedFiles += result.debug.parsedFiles
        totalStats.failedFiles += result.debug.failedFiles
      }
    }
    
    console.log(`[Xshell] 多目录导入完成: 总文件 ${totalStats.totalFiles}, 成功 ${totalStats.parsedFiles}, 失败 ${totalStats.failedFiles}`)
    
    return {
      success: sessions.length > 0,
      sessions,
      errors,
      debug: totalStats
    }
  }

  /**
   * 递归扫描目录
   */
  private scanDirectory(
    dirPath: string, 
    sessions: XshellSession[], 
    errors: string[],
    currentGroup: string,
    stats: { totalFiles: number; parsedFiles: number; failedFiles: number }
  ): void {
    let items: fs.Dirent[]
    try {
      items = fs.readdirSync(dirPath, { withFileTypes: true })
    } catch (error) {
      errors.push(`无法读取目录 ${dirPath}: ${error}`)
      return
    }
    
    for (const item of items) {
      const fullPath = path.join(dirPath, item.name)
      
      if (item.isDirectory()) {
        // 子目录作为分组
        const groupName = currentGroup ? `${currentGroup}/${item.name}` : item.name
        this.scanDirectory(fullPath, sessions, errors, groupName, stats)
      } else if (item.isFile() && item.name.toLowerCase().endsWith('.xsh')) {
        stats.totalFiles++
        const result = this.parseXshFile(fullPath)
        
        if ('error' in result) {
          // 解析失败
          stats.failedFiles++
          errors.push(`${item.name}: ${result.error}`)
        } else {
          // 解析成功
          stats.parsedFiles++
          result.group = currentGroup || undefined
          sessions.push(result)
        }
      }
    }
  }

  /**
   * 导入单个或多个 .xsh 文件
   */
  importFiles(filePaths: string[]): ImportResult {
    const sessions: XshellSession[] = []
    const errors: string[] = []
    const stats = { totalFiles: 0, parsedFiles: 0, failedFiles: 0 }
    
    for (const filePath of filePaths) {
      if (filePath.toLowerCase().endsWith('.xsh')) {
        stats.totalFiles++
        const result = this.parseXshFile(filePath)
        if ('error' in result) {
          stats.failedFiles++
          errors.push(`${path.basename(filePath)}: ${result.error}`)
        } else {
          stats.parsedFiles++
          sessions.push(result)
        }
      } else {
        errors.push(`不支持的文件格式: ${path.basename(filePath)}`)
      }
    }
    
    return {
      success: sessions.length > 0,
      sessions,
      errors,
      debug: stats
    }
  }

  /**
   * 递归统计目录中的 .xsh 文件数量
   */
  private countXshFiles(dirPath: string): number {
    let count = 0
    try {
      const items = fs.readdirSync(dirPath, { withFileTypes: true })
      for (const item of items) {
        const fullPath = path.join(dirPath, item.name)
        if (item.isDirectory()) {
          count += this.countXshFiles(fullPath)
        } else if (item.isFile() && item.name.toLowerCase().endsWith('.xsh')) {
          count++
        }
      }
    } catch (e) {
      // 忽略读取错误
    }
    return count
  }

  /**
   * 扫描常见的 Xshell 会话目录路径
   */
  scanDefaultPaths(): { found: boolean; paths: string[]; sessionCount: number } {
    const paths: string[] = []
    let sessionCount = 0

    // Windows 常见路径
    if (process.platform === 'win32') {
      const userProfile = process.env.USERPROFILE || ''
      const appData = process.env.APPDATA || ''

      // %USERPROFILE%\Documents\NetSarang Computer\*\Xshell\Sessions
      if (userProfile) {
        const netsarangBase = path.join(userProfile, 'Documents', 'NetSarang Computer')
        if (fs.existsSync(netsarangBase)) {
          try {
            const versions = fs.readdirSync(netsarangBase, { withFileTypes: true })
            for (const version of versions) {
              if (version.isDirectory()) {
                const sessionsPath = path.join(netsarangBase, version.name, 'Xshell', 'Sessions')
                if (fs.existsSync(sessionsPath)) {
                  paths.push(sessionsPath)
                  // 递归统计会话数量
                  sessionCount += this.countXshFiles(sessionsPath)
                }
              }
            }
          } catch (e) {
            // 忽略读取错误
          }
        }

        // %USERPROFILE%\Documents\NetSarang\Xshell\Sessions
        const altPath = path.join(userProfile, 'Documents', 'NetSarang', 'Xshell', 'Sessions')
        if (fs.existsSync(altPath)) {
          paths.push(altPath)
          sessionCount += this.countXshFiles(altPath)
        }
      }

      // %APPDATA%\NetSarang\Xshell\Sessions
      if (appData) {
        const appDataPath = path.join(appData, 'NetSarang', 'Xshell', 'Sessions')
        if (fs.existsSync(appDataPath)) {
          paths.push(appDataPath)
          sessionCount += this.countXshFiles(appDataPath)
        }
      }
    }

    // macOS/Linux (Wine 环境)
    if (process.platform === 'darwin' || process.platform === 'linux') {
      const homeDir = os.homedir()
      const winePrefixes = [
        path.join(homeDir, '.wine'),
        path.join(homeDir, '.wine32'),
        path.join(homeDir, 'Wine')
      ]

      for (const winePrefix of winePrefixes) {
        if (fs.existsSync(winePrefix)) {
          const driveC = path.join(winePrefix, 'drive_c')
          if (fs.existsSync(driveC)) {
            try {
              const usersDir = path.join(driveC, 'users')
              if (fs.existsSync(usersDir)) {
                const users = fs.readdirSync(usersDir, { withFileTypes: true })
                for (const user of users) {
                  if (user.isDirectory()) {
                    // Documents\NetSarang Computer\*\Xshell\Sessions
                    const netsarangBase = path.join(usersDir, user.name, 'Documents', 'NetSarang Computer')
                    if (fs.existsSync(netsarangBase)) {
                      try {
                        const versions = fs.readdirSync(netsarangBase, { withFileTypes: true })
                        for (const version of versions) {
                          if (version.isDirectory()) {
                            const sessionsPath = path.join(netsarangBase, version.name, 'Xshell', 'Sessions')
                            if (fs.existsSync(sessionsPath)) {
                              paths.push(sessionsPath)
                              sessionCount += this.countXshFiles(sessionsPath)
                            }
                          }
                        }
                      } catch (e) {
                        // 忽略读取错误
                      }
                    }

                    // Documents\NetSarang\Xshell\Sessions
                    const altPath = path.join(usersDir, user.name, 'Documents', 'NetSarang', 'Xshell', 'Sessions')
                    if (fs.existsSync(altPath)) {
                      paths.push(altPath)
                      sessionCount += this.countXshFiles(altPath)
                    }
                  }
                }
              }
            } catch (e) {
              // 忽略读取错误
            }
          }
        }
      }
    }

    // 去重路径
    const uniquePaths = Array.from(new Set(paths))

    return {
      found: uniquePaths.length > 0,
      paths: uniquePaths,
      sessionCount
    }
  }
}

