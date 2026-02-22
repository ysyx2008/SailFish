/**
 * Remote Chat Service - 远程会话核心服务
 *
 * 统一管理 Web Service 和 IM 集成的共享会话状态。
 * 所有远程通道（Web、钉钉、飞书等）共享同一个 Agent 会话。
 *
 * 架构：
 *   Web / IM ──→ RemoteChatService.sendMessage()
 *                        │
 *          通知桌面前端创建 assistant tab + pendingTask
 *                        │
 *          前端 AiPanel 走 runStandalone 驱动执行
 *                        │
 *          后端 runStandalone IPC handler 回调 onAgentStep/onAgentComplete
 *                        │
 *             IM/SSE 回调 + sendMessage Promise resolve
 */

import { v4 as uuidv4 } from 'uuid'

// ==================== 类型定义 ====================

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  timestamp: number
  steps?: any[]
}

export interface RemoteChatDependencies {
  agentService: {
    abort: (agentId: string) => boolean
    confirmToolCall: (agentId: string, toolCallId: string, approved: boolean, modifiedArgs?: Record<string, unknown>, alwaysAllow?: boolean) => boolean
    getRunStatus: (agentId: string) => any
    cleanupAgent: (agentId: string) => void
    addUserMessage: (agentId: string, message: string) => boolean
  }
  configService: {
    getActiveAiProfile: () => any
    getAgentDebugMode: () => boolean
    get: (key: any) => any
  }
  mainWindow: {
    webContents: {
      send: (channel: string, ...args: any[]) => void
      isDestroyed: () => boolean
    }
  } | null
}

/**
 * 调用方提供的回调，用于各通道（SSE / IM）各自处理 Agent 输出
 */
export interface AgentCallbacks {
  onStep?: (agentId: string, step: any) => void
  onNeedConfirm?: (confirmation: any) => void
  onComplete?: (agentId: string, result: string) => void
  onError?: (agentId: string, error: string) => void
}

export const VISIBLE_STEP_TYPES = new Set([
  'tool_call', 'error', 'confirm',
  'plan_created', 'plan_updated', 'plan_archived',
  'asking', 'waiting'
])

// ==================== 核心服务 ====================

export type RemoteChatEventListener = (event: any) => void

export class RemoteChatService {
  private deps: RemoteChatDependencies | null = null
  private agentId: string = `remote-agent-${uuidv4()}`
  private _isRunning = false
  private history: ChatMessage[] = []
  private _pendingConfirm: any | null = null
  private _executionMode: 'strict' | 'relaxed' | 'free' = 'relaxed'
  private _tabCreated = false

  // 当前运行的 IM/SSE 回调和状态
  private _callerCallbacks: AgentCallbacks | null = null
  private _currentAssistantMsg: ChatMessage | null = null
  private _runResolve: (() => void) | null = null

  // ---- 事件广播：供 SSE /api/chat/events 端点使用 ----
  private listeners = new Set<RemoteChatEventListener>()
  private emittedStepIds = new Set<string>()
  private currentMessageStepId: string | null = null

