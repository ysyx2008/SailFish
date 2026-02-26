/**
 * IM Service - 即时通讯平台集成服务
 *
 * 管理钉钉、飞书的连接，将 IM 消息路由到 Companion Agent。
 * IM 对话与觉醒唤醒、桌面助手共用同一个 Agent 会话，保持连贯上下文。
 *
 * 架构：
 *   IM 平台 ──→ Adapter ──→ IMService.handleMessage()
 *                                   │
 *                          AgentService.runAssistant(COMPANION_AGENT_ID)
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
  WeComConfig,
  SendFileResult
} from './types'
import { CONFIRM_KEYWORDS, REJECT_KEYWORDS, IM_TEXT_MAX_LENGTH } from './types'
import { DingTalkAdapter } from './dingtalk-adapter'
import { FeishuAdapter } from './feishu-adapter'
import { SlackAdapter } from './slack-adapter'
import { TelegramAdapter } from './telegram-adapter'
import { WeComAdapter } from './wecom-adapter'
import { AgentService } from '../agent'
import { getConfigService } from '../config.service'
import { t } from '../agent/i18n'
import { createLogger } from '../../utils/logger'

const log = createLogger('IMService')

export interface IMServiceDependencies {
  agentService: import('../agent').AgentService
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
  wecom: {
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
  private static readonly CONTACT_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

  private deps: IMServiceDependencies | null = null
  private dingtalkAdapter: DingTalkAdapter | null = null
  private feishuAdapter: FeishuAdapter | null = null
  private slackAdapter: SlackAdapter | null = null
  private telegramAdapter: TelegramAdapter | null = null
  private wecomAdapter: WeComAdapter | null = null
  private config: IMServiceConfig = {
    dingtalk: { enabled: false, clientId: '', clientSecret: '' },
    feishu: { enabled: false, appId: '', appSecret: '' },
    slack: { enabled: false, botToken: '', appToken: '' },
    telegram: { enabled: false, botToken: '' },
    wecom: { enabled: false, corpId: '', corpSecret: '', agentId: 0, token: '', encodingAESKey: '', callbackPort: 3722 },
    executionMode: 'relaxed',
    sessionTimeoutMinutes: 60,
  }

  /** 当前活跃的 IM 会话上下文（Agent 运行期间有效） */
  private activeSession: { adapter: IMAdapter; replyContext: any } | null = null

  /** 最近一次联系 AI 的 IM 渠道上下文（用于主动推送） */
  private lastContact: IMLastContact | null = null
  /** 各平台最近一次联系记录（持久化） */
  private contactsByPlatform: Partial<Record<IMPlatform, IMLastContact>> = {}

  constructor() {
    this.loadPersistedContacts()
    this.lastContact = this.pickMostRecentContact(this.contactsByPlatform)
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
   * 设置 Agent 执行模式
   */
  setExecutionMode(mode: 'strict' | 'relaxed' | 'free') {
    this.config.executionMode = mode
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
      log.info('DingTalk started')
      return { success: true }
    } catch (err: any) {
      log.error('DingTalk start failed:', err)
      this.dingtalkAdapter = null
      return { success: false, error: err.message || 'Failed to connect' }
    }
  }

  async stopDingTalk(): Promise<void> {
    if (this.dingtalkAdapter) {
      await this.dingtalkAdapter.stop() // adapter.stop() 内已触发 onConnectionChange(false)，无需再 sendToDesktop
      this.dingtalkAdapter = null
      this.config.dingtalk.enabled = false
      log.info('DingTalk stopped')
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
      log.info('Feishu started')
      return { success: true }
    } catch (err: any) {
      log.error('Feishu start failed:', err)
      this.feishuAdapter = null
      return { success: false, error: err.message || 'Failed to connect' }
    }
  }

  async stopFeishu(): Promise<void> {
    if (this.feishuAdapter) {
      await this.feishuAdapter.stop() // adapter 内已触发 onConnectionChange(false)
      this.feishuAdapter = null
      this.config.feishu.enabled = false
      log.info('Feishu stopped')
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
      log.info('Slack started')
      return { success: true }
    } catch (err: any) {
      log.error('Slack start failed:', err)
      this.slackAdapter = null
      return { success: false, error: err.message || 'Failed to connect' }
    }
  }

  async stopSlack(): Promise<void> {
    if (this.slackAdapter) {
      await this.slackAdapter.stop() // adapter 内已触发 onConnectionChange(false)
      this.slackAdapter = null
      this.config.slack.enabled = false
      log.info('Slack stopped')
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
      log.info('Telegram started')
      return { success: true }
    } catch (err: any) {
      log.error('Telegram start failed:', err)
      this.telegramAdapter = null
      return { success: false, error: err.message || 'Failed to connect' }
    }
  }

  async stopTelegram(): Promise<void> {
    if (this.telegramAdapter) {
      await this.telegramAdapter.stop() // adapter 内已触发 onConnectionChange(false)
      this.telegramAdapter = null
      this.config.telegram.enabled = false
      log.info('Telegram stopped')
    }
  }

  isTelegramConnected(): boolean {
    return this.telegramAdapter?.isConnected() ?? false
  }

  // ==================== 企业微信管理 ====================

  async startWeCom(config: WeComConfig): Promise<{ success: boolean; error?: string }> {
    if (!config.corpId || !config.corpSecret || !config.agentId) {
      return { success: false, error: 'Corp ID, Corp Secret and Agent ID are required' }
    }
    if (!config.token || !config.encodingAESKey) {
      return { success: false, error: 'Token and EncodingAESKey are required for callback verification' }
    }

    try {
      await this.stopWeCom()

      this.config.wecom = { ...config, enabled: true }
      this.wecomAdapter = new WeComAdapter(config)

      this.wecomAdapter.onMessage = (msg: IMIncomingMessage) => this.handleIncomingMessage(msg)
      this.wecomAdapter.onConnectionChange = (connected: boolean) => {
        this.sendToDesktop('im:connectionChange', { platform: 'wecom', connected })
      }

      await this.wecomAdapter.start()
      log.info('WeCom started')
      return { success: true }
    } catch (err: any) {
      log.error('WeCom start failed:', err)
      this.wecomAdapter = null
      return { success: false, error: err.message || 'Failed to connect' }
    }
  }

  async stopWeCom(): Promise<void> {
    if (this.wecomAdapter) {
      await this.wecomAdapter.stop() // adapter 内已触发 onConnectionChange(false)
      this.wecomAdapter = null
      this.config.wecom.enabled = false
      log.info('WeCom stopped')
    }
  }

  isWeComConnected(): boolean {
    return this.wecomAdapter?.isConnected() ?? false
  }

  // ==================== 全局操作 ====================

  async stopAll(): Promise<void> {
    await this.stopDingTalk()
    await this.stopFeishu()
    await this.stopSlack()
    await this.stopTelegram()
    await this.stopWeCom()
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
      },
      wecom: {
        enabled: this.config.wecom.enabled,
        connected: this.isWeComConnected(),
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

    const targets = this.getNotificationTargets()
    if (targets.length === 0) {
      return { success: false, error: t('im.notification_no_contact') }
    }

    // 截断过长文本（adapter 内部也有截断，此处做防御性限制）
    const truncated = text.length > IM_TEXT_MAX_LENGTH
      ? text.substring(0, IM_TEXT_MAX_LENGTH - 20) + t('im.text_truncated')
      : text

    let lastError = ''
    for (const contact of targets) {
      const adapter = this.getAdapter(contact.platform)
      if (!adapter || !adapter.isConnected()) continue

      try {
        if (options?.markdown) {
          await adapter.sendMarkdown(contact.replyContext, options.title || t('im.notification_title'), truncated)
        } else {
          await adapter.sendText(contact.replyContext, truncated)
        }
        this.lastContact = contact
        log.info(`Proactive notification sent via ${contact.platform}`)
        return { success: true, platform: contact.platform }
      } catch (err: any) {
        lastError = err?.message || 'Unknown error'
        log.error(`Failed to send proactive notification via ${contact.platform}:`, err)
        // 该平台上下文失效时，从联系人池移除，避免后续重复失败
        delete this.contactsByPlatform[contact.platform]
        if (this.lastContact?.platform === contact.platform) {
          this.lastContact = null
        }
        this.persistContacts()
      }
    }

    return { success: false, error: lastError || t('im.notification_no_contact') }
  }

  // ==================== 消息处理核心 ====================

  /**
   * 处理 IM 平台来的消息
   */
  private async handleIncomingMessage(msg: IMIncomingMessage) {
    if (!this.deps) {
      log.error('Dependencies not set, ignoring message')
      return
    }

    const adapter = this.getAdapter(msg.platform)
    if (!adapter) return

    // 记录最近联系的渠道，用于后续主动推送
    const contact: IMLastContact = {
      platform: msg.platform,
      replyContext: msg.replyContext,
      userId: msg.userId,
      userName: msg.userName,
      chatId: msg.chatId,
      chatType: msg.chatType,
      updatedAt: Date.now(),
    }
    this.lastContact = contact
    this.contactsByPlatform[msg.platform] = contact
    this.persistContacts()

    const replyContext = msg.replyContext

    // 构建完整消息文本（含附件信息）
    const fullMessage = this.buildAgentMessage(msg)

    // Companion Agent 实例
    const companion = this.deps.agentService.createAssistantAgent(AgentService.COMPANION_AGENT_ID)

    // 检查是否有待确认的工具调用（仅对纯文本消息生效）
    if (companion.hasPendingConfirmation() && !msg.attachments?.length) {
      await this.handleConfirmResponse(adapter, replyContext, msg.text)
      return
    }

    // 如果 Agent 正在运行，尝试补充消息（包括 ask_user 的回复）
    if (companion.isRunning()) {
      try {
        if (companion.addUserMessage(fullMessage)) {
          await adapter.sendText(replyContext, t('im.reply_received'))
        } else {
          await adapter.sendText(replyContext, t('im.reply_busy'))
        }
      } catch (err) {
        log.error('Failed to send busy reply:', err)
      }
      return
    }

    // 特殊命令处理（仅对纯文本消息、无附件时生效）
    if (!msg.attachments?.length) {
      const lowerText = msg.text.toLowerCase().trim()
      try {
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
        log.error('Failed to send command reply:', err)
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
    const companion = this.deps!.agentService.createAssistantAgent(AgentService.COMPANION_AGENT_ID)
    const lowerText = text.toLowerCase().trim()
    const isApproved = CONFIRM_KEYWORDS.some(kw => lowerText === kw)
    const isRejected = REJECT_KEYWORDS.some(kw => lowerText === kw)

    if (!isApproved && !isRejected) {
      try {
        const status = companion.getRunStatus()
        await adapter.sendText(replyContext,
          t('im.confirm_hint', { toolName: status?.currentToolName || 'unknown' })
        )
      } catch (err) {
        log.error('Failed to send confirm hint:', err)
      }
      return
    }

    const success = companion.confirmToolCall(undefined, isApproved)

    try {
      if (success) {
        await adapter.sendText(replyContext,
          isApproved ? t('im.confirmed') : t('im.rejected')
        )
      } else {
        await adapter.sendText(replyContext, t('im.confirm_failed'))
      }
    } catch (err) {
      log.error('Failed to send confirm result:', err)
    }
  }

  /**
   * 执行 Agent 任务（直接调用 Companion Agent）
   */
  private async runAgentTask(adapter: IMAdapter, replyContext: any, msg: IMIncomingMessage) {
    if (!this.deps) return

    this.activeSession = { adapter, replyContext }
    const fullMessage = this.buildAgentMessage(msg)
    const agentId = AgentService.COMPANION_AGENT_ID

    try {
      await adapter.sendText(replyContext, t('im.processing'))
    } catch { /* ignore */ }

    // 确保桌面端有 companion tab（不激活，不抢焦点）
    this.sendToDesktop('watch:ensureTab', { agentId })
    this.sendToDesktop('im:taskStarted', {
      platform: msg.platform, userId: msg.userId,
      userName: msg.userName, message: fullMessage
    })

    let textBuffer = ''
    let hasSentText = false
    let lastFlushedContent = ''
    const notifiedToolCalls = new Set<string>()
    const sentMessageStepIds = new Set<string>()

    let sendQueue: Promise<void> = Promise.resolve()
    const enqueueSend = (fn: () => Promise<void>): void => {
      sendQueue = sendQueue.then(() => fn().catch(err => {
        log.error('Send queue error:', err)
      }))
    }

    const flushTextBuffer = async () => {
      if (textBuffer) {
        hasSentText = true
        const text = textBuffer
        textBuffer = ''
        lastFlushedContent = text
        try {
          await adapter.sendMarkdown(replyContext, '旗鱼', text)
        } catch (err) {
          log.error('Failed to send text:', err)
        }
      }
    }

    const mainWindow = this.deps.mainWindow

    try {
      const context = {
        terminalOutput: [] as string[],
        systemInfo: { os: process.platform, shell: process.env.SHELL || '/bin/bash' },
        terminalType: 'local' as const,
        remoteChannel: msg.platform as any
      }

      await this.deps.agentService.runAssistant(agentId, fullMessage, context, {
        enabled: true, commandTimeout: 30000,
        autoExecuteSafe: true, autoExecuteModerate: true,
        executionMode: this.config.executionMode as 'strict' | 'relaxed' | 'free',
        debugMode: false
      }, undefined, {
        onStep: (_runId: string, step: any) => {
          // 同步到桌面 companion tab
          if (mainWindow && !mainWindow.webContents.isDestroyed()) {
            mainWindow.webContents.send('agent:step', {
              agentId, step: JSON.parse(JSON.stringify(step))
            })
          }

          if (step.type === 'message' && step.content) {
            if (step.isStreaming) {
              textBuffer = step.content
            } else if (!sentMessageStepIds.has(step.id)) {
              sentMessageStepIds.add(step.id)
              textBuffer = step.content
              enqueueSend(() => flushTextBuffer())
            }
          } else if (step.type === 'asking' && step.toolArgs) {
            const askKey = step.id || `asking:${step.toolArgs.question}`
            if (notifiedToolCalls.has(askKey)) return
            notifiedToolCalls.add(askKey)

            const sendAsk = async () => {
              await flushTextBuffer()
              const question = step.toolArgs.question || step.content || ''
              const options = step.toolArgs.options as string[] | undefined
              const lines = [t('im.need_reply'), '', question]
              if (options && options.length > 0) {
                lines.push('')
                options.forEach((opt: string, i: number) => { lines.push(`${i + 1}. ${opt}`) })
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
            if (step.toolName === 'ask_user') return
            const toolCallKey = step.id || `${step.toolName}:${JSON.stringify(step.toolArgs || {})}`
            if (notifiedToolCalls.has(toolCallKey)) return
            notifiedToolCalls.add(toolCallKey)

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

        onComplete: (_runId: string, result: string) => {
          const finish = async () => {
            await flushTextBuffer()
            const resultText = result?.trim() || ''
            if (resultText && resultText !== lastFlushedContent.trim()) {
              try { await adapter.sendMarkdown(replyContext, '旗鱼', result) } catch { /* ignore */ }
            } else if (!hasSentText) {
              try { await adapter.sendText(replyContext, t('im.task_complete')) } catch { /* ignore */ }
            }
          }
          enqueueSend(finish)

          if (mainWindow && !mainWindow.webContents.isDestroyed()) {
            mainWindow.webContents.send('agent:complete', { agentId, result })
          }
          this.sendToDesktop('im:taskComplete', {
            platform: msg.platform, userId: msg.userId
          })
        },

        onError: (_runId: string, error: string) => {
          const finish = async () => {
            await flushTextBuffer()
            try { await adapter.sendText(replyContext, t('im.task_error', { error })) } catch { /* ignore */ }
          }
          enqueueSend(finish)

          if (mainWindow && !mainWindow.webContents.isDestroyed()) {
            mainWindow.webContents.send('agent:error', { agentId, error })
          }
          this.sendToDesktop('im:taskError', {
            platform: msg.platform, userId: msg.userId, error
          })
        }
      })
    } catch (err: any) {
      try {
        await adapter.sendText(replyContext, `❌ ${err.message || 'Unknown error'}`)
      } catch { /* ignore */ }
    } finally {
      try { await sendQueue } catch { /* ignore */ }
      this.activeSession = null
    }
  }

  // ==================== 文件发送（供 Agent 工具调用） ====================

  /**
   * 为当前活跃的 IM 会话发送文件
   * 优先使用活跃会话，无活跃会话时通过最近联系人主动推送
   */
  async sendFileForCurrentSession(filePath: string, fileName?: string): Promise<SendFileResult> {
    if (this.activeSession) {
      try {
        await this.activeSession.adapter.sendFile(
          this.activeSession.replyContext,
          filePath,
          fileName
        )
        return { success: true }
      } catch (err: any) {
        log.error('Failed to send file:', err)
        return { success: false, error: err.message || 'Failed to send file' }
      }
    }

    return this.sendFileProactive(filePath, fileName)
  }

  /**
   * 为当前活跃的 IM 会话发送图片（内联显示）
   * 优先使用活跃会话，无活跃会话时通过最近联系人主动推送
   */
  async sendImageForCurrentSession(filePath: string): Promise<SendFileResult> {
    if (this.activeSession) {
      try {
        await this.activeSession.adapter.sendImage(
          this.activeSession.replyContext,
          filePath
        )
        return { success: true }
      } catch (err: any) {
        log.error('Failed to send image:', err)
        return { success: false, error: err.message || 'Failed to send image' }
      }
    }

    return this.sendImageProactive(filePath)
  }

  /**
   * 当前是否有活跃的 IM 会话或可用的最近联系人
   */
  hasActiveSession(): boolean {
    return this.activeSession !== null || this.lastContact !== null
  }

  /**
   * 通过最近联系人主动发送图片
   */
  private async sendImageProactive(filePath: string): Promise<SendFileResult> {
    const targets = this.getNotificationTargets()
    for (const contact of targets) {
      const adapter = this.getAdapter(contact.platform)
      if (!adapter || !adapter.isConnected()) continue
      try {
        await adapter.sendImage(contact.replyContext, filePath)
        log.info(`Proactive image sent via ${contact.platform}`)
        return { success: true }
      } catch (err: any) {
        log.error(`Failed to send image via ${contact.platform}:`, err)
      }
    }
    return { success: false, error: 'No available IM channel' }
  }

  /**
   * 通过最近联系人主动发送文件
   */
  private async sendFileProactive(filePath: string, fileName?: string): Promise<SendFileResult> {
    const targets = this.getNotificationTargets()
    for (const contact of targets) {
      const adapter = this.getAdapter(contact.platform)
      if (!adapter || !adapter.isConnected()) continue
      try {
        await adapter.sendFile(contact.replyContext, filePath, fileName)
        log.info(`Proactive file sent via ${contact.platform}`)
        return { success: true }
      } catch (err: any) {
        log.error(`Failed to send file via ${contact.platform}:`, err)
      }
    }
    return { success: false, error: 'No available IM channel' }
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
    if (platform === 'wecom') return this.wecomAdapter
    return null
  }

  private loadPersistedContacts(): void {
    try {
      const configService = getConfigService()
      const stored = configService.get('imLastContacts') as Record<string, unknown> | undefined
      if (!stored || typeof stored !== 'object') return

      const parsed: Partial<Record<IMPlatform, IMLastContact>> = {}
      const platforms: IMPlatform[] = ['dingtalk', 'feishu', 'slack', 'telegram', 'wecom']
      for (const platform of platforms) {
        const raw = stored[platform] as IMLastContact | undefined
        if (this.isValidContact(raw) && !this.isContactExpired(raw)) {
          parsed[platform] = raw
        }
      }
      this.contactsByPlatform = parsed
    } catch (err) {
      log.warn('Failed to load persisted contacts:', err)
      this.contactsByPlatform = {}
    }
  }

  private persistContacts(): void {
    try {
      const configService = getConfigService()
      const serializable: Record<string, unknown> = {}
      const platforms: IMPlatform[] = ['dingtalk', 'feishu', 'slack', 'telegram', 'wecom']
      for (const platform of platforms) {
        const contact = this.contactsByPlatform[platform]
        if (!contact) continue
        const safe = this.toSerializableContact(contact)
        if (safe) serializable[platform] = safe
      }
      configService.set('imLastContacts', serializable)
    } catch (err) {
      log.warn('Failed to persist contacts:', err)
    }
  }

  private toSerializableContact(contact: IMLastContact): IMLastContact | null {
    try {
      // 防御性校验：仅持久化可 JSON 序列化的 replyContext
      JSON.stringify(contact.replyContext)
      return contact
    } catch {
      log.warn(`Skip persisting contact for ${contact.platform}: replyContext is not serializable`)
      return null
    }
  }

  private isValidContact(contact: any): contact is IMLastContact {
    return !!contact
      && typeof contact.platform === 'string'
      && typeof contact.replyContext !== 'undefined'
      && typeof contact.userId === 'string'
      && typeof contact.userName === 'string'
      && (contact.chatType === 'single' || contact.chatType === 'group')
      && typeof contact.updatedAt === 'number'
  }

  private isContactExpired(contact: IMLastContact): boolean {
    return (Date.now() - contact.updatedAt) > IMService.CONTACT_TTL_MS
  }

  private pickMostRecentContact(
    contacts: Partial<Record<IMPlatform, IMLastContact>>
  ): IMLastContact | null {
    const list = Object.values(contacts)
      .filter((contact): contact is IMLastContact => !!contact)
      .sort((a, b) => b.updatedAt - a.updatedAt)
    return list[0] || null
  }

  private getNotificationTargets(): IMLastContact[] {
    const connectedPlatforms: IMPlatform[] = ['dingtalk', 'feishu', 'slack', 'telegram', 'wecom']
      .filter((platform) => {
        const adapter = this.getAdapter(platform)
        return !!adapter && adapter.isConnected()
      })

    if (connectedPlatforms.length === 0) return []

    const candidates = connectedPlatforms
      .map((platform) => this.contactsByPlatform[platform])
      .filter((contact): contact is IMLastContact => !!contact && !this.isContactExpired(contact))
      .sort((a, b) => b.updatedAt - a.updatedAt)

    if (candidates.length === 0) return []

    const preferredPlatform = this.lastContact?.platform
    if (preferredPlatform) {
      const preferred = candidates.find(c => c.platform === preferredPlatform)
      if (preferred) {
        return [preferred, ...candidates.filter(c => c.platform !== preferredPlatform)]
      }
    }
    return candidates
  }

  private getSessionStatus(): string {
    const companion = this.deps?.agentService?.createAssistantAgent(AgentService.COMPANION_AGENT_ID)
    const runStatus = companion?.getRunStatus()
    const connected = (name: string, isConn: boolean) =>
      `${name}: ${isConn ? '✅' : '❌'}`

    return [
      t('im.status_title'),
      `${t('im.status_state')}: ${runStatus?.isRunning ? t('im.status_running') : t('im.status_idle')}`,
      `${t('im.status_exec_mode')}: ${this.config.executionMode}`,
      connected('DingTalk', this.isDingTalkConnected()),
      connected('Feishu', this.isFeishuConnected()),
      connected('Slack', this.isSlackConnected()),
      connected('Telegram', this.isTelegramConnected()),
      connected('WeCom', this.isWeComConnected()),
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
