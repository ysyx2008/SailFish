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
 * - GET  /chat          → 聊天页面
 * - POST /api/chat      → 发送消息（SSE 流式响应）
 * - GET  /api/chat/history  → 获取历史
 * - POST /api/chat/abort    → 中止执行
 * - POST /api/chat/confirm  → 确认工具调用
 * - GET  /api/chat/status   → 获取状态
 * - POST /api/chat/clear    → 清空历史
 * - GET  /api/health        → 健康检查
 */

import * as http from 'http'
import * as crypto from 'crypto'
import * as os from 'os'

// 类型定义 ---------------------------------------------------------------

export interface GatewayConfig {
  enabled: boolean
  port: number
  apiToken: string
  host: string  // 监听地址，默认 '0.0.0.0'
}

export interface GatewayDependencies {
  agentService: {
    run: (ptyId: string, message: string, context: any, config?: any, profileId?: string, workerOptions?: any, callbacks?: any) => Promise<string>
    abort: (ptyId: string) => boolean
    confirmToolCall: (ptyId: string, toolCallId: string, approved: boolean, modifiedArgs?: Record<string, unknown>, alwaysAllow?: boolean) => boolean
    getRunStatus: (ptyId: string) => any
    cleanupAgent: (ptyId: string) => void
  }
  ptyService: {
    create: (options?: any) => Promise<string>
    write: (id: string, data: string) => void
    resize: (id: string, cols: number, rows: number) => void
    dispose: (id: string) => void
    onData: (id: string, callback: (data: string) => void) => () => void
  }
  configService: {
    getActiveAiProfile: () => any
    getAgentDebugMode: () => boolean
    get: (key: string) => any
  }
}

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  timestamp: number
  steps?: any[]
}

interface ChatState {
  ptyId: string | null
  isRunning: boolean
  history: ChatMessage[]
  pendingConfirm: any | null
  executionMode: 'strict' | 'relaxed' | 'free'
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
  private chatState: ChatState = {
    ptyId: null,
    isRunning: false,
    history: [],
    pendingConfirm: null,
    executionMode: 'relaxed'
  }
  private ptyUnsubscribe: (() => void) | null = null

  /**
   * 注入依赖（在 main.ts 中调用）
   */
  setDependencies(deps: GatewayDependencies) {
    this.deps = deps
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
   */
  async stop(): Promise<void> {
    if (this.ptyUnsubscribe) {
      this.ptyUnsubscribe()
      this.ptyUnsubscribe = null
    }
    if (this.chatState.ptyId && this.deps) {
      try {
        this.deps.ptyService.dispose(this.chatState.ptyId)
      } catch { /* ignore */ }
      this.chatState.ptyId = null
    }
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
      case '/api/chat/abort':
        return req.method === 'POST' ? this.handleChatAbort(req, res) : this.methodNotAllowed(res)
      case '/api/chat/confirm':
        return req.method === 'POST' ? this.handleChatConfirm(req, res) : this.methodNotAllowed(res)
      case '/api/chat/status':
        return req.method === 'GET' ? this.handleChatStatus(req, res) : this.methodNotAllowed(res)
      case '/api/chat/clear':
        return req.method === 'POST' ? this.handleChatClear(req, res) : this.methodNotAllowed(res)
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

    if (this.chatState.isRunning) {
      res.writeHead(409, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Agent is already running' }))
      return
    }

    // 更新执行模式
    if (executionMode && ['strict', 'relaxed', 'free'].includes(executionMode)) {
      this.chatState.executionMode = executionMode as ChatState['executionMode']
    }

    // 确保 PTY 存在
    try {
      await this.ensurePty()
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: `Failed to create terminal: ${err.message}` }))
      return
    }

    // 添加用户消息到历史
    this.chatState.history.push({
      role: 'user',
      content: message.trim(),
      timestamp: Date.now()
    })

