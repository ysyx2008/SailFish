/**
 * 插件系统类型定义
 * 兼容 OpenClaw 插件规范（openclaw.plugin.json + definePluginEntry）
 */

import type * as http from 'http'
import type { ToolDefinition } from '../ai.service'
import type { IMAdapter } from '../im/types'
import type { TtsProvider } from '../tts/types'

// ==================== Manifest ====================

/** 插件 manifest（对齐 openclaw.plugin.json） */
export interface PluginManifest {
  id: string
  name?: string
  description?: string
  version?: string
  /** 插件配置的 JSON Schema */
  configSchema: object
  /** 声明的 channel IDs */
  channels?: string[]
  /** 声明的 provider IDs */
  providers?: string[]
  /** CLI backend IDs（SailFish 不使用，忽略） */
  cliBackends?: string[]
  /** 静态能力声明 */
  contracts?: {
    tools?: string[]
    speechProviders?: string[]
    ttsProviders?: string[]
    mediaUnderstandingProviders?: string[]
    imageGenerationProviders?: string[]
    webSearchProviders?: string[]
  }
  /** 技能目录（相对于插件根目录） */
  skills?: string[]
  /** 默认启用 */
  enabledByDefault?: true
  /** UI 提示 */
  uiHints?: Record<string, {
    label?: string
    help?: string
    tags?: string[]
    advanced?: boolean
    sensitive?: boolean
    placeholder?: string
  }>
}

// ==================== Registration API ====================

/** 工具注册参数（OpenClaw 格式） */
export interface ToolRegistration {
  name: string
  description: string
  /** JSON Schema（TypeBox 编译结果也是 JSON Schema） */
  parameters: object
  execute(toolCallId: string, params: Record<string, unknown>): Promise<ToolExecuteResult>
}

/** 工具执行结果（OpenClaw 格式） */
export interface ToolExecuteResult {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string }
  >
}

/** 工具注册选项 */
export interface ToolRegistrationOptions {
  optional?: boolean
}

/** Provider 注册参数 */
export interface ProviderRegistration {
  id: string
  name: string
  /** 判断给定 profile 是否由此 provider 处理 */
  match(profile: { apiUrl: string; apiFormat?: string; model?: string }): boolean
  chatWithTools(params: ProviderChatParams): Promise<ProviderChatResult>
  chatWithToolsStream?(params: ProviderChatParams): AsyncGenerator<ProviderStreamChunk>
}

export interface ProviderChatParams {
  messages: Array<{ role: string; content: string; [key: string]: unknown }>
  tools?: ToolDefinition[]
  model?: string
  apiUrl?: string
  apiKey?: string
  [key: string]: unknown
}

export interface ProviderChatResult {
  content?: string
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  finish_reason?: 'stop' | 'tool_calls' | 'length'
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
}

export interface ProviderStreamChunk {
  type: 'content' | 'tool_call' | 'done' | 'error'
  content?: string
  tool_call?: { id: string; function: { name: string; arguments: string } }
  error?: string
}

/** Channel 注册参数 */
export interface ChannelRegistration {
  id: string
  name: string
  createAdapter(config: Record<string, unknown>): IMAdapter
}

/** HTTP 路由 handler */
export type RouteHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse
) => void | Promise<void>

/** HTTP 路由注册项 */
export interface HttpRouteEntry {
  /** 路由归属的插件 id（撤销、冲突检测与审计的凭据） */
  pluginId: string
  method: string
  path: string
  handler: RouteHandler
}

// ==================== Hook 系统 ====================

export type HookEvent =
  | 'before_tool_call'
  | 'after_tool_call'
  | 'before_ai_request'
  | 'message_sending'

export interface BeforeToolCallContext {
  toolName: string
  toolArgs: Record<string, unknown>
  toolCallId: string
}

export interface AfterToolCallContext {
  toolName: string
  toolArgs: Record<string, unknown>
  result: { success: boolean; output: string; error?: string }
}

export interface BeforeAiRequestContext {
  messages: Array<{ role: string; content: string; [key: string]: unknown }>
  tools: ToolDefinition[]
}

export interface MessageSendingContext {
  text: string
  platform?: string
  replyContext?: unknown
}

export type HookContext =
  | BeforeToolCallContext
  | AfterToolCallContext
  | BeforeAiRequestContext
  | MessageSendingContext

export interface HookDecision {
  /** 拦截工具调用 */
  block?: boolean
  /** 要求用户确认 */
  requireApproval?: boolean
  /** 取消消息发送 */
  cancel?: boolean
  /** 修改后的参数（预留，未来可用于 before_tool_call 修改参数） */
  modified?: unknown
}

export type HookHandler = (context: HookContext) => HookDecision | Promise<HookDecision>

// ==================== Plugin Registration API ====================

/** TTS Provider 注册参数（复用 TtsProvider 接口） */
export type TtsProviderRegistration = TtsProvider

/** 传给 register(api) 的注册 API 对象 */
export interface PluginRegistrationAPI {
  registerTool(def: ToolRegistration, opts?: ToolRegistrationOptions): void
  registerProvider(def: ProviderRegistration): void
  registerChannel(def: ChannelRegistration): void
  registerTtsProvider(def: TtsProviderRegistration): void
  registerHook(event: HookEvent, handler: HookHandler): void
  registerHttpRoute(method: string, path: string, handler: RouteHandler): void
}

// ==================== Plugin Entry ====================

/** 插件入口定义（OpenClaw definePluginEntry 格式） */
export interface PluginEntry {
  id: string
  name?: string
  description?: string
  register(api: PluginRegistrationAPI): void
  onUnload?(): void | Promise<void>
}

/** 运行时卸载结果。插件不在 registry 中视为失败并携带原因 */
export interface PluginUnloadResult {
  success: boolean
  /** onUnload 抛错时的错误信息，或插件未加载的原因 */
  error?: string
}

// ==================== Loaded Plugin ====================

/** 已加载的插件运行时信息 */
export interface LoadedPlugin {
  manifest: PluginManifest
  entry?: PluginEntry
  /** 插件根目录 */
  rootDir: string
  /** 注册的工具 */
  tools: Array<ToolRegistration & { optional?: boolean }>
  /** 注册的 provider */
  providers: ProviderRegistration[]
  /** 注册的 channel */
  channels: ChannelRegistration[]
  /** 注册的 TTS provider */
  ttsProviders: TtsProviderRegistration[]
  /** 注册的 hook */
  hooks: Map<HookEvent, HookHandler[]>
  /** 注册的 HTTP 路由 */
  httpRoutes: HttpRouteEntry[]
  /** 是否已启用 */
  enabled: boolean
}

// ==================== Config ====================

/** 单个插件的配置条目 */
export interface PluginEntryConfig {
  enabled: boolean
  config?: Record<string, unknown>
}
