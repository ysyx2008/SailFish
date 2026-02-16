/**
 * Remote Chat Service - 远程会话核心服务
 *
 * 统一管理 Web Service 和 IM 集成的共享会话状态。
 * 所有远程通道（Web、钉钉、飞书）共享同一个：
 * - PTY 终端
 * - 对话历史
 * - Agent 运行状态
 *
 * 架构：
 *   Web / IM ──→ RemoteChatService.sendMessage(callbacks)
 *                        │
 *                  agentService.run()
 *                        │
 *             state 更新 + desktop 通知 + 调用方回调
 */

import * as os from 'os'

// ==================== 类型定义 ====================

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  timestamp: number
  steps?: any[]
}

export interface RemoteChatDependencies {
  agentService: {
    run: (ptyId: string, message: string, context: any, config?: any, profileId?: string, workerOptions?: any, callbacks?: any) => Promise<string>
    abort: (ptyId: string) => boolean
    confirmToolCall: (ptyId: string, toolCallId: string, approved: boolean, modifiedArgs?: Record<string, unknown>, alwaysAllow?: boolean) => boolean
    getRunStatus: (ptyId: string) => any
    cleanupAgent: (ptyId: string) => void
    addUserMessage: (ptyId: string, message: string) => boolean
  }
  ptyService: {
    create: (options?: any) => string | Promise<string>
    write: (id: string, data: string) => void
    resize: (id: string, cols: number, rows: number) => void
    dispose: (id: string) => void
    onData: (id: string, callback: (data: string) => void) => () => void
    hasInstance: (id: string) => boolean
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

// 有意义的操作步骤类型（记录到历史 steps 中）
// tool_result 不单独渲染为卡片：tool_call 步骤会被更新（同一 id），
// 结果通过 step_update 回填到已有的 tool_call 卡片中
export const VISIBLE_STEP_TYPES = new Set([
  'tool_call', 'error', 'confirm',
  'plan_created', 'plan_updated', 'plan_archived',
  'asking', 'waiting'
])

// ==================== 核心服务 ====================

export type RemoteChatEventListener = (event: any) => void

export class RemoteChatService {
  private deps: RemoteChatDependencies | null = null
  private ptyId: string | null = null
  private _isRunning = false
  private history: ChatMessage[] = []
  private _pendingConfirm: any | null = null
  private _executionMode: 'strict' | 'relaxed' | 'free' = 'relaxed'
  private ptyUnsubscribe: (() => void) | null = null

  // ---- 事件广播：供 SSE /api/chat/events 端点使用 ----
  private listeners = new Set<RemoteChatEventListener>()
  private emittedStepIds = new Set<string>()
  private currentMessageStepId: string | null = null

  /**
   * 订阅实时事件（返回取消订阅函数）
   */
  subscribe(listener: RemoteChatEventListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private emitEvent(event: any) {
    for (const listener of this.listeners) {
      try { listener(event) } catch { /* ignore */ }
    }
  }

  /**
   * 注入依赖
   */
  setDependencies(deps: RemoteChatDependencies) {
    this.deps = deps
  }

  /**
   * 更新 mainWindow 引用
   */
  setMainWindow(win: RemoteChatDependencies['mainWindow']) {
    if (this.deps) {
      this.deps.mainWindow = win
    }
  }

  /**
   * 读取配置值（代理 configService.get）
   */
  getConfigValue(key: any): any {
    return this.deps?.configService.get(key)
  }

  // ==================== 状态查询 ====================

  getState() {
    return {
      ptyId: this.ptyId,
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
  getPtyId(): string | null { return this.ptyId }

  // ==================== PTY 管理 ====================

  /**
   * 确保 PTY 终端存在，不存在则创建
   */
  async ensurePty(): Promise<string> {
    // 检查现有 PTY 是否仍然存活
    if (this.ptyId) {
      if (this.deps?.ptyService.hasInstance(this.ptyId)) {
        return this.ptyId
      }
      // PTY 已被销毁，清理旧状态
      if (this.ptyUnsubscribe) {
        this.ptyUnsubscribe()
        this.ptyUnsubscribe = null
      }
      this.ptyId = null
    }

    if (!this.deps) throw new Error('Dependencies not set')

    const ptyId = await this.deps.ptyService.create()
    this.ptyId = ptyId

    // 订阅终端输出
    this.ptyUnsubscribe = this.deps.ptyService.onData(ptyId, (_data: string) => {
      // 终端输出可用于 Agent context
    })

    // 通知桌面端创建可见标签页
    this.sendToDesktop('gateway:remoteTabCreated', {
      ptyId,
      title: '📡 Remote Agent',
      type: 'local'
    })

    return ptyId
  }

  // ==================== 核心操作 ====================

  /**
   * 发送消息并运行 Agent
   *
   * @param message 用户消息
   * @param callbacks 通道特定的回调（SSE、IM 等各自处理输出）
   * @param remoteChannel 请求来源通道（desktop/web/dingtalk/feishu）
   * @throws Error 如果 Agent 正在运行或依赖未注入
   */
  async sendMessage(message: string, callbacks?: AgentCallbacks, remoteChannel?: 'desktop' | 'web' | 'dingtalk' | 'feishu'): Promise<void> {
    if (!this.deps) throw new Error('Dependencies not set')
    if (this._isRunning) throw new Error('Agent is already running')

    await this.ensurePty()

    // 通知桌面端：远程任务开始（所有通道统一在此发送，确保 ptyId 有效）
    console.log(`[RemoteDebug][Backend] sendMessage: 发送 gateway:remoteTaskStarted, ptyId=${this.ptyId}, message="${message.trim().substring(0, 60)}"`)
    this.sendToDesktop('gateway:remoteTaskStarted', {
      ptyId: this.ptyId,
      message: message.trim()
    })

    // 添加用户消息到历史
    this.history.push({
      role: 'user',
      content: message.trim(),
      timestamp: Date.now()
    })

    const assistantMsg: ChatMessage = {
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      steps: []
    }

    this._isRunning = true
    this._pendingConfirm = null
    this.emittedStepIds.clear()
    this.currentMessageStepId = null

    // 广播：任务开始（供旁听的 SSE 客户端创建 UI）
    this.emitEvent({ type: 'task_started', message: message.trim() })

    const context = {
      ptyId: this.ptyId!,
      terminalOutput: [],
      systemInfo: {
        os: `${os.type()} ${os.release()}`,
        shell: process.env.SHELL || 'bash'
      },
      terminalType: 'local' as const,
      remoteChannel: remoteChannel || 'desktop' as const,
      hostId: 'local'
    }

    const agentConfig = {
      executionMode: this._executionMode,
      debugMode: this.deps.configService.getAgentDebugMode()
    }

    const activeProfile = this.deps.configService.getActiveAiProfile()
    const profileId = activeProfile?.id

    const agentCallbacks = {
      onStep: (agentId: string, step: any) => {
        const serializedStep = JSON.parse(JSON.stringify(step))

        // 跟踪步骤到历史
        if (VISIBLE_STEP_TYPES.has(step.type)) {
          const idx = assistantMsg.steps!.findIndex((s: any) => s.id === step.id)
          if (idx === -1) {
            assistantMsg.steps!.push(serializedStep)
          } else {
            assistantMsg.steps![idx] = serializedStep
          }
        }

        // 跟踪最终文本内容
        if (step.type === 'message' && step.content && !step.isStreaming) {
          assistantMsg.content = step.content
        }

        // 通知桌面端
        // 仅对非流式 message 更新的步骤打印日志，避免刷屏
        if (step.type !== 'message' || !step.isStreaming) {
          console.log(`[RemoteDebug][Backend] onStep → desktop: type=${step.type}, id=${step.id}, ptyId=${this.ptyId}`)
        }
        this.sendToDesktop('agent:step', {
          agentId,
          ptyId: this.ptyId,
          step: serializedStep
        })

        // 广播 SSE 格式事件（与 Gateway handleChatMessage 输出格式一致）
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
          if (step.type === 'message' && !step.isStreaming) {
            // 流式结束：确保最终内容已发送
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

        // 转发到调用方
        callbacks?.onStep?.(agentId, step)
      },

      onNeedConfirm: (confirmation: any) => {
        this._pendingConfirm = {
          toolCallId: confirmation.toolCallId,
          toolName: confirmation.toolName,
          toolArgs: JSON.parse(JSON.stringify(confirmation.toolArgs)),
          riskLevel: confirmation.riskLevel
        }

        // 通知桌面端
        this.sendToDesktop('agent:needConfirm', {
          agentId: confirmation.agentId,
          ptyId: this.ptyId,
          toolCallId: confirmation.toolCallId,
          toolName: confirmation.toolName,
          toolArgs: JSON.parse(JSON.stringify(confirmation.toolArgs)),
          riskLevel: confirmation.riskLevel
        })

        // 转发到调用方
        callbacks?.onNeedConfirm?.(confirmation)

        // 广播
        this.emitEvent({ type: 'need_confirm', confirmation: this._pendingConfirm })
      },

      onComplete: (agentId: string, result: string) => {
        assistantMsg.content = result
        this.history.push(assistantMsg)
        this._isRunning = false
        this._pendingConfirm = null

        // 通知桌面端
        console.log(`[RemoteDebug][Backend] onComplete → desktop: ptyId=${this.ptyId}, result="${result.substring(0, 60)}"`)
        this.sendToDesktop('agent:complete', {
          agentId,
          ptyId: this.ptyId,
          result
        })

        // 转发到调用方
        callbacks?.onComplete?.(agentId, result)

        // 广播
        this.emitEvent({ type: 'complete', content: result })
        this.emittedStepIds.clear()
        this.currentMessageStepId = null
      },

      onError: (agentId: string, error: string) => {
        assistantMsg.content = `Error: ${error}`
        this.history.push(assistantMsg)
        this._isRunning = false
        this._pendingConfirm = null

        // 通知桌面端
        console.log(`[RemoteDebug][Backend] onError → desktop: ptyId=${this.ptyId}, error="${error.substring(0, 80)}"`)
        this.sendToDesktop('agent:error', {
          agentId,
          ptyId: this.ptyId,
          error
        })

        // 转发到调用方
        callbacks?.onError?.(agentId, error)

        // 广播
        this.emitEvent({ type: 'error', error })
        this.emittedStepIds.clear()
        this.currentMessageStepId = null
      }
    }

    try {
      await this.deps.agentService.run(
        this.ptyId!,
        message.trim(),
        context,
        agentConfig,
        profileId,
        undefined,
        agentCallbacks
      )

      // 后备：如果 onComplete/onError 没被调用
      if (this._isRunning) {
        this._isRunning = false
        if (!assistantMsg.content) assistantMsg.content = 'Done'
        this.history.push(assistantMsg)
        callbacks?.onComplete?.('', assistantMsg.content)
      }
    } catch (err: any) {
      if (this._isRunning) {
        this._isRunning = false
        const errMsg = err.message || 'Unknown error'
        assistantMsg.content = `Error: ${errMsg}`
        this.history.push(assistantMsg)
        callbacks?.onError?.('', errMsg)
      }
    }
  }

  /**
   * 确认工具调用
   */
  confirmToolCall(
    toolCallId?: string,
    approved = true,
    modifiedArgs?: Record<string, unknown>,
    alwaysAllow?: boolean
  ): boolean {
    if (!this.deps || !this.ptyId || !this._pendingConfirm) return false

    const id = toolCallId || this._pendingConfirm.toolCallId
    const result = this.deps.agentService.confirmToolCall(
      this.ptyId, id, approved, modifiedArgs, alwaysAllow
    )
    // 无论成功与否都清除 pendingConfirm：
    // 失败通常意味着 Agent 任务已结束，不应卡在确认状态
    this._pendingConfirm = null
    return result
  }

  /**
   * 中止当前任务
   */
  abort(): boolean {
    if (!this.deps || !this.ptyId || !this._isRunning) return false
    return this.deps.agentService.abort(this.ptyId)
  }

  /**
   * 补充消息（任务执行中追加信息）
   */
  supplement(message: string): boolean {
    if (!this.deps || !this.ptyId || !this._isRunning) return false
    return this.deps.agentService.addUserMessage(this.ptyId, message)
  }

  /**
   * 清空对话历史
   */
  clearHistory(): void {
    if (this.ptyId && this.deps) {
      this.deps.agentService.cleanupAgent(this.ptyId)
    }
    this.history = []
    this._pendingConfirm = null
    this.emitEvent({ type: 'history_cleared' })
  }

  /**
   * 获取 Agent 运行状态
   */
  getAgentStatus(): any {
    if (!this.deps || !this.ptyId) return null
    return this.deps.agentService.getRunStatus(this.ptyId)
  }

  /**
   * 释放资源（应用退出时调用）
   */
  async dispose(): Promise<void> {
    if (this.ptyUnsubscribe) {
      this.ptyUnsubscribe()
      this.ptyUnsubscribe = null
    }
    if (this.ptyId && this.deps) {
      try { this.deps.agentService.cleanupAgent(this.ptyId) } catch { /* ignore */ }
      try { this.deps.ptyService.dispose(this.ptyId) } catch { /* ignore */ }
      this.ptyId = null
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
