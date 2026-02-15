/**
 * IM Service - 即时通讯平台集成服务
 *
 * 统一管理钉钉、飞书的连接和消息处理。
 * 将 IM 用户消息桥接到 Agent 服务，并将 Agent 输出聚合后发回 IM。
 *
 * 架构：
 *   IM 平台 ──→ Adapter ──→ IMService.handleMessage()
 *                                   │
 *                          SessionManager (会话)
 *                                   │
 *                          agentService.run(callbacks)
 *                                   │
 *                          callbacks 聚合文本 ──→ Adapter.sendMarkdown()
 */

import * as os from 'os'
import type {
  IMServiceConfig,
  IMServiceDependencies,
  IMServiceStatus,
  IMAdapter,
  IMIncomingMessage,
  IMSession,
  IMPlatform,
  DingTalkConfig,
  FeishuConfig
} from './types'
import { CONFIRM_KEYWORDS, REJECT_KEYWORDS } from './types'
import { SessionManager } from './session-manager'
import { DingTalkAdapter } from './dingtalk-adapter'
import { FeishuAdapter } from './feishu-adapter'

export class IMService {
  private deps: IMServiceDependencies | null = null
  private sessionManager = new SessionManager()
  private dingtalkAdapter: DingTalkAdapter | null = null
  private feishuAdapter: FeishuAdapter | null = null
  private config: IMServiceConfig = {
    dingtalk: { enabled: false, clientId: '', clientSecret: '' },
    feishu: { enabled: false, appId: '', appSecret: '' },
    executionMode: 'relaxed',
    sessionTimeoutMinutes: 60,
  }

  /**
   * 注入依赖
   */
  setDependencies(deps: IMServiceDependencies) {
    this.deps = deps
    this.sessionManager.setDependencies(deps)
  }

  /**
   * 更新 mainWindow 引用
   */
  setMainWindow(win: IMServiceDependencies['mainWindow']) {
    if (this.deps) {
      this.deps.mainWindow = win
    }
  }

  // ==================== 钉钉管理 ====================

  async startDingTalk(config: DingTalkConfig): Promise<{ success: boolean; error?: string }> {
    if (!config.clientId || !config.clientSecret) {
      return { success: false, error: 'ClientID and ClientSecret are required' }
    }

    try {
      // 停止现有连接
      await this.stopDingTalk()

      this.config.dingtalk = { ...config, enabled: true }
      this.dingtalkAdapter = new DingTalkAdapter(config)

      this.dingtalkAdapter.onMessage = (msg) => this.handleIncomingMessage(msg)
      this.dingtalkAdapter.onConnectionChange = (connected) => {
        this.sendToDesktop('im:connectionChange', { platform: 'dingtalk', connected })
      }

      await this.dingtalkAdapter.start()
      this.sessionManager.startCleanup()
      // 注意：不在此处额外 sendToDesktop，adapter.start() 成功后会触发 onConnectionChange
      console.log('[IM] DingTalk started')
      return { success: true }
    } catch (err: any) {
      console.error('[IM] DingTalk start failed:', err)
      this.dingtalkAdapter = null
      return { success: false, error: err.message || 'Failed to connect' }
    }
  }

  async stopDingTalk(): Promise<void> {
    if (this.dingtalkAdapter) {
      await this.dingtalkAdapter.stop()
      this.dingtalkAdapter = null
      this.config.dingtalk.enabled = false
      this.sendToDesktop('im:connectionChange', { platform: 'dingtalk', connected: false })
      console.log('[IM] DingTalk stopped')
    }
  }

  isDingTalkConnected(): boolean {
    return this.dingtalkAdapter?.isConnected() ?? false
  }

  // ==================== 飞书管理 ====================

  async startFeishu(config: FeishuConfig): Promise<{ success: boolean; error?: string }> {
    if (!config.appId || !config.appSecret) {
      return { success: false, error: 'App ID and App Secret are required' }
    }

    try {
      await this.stopFeishu()

      this.config.feishu = { ...config, enabled: true }
      this.feishuAdapter = new FeishuAdapter(config)

      this.feishuAdapter.onMessage = (msg) => this.handleIncomingMessage(msg)
      this.feishuAdapter.onConnectionChange = (connected) => {
        this.sendToDesktop('im:connectionChange', { platform: 'feishu', connected })
      }

      await this.feishuAdapter.start()
      this.sessionManager.startCleanup()
      // 注意：不在此处额外 sendToDesktop，adapter.start() 成功后会触发 onConnectionChange
      console.log('[IM] Feishu started')
      return { success: true }
    } catch (err: any) {
      console.error('[IM] Feishu start failed:', err)
      this.feishuAdapter = null
      return { success: false, error: err.message || 'Failed to connect' }
    }
  }

