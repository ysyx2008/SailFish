/**
 * AI Debug 服务
 * 收集和广播 AI 请求与响应的实时流水
 */

import { BrowserWindow, ipcMain, app } from 'electron'
import { EventEmitter } from 'events'
import * as fs from 'fs'
import * as path from 'path'

// AI 日志条目类型
export type AiLogType = 
  | 'request_start'    // 请求开始
  | 'request_body'     // 请求体
  | 'response_chunk'   // 响应流式片段
  | 'response_done'    // 响应完成
  | 'response_error'   // 响应错误
  | 'tool_call'        // 工具调用
  | 'tool_result'      // 工具结果

export interface AiLogEntry {
  id: string
  type: AiLogType
  timestamp: number
  requestId: string     // 关联的请求ID
  profileId?: string    // AI Profile ID
  model?: string        // 模型名称
  data: {
    messages?: Array<{
      role: string
      content: string
      tool_call_id?: string
      tool_calls?: unknown[]
    }>
    tools?: unknown[]
    response?: string
    reasoningContent?: string  // 思考内容（DeepSeek-R1 等模型）
    chunk?: string
    error?: string
    toolCall?: {
      id: string
      name: string
      arguments: string
    }
    toolResult?: {
      toolCallId: string
      success: boolean
      result: string
    }
    finishReason?: string
    usage?: {
      prompt_tokens?: number
      completion_tokens?: number
      total_tokens?: number
    }
  }
}

class AiDebugService extends EventEmitter {
  private debugWindow: BrowserWindow | null = null
  private logs: AiLogEntry[] = []
  private maxLogs = 1000  // 最多保留的日志数量
  private enabled = false
  private logIdCounter = 0
  private logFilePath: string | null = null
  private logFileStream: fs.WriteStream | null = null

  constructor() {
    super()
    this.setupIpc()
  }

