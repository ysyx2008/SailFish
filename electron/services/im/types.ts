/**
 * IM Service Types - 即时通讯平台集成类型定义
 */

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

export interface IMServiceConfig {
  dingtalk: DingTalkConfig
  feishu: FeishuConfig
  /** Agent 执行模式，默认 relaxed */
  executionMode: 'strict' | 'relaxed' | 'free'
  /** 空闲会话超时（分钟），默认 60 */
  sessionTimeoutMinutes: number
}

// ==================== 适配器接口 ====================

export type IMPlatform = 'dingtalk' | 'feishu'

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

/** 图片上传大小限制（字节） */
export const IM_IMAGE_MAX_SIZE_FEISHU = 10 * 1024 * 1024   // 飞书: 10MB

// ==================== 常量 ====================

/** IM 消息最大长度（超过则截断） */
export const IM_TEXT_MAX_LENGTH = 4000

/** 确认命令关键词 */
export const CONFIRM_KEYWORDS = ['确认', '同意', '批准', 'y', 'yes', 'ok']
export const REJECT_KEYWORDS = ['拒绝', '取消', '否决', 'n', 'no', 'cancel']
