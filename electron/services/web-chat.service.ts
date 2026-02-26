/**
 * Web Chat Service - Web 远程会话服务
 *
 * 管理通过 Gateway HTTP 端点发起的 Web 会话。
 * 后端直驱 Agent 执行，前端仅渲染；SSE 实时推送事件给 Web 客户端。
 *
 * 架构：
 *   Web 客户端 ──→ GatewayService ──→ WebChatService.sendMessage()
 *                                              │
 *                              后端直接调用 agentService.runAssistant()
 *                                              │
 *                          IPC 推送到桌面前端渲染 + SSE 推送到 Web 客户端
 */

import * as os from 'os'
import { v4 as uuidv4 } from 'uuid'
import { createLogger } from '../utils/logger'

const log = createLogger('WebChat')

// ==================== 类型定义 ====================

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  timestamp: number
  steps?: any[]
}

export interface WebChatDependencies {
  agentService: {
    runAssistant: (agentId: string, userMessage: string, context: any, config?: any, profileId?: string, callbacks?: any) => Promise<string>
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

export type WebChatEventListener = (event: any) => void

export class WebChatService {
  private deps: WebChatDependencies | null = null
  private agentId: string = `remote-agent-${uuidv4()}`
  private _isRunning = false
  private history: ChatMessage[] = []
  private _pendingConfirm: any | null = null
  private _executionMode: 'strict' | 'relaxed' | 'free' = 'relaxed'
  private _tabCreated = false

  private _callerCallbacks: AgentCallbacks | null = null
  private _currentAssistantMsg: ChatMessage | null = null

  // ---- 事件广播：供 SSE /api/chat/events 端点使用 ----
  private listeners = new Set<WebChatEventListener>()
  private emittedStepIds = new Set<string>()
  private currentMessageStepId: string | null = null

  subscribe(listener: WebChatEventListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private emitEvent(event: any) {
    for (const listener of this.listeners) {
      try { listener(event) } catch { /* ignore */ }
    }
  }

  setDependencies(deps: WebChatDependencies) {
    this.deps = deps
  }

  setMainWindow(win: WebChatDependencies['mainWindow']) {
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
        title: '📡 远程对话'
      })
    }
  }

  /**
   * 发送消息：后端直驱 Agent 执行，不依赖前端转发
   *
   * 执行流程：
   * 1. 通知前端创建 tab + 显示任务开始
   * 2. 直接调用 agentService.runAssistant
   * 3. 通过回调将事件推送到前端（IPC）和 SSE 订阅者
   */
  async sendMessage(message: string, callbacks?: AgentCallbacks, remoteChannel?: 'desktop' | 'web' | 'dingtalk' | 'feishu' | 'slack' | 'telegram' | 'wecom'): Promise<void> {
    if (!this.deps) throw new Error('Dependencies not set')
    if (this._isRunning) throw new Error('Agent is already running')

    this.ensureDesktopTab()

    const remoteChannelValue = remoteChannel || 'desktop'
    log.info(`sendMessage: agentId=${this.agentId}, remoteChannel=${remoteChannelValue}, message="${message.trim().substring(0, 60)}"`)

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

    // 通知前端显示任务开始（前端仅设置 running 状态，不驱动执行）
    this.sendToDesktop('gateway:remoteTaskStarted', {
      agentId: this.agentId,
      message: message.trim(),
      remoteChannel: remoteChannelValue
    })

    // 后端直驱 Agent
    const context = {
      terminalOutput: [] as string[],
      systemInfo: { os: process.platform, shell: process.env.SHELL || '/bin/bash' },
      terminalType: 'local' as const,
      cwd: os.homedir(),
      remoteChannel: remoteChannelValue
    }

    const debugMode = this.deps.configService.getAgentDebugMode()

    const agentCallbacks = {
      onStep: (_runId: string, step: any) => {
        this.onAgentStep(step)
        this.sendToDesktop('agent:step', {
          agentId: this.agentId,
          step: JSON.parse(JSON.stringify(step))
        })
      },
      onNeedConfirm: (confirmation: any) => {
        this.sendToDesktop('agent:needConfirm', {
          agentId: this.agentId,
          toolCallId: confirmation.toolCallId,
          toolName: confirmation.toolName,
          toolArgs: JSON.parse(JSON.stringify(confirmation.toolArgs)),
          riskLevel: confirmation.riskLevel
        })
      },
      onComplete: (_runId: string, result: string, pendingUserMessages?: string[]) => {
        this.onAgentComplete(result)
        this.sendToDesktop('agent:complete', { agentId: this.agentId, result, pendingUserMessages })
      },
      onError: (_runId: string, error: string) => {
        this.onAgentError(error)
        this.sendToDesktop('agent:error', { agentId: this.agentId, error })
      }
    }

    try {
      await this.deps.agentService.runAssistant(
        this.agentId,
        message.trim(),
        context,
        {
          enabled: true,
          commandTimeout: 30000,
          autoExecuteSafe: true,
          autoExecuteModerate: true,
          executionMode: this._executionMode,
          debugMode
        },
        undefined,
        agentCallbacks
      )
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      if (this._isRunning) {
        this.onAgentError(errorMsg)
        this.sendToDesktop('agent:error', { agentId: this.agentId, error: errorMsg })
      }
    }
  }

  /**
   * Agent 步骤事件处理：更新内部状态 + 广播 SSE + 转发给调用方回调
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
   * Agent 执行完成
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

    log.info(`onAgentComplete: agentId=${this.agentId}, result="${result.substring(0, 60)}"`)

    this._callerCallbacks?.onComplete?.(this.agentId, result)
    this._callerCallbacks = null

    this.emitEvent({ type: 'complete', content: result })
    this.emittedStepIds.clear()
    this.currentMessageStepId = null
  }

  /**
   * Agent 执行出错
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

    log.info(`onAgentError: agentId=${this.agentId}, error="${error.substring(0, 80)}"`)

    this._callerCallbacks?.onError?.(this.agentId, error)
    this._callerCallbacks = null

    this.emitEvent({ type: 'error', error })
    this.emittedStepIds.clear()
    this.currentMessageStepId = null
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

let instance: WebChatService | null = null

export function getWebChatService(): WebChatService {
  if (!instance) instance = new WebChatService()
  return instance
}