  async stopFeishu(): Promise<void> {
    if (this.feishuAdapter) {
      await this.feishuAdapter.stop()
      this.feishuAdapter = null
      this.config.feishu.enabled = false
      this.sendToDesktop('im:connectionChange', { platform: 'feishu', connected: false })
      console.log('[IM] Feishu stopped')
    }
  }

  isFeishuConnected(): boolean {
    return this.feishuAdapter?.isConnected() ?? false
  }

  // ==================== 全局操作 ====================

  async stopAll(): Promise<void> {
    await this.stopDingTalk()
    await this.stopFeishu()
    await this.sessionManager.disposeAll()
  }

  getStatus(): IMServiceStatus {
    return {
      dingtalk: {
        enabled: this.config.dingtalk.enabled,
        connected: this.isDingTalkConnected(),
        activeSessions: this.sessionManager.getActiveCount('dingtalk'),
      },
      feishu: {
        enabled: this.config.feishu.enabled,
        connected: this.isFeishuConnected(),
        activeSessions: this.sessionManager.getActiveCount('feishu'),
      }
    }
  }

  // ==================== 消息处理核心 ====================

  /**
   * 处理 IM 平台来的消息
   */
  private async handleIncomingMessage(msg: IMIncomingMessage) {
    if (!this.deps) {
      console.error('[IM] Dependencies not set, ignoring message')
      return
    }

    const adapter = this.getAdapter(msg.platform)
    if (!adapter) return

    const session = this.sessionManager.getOrCreate(
      msg.platform,
      msg.userId,
      msg.userName,
      msg.chatType,
      msg.chatId,
      msg.replyContext
    )

    // 检查是否是确认/拒绝操作
    if (session.pendingConfirm) {
      await this.handleConfirmResponse(session, adapter, msg.text)
      return
    }

    // 如果 Agent 正在运行，尝试补充消息
    if (session.isRunning) {
      try {
        if (session.ptyId && this.deps.agentService.addUserMessage(session.ptyId, msg.text)) {
          await adapter.sendText(session.replyContext, '💬 补充信息已发送给 Agent')
        } else {
          await adapter.sendText(session.replyContext, '⏳ 当前有任务正在执行中，请等待完成后再发送新消息。')
        }
      } catch (err) {
        console.error('[IM] Failed to send busy reply:', err)
      }
      return
    }

    // 特殊命令处理
    const lowerText = msg.text.toLowerCase().trim()
    try {
      if (lowerText === '/clear' || lowerText === '清空' || lowerText === '清空历史') {
        session.history = []
        await adapter.sendText(session.replyContext, '🗑️ 对话历史已清空')
        return
      }
      if (lowerText === '/status' || lowerText === '状态') {
        const status = this.getSessionStatus(session)
        await adapter.sendText(session.replyContext, status)
        return
      }
      if (lowerText === '/help' || lowerText === '帮助') {
        await adapter.sendText(session.replyContext, this.getHelpText())
        return
      }
    } catch (err) {
      console.error('[IM] Failed to send command reply:', err)
      return
    }

    // 开始 Agent 任务
    await this.runAgentTask(session, adapter, msg.text)
  }

  /**
   * 处理确认/拒绝回复
   */
  private async handleConfirmResponse(session: IMSession, adapter: IMAdapter, text: string) {
    if (!this.deps || !session.pendingConfirm || !session.ptyId) return

    const lowerText = text.toLowerCase().trim()
    const isApproved = CONFIRM_KEYWORDS.some(kw => lowerText === kw)
    const isRejected = REJECT_KEYWORDS.some(kw => lowerText === kw)

    if (!isApproved && !isRejected) {
      try {
        await adapter.sendText(session.replyContext,
          `请回复「确认」执行或「拒绝」取消。\n\n操作: ${session.pendingConfirm.toolName}`
        )
      } catch (err) {
        console.error('[IM] Failed to send confirm hint:', err)
      }
      return
    }

    const toolCallId = session.pendingConfirm.toolCallId

    const success = this.deps.agentService.confirmToolCall(
      session.ptyId, toolCallId, isApproved
    )

    if (success) {
      // 确认成功后才清空 pendingConfirm
      session.pendingConfirm = null
      try {
        await adapter.sendText(session.replyContext,
          isApproved ? '✅ 已批准，继续执行...' : '❌ 已拒绝，操作已取消'
        )
      } catch (err) {
        console.error('[IM] Failed to send confirm result:', err)
      }
    } else {
      // 确认失败也清空，因为对应的 Agent 任务可能已经结束
      session.pendingConfirm = null
      try {
        await adapter.sendText(session.replyContext, '⚠️ 确认操作失败，可能任务已结束')
      } catch (err) {
        console.error('[IM] Failed to send confirm failure:', err)
      }
    }
  }

