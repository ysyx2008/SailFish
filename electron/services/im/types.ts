/**
 * IM Service Types - 即时通讯平台集成类型定义
 */

import type { ExecutionMode, IMProcessMode } from '@shared/types'

// re-export 让后端内部 import 路径稳定
export type { IMProcessMode }

// ==================== 配置类型 ====================

export interface DingTalkConfig {
  enabled: boolean
  clientId: string      // AppKey
  clientSecret: string  // AppSecret
}

export interface FeishuConfig {
  enabled: boolean
  appId: string
  appSecret: string
}

export interface SlackConfig {
  enabled: boolean
  botToken: string      // xoxb-...
  appToken: string      // xapp-...
}

export interface TelegramConfig {
  enabled: boolean
  botToken: string      // 123456:ABC-DEF...
}

export interface WeComConfig {
  enabled: boolean
  botId: string         // 智能机器人 BotID（长连接模式）
  secret: string        // 长连接专用密钥
}

export interface WeChatConfig {
  enabled: boolean
  token: string         // 扫码登录后获得的 bot_token
  baseUrl: string       // API base URL（登录时返回，默认 https://ilinkai.weixin.qq.com）
}

export interface IMServiceConfig {
  dingtalk: DingTalkConfig
  feishu: FeishuConfig
  slack: SlackConfig
  telegram: TelegramConfig
  wecom: WeComConfig
  wechat: WeChatConfig
  /** Agent 执行模式，默认 relaxed */
  executionMode: ExecutionMode
  /** 空闲会话超时（分钟），默认 60 */
  sessionTimeoutMinutes: number
  /**
   * 过程消息投递模式，默认 'messages'：
   * - 'final'：仅发送最终结果和错误，执行过程完全静默
   * - 'messages'：发送 AI 写给用户的消息内容，但不发工具调用记录（🔧/❌）。
   *   微信渠道走 digest buffer 合并，其他渠道逐条直发
   * - 'all'：消息内容 + 工具调用记录都发。微信渠道用 digest buffer 节流防风控，
   *   其他渠道正常逐条发
   */
  processMode: IMProcessMode
  /**
   * 是否把 AI 的思考过程（reasoning）一并发到 IM。默认 false：
   * - 关闭：仅发正文，思考过程被剥离，避免给 IM 用户刷屏
   * - 开启：思考过程与正文一起发，便于调试或观察 AI 的推理路径
   * 注意：无论开关与否，最终任务完成时若整个会话从未发过实质正文，
   * 会把最近一次思考过程作为兜底发出去（保证用户至少有反馈）。
   */
  sendThinkingProcess: boolean
}

// ==================== 适配器接口 ====================

export type IMPlatform = 'dingtalk' | 'feishu' | 'slack' | 'telegram' | 'wecom' | 'wechat' | (string & {})

/**
 * IM 接收消息中的附件（图片、语音、视频、文件）
 * 由适配器下载到本地临时目录后生成
 */
export interface IMAttachment {
  /** 附件类型 */
  type: 'image' | 'audio' | 'video' | 'file'
  /** 下载后的本地路径 */
  localPath: string
  /** 文件名 */
  fileName: string
}

/**
 * IM 消息事件 —— 适配器接收到用户消息后触发
 */
export interface IMIncomingMessage {
  platform: IMPlatform
  userId: string
  userName: string
  text: string
  chatType: 'single' | 'group'
  chatId?: string
  /** 平台特定的回复上下文 */
  replyContext: any
  /** 附件列表（图片、语音、视频、文件），已下载到本地 */
  attachments?: IMAttachment[]
  /** 该平台首次联系标记（由 IMService 在消息处理时设置） */
  isFirstContact?: boolean
}

/** beginOutboundSession 可选参数 */
export interface IMOutboundSessionOptions {
  /** 是否缓冲合并过程消息（微信等风控渠道）；默认 false */
  bufferProgress?: boolean
}

/**
 * 支持过程消息缓冲出站的可选适配器能力（WeChatAdapter 实现）。
 * IMService 通过 IMAdapter 上的同名可选方法调用，不依赖具体平台类型。
 */
export interface IMProgressOutboundCapable {
  sendProgressText(replyContext: any, text: string): Promise<void>
  sendProgressMarkdown(replyContext: any, title: string, content: string): Promise<void>
  flushProgress(replyContext: any): Promise<void>
}

/**
 * IM 适配器通用接口
 */
export interface IMAdapter {
  readonly platform: IMPlatform

  /** 启动连接 */
  start(): Promise<void>
  /** 停止连接。必须幂等可重入，且容忍在 start() 未完成或已失败时被调用（超时回滚与晚到完成监护可能先后调用两次） */
  stop(): Promise<void>
  /** 是否已连接 */
  isConnected(): boolean

