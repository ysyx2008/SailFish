/**
 * 终端屏幕内容服务
 * 
 * 提供从渲染进程 xterm buffer 直接读取终端内容的能力。
 * 这比通过 PTY 输出拼接的数据更准确，因为 xterm buffer 是终端内容的唯一真实来源。
 */
import { BrowserWindow, ipcMain } from 'electron'

// 存储待处理的请求
const pendingRequests = new Map<string, {
  resolve: (value: string[] | null) => void
  reject: (reason: Error) => void
  timeout: NodeJS.Timeout
}>()

// 是否已初始化
let isInitialized = false

/**
 * 初始化屏幕内容服务
 * 注册 IPC 响应监听器
 */
export function initScreenContentService(): void {
  if (isInitialized) return
  
  // 监听来自渲染进程的响应
  ipcMain.on('screen:responseLastNLines', (_event, data: { requestId: string; lines: string[] | null }) => {
    const request = pendingRequests.get(data.requestId)
    if (request) {
      clearTimeout(request.timeout)
      pendingRequests.delete(data.requestId)
      request.resolve(data.lines)
    }
  })

  ipcMain.on('screen:responseVisibleContent', (_event, data: { requestId: string; lines: string[] | null }) => {
    const request = pendingRequests.get(data.requestId)
    if (request) {
      clearTimeout(request.timeout)
      pendingRequests.delete(data.requestId)
      request.resolve(data.lines)
    }
  })
  
  isInitialized = true
}

/**
 * 获取主窗口
 */
function getMainWindow(): BrowserWindow | null {
  const windows = BrowserWindow.getAllWindows()
  return windows.length > 0 ? windows[0] : null
}

/**
 * 从 xterm buffer 获取最近 N 行输出
 * 
 * @param ptyId 终端 ID
 * @param lines 要获取的行数
 * @param timeoutMs 超时时间（毫秒），默认 3000
 * @returns 行数组，如果失败返回 null
 */
export async function getLastNLinesFromBuffer(
  ptyId: string,
  lines: number,
  timeoutMs: number = 3000
): Promise<string[] | null> {
  const mainWindow = getMainWindow()
  if (!mainWindow || mainWindow.isDestroyed()) {
    console.warn('[ScreenContent] mainWindow 不可用')
    return null
  }

  return new Promise((resolve) => {
    const requestId = `${ptyId}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    
    // 设置超时
    const timeout = setTimeout(() => {
      pendingRequests.delete(requestId)
      resolve(null)
    }, timeoutMs)
    
    pendingRequests.set(requestId, { 
      resolve, 
      reject: () => resolve(null), 
      timeout 
    })
    
    // 发送请求到渲染进程
    mainWindow.webContents.send('screen:requestLastNLines', { requestId, ptyId, lines })
  })
}

/**
 * 从 xterm buffer 获取可视区域内容
 * 
 * @param ptyId 终端 ID
 * @param timeoutMs 超时时间（毫秒），默认 3000
 * @returns 行数组，如果失败返回 null
 */
export async function getVisibleContentFromBuffer(
  ptyId: string,
  timeoutMs: number = 3000
): Promise<string[] | null> {
  const mainWindow = getMainWindow()
  if (!mainWindow || mainWindow.isDestroyed()) {
    console.warn('[ScreenContent] mainWindow 不可用')
    return null
  }

  return new Promise((resolve) => {
    const requestId = `${ptyId}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    
    const timeout = setTimeout(() => {
      pendingRequests.delete(requestId)
      resolve(null)
    }, timeoutMs)
    
    pendingRequests.set(requestId, { 
      resolve, 
      reject: () => resolve(null), 
      timeout 
    })
    
    mainWindow.webContents.send('screen:requestVisibleContent', { requestId, ptyId })
  })
}