  /**
   * 执行 Agent 任务
   */
  private async runAgentTask(session: IMSession, adapter: IMAdapter, message: string) {
    if (!this.deps) return

    try {
      // 确保 PTY
      await this.sessionManager.ensurePty(session)
    } catch (err: any) {
      await adapter.sendText(session.replyContext, `❌ 创建终端失败: ${err.message}`)
      return
    }

    // 添加用户消息到历史
    session.history.push({ role: 'user', content: message, timestamp: Date.now() })

    session.isRunning = true
    session.pendingConfirm = null
    session.textBuffer = ''
    session.currentStepId = null

    // 发送处理中提示
    await adapter.sendText(session.replyContext, '🤔 收到，正在处理...')

    // 通知桌面端
    this.sendToDesktop('im:taskStarted', {
      platform: session.platform,
      userId: session.userId,
      userName: session.userName,
      message
    })

    const context = {
      ptyId: session.ptyId!,
      terminalOutput: [],
      systemInfo: {
        os: `${os.type()} ${os.release()}`,
        shell: process.env.SHELL || 'bash'
      },
      terminalType: 'local' as const
    }

    const agentConfig = {
      executionMode: session.executionMode,
      debugMode: this.deps.configService.getAgentDebugMode()
    }

    // 跟踪已通知的工具调用 ID，避免重复通知
    const notifiedToolCalls = new Set<string>()

    /** 发送并清空文本缓冲区 */
    const flushTextBuffer = async () => {
      if (session.textBuffer) {
        const text = session.textBuffer
        session.textBuffer = ''
        try {
          await adapter.sendMarkdown(session.replyContext, '旗鱼终端', text)
        } catch (err) {
          console.error(`[IM] Failed to send text:`, err)
        }
      }
    }

    const callbacks = {
      onStep: (agentId: string, step: any) => {
        if (step.type === 'message' && step.content) {
          if (step.isStreaming) {
            // 流式中：只累积，不发送。等流式结束再一次性发。
            session.textBuffer = step.content
            session.currentStepId = step.id
          } else {
            // 流式结束：发送完整消息
            session.textBuffer = step.content
            flushTextBuffer().catch(() => {})
          }
        } else if (step.type === 'tool_call' && step.toolName) {
          // 去重：同一个工具调用只通知一次
          const toolCallKey = step.id || `${step.toolName}:${JSON.stringify(step.toolArgs || {})}`
          if (notifiedToolCalls.has(toolCallKey)) return
          notifiedToolCalls.add(toolCallKey)

          // 工具调用前，先发送已累积的文本
          flushTextBuffer().catch(() => {})

          // 发送工具调用提示
          const argsPreview = step.toolArgs
            ? JSON.stringify(step.toolArgs).substring(0, 100)
            : ''
          adapter.sendText(session.replyContext,
            `🔧 ${step.toolName}${argsPreview ? '\n' + argsPreview : ''}`
          ).catch(() => {})
        }

        // 推送到桌面端
        try {
          const serializedStep = JSON.parse(JSON.stringify(step))
          this.sendToDesktop('agent:step', {
            agentId,
            ptyId: session.ptyId,
            step: serializedStep
          })
        } catch { /* ignore */ }
      },

      onNeedConfirm: (confirmation: any) => {
        session.pendingConfirm = {
          toolCallId: confirmation.toolCallId,
          toolName: confirmation.toolName,
          toolArgs: JSON.parse(JSON.stringify(confirmation.toolArgs)),
          riskLevel: confirmation.riskLevel,
        }

        // 先发送缓冲区中的文本
        flushTextBuffer().catch(() => {})

        // 发送确认请求
        const riskEmoji = confirmation.riskLevel === 'dangerous' ? '🔴' : '🟡'
        const argsText = JSON.stringify(confirmation.toolArgs, null, 2)
          .substring(0, 500)

        adapter.sendMarkdown(session.replyContext, '需要确认', [
          `${riskEmoji} **需要确认操作**`,
          '',
          `**工具**: ${confirmation.toolName}`,
          `**风险**: ${confirmation.riskLevel}`,
          `**参数**:`,
          '```',
          argsText,
          '```',
          '',
          '回复「确认」执行，或「拒绝」取消。'
        ].join('\n')).catch(() => {})

        // 通知桌面端
        this.sendToDesktop('agent:needConfirm', {
          agentId: confirmation.agentId,
          ptyId: session.ptyId,
          toolCallId: confirmation.toolCallId,
          toolName: confirmation.toolName,
          toolArgs: JSON.parse(JSON.stringify(confirmation.toolArgs)),
          riskLevel: confirmation.riskLevel,
        })
      },

      onComplete: (agentId: string, result: string) => {
        // 发送残留的缓冲文本
        flushTextBuffer().catch(() => {})

        session.isRunning = false
        session.pendingConfirm = null
        session.history.push({ role: 'assistant', content: result, timestamp: Date.now() })

        // 任务完成通知
        adapter.sendText(session.replyContext, '✅ 任务完成').catch(() => {})

        this.sendToDesktop('im:taskComplete', {
          platform: session.platform,
          userId: session.userId,
        })
      },

      onError: (agentId: string, error: string) => {
        // 发送残留的缓冲文本
        flushTextBuffer().catch(() => {})

        session.isRunning = false
        session.pendingConfirm = null
        session.history.push({
          role: 'assistant',
          content: `Error: ${error}`,
          timestamp: Date.now()
        })

        adapter.sendText(session.replyContext, `❌ 执行出错: ${error}`).catch(() => {})

        this.sendToDesktop('im:taskError', {
          platform: session.platform,
          userId: session.userId,
          error,
        })
      }
    }

    try {
      const activeProfile = this.deps.configService.getActiveAiProfile()
      const profileId = activeProfile?.id

      await this.deps.agentService.run(
        session.ptyId!,
        message.trim(),
        context,
        agentConfig,
        profileId,
        undefined,
        callbacks
      )

      // Agent.run() 返回后，仅在 onComplete/onError 未清理的情况下执行后备逻辑
      // （避免与回调中的状态更新重复）
      if (session.isRunning) {
        if (session.textBuffer) {
          await flushTextBuffer()
        }
        session.isRunning = false
        session.pendingConfirm = null
        session.history.push({
          role: 'assistant',
          content: 'Done',
          timestamp: Date.now()
        })
        try {
          await adapter.sendText(session.replyContext, '✅ 任务完成')
        } catch (sendErr) {
          console.error('[IM] Failed to send completion message:', sendErr)
        }
      }
    } catch (err: any) {
      if (session.isRunning) {
        session.isRunning = false
        session.pendingConfirm = null
        const errMsg = err.message || 'Unknown error'
        session.history.push({
          role: 'assistant',
          content: `Error: ${errMsg}`,
          timestamp: Date.now()
        })
        try {
          await adapter.sendText(session.replyContext, `❌ 执行出错: ${errMsg}`)
        } catch (sendErr) {
          console.error('[IM] Failed to send error message:', sendErr)
        }
      }
    } finally {
      // finally 块：无需额外清理，已无定时器
    }
  }

