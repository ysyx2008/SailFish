/**
 * IM Service - 即时通讯平台集成服务
 *
 * 管理钉钉、飞书的连接，将 IM 消息桥接到共享的 RemoteChatService。
 * 所有远程通道（Web、钉钉、飞书）共享同一个会话、PTY 和历史记录。
 *
 * 架构：
 *   IM 平台 ──→ Adapter ──→ IMService.handleMessage()
 *                                   │
 *                          RemoteChatService（共享会话）
 *                                   │
 *                          callbacks 聚合文本 ──→ Adapter.sendMarkdown()
 */

import type {
  IMServiceConfig,
  IMAdapter,
  IMIncomingMessage,
  IMPlatform,
  DingTalkConfig,
  FeishuConfig
} from './types'
import { CONFIRM_KEYWORDS, REJECT_KEYWORDS } from './types'
import { DingTalkAdapter } from './dingtalk-adapter'
import { FeishuAdapter } from './feishu-adapter'
import { RemoteChatService } from '../remote-chat.service'

export interface IMServiceDependencies {
  remoteChatService: RemoteChatService
  mainWindow: {
    webContents: {
      send: (channel: string, ...args: any[]) => void
      isDestroyed: () => boolean
    }
  } | null
}

export interface IMServiceStatus {
  dingtalk: {
    enabled: boolean
    connected: boolean
  }
  feishu: {
    enabled: boolean
    connected: boolean
  }
}

export class IMService {
  private deps: IMServiceDependencies | null = null
  private dingtalkAdapter: DingTalkAdapter | null = null
  private feishuAdapter: FeishuAdapter | null = null
  private config: IMServiceConfig = {
    dingtalk: { enabled: false, clientId: '', clientSecret: '' },
    feishu: { enabled: false, appId: '', appSecret: '' },
    executionMode: 'relaxed',
    sessionTimeoutMinutes: 60,
  }

  /** 便捷访问共享会话服务 */
  private get chat(): RemoteChatService {
    return this.deps!.remoteChatService
  }

  /**
   * 注入依赖
   */
  setDependencies(deps: IMServiceDependencies) {
    this.deps = deps
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
      await this.stopDingTalk()

      this.config.dingtalk = { ...config, enabled: true }
      this.dingtalkAdapter = new DingTalkAdapter(config)

      this.dingtalkAdapter.onMessage = (msg) => this.handleIncomingMessage(msg)
      this.dingtalkAdapter.onConnectionChange = (connected) => {
        this.sendToDesktop('im:connectionChange', { platform: 'dingtalk', connected })
      }

      await this.dingtalkAdapter.start()
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
  }