    // SSE 响应
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    })

    const assistantMsg: ChatMessage = {
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      steps: []
    }

    this.chatState.isRunning = true
    this.chatState.pendingConfirm = null

    const sendEvent = (type: string, data: any) => {
      try {
        res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`)
      } catch { /* connection closed */ }
    }

    const context = {
      ptyId: this.chatState.ptyId!,
      terminalOutput: [],
      systemInfo: {
        os: `${os.type()} ${os.release()}`,
        shell: process.env.SHELL || 'bash'
      },
      terminalType: 'local' as const
    }

    const agentConfig = {
      executionMode: this.chatState.executionMode,
      debugMode: this.deps!.configService.getAgentDebugMode()
    }

    // 只展示有意义的操作步骤类型
    const VISIBLE_STEP_TYPES = new Set([
      'tool_call', 'tool_result', 'error', 'confirm',
      'plan_created', 'plan_updated', 'plan_archived'
    ])

    const callbacks = {
      onStep: (_agentId: string, step: any) => {
        if (step.type === 'thinking') {
          sendEvent('thinking', { content: step.content })
        } else if (VISIBLE_STEP_TYPES.has(step.type)) {
          const serializedStep = JSON.parse(JSON.stringify(step))
          assistantMsg.steps!.push(serializedStep)
          sendEvent('step', { step: serializedStep })
        } else if (step.type === 'message' && step.content) {
          // 中间消息作为实时文本发送，让用户看到 Agent 的思路
          sendEvent('text', { content: step.content })
        }
        // streaming, user_supplement, waiting 等类型不显示
      },
      onNeedConfirm: (confirmation: any) => {
        this.chatState.pendingConfirm = {
          toolCallId: confirmation.toolCallId,
          toolName: confirmation.toolName,
          toolArgs: JSON.parse(JSON.stringify(confirmation.toolArgs)),
          riskLevel: confirmation.riskLevel
        }
        sendEvent('need_confirm', { confirmation: this.chatState.pendingConfirm })
      },
      onComplete: (_agentId: string, result: string) => {
        assistantMsg.content = result
        this.chatState.history.push(assistantMsg)
        this.chatState.isRunning = false
        this.chatState.pendingConfirm = null
        sendEvent('complete', { content: result })
        res.end()
      },
      onError: (_agentId: string, error: string) => {
        assistantMsg.content = `Error: ${error}`
        this.chatState.history.push(assistantMsg)
        this.chatState.isRunning = false
        this.chatState.pendingConfirm = null
        sendEvent('error', { error })
        res.end()
      }
    }

    try {
      const activeProfile = this.deps!.configService.getActiveAiProfile()
      const profileId = activeProfile?.id

      await this.deps!.agentService.run(
        this.chatState.ptyId!,
        message.trim(),
        context,
        agentConfig,
        profileId,
        undefined,
        callbacks
      )

      // 如果 onComplete 没有被调用（Agent 直接返回）
      if (this.chatState.isRunning) {
        this.chatState.isRunning = false
        sendEvent('complete', { content: assistantMsg.content || 'Done' })
        if (!assistantMsg.content) {
          assistantMsg.content = 'Done'
        }
        this.chatState.history.push(assistantMsg)
        res.end()
      }
    } catch (err: any) {
      if (this.chatState.isRunning) {
        this.chatState.isRunning = false
        const errMsg = err.message || 'Unknown error'
        sendEvent('error', { error: errMsg })
        assistantMsg.content = `Error: ${errMsg}`
        this.chatState.history.push(assistantMsg)
        res.end()
      }
    }
  }

  /**
   * GET /api/chat/history
   */
  private handleChatHistory(_req: http.IncomingMessage, res: http.ServerResponse) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      history: this.chatState.history,
      isRunning: this.chatState.isRunning,
      executionMode: this.chatState.executionMode
    }))
  }

  /**
   * POST /api/chat/abort
   */
  private async handleChatAbort(_req: http.IncomingMessage, res: http.ServerResponse) {
    if (!this.chatState.ptyId || !this.chatState.isRunning) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'No running task' }))
      return
    }
    const result = this.deps!.agentService.abort(this.chatState.ptyId)
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
    if (!this.chatState.ptyId || !this.chatState.pendingConfirm) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'No pending confirmation' }))
      return
    }

    const result = this.deps!.agentService.confirmToolCall(
      this.chatState.ptyId,
      toolCallId || this.chatState.pendingConfirm.toolCallId,
      approved !== false,
      modifiedArgs,
      alwaysAllow
    )
    this.chatState.pendingConfirm = null
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ success: result }))
  }

  /**
   * GET /api/chat/status
   */
  private handleChatStatus(_req: http.IncomingMessage, res: http.ServerResponse) {
    let agentStatus = null
    if (this.chatState.ptyId) {
      agentStatus = this.deps!.agentService.getRunStatus(this.chatState.ptyId)
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      isRunning: this.chatState.isRunning,
      pendingConfirm: this.chatState.pendingConfirm,
      executionMode: this.chatState.executionMode,
      agentStatus
    }))
  }

  /**
   * POST /api/chat/clear
   */
  private handleChatClear(_req: http.IncomingMessage, res: http.ServerResponse) {
    if (this.chatState.ptyId && this.deps) {
      this.deps.agentService.cleanupAgent(this.chatState.ptyId)
    }
    this.chatState.history = []
    this.chatState.pendingConfirm = null
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ success: true }))
  }

  // ==================== PTY 管理 ====================

  private async ensurePty(): Promise<void> {
    if (this.chatState.ptyId) return
    if (!this.deps) throw new Error('Dependencies not set')

    const ptyId = await this.deps.ptyService.create()
    this.chatState.ptyId = ptyId

    // 订阅终端输出（保留最近的输出用于 context）
    this.ptyUnsubscribe = this.deps.ptyService.onData(ptyId, (_data: string) => {
      // 终端输出可以用于 Agent context，目前不做额外处理
    })
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
    const lang = this.deps?.configService?.get('language') || 'zh-CN'
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
      planUpdated: '计划已更新'
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
      planUpdated: 'Plan Updated'
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

async function loadHistory() {
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

// ==================== Send Message ====================

async function sendMessage() {
  var input = document.getElementById('msg-input');
  var message = input.value.trim();
  if (!message || isRunning) return;

  input.value = '';
  autoResize(input);
  var emptyEl = document.getElementById('empty-state');
  if (emptyEl) emptyEl.style.display = 'none';

  addUserBubble(message);

  currentAssistantEl = createAssistantBubble();
  updateStatus(true);

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
    case 'text':
      appendText(currentAssistantEl, event.content);
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

function appendText(el, content) {
  if (!content) return;
  // 移除思考指示器
  var thinkEl = el.querySelector('.thinking');
  if (thinkEl) thinkEl.remove();
  // 在步骤区域追加文本块（不是内容区，这样与工具调用卡片交错显示）
  var stepsContainer = el.querySelector('.msg-steps');
  var textBlock = document.createElement('div');
  textBlock.className = 'msg-text-block';
  textBlock.innerHTML = formatContent(content);
  stepsContainer.appendChild(textBlock);
}

function addStepCard(el, step) {
  var thinkEl = el.querySelector('.thinking');
  if (thinkEl) thinkEl.remove();

  var stepsContainer = el.querySelector('.msg-steps');
  var card = document.createElement('div');
  card.className = 'step-card';

  var icon = getStepIcon(step.type, step.toolName);
  var title = getStepTitle(step);
  var id = 'step-' + Math.random().toString(36).substr(2, 9);

  card.innerHTML =
    '<div class="step-header" onclick="toggleStep(\\'' + id + '\\')">' +
      '<span class="step-icon">' + icon + '</span>' +
      '<span class="step-title">' + escapeHtml(title) + '</span>' +
      '<span class="step-arrow" id="' + id + '-arrow">▶</span>' +
    '</div>' +
    '<div class="step-body" id="' + id + '">' +
      buildStepBody(step) +
    '</div>';

  stepsContainer.appendChild(card);
}

function buildStepBody(step) {
  var html = '';
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
  var icons = {
    'tool_call': '🔧', 'tool_result': '📋', 'thinking': '💭',
    'message': '💬', 'error': '❌', 'confirm': '⚠️',
    'plan_created': '📝', 'plan_updated': '📝'
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
    'error': T.error, 'plan_created': T.planCreated, 'plan_updated': T.planUpdated
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
  dot.className = 'status-dot ' + (running ? 'busy' : 'online');
  abortBtn.style.display = running ? 'inline-block' : 'none';
  sendBtn.disabled = running;
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
init();
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
