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

// ==================== 会话类型 ====================

export interface IMSession {
  id: string
  platform: IMPlatform
  userId: string
  userName: string
  chatType: 'single' | 'group'
  chatId?: string
  ptyId: string | null
  isRunning: boolean
  history: IMChatMessage[]
  pendingConfirm: IMPendingConfirm | null
  executionMode: 'strict' | 'relaxed' | 'free'
  lastActiveAt: number
  /** 流式文本聚合缓冲区 */
  textBuffer: string
  currentStepId: string | null
  /** 平台特定的回复上下文（如 sessionWebhook、chatId 等） */
  replyContext: any
}

export interface IMChatMessage {
  role: 'user' | 'assistant'
  content: string
  timestamp: number
}

export interface IMPendingConfirm {
  toolCallId: string
  toolName: string
  toolArgs: Record<string, unknown>
  riskLevel: string
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

  /** 消息到达回调 */
  onMessage: ((msg: IMIncomingMessage) => void) | null
  /** 连接状态变化回调 */
  onConnectionChange: ((connected: boolean) => void) | null
}

// ==================== IM 服务依赖 ====================

export interface IMServiceDependencies {
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

// ==================== IM 服务状态（发送到前端） ====================

export interface IMServiceStatus {
  dingtalk: {
    enabled: boolean
    connected: boolean
    activeSessions: number
  }
  feishu: {
    enabled: boolean
    connected: boolean
    activeSessions: number
  }
}

// ==================== 常量 ====================

/** IM 消息最大长度（超过则截断） */
export const IM_TEXT_MAX_LENGTH = 4000

/** 确认命令关键词 */
export const CONFIRM_KEYWORDS = ['确认', '同意', '批准', 'y', 'yes', 'ok']
export const REJECT_KEYWORDS = ['拒绝', '取消', '否决', 'n', 'no', 'cancel']
