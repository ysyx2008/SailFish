import SftpClient from 'ssh2-sftp-client'
import * as fs from 'fs'
import * as path from 'path'
import { EventEmitter } from 'events'

export interface SftpConfig {
  host: string
  port: number
  username: string
  password?: string
  privateKey?: string | Buffer
  privateKeyPath?: string
  passphrase?: string
}

export interface SftpFileInfo {
  name: string
  path: string
  size: number
  modifyTime: number
  accessTime: number
  isDirectory: boolean
  isSymlink: boolean
  permissions: {
    user: string
    group: string
    other: string
  }
  owner: number
  group: number
}

export interface TransferProgress {
  transferId: string
  filename: string
  localPath: string
  remotePath: string
  direction: 'upload' | 'download'
  totalBytes: number
  transferredBytes: number
  percent: number
  status: 'pending' | 'transferring' | 'completed' | 'failed' | 'cancelled'
  error?: string
  startTime: number
}

export interface TransferTask {
  id: string
  sessionId: string
  localPath: string
  remotePath: string
  direction: 'upload' | 'download'
  status: 'pending' | 'transferring' | 'completed' | 'failed' | 'cancelled'
  error?: string
}

export class SftpService extends EventEmitter {
  private sessions: Map<string, SftpClient> = new Map()
  private transfers: Map<string, TransferProgress> = new Map()
  private cancelledTransfers: Set<string> = new Set()

  /**
   * 创建 SFTP 连接
   */
  async connect(sessionId: string, config: SftpConfig): Promise<void> {
    // 如果已存在连接，先关闭
    if (this.sessions.has(sessionId)) {
      await this.disconnect(sessionId)
    }

    const sftp = new SftpClient()

    // 准备私钥
    let privateKey: string | Buffer | undefined = config.privateKey
    if (!privateKey && config.privateKeyPath) {
      try {
        privateKey = fs.readFileSync(config.privateKeyPath)
      } catch (err) {
        throw new Error(`无法读取私钥文件: ${config.privateKeyPath}`)
      }
    }

    const connectConfig: SftpClient.ConnectOptions = {
      host: config.host,
      port: config.port,
      username: config.username,
      readyTimeout: 30000,
      retries: 2,
      retry_factor: 2,
      retry_minTimeout: 2000
    }

    if (privateKey) {
      connectConfig.privateKey = privateKey
      if (config.passphrase) {
        connectConfig.passphrase = config.passphrase
      }
    } else if (config.password) {
      connectConfig.password = config.password
    }

    await sftp.connect(connectConfig)
    this.sessions.set(sessionId, sftp)
  }

  /**
   * 断开 SFTP 连接
   */
  async disconnect(sessionId: string): Promise<void> {
    const sftp = this.sessions.get(sessionId)
    if (sftp) {
      try {
        await sftp.end()
      } catch (e) {
        // 忽略关闭错误
      }
      this.sessions.delete(sessionId)
    }
  }

  /**
   * 断开所有连接
   */
  async disconnectAll(): Promise<void> {
    const promises = Array.from(this.sessions.keys()).map(id => this.disconnect(id))
    await Promise.all(promises)
  }

