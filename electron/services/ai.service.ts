import { ConfigService } from './config.service'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'
import * as https from 'https'
import * as http from 'http'
import { t } from './agent/i18n'
import { getAiDebugService } from './ai-debug.service'
import { createLogger } from '../utils/logger'

const log = createLogger('AI')

// AI 请求超时配置（毫秒）
const AI_TIMEOUT = {
  CONNECT: 15 * 1000,        // 连接超时：15 秒
  SOCKET_IDLE: 120 * 1000,   // 空闲超时：120 秒（流式请求中数据流中断检测）
  TOTAL: 10 * 60 * 1000      // 总超时：10 分钟（长文本生成可能需要较长时间）
}

// 网络错误自动重试配置
const AI_RETRY = {
  MAX_RETRIES: 3,            // 最大重试次数
  RETRY_DELAY: 2000,         // 重试间隔：2 秒
  RATE_LIMIT_MAX_RETRIES: 3, // Rate limit 最大重试次数
  RATE_LIMIT_BASE_DELAY: 5000, // Rate limit 基础退避：5 秒
  SERVER_ERROR_MAX_RETRIES: 2, // 5xx 服务端错误最大重试次数
  SERVER_ERROR_BASE_DELAY: 3000, // 5xx 基础退避：3 秒
  // 可重试的网络错误码
  RETRYABLE_ERRORS: ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED', 'EPIPE', 'EAI_AGAIN'],
  // 可重试的 HTTP 状态码（服务端临时错误）
  RETRYABLE_STATUS_CODES: [500, 502, 503, 529] as readonly number[]
}

// 判断错误是否可重试
function isRetryableError(errorMessage: string): boolean {
  return AI_RETRY.RETRYABLE_ERRORS.some(code => errorMessage.includes(code))
}

/**
 * 将 Node.js 网络错误消息翻译为用户可读的界面语言
 * 错误码是 Node.js 定义的稳定常量，不是关键词匹配
 */
const NET_ERROR_CODES = ['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN'] as const

function translateNetworkError(errMessage: string): string {
  // 从 err.message（如 "getaddrinfo ENOTFOUND api.deepseek.com"）中提取错误码和主机名
  for (const code of NET_ERROR_CODES) {
    if (errMessage.includes(code)) {
      // 提取主机名：错误消息中错误码后面的部分，取第一段非空字符串
      const afterCode = errMessage.split(code)[1]?.trim() || ''
      const host = afterCode.split(/\s/)[0] || ''
      const key = `error.net_${code.toLowerCase()}` as Parameters<typeof t>[0]
      return t(key, { host })
    }
  }
  return errMessage
}

/**
 * 解析 API 返回的错误响应体，提取结构化的错误信息
 * 避免将原始 JSON（如 {"error":{"message":"...","type":"...","param":null,...}}）直接展示给用户
 */
function parseApiError(rawBody: string): { message: string; code?: string } {
  try {
    const parsed = JSON.parse(rawBody) as { error?: { message?: string; code?: string; type?: string } }
    if (parsed?.error) {
      return {
        message: parsed.error.message || rawBody,
        code: parsed.error.code || parsed.error.type
      }
    }
  } catch {
    // 非 JSON，原样返回（截断过长内容）
  }
  return { message: rawBody.length > 300 ? rawBody.slice(0, 300) + '...' : rawBody }
}

// 多模态消息内容部分（OpenAI Vision API 格式）
export type AiContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } }

export interface AiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  images?: string[]  // 图片 base64 data URL 列表（仅 user 消息），发送时会转为多模态格式
  tool_call_id?: string  // 用于 tool 角色的消息
  tool_calls?: ToolCall[]  // 用于 assistant 角色的工具调用
  reasoning_content?: string  // 用于 think 模型的思考内容（DeepSeek-R1 等）
}

interface ToolParameterSchema {
  type: string
  description?: string
  enum?: string[]
  items?: ToolParameterSchema
  properties?: Record<string, ToolParameterSchema>
  required?: string[]
}

// Tool Calling 相关类型
export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, ToolParameterSchema>
      required?: string[]
    }
  }
}

export interface ToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string  // JSON 字符串
  }
}

export interface ChatWithToolsResult {
  content?: string
  tool_calls?: ToolCall[]
  finish_reason?: 'stop' | 'tool_calls' | 'length'
  reasoning_content?: string  // think 模型的思考内容
}

export type { AiModelType } from './config.service'

export interface AiProfile {
  id: string
  name: string
  apiUrl: string
  apiKey: string
  model: string
  proxy?: string
  contextLength?: number  // 模型上下文长度（tokens），默认 128000
  maxOutputTokens?: number  // 单次回复最大输出 token 数，默认 8192
  modelType?: import('./config.service').AiModelType  // 模型类型，默认 general
  visionProfileId?: string  // 关联的视觉模型 Profile ID（仅 general 类型有效）
}

/**
 * 检测 API 错误是否因为不支持 image_url（视觉/多模态）
 * 精确匹配：错误消息明确提及 image_url 相关问题
 */
function isVisionNotSupportedError(errorMsg: string): boolean {
  const lower = errorMsg.toLowerCase()
  return lower.includes('image_url') && (
    lower.includes('unknown variant') ||
    lower.includes('not supported') ||
    lower.includes('invalid type') ||
    lower.includes('invalid_type') ||
    lower.includes('expected `text`') ||
    lower.includes("expected 'text'")
  )
}

/**
 * 检测请求含图片时 API 返回的参数错误（宽松匹配）
 * 部分 API（如智谱 GLM-5）对不支持的 content 类型只返回泛化错误，
 * 不会在错误消息中提及 image_url，此函数捕获这类情况。
 * 仅在 hasImages=true 时调用，避免误伤。
 */
function isGenericParamErrorWithImages(errorMsg: string): boolean {
  const lower = errorMsg.toLowerCase()
  return (
    lower.includes('参数有误') ||
    lower.includes('invalid parameter') ||
    lower.includes('invalid_request_error') ||
    lower.includes('unrecognized request argument') ||
    lower.includes('invalid content type') ||
    lower.includes('invalid message format')
  )
}

/**
 * 检测消息列表中是否包含图片
 */
function messagesContainImages(messages: AiMessage[]): boolean {
  return messages.some(m => m.images && m.images.length > 0)
}

