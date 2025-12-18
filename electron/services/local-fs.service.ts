import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { EventEmitter } from 'events'

// 本地文件信息类型（与 SFTP 保持一致的结构）
export interface LocalFileInfo {
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
}

// 驱动器信息（Windows）
export interface DriveInfo {
  name: string      // 驱动器名称，如 "C:"
  path: string      // 驱动器路径，如 "C:\\"
  label?: string    // 卷标
  type: 'fixed' | 'removable' | 'network' | 'cdrom' | 'unknown'
}

export class LocalFsService extends EventEmitter {
  /**
   * 获取用户主目录
   */
  getHomeDir(): string {
    return os.homedir()
  }

  /**
   * 获取驱动器列表（主要用于 Windows）
   */
  async getDrives(): Promise<DriveInfo[]> {
    if (process.platform !== 'win32') {
      // 非 Windows 返回根目录
      return [{ name: '/', path: '/', type: 'fixed' }]
    }

    const drives: DriveInfo[] = []
    // Windows 上检查 A-Z 驱动器
    for (let i = 65; i <= 90; i++) {
      const letter = String.fromCharCode(i)
      const drivePath = `${letter}:\\`
      try {
        fs.accessSync(drivePath, fs.constants.R_OK)
        drives.push({
          name: `${letter}:`,
          path: drivePath,
          type: 'fixed'
        })
      } catch {
        // 驱动器不存在或不可访问
      }
    }
    return drives
  }

