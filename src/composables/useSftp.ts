import { ref, computed, onUnmounted } from 'vue'

// SFTP 文件信息类型
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

// 传输进度类型
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

// SFTP 连接配置
export interface SftpConnectionConfig {
  host: string
  port: number
  username: string
  password?: string
  privateKeyPath?: string
  passphrase?: string
}

// 历史记录
interface HistoryEntry {
  path: string
  timestamp: number
}

export function useSftp() {
  // 状态
  const sessionId = ref<string | null>(null)
  const isConnected = ref(false)
  const isConnecting = ref(false)
  const isLoading = ref(false)
  const currentPath = ref('/')
  const files = ref<SftpFileInfo[]>([])
  const transfers = ref<TransferProgress[]>([])
  const error = ref<string | null>(null)
  const connectionInfo = ref<{ host: string; username: string } | null>(null)

  // 导航历史
  const history = ref<HistoryEntry[]>([])
  const historyIndex = ref(-1)

  // 计算属性
  const canGoBack = computed(() => historyIndex.value > 0)
  const canGoForward = computed(() => historyIndex.value < history.value.length - 1)

  // 事件监听器清理函数
  const cleanupFns: (() => void)[] = []

  // 初始化传输事件监听
  const initTransferListeners = () => {
    const onStart = window.electronAPI.sftp.onTransferStart((progress) => {
      const existing = transfers.value.find(t => t.transferId === progress.transferId)
      if (!existing) {
        transfers.value.push(progress)
      }
    })
    cleanupFns.push(onStart)

    const onProgress = window.electronAPI.sftp.onTransferProgress((progress) => {
      const index = transfers.value.findIndex(t => t.transferId === progress.transferId)
      if (index !== -1) {
        transfers.value[index] = progress
      }
    })
    cleanupFns.push(onProgress)

    const onComplete = window.electronAPI.sftp.onTransferComplete((progress) => {
      const index = transfers.value.findIndex(t => t.transferId === progress.transferId)
      if (index !== -1) {
        transfers.value[index] = progress
      }
      // 刷新当前目录
      if (progress.direction === 'upload') {
        refresh()
      }
    })
    cleanupFns.push(onComplete)

    const onError = window.electronAPI.sftp.onTransferError((progress) => {
      const index = transfers.value.findIndex(t => t.transferId === progress.transferId)
      if (index !== -1) {
        transfers.value[index] = progress
      }
    })
    cleanupFns.push(onError)

    const onCancelled = window.electronAPI.sftp.onTransferCancelled((progress: TransferProgress) => {
      const index = transfers.value.findIndex(t => t.transferId === progress.transferId)
      if (index !== -1) {
        transfers.value[index] = progress
      }
    })
    cleanupFns.push(onCancelled)
  }

  // 取消传输
  const cancelTransfer = async (transferId: string): Promise<boolean> => {
    const result = await window.electronAPI.sftp.cancelTransfer(transferId)
    return result.success
  }

  // 清除已完成的传输
  const clearCompletedTransfers = () => {
    transfers.value = transfers.value.filter(
      t => t.status === 'transferring' || t.status === 'pending'
    )
  }

  // 清除所有传输
  const clearAllTransfers = () => {
    transfers.value = []
  }

  // 连接 SFTP
  const connect = async (config: SftpConnectionConfig): Promise<boolean> => {
    if (isConnecting.value) return false

    isConnecting.value = true
    error.value = null

    try {
      const id = `sftp-${Date.now()}`
      const result = await window.electronAPI.sftp.connect(id, {
        host: config.host,
        port: config.port,
        username: config.username,
        password: config.password,
        privateKeyPath: config.privateKeyPath,
        passphrase: config.passphrase
      })

      if (result.success) {
        sessionId.value = id
        isConnected.value = true
        connectionInfo.value = { host: config.host, username: config.username }

        // 初始化传输监听
        initTransferListeners()

        // 获取初始目录
        const pwdResult = await window.electronAPI.sftp.pwd(id)
        if (pwdResult.success && pwdResult.data) {
          await navigateTo(pwdResult.data, false)
        } else {
          await navigateTo('/', false)
        }

        return true
      } else {
        // 显示后端返回的具体错误信息
        error.value = result.error || '连接失败'
        return false
      }
    } catch (e) {
      // 显示具体错误信息
      error.value = e instanceof Error ? e.message : '连接失败'
      return false
    } finally {
      isConnecting.value = false
    }
  }

  // 断开连接
  const disconnect = async () => {
    if (sessionId.value) {
      await window.electronAPI.sftp.disconnect(sessionId.value)
    }
    sessionId.value = null
    isConnected.value = false
    currentPath.value = '/'
    files.value = []
    transfers.value = []
    history.value = []
    historyIndex.value = -1
    connectionInfo.value = null

    // 清理事件监听
    cleanupFns.forEach(fn => fn())
    cleanupFns.length = 0
  }

  // 导航到指定路径
  const navigateTo = async (path: string, addToHistory = true) => {
    if (!sessionId.value || isLoading.value) return

    isLoading.value = true
    error.value = null

    try {
      const result = await window.electronAPI.sftp.list(sessionId.value, path)
      if (result.success && result.data) {
        files.value = result.data
        // 使用解析后的实际路径（处理 ~ 等特殊路径）
        const actualPath = result.resolvedPath || path
        currentPath.value = actualPath

        if (addToHistory) {
          // 截断前进历史
          if (historyIndex.value < history.value.length - 1) {
            history.value = history.value.slice(0, historyIndex.value + 1)
          }
          history.value.push({ path: actualPath, timestamp: Date.now() })
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
    await navigateTo(currentPath.value, false)
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
    if (currentPath.value === '/') return
    const parts = currentPath.value.split('/').filter(Boolean)
    parts.pop()
    const parentPath = '/' + parts.join('/')
    await navigateTo(parentPath || '/')
  }

  // 返回主目录
  const goHome = async () => {
    if (!sessionId.value) return
    const result = await window.electronAPI.sftp.pwd(sessionId.value)
    if (result.success && result.data) {
      await navigateTo(result.data)
    }
  }

  // 上传文件
  const uploadFile = async (localPath: string, remotePath: string): Promise<boolean> => {
    if (!sessionId.value) return false

    const transferId = `upload-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const result = await window.electronAPI.sftp.upload(
      sessionId.value,
      localPath,
      remotePath,
      transferId
    )

    return result.success
  }

  // 上传多个文件
  const uploadFiles = async (localPaths: string[]): Promise<void> => {
    for (const localPath of localPaths) {
      const filename = localPath.split(/[/\\]/).pop() || 'file'
      const remotePath = currentPath.value.endsWith('/')
        ? currentPath.value + filename
        : currentPath.value + '/' + filename
      await uploadFile(localPath, remotePath)
    }
  }

  // 下载文件
  const downloadFile = async (remotePath: string, localPath: string): Promise<boolean> => {
    if (!sessionId.value) return false

    const transferId = `download-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const result = await window.electronAPI.sftp.download(
      sessionId.value,
      remotePath,
      localPath,
      transferId
    )

    return result.success
  }

  // 创建目录
  const createDirectory = async (name: string): Promise<boolean> => {
    if (!sessionId.value) return false

    const path = currentPath.value.endsWith('/')
      ? currentPath.value + name
      : currentPath.value + '/' + name

    const result = await window.electronAPI.sftp.mkdir(sessionId.value, path)
    if (result.success) {
      await refresh()
    }
    return result.success
  }

  // 删除文件
  const deleteFile = async (remotePath: string): Promise<boolean> => {
    if (!sessionId.value) return false

    const result = await window.electronAPI.sftp.delete(sessionId.value, remotePath)
    if (result.success) {
      await refresh()
    }
    return result.success
  }

  // 删除目录
  const deleteDirectory = async (remotePath: string): Promise<boolean> => {
    if (!sessionId.value) return false

    const result = await window.electronAPI.sftp.rmdir(sessionId.value, remotePath)
    if (result.success) {
      await refresh()
    }
    return result.success
  }

  // 重命名
  const rename = async (oldPath: string, newName: string): Promise<boolean> => {
    if (!sessionId.value) return false

    const dir = oldPath.substring(0, oldPath.lastIndexOf('/'))
    const newPath = dir ? `${dir}/${newName}` : `/${newName}`

    const result = await window.electronAPI.sftp.rename(sessionId.value, oldPath, newPath)
    if (result.success) {
      await refresh()
    }
    return result.success
  }

  // 读取文本文件
  const readTextFile = async (remotePath: string): Promise<string | null> => {
    if (!sessionId.value) return null

    const result = await window.electronAPI.sftp.readFile(sessionId.value, remotePath)
    if (result.success && result.data) {
      return result.data
    }
    return null
  }

  // 选择本地文件上传
  const selectAndUpload = async (): Promise<void> => {
    const result = await window.electronAPI.sftp.selectLocalFiles()
    if (!result.canceled && result.files.length > 0) {
      const paths = result.files.map(f => f.path)
      await uploadFiles(paths)
    }
  }

  // 选择保存位置并下载
  const selectAndDownload = async (file: SftpFileInfo): Promise<void> => {
    const result = await window.electronAPI.sftp.selectSavePath(file.name)
    if (!result.canceled && result.path) {
      await downloadFile(file.path, result.path)
    }
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

  // 清理
  onUnmounted(() => {
    disconnect()
  })

  return {
    // 状态
    sessionId,
    isConnected,
    isConnecting,
    isLoading,
    currentPath,
    files,
    transfers,
    error,
    connectionInfo,
    canGoBack,
    canGoForward,

    // 方法
    connect,
    disconnect,
    navigateTo,
    refresh,
    goBack,
    goForward,
    goUp,
    goHome,
    uploadFile,
    uploadFiles,
    downloadFile,
    createDirectory,
    deleteFile,
    deleteDirectory,
    rename,
    readTextFile,
    selectAndUpload,
    selectAndDownload,
    cancelTransfer,
    clearCompletedTransfers,
    clearAllTransfers,

    // 工具函数
    formatSize,
    formatTime,
    formatPermissions
  }
}