/**
 * 将 AiMessage 转换为 API 请求格式
 * 如果消息包含图片，content 会转为多模态数组格式（OpenAI Vision API）
 * @param stripImages 为 true 时忽略图片（用于 API 不支持视觉时的降级）
 */
function formatMessageForApi(msg: AiMessage, stripImages = false): Record<string, unknown> {
  if (msg.role === 'tool') {
    return {
      role: 'tool' as const,
      content: msg.content,
      tool_call_id: msg.tool_call_id
    }
  }
  if (msg.role === 'assistant' && msg.tool_calls) {
    const assistantMsg: Record<string, unknown> = {
      role: 'assistant' as const,
      content: msg.content || null,
      tool_calls: msg.tool_calls
    }
    if (msg.reasoning_content) {
      assistantMsg.reasoning_content = msg.reasoning_content
    }
    return assistantMsg
  }
  // user / system 消息：如果有图片且未要求剥离，转为多模态格式
  if (!stripImages && msg.images && msg.images.length > 0 && msg.role === 'user') {
    const parts: AiContentPart[] = []
    // 文本部分
    if (msg.content) {
      parts.push({ type: 'text', text: msg.content })
    }
    // 图片部分
    for (const imageUrl of msg.images) {
      parts.push({ type: 'image_url', image_url: { url: imageUrl } })
    }
    return {
      role: msg.role,
      content: parts
    }
  }
  return {
    role: msg.role,
    content: msg.content
  }
}

// === Anthropic Native API Adapter ===

function isAnthropicNativeApi(apiUrl: string): boolean {
  try {
    const url = new URL(apiUrl)
    return url.hostname === 'api.anthropic.com' && !apiUrl.includes('/chat/completions')
  } catch {
    return false
  }
}

