/**
 * 终端屏幕内容服务
 * 
 * 提供从渲染进程 xterm buffer 直接读取终端内容的能力。
 * 这比通过 PTY 输出拼接的数据更准确，因为 xterm buffer 是终端内容的唯一真实来源。
 * 
 * 核心理念：xterm.js 是终端状态的唯一真实来源（Single Source of Truth）
 * - 屏幕内容：直接从 xterm buffer 读取
 * - 输入等待检测：由前端 TerminalScreenService 分析
 * - 环境分析：由前端 TerminalScreenService 分析
 */
import { BrowserWindow, ipcMain } from 'electron'

/** 屏幕分析结果（与前端 TerminalAwarenessState 保持一致） */
export interface ScreenAnalysis {
  input: {
    isWaiting: boolean
    type: 'password' | 'confirmation' | 'selection' | 'pager' | 'prompt' | 'editor' | 'custom_input' | 'none'
    prompt?: string
    options?: string[]
    suggestedResponse?: string
    confidence: number
  }
  output: {
    type: 'progress' | 'compilation' | 'test' | 'log_stream' | 'error' | 'table' | 'normal'
    confidence: number
    details?: {
      progress?: number
      testsPassed?: number
      testsFailed?: number
      errorCount?: number
      eta?: string
    }
  }
  context: {
    user?: string
    hostname?: string
    isRoot: boolean
    cwdFromPrompt?: string
    activeEnvs: string[]
    sshDepth: number
    promptType: 'bash' | 'zsh' | 'fish' | 'powershell' | 'cmd' | 'unknown'
  }
  /** 可视区域内容 */
  visibleContent?: string[]
  timestamp: number
}

// 存储待处理的请求（字符串数组类型）
const pendingRequests = new Map<string, {
  resolve: (value: string[] | null) => void
  reject: (reason: Error) => void
  timeout: NodeJS.Timeout
}>()

// 存储待处理的屏幕分析请求
const pendingAnalysisRequests = new Map<string, {
  resolve: (value: ScreenAnalysis | null) => void
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

  // 监听屏幕分析响应
  ipcMain.on('screen:responseScreenAnalysis', (_event, data: { requestId: string; analysis: ScreenAnalysis | null }) => {
    const request = pendingAnalysisRequests.get(data.requestId)
    if (request) {
      clearTimeout(request.timeout)
      pendingAnalysisRequests.delete(data.requestId)
      request.resolve(data.analysis)
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

/**
 * 从前端实时获取完整的屏幕分析结果
 * 
 * 这是获取终端真实状态的首选方式，包括：
 * - 输入等待检测（密码、确认、选择等）
 * - 输出模式识别（进度条、测试结果等）
 * - 环境分析（用户、主机、虚拟环境等）
 * - 可视区域内容
 * 
 * @param ptyId 终端 ID
 * @param timeoutMs 超时时间（毫秒），默认 2000
 * @returns 屏幕分析结果，如果失败返回 null
 */
export async function getScreenAnalysisFromFrontend(
  ptyId: string,
  timeoutMs: number = 2000
): Promise<ScreenAnalysis | null> {
  const mainWindow = getMainWindow()
  if (!mainWindow || mainWindow.isDestroyed()) {
    console.warn('[ScreenContent] mainWindow 不可用，无法获取屏幕分析')
    return null
  }

  return new Promise((resolve) => {
    const requestId = `analysis-${ptyId}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    
    const timeout = setTimeout(() => {
      pendingAnalysisRequests.delete(requestId)
      resolve(null)
    }, timeoutMs)
    
    pendingAnalysisRequests.set(requestId, { 
      resolve, 
      reject: () => resolve(null), 
      timeout 
    })
    
    // 发送请求到渲染进程
    mainWindow.webContents.send('screen:requestScreenAnalysis', { requestId, ptyId })
  })
}

/**
 * 从前端实时获取光标位置
 * 
 * @param ptyId 终端 ID
 * @param timeoutMs 超时时间（毫秒），默认 1000
 * @returns 光标位置 {x, y}，如果失败返回 null
 */
export async function getCursorPositionFromFrontend(
  ptyId: string,
  timeoutMs: number = 1000
): Promise<{ x: number; y: number } | null> {
  // 通过屏幕分析获取，因为屏幕分析中包含了光标位置相关信息
  // 这里可以后续扩展为独立的 IPC 调用以提高效率
  const analysis = await getScreenAnalysisFromFrontend(ptyId, timeoutMs)
  if (!analysis) return null
  
  // 注意：当前屏幕分析不包含光标位置，需要后续扩展
  // 暂时返回 null
  return null
}