  getStatus(): IMServiceStatus {
    return {
      dingtalk: {
        enabled: this.config.dingtalk.enabled,
        connected: this.isDingTalkConnected(),
      },
      feishu: {
        enabled: this.config.feishu.enabled,
        connected: this.isFeishuConnected(),
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

    const replyContext = msg.replyContext

    // 检查是否是确认/拒绝操作
    if (this.chat.pendingConfirm) {
      await this.handleConfirmResponse(adapter, replyContext, msg.text)
      return
    }

    // 如果 Agent 正在运行，尝试补充消息（包括 ask_user 的回复）
    if (this.chat.isRunning) {
      try {
        if (this.chat.supplement(msg.text)) {
          await adapter.sendText(replyContext, '💬 已收到你的回复')
        } else {
          await adapter.sendText(replyContext, '⏳ 当前有任务正在执行中，请等待完成后再发送新消息。')
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
        this.chat.clearHistory()
        await adapter.sendText(replyContext, '🗑️ 对话历史已清空')
        return
      }
      if (lowerText === '/status' || lowerText === '状态') {
        const status = this.getSessionStatus()
        await adapter.sendText(replyContext, status)
        return
      }
      if (lowerText === '/help' || lowerText === '帮助') {
        await adapter.sendText(replyContext, this.getHelpText())
        return
      }
    } catch (err) {
      console.error('[IM] Failed to send command reply:', err)
      return
    }

    // 开始 Agent 任务
    await this.runAgentTask(adapter, replyContext, msg)
  }

  /**
   * 处理确认/拒绝回复
   */
  private async handleConfirmResponse(adapter: IMAdapter, replyContext: any, text: string) {
    const lowerText = text.toLowerCase().trim()
    const isApproved = CONFIRM_KEYWORDS.some(kw => lowerText === kw)
    const isRejected = REJECT_KEYWORDS.some(kw => lowerText === kw)

    if (!isApproved && !isRejected) {
      try {
        const pendingConfirm = this.chat.pendingConfirm
        await adapter.sendText(replyContext,
          `请回复「确认」执行或「拒绝」取消。\n\n操作: ${pendingConfirm?.toolName || 'unknown'}`
        )
      } catch (err) {
        console.error('[IM] Failed to send confirm hint:', err)
      }
      return
    }

    const success = this.chat.confirmToolCall(undefined, isApproved)

    try {
      if (success) {
        await adapter.sendText(replyContext,
          isApproved ? '✅ 已批准，继续执行...' : '❌ 已拒绝，操作已取消'
        )
      } else {
        await adapter.sendText(replyContext, '⚠️ 确认操作失败，可能任务已结束')
      }
    } catch (err) {
      console.error('[IM] Failed to send confirm result:', err)
    }
  }

  /**
   * 执行 Agent 任务
   */
  private async runAgentTask(adapter: IMAdapter, replyContext: any, msg: IMIncomingMessage) {
    if (!this.deps) return

    // 发送处理中提示
    try {
      await adapter.sendText(replyContext, '🤔 收到，正在处理...')
    } catch { /* ignore */ }

    // 通知桌面端
    this.sendToDesktop('im:taskStarted', {
      platform: msg.platform,
      userId: msg.userId,
      userName: msg.userName,
      message: msg.text
    })

    // IM 专用：文本缓冲和工具调用去重
    let textBuffer = ''
    const notifiedToolCalls = new Set<string>()

    const flushTextBuffer = async () => {
      if (textBuffer) {
        const text = textBuffer
        textBuffer = ''
        try {
          await adapter.sendMarkdown(replyContext, '旗鱼终端', text)
        } catch (err) {
          console.error('[IM] Failed to send text:', err)
        }
      }
    }

    // 将 IM 平台类型映射为 remoteChannel（显式匹配，避免未来新增平台时默认值错误）
    const channelMap: Record<IMPlatform, 'dingtalk' | 'feishu'> = {
      dingtalk: 'dingtalk',
      feishu: 'feishu'
    }
    const remoteChannel = channelMap[msg.platform]

    try {
      await this.chat.sendMessage(msg.text, {
        onStep: (_agentId: string, step: any) => {
          if (step.type === 'message' && step.content) {
            if (step.isStreaming) {
              // 流式中：只累积，不发送
              textBuffer = step.content
            } else {
              // 流式结束：发送完整消息
              textBuffer = step.content
              flushTextBuffer().catch(() => {})
            }
          } else if (step.type === 'asking' && step.toolArgs) {
            // ask_user 工具：向用户展示问题，等待回复
            flushTextBuffer().catch(() => {})

            const question = step.toolArgs.question || step.content || ''
            const options = step.toolArgs.options as string[] | undefined
            const lines = ['❓ **需要你的回复**', '', question]

            if (options && options.length > 0) {
              lines.push('')
              options.forEach((opt: string, i: number) => {
                lines.push(`${i + 1}. ${opt}`)
              })
              lines.push('', '回复选项编号或直接输入内容。')
            } else {
              lines.push('', '请直接回复你的答案。')
            }

            adapter.sendMarkdown(replyContext, '需要回复', lines.join('\n')).catch(() => {})
          } else if (step.type === 'tool_call' && step.toolName) {
            // ask_user 的工具调用不重复提示（已在 asking 步骤中处理）
            if (step.toolName === 'ask_user') return

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
            adapter.sendText(replyContext,
              `🔧 ${step.toolName}${argsPreview ? '\n' + argsPreview : ''}`
            ).catch(() => {})
          }
        },

        onNeedConfirm: (confirmation: any) => {
          // 先发送缓冲区中的文本
          flushTextBuffer().catch(() => {})

          // 发送确认请求
          const riskEmoji = confirmation.riskLevel === 'dangerous' ? '🔴' : '🟡'
          const argsText = JSON.stringify(confirmation.toolArgs, null, 2)
            .substring(0, 500)

          adapter.sendMarkdown(replyContext, '需要确认', [
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
        },

        onComplete: (_agentId: string, _result: string) => {
          // 发送残留的缓冲文本
          flushTextBuffer().catch(() => {})
          // 任务完成通知
          adapter.sendText(replyContext, '✅ 任务完成').catch(() => {})
          this.sendToDesktop('im:taskComplete', {
            platform: msg.platform,
            userId: msg.userId,
          })
        },

        onError: (_agentId: string, error: string) => {
          // 发送残留的缓冲文本
          flushTextBuffer().catch(() => {})
          adapter.sendText(replyContext, `❌ 执行出错: ${error}`).catch(() => {})
          this.sendToDesktop('im:taskError', {
            platform: msg.platform,
            userId: msg.userId,
            error,
          })
        }
      }, remoteChannel)
    } catch (err: any) {
      // sendMessage 抛异常（如 Agent 正在运行、PTY 创建失败等）
      try {
        await adapter.sendText(replyContext, `❌ ${err.message || 'Unknown error'}`)
      } catch { /* ignore */ }
    }
  }

  // ==================== 工具方法 ====================

  private getAdapter(platform: IMPlatform): IMAdapter | null {
    if (platform === 'dingtalk') return this.dingtalkAdapter
    if (platform === 'feishu') return this.feishuAdapter
    return null
  }

  private getSessionStatus(): string {
    const state = this.chat.getState()
    return [
      `📊 会话状态`,
      `状态: ${state.isRunning ? '执行中' : '空闲'}`,
      `历史消息: ${state.history.length} 条`,
      `终端: ${state.ptyId || '未创建'}`,
      `执行模式: ${state.executionMode}`,
      `钉钉: ${this.isDingTalkConnected() ? '已连接' : '未连接'}`,
      `飞书: ${this.isFeishuConnected() ? '已连接' : '未连接'}`,
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