function getRequestHeaders(profile: AiProfile): Record<string, string> {
  if (isAnthropicNativeApi(profile.apiUrl)) {
    return {
      'Content-Type': 'application/json',
      'x-api-key': profile.apiKey,
      'anthropic-version': '2023-06-01'
    }
  }
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${profile.apiKey}`
  }
}

function convertToAnthropicBody(body: Record<string, unknown>): Record<string, unknown> {
  const rawMessages = body.messages as Array<Record<string, unknown>>
  let system = ''
  const messages: Array<Record<string, unknown>> = []

  for (const msg of rawMessages) {
    const role = msg.role as string

    if (role === 'system') {
      if (system) system += '\n'
      system += (msg.content as string) || ''
      continue
    }

    if (role === 'user') {
      const images = msg.images as string[] | undefined
      if (images && images.length > 0) {
        const parts: Array<Record<string, unknown>> = []
        if (msg.content) parts.push({ type: 'text', text: msg.content })
        for (const imgUrl of images) {
          const match = imgUrl.match(/^data:(image\/[^;]+);base64,(.+)$/)
          if (match) {
            parts.push({ type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } })
          }
        }
        messages.push({ role: 'user', content: parts })
        continue
      }
      if (Array.isArray(msg.content)) {
        const parts: Array<Record<string, unknown>> = []
        for (const part of msg.content as Array<Record<string, unknown>>) {
          if (part.type === 'text') {
            parts.push({ type: 'text', text: part.text })
          } else if (part.type === 'image_url') {
            const url = (part.image_url as Record<string, unknown>)?.url as string
            const match = url?.match(/^data:(image\/[^;]+);base64,(.+)$/)
            if (match) {
              parts.push({ type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } })
            } else if (url) {
              parts.push({ type: 'image', source: { type: 'url', url } })
            }
          }
        }
        messages.push({ role: 'user', content: parts })
        continue
      }
      messages.push({ role: 'user', content: msg.content })
      continue
    }

    if (role === 'assistant') {
      const blocks: Array<Record<string, unknown>> = []
      if (msg.content) blocks.push({ type: 'text', text: msg.content })
      const tcs = msg.tool_calls as ToolCall[] | undefined
      if (tcs) {
        for (const tc of tcs) {
          let input = {}
          try { input = JSON.parse(tc.function.arguments) } catch { /* noop */ }
          blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input })
        }
      }
      if (blocks.length === 1 && blocks[0].type === 'text') {
        messages.push({ role: 'assistant', content: blocks[0].text })
      } else if (blocks.length > 0) {
        messages.push({ role: 'assistant', content: blocks })
      } else {
        messages.push({ role: 'assistant', content: [{ type: 'text', text: '' }] })
      }
      continue
    }

    if (role === 'tool') {
      const result = {
        type: 'tool_result' as const,
        tool_use_id: msg.tool_call_id as string,
        content: (msg.content as string) || ''
      }
      const last = messages[messages.length - 1]
      if (last?.role === 'user' && Array.isArray(last.content) &&
          (last.content as Array<Record<string, unknown>>).every(c => c.type === 'tool_result')) {
        (last.content as Array<Record<string, unknown>>).push(result)
      } else {
        messages.push({ role: 'user', content: [result] })
      }
      continue
    }
  }

  const result: Record<string, unknown> = {
    model: body.model,
    max_tokens: body.max_tokens || 4096,
    messages
  }
  if (system) result.system = system
  if (body.temperature !== undefined) result.temperature = body.temperature
  if (body.stream) result.stream = true

  const tools = body.tools as ToolDefinition[] | undefined
  if (tools && tools.length > 0) {
    result.tools = tools.map(td => ({
      name: td.function.name,
      description: td.function.description,
      input_schema: td.function.parameters
    }))
    if (body.tool_choice === 'auto') {
      result.tool_choice = { type: 'auto' }
    } else if (body.tool_choice === 'none') {
      result.tool_choice = { type: 'none' }
    } else if (body.tool_choice === 'required') {
      result.tool_choice = { type: 'any' }
    }
  }

  return result
}

function convertFromAnthropicResponse(resp: Record<string, unknown>): Record<string, unknown> {
  if (resp.type === 'error') {
    const err = resp.error as Record<string, unknown> | undefined
    return {
      error: {
        message: err?.message || 'Unknown Anthropic API error',
        type: err?.type,
        code: err?.type
      }
    }
  }

  const contentBlocks = resp.content as Array<Record<string, unknown>> | undefined
  let text = ''
  const toolCalls: ToolCall[] = []

  if (contentBlocks) {
    for (const block of contentBlocks) {
      if (block.type === 'text') text += (block.text as string) || ''
      else if (block.type === 'tool_use') {
        toolCalls.push({
          id: (block.id as string) || '',
          type: 'function',
          function: {
            name: (block.name as string) || '',
            arguments: JSON.stringify(block.input || {})
          }
        })
      }
    }
  }

  const message: Record<string, unknown> = { role: 'assistant', content: text || null }
  if (toolCalls.length > 0) message.tool_calls = toolCalls

  const stopReason = resp.stop_reason as string
  const finishReason = stopReason === 'tool_use' ? 'tool_calls'
    : stopReason === 'max_tokens' ? 'length' : 'stop'

  const rawUsage = resp.usage as Record<string, number> | undefined
  const usage = rawUsage ? {
    prompt_tokens: rawUsage.input_tokens ?? 0,
    completion_tokens: rawUsage.output_tokens ?? 0,
    total_tokens: (rawUsage.input_tokens ?? 0) + (rawUsage.output_tokens ?? 0)
  } : undefined

  return { choices: [{ message, finish_reason: finishReason }], usage }
}

interface AnthropicStreamDelta {
  content?: string
  reasoning_content?: string
  tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>
  finish_reason?: string
  done?: boolean
}

function parseAnthropicStreamEvent(data: string): AnthropicStreamDelta | null {
  try {
    const json = JSON.parse(data) as Record<string, unknown>
    switch (json.type) {
      case 'content_block_start': {
        const cb = json.content_block as Record<string, unknown>
        if (cb?.type === 'tool_use') {
          return {
            tool_calls: [{
              index: json.index as number,
              id: cb.id as string,
              function: { name: cb.name as string }
            }]
          }
        }
        return null
      }
      case 'content_block_delta': {
        const d = json.delta as Record<string, unknown>
        if (d?.type === 'text_delta') return { content: d.text as string }
        if (d?.type === 'input_json_delta') {
          return {
            tool_calls: [{
              index: json.index as number,
              function: { arguments: d.partial_json as string }
            }]
          }
        }
        if (d?.type === 'thinking_delta') return { reasoning_content: d.thinking as string }
        return null
      }
      case 'message_delta': {
        const d = json.delta as Record<string, unknown>
        const sr = d?.stop_reason as string
        if (sr) {
          return {
            finish_reason: sr === 'tool_use' ? 'tool_calls' : sr === 'max_tokens' ? 'length' : 'stop'
          }
        }
        return null
      }
      case 'message_stop':
        return { done: true }
      default:
        return null
    }
  } catch {
    return null
  }
}

export class AiService {
  private configService: ConfigService
  // 使用 Map 存储多个请求的 AbortController，支持多个终端同时请求
  private abortControllers: Map<string, AbortController> = new Map()

  constructor() {
    this.configService = new ConfigService()
  }

  /**
   * 中止指定请求，如果不传 requestId 则中止所有请求
   */
  abort(requestId?: string): void {
    if (requestId) {
      const controller = this.abortControllers.get(requestId)
      if (controller) {
        controller.abort()
        this.abortControllers.delete(requestId)
      }
    } else {
      // 中止所有请求
      this.abortControllers.forEach(controller => controller.abort())
      this.abortControllers.clear()
    }
  }

  /**
   * 获取代理 Agent
   */
  private getProxyAgent(proxyUrl: string): HttpsProxyAgent<string> | SocksProxyAgent | undefined {
    if (!proxyUrl) return undefined

    if (proxyUrl.startsWith('socks')) {
      return new SocksProxyAgent(proxyUrl)
    } else {
      return new HttpsProxyAgent(proxyUrl)
    }
  }

  /**
   * 获取当前 AI Profile
   */
  private async getCurrentProfile(profileId?: string): Promise<AiProfile | null> {
    const profiles = this.configService.getAiProfiles()
    if (profiles.length === 0) return null

    if (profileId) {
      return profiles.find(p => p.id === profileId) || null
    }

    const activeId = this.configService.getActiveAiProfile()
    if (activeId) {
      return profiles.find(p => p.id === activeId) || profiles[0]
    }

    return profiles[0]
  }

  /**
   * 发送聊天请求（非流式）
   */
  async chat(messages: AiMessage[], profileId?: string): Promise<string> {
    const profile = await this.getCurrentProfile(profileId)
    if (!profile) {
      throw new Error(t('error.ai_no_config'))
    }

    const startTime = Date.now()
    log.info(`Chat request: model=${profile.model}, messages=${messages.length}`)

    const requestBody = {
      model: profile.model,
      messages,
      temperature: 0.7,
      max_tokens: 2048
    }

    try {
      const data = await this.makeRequest<{
        choices?: { message?: { content?: string } }[]
        error?: { message?: string; code?: string; type?: string }
      }>(profile, requestBody)

      if (data.error) {
        const code = data.error.code?.toLowerCase() || data.error.type?.toLowerCase() || ''
        if (code === 'context_length_exceeded') {
          throw new Error(t('error.context_length_exceeded'))
        }
        throw new Error(t('error.api_request_failed', { data: data.error.message || t('error.api_error_generic') }))
      }

      const result = data.choices?.[0]?.message?.content || ''
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
      log.info(`Chat done: model=${profile.model}, duration=${elapsed}s, responseLen=${result.length}`)
      return result
    } catch (error) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
      log.error(`Chat failed: model=${profile.model}, duration=${elapsed}s, error=${error instanceof Error ? error.message : error}`)
      if (error instanceof Error) {
        if (error.message === t('error.context_length_exceeded')) {
          throw error
        }
        throw new Error(t('error.ai_request_failed', { message: translateNetworkError(error.message) }))
      }
      throw error
    }
  }

  /**
   * 发送 HTTP 请求（支持代理，带超时处理）
   */
  private makeRequest<T>(profile: AiProfile, body: object, signal?: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      const url = new URL(profile.apiUrl)
      const isHttps = url.protocol === 'https:'
      const httpModule = isHttps ? https : http

      const options: https.RequestOptions = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: getRequestHeaders(profile),
        timeout: AI_TIMEOUT.CONNECT
      }

      if (profile.proxy) {
        options.agent = this.getProxyAgent(profile.proxy)
      }

      let isCompleted = false
      const complete = (fn: () => void) => {
        if (!isCompleted) {
          isCompleted = true
          clearTimeout(totalTimeoutId)
          fn()
        }
      }

      // 总超时计时器
      const totalTimeoutId = setTimeout(() => {
        if (!isCompleted) {
          req.destroy()
          complete(() => reject(new Error(t('error.ai_total_timeout'))))
        }
      }, AI_TIMEOUT.TOTAL)

      const req = httpModule.request(options, (res) => {
        let data = ''
        
        // 设置 socket 空闲超时
        res.socket?.setTimeout(AI_TIMEOUT.SOCKET_IDLE)
        res.socket?.on('timeout', () => {
          req.destroy()
          complete(() => reject(new Error(t('error.ai_idle_timeout'))))
        })

        res.on('data', (chunk) => {
          data += chunk
        })
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            complete(() => {
              try {
                let parsed = JSON.parse(data)
                if (isAnthropicNativeApi(profile.apiUrl)) {
                  parsed = convertFromAnthropicResponse(parsed)
                }
                resolve(parsed)
              } catch {
                reject(new Error(t('error.ai_parse_failed', { data })))
              }
            })
          } else {
            complete(() => reject(new Error(t('error.api_request_failed', { data: parseApiError(data).message }))))
          }
        })
      })

      // 连接超时处理
      req.on('timeout', () => {
        req.destroy()
        complete(() => reject(new Error(t('error.ai_connection_timeout'))))
      })

      req.on('error', (err) => {
        complete(() => reject(new Error(t('error.request_error', { message: translateNetworkError(err.message) }))))
      })

      // 支持中止请求
      if (signal) {
        signal.addEventListener('abort', () => {
          req.destroy()
          complete(() => reject(new Error(t('error.request_aborted'))))
        })
      }

      const finalBody = isAnthropicNativeApi(profile.apiUrl) ? convertToAnthropicBody(body as Record<string, unknown>) : body
      req.write(JSON.stringify(finalBody))
      req.end()
    })
  }

  /**
   * 发送聊天请求（流式，支持代理）
   * 支持 think 模型（如 DeepSeek-R1）的 reasoning_content 字段
   * @param requestId 请求 ID，用于支持多个终端同时请求
   */
  async chatStream(
    messages: AiMessage[],
    onChunk: (chunk: string) => void,
    onDone: () => void,
    onError: (error: string) => void,
    profileId?: string,
    requestId?: string
  ): Promise<void> {
    const profile = await this.getCurrentProfile(profileId)
    if (!profile) {
      onError(t('error.ai_no_config'))
      return
    }

    const isAnthropic = isAnthropicNativeApi(profile.apiUrl)
    const streamStartTime = Date.now()
    log.info(`ChatStream request: model=${profile.model}, messages=${messages.length}`)

    const originalOnDone = onDone
    const originalOnError = onError
    onDone = () => {
      const elapsed = ((Date.now() - streamStartTime) / 1000).toFixed(1)
      log.info(`ChatStream done: model=${profile.model}, duration=${elapsed}s`)
      originalOnDone()
    }
    onError = (error: string) => {
      const elapsed = ((Date.now() - streamStartTime) / 1000).toFixed(1)
      log.error(`ChatStream failed: model=${profile.model}, duration=${elapsed}s, error=${error}`)
      originalOnError(error)
    }

    const requestBody = {
      model: profile.model,
      messages,
      temperature: 0.7,
      max_tokens: 2048,
      stream: true
    }

    // 创建 AbortController，使用 requestId 或生成一个唯一 ID
    const reqId = requestId || `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    const abortController = new AbortController()
    this.abortControllers.set(reqId, abortController)

    // 完成状态标记，防止重复回调
    let isCompleted = false
    const complete = (fn: () => void) => {
      if (!isCompleted) {
        isCompleted = true
        clearTimeout(totalTimeoutId)
        clearTimeout(idleTimeoutId)
        this.abortControllers.delete(reqId)
        fn()
      }
    }

    // 总超时计时器
    let totalTimeoutId: NodeJS.Timeout
    // 空闲超时计时器（收到数据后重置）
    let idleTimeoutId: NodeJS.Timeout

    const resetIdleTimeout = () => {
      clearTimeout(idleTimeoutId)
      idleTimeoutId = setTimeout(() => {
        if (!isCompleted) {
          req?.destroy()
          complete(() => onError(t('error.ai_idle_timeout')))
        }
      }, AI_TIMEOUT.SOCKET_IDLE)
    }

    let req: http.ClientRequest | undefined

    try {
      const url = new URL(profile.apiUrl)
      const isHttps = url.protocol === 'https:'
      const httpModule = isHttps ? https : http

      const options: https.RequestOptions = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: getRequestHeaders(profile),
        timeout: AI_TIMEOUT.CONNECT
      }

      if (profile.proxy) {
        options.agent = this.getProxyAgent(profile.proxy)
      }

      totalTimeoutId = setTimeout(() => {
        if (!isCompleted) {
          req?.destroy()
          complete(() => onError(t('error.ai_total_timeout')))
        }
      }, AI_TIMEOUT.TOTAL)

      let hasReasoningOutput = false
      let hasContentOutput = false

      req = httpModule.request(options, (res) => {
        // 开始接收响应，启动空闲超时
        resetIdleTimeout()

        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
          let errorData = ''
          res.on('data', (chunk) => { 
            errorData += chunk
            resetIdleTimeout()
          })
          res.on('end', () => {
            // 尝试解析 JSON 提取结构化错误信息
            const parsed = parseApiError(errorData)
            if (parsed.code === 'context_length_exceeded') {
              complete(() => onError(t('error.context_length_exceeded')))
            } else {
              complete(() => onError(t('error.api_request_failed', { data: parsed.message })))
            }
          })
          return
        }

        let buffer = ''

        res.on('data', (chunk: Buffer) => {
          // 收到数据，重置空闲超时
          resetIdleTimeout()

          buffer += chunk.toString()
          const lines = buffer.split('\n')
          // 保留最后一个可能不完整的行
          buffer = lines.pop() || ''

          for (const line of lines) {
            const trimmedLine = line.trim()
            if (!trimmedLine) continue

            if (trimmedLine.startsWith('data: ')) {
              const data = trimmedLine.slice(6).trim()
              if (!data) continue

              let delta: { content?: string; reasoning_content?: string } | undefined
              let isDone = false

              if (isAnthropic) {
                const event = parseAnthropicStreamEvent(data)
                if (!event) continue
                isDone = !!event.done
                delta = event
              } else {
                if (data === '[DONE]') {
                  isDone = true
                } else {
                  try {
                    const json = JSON.parse(data)
                    delta = json.choices?.[0]?.delta
                  } catch { continue }
                }
              }

              if (isDone) {
                if (hasReasoningOutput && !hasContentOutput) {
                  onChunk('\n\n</details>\n')
                }
                complete(() => onDone())
                return
              }

              if (delta?.reasoning_content) {
                if (!hasReasoningOutput) {
                  hasReasoningOutput = true
                  onChunk('<details open>\n<summary>🤔 <strong>思考过程</strong>（点击折叠）</summary>\n\n<blockquote>\n\n')
                }
                onChunk(delta.reasoning_content)
              }

              if (delta?.content) {
                if (hasReasoningOutput && !hasContentOutput) {
                  hasContentOutput = true
                  onChunk('\n\n</blockquote>\n</details>\n\n---\n\n### 💬 回复\n\n')
                }
                onChunk(delta.content)
              }
            }
          }
        })

        res.on('end', () => {
          complete(() => onDone())
        })

        res.on('error', (err) => {
          complete(() => onError(t('error.ai_response_error', { message: translateNetworkError(err.message) })))
        })
      })

      // 连接超时处理
      req.on('timeout', () => {
        req?.destroy()
        complete(() => onError(t('error.ai_connection_timeout')))
      })

      req.on('error', (err) => {
        // 检查是否是中止错误（可能是原始消息或国际化后的消息）
        if (err.message === t('error.request_aborted') || err.message.includes('aborted')) {
          complete(() => onDone())
          return
        }
        complete(() => onError(t('error.request_error', { message: translateNetworkError(err.message) })))
      })

      // 支持中止请求
      abortController.signal.addEventListener('abort', () => {
        req?.destroy()
        complete(() => onDone())
      })

      const chatStreamBody = isAnthropic ? convertToAnthropicBody(requestBody as Record<string, unknown>) : requestBody
      req.write(JSON.stringify(chatStreamBody))
      req.end()
    } catch (error) {
      if (error instanceof Error) {
        complete(() => onError(t('error.ai_request_failed', { message: translateNetworkError(error.message) })))
      } else {
        complete(() => onError(t('error.ai_request_failed_unknown')))
      }
    }
  }

  /**
   * 发送带工具调用的聊天请求（非流式）
   * 用于 Agent 模式，支持 function calling
   */
  async chatWithTools(
    messages: AiMessage[],
    tools: ToolDefinition[],
    profileId?: string
  ): Promise<ChatWithToolsResult> {
    const profile = await this.getCurrentProfile(profileId)
    if (!profile) {
      throw new Error(t('error.ai_no_config'))
    }

    const startTime = Date.now()
    log.info(`ChatWithTools request: model=${profile.model}, messages=${messages.length}, tools=${tools.length}`)

    const hasImages = messagesContainImages(messages)

    const doRequest = async (stripImages: boolean): Promise<ChatWithToolsResult> => {
      const fmtMessages = messages.map(msg => formatMessageForApi(msg, stripImages))

      const body = {
        model: profile.model,
        messages: fmtMessages,
        tools: tools.length > 0 ? tools : undefined,
        tool_choice: tools.length > 0 ? 'auto' : undefined,
        parallel_tool_calls: tools.length > 0 ? true : undefined,
        temperature: 0.7,
        max_tokens: profile.maxOutputTokens || 8192
      }

      let data: {
        choices?: {
          message?: {
            content?: string | null
            tool_calls?: ToolCall[]
          }
          finish_reason?: string
        }[]
        error?: { message?: string; code?: string; type?: string }
      }

      try {
        data = await this.makeRequest(profile, body)
      } catch (err) {
        if (!stripImages && hasImages && err instanceof Error &&
            (isVisionNotSupportedError(err.message) || isGenericParamErrorWithImages(err.message))) {
          log.warn(`Model ${profile.model} may not support images (error: ${err.message}), retrying without images`)
          return doRequest(true)
        }
        throw err
      }

      if (data.error) {
        const code = data.error.code?.toLowerCase() || data.error.type?.toLowerCase() || ''
        if (code === 'context_length_exceeded') {
          throw new Error(t('error.context_length_exceeded'))
        }
        const errorMsg = data.error.message || t('error.api_error_generic')
        if (!stripImages && hasImages &&
            (isVisionNotSupportedError(errorMsg) || isGenericParamErrorWithImages(errorMsg))) {
          log.warn(`Model ${profile.model} may not support images (error: ${errorMsg}), retrying without images`)
          return doRequest(true)
        }
        throw new Error(t('error.api_request_failed', { data: errorMsg }))
      }

      const choice = data.choices?.[0]
      if (!choice) {
        throw new Error(t('error.ai_empty_response'))
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
      const toolNames = choice.message?.tool_calls?.map(tc => tc.function.name).join(', ') || ''
      log.info(`ChatWithTools done: model=${profile.model}, duration=${elapsed}s, finish=${choice.finish_reason}, tools=[${toolNames}]`)

      return {
        content: choice.message?.content || undefined,
        tool_calls: choice.message?.tool_calls,
        finish_reason: choice.finish_reason as ChatWithToolsResult['finish_reason']
      }
    }

    try {
      return await doRequest(false)
    } catch (error) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
      log.error(`ChatWithTools failed: model=${profile.model}, duration=${elapsed}s, error=${error instanceof Error ? error.message : error}`)
      if (error instanceof Error) {
        if (error.message === t('error.context_length_exceeded')) {
          throw error
        }
        throw new Error(t('error.ai_request_failed', { message: translateNetworkError(error.message) }))
      }
      throw error
    }
  }

  /**
   * 带工具的聊天（流式）
   * 用于 Agent 模式，支持 function calling 和流式输出
   * 支持 think 模型（如 DeepSeek-R1）的 reasoning_content 字段
   */
  async chatWithToolsStream(
    messages: AiMessage[],
    tools: ToolDefinition[],
    onChunk: (chunk: string) => void,
    onToolCall: (toolCalls: ToolCall[]) => void,
    onDone: (result: ChatWithToolsResult) => void,
    onError: (error: string) => void,
    profileId?: string,
    onToolCallProgress?: (toolName: string, argsLength: number) => void,  // 工具调用参数生成进度
    requestId?: string  // 用于支持中止请求
  ): Promise<void> {
    const profile = await this.getCurrentProfile(profileId)
    if (!profile) {
      onError(t('error.ai_no_config'))
      return
    }

    const isAnthropic = isAnthropicNativeApi(profile.apiUrl)

    // 创建 AbortController，使用 requestId 或生成一个唯一 ID
    const reqId = requestId || `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    const abortController = new AbortController()
    this.abortControllers.set(reqId, abortController)

    const startTime = Date.now()
    log.info(`Request started: model=${profile.model}, messages=${messages.length}, tools=${tools.length}`)

    // AI Debug: 记录请求开始
    getAiDebugService().logRequestStart(reqId, {
      profileId: profile.id,
      model: profile.model,
      messages: messages.map(m => ({
        role: m.role,
        content: m.content,
        tool_call_id: m.tool_call_id,
        tool_calls: m.tool_calls
      })),
      tools
    })

    // 完成状态标记，防止重复回调
    let isCompleted = false
    // 总超时计时器
    let totalTimeoutId: NodeJS.Timeout
    // 空闲超时计时器（收到数据后重置）
    let idleTimeoutId: NodeJS.Timeout
    // 请求对象引用
    let req: http.ClientRequest | undefined
    // 重试计数器
    let retryCount = 0
    // Rate limit 重试计数器（独立于网络错误重试）
    let rateLimitRetryCount = 0
    // 5xx 服务端错误重试计数器（独立于网络错误重试）
    let serverErrorRetryCount = 0

    // 收集的数据
    let content = ''
    let reasoningContent = ''  // 用于收集 think 模型的思考内容
    let toolCalls: ToolCall[] = []
    let finishReason: string | undefined

    const complete = (fn: () => void) => {
      if (!isCompleted) {
        isCompleted = true
        clearTimeout(totalTimeoutId)
        clearTimeout(idleTimeoutId)
        this.abortControllers.delete(reqId)
        fn()
      }
    }

    // 重置状态以便重试
    const resetForRetry = () => {
      isCompleted = false
      clearTimeout(totalTimeoutId)
      clearTimeout(idleTimeoutId)
      content = ''
      reasoningContent = ''
      toolCalls = []
      finishReason = undefined
      req = undefined
    }

    const resetIdleTimeout = () => {
      clearTimeout(idleTimeoutId)
      idleTimeoutId = setTimeout(() => {
        if (!isCompleted) {
          req?.destroy()
          if (!tryRetry('ETIMEDOUT', doRequest)) {
            complete(() => onError(t('error.ai_idle_timeout')))
          }
        }
      }, AI_TIMEOUT.SOCKET_IDLE)
    }

    // 视觉降级标记：API 不支持 image_url 时自动剥离图片重试
    let stripImages = false
    const hasImages = messagesContainImages(messages)

    const rebuildRequestBody = () => {
      const fmtMsgs = messages.map(msg => formatMessageForApi(msg, stripImages))
      return {
        model: profile.model,
        messages: fmtMsgs,
        tools: tools.length > 0 ? tools : undefined,
        tool_choice: tools.length > 0 ? 'auto' : undefined,
        parallel_tool_calls: tools.length > 0 ? true : undefined,
        temperature: 0.7,
        max_tokens: profile.maxOutputTokens || 8192,
        stream: true
      }
    }

    let requestBody = rebuildRequestBody()

    // 视觉降级重试：剥离图片后重新请求（最多触发一次）
    const tryVisionFallback = (errorMsg: string): boolean => {
      if (!stripImages && hasImages &&
          (isVisionNotSupportedError(errorMsg) || isGenericParamErrorWithImages(errorMsg))) {
        log.warn(`Model ${profile.model} may not support images (error: ${errorMsg}), retrying without images`)
        stripImages = true
        requestBody = rebuildRequestBody()
        resetForRetry()
        doRequest()
        return true
      }
      return false
    }

    // 尝试重试的辅助函数
    const tryRetry = (errorMsg: string, doRequest: () => void): boolean => {
      if (retryCount < AI_RETRY.MAX_RETRIES && isRetryableError(errorMsg)) {
        retryCount++
        const retryMsg = `⚠️ 网络错误，正在重试 (${retryCount}/${AI_RETRY.MAX_RETRIES})...`
        onChunk(retryMsg + '\n')
        getAiDebugService().logResponseError(reqId, `${errorMsg} - 准备重试 ${retryCount}/${AI_RETRY.MAX_RETRIES}`)
        resetForRetry()
        setTimeout(doRequest, AI_RETRY.RETRY_DELAY)
        return true
      }
      return false
    }

    const doRequest = () => {
    try {
      const url = new URL(profile.apiUrl)
      const isHttps = url.protocol === 'https:'
      const httpModule = isHttps ? https : http

      const options: https.RequestOptions = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: getRequestHeaders(profile),
        timeout: AI_TIMEOUT.CONNECT
      }

      if (profile.proxy) {
        options.agent = this.getProxyAgent(profile.proxy)
      }

      totalTimeoutId = setTimeout(() => {
        if (!isCompleted) {
          req?.destroy()
          complete(() => onError(t('error.ai_total_timeout')))
        }
      }, AI_TIMEOUT.TOTAL)

      let hasReasoningOutput = false
      let hasContentOutput = false

      req = httpModule.request(options, (res) => {
        // 开始接收响应，启动空闲超时
        resetIdleTimeout()

        // 处理 HTTP 错误
        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
          let errorData = ''
          res.on('data', (chunk) => { 
            errorData += chunk
            resetIdleTimeout()
          })
          res.on('end', () => {
            const parsed = parseApiError(errorData)
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
            log.error(`Request HTTP error: model=${profile.model}, status=${res.statusCode}, duration=${elapsed}s, error=${parsed.message.slice(0, 200)}`)
            if (res.statusCode === 429 && rateLimitRetryCount < AI_RETRY.RATE_LIMIT_MAX_RETRIES) {
              // Rate limit: 指数退避重试，优先使用 Retry-After header
              rateLimitRetryCount++
              const retryAfterHeader = res.headers['retry-after']
              const defaultBackoff = AI_RETRY.RATE_LIMIT_BASE_DELAY * Math.pow(2, rateLimitRetryCount - 1)
              let retryAfterMs = defaultBackoff
              if (retryAfterHeader) {
                const seconds = Number(retryAfterHeader)
                if (!isNaN(seconds) && seconds > 0) {
                  retryAfterMs = seconds * 1000
                } else {
                  // Retry-After 也可以是 HTTP 日期格式（RFC 1123）
                  const date = Date.parse(retryAfterHeader)
                  if (!isNaN(date)) {
                    retryAfterMs = Math.max(1000, date - Date.now())
                  }
                }
              }
              const retryAfterSec = (retryAfterMs / 1000).toFixed(0)
              log.warn(`Rate limited (429), retrying in ${retryAfterSec}s (${rateLimitRetryCount}/${AI_RETRY.RATE_LIMIT_MAX_RETRIES})`)
              onChunk(`⚠️ ${t('error.rate_limited', { seconds: retryAfterSec, attempt: String(rateLimitRetryCount), max: String(AI_RETRY.RATE_LIMIT_MAX_RETRIES) })}\n`)
              getAiDebugService().logResponseError(reqId, `429 Rate Limited - retry ${rateLimitRetryCount}/${AI_RETRY.RATE_LIMIT_MAX_RETRIES} in ${retryAfterSec}s`)
              resetForRetry()
              setTimeout(doRequest, retryAfterMs)
            } else if (parsed.code === 'context_length_exceeded') {
              complete(() => onError(t('error.context_length_exceeded')))
            } else if (res.statusCode && AI_RETRY.RETRYABLE_STATUS_CODES.includes(res.statusCode) && serverErrorRetryCount < AI_RETRY.SERVER_ERROR_MAX_RETRIES) {
              serverErrorRetryCount++
              const delay = AI_RETRY.SERVER_ERROR_BASE_DELAY * Math.pow(2, serverErrorRetryCount - 1)
              const delaySec = (delay / 1000).toFixed(0)
              log.warn(`Server error (${res.statusCode}), retrying in ${delaySec}s (${serverErrorRetryCount}/${AI_RETRY.SERVER_ERROR_MAX_RETRIES})`)
              onChunk(`⚠️ ${t('error.server_error_retry', { status: String(res.statusCode), seconds: delaySec, attempt: String(serverErrorRetryCount), max: String(AI_RETRY.SERVER_ERROR_MAX_RETRIES) })}\n`)
              getAiDebugService().logResponseError(reqId, `${res.statusCode} Server Error - retry ${serverErrorRetryCount}/${AI_RETRY.SERVER_ERROR_MAX_RETRIES} in ${delaySec}s`)
              resetForRetry()
              setTimeout(doRequest, delay)
            } else if (tryVisionFallback(parsed.message)) {
              // 已降级重试
            } else {
              complete(() => onError(t('error.api_request_failed', { data: parsed.message })))
            }
          })
          return
        }

        let buffer = ''

        res.on('data', (chunk: Buffer) => {
          // 收到数据，重置空闲超时
          resetIdleTimeout()

          // 检查是否已被 abort，立即停止处理
          if (abortController.signal.aborted || isCompleted) {
            return
          }

          buffer += chunk.toString()
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''

          for (const line of lines) {
            if (abortController.signal.aborted || isCompleted) return
            if (line.startsWith('data: ')) {
              const data = line.slice(6).trim()
              if (!data) continue

              let delta: AnthropicStreamDelta | { content?: string; reasoning_content?: string; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> } | undefined
              let reason: string | undefined
              let isDone = false

              if (isAnthropic) {
                const event = parseAnthropicStreamEvent(data)
                if (!event) continue
                isDone = !!event.done
                delta = event
                reason = event.finish_reason
              } else {
                if (data === '[DONE]') {
                  isDone = true
                } else {
                  try {
                    const json = JSON.parse(data)
                    delta = json.choices?.[0]?.delta
                    reason = json.choices?.[0]?.finish_reason
                  } catch { continue }
                }
              }

              if (reason) finishReason = reason

              if (isDone) {
                const finalContent = content || (reasoningContent ? `🤔 **思考过程**\n\n> ${reasoningContent.replace(/\n/g, '\n> ')}` : undefined)
                complete(() => onDone({
                  content: finalContent,
                  tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
                  finish_reason: finishReason as ChatWithToolsResult['finish_reason'],
                  reasoning_content: reasoningContent || undefined
                }))
                return
              }

              if (delta?.reasoning_content) {
                if (!hasReasoningOutput) {
                  hasReasoningOutput = true
                  onChunk(t('ai.thinking_with_emoji'))
                }
                reasoningContent += delta.reasoning_content
                onChunk(delta.reasoning_content.replace(/\n/g, '\n> '))
                getAiDebugService().logResponseChunk(reqId, `[THINKING] ${delta.reasoning_content}`)
              }

              if (delta?.content) {
                if (hasReasoningOutput && !hasContentOutput) {
                  hasContentOutput = true
                  onChunk('\n\n---\n\n**回复：** ')
                }
                content += delta.content
                onChunk(delta.content)
                getAiDebugService().logResponseChunk(reqId, delta.content)
              }

              if (delta?.tool_calls) {
                if (hasReasoningOutput && !hasContentOutput) {
                  hasContentOutput = true
                  onChunk('\n\n')
                }
                for (const tc of delta.tool_calls) {
                  const index = tc.index ?? 0
                  if (!toolCalls[index]) {
                    toolCalls[index] = {
                      id: tc.id || '',
                      type: 'function',
                      function: {
                        name: tc.function?.name || '',
                        arguments: tc.function?.arguments || ''
                      }
                    }
                  } else {
                    if (tc.id) toolCalls[index].id = tc.id
                    if (tc.function?.name) toolCalls[index].function.name = tc.function.name
                    if (tc.function?.arguments) toolCalls[index].function.arguments += tc.function.arguments
                  }
                  if (onToolCallProgress && toolCalls[index]) {
                    onToolCallProgress(toolCalls[index].function.name, toolCalls[index].function.arguments.length)
                  }
                }
              }
            }
          }
        })

        res.on('end', () => {
          // 流结束但未收到 [DONE] 或 finish_reason：检测不完整的 tool calls
          // 某些 API 在 max_tokens 截断时可能不发送 finish_reason 就断流
          if (!finishReason && toolCalls.length > 0) {
            const hasIncomplete = toolCalls.some(tc => {
              if (!tc.function.arguments) return true
              try { JSON.parse(tc.function.arguments); return false }
              catch (e) { if (e instanceof SyntaxError) return true; throw e }
            })
            if (hasIncomplete) {
              finishReason = 'length'
              log.warn(`Stream ended without finish_reason but has incomplete tool_calls, treating as length truncation`)
            }
          }

          // 如果有思考内容但没有最终内容，把思考内容作为最终内容
          const finalContent = content || (reasoningContent ? `🤔 **思考过程**\n\n> ${reasoningContent.replace(/\n/g, '\n> ')}` : undefined)

          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
          const toolNames = toolCalls.map(tc => tc.function.name).join(', ')
          log.info(`Request done: model=${profile.model}, duration=${elapsed}s, finish=${finishReason || 'end'}, tools=[${toolNames}], contentLen=${(finalContent || '').length}`)

          // AI Debug: 记录响应完成（包含工具调用）
          getAiDebugService().logResponseDone(reqId, {
            response: finalContent,
            reasoningContent: reasoningContent || undefined,
            finishReason,
            toolCalls: toolCalls.length > 0 ? toolCalls.map(tc => ({
              id: tc.id,
              name: tc.function.name,
              arguments: tc.function.arguments
            })) : undefined
          })
          // 如果有工具调用，通知回调
          if (toolCalls.length > 0) {
            onToolCall(toolCalls)
          }
          complete(() => onDone({
            content: finalContent,
            tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
            finish_reason: finishReason as ChatWithToolsResult['finish_reason'],
            reasoning_content: reasoningContent || undefined
          }))
        })

        res.on('error', (err) => {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
          log.error(`Request failed: model=${profile.model}, duration=${elapsed}s, error=${err.message}`)
          getAiDebugService().logResponseError(reqId, err.message)
          complete(() => onError(t('error.request_error', { message: translateNetworkError(err.message) })))
        })
      })

      // 连接超时处理
      req.on('timeout', () => {
        req?.destroy()
        if (!tryRetry('ETIMEDOUT', doRequest)) {
          const errorMsg = t('error.ai_connection_timeout')
          getAiDebugService().logResponseError(reqId, errorMsg)
          complete(() => onError(errorMsg))
        }
      })

      req.on('error', (err) => {
        // 如果是中止导致的错误，不报错
        if (err.message === 'aborted' || err.message.includes('socket hang up')) {
          getAiDebugService().logResponseDone(reqId, { finishReason: 'aborted' })
          complete(() => onDone({
            content: undefined,
            tool_calls: undefined,
            finish_reason: 'stop'
          }))
          return
        }
        if (tryVisionFallback(err.message)) return
        // 尝试重试网络错误
        if (!tryRetry(err.message, doRequest)) {
          getAiDebugService().logResponseError(reqId, err.message)
          complete(() => onError(t('error.request_error', { message: translateNetworkError(err.message) })))
        }
      })

      // 支持中止请求
      abortController.signal.addEventListener('abort', () => {
        req?.destroy()
        const filteredCount = toolCalls.length
        const validToolCalls = toolCalls.filter(tc => {
          if (!tc.id || !tc.function.name || !tc.function.arguments) return false
          try { JSON.parse(tc.function.arguments); return true }
          catch (e) { if (e instanceof SyntaxError) return false; throw e }
        })
        if (validToolCalls.length < filteredCount) {
          log.info(`Abort: filtered ${filteredCount - validToolCalls.length}/${filteredCount} incomplete tool_calls`)
        }
        const finalContent = content || (reasoningContent ? `🤔 **思考过程**\n\n> ${reasoningContent.replace(/\n/g, '\n> ')}` : undefined)
        complete(() => onDone({
          content: finalContent,
          tool_calls: validToolCalls.length > 0 ? validToolCalls : undefined,
          finish_reason: 'stop',
          reasoning_content: reasoningContent || undefined
        }))
      })

      const toolStreamBody = isAnthropic ? convertToAnthropicBody(requestBody as Record<string, unknown>) : requestBody
      req.write(JSON.stringify(toolStreamBody))
      req.end()
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error'
      if (tryVisionFallback(errorMsg)) return
      // 尝试重试网络错误
      if (!tryRetry(errorMsg, doRequest)) {
        getAiDebugService().logResponseError(reqId, `Exception: ${errorMsg}`)
        if (error instanceof Error) {
          complete(() => onError(t('error.ai_request_failed', { message: translateNetworkError(error.message) })))
        } else {
          complete(() => onError(t('error.ai_request_failed_unknown')))
        }
      }
    }
    }  // end of doRequest

    // 开始执行请求
    doRequest()
  }

  /**
   * 生成命令解释的 prompt
   */
  static getExplainCommandPrompt(command: string): AiMessage[] {
    return [
      {
        role: 'system',
        content:
          '你是一个专业的 Linux/Unix 系统管理员助手。用户会给你一个命令，请用中文简洁地解释这个命令的作用、参数含义，以及可能的注意事项。'
      },
      {
        role: 'user',
        content: `请解释这个命令：\n\`\`\`\n${command}\n\`\`\``
      }
    ]
  }

  /**
   * 生成错误诊断的 prompt
   */
  static getDiagnoseErrorPrompt(error: string, context?: string): AiMessage[] {
    return [
      {
        role: 'system',
        content:
          '你是一个专业的运维工程师助手。用户会给你一个错误信息，请用中文分析错误原因，并提供可能的解决方案。'
      },
      {
        role: 'user',
        content: `请分析这个错误并提供解决方案：\n\`\`\`\n${error}\n\`\`\`${context ? `\n\n上下文信息：\n${context}` : ''}`
      }
    ]
  }

  /**
   * 生成自然语言转命令的 prompt
   */
  static getNaturalToCommandPrompt(description: string, os?: string): AiMessage[] {
    return [
      {
        role: 'system',
        content: `你是一个专业的命令行助手。用户会用自然语言描述他想做的事情，请生成对应的命令。${os ? `当前操作系统是 ${os}。` : ''}请只返回命令本身，如果有多个命令请用换行分隔，不需要额外解释。`
      },
      {
        role: 'user',
        content: description
      }
    ]
  }
}