  subscribe(listener: RemoteChatEventListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private emitEvent(event: any) {
    for (const listener of this.listeners) {
      try { listener(event) } catch { /* ignore */ }
    }
  }

  setDependencies(deps: RemoteChatDependencies) {
    this.deps = deps
  }

  setMainWindow(win: RemoteChatDependencies['mainWindow']) {
    if (this.deps) {
      this.deps.mainWindow = win
    }
  }

  getConfigValue(key: any): any {
    return this.deps?.configService.get(key)
  }

  // ==================== 状态查询 ====================

  getState() {
    return {
      agentId: this.agentId,
      isRunning: this._isRunning,
      history: this.history,
      pendingConfirm: this._pendingConfirm,
      executionMode: this._executionMode
    }
  }

  getHistory(): ChatMessage[] { return this.history }
  get isRunning(): boolean { return this._isRunning }
  get pendingConfirm(): any | null { return this._pendingConfirm }
  get executionMode(): 'strict' | 'relaxed' | 'free' { return this._executionMode }
  set executionMode(mode: 'strict' | 'relaxed' | 'free') { this._executionMode = mode }
  getAgentId(): string { return this.agentId }

  // ==================== 核心操作 ====================

  private ensureDesktopTab(): void {
    if (!this._tabCreated) {
      this._tabCreated = true
      this.sendToDesktop('gateway:remoteTabCreated', {
        agentId: this.agentId,
        title: '📡 Remote Agent'
      })
    }
  }

  /**
   * 发送消息：通知前端创建 tab + pendingTask，等待前端 runStandalone 完成
   *
   * 不直接调 agentService，由前端 AiPanel 驱动执行。
   * 通过 onAgentStep / onAgentComplete / onAgentError 接收结果。
   */
  async sendMessage(message: string, callbacks?: AgentCallbacks, remoteChannel?: 'desktop' | 'web' | 'dingtalk' | 'feishu' | 'slack' | 'telegram' | 'wecom'): Promise<void> {
    if (!this.deps) throw new Error('Dependencies not set')
    if (this._isRunning) throw new Error('Agent is already running')

    this.ensureDesktopTab()

    const remoteChannelValue = remoteChannel || 'desktop'
    console.log(`[RemoteChat] sendMessage: agentId=${this.agentId}, remoteChannel=${remoteChannelValue}, message="${message.trim().substring(0, 60)}"`)

    this.history.push({
      role: 'user',
      content: message.trim(),
      timestamp: Date.now()
    })

    this._currentAssistantMsg = {
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      steps: []
    }

    this._isRunning = true
    this._pendingConfirm = null
    this._callerCallbacks = callbacks || null
    this.emittedStepIds.clear()
    this.currentMessageStepId = null

    this.emitEvent({ type: 'task_started', message: message.trim() })

    // 通知前端创建 tab + 提交任务
    this.sendToDesktop('gateway:remoteTaskStarted', {
      agentId: this.agentId,
      message: message.trim(),
      remoteChannel: remoteChannelValue
    })

    // 等待前端执行完成（由 onAgentComplete / onAgentError 触发 resolve）
    return new Promise<void>((resolve) => {
      this._runResolve = resolve
    })
  }

  /**
   * 前端 runStandalone 产生的步骤事件（由 main.ts IPC handler 调用）
   */
  onAgentStep(step: any): void {
    if (!this._isRunning) return

    const serializedStep = JSON.parse(JSON.stringify(step))

    if (this._currentAssistantMsg && VISIBLE_STEP_TYPES.has(step.type)) {
      const idx = this._currentAssistantMsg.steps!.findIndex((s: any) => s.id === step.id)
      if (idx === -1) {
        this._currentAssistantMsg.steps!.push(serializedStep)
      } else {
        this._currentAssistantMsg.steps![idx] = serializedStep
      }
    }

    if (step.type === 'message' && step.content && !step.isStreaming) {
      if (this._currentAssistantMsg) this._currentAssistantMsg.content = step.content
    }

    // 广播 SSE 事件
    if (step.type === 'thinking') {
      if (!this.emittedStepIds.has(step.id)) {
        this.emittedStepIds.add(step.id)
        this.emitEvent({ type: 'thinking', content: step.content })
      }
    } else if (step.type === 'message' && step.content) {
      if (this.currentMessageStepId !== step.id) {
        this.currentMessageStepId = step.id
        this.emitEvent({ type: 'text_new', content: step.content, stepId: step.id })
      } else {
        this.emitEvent({ type: 'text_replace', content: step.content, stepId: step.id })
      }
      if (!step.isStreaming) {
        this.emitEvent({ type: 'text_replace', content: step.content, stepId: step.id })
      }
    } else if (VISIBLE_STEP_TYPES.has(step.type)) {
      if (!this.emittedStepIds.has(step.id)) {
        this.emittedStepIds.add(step.id)
        this.emitEvent({ type: 'step', step: serializedStep })
      } else {
        this.emitEvent({ type: 'step_update', step: serializedStep })
      }
      if (step.type === 'tool_call') {
        this.currentMessageStepId = null
      }
    }

    // 转发确认请求
    if (step.type === 'confirm') {
      this._pendingConfirm = {
        toolCallId: step.toolCallId || step.id,
        toolName: step.toolName,
        toolArgs: step.toolArgs,
        riskLevel: step.riskLevel
      }
      this._callerCallbacks?.onNeedConfirm?.(this._pendingConfirm)
      this.emitEvent({ type: 'need_confirm', confirmation: this._pendingConfirm })
    }

    this._callerCallbacks?.onStep?.(this.agentId, step)
  }

  /**
   * 前端 Agent 执行完成（由 main.ts IPC handler 调用）
   */
  onAgentComplete(result: string): void {
    if (!this._isRunning) return

    if (this._currentAssistantMsg) {
      this._currentAssistantMsg.content = result
      this.history.push(this._currentAssistantMsg)
      this._currentAssistantMsg = null
    }

    this._isRunning = false
    this._pendingConfirm = null

    console.log(`[RemoteChat] onAgentComplete: agentId=${this.agentId}, result="${result.substring(0, 60)}"`)

    this._callerCallbacks?.onComplete?.(this.agentId, result)
    this._callerCallbacks = null

    this.emitEvent({ type: 'complete', content: result })
    this.emittedStepIds.clear()
    this.currentMessageStepId = null

    this._runResolve?.()
    this._runResolve = null
  }

  /**
   * 前端 Agent 执行出错（由 main.ts IPC handler 调用）
   */
  onAgentError(error: string): void {
    if (!this._isRunning) return

    if (this._currentAssistantMsg) {
      this._currentAssistantMsg.content = `Error: ${error}`
      this.history.push(this._currentAssistantMsg)
      this._currentAssistantMsg = null
    }

    this._isRunning = false
    this._pendingConfirm = null

    console.log(`[RemoteChat] onAgentError: agentId=${this.agentId}, error="${error.substring(0, 80)}"`)

    this._callerCallbacks?.onError?.(this.agentId, error)
    this._callerCallbacks = null

    this.emitEvent({ type: 'error', error })
    this.emittedStepIds.clear()
    this.currentMessageStepId = null

    this._runResolve?.()
    this._runResolve = null
  }

  confirmToolCall(
    toolCallId?: string,
    approved = true,
    modifiedArgs?: Record<string, unknown>,
    alwaysAllow?: boolean
  ): boolean {
    if (!this.deps || !this._pendingConfirm) return false
    const id = toolCallId || this._pendingConfirm.toolCallId
    const result = this.deps.agentService.confirmToolCall(
      this.agentId, id, approved, modifiedArgs, alwaysAllow
    )
    this._pendingConfirm = null
    return result
  }

  abort(): boolean {
    if (!this.deps || !this._isRunning) return false
    return this.deps.agentService.abort(this.agentId)
  }

  supplement(message: string): boolean {
    if (!this.deps || !this._isRunning) return false
    return this.deps.agentService.addUserMessage(this.agentId, message)
  }

  clearHistory(): void {
    if (this.deps) {
      this.deps.agentService.cleanupAgent(this.agentId)
    }
    this.agentId = `remote-agent-${uuidv4()}`
    this._tabCreated = false
    this.history = []
    this._pendingConfirm = null
    this._callerCallbacks = null
    this._currentAssistantMsg = null
    this._runResolve = null
    this.emitEvent({ type: 'history_cleared' })
  }

  getAgentStatus(): any {
    if (!this.deps) return null
    return this.deps.agentService.getRunStatus(this.agentId)
  }

  async dispose(): Promise<void> {
    if (this.deps) {
      try { this.deps.agentService.cleanupAgent(this.agentId) } catch { /* ignore */ }
    }
  }

  // ==================== 内部方法 ====================

  private sendToDesktop(channel: string, ...args: any[]) {
    try {
      const mw = this.deps?.mainWindow
      if (mw && !mw.webContents.isDestroyed()) {
        mw.webContents.send(channel, ...args)
      }
    } catch { /* window destroyed */ }
  }
}

// ==================== 单例管理 ====================

let instance: RemoteChatService | null = null

export function getRemoteChatService(): RemoteChatService {
  if (!instance) instance = new RemoteChatService()
  return instance
}