  /**
   * 检查连接是否存在
   */
  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  /**
   * 列出目录内容
   */
  async list(sessionId: string, remotePath: string): Promise<{ files: SftpFileInfo[]; resolvedPath: string }> {
    const sftp = this.sessions.get(sessionId)
    if (!sftp) throw new Error('SFTP 会话不存在')

    // 修复错误的路径格式（如 /~ 或 /~/xxx 应该是 ~ 或 ~/xxx）
    if (remotePath === '/~' || remotePath.startsWith('/~/')) {
      remotePath = remotePath.slice(1) // 移除开头的 /
      console.log(`[SFTP] 修复路径格式: ${remotePath.slice(0, 1) === '~' ? '/~ -> ~' : '/~/ -> ~/'}`)
    }

    // 解析 ~ 路径 - SFTP 协议不支持 ~，必须展开为绝对路径
    let resolvedPath = remotePath
    if (remotePath === '~' || remotePath.startsWith('~/')) {
      console.log(`[SFTP] 开始解析 ~ 路径: ${remotePath}`)
      try {
        // sftp.cwd() 返回 SFTP 会话的当前工作目录（通常是 home 目录）
        const homePath = await sftp.cwd()
        console.log(`[SFTP] sftp.cwd() 返回: ${homePath}`)
        
        if (remotePath === '~') {
          resolvedPath = homePath
        } else {
          // ~/xxx -> /home/user/xxx
          resolvedPath = homePath + remotePath.slice(1)
        }
        console.log(`[SFTP] ~ 路径解析: ${remotePath} -> ${resolvedPath}`)
      } catch (e) {
        console.error(`[SFTP] sftp.cwd() 失败:`, e)
        // 回退：尝试使用 realpath
        try {
          const realHome = await sftp.realPath('~')
          console.log(`[SFTP] sftp.realPath('~') 返回: ${realHome}`)
          if (remotePath === '~') {
            resolvedPath = realHome
          } else {
            resolvedPath = realHome + remotePath.slice(1)
          }
        } catch (e2) {
          console.error(`[SFTP] sftp.realPath('~') 也失败:`, e2)
          // 最后的回退：直接用 . 作为 home
          resolvedPath = remotePath === '~' ? '.' : '.' + remotePath.slice(1)
          console.log(`[SFTP] 使用回退路径: ${resolvedPath}`)
        }
      }
    }

    const list = await sftp.list(resolvedPath)

    const files = list.map(item => ({
      name: item.name,
      path: path.posix.join(resolvedPath, item.name),
      size: item.size,
      modifyTime: item.modifyTime,
      accessTime: item.accessTime,
      isDirectory: item.type === 'd',
      isSymlink: item.type === 'l',
      permissions: {
        user: this.formatPermission((item.rights?.user as string) || ''),
        group: this.formatPermission((item.rights?.group as string) || ''),
        other: this.formatPermission((item.rights?.other as string) || '')
      },
      owner: item.owner,
      group: item.group
    })).sort((a, b) => {
      // 目录在前
      if (a.isDirectory && !b.isDirectory) return -1
      if (!a.isDirectory && b.isDirectory) return 1
      return a.name.localeCompare(b.name)
    })

    return { files, resolvedPath }
  }

  /**
   * 获取当前工作目录
   */
  async pwd(sessionId: string): Promise<string> {
    const sftp = this.sessions.get(sessionId)
    if (!sftp) throw new Error('SFTP 会话不存在')
    return sftp.cwd()
  }

  /**
   * 获取文件/目录信息
   */
  async stat(sessionId: string, remotePath: string): Promise<SftpClient.FileStats | null> {
    const sftp = this.sessions.get(sessionId)
    if (!sftp) throw new Error('SFTP 会话不存在')

    try {
      return await sftp.stat(remotePath)
    } catch {
      return null
    }
  }

  /**
   * 检查路径是否存在
   */
  async exists(sessionId: string, remotePath: string): Promise<false | 'd' | '-' | 'l'> {
    const sftp = this.sessions.get(sessionId)
    if (!sftp) throw new Error('SFTP 会话不存在')
    return sftp.exists(remotePath)
  }

  /**
   * 上传文件
   */
  async upload(
    sessionId: string,
    localPath: string,
    remotePath: string,
    transferId: string
  ): Promise<void> {
    const sftp = this.sessions.get(sessionId)
    if (!sftp) throw new Error('SFTP 会话不存在')

    // 检查本地文件是否存在和可读
    let stats: fs.Stats
    try {
      stats = fs.statSync(localPath)
    } catch (err: unknown) {
      const nodeErr = err as NodeJS.ErrnoException
      if (nodeErr.code === 'ENOENT') {
        throw new Error(`文件不存在: ${localPath}`)
      } else if (nodeErr.code === 'EACCES' || nodeErr.code === 'EPERM') {
        throw new Error(`无权限读取文件: ${localPath}，请检查文件权限设置`)
      } else {
        throw new Error(`无法读取文件: ${localPath}，${nodeErr.message}`)
      }
    }

    // 检查是否有读取权限
    try {
      fs.accessSync(localPath, fs.constants.R_OK)
    } catch {
      throw new Error(`无权限读取文件: ${localPath}，请检查文件权限设置`)
    }

    const totalBytes = stats.size

    const progress: TransferProgress = {
      transferId,
      filename: path.basename(localPath),
      localPath,
      remotePath,
      direction: 'upload',
      totalBytes,
      transferredBytes: 0,
      percent: 0,
      status: 'transferring',
      startTime: Date.now()
    }
    this.transfers.set(transferId, progress)
    this.emit('transfer-start', { ...progress })

    try {
      await sftp.put(localPath, remotePath, {
        step: (transferred: number, _chunk: number, total: number) => {
          // 检查是否已取消
          if (this.isTransferCancelled(transferId)) {
            return
          }
          progress.transferredBytes = transferred
          progress.percent = total > 0 ? Math.round((transferred / total) * 100) : 0
          this.emit('transfer-progress', { ...progress })
        }
      })

      // 检查是否在传输过程中被取消
      if (this.isTransferCancelled(transferId)) {
        this.clearCancelledTransfer(transferId)
        return
      }

      progress.status = 'completed'
      progress.percent = 100
      progress.transferredBytes = totalBytes
      this.emit('transfer-complete', { ...progress })
    } catch (err: unknown) {
      const nodeErr = err as NodeJS.ErrnoException
      let errorMessage = '上传失败'

      // 处理本地文件读取权限错误
      if (nodeErr.code === 'EACCES' || nodeErr.code === 'EPERM') {
        errorMessage = `无权限读取文件: ${localPath}，请检查文件权限设置`
      } else if (nodeErr.code === 'ENOENT') {
        errorMessage = `文件不存在: ${localPath}`
      } else if (nodeErr.message) {
        // 检查是否是远程服务器权限错误
        if (nodeErr.message.includes('Permission denied') || nodeErr.message.includes('permission denied')) {
          errorMessage = `远程服务器拒绝写入: ${remotePath}，请检查目标目录权限`
        } else {
          errorMessage = nodeErr.message
        }
      }

      progress.status = 'failed'
      progress.error = errorMessage
      this.emit('transfer-error', { ...progress })
      throw new Error(errorMessage)
    } finally {
      this.transfers.delete(transferId)
    }
  }

