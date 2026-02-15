/**
 * Gateway Service - 远程 Agent 交互服务
 * 
 * 提供一个轻量级 HTTP 服务器，允许通过浏览器远程与 Agent 交互。
 * 
 * 架构：
 * - Express HTTP 服务器 + API Token 鉴权
 * - SSE (Server-Sent Events) 用于流式输出
 * - 内嵌 HTML 聊天页面（自包含，无外部依赖）
 * - 服务端持久化 PTY 终端
 * 
 * API 端点：
 * - GET  /chat               → 聊天页面
 * - POST /api/chat           → 发送消息（SSE 流式响应）
 * - GET  /api/chat/events    → 实时事件 SSE 流（旁听所有通道的 Agent 事件）
 * - GET  /api/chat/history   → 获取历史
 * - POST /api/chat/supplement → 任务执行中补充信息
 * - POST /api/chat/abort     → 中止执行
 * - POST /api/chat/confirm   → 确认工具调用
 * - GET  /api/chat/status    → 获取状态
 * - POST /api/chat/clear     → 清空历史
 * - GET  /api/health         → 健康检查
 */

import * as http from 'http'
import * as crypto from 'crypto'
import { RemoteChatService, VISIBLE_STEP_TYPES } from './remote-chat.service'

// 类型定义 ---------------------------------------------------------------

export interface GatewayConfig {
  enabled: boolean
  port: number
  apiToken: string
  host: string  // 监听地址，默认 '0.0.0.0'
}

export interface GatewayDependencies {
  remoteChatService: RemoteChatService
  mainWindow: {
    webContents: {
      send: (channel: string, ...args: any[]) => void
      isDestroyed: () => boolean
    }
  } | null
}

// 审计日志
interface AuditLogEntry {
  id: string
  timestamp: number
  type: 'connection' | 'task_start' | 'tool_call' | 'task_complete' | 'task_error' | 'confirm' | 'supplement'
  clientIp?: string
  summary: string
  details?: Record<string, unknown>
}

// GatewayService 实现 ----------------------------------------------------

export class GatewayService {
  private server: http.Server | null = null
  private deps: GatewayDependencies | null = null
  private config: GatewayConfig = {
    enabled: false,
    port: 3721,
    apiToken: '',
    host: '0.0.0.0'
  }
  private auditLog: AuditLogEntry[] = []
  private static readonly MAX_AUDIT_LOG = 500  // 最多保留 500 条记录

  /** 便捷访问共享会话服务 */
  private get chat(): RemoteChatService {
    return this.deps!.remoteChatService
  }

  /**
   * 注入依赖（在 main.ts 中调用）
   */
  setDependencies(deps: GatewayDependencies) {
    this.deps = deps
  }

  /**
   * 更新 mainWindow 引用（窗口创建/重建后调用）
   */
  setMainWindow(win: GatewayDependencies['mainWindow']) {
    if (this.deps) {
      this.deps.mainWindow = win
    }
  }