  /**
   * 列出目录内容
   */
  async list(dirPath: string): Promise<LocalFileInfo[]> {
    const normalizedPath = path.normalize(dirPath)
    
    // 读取目录内容
    const entries = await fs.promises.readdir(normalizedPath, { withFileTypes: true })
    const files: LocalFileInfo[] = []

    for (const entry of entries) {
      // 跳过隐藏文件（以 . 开头），但不跳过 .. 
      // 实际上我们不需要 . 和 .. 项
      if (entry.name === '.' || entry.name === '..') continue

      const fullPath = path.join(normalizedPath, entry.name)
      
      try {
        // 使用 lstat 获取文件信息（不解析符号链接）
        const stats = await fs.promises.lstat(fullPath)
        
        files.push({
          name: entry.name,
          path: fullPath,
          size: stats.size,
          modifyTime: stats.mtimeMs,
          accessTime: stats.atimeMs,
          isDirectory: stats.isDirectory(),
          isSymlink: stats.isSymbolicLink(),
          permissions: this.formatMode(stats.mode)
        })
      } catch (err) {
        // 无法访问的文件跳过
        console.warn(`[LocalFs] 无法访问: ${fullPath}`, err)
      }
    }

    // 排序：目录在前，然后按名称排序
    return files.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1
      if (!a.isDirectory && b.isDirectory) return 1
      return a.name.localeCompare(b.name, 'zh-CN')
    })
  }

  /**
   * 获取文件/目录信息
   */
  async stat(filePath: string): Promise<LocalFileInfo | null> {
    try {
      const normalizedPath = path.normalize(filePath)
      const stats = await fs.promises.lstat(normalizedPath)
      
      return {
        name: path.basename(normalizedPath),
        path: normalizedPath,
        size: stats.size,
        modifyTime: stats.mtimeMs,
        accessTime: stats.atimeMs,
        isDirectory: stats.isDirectory(),
        isSymlink: stats.isSymbolicLink(),
        permissions: this.formatMode(stats.mode)
      }
    } catch {
      return null
    }
  }

  /**
   * 检查路径是否存在
   */
  async exists(filePath: string): Promise<false | 'd' | '-' | 'l'> {
    try {
      const normalizedPath = path.normalize(filePath)
      const stats = await fs.promises.lstat(normalizedPath)
      
      if (stats.isSymbolicLink()) return 'l'
      if (stats.isDirectory()) return 'd'
      return '-'
    } catch {
      return false
    }
  }

  /**
   * 创建目录
   */
  async mkdir(dirPath: string, recursive = true): Promise<void> {
    const normalizedPath = path.normalize(dirPath)
    await fs.promises.mkdir(normalizedPath, { recursive })
  }

  /**
   * 删除文件
   */
  async delete(filePath: string): Promise<void> {
    const normalizedPath = path.normalize(filePath)
    await fs.promises.unlink(normalizedPath)
  }

  /**
   * 删除目录（递归）
   */
  async rmdir(dirPath: string, recursive = true): Promise<void> {
    const normalizedPath = path.normalize(dirPath)
    await fs.promises.rm(normalizedPath, { recursive, force: true })
  }

  /**
   * 重命名/移动
   */
  async rename(oldPath: string, newPath: string): Promise<void> {
    const normalizedOld = path.normalize(oldPath)
    const normalizedNew = path.normalize(newPath)
    await fs.promises.rename(normalizedOld, normalizedNew)
  }

  /**
   * 复制文件
   */
  async copyFile(src: string, dest: string): Promise<void> {
    const normalizedSrc = path.normalize(src)
    const normalizedDest = path.normalize(dest)
    await fs.promises.copyFile(normalizedSrc, normalizedDest)
  }

  /**
   * 复制目录（递归）
   */
  async copyDir(src: string, dest: string): Promise<void> {
    const normalizedSrc = path.normalize(src)
    const normalizedDest = path.normalize(dest)
    await fs.promises.cp(normalizedSrc, normalizedDest, { recursive: true })
  }

  /**
   * 读取文本文件
   */
  async readFile(filePath: string, encoding: BufferEncoding = 'utf-8'): Promise<string> {
    const normalizedPath = path.normalize(filePath)
    return fs.promises.readFile(normalizedPath, { encoding })
  }

  /**
   * 写入文本文件
   */
  async writeFile(filePath: string, content: string, encoding: BufferEncoding = 'utf-8'): Promise<void> {
    const normalizedPath = path.normalize(filePath)
    await fs.promises.writeFile(normalizedPath, content, { encoding })
  }

  /**
   * 获取上级目录
   */
  getParentDir(filePath: string): string {
    const normalizedPath = path.normalize(filePath)
    return path.dirname(normalizedPath)
  }

  /**
   * 拼接路径
   */
  joinPath(...parts: string[]): string {
    return path.join(...parts)
  }

  /**
   * 获取路径分隔符
   */
  getSeparator(): string {
    return path.sep
  }

  /**
   * 获取常用目录
   */
  getSpecialFolders(): { name: string; path: string; icon: string }[] {
    const home = os.homedir()
    const folders = [
      { name: '主目录', path: home, icon: 'home' },
      { name: '桌面', path: path.join(home, 'Desktop'), icon: 'desktop' },
      { name: '文档', path: path.join(home, 'Documents'), icon: 'documents' },
      { name: '下载', path: path.join(home, 'Downloads'), icon: 'downloads' },
    ]

    // 根据系统添加额外目录
    if (process.platform === 'darwin') {
      folders.push({ name: '应用程序', path: '/Applications', icon: 'applications' })
    } else if (process.platform === 'win32') {
      folders.push({ name: '我的电脑', path: '', icon: 'computer' })  // 特殊处理
    } else {
      folders.push({ name: '根目录', path: '/', icon: 'root' })
    }

    // 过滤不存在的目录
    return folders.filter(f => {
      if (!f.path) return true  // 特殊目录
      try {
        fs.accessSync(f.path, fs.constants.R_OK)
        return true
      } catch {
        return false
      }
    })
  }

  /**
   * 在系统文件管理器中显示文件
   */
  async showInExplorer(filePath: string): Promise<void> {
    const { shell } = await import('electron')
    const normalizedPath = path.normalize(filePath)
    shell.showItemInFolder(normalizedPath)
  }

  /**
   * 用系统默认程序打开文件
   */
  async openFile(filePath: string): Promise<void> {
    const { shell } = await import('electron')
    const normalizedPath = path.normalize(filePath)
    await shell.openPath(normalizedPath)
  }

  /**
   * 格式化文件 mode 为权限字符串
   */
  private formatMode(mode: number): { user: string; group: string; other: string } {
    const formatTriple = (m: number): string => {
      return (
        ((m & 4) ? 'r' : '-') +
        ((m & 2) ? 'w' : '-') +
        ((m & 1) ? 'x' : '-')
      )
    }

    return {
      user: formatTriple((mode >> 6) & 7),
      group: formatTriple((mode >> 3) & 7),
      other: formatTriple(mode & 7)
    }
  }
}