  /**
   * 下载文件
   */
  async download(
    sessionId: string,
    remotePath: string,
    localPath: string,
    transferId: string
  ): Promise<void> {
    const sftp = this.sessions.get(sessionId)
    if (!sftp) throw new Error('SFTP 会话不存在')

    // 获取远程文件大小
    const stats = await sftp.stat(remotePath)
    const totalBytes = stats.size

    const progress: TransferProgress = {
      transferId,
      filename: path.basename(remotePath),
      localPath,
      remotePath,
      direction: 'download',
      totalBytes,
      transferredBytes: 0,
      percent: 0,
      status: 'transferring',
      startTime: Date.now()
    }
    this.transfers.set(transferId, progress)
    this.emit('transfer-start', { ...progress })

    try {
      // 确保本地目录存在
      const localDir = path.dirname(localPath)
      if (!fs.existsSync(localDir)) {
        fs.mkdirSync(localDir, { recursive: true })
      }

      await sftp.get(remotePath, localPath, {
        step: (transferred: number, _chunk: number, total: number) => {
          // 检查是否已取消
          if (this.isTransferCancelled(transferId)) {
            return
          }
          progress.transferredBytes = transferred
          progress.percent = total > 0 ? Math.round((transferred / total) * 100) : 0
          this.emit('transfer-progress', { ...progress })
        }
      })

      // 检查是否在传输过程中被取消
      if (this.isTransferCancelled(transferId)) {
        this.clearCancelledTransfer(transferId)
        // 尝试删除未完成的本地文件
        try {
          if (fs.existsSync(localPath)) {
            fs.unlinkSync(localPath)
          }
        } catch {
          // 忽略删除失败
        }
        return
      }

      progress.status = 'completed'
      progress.percent = 100
      progress.transferredBytes = totalBytes
      this.emit('transfer-complete', { ...progress })
    } catch (err) {
      progress.status = 'failed'
      progress.error = err instanceof Error ? err.message : '下载失败'
      this.emit('transfer-error', { ...progress })
      throw err
    } finally {
      this.transfers.delete(transferId)
    }
  }

  /**
   * 上传目录（递归）
   */
  async uploadDir(
    sessionId: string,
    localDir: string,
    remoteDir: string
  ): Promise<void> {
    const sftp = this.sessions.get(sessionId)
    if (!sftp) throw new Error('SFTP 会话不存在')

    // 检查本地目录是否存在和可读
    try {
      const stats = fs.statSync(localDir)
      if (!stats.isDirectory()) {
        throw new Error(`路径不是目录: ${localDir}`)
      }
    } catch (err: unknown) {
      const nodeErr = err as NodeJS.ErrnoException
      if (nodeErr.code === 'ENOENT') {
        throw new Error(`目录不存在: ${localDir}`)
      } else if (nodeErr.code === 'EACCES' || nodeErr.code === 'EPERM') {
        throw new Error(`无权限访问目录: ${localDir}，请检查目录权限设置`)
      } else if (nodeErr.message?.includes('路径不是目录')) {
        throw nodeErr
      } else {
        throw new Error(`无法访问目录: ${localDir}，${nodeErr.message}`)
      }
    }

    try {
      fs.accessSync(localDir, fs.constants.R_OK)
    } catch {
      throw new Error(`无权限读取目录: ${localDir}，请检查目录权限设置`)
    }

    try {
      await sftp.uploadDir(localDir, remoteDir)
    } catch (err: unknown) {
      const nodeErr = err as NodeJS.ErrnoException
      // 处理上传过程中可能遇到的权限问题
      if (nodeErr.code === 'EACCES' || nodeErr.code === 'EPERM') {
        throw new Error(`上传目录时权限不足，可能某些文件无法读取: ${nodeErr.message}`)
      }
      throw err
    }
  }