  /** 发送纯文本消息 */
  sendText(replyContext: any, text: string): Promise<void>
  /** 发送 Markdown 消息 */
  sendMarkdown(replyContext: any, title: string, content: string): Promise<void>
  /** 发送图片消息（内联显示） */
  sendImage(replyContext: any, filePath: string): Promise<void>
  /** 发送文件消息 */
  sendFile(replyContext: any, filePath: string, fileName?: string): Promise<void>

  /** 发送带确认按钮的交互卡片（可选，仅部分平台支持） */
  sendConfirmCard?(replyContext: any, toolName: string, toolArgs: string, riskLevel: string): Promise<void>

  /** 发送 ask_user 选项卡片：单选显示按钮，多选显示下拉多选+提交按钮（可选，仅部分平台支持） */
  sendAskCard?(replyContext: any, question: string, options: string[], allowMultiple?: boolean): Promise<void>

  /**
   * 开始长出站会话（可选，微信实现）。
   * 在 Agent 任务全程维持 typing keepalive，避免 context_token 中途失效。
   * `bufferProgress` 为 true 时，适配器可启用过程消息合并（见 sendProgressText 等）。
   */
  beginOutboundSession?(replyContext: any, options?: IMOutboundSessionOptions): Promise<void>
  /** 结束长出站会话（与 beginOutboundSession 配对） */
  endOutboundSession?(replyContext: any): void | Promise<void>
  /**
   * 发送过程类纯文本（工具进度等）。实现方可缓冲合并后再出站，未实现则 IMService 回退 sendText。
   */
  sendProgressText?(replyContext: any, text: string): Promise<void>
  /**
   * 发送过程类 Markdown 正文（中间 message step 等）。实现方可缓冲合并，未实现则回退 sendMarkdown。
   */
  sendProgressMarkdown?(replyContext: any, title: string, content: string): Promise<void>
  /** 立即 flush 缓冲中的过程消息（ask/confirm/任务结束前由 IMService 调用） */
  flushProgress?(replyContext: any): Promise<void>
  /**
   * 微信：发送结构化工具进度（TOOL_CALL_START/RESULT），替代纯文本刷屏。
   * 须在 beginOutboundSession 之后、endOutboundSession 之前调用。
   */
  notifyToolProgress?(
    replyContext: any,
    event: { phase: 'start' | 'end'; toolName: string; toolCallId?: string; success?: boolean },
  ): void
  /** 微信：出站失败时向用户发一条纯文本提示（对齐 upstream sendWeixinErrorNotice） */
  sendErrorNotice?(replyContext: any, message: string): Promise<void>

  /** 消息到达回调 */
  onMessage: ((msg: IMIncomingMessage) => void) | null
  /** 连接状态变化回调 */
  onConnectionChange: ((connected: boolean) => void) | null
}

/**
 * 文件发送结果
 */
export interface SendFileResult {
  success: boolean
  error?: string
}

/**
 * 渠道可发文件状态（产出物「发送到手机」渠道弹窗用）
 */
export interface IMChannelSendTarget {
  platform: IMPlatform
  /** 适配器已连接 */
  connected: boolean
  /** 持有可投递的会话上下文（用户须先在该渠道与 bot 对话过且未过期） */
  hasContact: boolean
  /** 有会话上下文时为最近联系人名 */
  contactName?: string
}

/** 文件上传大小限制（字节） */
export const IM_FILE_MAX_SIZE_DINGTALK = 20 * 1024 * 1024  // 钉钉: 20MB
export const IM_FILE_MAX_SIZE_FEISHU = 30 * 1024 * 1024    // 飞书: 30MB
export const IM_FILE_MAX_SIZE_SLACK = 1 * 1024 * 1024 * 1024  // Slack: 1GB（Free 计划实际 API 限制通常更小，此处为用户侧防御性限制）
export const IM_FILE_MAX_SIZE_TELEGRAM = 50 * 1024 * 1024  // Telegram: 50MB
export const IM_FILE_MAX_SIZE_WECOM = 20 * 1024 * 1024    // 企业微信: 20MB
export const IM_FILE_MAX_SIZE_WECHAT = 20 * 1024 * 1024  // 微信: 20MB

/** 图片上传大小限制（字节） */
export const IM_IMAGE_MAX_SIZE_FEISHU = 10 * 1024 * 1024   // 飞书: 10MB
export const IM_IMAGE_MAX_SIZE_TELEGRAM = 10 * 1024 * 1024  // Telegram: 10MB

/** 接收文件下载大小限制（字节） */
export const IM_DOWNLOAD_MAX_SIZE = 100 * 1024 * 1024  // 100MB

// ==================== 常量 ====================

/** IM 消息最大长度（超过则截断） */
export const IM_TEXT_MAX_LENGTH = 4000

/** 确认命令关键词 */
export const CONFIRM_KEYWORDS = ['确认', '同意', '批准', 'y', 'yes', 'ok']
export const REJECT_KEYWORDS = ['拒绝', '取消', '否决', 'n', 'no', 'cancel']
