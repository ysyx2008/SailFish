/**
 * IM Service Types - 即时通讯平台集成类型定义
 */

import type { ExecutionMode } from '@shared/types'

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
  corpId: string        // 企业 ID
  corpSecret: string    // 应用 Secret
  agentId: number       // 应用 AgentId
  token: string         // 回调 Token
  encodingAESKey: string // 回调加密密钥
  callbackPort: number  // 本地回调服务端口，默认 3722
}

export interface IMServiceConfig {
  dingtalk: DingTalkConfig
  feishu: FeishuConfig
  slack: SlackConfig
  telegram: TelegramConfig
  wecom: WeComConfig
  /** Agent 执行模式，默认 relaxed */
  executionMode: ExecutionMode
  /** 空闲会话超时（分钟），默认 60 */
  sessionTimeoutMinutes: number
  /** 是否发送过程消息（工具调用、中间文本等），关闭后仅发送最终结果和错误，默认 true */
  sendProcessMessages: boolean
}

// ==================== 适配器接口 ====================

export type IMPlatform = 'dingtalk' | 'feishu' | 'slack' | 'telegram' | 'wecom'

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

/**
 * IM 适配器通用接口
 */
export interface IMAdapter {
  readonly platform: IMPlatform

  /** 启动连接 */
  start(): Promise<void>
  /** 停止连接 */
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

/** 文件上传大小限制（字节） */
export const IM_FILE_MAX_SIZE_DINGTALK = 20 * 1024 * 1024  // 钉钉: 20MB
export const IM_FILE_MAX_SIZE_FEISHU = 30 * 1024 * 1024    // 飞书: 30MB
export const IM_FILE_MAX_SIZE_SLACK = 1 * 1024 * 1024 * 1024  // Slack: 1GB（Free 计划实际 API 限制通常更小，此处为用户侧防御性限制）
export const IM_FILE_MAX_SIZE_TELEGRAM = 50 * 1024 * 1024  // Telegram: 50MB
export const IM_FILE_MAX_SIZE_WECOM = 20 * 1024 * 1024    // 企业微信: 20MB

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
