import { ref, computed, onUnmounted } from 'vue'

// 本地文件信息类型
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

// 驱动器信息
export interface DriveInfo {
  name: string
  path: string
  label?: string
  type: 'fixed' | 'removable' | 'network' | 'cdrom' | 'unknown'
}

// 特殊目录
export interface SpecialFolder {
  name: string
  path: string
  icon: string
}

// 历史记录
interface HistoryEntry {
  path: string
  timestamp: number
}

export function useLocalFs() {
  // 状态
  const isLoading = ref(false)
  const currentPath = ref('')
  const files = ref<LocalFileInfo[]>([])
  const error = ref<string | null>(null)
  const separator = ref('/')

  // 导航历史
  const history = ref<HistoryEntry[]>([])
  const historyIndex = ref(-1)

  // 计算属性
  const canGoBack = computed(() => historyIndex.value > 0)
  const canGoForward = computed(() => historyIndex.value < history.value.length - 1)
  const canGoUp = computed(() => {
    if (!currentPath.value) return false
    // Windows: C:\ 不能再上级
    if (currentPath.value.match(/^[A-Z]:\\?$/i)) return false
    // Unix: / 不能再上级
    return currentPath.value !== '/'
  })

  // 初始化
  const initialize = async () => {
    // 获取路径分隔符
    separator.value = await window.electronAPI.localFs.getSeparator()
    
    // 导航到主目录
    const homeDir = await window.electronAPI.localFs.getHomeDir()
    await navigateTo(homeDir, false)
  }

  // 导航到指定路径
  const navigateTo = async (path: string, addToHistory = true) => {
    if (isLoading.value) return

    isLoading.value = true
    error.value = null

    try {
      const result = await window.electronAPI.localFs.list(path)
      if (result.success && result.data) {
        files.value = result.data
        currentPath.value = path

        if (addToHistory) {
          // 截断前进历史
          if (historyIndex.value < history.value.length - 1) {
            history.value = history.value.slice(0, historyIndex.value + 1)
          }
          history.value.push({ path, timestamp: Date.now() })
          historyIndex.value = history.value.length - 1
        }
      } else {
        error.value = result.error || '无法访问目录'
      }
    } catch (e) {
      error.value = e instanceof Error ? e.message : '加载目录失败'
    } finally {
      isLoading.value = false
    }
  }

  // 刷新当前目录
  const refresh = async () => {
    if (currentPath.value) {
      await navigateTo(currentPath.value, false)
    }
  }

  // 后退
  const goBack = async () => {
    if (canGoBack.value) {
      historyIndex.value--
      await navigateTo(history.value[historyIndex.value].path, false)
    }
  }

  // 前进
  const goForward = async () => {
    if (canGoForward.value) {
      historyIndex.value++
      await navigateTo(history.value[historyIndex.value].path, false)
    }
  }

  // 返回上级目录
  const goUp = async () => {
    if (!canGoUp.value) return
    const parentDir = await window.electronAPI.localFs.getParentDir(currentPath.value)
    await navigateTo(parentDir)
  }

  // 返回主目录
  const goHome = async () => {
    const homeDir = await window.electronAPI.localFs.getHomeDir()
    await navigateTo(homeDir)
  }

  // 创建目录
  const createDirectory = async (name: string): Promise<boolean> => {
    const newPath = await window.electronAPI.localFs.joinPath(currentPath.value, name)
    const result = await window.electronAPI.localFs.mkdir(newPath)
    if (result.success) {
      await refresh()
      return true
    }
    error.value = result.error || '创建目录失败'
    return false
  }

  // 删除文件
  const deleteFile = async (filePath: string): Promise<boolean> => {
    const result = await window.electronAPI.localFs.delete(filePath)
    if (result.success) {
      await refresh()
      return true
    }
    error.value = result.error || '删除文件失败'
    return false
  }

  // 删除目录
  const deleteDirectory = async (dirPath: string): Promise<boolean> => {
    const result = await window.electronAPI.localFs.rmdir(dirPath)
    if (result.success) {
      await refresh()
      return true
    }
    error.value = result.error || '删除目录失败'
    return false
  }

  // 重命名
  const rename = async (oldPath: string, newName: string): Promise<boolean> => {
    const dir = await window.electronAPI.localFs.getParentDir(oldPath)
    const newPath = await window.electronAPI.localFs.joinPath(dir, newName)
    
    const result = await window.electronAPI.localFs.rename(oldPath, newPath)
    if (result.success) {
      await refresh()
      return true
    }
    error.value = result.error || '重命名失败'
    return false
  }

  // 复制文件
  const copyFile = async (src: string, destDir: string): Promise<boolean> => {
    const fileName = src.split(separator.value).pop() || 'file'
    const destPath = await window.electronAPI.localFs.joinPath(destDir, fileName)
    
    const result = await window.electronAPI.localFs.copyFile(src, destPath)
    return result.success
  }

  // 复制目录
  const copyDirectory = async (src: string, destDir: string): Promise<boolean> => {
    const dirName = src.split(separator.value).pop() || 'folder'
    const destPath = await window.electronAPI.localFs.joinPath(destDir, dirName)
    
    const result = await window.electronAPI.localFs.copyDir(src, destPath)
    return result.success
  }

  // 读取文本文件
  const readTextFile = async (filePath: string): Promise<string | null> => {
    const result = await window.electronAPI.localFs.readFile(filePath)
    return result.success ? result.data ?? null : null
  }

  // 获取驱动器列表
  const getDrives = async (): Promise<DriveInfo[]> => {
    return window.electronAPI.localFs.getDrives()
  }

  // 获取常用目录
  const getSpecialFolders = async (): Promise<SpecialFolder[]> => {
    return window.electronAPI.localFs.getSpecialFolders()
  }

  // 在系统文件管理器中显示
  const showInExplorer = async (filePath: string) => {
    await window.electronAPI.localFs.showInExplorer(filePath)
  }

  // 用系统默认程序打开
  const openFile = async (filePath: string) => {
    await window.electronAPI.localFs.openFile(filePath)
  }

  // 格式化文件大小
  const formatSize = (bytes: number): string => {
    if (bytes === 0) return '-'
    const units = ['B', 'KB', 'MB', 'GB', 'TB']
    const i = Math.floor(Math.log(bytes) / Math.log(1024))
    return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`
  }

  // 格式化时间
  const formatTime = (timestamp: number): string => {
    const date = new Date(timestamp)
    const now = new Date()
    const isThisYear = date.getFullYear() === now.getFullYear()

    if (isThisYear) {
      return date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }) +
        ' ' + date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    }
    return date.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
  }

  // 格式化权限
  const formatPermissions = (perms: { user: string; group: string; other: string }): string => {
    return `${perms.user}${perms.group}${perms.other}`
  }

  return {
    // 状态
    isLoading,
    currentPath,
    files,
    error,
    separator,
    canGoBack,
    canGoForward,
    canGoUp,

    // 方法
    initialize,
    navigateTo,
    refresh,
    goBack,
    goForward,
    goUp,
    goHome,
    createDirectory,
    deleteFile,
    deleteDirectory,
    rename,
    copyFile,
    copyDirectory,
    readTextFile,
    getDrives,
    getSpecialFolders,
    showInExplorer,
    openFile,

    // 工具函数
    formatSize,
    formatTime,
    formatPermissions
  }
}
