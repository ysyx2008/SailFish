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
  IMAttachment,
  DingTalkConfig,
  FeishuConfig,
  SlackConfig,
  TelegramConfig,
  SendFileResult
} from './types'
import { CONFIRM_KEYWORDS, REJECT_KEYWORDS, IM_TEXT_MAX_LENGTH } from './types'
import { DingTalkAdapter } from './dingtalk-adapter'
import { FeishuAdapter } from './feishu-adapter'
import { SlackAdapter } from './slack-adapter'
import { TelegramAdapter } from './telegram-adapter'
import { RemoteChatService } from '../remote-chat.service'
import { t } from '../agent/i18n'

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
  slack: {
    enabled: boolean
    connected: boolean
  }
  telegram: {
    enabled: boolean
    connected: boolean
  }
}

/** 最近一次 IM 联系的上下文，用于主动推送 */
export interface IMLastContact {
  platform: IMPlatform
  replyContext: any
  userId: string
  userName: string
  chatId?: string
  chatType: 'single' | 'group'
  updatedAt: number
}

/** 工具 → 图标 */
const TOOL_ICONS: Record<string, string> = {
  execute_command: '🔧', read_file: '📄', edit_file: '✏️',
  write_local_file: '📝', write_remote_file: '📝', file_search: '🔍',
  search_knowledge: '📚', get_knowledge_doc: '📚',
  recall_task: '🧠', deep_recall: '🧠', wait: '⏳',
  create_plan: '📋', update_plan: '📋', clear_plan: '📋',
  send_file_to_chat: '📤', send_image_to_chat: '🖼️', send_im_notification: '📢',
  remember_info: '💾', check_terminal_status: '🖥️', get_terminal_context: '🖥️',
  send_control_key: '⌨️', send_input: '⌨️', load_skill: '📦', load_user_skill: '📦',
}

/** 工具 → 已有 i18n key 的映射（复用已有翻译，避免重复添加） */
const TOOL_I18N_MAP: Record<string, Parameters<typeof t>[0]> = {
  execute_command: 'tool.execute_command',
  check_terminal_status: 'tool.check_terminal_status',
  get_terminal_context: 'tool.get_terminal_context',
  send_control_key: 'tool.send_control_key',
  send_input: 'tool.send_input',
  read_file: 'tool.read_file',
  edit_file: 'file.edit',
  write_local_file: 'tool.write_file',
  write_remote_file: 'tool.write_file',
  file_search: 'file.searching',
  remember_info: 'tool.remember_info',
  search_knowledge: 'tool.search_knowledge',
  get_knowledge_doc: 'tool.get_knowledge_doc',
  recall_task: 'memory.task_recall',
  deep_recall: 'memory.deep_recall',
  wait: 'tool.wait',
  create_plan: 'tool.create_plan',
  update_plan: 'tool.update_plan',
  clear_plan: 'tool.clear_plan',
  ask_user: 'tool.ask_user',
}

/**
 * 将工具调用格式化为用户友好的通知文本
 * 通过映射复用 i18n 已有翻译，无匹配时 fallback 到 toolName
 */
function formatToolNotification(toolName: string, toolArgs?: Record<string, unknown>): string {
  const icon = TOOL_ICONS[toolName] || '🔧'
  const i18nKey = TOOL_I18N_MAP[toolName]
  const label = i18nKey ? t(i18nKey) : toolName

  // 根据工具类型附加关键参数
  let detail = ''
  if (toolName === 'execute_command') {
    const cmd = toolArgs?.command ? String(toolArgs.command) : ''
    detail = cmd ? `\n$ ${cmd.length > 200 ? cmd.substring(0, 200) + '...' : cmd}` : ''
  } else if (toolArgs?.path) {
    detail = `  ${toolArgs.path}`
  } else if (toolName === 'file_search' && (toolArgs?.pattern || toolArgs?.query)) {
    detail = `  ${toolArgs.pattern || toolArgs.query}`
  } else if ((toolName === 'load_skill' || toolName === 'load_user_skill') && (toolArgs?.skill_id || toolArgs?.name)) {
    detail = `  ${toolArgs.skill_id || toolArgs.name}`
  } else if (toolName === 'send_control_key' && toolArgs?.key) {
    detail = ` ${toolArgs.key}`
  } else if (toolName === 'wait' && toolArgs?.seconds) {
    detail = ` ${toolArgs.seconds}s`
  }

  return `${icon} ${label}${detail}`
}