  // ==================== 工具方法 ====================

  private getAdapter(platform: IMPlatform): IMAdapter | null {
    if (platform === 'dingtalk') return this.dingtalkAdapter
    if (platform === 'feishu') return this.feishuAdapter
    return null
  }

  private getSessionStatus(session: IMSession): string {
    return [
      `📊 会话状态`,
      `平台: ${session.platform === 'dingtalk' ? '钉钉' : '飞书'}`,
      `用户: ${session.userName || session.userId}`,
      `状态: ${session.isRunning ? '执行中' : '空闲'}`,
      `历史消息: ${session.history.length} 条`,
      `终端: ${session.ptyId || '未创建'}`,
      `执行模式: ${session.executionMode}`,
    ].join('\n')
  }

  private getHelpText(): string {
    return [
      '🐟 旗鱼终端 - IM 远程助手',
      '',
      '直接发送消息即可与 AI Agent 对话。Agent 可以在本机执行命令、编辑文件等操作。',
      '',
      '特殊命令:',
      '  /help 或 帮助 - 显示此帮助',
      '  /status 或 状态 - 查看会话状态',
      '  /clear 或 清空 - 清空对话历史',
      '',
      '当 Agent 请求确认操作时:',
      '  回复「确认」- 批准执行',
      '  回复「拒绝」- 取消操作',
    ].join('\n')
  }

  private sendToDesktop(channel: string, data: any) {
    try {
      if (this.deps?.mainWindow && !this.deps.mainWindow.webContents.isDestroyed()) {
        this.deps.mainWindow.webContents.send(channel, data)
      }
    } catch { /* ignore */ }
  }
}

// ==================== 单例管理 ====================

let imServiceInstance: IMService | null = null

export function getIMService(): IMService {
  if (!imServiceInstance) {
    imServiceInstance = new IMService()
  }
  return imServiceInstance
}