  /**
   * 启动 Gateway 服务
   */
  async start(config: GatewayConfig): Promise<{ success: boolean; error?: string }> {
    if (this.server) {
      return { success: false, error: 'Gateway already running' }
    }
    if (!this.deps) {
      return { success: false, error: 'Dependencies not set' }
    }

    this.config = { ...config }

    // 生成 Token（如果没有）
    if (!this.config.apiToken) {
      this.config.apiToken = crypto.randomBytes(32).toString('hex')
    }

    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res))

      this.server.on('error', (err: any) => {
        if (err.code === 'EADDRINUSE') {
          resolve({ success: false, error: `Port ${this.config.port} is already in use` })
        } else {
          resolve({ success: false, error: err.message })
        }
        this.server = null
      })

      this.server.listen(this.config.port, this.config.host, () => {
        console.log(`[Gateway] Server started on ${this.config.host}:${this.config.port}`)
        console.log(`[Gateway] Chat page: http://localhost:${this.config.port}/chat`)
        console.log(`[Gateway] API Token: ${this.config.apiToken}`)
        resolve({ success: true })
      })
    })
  }

  /**
   * 停止 Gateway 服务
   * 注意：不销毁 PTY，因为 PTY 由 RemoteChatService 统一管理，IM 等通道可能仍在使用
   */
  async stop(): Promise<void> {
    if (this.server) {
      return new Promise((resolve) => {
        this.server!.close(() => {
          console.log('[Gateway] Server stopped')
          this.server = null
          resolve()
        })
      })
    }
  }

  /**
   * 获取当前配置（含生成的 Token）
   */
  getConfig(): GatewayConfig {
    return { ...this.config }
  }

  /**
   * 是否正在运行
   */
  isRunning(): boolean {
    return this.server !== null && this.server.listening
  }

  // ==================== HTTP 请求处理 ====================

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    const path = url.pathname

    // 公开端点（无需鉴权）
    if (path === '/api/health') {
      return this.handleHealth(req, res)
    }
    if (path === '/chat') {
      return this.serveChatPage(req, res)
    }
    if (path === '/api/auth/validate') {
      return this.handleAuthValidate(req, res)
    }

    // 鉴权
    if (!this.authenticate(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Unauthorized' }))
      return
    }

    // API 路由
    switch (path) {
      case '/api/chat':
        return req.method === 'POST' ? this.handleChatMessage(req, res) : this.methodNotAllowed(res)
      case '/api/chat/history':
        return req.method === 'GET' ? this.handleChatHistory(req, res) : this.methodNotAllowed(res)
      case '/api/chat/supplement':
        return req.method === 'POST' ? this.handleChatSupplement(req, res) : this.methodNotAllowed(res)
      case '/api/chat/abort':
        return req.method === 'POST' ? this.handleChatAbort(req, res) : this.methodNotAllowed(res)
      case '/api/chat/confirm':
        return req.method === 'POST' ? this.handleChatConfirm(req, res) : this.methodNotAllowed(res)
      case '/api/chat/status':
        return req.method === 'GET' ? this.handleChatStatus(req, res) : this.methodNotAllowed(res)
      case '/api/chat/clear':
        return req.method === 'POST' ? this.handleChatClear(req, res) : this.methodNotAllowed(res)
      case '/api/chat/events':
        return req.method === 'GET' ? this.handleChatEvents(req, res) : this.methodNotAllowed(res)
      default:
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Not Found' }))
    }
  }

  // ==================== 鉴权 ====================

  private authenticate(req: http.IncomingMessage): boolean {
    const auth = req.headers.authorization
    if (!auth) return false
    const token = auth.replace(/^Bearer\s+/i, '')
    return token === this.config.apiToken
  }

  private handleAuthValidate(req: http.IncomingMessage, res: http.ServerResponse) {
    const valid = this.authenticate(req)
    const clientIp = (req.headers['x-forwarded-for'] as string || req.socket.remoteAddress || '').split(',')[0].trim()
    if (valid) {
      this.addAuditLog({
        type: 'connection',
        clientIp,
        summary: `客户端认证成功: ${clientIp}`
      })
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ valid }))
  }

  private handleHealth(_req: http.IncomingMessage, res: http.ServerResponse) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', version: '1.0.0' }))
  }

  // ==================== Chat API ====================

  /**
   * POST /api/chat - 发送消息并获取流式响应
   */
  private async handleChatMessage(req: http.IncomingMessage, res: http.ServerResponse) {
    const body = await this.readBody(req)
    if (!body) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Invalid JSON body' }))
      return
    }

    const { message, executionMode } = body as { message?: string; executionMode?: string }
    if (!message || typeof message !== 'string' || !message.trim()) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Message is required' }))
      return
    }

    if (this.chat.isRunning) {
      res.writeHead(409, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Agent is already running' }))
      return
    }

    // 更新执行模式
    if (executionMode && ['strict', 'relaxed', 'free'].includes(executionMode)) {
      this.chat.executionMode = executionMode as 'strict' | 'relaxed' | 'free'
    }

    // SSE 响应
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    })

    const sendEvent = (type: string, data: any) => {
      try {
        res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`)
      } catch { /* connection closed */ }
    }

    const clientIp = (req.headers['x-forwarded-for'] as string || req.socket.remoteAddress || '').split(',')[0].trim()

    // 先确保 PTY 存在，这样下面通知桌面端时 ptyId 不会是 null
    await this.chat.ensurePty()

    // 审计日志：任务开始
    this.addAuditLog({
      type: 'task_start',
      clientIp,
      summary: `远程任务开始: ${message.trim().substring(0, 80)}`,
      details: { message: message.trim(), executionMode: this.chat.executionMode }
    })

    // 通知桌面端：远程 Web 任务开始（PTY 已创建，ptyId 有效）
    this.sendToDesktop('gateway:remoteTaskStarted', {
      ptyId: this.chat.getPtyId(),
      message: message.trim()
    })

    // ---- SSE 专用的流式渲染状态 ----
    const sentStepIds = new Set<string>()
    let currentMessageStepId: string | null = null
    let pendingTextContent: string | null = null
    let pendingTextTimer: ReturnType<typeof setTimeout> | null = null
    const TEXT_THROTTLE_MS = 150

    const flushPendingText = () => {
      if (pendingTextContent !== null && currentMessageStepId) {
        sendEvent('text_replace', { content: pendingTextContent, stepId: currentMessageStepId })
        pendingTextContent = null
      }
      pendingTextTimer = null
    }

    try {
      await this.chat.sendMessage(message.trim(), {
        onStep: (_agentId: string, step: any) => {
          // ---- SSE 流式输出逻辑（仅处理远程 Chat 页面渲染） ----
          if (step.type === 'thinking') {
            if (!sentStepIds.has(step.id)) {
              sentStepIds.add(step.id)
              sendEvent('thinking', { content: step.content })
            }
          } else if (step.type === 'message' && step.content) {
            if (currentMessageStepId === step.id) {
              pendingTextContent = step.content
              if (!pendingTextTimer) {
                pendingTextTimer = setTimeout(flushPendingText, TEXT_THROTTLE_MS)
              }
            } else {
              if (pendingTextTimer) { clearTimeout(pendingTextTimer); flushPendingText() }
              currentMessageStepId = step.id
              pendingTextContent = null
              sendEvent('text_new', { content: step.content, stepId: step.id })
            }
            sentStepIds.add(step.id)
            if (!step.isStreaming && pendingTextTimer) {
              clearTimeout(pendingTextTimer)
              pendingTextContent = step.content
              flushPendingText()
            }
          } else if (VISIBLE_STEP_TYPES.has(step.type)) {
            if (!sentStepIds.has(step.id)) {
              sentStepIds.add(step.id)
              sendEvent('step', { step: JSON.parse(JSON.stringify(step)) })
            } else {
              sendEvent('step_update', { step: JSON.parse(JSON.stringify(step)) })
            }
            if (step.type === 'tool_call') {
              if (pendingTextTimer) { clearTimeout(pendingTextTimer); flushPendingText() }
              currentMessageStepId = null
            }
          }

          // 审计日志：工具调用
          if (step.type === 'tool_call') {
            this.addAuditLog({
              type: 'tool_call',
              clientIp,
              summary: `工具调用: ${step.toolName || 'unknown'}`,
              details: { toolName: step.toolName, args: step.args }
            })
          }
        },

        onNeedConfirm: (confirmation: any) => {
          sendEvent('need_confirm', { confirmation: this.chat.pendingConfirm })
          this.addAuditLog({
            type: 'confirm',
            clientIp,
            summary: `需要确认: ${confirmation.toolName} (${confirmation.riskLevel})`,
            details: { toolName: confirmation.toolName, riskLevel: confirmation.riskLevel, toolArgs: confirmation.toolArgs }
          })
        },

        onComplete: (_agentId: string, result: string) => {
          if (pendingTextTimer) { clearTimeout(pendingTextTimer); flushPendingText() }
          sendEvent('complete', { content: result })
          res.end()
          this.addAuditLog({
            type: 'task_complete',
            clientIp,
            summary: `远程任务完成: ${result.substring(0, 80)}`,
            details: {}
          })
        },

        onError: (_agentId: string, error: string) => {
          if (pendingTextTimer) { clearTimeout(pendingTextTimer); flushPendingText() }
          sendEvent('error', { error })
          res.end()
          this.addAuditLog({
            type: 'task_error',
            clientIp,
            summary: `远程任务出错: ${error.substring(0, 80)}`,
            details: { error }
          })
        }
      })
    } catch (err: any) {
      // sendMessage 抛异常（如依赖未注入、PTY 创建失败）
      sendEvent('error', { error: err.message || 'Unknown error' })
      res.end()
    }
  }

  /**
   * GET /api/chat/history
   */
  private handleChatHistory(_req: http.IncomingMessage, res: http.ServerResponse) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      history: this.chat.getHistory(),
      isRunning: this.chat.isRunning,
      executionMode: this.chat.executionMode
    }))
  }

  /**
   * POST /api/chat/supplement - 任务执行中发送补充信息
   */
  private async handleChatSupplement(req: http.IncomingMessage, res: http.ServerResponse) {
    const body = await this.readBody(req)
    if (!body) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Invalid request body' }))
      return
    }

    const { message } = body as any
    if (!message || typeof message !== 'string') {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Message is required' }))
      return
    }

    if (!this.chat.isRunning) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'No running task' }))
      return
    }

    const result = this.chat.supplement(message.trim())

    // 审计日志
    this.addAuditLog({
      type: 'supplement',
      clientIp: (req.headers['x-forwarded-for'] as string || req.socket.remoteAddress || '').split(',')[0].trim(),
      summary: `补充信息: ${message.trim().substring(0, 80)}`,
      details: { message: message.trim() }
    })

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ success: result }))
  }

  /**
   * POST /api/chat/abort
   */
  private async handleChatAbort(_req: http.IncomingMessage, res: http.ServerResponse) {
    if (!this.chat.isRunning) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'No running task' }))
      return
    }
    const result = this.chat.abort()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ success: result }))
  }

  /**
   * POST /api/chat/confirm
   */
  private async handleChatConfirm(req: http.IncomingMessage, res: http.ServerResponse) {
    const body = await this.readBody(req)
    if (!body) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Invalid JSON body' }))
      return
    }

    const { toolCallId, approved, modifiedArgs, alwaysAllow } = body as any
    if (!this.chat.pendingConfirm) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'No pending confirmation' }))
      return
    }

    const result = this.chat.confirmToolCall(
      toolCallId,
      approved !== false,
      modifiedArgs,
      alwaysAllow
    )
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ success: result }))
  }

  /**
   * GET /api/chat/status
   */
  private handleChatStatus(_req: http.IncomingMessage, res: http.ServerResponse) {
    const agentStatus = this.chat.getAgentStatus()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      isRunning: this.chat.isRunning,
      pendingConfirm: this.chat.pendingConfirm,
      executionMode: this.chat.executionMode,
      agentStatus
    }))
  }

  /**
   * POST /api/chat/clear
   */
  private handleChatClear(_req: http.IncomingMessage, res: http.ServerResponse) {
    this.chat.clearHistory()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ success: true }))
  }

  /**
   * GET /api/chat/events - 实时事件 SSE 流
   *
   * 客户端连接后会收到所有通道（Web / IM）触发的 Agent 事件。
   * 事件格式与 POST /api/chat 的 SSE 响应完全一致，
   * 客户端可复用同一套 handleSSEEvent 逻辑渲染。
   */
  private handleChatEvents(_req: http.IncomingMessage, res: http.ServerResponse) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    })

    // 发送当前状态，便于断线重连后同步
    const state = this.chat.getState()
    res.write(`data: ${JSON.stringify({ type: 'init', isRunning: state.isRunning, historyCount: state.history.length })}\n\n`)

    // 订阅 RemoteChatService 的实时事件
    const unsubscribe = this.chat.subscribe((event: any) => {
      try {
        res.write(`data: ${JSON.stringify(event)}\n\n`)
      } catch { /* connection closed */ }
    })

    // 心跳保活（每 30 秒）
    const heartbeat = setInterval(() => {
      try { res.write(': heartbeat\n\n') } catch { /* ignore */ }
    }, 30_000)

    const cleanup = () => {
      clearInterval(heartbeat)
      unsubscribe()
    }
    _req.on('close', cleanup)
    res.on('close', cleanup)
  }

  /**
   * 安全地推送事件到桌面端 mainWindow
   */
  private sendToDesktop(channel: string, ...args: any[]) {
    try {
      const mw = this.deps?.mainWindow
      if (mw && !mw.webContents.isDestroyed()) {
        mw.webContents.send(channel, ...args)
      }
    } catch { /* window destroyed */ }
  }

  /**
   * 记录审计日志
   */
  private addAuditLog(entry: Omit<AuditLogEntry, 'id' | 'timestamp'>) {
    const logEntry: AuditLogEntry = {
      id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      ...entry
    }
    this.auditLog.push(logEntry)
    // 限制日志数量
    if (this.auditLog.length > GatewayService.MAX_AUDIT_LOG) {
      this.auditLog = this.auditLog.slice(-GatewayService.MAX_AUDIT_LOG)
    }
    // 推送到桌面端
    this.sendToDesktop('gateway:auditLog', logEntry)
  }

  /**
   * 获取审计日志（IPC 接口）
   */
  getAuditLog(limit = 100): AuditLogEntry[] {
    return this.auditLog.slice(-limit)
  }

  // ==================== 工具方法 ====================

  private methodNotAllowed(res: http.ServerResponse) {
    res.writeHead(405, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Method Not Allowed' }))
  }

  private readBody(req: http.IncomingMessage): Promise<any | null> {
    return new Promise((resolve) => {
      let body = ''
      req.on('data', (chunk: Buffer) => { body += chunk.toString() })
      req.on('end', () => {
        try {
          resolve(body ? JSON.parse(body) : null)
        } catch {
          resolve(null)
        }
      })
      req.on('error', () => resolve(null))
    })
  }

  // ==================== Chat Page HTML ====================

  private serveChatPage(_req: http.IncomingMessage, res: http.ServerResponse) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(this.getChatPageHtml())
  }

  private getChatPageHtml(): string {
    // 从 configService 读取语言设置
    const lang = this.chat.getConfigValue('language') || 'zh-CN'
    const isZh = lang.startsWith('zh')

    // 双语文本
    const i18n = isZh ? {
      title: '旗鱼终端 - 远程助手',
      brand: '旗鱼终端',
      authTitle: '旗鱼终端',
      authSubtitle: '远程 Agent 访问',
      tokenPlaceholder: '请输入 API Token',
      connect: '连接',
      tokenEmpty: '请输入 API Token',
      tokenInvalid: 'Token 无效',
      connFailed: '连接失败: ',
      modeStrict: '严格',
      modeNormal: '宽松',
      modeYolo: '自由',
      modeTitle: '执行模式',
      clear: '清空',
      abort: '中止',
      emptyHint: '输入消息开始与 AI 助手交互。<br>助手可以在远程机器上执行命令、编辑文件等操作。',
      confirmLabel: '需要确认: ',
      reject: '拒绝',
      approve: '允许',
      inputPlaceholder: '让助手帮你做点什么...',
      send: '发送',
      thinking: '💭 思考中',
      clearRunning: '助手正在运行中，无法清空',
      stepTool: '工具',
      stepArgs: '参数',
      stepResult: '结果',
      stepContent: '内容',
      noDetails: '无详情',
      executeCommand: '执行命令',
      writeFile: '写入文件',
      readFile: '读取文件',
      search: '搜索',
      searchCode: '搜索代码',
      think: '思考',
      plan: '计划',
      thinkingTitle: '思考中...',
      message: '消息',
      error: '错误',
      planCreated: '计划已创建',
      planUpdated: '计划已更新',
      supplementPlaceholder: '输入补充信息（将在下一步生效）...',
      supplement: '补充',
      supplementSent: '💡 补充信息（等待处理）',
      askUser: '等待回复',
      waiting: '等待中'
    } : {
      title: 'SFTerm - Remote Agent',
      brand: 'SFTerm',
      authTitle: 'SFTerm',
      authSubtitle: 'Remote Agent Access',
      tokenPlaceholder: 'Enter API Token',
      connect: 'Connect',
      tokenEmpty: 'Please enter API Token',
      tokenInvalid: 'Invalid Token',
      connFailed: 'Connection failed: ',
      modeStrict: 'Strict',
      modeNormal: 'Relaxed',
      modeYolo: 'YOLO',
      modeTitle: 'Execution Mode',
      clear: 'Clear',
      abort: 'Abort',
      emptyHint: 'Enter a message to start interacting with the AI Agent.<br>The agent can execute commands, edit files, and more on the remote machine.',
      confirmLabel: 'Requires confirmation: ',
      reject: 'Reject',
      approve: 'Approve',
      inputPlaceholder: 'Ask the agent to do something...',
      send: 'Send',
      thinking: '💭 Thinking',
      clearRunning: 'Cannot clear while agent is running',
      stepTool: 'Tool',
      stepArgs: 'Arguments',
      stepResult: 'Result',
      stepContent: 'Content',
      noDetails: 'No details',
      executeCommand: 'Execute Command',
      writeFile: 'Write File',
      readFile: 'Read File',
      search: 'Search',
      searchCode: 'Search Code',
      think: 'Think',
      plan: 'Plan',
      thinkingTitle: 'Thinking...',
      message: 'Message',
      error: 'Error',
      planCreated: 'Plan Created',
      planUpdated: 'Plan Updated',
      supplementPlaceholder: 'Add info for the agent (takes effect next step)...',
      supplement: 'Add',
      supplementSent: '💡 Supplement (pending)',
      askUser: 'Waiting for reply',
      waiting: 'Waiting'
    }

    // 序列化 i18n 对象注入到 JS 中
    const i18nJson = JSON.stringify(i18n)

    return `<!DOCTYPE html>
<html lang="${isZh ? 'zh-CN' : 'en'}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${i18n.title}</title>
<style>
  :root {
    --bg: #0d1117; --bg2: #161b22; --bg3: #21262d;
    --border: #30363d; --text: #e6edf3; --text2: #8b949e;
    --accent: #58a6ff; --accent2: #1f6feb;
    --green: #3fb950; --red: #f85149; --yellow: #d29922;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    background: var(--bg); color: var(--text); height: 100vh; display: flex; flex-direction: column; }

  /* Auth overlay */
  #auth-overlay { position: fixed; inset: 0; background: var(--bg); z-index: 100;
    display: flex; align-items: center; justify-content: center; }
  .auth-box { background: var(--bg2); border: 1px solid var(--border); border-radius: 12px;
    padding: 32px; width: 380px; text-align: center; }
  .auth-box h2 { margin-bottom: 8px; font-size: 20px; }
  .auth-box p { color: var(--text2); font-size: 14px; margin-bottom: 20px; }
  .auth-box input { width: 100%; padding: 10px 12px; background: var(--bg3); border: 1px solid var(--border);
    border-radius: 6px; color: var(--text); font-size: 14px; outline: none; margin-bottom: 12px; }
  .auth-box input:focus { border-color: var(--accent); }
  .auth-box button { width: 100%; padding: 10px; background: var(--accent2); color: #fff;
    border: none; border-radius: 6px; font-size: 14px; cursor: pointer; font-weight: 500; }
  .auth-box button:hover { background: var(--accent); }
  .auth-error { color: var(--red); font-size: 13px; margin-top: 8px; }

  /* Header */
  .header { padding: 12px 16px; background: var(--bg2); border-bottom: 1px solid var(--border);
    display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; }
  .header h1 { font-size: 16px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
  .header-actions { display: flex; gap: 8px; align-items: center; }
  .mode-select { background: var(--bg3); border: 1px solid var(--border); color: var(--text);
    padding: 4px 8px; border-radius: 6px; font-size: 12px; outline: none; }
  .btn-sm { padding: 5px 10px; background: var(--bg3); border: 1px solid var(--border);
    color: var(--text2); border-radius: 6px; font-size: 12px; cursor: pointer; }
  .btn-sm:hover { background: var(--border); color: var(--text); }
  .btn-danger { border-color: var(--red); color: var(--red); }
  .btn-danger:hover { background: rgba(248,81,73,0.15); }

  /* Messages area */
  .messages { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 16px; }
  .msg { max-width: 85%; padding: 12px 16px; border-radius: 12px; line-height: 1.6; font-size: 14px;
    word-break: break-word; white-space: pre-wrap; }
  .msg-user { align-self: flex-end; background: var(--accent2); border-bottom-right-radius: 4px; }
  .msg-assistant { align-self: flex-start; background: var(--bg2); border: 1px solid var(--border);
    border-bottom-left-radius: 4px; max-width: 92%; width: fit-content; }
  .msg-assistant .msg-content { min-height: 20px; }

  /* Steps */
  .step-card { margin: 8px 0; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
  .step-header { display: flex; align-items: center; gap: 8px; padding: 8px 12px;
    background: var(--bg3); cursor: pointer; font-size: 13px; user-select: none; }
  .step-header:hover { background: var(--border); }
  .step-icon { width: 18px; text-align: center; flex-shrink: 0; }
  .step-title { flex: 1; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .step-arrow { color: var(--text2); font-size: 11px; transition: transform 0.2s; }
  .step-arrow.expanded { transform: rotate(90deg); }
  .step-body { padding: 10px 12px; font-size: 13px; color: var(--text2); display: none;
    background: var(--bg); border-top: 1px solid var(--border); overflow-x: auto; }
  .step-body.show { display: block; }
  .step-body pre { white-space: pre-wrap; word-break: break-all; font-family: 'SF Mono', Monaco, Consolas, monospace; font-size: 12px; }
  .step-body .step-label { color: var(--text2); font-size: 11px; text-transform: uppercase; margin-bottom: 4px; font-weight: 600; }

  /* Text block (intermediate message between tool calls) */
  .msg-text-block { padding: 8px 0; font-size: 14px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
  .msg-text-block code { background: var(--bg3); padding: 2px 6px; border-radius: 4px; font-size: 13px;
    font-family: 'SF Mono', Monaco, Consolas, monospace; }
  .msg-text-block pre code { display: block; padding: 10px; border-radius: 6px; overflow-x: auto; }

  /* Thinking indicator */
  .thinking { display: flex; align-items: center; gap: 8px; color: var(--text2); font-size: 13px;
    padding: 8px 0; font-style: italic; }
  .thinking-dots span { display: inline-block; animation: blink 1.4s infinite both; }
  .thinking-dots span:nth-child(2) { animation-delay: 0.2s; }
  .thinking-dots span:nth-child(3) { animation-delay: 0.4s; }
  @keyframes blink { 0%, 80%, 100% { opacity: 0; } 40% { opacity: 1; } }

  /* Confirm bar */
  .confirm-bar { padding: 12px 16px; background: rgba(210,153,34,0.12); border-top: 1px solid var(--yellow);
    display: flex; align-items: center; gap: 12px; flex-shrink: 0; }
  .confirm-bar .confirm-info { flex: 1; font-size: 13px; }
  .confirm-bar .confirm-tool { font-weight: 600; color: var(--yellow); }
  .confirm-bar .confirm-args { color: var(--text2); font-size: 12px; margin-top: 2px;
    max-height: 60px; overflow: auto; font-family: monospace; }
  .btn-approve { padding: 6px 16px; background: var(--green); color: #fff; border: none;
    border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 500; }
  .btn-reject { padding: 6px 16px; background: var(--red); color: #fff; border: none;
    border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 500; }

  /* Input area */
  .input-area { padding: 12px 16px; background: var(--bg2); border-top: 1px solid var(--border);
    display: flex; gap: 8px; flex-shrink: 0; }
  .input-area textarea { flex: 1; padding: 10px 12px; background: var(--bg3); border: 1px solid var(--border);
    border-radius: 8px; color: var(--text); font-size: 14px; resize: none; outline: none;
    font-family: inherit; min-height: 42px; max-height: 120px; line-height: 1.5; }
  .input-area textarea:focus { border-color: var(--accent); }
  .input-area button { padding: 10px 20px; background: var(--accent2); color: #fff; border: none;
    border-radius: 8px; font-size: 14px; cursor: pointer; font-weight: 500; flex-shrink: 0;
    align-self: flex-end; }
  .input-area button:hover { background: var(--accent); }
  .input-area button:disabled { opacity: 0.5; cursor: not-allowed; }
  .input-area button.supplement-mode { background: #d97706; }
  .input-area button.supplement-mode:hover { background: #b45309; }

  /* Supplement bubble */
  .supplement-bubble { display: flex; flex-direction: column; gap: 4px; padding: 8px 12px;
    margin: 6px 0; background: rgba(217, 119, 6, 0.1); border: 1px dashed rgba(217, 119, 6, 0.4);
    border-radius: 8px; align-self: flex-end; max-width: 80%; }
  .supplement-label { font-size: 11px; color: #d97706; font-weight: 500; }
  .supplement-text { font-size: 13px; color: var(--text); line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
  .supplement-bubble.processed { border-style: solid; opacity: 0.7; }
  .supplement-bubble.processed .supplement-label { color: #a3a3a3; }

  /* Ask user */
  .ask-question { font-size: 14px; color: var(--text); line-height: 1.6; white-space: pre-wrap; padding: 8px 0; }
  .ask-options { display: flex; flex-wrap: wrap; gap: 8px; padding: 8px 0; }
  .ask-option { padding: 6px 14px; border-radius: 6px; border: 1px solid var(--accent);
    background: transparent; color: var(--accent); font-size: 13px; cursor: pointer; transition: all 0.15s; }
  .ask-option:hover { background: var(--accent); color: #fff; }
  .ask-status { font-size: 12px; color: #d97706; padding: 4px 0; }

  /* Scrollbar */
  ::-webkit-scrollbar { width: 6px; height: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
  ::-webkit-scrollbar-thumb:hover { background: var(--text2); }

  /* Final content */
  .msg-final code { background: var(--bg3); padding: 2px 6px; border-radius: 4px; font-size: 13px;
    font-family: 'SF Mono', Monaco, Consolas, monospace; }
  .msg-final pre code { display: block; padding: 10px; border-radius: 6px; overflow-x: auto; }
  .msg-steps:not(:empty) + .msg-content .msg-final { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--border); }

  /* Status dot */
  .status-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
  .status-dot.online { background: var(--green); }
  .status-dot.busy { background: var(--yellow); animation: pulse 1.5s infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

  /* Empty state */
  .empty-state { flex: 1; display: flex; align-items: center; justify-content: center;
    color: var(--text2); font-size: 14px; text-align: center; }
  .empty-state .logo { font-size: 48px; margin-bottom: 12px; }
  .empty-state p { max-width: 400px; line-height: 1.6; }
</style>
</head>
<body>

<div id="auth-overlay">
  <div class="auth-box">
    <h2>${i18n.authTitle}</h2>
    <p>${i18n.authSubtitle}</p>
    <input id="token-input" type="password" placeholder="${i18n.tokenPlaceholder}" autocomplete="off" />
    <button onclick="doLogin()">${i18n.connect}</button>
    <div id="auth-error" class="auth-error"></div>
  </div>
</div>

<div class="header">
  <h1>
    <span class="status-dot" id="status-dot"></span>
    ${i18n.brand}
  </h1>
  <div class="header-actions">
    <select class="mode-select" id="mode-select" title="${i18n.modeTitle}">
      <option value="strict">${i18n.modeStrict}</option>
      <option value="relaxed" selected>${i18n.modeNormal}</option>
      <option value="free">${i18n.modeYolo}</option>
    </select>
    <button class="btn-sm" onclick="clearChat()">${i18n.clear}</button>
    <button class="btn-sm btn-danger" id="abort-btn" style="display:none" onclick="abortTask()">${i18n.abort}</button>
  </div>
</div>

<div class="messages" id="messages">
  <div class="empty-state" id="empty-state">
    <div>
      <div class="logo">🐟</div>
      <p>${i18n.emptyHint}</p>
    </div>
  </div>
</div>

<div class="confirm-bar" id="confirm-bar" style="display:none">
  <div class="confirm-info">
    <div>${i18n.confirmLabel}<span class="confirm-tool" id="confirm-tool"></span></div>
    <div class="confirm-args" id="confirm-args"></div>
  </div>
  <button class="btn-reject" onclick="confirmAction(false)">${i18n.reject}</button>
  <button class="btn-approve" onclick="confirmAction(true)">${i18n.approve}</button>
</div>

<div class="input-area">
  <textarea id="msg-input" placeholder="${i18n.inputPlaceholder}" rows="1"
    onkeydown="handleKey(event)" oninput="autoResize(this)"></textarea>
  <button id="send-btn" onclick="sendMessage()">${i18n.send}</button>
</div>

<script>
const T = ${i18nJson};
const API_BASE = location.origin;
let TOKEN = localStorage.getItem('sfterm_token') || '';
let isRunning = false;
let currentAssistantEl = null;
let ownTaskActive = false; // 自己发起的任务正在进行时跳过 SSE 事件
let evtController = null;  // AbortController for /api/chat/events

function headers() {
  return { 'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json' };
}

// ==================== Auth ====================

async function doLogin() {
  const input = document.getElementById('token-input');
  const err = document.getElementById('auth-error');
  const t = input.value.trim();
  if (!t) { err.textContent = T.tokenEmpty; return; }

  try {
    const r = await fetch(API_BASE + '/api/auth/validate', { headers: { 'Authorization': 'Bearer ' + t } });
    const d = await r.json();
    if (d.valid) {
      TOKEN = t;
      localStorage.setItem('sfterm_token', t);
      document.getElementById('auth-overlay').style.display = 'none';
      loadHistory();
    } else {
      err.textContent = T.tokenInvalid;
    }
  } catch (e) {
    err.textContent = T.connFailed + e.message;
  }
}

async function init() {
  if (!TOKEN) return;
  try {
    const r = await fetch(API_BASE + '/api/auth/validate', { headers: { 'Authorization': 'Bearer ' + TOKEN } });
    const d = await r.json();
    if (d.valid) {
      document.getElementById('auth-overlay').style.display = 'none';
      loadHistory();
    } else {
      localStorage.removeItem('sfterm_token');
      TOKEN = '';
    }
  } catch {
    localStorage.removeItem('sfterm_token');
    TOKEN = '';
  }
}

// ==================== History ====================

async function loadHistory(isRefresh) {
  try {
    const r = await fetch(API_BASE + '/api/chat/history', { headers: headers() });
    if (r.status === 401) {
      localStorage.removeItem('sfterm_token');
      TOKEN = '';
      document.getElementById('auth-overlay').style.display = 'flex';
      return;
    }
    const d = await r.json();
    if (d.executionMode) {
      document.getElementById('mode-select').value = d.executionMode;
    }
    if (d.history && d.history.length > 0) {
      if (isRefresh) {
        // 外部触发刷新：清除旧内容重新渲染
        var msgsEl = document.getElementById('messages');
        msgsEl.innerHTML = '';
        currentAssistantEl = null;
      }
      const emptyEl = document.getElementById('empty-state');
      if (emptyEl) emptyEl.style.display = 'none';
      d.history.forEach(function(msg) {
        if (msg.role === 'user') {
          addUserBubble(msg.content);
        } else {
          addAssistantBubble(msg.content, msg.steps);
        }
      });
      scrollToBottom();
    }
    updateStatus(d.isRunning);
  } catch (e) {
    console.error('Load history failed:', e);
  }
}

// ==================== Supplement ====================

async function sendSupplement(message) {
  // 在当前助手消息区域内添加补充提示
  if (currentAssistantEl) {
    var stepsEl = currentAssistantEl.querySelector('.msg-steps');
    if (stepsEl) {
      var supEl = document.createElement('div');
      supEl.className = 'supplement-bubble';
      supEl.innerHTML = '<span class="supplement-label">' + T.supplementSent + '</span><span class="supplement-text">' + escapeHtml(message) + '</span>';
      stepsEl.appendChild(supEl);
      scrollToBottom();
    }
  }

  try {
    await fetch(API_BASE + '/api/chat/supplement', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ message: message })
    });
  } catch (e) {
    console.error('Supplement failed:', e);
  }
}

// ==================== Send Message ====================

async function sendMessage() {
  var input = document.getElementById('msg-input');
  var message = input.value.trim();
  if (!message) return;

  // 任务运行中：发送补充信息
  if (isRunning) {
    sendSupplement(message);
    input.value = '';
    autoResize(input);
    return;
  }

  input.value = '';
  autoResize(input);
  var emptyEl = document.getElementById('empty-state');
  if (emptyEl) emptyEl.style.display = 'none';

  addUserBubble(message);

  currentAssistantEl = createAssistantBubble();
  updateStatus(true);
  ownTaskActive = true;

  var mode = document.getElementById('mode-select').value;

  try {
    var r = await fetch(API_BASE + '/api/chat', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ message: message, executionMode: mode })
    });

    if (!r.ok) {
      var errData = await r.json().catch(function() { return { error: 'Request failed' }; });
      finishAssistant(T.error + ': ' + (errData.error || r.statusText));
      updateStatus(false);
      ownTaskActive = false;
      return;
    }

    // Read SSE stream
    var reader = r.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '';

    while (true) {
      var chunk = await reader.read();
      if (chunk.done) break;

      buffer += decoder.decode(chunk.value, { stream: true });
      var lines = buffer.split('\\n');
      buffer = lines.pop() || '';

      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (!line.startsWith('data: ')) continue;
        try {
          var event = JSON.parse(line.substring(6));
          handleSSEEvent(event);
        } catch (ex) { /* skip malformed */ }
      }
    }

    // 流结束后兜底：如果 complete/error 未触发，确保 UI 不卡在 running
    if (isRunning && currentAssistantEl) {
      finishAssistant('');
      updateStatus(false);
    }
  } catch (e) {
    finishAssistant(T.error + ': ' + e.message);
    updateStatus(false);
  }
  ownTaskActive = false;
}

function handleSSEEvent(event) {
  if (!currentAssistantEl) return;

  switch (event.type) {
    case 'thinking':
      showThinking(currentAssistantEl);
      break;
    case 'step':
      addStepCard(currentAssistantEl, event.step);
      break;
    case 'step_update':
      updateStepCard(currentAssistantEl, event.step);
      break;
    case 'text_new':
      appendTextBlock(currentAssistantEl, event.content, event.stepId);
      break;
    case 'text_replace':
      replaceTextBlock(currentAssistantEl, event.content, event.stepId);
      break;
    case 'text':
      appendTextBlock(currentAssistantEl, event.content, null);
      break;
    case 'need_confirm':
      showConfirmBar(event.confirmation);
      break;
    case 'complete':
      finishAssistant(event.content);
      updateStatus(false);
      break;
    case 'error':
      finishAssistant(T.error + ': ' + event.error);
      updateStatus(false);
      break;
  }
  scrollToBottom();
}

// ==================== UI Helpers ====================

function addUserBubble(content) {
  var el = document.createElement('div');
  el.className = 'msg msg-user';
  el.textContent = content;
  document.getElementById('messages').appendChild(el);
  scrollToBottom();
}

function createAssistantBubble() {
  var el = document.createElement('div');
  el.className = 'msg msg-assistant';
  el.innerHTML = '<div class="msg-steps"></div><div class="msg-content"></div>';
  document.getElementById('messages').appendChild(el);
  return el;
}

function addAssistantBubble(content, steps) {
  var el = createAssistantBubble();
  if (steps && steps.length > 0) {
    steps.forEach(function(step) { addStepCard(el, step); });
  }
  if (content) {
    el.querySelector('.msg-content').innerHTML = '<div class="msg-final">' + formatContent(content) + '</div>';
  }
}

function showThinking(el) {
  var thinkEl = el.querySelector('.thinking');
  if (!thinkEl) {
    thinkEl = document.createElement('div');
    thinkEl.className = 'thinking';
    el.querySelector('.msg-steps').appendChild(thinkEl);
  }
  thinkEl.innerHTML = T.thinking + '<span class="thinking-dots"><span>.</span><span>.</span><span>.</span></span>';
}

function appendTextBlock(el, content, stepId) {
  if (!content) return;
  // 移除思考指示器
  var thinkEl = el.querySelector('.thinking');
  if (thinkEl) thinkEl.remove();
  // 在步骤区域创建新文本块
  var stepsContainer = el.querySelector('.msg-steps');
  var textBlock = document.createElement('div');
  textBlock.className = 'msg-text-block';
  if (stepId) textBlock.setAttribute('data-step-id', stepId);
  textBlock.innerHTML = formatContent(content);
  stepsContainer.appendChild(textBlock);
}

function replaceTextBlock(el, content, stepId) {
  if (!content) return;
  // 移除思考指示器
  var thinkEl = el.querySelector('.thinking');
  if (thinkEl) thinkEl.remove();
  // 找到同 stepId 的文本块并替换内容
  var stepsContainer = el.querySelector('.msg-steps');
  var existing = stepId ? stepsContainer.querySelector('.msg-text-block[data-step-id="' + stepId + '"]') : null;
  if (existing) {
    existing.innerHTML = formatContent(content);
  } else {
    // 降级：找不到就追加新块
    appendTextBlock(el, content, stepId);
  }
}

function addStepCard(el, step) {
  var thinkEl = el.querySelector('.thinking');
  if (thinkEl) thinkEl.remove();

  var stepsContainer = el.querySelector('.msg-steps');
  var card = document.createElement('div');
  card.className = 'step-card';
  if (step.id) card.setAttribute('data-step-id', step.id);

  var icon = getStepIcon(step.type, step.toolName);
  var title = getStepTitle(step);
  var id = 'step-' + Math.random().toString(36).substr(2, 9);

  // asking 类型默认展开（用户需要看到问题和选项）
  var isOpen = (step.type === 'asking');
  card.innerHTML =
    '<div class="step-header" onclick="toggleStep(\\'' + id + '\\')">' +
      '<span class="step-icon">' + icon + '</span>' +
      '<span class="step-title">' + escapeHtml(title) + '</span>' +
      '<span class="step-arrow' + (isOpen ? ' expanded' : '') + '" id="' + id + '-arrow">▶</span>' +
    '</div>' +
    '<div class="step-body' + (isOpen ? ' show' : '') + '" id="' + id + '">' +
      buildStepBody(step) +
    '</div>';

  stepsContainer.appendChild(card);
}

function updateStepCard(el, step) {
  if (!step.id) return;
  var stepsContainer = el.querySelector('.msg-steps');
  var existingCard = stepsContainer.querySelector('.step-card[data-step-id="' + step.id + '"]');
  if (existingCard) {
    // 更新 body 内容（如 tool_result 回填）
    var bodyEl = existingCard.querySelector('.step-body');
    if (bodyEl) bodyEl.innerHTML = buildStepBody(step);
    // 更新标题
    var titleEl = existingCard.querySelector('.step-title');
    if (titleEl) titleEl.textContent = getStepTitle(step);
  }
}

function buildStepBody(step) {
  var html = '';

  // asking 类型特殊渲染：显示问题 + 可点击选项
  if (step.type === 'asking' || (step.toolName === 'ask_user')) {
    var question = (step.toolArgs && step.toolArgs.question) || step.content || '';
    html += '<div class="ask-question">' + escapeHtml(question) + '</div>';
    if (step.toolArgs && step.toolArgs.options && step.toolArgs.options.length > 0) {
      html += '<div class="ask-options">';
      for (var oi = 0; oi < step.toolArgs.options.length; oi++) {
        var optText = step.toolArgs.options[oi];
        html += '<button class="ask-option" data-option="' + escapeHtml(optText) + '">' +
          escapeHtml(optText) + '</button>';
      }
      html += '</div>';
    }
    if (step.toolResult) {
      html += '<div class="ask-status">' + escapeHtml(step.toolResult) + '</div>';
    }
    return html;
  }

  if (step.toolName) {
    html += '<div class="step-label">' + T.stepTool + '</div><pre>' + escapeHtml(step.toolName) + '</pre>';
  }
  if (step.toolArgs && Object.keys(step.toolArgs).length > 0) {
    html += '<div class="step-label">' + T.stepArgs + '</div><pre>' + escapeHtml(JSON.stringify(step.toolArgs, null, 2)) + '</pre>';
  }
  if (step.toolResult) {
    html += '<div class="step-label">' + T.stepResult + '</div><pre>' + escapeHtml(truncate(step.toolResult, 2000)) + '</pre>';
  }
  if (step.content && step.type !== 'thinking') {
    html += '<div class="step-label">' + T.stepContent + '</div><pre>' + escapeHtml(truncate(step.content, 2000)) + '</pre>';
  }
  return html || '<pre>' + T.noDetails + '</pre>';
}

function finishAssistant(content) {
  if (!currentAssistantEl) return;
  var thinkEl = currentAssistantEl.querySelector('.thinking');
  if (thinkEl) thinkEl.remove();
  // 清除流式中间文本块（会被最终结果替代）
  var textBlocks = currentAssistantEl.querySelectorAll('.msg-text-block');
  for (var i = 0; i < textBlocks.length; i++) textBlocks[i].remove();
  // 标记补充气泡为已处理（去掉虚线边框）
  var supBubbles = currentAssistantEl.querySelectorAll('.supplement-bubble');
  for (var j = 0; j < supBubbles.length; j++) supBubbles[j].classList.add('processed');
  if (content) {
    currentAssistantEl.querySelector('.msg-content').innerHTML =
      '<div class="msg-final">' + formatContent(content) + '</div>';
  }
  currentAssistantEl = null;
  hideConfirmBar();
}

function toggleStep(id) {
  var body = document.getElementById(id);
  var arrow = document.getElementById(id + '-arrow');
  if (!body || !arrow) return;
  if (body.classList.contains('show')) {
    body.classList.remove('show');
    arrow.classList.remove('expanded');
  } else {
    body.classList.add('show');
    arrow.classList.add('expanded');
  }
}

function getStepIcon(type, toolName) {
  if (toolName === 'execute_command' || toolName === 'executeCommand') return '⚡';
  if (toolName === 'write_file' || toolName === 'writeFile') return '📄';
  if (toolName === 'read_file' || toolName === 'readFile') return '📖';
  if (toolName === 'search_files' || toolName === 'searchFiles' || toolName === 'searchCode') return '🔍';
  if (toolName === 'ask_user') return '❓';
  var icons = {
    'tool_call': '🔧', 'tool_result': '📋', 'thinking': '💭',
    'message': '💬', 'error': '❌', 'confirm': '⚠️',
    'plan_created': '📝', 'plan_updated': '📝',
    'asking': '❓', 'waiting': '⏳'
  };
  return icons[type] || '▪️';
}

function getStepTitle(step) {
  if (step.toolName) {
    var names = {
      'execute_command': T.executeCommand, 'executeCommand': T.executeCommand,
      'write_file': T.writeFile, 'writeFile': T.writeFile,
      'read_file': T.readFile, 'readFile': T.readFile,
      'search_files': T.search, 'searchFiles': T.search, 'searchCode': T.searchCode,
      'think': T.think, 'plan': T.plan
    };
    var title = names[step.toolName] || step.toolName;
    if (step.toolArgs) {
      if (step.toolArgs.command) title += ': ' + truncate(step.toolArgs.command, 60);
      else if (step.toolArgs.path) title += ': ' + truncate(step.toolArgs.path, 60);
      else if (step.toolArgs.filePath) title += ': ' + truncate(step.toolArgs.filePath, 60);
    }
    return title;
  }
  var titles = {
    'thinking': T.thinkingTitle, 'message': T.message,
    'error': T.error, 'plan_created': T.planCreated, 'plan_updated': T.planUpdated,
    'asking': T.askUser, 'waiting': T.waiting
  };
  return titles[step.type] || step.type;
}

// ==================== Confirm ====================

function showConfirmBar(confirmation) {
  document.getElementById('confirm-bar').style.display = 'flex';
  document.getElementById('confirm-tool').textContent = confirmation.toolName;
  document.getElementById('confirm-args').textContent = JSON.stringify(confirmation.toolArgs, null, 2);
}

function hideConfirmBar() {
  document.getElementById('confirm-bar').style.display = 'none';
}

async function confirmAction(approved) {
  try {
    await fetch(API_BASE + '/api/chat/confirm', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ approved: approved })
    });
    hideConfirmBar();
  } catch (e) {
    console.error('Confirm failed:', e);
  }
}

// ==================== Abort / Clear ====================

async function abortTask() {
  try {
    await fetch(API_BASE + '/api/chat/abort', { method: 'POST', headers: headers() });
  } catch (e) {
    console.error('Abort failed:', e);
  }
}

async function clearChat() {
  if (isRunning) { alert(T.clearRunning); return; }
  try {
    await fetch(API_BASE + '/api/chat/clear', { method: 'POST', headers: headers() });
    document.getElementById('messages').innerHTML =
      '<div class="empty-state" id="empty-state"><div><div class="logo">🐟</div>' +
      '<p>' + T.emptyHint + '</p></div></div>';
    currentAssistantEl = null;
  } catch (e) {
    console.error('Clear failed:', e);
  }
}

// ==================== Status ====================

function updateStatus(running) {
  isRunning = running;
  var dot = document.getElementById('status-dot');
  var abortBtn = document.getElementById('abort-btn');
  var sendBtn = document.getElementById('send-btn');
  var input = document.getElementById('msg-input');
  dot.className = 'status-dot ' + (running ? 'busy' : 'online');
  abortBtn.style.display = running ? 'inline-block' : 'none';
  // 运行中：切换为补充模式（按钮可用，placeholder 和按钮文案切换）
  sendBtn.disabled = false;
  if (running) {
    sendBtn.textContent = T.supplement;
    sendBtn.classList.add('supplement-mode');
    input.placeholder = T.supplementPlaceholder;
  } else {
    sendBtn.textContent = T.send;
    sendBtn.classList.remove('supplement-mode');
    input.placeholder = T.inputPlaceholder;
  }
}

// ==================== Utils ====================

function escapeHtml(s) {
  if (!s) return '';
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function formatContent(s) {
  if (!s) return '';
  var html = escapeHtml(s);
  // code blocks
  html = html.replace(/\`\`\`([\\s\\S]*?)\`\`\`/g, '<pre><code>$1</code></pre>');
  // inline code
  html = html.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
  // bold
  html = html.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
  return html;
}

function truncate(s, max) {
  if (!s || s.length <= max) return s;
  return s.substring(0, max) + '... (' + s.length + ' chars)';
}

function scrollToBottom() {
  var el = document.getElementById('messages');
  requestAnimationFrame(function() { el.scrollTop = el.scrollHeight; });
}

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

function handleKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
}

// Init
document.getElementById('token-input').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') doLogin();
});

// 事件委托：ask_user 选项按钮点击
document.getElementById('messages').addEventListener('click', function(e) {
  var btn = e.target.closest('.ask-option');
  if (btn && btn.dataset.option) {
    sendSupplement(btn.dataset.option);
  }
});

// ==================== SSE 实时事件流 ====================
// 连接 /api/chat/events，实时接收所有通道（IM / 其他 Web 客户端）触发的 Agent 事件
// 自己发起的任务通过 POST /api/chat 的 SSE 响应处理，此流仅处理外部任务

async function connectEventStream() {
  if (!TOKEN) return;
  if (evtController) evtController.abort();
  evtController = new AbortController();

  try {
    var r = await fetch(API_BASE + '/api/chat/events', {
      headers: headers(),
      signal: evtController.signal
    });
    if (!r.ok) { setTimeout(connectEventStream, 5000); return; }

    var reader = r.body.getReader();
    var decoder = new TextDecoder();
    var buf = '';

    while (true) {
      var chunk = await reader.read();
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      var lines = buf.split('\\n');
      buf = lines.pop() || '';
      for (var i = 0; i < lines.length; i++) {
        if (!lines[i].startsWith('data: ')) continue;
        try {
          var evt = JSON.parse(lines[i].substring(6));
          handleExternalEvent(evt);
        } catch {}
      }
    }
    // 连接正常关闭（服务器重启等），自动重连
    setTimeout(connectEventStream, 2000);
  } catch (e) {
    if (e.name !== 'AbortError') {
      setTimeout(connectEventStream, 5000);
    }
  }
}

function handleExternalEvent(evt) {
  // 自己发起的任务由 sendMessage 的 SSE 响应处理，跳过
  if (ownTaskActive) return;

  switch (evt.type) {
    case 'init':
      // 连接时如果有外部任务正在运行，准备接收后续事件
      if (evt.isRunning && !currentAssistantEl) {
        loadHistory(true).then(function() {
          // 历史只包含已完成的消息，为正在进行的任务创建新气泡
          if (!currentAssistantEl) {
            currentAssistantEl = createAssistantBubble();
          }
        });
      }
      break;
    case 'task_started':
      // 外部通道（IM）发来新任务
      var emptyEl = document.getElementById('empty-state');
      if (emptyEl) emptyEl.style.display = 'none';
      addUserBubble(evt.message);
      currentAssistantEl = createAssistantBubble();
      updateStatus(true);
      scrollToBottom();
      break;
    case 'history_cleared':
      // 外部清空了历史
      document.getElementById('messages').innerHTML =
        '<div class="empty-state" id="empty-state"><div><div class="logo">🐟</div>' +
        '<p>' + T.emptyHint + '</p></div></div>';
      currentAssistantEl = null;
      updateStatus(false);
      break;
    case 'thinking':
    case 'step':
    case 'step_update':
    case 'text_new':
    case 'text_replace':
    case 'text':
    case 'need_confirm':
    case 'complete':
    case 'error':
      // 直接复用已有的 SSE 事件处理逻辑
      handleSSEEvent(evt);
      break;
  }
}

init();
connectEventStream();
</script>
</body>
</html>`
  }
}

// 单例管理 ----------------------------------------------------------------

let gatewayServiceInstance: GatewayService | null = null

export function getGatewayService(): GatewayService {
  if (!gatewayServiceInstance) {
    gatewayServiceInstance = new GatewayService()
  }
  return gatewayServiceInstance
}