export class IMService {
  private deps: IMServiceDependencies | null = null
  private dingtalkAdapter: DingTalkAdapter | null = null
  private feishuAdapter: FeishuAdapter | null = null
  private slackAdapter: SlackAdapter | null = null
  private telegramAdapter: TelegramAdapter | null = null
  private config: IMServiceConfig = {
    dingtalk: { enabled: false, clientId: '', clientSecret: '' },
    feishu: { enabled: false, appId: '', appSecret: '' },
    slack: { enabled: false, botToken: '', appToken: '' },
    telegram: { enabled: false, botToken: '' },
    executionMode: 'relaxed',
    sessionTimeoutMinutes: 60,
  }

  /** 当前活跃的 IM 会话上下文（Agent 运行期间有效） */
  private activeSession: { adapter: IMAdapter; replyContext: any } | null = null

  /** 最近一次联系 AI 的 IM 渠道上下文（用于主动推送） */
  private lastContact: IMLastContact | null = null

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

  /**
   * 设置 Agent 执行模式（同步到 RemoteChatService）
   */
  setExecutionMode(mode: 'strict' | 'relaxed' | 'free') {
    this.config.executionMode = mode
    this.chat.executionMode = mode
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

  // ==================== Slack 管理 ====================

  async startSlack(config: SlackConfig): Promise<{ success: boolean; error?: string }> {
    if (!config.botToken || !config.appToken) {
      return { success: false, error: 'Bot Token and App Token are required' }
    }
    if (!config.botToken.startsWith('xoxb-')) {
      return { success: false, error: 'Invalid Bot Token format (must start with xoxb-)' }
    }
    if (!config.appToken.startsWith('xapp-')) {
      return { success: false, error: 'Invalid App Token format (must start with xapp-)' }
    }

    try {
      await this.stopSlack()

      this.config.slack = { ...config, enabled: true }
      this.slackAdapter = new SlackAdapter(config)

      this.slackAdapter.onMessage = (msg: IMIncomingMessage) => this.handleIncomingMessage(msg)
      this.slackAdapter.onConnectionChange = (connected: boolean) => {
        this.sendToDesktop('im:connectionChange', { platform: 'slack', connected })
      }

      await this.slackAdapter.start()
      console.log('[IM] Slack started')
      return { success: true }
    } catch (err: any) {
      console.error('[IM] Slack start failed:', err)
      this.slackAdapter = null
      return { success: false, error: err.message || 'Failed to connect' }
    }
  }

  async stopSlack(): Promise<void> {
    if (this.slackAdapter) {
      await this.slackAdapter.stop()
      this.slackAdapter = null
      this.config.slack.enabled = false
      this.sendToDesktop('im:connectionChange', { platform: 'slack', connected: false })
      console.log('[IM] Slack stopped')
    }
  }

  isSlackConnected(): boolean {
    return this.slackAdapter?.isConnected() ?? false
  }

  // ==================== Telegram 管理 ====================

  async startTelegram(config: TelegramConfig): Promise<{ success: boolean; error?: string }> {
    if (!config.botToken) {
      return { success: false, error: 'Bot Token is required' }
    }
    if (!/^\d+:.+$/.test(config.botToken)) {
      return { success: false, error: 'Invalid Bot Token format (expected: 123456:ABC-DEF...)' }
    }

    try {
      await this.stopTelegram()

      this.config.telegram = { ...config, enabled: true }
      this.telegramAdapter = new TelegramAdapter(config)

      this.telegramAdapter.onMessage = (msg: IMIncomingMessage) => this.handleIncomingMessage(msg)
      this.telegramAdapter.onConnectionChange = (connected: boolean) => {
        this.sendToDesktop('im:connectionChange', { platform: 'telegram', connected })
      }

      await this.telegramAdapter.start()
      console.log('[IM] Telegram started')
      return { success: true }
    } catch (err: any) {
      console.error('[IM] Telegram start failed:', err)
      this.telegramAdapter = null
      return { success: false, error: err.message || 'Failed to connect' }
    }
  }

  async stopTelegram(): Promise<void> {
    if (this.telegramAdapter) {
      await this.telegramAdapter.stop()
      this.telegramAdapter = null
      this.config.telegram.enabled = false
      this.sendToDesktop('im:connectionChange', { platform: 'telegram', connected: false })
      console.log('[IM] Telegram stopped')
    }
  }

  isTelegramConnected(): boolean {
    return this.telegramAdapter?.isConnected() ?? false
  }

  // ==================== 全局操作 ====================

  async stopAll(): Promise<void> {
    await this.stopDingTalk()
    await this.stopFeishu()
    await this.stopSlack()
    await this.stopTelegram()
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
      },
      slack: {
        enabled: this.config.slack.enabled,
        connected: this.isSlackConnected(),
      },
      telegram: {
        enabled: this.config.telegram.enabled,
        connected: this.isTelegramConnected(),
      }
    }
  }

  // ==================== 主动推送 ====================

  /**
   * 获取最近联系 AI 的 IM 渠道信息
   */
  getLastContact(): IMLastContact | null {
    return this.lastContact
  }

  /**
   * 主动向最近联系 AI 的 IM 渠道发送通知消息
   *
   * @param text   消息内容
   * @param options.markdown  是否以 Markdown 格式发送（默认 false）
   * @param options.title     Markdown 模式下的标题（默认 '通知'）
   */
  async sendNotification(
    text: string,
    options?: { markdown?: boolean; title?: string }
  ): Promise<{ success: boolean; platform?: IMPlatform; error?: string }> {
    if (!text || typeof text !== 'string') {
      return { success: false, error: t('im.notification_empty') }
    }

    if (!this.lastContact) {
      return { success: false, error: t('im.notification_no_contact') }
    }

    const { platform, replyContext } = this.lastContact
    const adapter = this.getAdapter(platform)

    if (!adapter) {
      return { success: false, error: t('im.notification_no_adapter', { platform }) }
    }

    if (!adapter.isConnected()) {
      return { success: false, error: t('im.notification_not_connected', { platform }) }
    }

    // 截断过长文本（adapter 内部也有截断，此处做防御性限制）
    const truncated = text.length > IM_TEXT_MAX_LENGTH
      ? text.substring(0, IM_TEXT_MAX_LENGTH - 20) + t('im.text_truncated')
      : text

    try {
      if (options?.markdown) {
        await adapter.sendMarkdown(replyContext, options.title || t('im.notification_title'), truncated)
      } else {
        await adapter.sendText(replyContext, truncated)
      }
      console.log(`[IM] Proactive notification sent via ${platform}`)
      return { success: true, platform }
    } catch (err: any) {
      console.error(`[IM] Failed to send proactive notification via ${platform}:`, err)
      return { success: false, platform, error: err.message || 'Unknown error' }
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

    // 记录最近联系的渠道，用于后续主动推送
    this.lastContact = {
      platform: msg.platform,
      replyContext: msg.replyContext,
      userId: msg.userId,
      userName: msg.userName,
      chatId: msg.chatId,
      chatType: msg.chatType,
      updatedAt: Date.now(),
    }

    const replyContext = msg.replyContext

    // 构建完整消息文本（含附件信息）
    const fullMessage = this.buildAgentMessage(msg)

    // 检查是否是确认/拒绝操作（仅对纯文本消息生效）
    if (this.chat.pendingConfirm && !msg.attachments?.length) {
      await this.handleConfirmResponse(adapter, replyContext, msg.text)
      return
    }

    // 如果 Agent 正在运行，尝试补充消息（包括 ask_user 的回复）
    if (this.chat.isRunning) {
      try {
        if (this.chat.supplement(fullMessage)) {
          await adapter.sendText(replyContext, t('im.reply_received'))
        } else {
          await adapter.sendText(replyContext, t('im.reply_busy'))
        }
      } catch (err) {
        console.error('[IM] Failed to send busy reply:', err)
      }
      return
    }

    // 特殊命令处理（仅对纯文本消息、无附件时生效）
    if (!msg.attachments?.length) {
      const lowerText = msg.text.toLowerCase().trim()
      try {
        if (lowerText === '/clear' || lowerText === '清空' || lowerText === '清空历史' || lowerText === 'clear') {
          this.chat.clearHistory()
          await adapter.sendText(replyContext, t('im.history_cleared'))
          return
        }
        if (lowerText === '/status' || lowerText === '状态' || lowerText === 'status') {
          const status = this.getSessionStatus()
          await adapter.sendText(replyContext, status)
          return
        }
        if (lowerText === '/help' || lowerText === '帮助' || lowerText === 'help') {
          await adapter.sendText(replyContext, this.getHelpText())
          return
        }
      } catch (err) {
        console.error('[IM] Failed to send command reply:', err)
        return
      }
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
          t('im.confirm_hint', { toolName: pendingConfirm?.toolName || 'unknown' })
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
          isApproved ? t('im.confirmed') : t('im.rejected')
        )
      } else {
        await adapter.sendText(replyContext, t('im.confirm_failed'))
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

    // 设置当前活跃会话（供 send_file_to_chat 工具使用）
    this.activeSession = { adapter, replyContext }

    // 构建完整消息文本（含附件路径信息）
    const fullMessage = this.buildAgentMessage(msg)

    // 发送处理中提示
    try {
      await adapter.sendText(replyContext, t('im.processing'))
    } catch { /* ignore */ }

    // 通知桌面端
    this.sendToDesktop('im:taskStarted', {
      platform: msg.platform,
      userId: msg.userId,
      userName: msg.userName,
      message: fullMessage
    })

    // IM 专用：文本缓冲和工具调用去重
    let textBuffer = ''
    let hasSentText = false
    const notifiedToolCalls = new Set<string>()

    // 发送队列：序列化所有 IM 消息发送，防止并发导致消息乱序
    let sendQueue: Promise<void> = Promise.resolve()
    const enqueueSend = (fn: () => Promise<void>): void => {
      sendQueue = sendQueue.then(() => fn().catch(err => {
        console.error('[IM] Send queue error:', err)
      }))
    }

    const flushTextBuffer = async () => {
      if (textBuffer) {
        hasSentText = true
        const text = textBuffer
        textBuffer = ''
        try {
          await adapter.sendMarkdown(replyContext, '旗鱼', text)
        } catch (err) {
          console.error('[IM] Failed to send text:', err)
        }
      }
    }

    // 将 IM 平台类型映射为 remoteChannel（显式匹配，避免未来新增平台时默认值错误）
    const channelMap: Record<IMPlatform, 'dingtalk' | 'feishu' | 'slack' | 'telegram'> = {
      dingtalk: 'dingtalk',
      feishu: 'feishu',
      slack: 'slack',
      telegram: 'telegram',
    }
    const remoteChannel = channelMap[msg.platform]

    try {
      await this.chat.sendMessage(fullMessage, {
        onStep: (_agentId: string, step: any) => {
          if (step.type === 'message' && step.content) {
            if (step.isStreaming) {
              // 流式中：只累积，不发送
              textBuffer = step.content
            } else {
              // 流式结束：发送完整消息
              textBuffer = step.content
              enqueueSend(() => flushTextBuffer())
            }
          } else if (step.type === 'asking' && step.toolArgs) {
            // ask_user 工具：去重（updateStep 轮询更新剩余时间会反复触发 onStep）
            const askKey = step.id || `asking:${step.toolArgs.question}`
            if (notifiedToolCalls.has(askKey)) return
            notifiedToolCalls.add(askKey)

            // 先发送缓冲文本，再展示问题（避免乱序）
            const sendAsk = async () => {
              await flushTextBuffer()

              const question = step.toolArgs.question || step.content || ''
              const options = step.toolArgs.options as string[] | undefined
              const lines = [t('im.need_reply'), '', question]

              if (options && options.length > 0) {
                lines.push('')
                options.forEach((opt: string, i: number) => {
                  lines.push(`${i + 1}. ${opt}`)
                })
                lines.push('', t('im.need_reply_select'))
              } else {
                lines.push('', t('im.need_reply_input'))
              }

              try {
                await adapter.sendMarkdown(replyContext, t('im.need_reply_title'), lines.join('\n'))
              } catch { /* ignore */ }
            }
            enqueueSend(sendAsk)
          } else if (step.type === 'tool_call' && step.toolName) {
            // ask_user 的工具调用不重复提示（已在 asking 步骤中处理）
            if (step.toolName === 'ask_user') return

            // 去重：同一个工具调用只通知一次
            const toolCallKey = step.id || `${step.toolName}:${JSON.stringify(step.toolArgs || {})}`
            if (notifiedToolCalls.has(toolCallKey)) return
            notifiedToolCalls.add(toolCallKey)

            // 先发送缓冲文本，再发工具通知（避免乱序）
            const sendToolNotify = async () => {
              await flushTextBuffer()
              try {
                await adapter.sendText(replyContext,
                  formatToolNotification(step.toolName, step.toolArgs as Record<string, unknown>))
              } catch { /* ignore */ }
            }
            enqueueSend(sendToolNotify)
          }
        },

        onNeedConfirm: (confirmation: any) => {
          // 先发送缓冲区中的文本，再发送确认卡片（避免乱序）
          const sendConfirm = async () => {
            await flushTextBuffer()
            const riskEmoji = confirmation.riskLevel === 'dangerous' ? '🔴' : '🟡'
            const argsText = JSON.stringify(confirmation.toolArgs, null, 2)
              .substring(0, 500)

            try {
              await adapter.sendMarkdown(replyContext, t('im.need_confirm'), [
                t('im.need_confirm_title', { riskEmoji }),
                '',
                t('im.need_confirm_tool', { toolName: confirmation.toolName }),
                t('im.need_confirm_risk', { riskLevel: confirmation.riskLevel }),
                t('im.need_confirm_args'),
                '```',
                argsText,
                '```',
                '',
                t('im.need_confirm_action'),
              ].join('\n'))
            } catch { /* ignore */ }
          }
          enqueueSend(sendConfirm)
        },

        onComplete: (_agentId: string, _result: string) => {
          // 先发送残留文本，再决定是否发完成通知（避免乱序和冗余）
          const finish = async () => {
            await flushTextBuffer()
            // 已发送过文本回复时，不再单独发完成通知（避免冗余）
            if (!hasSentText) {
              try {
                await adapter.sendText(replyContext, t('im.task_complete'))
              } catch { /* ignore */ }
            }
          }
          enqueueSend(finish)
          this.sendToDesktop('im:taskComplete', {
            platform: msg.platform,
            userId: msg.userId,
          })
        },

        onError: (_agentId: string, error: string) => {
          // 先发送残留文本，再发送错误提示（避免乱序）
          const finish = async () => {
            await flushTextBuffer()
            try {
              await adapter.sendText(replyContext, t('im.task_error', { error }))
            } catch { /* ignore */ }
          }
          enqueueSend(finish)
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
    } finally {
      // 等待发送队列中所有消息发送完毕，再清理会话
      try { await sendQueue } catch { /* ignore */ }
      this.activeSession = null
    }
  }

  // ==================== 文件发送（供 Agent 工具调用） ====================

  /**
   * 为当前活跃的 IM 会话发送文件
   * 仅在 Agent 通过 IM 通道运行时可用
   */
  async sendFileForCurrentSession(filePath: string, fileName?: string): Promise<SendFileResult> {
    if (!this.activeSession) {
      return { success: false, error: 'No active IM session' }
    }

    try {
      await this.activeSession.adapter.sendFile(
        this.activeSession.replyContext,
        filePath,
        fileName
      )
      return { success: true }
    } catch (err: any) {
      console.error('[IM] Failed to send file:', err)
      return { success: false, error: err.message || 'Failed to send file' }
    }
  }

  /**
   * 为当前活跃的 IM 会话发送图片（内联显示）
   * 仅在 Agent 通过 IM 通道运行时可用
   */
  async sendImageForCurrentSession(filePath: string): Promise<SendFileResult> {
    if (!this.activeSession) {
      return { success: false, error: 'No active IM session' }
    }

    try {
      await this.activeSession.adapter.sendImage(
        this.activeSession.replyContext,
        filePath
      )
      return { success: true }
    } catch (err: any) {
      console.error('[IM] Failed to send image:', err)
      return { success: false, error: err.message || 'Failed to send image' }
    }
  }

  /**
   * 当前是否有活跃的 IM 会话
   */
  hasActiveSession(): boolean {
    return this.activeSession !== null
  }

  // ==================== 工具方法 ====================

  /**
   * 将消息文本和附件信息组装为传给 Agent 的完整消息
   * 包含文件路径和处理指引，帮助 Agent 正确处理不同类型的文件
   */
  private buildAgentMessage(msg: IMIncomingMessage): string {
    let text = msg.text || ''

    if (msg.attachments && msg.attachments.length > 0) {
      const BINARY_TYPES = new Set<IMAttachment['type']>(['image', 'audio', 'video'])

      const typeI18nKeys: Record<IMAttachment['type'], Parameters<typeof t>[0]> = {
        image: 'im.attachment_image',
        audio: 'im.attachment_audio',
        video: 'im.attachment_video',
        file: 'im.attachment_file',
      }

      const fileDescriptions = msg.attachments.map(a => {
        const isBinary = BINARY_TYPES.has(a.type)
        const typeLabel = t(typeI18nKeys[a.type] || 'im.attachment_file')
        let desc = `- [${typeLabel}] ${a.fileName} → ${a.localPath}`
        if (isBinary) {
          desc += t('im.attachment_binary_warn')
        }
        return desc
      })

      const hasBinary = msg.attachments.some(a => BINARY_TYPES.has(a.type))
      const guidance = hasBinary ? t('im.attachment_binary_guidance') : ''

      const fileList = fileDescriptions.join('\n')

      if (text) {
        text += `\n\n${t('im.attachment_sent')}\n${fileList}${guidance}`
      } else {
        text = `${t('im.attachment_sent_only')}\n${fileList}${guidance}${t('im.attachment_help_hint')}`
      }
    }

    return text
  }

  private getAdapter(platform: IMPlatform): IMAdapter | null {
    if (platform === 'dingtalk') return this.dingtalkAdapter
    if (platform === 'feishu') return this.feishuAdapter
    if (platform === 'slack') return this.slackAdapter
    if (platform === 'telegram') return this.telegramAdapter
    return null
  }

  private getSessionStatus(): string {
    const state = this.chat.getState()
    const connected = (name: string, isConn: boolean) =>
      `${name}: ${isConn ? '✅' : '❌'}`

    return [
      t('im.status_title'),
      `${t('im.status_state')}: ${state.isRunning ? t('im.status_running') : t('im.status_idle')}`,
      `${t('im.status_history')}: ${t('im.status_history_count', { count: state.history.length })}`,
      `${t('im.status_terminal')}: ${state.ptyId || t('im.status_terminal_none')}`,
      `${t('im.status_exec_mode')}: ${state.executionMode}`,
      connected('DingTalk', this.isDingTalkConnected()),
      connected('Feishu', this.isFeishuConnected()),
      connected('Slack', this.isSlackConnected()),
      connected('Telegram', this.isTelegramConnected()),
    ].join('\n')
  }

  private getHelpText(): string {
    return [
      t('im.help_title'),
      '',
      t('im.help_desc'),
      '',
      t('im.help_commands'),
      t('im.help_cmd_help'),
      t('im.help_cmd_status'),
      t('im.help_cmd_clear'),
      '',
      t('im.help_confirm'),
      t('im.help_confirm_approve'),
      t('im.help_confirm_reject'),
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