  /**
   * 获取日志文件目录
   */
  private getLogDir(): string {
    const userDataPath = app.getPath('userData')
    const logDir = path.join(userDataPath, 'ai-debug-logs')
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true })
    }
    return logDir
  }

  /**
   * 创建新的日志文件
   */
  private createLogFile(): void {
    try {
      const logDir = this.getLogDir()
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
      this.logFilePath = path.join(logDir, `ai-debug-${timestamp}.log`)
      this.logFileStream = fs.createWriteStream(this.logFilePath, { flags: 'a' })
      
      // 写入日志文件头
      this.logFileStream.write(`# AI Debug Log\n`)
      this.logFileStream.write(`# Started: ${new Date().toISOString()}\n`)
      this.logFileStream.write(`# ================================\n\n`)
      
      console.log(`[AI Debug] Log file created: ${this.logFilePath}`)
    } catch (error) {
      console.error('[AI Debug] Failed to create log file:', error)
    }
  }

  /**
   * 关闭日志文件
   */
  private closeLogFile(): void {
    if (this.logFileStream) {
      this.logFileStream.write(`\n# ================================\n`)
      this.logFileStream.write(`# Ended: ${new Date().toISOString()}\n`)
      this.logFileStream.end()
      this.logFileStream = null
    }
  }

  /**
   * 写入日志到文件
   */
  private writeToFile(entry: AiLogEntry): void {
    if (!this.logFileStream) return

    try {
      const time = new Date(entry.timestamp).toISOString()
      let line = `[${time}] [${entry.type.toUpperCase()}] `
      
      switch (entry.type) {
        case 'request_start':
          line += `Request ${entry.requestId} started\n`
          line += `  Model: ${entry.model || 'unknown'}\n`
          if (entry.data.messages) {
            line += `  Messages (${entry.data.messages.length}):\n`
            for (const msg of entry.data.messages) {
              const msgContent = msg.content || ''
              const content = msgContent.length > 500 
                ? msgContent.substring(0, 500) + '...[truncated]' 
                : msgContent
              line += `    [${msg.role}]: ${content.replace(/\n/g, '\n    ')}\n`
            }
          }
          if (entry.data.tools && entry.data.tools.length > 0) {
            line += `  Tools: ${entry.data.tools.map((t: any) => t.function?.name || t).join(', ')}\n`
          }
          break
        case 'response_chunk':
          line += `Chunk: ${(entry.data.chunk || '').replace(/\n/g, '\\n')}\n`
          break
        case 'response_done':
          line += `Request ${entry.requestId} completed (${entry.data.finishReason || 'unknown'})\n`
          if (entry.data.response) {
            const resp = entry.data.response.length > 1000 
              ? entry.data.response.substring(0, 1000) + '...[truncated]'
              : entry.data.response
            line += `  Response: ${resp.replace(/\n/g, '\n  ')}\n`
          }
          break
        case 'response_error':
          line += `Request ${entry.requestId} ERROR: ${entry.data.error}\n`
          break
        case 'tool_call':
          line += `Tool Call: ${entry.data.toolCall?.name}(${entry.data.toolCall?.id})\n`
          if (entry.data.toolCall?.arguments) {
            const args = entry.data.toolCall.arguments.length > 500 
              ? entry.data.toolCall.arguments.substring(0, 500) + '...[truncated]'
              : entry.data.toolCall.arguments
            line += `  Arguments: ${args}\n`
          }
          break
        case 'tool_result':
          const success = entry.data.toolResult?.success ? '✓' : '✗'
          line += `Tool Result (${entry.data.toolResult?.toolCallId}): ${success}\n`
          if (entry.data.toolResult?.result) {
            const result = entry.data.toolResult.result.length > 500 
              ? entry.data.toolResult.result.substring(0, 500) + '...[truncated]'
              : entry.data.toolResult.result
            line += `  Result: ${result.replace(/\n/g, '\n  ')}\n`
          }
          break
        default:
          line += JSON.stringify(entry.data) + '\n'
      }
      
      this.logFileStream.write(line + '\n')
    } catch (error) {
      console.error('[AI Debug] Failed to write to log file:', error)
    }
  }

  /**
   * 设置 IPC 通道
   */
  private setupIpc(): void {
    // 先移除可能已存在的 handlers（防止热重载时重复注册）
    const channels = [
      'aiDebug:getLogs',
      'aiDebug:clearLogs', 
      'aiDebug:isWindowOpen',
      'aiDebug:getLogFilePath',
      'aiDebug:getLogDir',
      'aiDebug:exportLogs',
      'aiDebug:copyEntry'
    ]
    channels.forEach(channel => {
      try { ipcMain.removeHandler(channel) } catch { /* ignore */ }
    })

    // 获取所有日志
    ipcMain.handle('aiDebug:getLogs', () => {
      return this.logs
    })

    // 清除日志
    ipcMain.handle('aiDebug:clearLogs', () => {
      this.logs = []
      this.broadcast({ type: 'clear' })
      return true
    })

    // 检查调试窗口是否打开
    ipcMain.handle('aiDebug:isWindowOpen', () => {
      return this.debugWindow !== null && !this.debugWindow.isDestroyed()
    })

    // 获取日志文件路径
    ipcMain.handle('aiDebug:getLogFilePath', () => {
      return this.logFilePath
    })

    // 获取日志目录
    ipcMain.handle('aiDebug:getLogDir', () => {
      return this.getLogDir()
    })

    // 导出日志到指定文件
    ipcMain.handle('aiDebug:exportLogs', async (_event, filePath: string) => {
      try {
        const content = this.logs.map(entry => {
          const time = new Date(entry.timestamp).toISOString()
          return `[${time}] [${entry.type}] ${JSON.stringify(entry.data)}`
        }).join('\n')
        fs.writeFileSync(filePath, content, 'utf-8')
        return { success: true }
      } catch (error) {
        return { success: false, error: String(error) }
      }
    })

    // 复制日志条目
    ipcMain.handle('aiDebug:copyEntry', async (_event, entryId: string) => {
      const entry = this.logs.find(e => e.id === entryId)
      if (entry) {
        return JSON.stringify(entry, null, 2)
      }
      return null
    })
  }

  /**
   * 生成唯一的日志 ID
   */
  private generateLogId(): string {
    return `log_${Date.now()}_${++this.logIdCounter}`
  }

  /**
   * 添加日志条目
   */
  addLog(entry: Omit<AiLogEntry, 'id' | 'timestamp'>): void {
    if (!this.enabled) return

    const fullEntry: AiLogEntry = {
      ...entry,
      id: this.generateLogId(),
      timestamp: Date.now()
    }

    this.logs.push(fullEntry)

    // 限制日志数量
    if (this.logs.length > this.maxLogs) {
      this.logs = this.logs.slice(-this.maxLogs)
    }

    // 写入日志文件
    this.writeToFile(fullEntry)

    // 广播到调试窗口
    this.broadcast({ type: 'log', entry: fullEntry })
  }

  /**
   * 记录请求开始
   */
  logRequestStart(requestId: string, options: {
    profileId?: string
    model?: string
    messages?: AiLogEntry['data']['messages']
    tools?: unknown[]
  }): void {
    this.addLog({
      type: 'request_start',
      requestId,
      profileId: options.profileId,
      model: options.model,
      data: {
        messages: options.messages,
        tools: options.tools
      }
    })
  }

  /**
   * 记录响应流式片段
   */
  logResponseChunk(requestId: string, chunk: string): void {
    this.addLog({
      type: 'response_chunk',
      requestId,
      data: { chunk }
    })
  }

  /**
   * 记录响应完成
   */
  logResponseDone(requestId: string, options: {
    response?: string
    reasoningContent?: string  // 思考内容
    finishReason?: string
    usage?: AiLogEntry['data']['usage']
    toolCalls?: Array<{  // 工具调用列表
      id: string
      name: string
      arguments: string
    }>
  }): void {
    this.addLog({
      type: 'response_done',
      requestId,
      data: options
    })
  }

  /**
   * 记录响应错误
   */
  logResponseError(requestId: string, error: string): void {
    this.addLog({
      type: 'response_error',
      requestId,
      data: { error }
    })
  }

  /**
   * 记录工具调用
   */
  logToolCall(requestId: string, toolCall: {
    id: string
    name: string
    arguments: string
  }): void {
    this.addLog({
      type: 'tool_call',
      requestId,
      data: { toolCall }
    })
  }

  /**
   * 记录工具结果
   */
  logToolResult(requestId: string, result: {
    toolCallId: string
    success: boolean
    result: string
  }): void {
    this.addLog({
      type: 'tool_result',
      requestId,
      data: { toolResult: result }
    })
  }

  /**
   * 广播消息到调试窗口
   */
  private broadcast(message: { type: string; entry?: AiLogEntry }): void {
    if (this.debugWindow && !this.debugWindow.isDestroyed()) {
      this.debugWindow.webContents.send('aiDebug:message', message)
    }
  }

  /**
   * 设置调试窗口
   */
  setDebugWindow(window: BrowserWindow | null): void {
    // 如果之前有窗口，先关闭日志文件
    if (this.debugWindow && !window) {
      this.closeLogFile()
    }
    
    this.debugWindow = window
    this.enabled = window !== null && !window.isDestroyed()
    
    if (this.debugWindow) {
      // 创建新的日志文件
      this.createLogFile()
      
      this.debugWindow.on('closed', () => {
        this.closeLogFile()
        this.debugWindow = null
        this.enabled = false
      })
    }
  }

  /**
   * 是否启用
   */
  isEnabled(): boolean {
    return this.enabled
  }

  /**
   * 获取调试窗口
   */
  getDebugWindow(): BrowserWindow | null {
    return this.debugWindow
  }

  /**
   * 清除日志
   */
  clearLogs(): void {
    this.logs = []
  }
}

// 单例导出
export const aiDebugService = new AiDebugService()