  /**
   * 下载目录（递归）
   */
  async downloadDir(
    sessionId: string,
    remoteDir: string,
    localDir: string
  ): Promise<void> {
    const sftp = this.sessions.get(sessionId)
    if (!sftp) throw new Error('SFTP 会话不存在')
    await sftp.downloadDir(remoteDir, localDir)
  }

  /**
   * 创建目录
   */
  async mkdir(sessionId: string, remotePath: string, recursive = true): Promise<void> {
    const sftp = this.sessions.get(sessionId)
    if (!sftp) throw new Error('SFTP 会话不存在')
    await sftp.mkdir(remotePath, recursive)
  }

  /**
   * 删除文件
   */
  async delete(sessionId: string, remotePath: string): Promise<void> {
    const sftp = this.sessions.get(sessionId)
    if (!sftp) throw new Error('SFTP 会话不存在')
    await sftp.delete(remotePath)
  }

  /**
   * 删除目录
   */
  async rmdir(sessionId: string, remotePath: string, recursive = true): Promise<void> {
    const sftp = this.sessions.get(sessionId)
    if (!sftp) throw new Error('SFTP 会话不存在')
    await sftp.rmdir(remotePath, recursive)
  }

  /**
   * 重命名/移动
   */
  async rename(sessionId: string, oldPath: string, newPath: string): Promise<void> {
    const sftp = this.sessions.get(sessionId)
    if (!sftp) throw new Error('SFTP 会话不存在')
    await sftp.rename(oldPath, newPath)
  }

  /**
   * 修改权限
   */
  async chmod(sessionId: string, remotePath: string, mode: string | number): Promise<void> {
    const sftp = this.sessions.get(sessionId)
    if (!sftp) throw new Error('SFTP 会话不存在')
    await sftp.chmod(remotePath, mode)
  }

  /**
   * 获取实时大小（通过 stat）
   */
  async getSize(sessionId: string, remotePath: string): Promise<number> {
    const sftp = this.sessions.get(sessionId)
    if (!sftp) throw new Error('SFTP 会话不存在')
    const stats = await sftp.stat(remotePath)
    return stats.size
  }

  /**
   * 读取文本文件内容
   */
  async readFile(sessionId: string, remotePath: string): Promise<string> {
    const sftp = this.sessions.get(sessionId)
    if (!sftp) throw new Error('SFTP 会话不存在')
    const buffer = await sftp.get(remotePath) as Buffer
    return buffer.toString('utf-8')
  }

  /**
   * 写入文本文件
   */
  async writeFile(sessionId: string, remotePath: string, content: string): Promise<void> {
    const sftp = this.sessions.get(sessionId)
    if (!sftp) throw new Error('SFTP 会话不存在')
    const buffer = Buffer.from(content, 'utf-8')
    await sftp.put(buffer, remotePath)
  }

  /**
   * 获取当前传输状态
   */
  getTransfers(): TransferProgress[] {
    return Array.from(this.transfers.values())
  }

  /**
   * 取消传输
   * 注意：由于 ssh2-sftp-client 不支持真正取消传输，
   * 这里只是标记传输为已取消，并发送取消事件
   */
  cancelTransfer(transferId: string): boolean {
    const transfer = this.transfers.get(transferId)
    if (!transfer) return false
    
    // 如果传输还在进行中，标记为取消
    if (transfer.status === 'transferring' || transfer.status === 'pending') {
      this.cancelledTransfers.add(transferId)
      transfer.status = 'cancelled'
      this.emit('transfer-cancelled', { ...transfer })
      this.transfers.delete(transferId)
      return true
    }
    
    return false
  }

  /**
   * 检查传输是否已被取消
   */
  isTransferCancelled(transferId: string): boolean {
    return this.cancelledTransfers.has(transferId)
  }

  /**
   * 清理已取消的传输记录
   */
  clearCancelledTransfer(transferId: string): void {
    this.cancelledTransfers.delete(transferId)
  }

  /**
   * 格式化权限字符串
   */
  private formatPermission(perm: string): string {
    if (!perm) return '---'
    let result = ''
    result += perm.includes('r') ? 'r' : '-'
    result += perm.includes('w') ? 'w' : '-'
    result += perm.includes('x') ? 'x' : '-'
    return result
  }
}
