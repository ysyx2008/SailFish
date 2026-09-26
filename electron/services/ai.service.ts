import { ConfigService, getConfigService } from './config.service'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'
import * as https from 'https'
import * as http from 'http'
import { t } from './agent/i18n'
import { stripCompositionMarkers } from './agent/context-composition'
import { getAiDebugService } from './ai-debug.service'
import type { ProviderChatParams } from './plugin/types'
import { createLogger } from '../utils/logger'
import { toSendableVisionImageUrl } from '../utils/vision-image'
import {
  ACCOUNT_BILLING_CODES,
  classifyFailoverTrigger,
  isAccountBillingError,
  listFailoverCandidates,
  normalizeApiErrorCode,
  type AiModelFailoverNotice,
  type FailoverTrigger,
} from './ai-model-failover'

export type { AiModelFailoverNotice } from './ai-model-failover'

const log = createLogger('AI')

// AI 请求超时配置（毫秒）
const AI_TIMEOUT = {
  CONNECT: 30 * 1000,        // 连接超时：30 秒（火山引擎等中转服务需要更长连接时间）
  SOCKET_IDLE: 120 * 1000,   // 空闲超时：120 秒（流式请求中数据流中断检测）
  TOTAL: 10 * 60 * 1000      // 总超时：10 分钟（长文本生成可能需要较长时间）
}

// 网络错误自动重试配置
const AI_RETRY = {
  MAX_RETRIES: 3,            // 网络错误最大重试次数
  BASE_DELAY: 2000,          // 网络错误基础退避：2 秒
  RATE_LIMIT_MAX_RETRIES: 5, // Rate limit 最大重试次数
  RATE_LIMIT_BASE_DELAY: 5000, // Rate limit 基础退避：5 秒
  SERVER_ERROR_MAX_RETRIES: 3, // 5xx 服务端错误最大重试次数
  SERVER_ERROR_BASE_DELAY: 3000, // 5xx 基础退避：3 秒
  MAX_DELAY_MS: 60000,       // 单次重试最大延迟：60 秒（防止指数退避无限增长）
  MAX_RETRY_AFTER_MS: 120000, // Retry-After 最大接受值：120 秒（超过则不重试）
  JITTER_FACTOR: 0.2,        // 退避抖动因子（±20%），避免 thundering herd
  // Node.js 系统错误码（err.code，稳定常量）。含 EPROTO：代理/VPN 切换时 TLS 握手失败常见
  RETRYABLE_ERROR_CODES: ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED', 'EPIPE', 'EAI_AGAIN', 'EPROTO'] as const,
  // 无稳定 code、但 Node 会写入 message 的瞬时网络故障短语
  RETRYABLE_ERROR_MESSAGES: ['socket hang up'] as const,
  // 可重试的 HTTP 状态码（服务端临时错误）
  RETRYABLE_STATUS_CODES: [500, 502, 503, 529] as readonly number[]
}

/** 网络错误判定输入：字符串（兼容 'ETIMEDOUT'）或带 code/message 的 Error */
type NetworkErrorLike = string | { message?: string; code?: string }

function getNetworkErrorMessage(error: NetworkErrorLike): string {
  return typeof error === 'string' ? error : (error.message ?? '')
}

function getNetworkErrorCode(error: NetworkErrorLike): string {
  return typeof error === 'string' ? '' : (error.code ?? '')
}

/**
 * 是否为可自动重试的瞬时网络错误。
 * 优先看 err.code（Node 系统错误码）；TLS 握手中断时 message 往往是
 * "Client network socket disconnected before secure TLS connection was established"
 * 不含 ECONNRESET 字样，但 code 仍为 ECONNRESET——只匹配 message 会漏掉重试。
 */
export function isRetryableError(error: NetworkErrorLike): boolean {
  const code = getNetworkErrorCode(error)
  if (code && (AI_RETRY.RETRYABLE_ERROR_CODES as readonly string[]).includes(code)) {
    return true
  }
  const message = getNetworkErrorMessage(error)
  return (
    AI_RETRY.RETRYABLE_ERROR_CODES.some(c => message.includes(c)) ||
    AI_RETRY.RETRYABLE_ERROR_MESSAGES.some(m => message.includes(m))
  )
}

function isTimeoutError(error: NetworkErrorLike): boolean {
  return getNetworkErrorCode(error) === 'ETIMEDOUT' || getNetworkErrorMessage(error).includes('ETIMEDOUT')
}

/**
 * 计算带 jitter 的指数退避延迟
 * delay = baseDelay * 2^attempt * (1 ± jitterFactor)
 */
function calculateBackoff(baseDelay: number, attempt: number): number {
  const expDelay = baseDelay * Math.pow(2, attempt)
  const jitter = expDelay * AI_RETRY.JITTER_FACTOR * (2 * Math.random() - 1)
  // 加上限，防止指数退避无限增长导致资源耗尽
  return Math.min(AI_RETRY.MAX_DELAY_MS, Math.max(0, Math.round(expDelay + jitter)))
}

/**
 * AI API 请求错误分类
 */
interface ApiRequestError extends Error {
  statusCode?: number
  retryAfter?: number
  apiErrorCode?: string
  /** Node.js 系统错误码（ECONNRESET / EPROTO 等），toApiRequestError 保留原 Error 时自带 */
  code?: string
}

/**
 * 重试上下文（通过 onRetry 回调传递给调用方，便于在 UI 上展示「自动重试中」提示）
 */
export interface RetryInfo {
  /** 当前是第几次重试（从 1 开始） */
  attempt: number
  /** 该类错误允许的最大重试次数 */
  max: number
  /** 距下次请求的等待毫秒数 */
  delayMs: number
  /** 触发重试的原因 */
  reason: 'network' | 'rate_limit' | 'server_error'
  /** HTTP 状态码（rate_limit / server_error 才有） */
  statusCode?: number
  /** 网络错误里把超时单独标出来，方便界面说「请求超时」而不是笼统的「网络异常」 */
  cause?: 'timeout'
}

function toApiRequestError(err: unknown, statusCode?: number, headers?: Record<string, string | string[] | undefined>, apiErrorCode?: string): ApiRequestError {
  const error = (err instanceof Error ? err : new Error(String(err))) as ApiRequestError
  error.statusCode = statusCode
  error.apiErrorCode = normalizeApiErrorCode(apiErrorCode)
  if (statusCode === 429 && headers?.['retry-after']) {
    const raw = String(headers['retry-after'])
    const seconds = Number(raw)
    if (!isNaN(seconds) && seconds > 0) {
      error.retryAfter = seconds * 1000
    } else {
      const date = Date.parse(raw)
      if (!isNaN(date)) {
        error.retryAfter = Math.max(1000, date - Date.now())
      }
    }
  }
  return error
}

/**
 * 通用 AI API 重试包装器
 * 对 Promise 类请求（chat / chatWithTools / makeRequest）提供统一的重试策略：
 * - 网络错误：指数退避 + jitter
 * - 429 Rate Limit：优先 Retry-After，否则指数退避
 * - 5xx 服务端错误：指数退避
 * - context_length_exceeded / 其他 4xx：不重试
 */
async function withApiRetry<T>(
  fn: () => Promise<T>,
  options?: {
    /** 覆盖网络错误最大重试次数 */
    maxRetries?: number
    /** 不重试的错误码 */
    noRetryErrorCodes?: string[]
    /** 重试前回调 */
    onRetry?: (attempt: number, delay: number, reason: string) => void
  }
): Promise<T> {
  const maxRetries = options?.maxRetries ?? AI_RETRY.MAX_RETRIES
  const noRetryCodes = new Set((options?.noRetryErrorCodes ?? NO_RETRY_BUSINESS_CODES).map(c => c.toLowerCase()))
  let networkAttempt = 0
  let rateLimitAttempt = 0
  let serverErrorAttempt = 0

  const _retry = async (): Promise<T> => {
    try {
      return await fn()
    } catch (err) {
      const apiErr = err as ApiRequestError

      // 不重试的业务错误（欠费 / 鉴权等）。码先归一成小写，避免 ArrearsError 对不上 arrearserror
      if (isAccountBillingError(apiErr.apiErrorCode, apiErr.statusCode)) {
        throw apiErr
      }
      const businessCode = normalizeApiErrorCode(apiErr.apiErrorCode)
      if (businessCode && noRetryCodes.has(businessCode)) {
        throw apiErr
      }

      // 429 Rate Limit（账户欠费有的厂商也回 429，上面已经排除）
      if (apiErr.statusCode === 429 && rateLimitAttempt < AI_RETRY.RATE_LIMIT_MAX_RETRIES) {
        rateLimitAttempt++
        const rawDelay = apiErr.retryAfter ?? calculateBackoff(AI_RETRY.RATE_LIMIT_BASE_DELAY, rateLimitAttempt - 1)
        // 限制 Retry-After 最大值，防止服务器返回过大值导致长时间阻塞
        const delay = Math.min(AI_RETRY.MAX_RETRY_AFTER_MS, rawDelay)
        if (rawDelay > AI_RETRY.MAX_RETRY_AFTER_MS) {
          log.warn(`Retry-After ${rawDelay}ms exceeds cap, using ${AI_RETRY.MAX_RETRY_AFTER_MS}ms`)
        }
        log.warn(`Rate limited (429), retry ${rateLimitAttempt}/${AI_RETRY.RATE_LIMIT_MAX_RETRIES} in ${(delay / 1000).toFixed(1)}s`)
        options?.onRetry?.(rateLimitAttempt, delay, '429')
        await new Promise(resolve => setTimeout(resolve, delay))
        return _retry()
      }

      // 5xx 服务端错误
      if (apiErr.statusCode && AI_RETRY.RETRYABLE_STATUS_CODES.includes(apiErr.statusCode) &&
          serverErrorAttempt < AI_RETRY.SERVER_ERROR_MAX_RETRIES) {
        serverErrorAttempt++
        const delay = calculateBackoff(AI_RETRY.SERVER_ERROR_BASE_DELAY, serverErrorAttempt - 1)
        log.warn(`Server error (${apiErr.statusCode}), retry ${serverErrorAttempt}/${AI_RETRY.SERVER_ERROR_MAX_RETRIES} in ${(delay / 1000).toFixed(1)}s`)
        options?.onRetry?.(serverErrorAttempt, delay, String(apiErr.statusCode))
        await new Promise(resolve => setTimeout(resolve, delay))
        return _retry()
      }

      // 网络错误（看 err.code + message；TLS 握手中断时常只有 code=ECONNRESET）
      if (isRetryableError(apiErr) && networkAttempt < maxRetries) {
        networkAttempt++
        const delay = calculateBackoff(AI_RETRY.BASE_DELAY, networkAttempt - 1)
        const detail = [getNetworkErrorCode(apiErr), getNetworkErrorMessage(apiErr)].filter(Boolean).join(' ').slice(0, 80)
        log.warn(`Network error (${detail}), retry ${networkAttempt}/${maxRetries} in ${(delay / 1000).toFixed(1)}s`)
        options?.onRetry?.(networkAttempt, delay, 'network')
        await new Promise(resolve => setTimeout(resolve, delay))
        return _retry()
      }

      throw apiErr
    }
  }

  return _retry()
}

/**
 * 将 Node.js 网络错误翻译为用户可读的界面语言。
 * 优先用 err.code（稳定常量）；TLS 握手断开等场景 message 不含错误码。
 */
const NET_ERROR_CODES = ['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'EPROTO'] as const

function translateNetworkError(err: NetworkErrorLike): string {
  const errMessage = getNetworkErrorMessage(err)
  const errCode = getNetworkErrorCode(err)
  if (errMessage.includes('socket hang up')) {
    return t('error.net_socket_hang_up')
  }
  for (const code of NET_ERROR_CODES) {
    if (errCode !== code && !errMessage.includes(code)) continue
    // 提取主机名：错误消息中错误码后面的部分，取第一段非空字符串
    const afterCode = errMessage.includes(code) ? (errMessage.split(code)[1]?.trim() || '') : ''
    const host = afterCode.split(/\s/)[0] || ''
    // EPROTO 无独立文案，复用连接中断提示（代理/VPN 切换时常见）
    const keyCode = code === 'EPROTO' ? 'econnreset' : code.toLowerCase()
    const key = `error.net_${keyCode}` as Parameters<typeof t>[0]
    return t(key, { host })
  }
  return errMessage
}

/**
 * AI API 业务错误到友好文案的映射
 * 所有键都是厂商协议里稳定的字符串常量（code 或 type），不做关键词匹配
 *
 * 覆盖的典型场景与厂商：
 *  - 某一款额度用尽：OpenAI/通义 `insufficient_quota`
 *  - 账户欠费/停缴：见 ACCOUNT_BILLING_CODES（阿里云 ArrearsError、Moonshot exceeded_current_quota_error 等）
 *  - API Key 无效：OpenAI `invalid_api_key`、Anthropic `authentication_error`、通用 `unauthorized`
 *  - 权限/地区受限：`permission_denied`、`permission_error`、`model_not_accessible`、`access_denied`、`region_not_supported`
 *  - 模型不存在：OpenAI `model_not_found`、Anthropic `not_found_error`
 *  - 内容安全：`content_filter`、`content_filtered`、阿里云 `data_inspection_failed`、`risk_control`
 *  - 服务端过载：Anthropic `overloaded_error`
 *  - 限流：`rate_limit_exceeded`、Anthropic `rate_limit_error`、`requests_per_minute_exceeded`、`tokens_per_minute_exceeded`
 */
const API_ERROR_CODE_MAP: Record<string, 'error.api_insufficient_quota' | 'error.api_invalid_key' | 'error.api_permission_denied' | 'error.api_model_not_found' | 'error.api_content_filtered' | 'error.api_overloaded' | 'error.api_rate_limited'> = {
  insufficient_quota: 'error.api_insufficient_quota',
  ...Object.fromEntries([...ACCOUNT_BILLING_CODES].map(code => [code, 'error.api_insufficient_quota' as const])),
  invalid_api_key: 'error.api_invalid_key',
  authentication_error: 'error.api_invalid_key',
  unauthorized: 'error.api_invalid_key',
  permission_denied: 'error.api_permission_denied',
  permission_error: 'error.api_permission_denied',
  model_not_accessible: 'error.api_permission_denied',
  access_denied: 'error.api_permission_denied',
  region_not_supported: 'error.api_permission_denied',
  model_not_found: 'error.api_model_not_found',
  not_found_error: 'error.api_model_not_found',
  content_filter: 'error.api_content_filtered',
  content_filtered: 'error.api_content_filtered',
  data_inspection_failed: 'error.api_content_filtered',
  risk_control: 'error.api_content_filtered',
  overloaded_error: 'error.api_overloaded',
  rate_limit_exceeded: 'error.api_rate_limited',
  rate_limit_error: 'error.api_rate_limited',
  requests_per_minute_exceeded: 'error.api_rate_limited',
  tokens_per_minute_exceeded: 'error.api_rate_limited'
}

/**
 * 明确属于"调用方错误、重试无意义"的业务码
 * withApiRetry 在这些码上直接放弃，避免把欠费/鉴权错误当成限流反复重试
 */
const NO_RETRY_BUSINESS_CODES: readonly string[] = [
  'context_length_exceeded',
  ...Object.keys(API_ERROR_CODE_MAP).filter(k =>
    API_ERROR_CODE_MAP[k] !== 'error.api_overloaded' &&
    API_ERROR_CODE_MAP[k] !== 'error.api_rate_limited'
  )
]

export function isNoRetryBusinessCode(code?: unknown): boolean {
  const normalized = normalizeApiErrorCode(code)
  return !!normalized && NO_RETRY_BUSINESS_CODES.includes(normalized)
}

/**
 * 把原始 API 错误翻译为用户可读的文案
 * - 先按厂商 code/type 精确匹配（最准确）
 * - code 缺失或未知时按 HTTP 状态码粗分类（401/402/403/404/429/503/529）
 * - 两者都未命中时返回 null，由调用方回退到 translateNetworkError 或原始消息
 */
function translateApiBusinessError(
  statusCode: number | undefined,
  apiErrorCode: string | undefined,
  model?: string
): string | null {
  const code = normalizeApiErrorCode(apiErrorCode)
  if (code && API_ERROR_CODE_MAP[code]) {
    const key = API_ERROR_CODE_MAP[code]
    return t(key, { model: model || '' })
  }
  if (statusCode !== undefined) {
    switch (statusCode) {
      case 401: return t('error.api_invalid_key')
      case 402: return t('error.api_insufficient_quota')
      case 403: return t('error.api_permission_denied')
      case 404: return t('error.api_model_not_found', { model: model || '' })
      case 429: return t('error.api_rate_limited')
      case 503:
      case 529: return t('error.api_overloaded')
    }
  }
  return null
}

/**
 * 从抛出的 Error 中提取 ApiRequestError 附加信息（statusCode / apiErrorCode）并翻译
 * 未命中业务错误时返回 null，由调用方继续走 translateNetworkError 兜底
 */
function tryFriendlyApiError(err: unknown, model?: string): string | null {
  if (!(err instanceof Error)) return null
  const apiErr = err as ApiRequestError
  return translateApiBusinessError(apiErr.statusCode, apiErr.apiErrorCode, model)
}

/**
 * 是否为「上下文/消息 token 超限」类 API 失败。
 * - OpenAI 系：code === context_length_exceeded
 * - 火山方舟豆包：code 常为空，message 为固定英文
 *   "Total tokens of image and text exceed max message tokens."
 * 匹配的是厂商协议稳定字段，不是自然语言关键词分析。
 */
function isContextLengthApiFailure(code?: string, message?: string): boolean {
  if ((code || '').toLowerCase() === 'context_length_exceeded') return true
  if (message && message.includes('exceed max message tokens')) return true
  return false
}

/** 去掉 UTF-8 BOM 与首尾空白，避免 JSON.parse 因不可见前缀失败 */
function normalizeApiResponseBody(raw: string): string {
  return raw.replace(/^\uFEFF/, '').trim()
}

/** 是否为 HTML/XML 错误页（按文档结构前缀判断，非语义关键词匹配） */
function looksLikeMarkupDocument(body: string): boolean {
  const head = body.slice(0, 32).toLowerCase()
  return head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')
}

/**
 * 解析 API 成功响应正文为 JSON。
 * 失败时抛出带友好文案的 Error，且不附带原始正文（避免把二进制/异常字符经 IPC 传回前端）。
 */
function parseApiResponseJson(raw: string): unknown {
  const body = normalizeApiResponseBody(raw)
  if (!body) {
    throw new Error(t('error.ai_empty_response'))
  }
  if (looksLikeMarkupDocument(body)) {
    throw new Error(t('error.ai_invalid_response'))
  }
  try {
    return JSON.parse(body)
  } catch {
    log.warn(`API response JSON parse failed, len=${body.length}, preview=${toSafeErrorMessage(body, 80)}`)
    throw new Error(t('error.ai_invalid_response'))
  }
}

/**
 * 解析 API 返回的错误响应体，提取结构化的错误信息
 * 避免将原始 JSON（如 {"error":{"message":"...","type":"...","param":null,...}}）直接展示给用户
 */
export function parseApiError(rawBody: string): { message: string; code?: string } {
  const body = normalizeApiResponseBody(rawBody)
  try {
    const parsed = JSON.parse(body)
    if (parsed?.error) {
      // OpenAI 格式: {"error": {"message":"...", "type":"...", "code":"..."}}
      if (typeof parsed.error === 'object') {
        return {
          message: (typeof parsed.error.message === 'string' && parsed.error.message)
            ? parsed.error.message
            : t('error.api_error_generic'),
          code: normalizeApiErrorCode(parsed.error.code) || normalizeApiErrorCode(parsed.error.type)
        }
      }
      // vLLM/SGLang 格式: {"error":"...", "error_type":"..."}
      if (typeof parsed.error === 'string') {
        return {
          message: parsed.error,
          code: normalizeApiErrorCode(parsed.error_type)
        }
      }
    }
    // DashScope / 部分中转：顶层 { code, message }，无 error 包裹
    const topCode = normalizeApiErrorCode(parsed?.code) || normalizeApiErrorCode(parsed?.type)
    const topMessage = typeof parsed?.message === 'string' ? parsed.message : undefined
    if (topCode || topMessage) {
      return {
        message: topMessage || t('error.api_error_generic'),
        code: topCode
      }
    }
  } catch {
    // 非 JSON
  }
  if (!body) {
    return { message: t('error.ai_empty_response') }
  }
  if (looksLikeMarkupDocument(body)) {
    return { message: t('error.ai_invalid_response') }
  }
  return { message: toSafeErrorMessage(body, 200) }
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
  /**
   * think 模型的思考内容（DeepSeek-R1 / DeepSeek V3.2+ 等）。
   *
   * 重要：当 assistant 消息包含 `tool_calls` 时，此字段必须在后续所有请求中
   * 回传给 API（即使值为空字符串），否则 DeepSeek V3.2+ 思考模式会返回 400。
   * `formatMessageForApi` 会在字段缺失时自动补空串，新建/保存消息时请用
   * `!== undefined` 判断以保留空字符串值。
   */
  reasoning_content?: string
  /** @internal Anthropic prompt cache: 标记此消息为缓存断点（跨任务复用的消息边界） */
  _cacheBreakpoint?: boolean
  /**
   * @internal 系统在 task 内部主动注入的 user/assistant 消息（非用户真实输入），
   * 例如「工具读取图片占位」「上下文压力警告」等。这种消息：
   * - 不应被 splitMessagesIntoTasks 当作任务边界（否则会把同一个 task 切碎，
   *   产生「孤儿 tool」之类的违规序列）。
   * - 仍然会原样发给 API（formatMessageForApi 会忽略未知字段）。
   */
  _systemInjected?: boolean
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

export interface TokenUsageInfo {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  // 缓存统计（各家字段不同，统一归一化）
  cache_hit_tokens?: number   // 缓存命中的输入 token 数
  cache_miss_tokens?: number  // 缓存未命中的输入 token 数
}

export interface ChatWithToolsResult {
  content?: string
  tool_calls?: ToolCall[]
  finish_reason?: 'stop' | 'tool_calls' | 'length'
  reasoning_content?: string  // think 模型的思考内容
  usage?: TokenUsageInfo
  aborted?: boolean  // 是否因外部中止（如用户补充新消息）被打断；调用方据此避免把已展示的正文从步骤卡里抹掉
  /**
   * 本次请求触发过「剥图降级」（视觉模型拒收图片后剥离 images 重试成功）。
   * 调用方据此在写 cache 前缀快照时剔除 images——前缀只装模型实际处理过的内容，
   * 防止带图毒前缀每轮循环「拒图→剥图→说看不到」（SPEC: 跨模型带图）。
   */
  imagesStripped?: boolean
}

/** 压测等需要「原样记失败」的调用：关掉自动重试/换模型，并可收紧输出。 */
export interface ChatStreamOptions {
  disableRetry?: boolean
  disableFailover?: boolean
  maxOutputTokens?: number
  temperature?: number
  /** 压测填充很长，调试流水只留头尾，避免把窗口和日志文件灌满 */
  truncateDebugMessages?: boolean
  onHttpStatus?: (status: number) => void
  /** 压测「必须调工具」轴用；默认 auto */
  toolChoice?: 'auto' | 'none' | 'required'
}

import type { AiModelType, AiProfile, FetchedAiModel } from '@shared/types'
export type { AiModelType, AiProfile, FetchedAiModel }

export { DEFAULT_MAX_OUTPUT_TOKENS } from './ai-request-budget'
import { resolveRequestBudget } from './ai-request-budget'

function asPositiveInt(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(n) || n <= 0) return undefined
  return Math.floor(n)
}

function truncateBenchDebugContent(content: string | undefined): string | undefined {
  if (!content || content.length <= 400) return content
  return `${content.slice(0, 160)}\n...[${content.length} chars]...\n${content.slice(-80)}`
}

/** 厂商模型列表条目上可能出现的能力字段（只读结构化字段，不按模型名猜测） */
export interface ModelListEntry {
  id?: unknown
  input_modalities?: unknown
  capabilities?: { vision?: unknown; image_input?: unknown }
  type?: unknown
  modalities?: unknown
  context_length?: unknown
  context_window?: unknown
  max_input_tokens?: unknown
  max_output_tokens?: unknown
  max_completion_tokens?: unknown
  output_token_limit?: unknown
  outputTokenLimit?: unknown
  max_output?: unknown
  max_tokens?: unknown
  top_provider?: { max_completion_tokens?: unknown }
}

/**
 * 从 /models 单条记录解析 id、视觉能力、上下文长度和输出上限。
 * 输出上限只认明确的输出字段；`max_tokens` 仅在小于上下文长度时视为输出上限
 * （Anthropic 列表的写法），以免把上下文窗口误当成输出。
 */
export function parseModelListEntry(raw: ModelListEntry): FetchedAiModel | null {
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  if (!id) return null

  const inputModalities = Array.isArray(raw.input_modalities)
    ? raw.input_modalities
    : Array.isArray(raw.modalities)
      ? raw.modalities
      : []
  const supportsVision =
    inputModalities.includes('image') ||
    raw.capabilities?.vision === true ||
    raw.capabilities?.image_input === true ||
    raw.type === 'multimodal'

  const contextLength =
    asPositiveInt(raw.context_length) ??
    asPositiveInt(raw.context_window) ??
    asPositiveInt(raw.max_input_tokens)

  const explicitOutput =
    asPositiveInt(raw.max_output_tokens) ??
    asPositiveInt(raw.max_completion_tokens) ??
    asPositiveInt(raw.output_token_limit) ??
    asPositiveInt(raw.outputTokenLimit) ??
    asPositiveInt(raw.max_output) ??
    asPositiveInt(raw.top_provider?.max_completion_tokens)

  const listedMaxTokens = asPositiveInt(raw.max_tokens)
  // max_tokens 单独出现时含义不清（有的厂商拿它表示上下文），
  // 只在同时有上下文、且明显更小的时候当作输出上限（Anthropic 列表）。
  const rawOutput = explicitOutput ?? (
    listedMaxTokens && contextLength && listedMaxTokens < contextLength
      ? listedMaxTokens
      : undefined
  )
  // 输出上限 ≥ 窗口：那是「最多能写这么多」，不是每次都要预留的额度
  const maxOutputTokens = rawOutput && contextLength && rawOutput >= contextLength
    ? undefined
    : rawOutput

  return {
    id,
    supportsVision,
    ...(contextLength ? { contextLength } : {}),
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
  }
}

/** 指定 profileId 失效时回退到其它配置的通知 */
export interface AiProfileFallbackNotice {
  requestedId: string
  usedId: string
  usedName: string
}

/**
 * 从 profiles 列表解析本次应使用的配置。
 * - 指定 id 命中 → 直接用
 * - 指定 id 未命中但列表非空 → 回退 active / 第一个，并带 fallback 元数据
 * - 未指定 id → active（找不到则第一个）；active 失效时同样带 fallback
 */
export function resolveAiProfile(
  profiles: AiProfile[],
  activeId: string,
  requestedId?: string
): { profile: AiProfile | null; fallback?: AiProfileFallbackNotice } {
  if (profiles.length === 0) return { profile: null }

  if (requestedId) {
    const found = profiles.find(p => p.id === requestedId)
    if (found) return { profile: found }
    const used =
      (activeId ? profiles.find(p => p.id === activeId) : undefined) ?? profiles[0]
    return {
      profile: used,
      fallback: { requestedId, usedId: used.id, usedName: used.name }
    }
  }

  if (activeId) {
    const found = profiles.find(p => p.id === activeId)
    if (found) return { profile: found }
    const used = profiles[0]
    return {
      profile: used,
      fallback: { requestedId: activeId, usedId: used.id, usedName: used.name }
    }
  }

  return { profile: profiles[0] }
}

/** 执行前结构化校验：空配置 / URL 非法 / 缺 model（禁止靠错误字符串关键词匹配） */
export type ProfileValidationResult =
  | { ok: true; profile: AiProfile }
  | { ok: false; code: 'NO_PROFILE' | 'MISSING_API_URL' | 'INVALID_API_URL' | 'MISSING_MODEL'; message: string }

export function validateProfileForRequest(
  profile: AiProfile | null | undefined,
): ProfileValidationResult {
  if (!profile) {
    return { ok: false, code: 'NO_PROFILE', message: 'No AI profile configured' }
  }
  const apiUrl = typeof profile.apiUrl === 'string' ? profile.apiUrl.trim() : ''
  if (!apiUrl) {
    return { ok: false, code: 'MISSING_API_URL', message: 'AI profile apiUrl is empty' }
  }
  try {
    // eslint-disable-next-line no-new
    new URL(apiUrl)
  } catch {
    return { ok: false, code: 'INVALID_API_URL', message: 'AI profile apiUrl is not a valid URL' }
  }
  const model = typeof profile.model === 'string' ? profile.model.trim() : ''
  if (!model) {
    return { ok: false, code: 'MISSING_MODEL', message: 'AI profile model is empty' }
  }
  return { ok: true, profile }
}

/**
 * 检测 API 错误是否因为不支持多模态/视觉输入
 * - 部分网关会明确写 image_url / content 类型
 * - 火山方舟等返回「Model do not support image input」不含 image_url 字样，也需识别以便降级重试
 */
function isVisionNotSupportedError(errorMsg: string): boolean {
  const lower = errorMsg.toLowerCase()
  if (lower.includes('image_url') && (
    lower.includes('unknown variant') ||
    lower.includes('not supported') ||
    lower.includes('invalid type') ||
    lower.includes('invalid_type') ||
    lower.includes('expected `text`') ||
    lower.includes("expected 'text'")
  )) {
    return true
  }
  if (
    (lower.includes('not support') && lower.includes('image')) ||
    (lower.includes('does not support') && lower.includes('image')) ||
    (lower.includes('unsupported') && lower.includes('image')) ||
    (lower.includes('image input') && (
      lower.includes('not support') ||
      lower.includes('unsupported') ||
      lower.includes('do not support')
    ))
  ) {
    return true
  }
  return false
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
 * 图片已经发出，但接口判定 payload 无效（豆包 Invalid base64 image_url 等）。
 * 与「模型不支持图片」不同，但同样应剥图用正文重试，避免整单失败。
 */
function isUnusableImagePayloadError(errorMsg: string): boolean {
  const lower = errorMsg.toLowerCase()
  return (
    lower.includes('invalid base64 image_url') ||
    lower.includes('unsupportedimageformat') ||
    (lower.includes('image format') && (
      lower.includes('not supported') ||
      lower.includes('unsupported')
    ))
  )
}

function shouldRetryWithoutImages(errorMsg: string): boolean {
  return (
    isVisionNotSupportedError(errorMsg) ||
    isGenericParamErrorWithImages(errorMsg) ||
    isUnusableImagePayloadError(errorMsg)
  )
}

/**
 * 解析模型的合适 temperature 值
 * 部分模型有固定 temperature 要求（如 Kimi K2.5 只允许 temperature=1），
 * 此函数根据模型名称返回合适的值，未命中时返回 defaultTemp。
 */
function resolveTemperature(profile: { model: string; temperature?: number }, defaultTemp = 0.7): number {
  if (typeof profile.temperature === 'number' && !isNaN(profile.temperature)) {
    return Math.max(0, Math.min(2, profile.temperature))
  }
  const lower = profile.model.toLowerCase()
  if (lower.includes('k2.5') || lower.includes('k-2.5')) return 1
  return defaultTemp
}

/**
 * 检测消息列表中是否包含会发往 API 的多模态图片（与 formatMessageForApi 一致，仅 user 角色）
 */
function messagesContainImages(messages: AiMessage[]): boolean {
  return messages.some(m =>
    m.role === 'user' &&
    !!m.images?.some(url => toSendableVisionImageUrl(url) !== null)
  )
}

/**
 * 将 AiMessage 转换为 API 请求格式
 * 如果消息包含图片，content 会转为多模态数组格式（OpenAI Vision API）
 * @param stripImages 为 true 时忽略图片（用于 API 不支持视觉时的降级）
 *
 * 导出仅用于单元测试（DeepSeek 思考模式合规性回归）。运行时仅本文件内部使用。
 */
export function formatMessageForApi(msg: AiMessage, stripImages = false): Record<string, unknown> {
  if (msg.role === 'tool') {
    return {
      role: 'tool' as const,
      content: msg.content || '[no output]',
      tool_call_id: msg.tool_call_id
    }
  }
  if (msg.role === 'assistant' && msg.tool_calls) {
    const assistantMsg: Record<string, unknown> = {
      role: 'assistant' as const,
      content: msg.content || null,
      tool_calls: msg.tool_calls,
      // DeepSeek V3.2+ 思考模式：带 tool_calls 的 assistant 消息必须回传 reasoning_content
      // 字段不存在（历史消息 / 非思考模型）时补空串，兼容其余 OpenAI 兼容 API（忽略未知字段）
      reasoning_content: msg.reasoning_content ?? ''
    }
    return assistantMsg
  }
  // user / system 消息：如果有图片且未要求剥离，转为多模态格式
  if (!stripImages && msg.images && msg.images.length > 0 && msg.role === 'user') {
    const parts: AiContentPart[] = []
    if (msg.content) {
      parts.push({ type: 'text', text: msg.content })
    }
    for (const imageUrl of msg.images) {
      const url = toSendableVisionImageUrl(imageUrl)
      if (!url) continue
      parts.push({ type: 'image_url', image_url: { url, detail: 'high' } })
    }
    if (parts.some(p => p.type === 'image_url')) {
      return {
        role: msg.role,
        content: parts
      }
    }
  }
  // vLLM 等推理引擎拒绝空 content，纯 assistant 文本消息也需保护
  let content = msg.content || (msg.role === 'assistant' ? '[no response]' : ' ')
  // system 归因标记仅供本地组成占比，不发给 API
  if (msg.role === 'system') {
    content = stripCompositionMarkers(content)
  }
  const result: Record<string, unknown> = { role: msg.role, content }
  // DeepSeek V3.2+/V4 思考模式要求所有 assistant 消息必须带 reasoning_content（缺一即拒）。
  // 与 tool_calls 分支一致，这里对纯文本 assistant 也无条件补字段（缺失补空串），
  // 兜底所有可能漏字段的来源（TaskMemory L1/L2 压缩重建、跨会话恢复的老 record、模型切换等）。
  // 其余 OpenAI 兼容 API 会忽略未知字段，不会受影响。
  if (msg.role === 'assistant') {
    result.reasoning_content = msg.reasoning_content ?? ''
  }
  if (msg._cacheBreakpoint) result._cacheBreakpoint = true
  return result
}

/**
 * 从 API 返回的 usage 对象中提取缓存统计信息
 * 各家格式不同，统一归一化为 cache_hit_tokens / cache_miss_tokens
 * 
 * 部分代理（如火山引擎）可能同时返回多种格式，优先取有实际数据的
 */
function extractCacheStats(rawUsage: Record<string, unknown>): { cache_hit_tokens?: number; cache_miss_tokens?: number } {
  type CacheResult = { cache_hit_tokens: number; cache_miss_tokens: number }
  const candidates: CacheResult[] = []

  // DeepSeek: prompt_cache_hit_tokens / prompt_cache_miss_tokens
  const dsHit = rawUsage.prompt_cache_hit_tokens as number | undefined
  const dsMiss = rawUsage.prompt_cache_miss_tokens as number | undefined
  if (dsHit !== undefined || dsMiss !== undefined) {
    candidates.push({ cache_hit_tokens: dsHit ?? 0, cache_miss_tokens: dsMiss ?? 0 })
  }

  // Anthropic: cache_read_input_tokens / cache_creation_input_tokens
  const anthropicRead = rawUsage.cache_read_input_tokens as number | undefined
  const anthropicCreate = rawUsage.cache_creation_input_tokens as number | undefined
  if (anthropicRead !== undefined || anthropicCreate !== undefined) {
    candidates.push({ cache_hit_tokens: anthropicRead ?? 0, cache_miss_tokens: anthropicCreate ?? 0 })
  }

  // OpenAI: prompt_tokens_details.cached_tokens
  const details = rawUsage.prompt_tokens_details as Record<string, unknown> | undefined
  if (details?.cached_tokens !== undefined) {
    const cached = details.cached_tokens as number
    const total = (rawUsage.prompt_tokens as number) || 0
    candidates.push({ cache_hit_tokens: cached, cache_miss_tokens: Math.max(0, total - cached) })
  }

  if (candidates.length === 0) return {}
  // 多个候选时优先取有实际数据（cache_hit > 0 或 cache_miss > 0）的
  return candidates.find(c => c.cache_hit_tokens > 0 || c.cache_miss_tokens > 0) || candidates[0]
}

interface AnthropicInputUsage {
  input_tokens: number
  cache_hit_tokens?: number
  cache_miss_tokens?: number
}

/**
 * Anthropic 的 input_tokens 不含缓存读写（cache_read / cache_creation 另报、需相加），
 * 折成与 OpenAI 系同口径的总输入：cache_hit 是总输入的子集，miss = 总输入 − hit。
 */
function normalizeAnthropicInput(rawUsage: Record<string, unknown>): AnthropicInputUsage {
  const uncached = typeof rawUsage.input_tokens === 'number' ? rawUsage.input_tokens : 0
  const read = typeof rawUsage.cache_read_input_tokens === 'number' ? rawUsage.cache_read_input_tokens : undefined
  const write = typeof rawUsage.cache_creation_input_tokens === 'number' ? rawUsage.cache_creation_input_tokens : undefined
  const input = uncached + (read ?? 0) + (write ?? 0)
  if (read === undefined && write === undefined) return { input_tokens: input }
  return { input_tokens: input, cache_hit_tokens: read ?? 0, cache_miss_tokens: input - (read ?? 0) }
}

// === Anthropic Native API Adapter ===

function isAnthropicApi(profile: { apiUrl: string; apiFormat?: string }): boolean {
  const format = profile.apiFormat || 'auto'
  if (format === 'openai') return false
  if (format === 'anthropic') return true
  // auto: 根据 URL 自动检测
  try {
    if (profile.apiUrl.includes('/chat/completions')) return false
    const url = new URL(profile.apiUrl)
    if (url.hostname === 'api.anthropic.com') return true
    if (url.pathname.startsWith('/anthropic')) return true
    return false
  } catch {
    log.warn(`Invalid API URL for format detection: ${profile.apiUrl}`)
    return false
  }
}

function getRequestHeaders(profile: AiProfile): Record<string, string> {
  if (isAnthropicApi(profile)) {
    return {
      'Content-Type': 'application/json',
      'x-api-key': profile.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31'
    }
  }
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${profile.apiKey}`
  }
}

/**
 * 清洗字符串中的孤立 UTF-16 surrogate（high surrogate 缺 low / low surrogate 缺 high）。
 * 上层若用 substring/slice 按 UTF-16 code unit 截断包含 emoji 的文本，可能切出孤立
 * surrogate；JSON.stringify 会把它原样输出为 `\uD8XX`，而严格的 JSON 解析器（如
 * DeepSeek 服务端）会报 "unexpected end of hex escape" 拒绝整个请求。这里把孤立
 * surrogate 替换为 U+FFFD（替换字符），是发请求前的最后兜底。
 */
function sanitizeIsolatedSurrogates(s: string): string {
  if (!s) return s
  // \uD800-\uDBFF 后必须紧跟 \uDC00-\uDFFF；任何不配对的高/低代理项替换为 U+FFFD
  return s
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '\uFFFD')
    .replace(/(^|[^\uD800-\uDBFF])([\uDC00-\uDFFF])/g, '$1\uFFFD')
}

/** 清洗控制字符 / 孤立 surrogate 并截断，保证错误文案可安全经 IPC 传回前端 */
function toSafeErrorMessage(msg: string, maxLen = 300): string {
  // 故意匹配 C0 控制字符，供 IPC 安全传输
  // eslint-disable-next-line no-control-regex -- strip C0 controls from error text
  const cleaned = sanitizeIsolatedSurrogates(msg).replace(/[\u0000-\u001f]/g, ' ')
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) + '...' : cleaned
}

/** 递归清洗 body 中所有字符串字段的孤立 surrogate */
function sanitizeBodyStrings(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeIsolatedSurrogates(value)
  if (Array.isArray(value)) return value.map(sanitizeBodyStrings)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitizeBodyStrings(v)
    }
    return out
  }
  return value
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
      // 缓存断点 3/4：跨任务消息复用边界（前序任务的最后一条 assistant 消息）
      if (msg._cacheBreakpoint) {
        if (blocks.length === 0) blocks.push({ type: 'text', text: '' })
        blocks[blocks.length - 1].cache_control = { type: 'ephemeral' }
        messages.push({ role: 'assistant', content: blocks })
      } else if (blocks.length === 1 && blocks[0].type === 'text') {
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
  if (system) {
    // Anthropic prompt caching: 将系统提示拆分为稳定部分（缓存）和动态部分
    // 缓存断点 1/4：系统提示的稳定前缀
    const CACHE_BREAK = '<!-- CACHE_BREAK -->'
    const breakIdx = system.indexOf(CACHE_BREAK)
    if (breakIdx !== -1) {
      const stablePart = system.substring(0, breakIdx).trim()
      const dynamicPart = system.substring(breakIdx + CACHE_BREAK.length).trim()
      const blocks: Array<Record<string, unknown>> = []
      if (stablePart) {
        blocks.push({ type: 'text', text: stablePart, cache_control: { type: 'ephemeral' } })
      }
      if (dynamicPart) {
        blocks.push({ type: 'text', text: dynamicPart })
      }
      result.system = blocks
    } else {
      // 没有分隔符时，整个系统提示标记为缓存
      result.system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
    }
  }
  if (body.temperature !== undefined) result.temperature = body.temperature
  if (body.stream) result.stream = true

  const tools = body.tools as ToolDefinition[] | undefined
  if (tools && tools.length > 0) {
    const anthropicTools = tools.map(td => ({
      name: td.function.name,
      description: td.function.description,
      input_schema: td.function.parameters
    }))
    // 缓存断点 2/4：工具定义列表（会话内稳定不变）
    if (anthropicTools.length > 0) {
      (anthropicTools[anthropicTools.length - 1] as Record<string, unknown>).cache_control = { type: 'ephemeral' }
    }
    result.tools = anthropicTools
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

  const rawUsage = resp.usage as Record<string, unknown> | undefined
  let usage: TokenUsageInfo | undefined
  if (rawUsage) {
    const { input_tokens, ...cacheStats } = normalizeAnthropicInput(rawUsage)
    const completion = typeof rawUsage.output_tokens === 'number' ? rawUsage.output_tokens : 0
    usage = { prompt_tokens: input_tokens, completion_tokens: completion, total_tokens: input_tokens + completion, ...cacheStats }
  }

  return { choices: [{ message, finish_reason: finishReason }], usage }
}

interface AnthropicStreamDelta {
  content?: string
  reasoning_content?: string
  tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>
  finish_reason?: string
  done?: boolean
  usage?: Partial<AnthropicInputUsage> & { output_tokens?: number }
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
      case 'message_start': {
        const msg = json.message as Record<string, unknown>
        const u = msg?.usage as Record<string, unknown> | undefined
        if (!u) return null
        const input = normalizeAnthropicInput(u)
        return input.input_tokens > 0 ? { usage: input } : null
      }
      case 'message_delta': {
        const d = json.delta as Record<string, unknown>
        const sr = d?.stop_reason as string
        const u = json.usage as Record<string, unknown> | undefined
        const result: AnthropicStreamDelta = {}
        if (sr) {
          result.finish_reason = sr === 'tool_use' ? 'tool_calls' : sr === 'max_tokens' ? 'length' : 'stop'
        }
        if (u) {
          const input = normalizeAnthropicInput(u)
          const output = typeof u.output_tokens === 'number' ? u.output_tokens : 0
          if (input.input_tokens > 0 || output > 0) {
            result.usage = { ...(input.input_tokens > 0 ? input : {}), ...(output > 0 ? { output_tokens: output } : {}) }
          }
        }
        return (result.finish_reason || result.usage) ? result : null
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
  // 插件 provider（由 PluginRegistry 初始化后注入）
  private pluginProviders: Array<import('./plugin/types').ProviderRegistration> = []
  // 专用 HTTP agent，支持子 Agent 并发请求时连接池复用，避免 MaxListenersExceededWarning
  private readonly httpsAgent: https.Agent
  private readonly httpAgent: http.Agent
  private disposed = false
  private readonly profileFallbackListeners = new Set<(notice: AiProfileFallbackNotice) => void>()

  /**
   * @param configService 应与主进程/CLI 单例共用；省略时走 getConfigService()
   */
  constructor(configService?: ConfigService) {
    this.configService = configService ?? getConfigService()
    this.httpsAgent = new https.Agent({ keepAlive: true })
    this.httpsAgent.setMaxListeners(30)
    this.httpAgent = new http.Agent({ keepAlive: true })
    this.httpAgent.setMaxListeners(30)
  }

  /**
   * 订阅「指定 profile 失效并已回退」事件。返回取消订阅函数。
   * 主进程用于 toast；Agent 用于步骤流提示并纠正 this.profileId。
   */
  onProfileFallback(listener: (notice: AiProfileFallbackNotice) => void): () => void {
    this.profileFallbackListeners.add(listener)
    return () => { this.profileFallbackListeners.delete(listener) }
  }

  private emitProfileFallback(notice: AiProfileFallbackNotice): void {
    log.warn(
      `AI profile fallback: requested=${notice.requestedId} -> ${notice.usedId} (${notice.usedName})`
    )
    for (const listener of this.profileFallbackListeners) {
      try {
        listener(notice)
      } catch (err) {
        log.error('profileFallback listener failed:', err)
      }
    }
  }

  /**
   * 注入插件 provider（由 PluginRegistry 初始化后调用）
   */
  setPluginProviders(providers: Array<import('./plugin/types').ProviderRegistration>): void {
    this.pluginProviders = providers
    if (providers.length > 0) {
      log.info(`Registered ${providers.length} plugin provider(s): ${providers.map(p => p.id).join(', ')}`)
    }
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
   * 释放 keep-alive HTTP 连接池。CLI 进程退出前调用，避免 Agent 空转十几秒才退出。
   * 幂等：重复调用无副作用。
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.abort()
    this.httpsAgent.destroy()
    this.httpAgent.destroy()
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
   * 获取当前 AI Profile；指定 id 失效时回退 active/第一个并通知监听方。
   */
  private getCurrentProfile(profileId?: string): AiProfile | null {
    const { profile, fallback } = resolveAiProfile(
      this.configService.getAiProfiles(),
      this.configService.getActiveAiProfile(),
      profileId
    )
    if (fallback) this.emitProfileFallback(fallback)
    return profile
  }

  /**
   * 发送聊天请求（非流式）
   */
  async chat(messages: AiMessage[], profileId?: string): Promise<string> {
    const profile = this.getCurrentProfile(profileId)
    if (!profile) {
      throw new Error(t('error.ai_no_config'))
    }

    const startTime = Date.now()
    log.info(`Chat request: model=${profile.model}, messages=${messages.length}`)

    const requestBody = {
      model: profile.model,
      messages,
      temperature: resolveTemperature(profile),
      max_tokens: 2048
    }

    try {
      const data = await this.makeRequest<{
        choices?: { message?: { content?: string } }[]
        error?: { message?: string; code?: string; type?: string }
      }>(profile, requestBody)

      if (data.error) {
        const code = data.error.code?.toLowerCase() || data.error.type?.toLowerCase() || ''
        if (isContextLengthApiFailure(code, data.error.message)) {
          throw new Error(t('error.context_length_exceeded'))
        }
        const friendly = translateApiBusinessError(undefined, code, profile.model)
        if (friendly) {
          throw new Error(friendly)
        }
        throw new Error(t('error.api_request_failed', { data: data.error.message || t('error.api_error_generic') }))
      }

      const result = data.choices?.[0]?.message?.content || ''
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
      log.info(`Chat done: model=${profile.model}, duration=${elapsed}s, responseLen=${result.length}`)
      return result
    } catch (error) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
      const errMsg = error instanceof Error ? error.message : String(error)
      log.error(`Chat failed: model=${profile.model}, duration=${elapsed}s, error=${errMsg}`)
      if (error instanceof Error) {
        if (error.message === t('error.context_length_exceeded')) {
          throw error
        }
        // 先尝试匹配业务错误（欠费 / 鉴权 / 权限 / 模型不存在 / 内容安全等）
        const friendly = tryFriendlyApiError(error, profile.model)
        if (friendly) {
          throw new Error(friendly)
        }
        // 保留 makeRequest 已重试后的原始错误信息，翻译网络错误码
        throw new Error(t('error.ai_request_failed', { message: translateNetworkError(error) }))
      }
      throw error
    }
  }

  /**
   * 测试 API Key 是否可用（使用表单中的临时配置，不要求 profile 已保存）
   * 发送极小请求（max_tokens=1），快速验证 Key + endpoint 连通性
   */
  async testApiKey(profile: Partial<AiProfile>): Promise<{ success: boolean; message: string; latencyMs?: number }> {
    if (!profile.apiUrl || !profile.model) {
      return { success: false, message: t('error.ai_no_config') }
    }

    const testProfile: AiProfile = {
      id: '__test__',
      name: '__test__',
      apiUrl: profile.apiUrl,
      apiKey: profile.apiKey ?? '',
      model: profile.model,
      proxy: profile.proxy,
      apiFormat: profile.apiFormat ?? 'auto',
      contextLength: 4096,
      maxOutputTokens: 1,
    }

    const requestBody = {
      model: testProfile.model,
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 1,
    }

    const start = Date.now()
    try {
      const data = await this.makeRequestOnce<{
        choices?: { message?: { content?: string } }[]
        content?: { type?: string; text?: string }[]
        error?: { message?: string; code?: string; type?: string }
      }>(testProfile, requestBody)

      const latencyMs = Date.now() - start

      if (data.error) {
        const msg = data.error.message || t('error.api_error_generic')
        return { success: false, message: toSafeErrorMessage(msg), latencyMs }
      }

      return { success: true, message: '', latencyMs }
    } catch (err) {
      const latencyMs = Date.now() - start
      const friendly = err instanceof Error ? tryFriendlyApiError(err, testProfile.model) : null
      const netErr: NetworkErrorLike = err instanceof Error ? err : String(err)
      return {
        success: false,
        message: toSafeErrorMessage(friendly || translateNetworkError(netErr)),
        latencyMs,
      }
    }
  }

  /**
   * 从 provider 拉取可用模型列表（GET /v1/models）
   * 同时尝试解析非标准能力字段以自动识别视觉模型
   */
  async fetchModels(profile: Partial<AiProfile>): Promise<{
    models: FetchedAiModel[]
    error?: string
  }> {
    if (!profile.apiUrl) {
      return { models: [], error: t('error.ai_no_config') }
    }

    // 构造 /models 端点：将 /chat/completions 替换为 /models
    // 其他路径形式：去掉最后一段然后加 /models（兜底方案）
    let modelsUrl: string
    try {
      const cleaned = profile.apiUrl.replace(/\/chat\/completions(\?.*)?$/, '').replace(/\/messages(\?.*)?$/, '')
      const base = new URL(cleaned)
      // 如果路径已经以 /models 结尾则直接用
      if (base.pathname.endsWith('/models')) {
        modelsUrl = base.toString()
      } else {
        base.pathname = base.pathname.replace(/\/$/, '') + '/models'
        modelsUrl = base.toString()
      }
    } catch {
      return { models: [], error: t('error.ai_no_config') }
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (profile.apiKey) {
      // Anthropic 使用 x-api-key，其余用 Bearer
      const isAnthropic = isAnthropicApi({ apiUrl: profile.apiUrl, apiFormat: profile.apiFormat })
      if (isAnthropic) {
        headers['x-api-key'] = profile.apiKey
        headers['anthropic-version'] = '2023-06-01'
      } else {
        headers['Authorization'] = `Bearer ${profile.apiKey}`
      }
    }

    return new Promise((resolve) => {
      try {
        const url = new URL(modelsUrl)
        const isHttps = url.protocol === 'https:'
        const httpModule = isHttps ? https : http
        const proxyAgent = profile.proxy ? this.getProxyAgent(profile.proxy) : undefined

        const options: https.RequestOptions = {
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname + url.search,
          method: 'GET',
          headers,
          timeout: 10000,
          agent: proxyAgent ?? (isHttps ? this.httpsAgent : this.httpAgent),
        }

        const req = httpModule.request(options, (res) => {
          let data = ''
          res.on('data', (chunk) => { data += chunk })
          res.on('end', () => {
            const statusCode = res.statusCode ?? 0
            const contentType = res.headers['content-type'] ?? ''

            // 非 JSON 响应（HTML 错误页等）：先于 JSON.parse 拦截
            if (!contentType.includes('application/json') && !contentType.includes('text/json')) {
              if (statusCode === 404) {
                resolve({ models: [], error: t('error.fetch_models_not_supported') })
              } else if (statusCode === 401 || statusCode === 403) {
                resolve({ models: [], error: t('error.api_invalid_key') })
              } else {
                resolve({ models: [], error: t('error.fetch_models_not_supported') })
              }
              return
            }

            try {
              const json = JSON.parse(data) as {
                data?: ModelListEntry[]
                models?: ModelListEntry[]
                error?: { message?: string }
              }

              // API 层面的错误（Key 无效、权限不足等）
              if (json.error) {
                const msg = json.error.message ?? t('error.api_error_generic')
                const friendly = tryFriendlyApiError(new Error(msg), undefined)
                resolve({ models: [], error: friendly || msg })
                return
              }

              // 兼容标准格式（data[]）和部分厂商格式（models[]）
              const rawList = json.data ?? json.models ?? []
              const models = rawList
                .map((m) => parseModelListEntry(m))
                .filter((m): m is FetchedAiModel => m !== null)

              resolve({ models })
            } catch {
              resolve({ models: [], error: t('error.response_parse_failed') })
            }
          })
        })

        req.on('timeout', () => {
          req.destroy()
          resolve({ models: [], error: translateNetworkError('ETIMEDOUT') })
        })
        req.on('error', (err) => {
          resolve({ models: [], error: translateNetworkError(err) })
        })
        req.end()
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        resolve({ models: [], error: msg })
      }
    })
  }

  /**
   * 发送单次 HTTP 请求（支持代理，带超时处理）
   * 抛出 ApiRequestError 携带 statusCode / retryAfter / apiErrorCode，供 withApiRetry 分类重试
   */
  private makeRequestOnce<T>(profile: AiProfile, body: object, signal?: AbortSignal): Promise<T> {
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
        timeout: AI_TIMEOUT.CONNECT,
        agent: profile.proxy ? this.getProxyAgent(profile.proxy) : (isHttps ? this.httpsAgent : this.httpAgent)
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
          complete(() => reject(toApiRequestError(new Error(t('error.ai_total_timeout')))))
        }
      }, AI_TIMEOUT.TOTAL)

      const req = httpModule.request(options, (res) => {
        let data = ''
        
        // 设置 socket 空闲超时
        res.socket?.setTimeout(AI_TIMEOUT.SOCKET_IDLE)
        res.socket?.on('timeout', () => {
          req.destroy()
          complete(() => reject(toApiRequestError(new Error('ETIMEDOUT'))))
        })

        res.on('data', (chunk) => {
          data += chunk
        })
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            complete(() => {
              try {
                let parsed: unknown = parseApiResponseJson(data)
                if (isAnthropicApi(profile)) {
                  parsed = convertFromAnthropicResponse(parsed as Record<string, unknown>)
                }
                resolve(parsed as T)
              } catch (err) {
                const msg = err instanceof Error ? err.message : t('error.ai_invalid_response')
                reject(toApiRequestError(new Error(msg)))
              }
            })
          } else {
            const parsed = parseApiError(data)
            const headers = res.headers as Record<string, string | string[] | undefined>
            complete(() => reject(toApiRequestError(
              new Error(parsed.message),
              res.statusCode!,
              headers,
              parsed.code
            )))
          }
        })
      })

      // 连接超时处理
      req.on('timeout', () => {
        req.destroy()
        complete(() => reject(toApiRequestError(new Error('ETIMEDOUT'))))
      })

      req.on('error', (err) => {
        complete(() => reject(toApiRequestError(err)))
      })

      // 支持中止请求
      if (signal) {
        signal.addEventListener('abort', () => {
          req.destroy()
          complete(() => reject(toApiRequestError(new Error(t('error.request_aborted')))))
        })
      }

      const finalBody = isAnthropicApi(profile) ? convertToAnthropicBody(body as Record<string, unknown>) : body
      req.write(JSON.stringify(sanitizeBodyStrings(finalBody)))
      req.end()
    })
  }

  /**
   * 发送 HTTP 请求（带自动重试：网络错误 / 429 / 5xx 均自动退避重试）
   */
  private makeRequest<T>(profile: AiProfile, body: object, signal?: AbortSignal): Promise<T> {
    return withApiRetry(() => this.makeRequestOnce<T>(profile, body, signal))
  }

  /**
   * 发送聊天请求（流式，支持代理）
   * 支持 think 模型（如 DeepSeek-R1）的 reasoning_content 字段
   * 支持网络错误 / 429 / 5xx 自动重试（指数退避 + jitter）
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
    const profile = this.getCurrentProfile(profileId)
    if (!profile) {
      onError(t('error.ai_no_config'))
      return
    }

    const isAnthropic = isAnthropicApi(profile)
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
      temperature: resolveTemperature(profile),
      max_tokens: 2048,
      stream: true
    }

    // 创建 AbortController，使用 requestId 或生成一个唯一 ID
    const reqId = requestId || `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    const abortController = new AbortController()
    this.abortControllers.set(reqId, abortController)

    // 完成状态标记，防止重复回调
    let isCompleted = false
    // 总超时计时器
    let totalTimeoutId: NodeJS.Timeout
    // 空闲超时计时器（收到数据后重置）
    let idleTimeoutId: NodeJS.Timeout
    // 请求对象引用
    let req: http.ClientRequest | undefined
    // 重试计数器
    let networkRetryCount = 0
    let rateLimitRetryCount = 0
    let serverErrorRetryCount = 0

    // reasoning 输出状态
    let hasReasoningOutput = false
    let hasContentOutput = false

    const complete = (fn: () => void) => {
      if (!isCompleted) {
        isCompleted = true
        clearTimeout(totalTimeoutId)
        clearTimeout(idleTimeoutId)
        this.abortControllers.delete(reqId)
        fn()
      }
    }

    const resetForRetry = () => {
      clearTimeout(totalTimeoutId)
      clearTimeout(idleTimeoutId)
      req = undefined
      hasReasoningOutput = false
      hasContentOutput = false
    }

    const closeOpenReasoningBlock = () => {
      if (hasReasoningOutput && !hasContentOutput) {
        onChunk('\n\n</blockquote>\n</details>\n\n')
        hasReasoningOutput = false
      }
    }

    const resetIdleTimeout = () => {
      clearTimeout(idleTimeoutId)
      idleTimeoutId = setTimeout(() => {
        if (!isCompleted) {
          req?.destroy()
          if (!tryRetry('ETIMEDOUT')) {
            complete(() => onError(t('error.ai_idle_timeout')))
          }
        }
      }, AI_TIMEOUT.SOCKET_IDLE)
    }

    const tryRetry = (error: NetworkErrorLike, statusCode?: number, retryAfterMs?: number, apiErrorCode?: string): boolean => {
      if (isCompleted) return true

      if (isAccountBillingError(apiErrorCode, statusCode) || isNoRetryBusinessCode(apiErrorCode)) {
        return false
      }

      // 429 Rate Limit
      if (statusCode === 429 && rateLimitRetryCount < AI_RETRY.RATE_LIMIT_MAX_RETRIES) {
        rateLimitRetryCount++
        const delay = retryAfterMs ?? calculateBackoff(AI_RETRY.RATE_LIMIT_BASE_DELAY, rateLimitRetryCount - 1)
        log.warn(`ChatStream rate limited (429), retry ${rateLimitRetryCount}/${AI_RETRY.RATE_LIMIT_MAX_RETRIES} in ${(delay / 1000).toFixed(0)}s`)
        closeOpenReasoningBlock()
        onChunk(`⚠️ ${t('error.rate_limited', { seconds: (delay / 1000).toFixed(0), attempt: String(rateLimitRetryCount), max: String(AI_RETRY.RATE_LIMIT_MAX_RETRIES) })}\n`)
        resetForRetry()
        setTimeout(doRequest, delay)
        isCompleted = true
        return true
      }

      // 5xx 服务端错误
      if (statusCode && AI_RETRY.RETRYABLE_STATUS_CODES.includes(statusCode) && serverErrorRetryCount < AI_RETRY.SERVER_ERROR_MAX_RETRIES) {
        serverErrorRetryCount++
        const delay = calculateBackoff(AI_RETRY.SERVER_ERROR_BASE_DELAY, serverErrorRetryCount - 1)
        log.warn(`ChatStream server error (${statusCode}), retry ${serverErrorRetryCount}/${AI_RETRY.SERVER_ERROR_MAX_RETRIES} in ${(delay / 1000).toFixed(0)}s`)
        closeOpenReasoningBlock()
        onChunk(`⚠️ ${t('error.server_error_retry', { status: String(statusCode), seconds: (delay / 1000).toFixed(0), attempt: String(serverErrorRetryCount), max: String(AI_RETRY.SERVER_ERROR_MAX_RETRIES) })}\n`)
        resetForRetry()
        setTimeout(doRequest, delay)
        isCompleted = true
        return true
      }

      // 网络错误（优先 err.code，避免 TLS 握手断开等 message 不含错误码时漏重试）
      if (networkRetryCount < AI_RETRY.MAX_RETRIES && isRetryableError(error)) {
        networkRetryCount++
        const delay = calculateBackoff(AI_RETRY.BASE_DELAY, networkRetryCount - 1)
        log.warn(`ChatStream network error, retry ${networkRetryCount}/${AI_RETRY.MAX_RETRIES} in ${(delay / 1000).toFixed(0)}s`)
        closeOpenReasoningBlock()
        onChunk(`⚠️ ${t('error.network_retry', { attempt: String(networkRetryCount), max: String(AI_RETRY.MAX_RETRIES) })}\n`)
        resetForRetry()
        setTimeout(doRequest, delay)
        isCompleted = true
        return true
      }

      return false
    }

    const doRequest = () => {
    isCompleted = false

    // 重试等待期间用户可能已取消请求
    if (abortController.signal.aborted) {
      this.abortControllers.delete(reqId)
      onDone()
      return
    }

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
        timeout: AI_TIMEOUT.CONNECT,
        agent: profile.proxy ? this.getProxyAgent(profile.proxy) : (isHttps ? this.httpsAgent : this.httpAgent)
      }

      totalTimeoutId = setTimeout(() => {
        if (!isCompleted) {
          req?.destroy()
          complete(() => onError(t('error.ai_total_timeout')))
        }
      }, AI_TIMEOUT.TOTAL)

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
            const parsed = parseApiError(errorData)
            if (isContextLengthApiFailure(parsed.code, parsed.message)) {
              complete(() => onError(t('error.context_length_exceeded')))
              return
            }
            // 解析 Retry-After header
            let retryAfterMs: number | undefined
            const retryAfterHeader = res.headers['retry-after']
            if (retryAfterHeader) {
              const seconds = Number(retryAfterHeader)
              if (!isNaN(seconds) && seconds > 0) retryAfterMs = seconds * 1000
              else {
                const date = Date.parse(String(retryAfterHeader))
                if (!isNaN(date)) retryAfterMs = Math.max(1000, date - Date.now())
              }
            }
            if (!tryRetry(parsed.message, res.statusCode, retryAfterMs, parsed.code)) {
              const friendly = translateApiBusinessError(res.statusCode, parsed.code, profile.model)
              complete(() => onError(friendly || t('error.api_request_failed', { data: parsed.message })))
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
          if (!tryRetry(err)) {
            const friendly = tryFriendlyApiError(err, profile.model)
            complete(() => onError(friendly || t('error.ai_response_error', { message: translateNetworkError(err) })))
          }
        })
      })

      // 连接超时处理
      req.on('timeout', () => {
        req?.destroy()
        if (!tryRetry('ETIMEDOUT')) {
          complete(() => onError(t('error.ai_connection_timeout')))
        }
      })

      req.on('error', (err) => {
        if (abortController.signal.aborted) {
          complete(() => onDone())
          return
        }
        if (!tryRetry(err)) {
          const friendly = tryFriendlyApiError(err, profile.model)
          complete(() => onError(friendly || t('error.request_error', { message: translateNetworkError(err) })))
        }
      })

      // 支持中止请求
      abortController.signal.addEventListener('abort', () => {
        req?.destroy()
        complete(() => onDone())
      })

      const chatStreamBody = isAnthropic ? convertToAnthropicBody(requestBody as Record<string, unknown>) : requestBody
      req.write(JSON.stringify(sanitizeBodyStrings(chatStreamBody)))
      req.end()
    } catch (error) {
      const errorLike: NetworkErrorLike = error instanceof Error ? error : 'Unknown error'
      if (!tryRetry(errorLike)) {
        if (error instanceof Error) {
          const friendly = tryFriendlyApiError(error, profile.model)
          complete(() => onError(friendly || t('error.ai_request_failed', { message: translateNetworkError(error) })))
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
   * 发送带工具调用的聊天请求（非流式）
   * 用于 Agent 模式，支持 function calling
   */
  /**
   * @param options.toolChoice 'none' 表示带着 tools 发但禁止调用。
   *   用于「必须拿到文本回复」的场景（如让模型写上下文交接小结）：tools schema
   *   照常带上，前缀与平时逐字一致、前缀缓存照常命中；只是这一次不允许它转头去
   *   调工具。剔除 tools 也能达到不调用的效果，但那会改变前缀、白丢整段缓存。
   */
  async chatWithTools(
    messages: AiMessage[],
    tools: ToolDefinition[],
    profileId?: string,
    signal?: AbortSignal,
    options?: { toolChoice?: 'auto' | 'none'; maxOutputTokens?: number }
  ): Promise<ChatWithToolsResult> {
    const profile = this.getCurrentProfile(profileId)
    if (!profile) {
      throw new Error(t('error.ai_no_config'))
    }

    // 插件 provider 前置检查
    for (const provider of this.pluginProviders) {
      if (provider.match(profile)) {
        log.info(`Delegating to plugin provider "${provider.id}" for model=${profile.model}`)
        const result = await provider.chatWithTools({ messages: messages as ProviderChatParams['messages'], tools, model: profile.model, apiUrl: profile.apiUrl, apiKey: profile.apiKey })
        return result as ChatWithToolsResult
      }
    }

    const startTime = Date.now()
    const reqId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    log.info(`ChatWithTools request: model=${profile.model}, messages=${messages.length}, tools=${tools.length}`)

    const aiDebug = getAiDebugService()
    const hasImages = messagesContainImages(messages)

    aiDebug.logRequestStart(reqId, {
      profileId: profile.id,
      model: profile.model,
      messages: messages.map(m => ({
        role: m.role,
        content: m.content,
        tool_call_id: m.tool_call_id,
        tool_calls: m.tool_calls,
        reasoning_content: m.reasoning_content,
        images: m.images && m.images.length > 0
          ? m.images.map((img, i) => {
              const sizeKB = (img.length * 0.75 / 1024).toFixed(0)
              const mimeMatch = img.match(/^data:(image\/[^;]+);/)
              const mime = mimeMatch ? mimeMatch[1] : 'unknown'
              return `[image_${i}: ${mime}, ~${sizeKB}KB]`
            })
          : undefined
      })),
      tools
    })

    const doRequest = async (stripImages: boolean): Promise<ChatWithToolsResult> => {
      const fmtMessages = messages.map(msg => formatMessageForApi(msg, stripImages))

      const body = {
        model: profile.model,
        messages: fmtMessages,
        tools: tools.length > 0 ? tools : undefined,
        tool_choice: tools.length > 0 ? (options?.toolChoice ?? 'auto') : undefined,
        temperature: resolveTemperature(profile),
        max_tokens: options?.maxOutputTokens ?? resolveRequestBudget(profile).outputTokens
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
        usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
      }

      try {
        data = await this.makeRequest(profile, body, signal)
      } catch (err) {
        if (signal?.aborted) throw new Error('Aborted')
        if (!stripImages && hasImages && err instanceof Error &&
            shouldRetryWithoutImages(err.message)) {
          log.warn(`Vision request failed with images (error: ${err.message}), retrying without images`)
          return doRequest(true)
        }
        throw err
      }

      if (data.error) {
        const code = data.error.code?.toLowerCase() || data.error.type?.toLowerCase() || ''
        if (isContextLengthApiFailure(code, data.error.message)) {
          throw new Error(t('error.context_length_exceeded'))
        }
        const errorMsg = data.error.message || t('error.api_error_generic')
        if (!stripImages && hasImages &&
            shouldRetryWithoutImages(errorMsg)) {
          log.warn(`Vision request failed with images (error: ${errorMsg}), retrying without images`)
          return doRequest(true)
        }
        const friendly = translateApiBusinessError(undefined, code, profile.model)
        if (friendly) {
          throw new Error(friendly)
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

      const normalizedUsage = data.usage ? {
        prompt_tokens: data.usage.prompt_tokens ?? 0,
        completion_tokens: data.usage.completion_tokens ?? 0,
        total_tokens: data.usage.total_tokens ?? 0,
        ...extractCacheStats(data.usage)
      } : undefined

      aiDebug.logResponseDone(reqId, {
        response: choice.message?.content || undefined,
        finishReason: choice.finish_reason,
        usage: normalizedUsage,
        toolCalls: choice.message?.tool_calls?.map(tc => ({
          id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments
        }))
      })

      return {
        content: choice.message?.content || undefined,
        tool_calls: choice.message?.tool_calls,
        finish_reason: choice.finish_reason as ChatWithToolsResult['finish_reason'],
        usage: normalizedUsage,
        ...(stripImages ? { imagesStripped: true } : {})
      }
    }

    try {
      return await doRequest(false)
    } catch (error) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
      log.error(`ChatWithTools failed: model=${profile.model}, duration=${elapsed}s, error=${error instanceof Error ? error.message : error}`)
      aiDebug.logResponseError(reqId, error instanceof Error ? error.message : String(error))
      if (error instanceof Error) {
        if (error.message === t('error.context_length_exceeded')) {
          throw error
        }
        const friendly = tryFriendlyApiError(error, profile.model)
        if (friendly) {
          throw new Error(friendly)
        }
        throw new Error(t('error.ai_request_failed', { message: translateNetworkError(error) }))
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
    onToolCallProgress?: (toolCallId: string, toolName: string, partialArgs: string) => void,  // 工具调用参数流式片段（含 toolCallId 以便前端就地更新对应卡片）
    requestId?: string,  // 用于支持中止请求
    /**
     * 重试前通知调用方重置流状态（避免 reasoning 块重复）。
     * 提供 retryInfo 时调用方可据此向前端展示「正在重试 N/M」的提示，
     * 避免用户以为应用卡住了。
     */
    onRetry?: (retryInfo?: RetryInfo) => void,
    onToolCallReady?: (toolCall: ToolCall) => void,  // 流式中某个 tool_call 参数完整时回调
    onModelFailover?: (notice: AiModelFailoverNotice) => void,
    streamOptions?: ChatStreamOptions,
  ): Promise<void> {
    let profile = this.getCurrentProfile(profileId)
    if (!profile) {
      onError(t('error.ai_no_config'))
      return
    }

    let isAnthropic = isAnthropicApi(profile)
    const triedFailoverIds = new Set<string>([profile.id])
    let requestGeneration = 0

    // 创建 AbortController，使用 requestId 或生成一个唯一 ID
    const reqId = requestId || `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    const abortController = new AbortController()
    this.abortControllers.set(reqId, abortController)

    const startTime = Date.now()
    log.info(`Request started: model=${profile.model}, messages=${messages.length}, tools=${tools.length}`)

    // AI Debug: 记录请求开始
    const requestHasImages = messagesContainImages(messages)
    if (requestHasImages) {
      const imageMessages = messages.filter(m => m.images && m.images.length > 0)
      log.info(`Request contains images: ${imageMessages.length} message(s) with images`)
    }
    getAiDebugService().logRequestStart(reqId, {
      profileId: profile.id,
      model: profile.model,
      messages: messages.map(m => ({
        role: m.role,
        content: streamOptions?.truncateDebugMessages
          ? truncateBenchDebugContent(m.content)
          : m.content,
        tool_call_id: m.tool_call_id,
        tool_calls: m.tool_calls,
        reasoning_content: m.reasoning_content,
        images: m.images && m.images.length > 0
          ? m.images.map((img, i) => {
              const sizeKB = (img.length * 0.75 / 1024).toFixed(0)
              const mimeMatch = img.match(/^data:(image\/[^;]+);/)
              const mime = mimeMatch ? mimeMatch[1] : 'unknown'
              return `[image_${i}: ${mime}, ~${sizeKB}KB]`
            })
          : undefined
      })),
      tools
    })

    // 当前这次 HTTP 尝试是否已结束（重试等待期间为 true，用来挡住旧请求的收尾）
    let isCompleted = false
    // 整次请求是否已向调用方交过终态；一旦为 true 不再 onDone/onError
    let settled = false
    // 总超时计时器
    let totalTimeoutId: NodeJS.Timeout
    // 空闲超时计时器（收到数据后重置）
    let idleTimeoutId: NodeJS.Timeout
    // 自动重试退避计时器（点停止时必须清掉，否则会等到点再发下一次请求）
    let retryTimeoutId: NodeJS.Timeout | undefined
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
    let streamUsage: ChatWithToolsResult['usage'] | undefined
    // reasoning 输出状态（需跨重试可见，以便重试前关闭未闭合的 <details> 块）
    let hasReasoningOutput = false
    let hasContentOutput = false
    // 流式工具就绪追踪：已通过 onToolCallReady 回调的 tool_call 索引
    const readyToolCallIndices = new Set<number>()

    const complete = (fn: () => void) => {
      if (settled) return
      settled = true
      isCompleted = true
      if (retryTimeoutId !== undefined) {
        clearTimeout(retryTimeoutId)
        retryTimeoutId = undefined
      }
      clearTimeout(totalTimeoutId)
      clearTimeout(idleTimeoutId)
      this.abortControllers.delete(reqId)
      fn()
    }

    const scheduleRetry = (next: () => void, delay: number) => {
      if (retryTimeoutId !== undefined) clearTimeout(retryTimeoutId)
      retryTimeoutId = setTimeout(() => {
        retryTimeoutId = undefined
        next()
      }, delay)
      // 挡住旧请求的 error/timeout 收尾，但 settled 仍为 false，点停止可以立刻 complete
      isCompleted = true
    }

    // 重置状态以便重试（不重置 isCompleted，由 tryRetry/doRequest 管理）
    // retryInfo 由具体重试分支提供：网络错误 / 429 / 5xx 各自构造后通过 resetForRetry 透传
    let pendingRetryInfo: RetryInfo | undefined
    const resetForRetry = () => {
      clearTimeout(totalTimeoutId)
      clearTimeout(idleTimeoutId)
      onRetry?.(pendingRetryInfo)
      pendingRetryInfo = undefined
      content = ''
      reasoningContent = ''
      toolCalls = []
      finishReason = undefined
      streamUsage = undefined
      req = undefined
      hasReasoningOutput = false
      hasContentOutput = false
      readyToolCallIndices.clear()
    }

    // 关闭未闭合的 reasoning <details> 块（重试前调用，避免嵌套）
    // 当提供了 onRetry 时跳过 onChunk，因为调用方会整体重置流内容
    const closeOpenReasoningBlock = () => {
      if (hasReasoningOutput && !hasContentOutput) {
        if (!onRetry) {
          onChunk('\n\n</blockquote>\n</details>\n\n')
        }
        hasReasoningOutput = false
      }
    }

    const resetIdleTimeout = () => {
      const gen = requestGeneration
      clearTimeout(idleTimeoutId)
      idleTimeoutId = setTimeout(() => {
        if (gen !== requestGeneration) return
        if (!isCompleted) {
          req?.destroy()
          if (!tryRetry('ETIMEDOUT', doRequest)) {
            if (!tryModelFailover('retries_exhausted')) {
              complete(() => onError(t('error.ai_idle_timeout')))
            }
          }
        }
      }, AI_TIMEOUT.SOCKET_IDLE)
    }

    // 视觉降级标记：API 不支持 image_url 时自动剥离图片重试
    let stripImages = false
    const hasImages = messagesContainImages(messages)

    const rebuildRequestBody = () => {
      const fmtMsgs = messages.map(msg => formatMessageForApi(msg, stripImages))
      const body: Record<string, unknown> = {
        model: profile.model,
        messages: fmtMsgs,
        tools: tools.length > 0 ? tools : undefined,
        tool_choice: tools.length > 0 ? (streamOptions?.toolChoice ?? 'auto') : undefined,
        temperature: streamOptions?.temperature ?? resolveTemperature(profile),
        max_tokens: streamOptions?.maxOutputTokens ?? resolveRequestBudget(profile).outputTokens,
        stream: true
      }
      if (!isAnthropic) {
        body.stream_options = { include_usage: true }
      }
      return body
    }

    let requestBody = rebuildRequestBody()

    // 视觉降级重试：剥离图片后重新请求（最多触发一次）
    const tryVisionFallback = (errorMsg: string): boolean => {
      if (!stripImages && hasImages && shouldRetryWithoutImages(errorMsg)) {
        log.warn(`Vision request failed with images (error: ${errorMsg}), retrying without images`)
        stripImages = true
        requestBody = rebuildRequestBody()
        closeOpenReasoningBlock()
        resetForRetry()
        doRequest()
        return true
      }
      return false
    }

    const tryModelFailover = (trigger: FailoverTrigger | null): boolean => {
      if (streamOptions?.disableFailover) return false
      if (!trigger || settled || abortController.signal.aborted) return false
      if (!this.configService.get('autoFailoverModel')) return false
      const next = listFailoverCandidates(
        this.configService.getAiProfiles(),
        profile.id,
        triedFailoverIds,
        profile.contextLength,
      )[0]
      if (!next) return false

      triedFailoverIds.add(next.id)
      const notice: AiModelFailoverNotice = {
        fromId: profile.id,
        fromName: profile.name,
        usedId: next.id,
        usedName: next.name,
      }
      log.warn(`AI model failover (${trigger}): ${notice.fromName} -> ${notice.usedName}`)
      onModelFailover?.(notice)

      profile = next
      isAnthropic = isAnthropicApi(profile)
      retryCount = 0
      rateLimitRetryCount = 0
      serverErrorRetryCount = 0
      stripImages = false
      requestGeneration += 1
      isCompleted = true
      requestBody = rebuildRequestBody()
      closeOpenReasoningBlock()
      resetForRetry()
      doRequest()
      return true
    }

    // 尝试重试的辅助函数（网络错误：指数退避 + jitter；优先 err.code）
    const tryRetry = (error: NetworkErrorLike, doRequest: () => void): boolean => {
      // 已有重试在等待或请求已完成，跳过（防止 res/req 同时 emit error 导致重复重试）
      if (settled || isCompleted) return true
      if (streamOptions?.disableRetry) return false
      if (retryCount < AI_RETRY.MAX_RETRIES && isRetryableError(error)) {
        retryCount++
        const delay = calculateBackoff(AI_RETRY.BASE_DELAY, retryCount - 1)
        closeOpenReasoningBlock()
        if (!onRetry) {
          onChunk(`⚠️ ${t('error.network_retry', { attempt: String(retryCount), max: String(AI_RETRY.MAX_RETRIES) })}\n`)
        }
        const detail = [getNetworkErrorCode(error), getNetworkErrorMessage(error)].filter(Boolean).join(' ')
        getAiDebugService().logResponseError(reqId, `${detail} - 准备重试 ${retryCount}/${AI_RETRY.MAX_RETRIES} in ${(delay / 1000).toFixed(1)}s`)
        pendingRetryInfo = {
          attempt: retryCount,
          max: AI_RETRY.MAX_RETRIES,
          delayMs: delay,
          reason: 'network',
          ...(isTimeoutError(error) ? { cause: 'timeout' as const } : {})
        }
        resetForRetry()
        scheduleRetry(doRequest, delay)
        return true
      }
      return false
    }

    const doRequest = () => {
    if (settled) return
    const gen = requestGeneration
    const isStale = () => gen !== requestGeneration
    // 每次（重）试开始时允许 complete() 回调
    isCompleted = false

    // 重试等待期间用户可能已取消请求
    if (abortController.signal.aborted) {
      getAiDebugService().logResponseDone(reqId, { finishReason: 'aborted' })
      complete(() => onDone({
        content: undefined,
        tool_calls: undefined,
        finish_reason: 'stop',
        aborted: true
      }))
      return
    }

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
        timeout: AI_TIMEOUT.CONNECT,
        agent: profile.proxy ? this.getProxyAgent(profile.proxy) : (isHttps ? this.httpsAgent : this.httpAgent)
      }

      totalTimeoutId = setTimeout(() => {
        if (isStale()) return
        if (!isCompleted) {
          req?.destroy()
          if (!tryModelFailover('retries_exhausted')) {
            complete(() => onError(t('error.ai_total_timeout')))
          }
        }
      }, AI_TIMEOUT.TOTAL)

      req = httpModule.request(options, (res) => {
        if (isStale()) return
        if (res.statusCode) streamOptions?.onHttpStatus?.(res.statusCode)
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
            if (isStale()) return
            if (settled || abortController.signal.aborted) {
              complete(() => onDone({
                content: undefined,
                tool_calls: undefined,
                finish_reason: 'stop',
                aborted: true
              }))
              return
            }
            const parsed = parseApiError(errorData)
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
            log.error(`Request HTTP error: model=${profile.model}, status=${res.statusCode}, duration=${elapsed}s, error=${parsed.message.slice(0, 200)}`)
            if (
              res.statusCode === 429
              && !streamOptions?.disableRetry
              && !isAccountBillingError(parsed.code, res.statusCode)
              && !isNoRetryBusinessCode(parsed.code)
              && rateLimitRetryCount < AI_RETRY.RATE_LIMIT_MAX_RETRIES
            ) {
              // Rate limit: 优先 Retry-After header，否则指数退避 + jitter
              rateLimitRetryCount++
              const retryAfterHeader = res.headers['retry-after']
              let retryAfterMs = calculateBackoff(AI_RETRY.RATE_LIMIT_BASE_DELAY, rateLimitRetryCount - 1)
              if (retryAfterHeader) {
                const seconds = Number(retryAfterHeader)
                if (!isNaN(seconds) && seconds > 0) {
                  retryAfterMs = seconds * 1000
                } else {
                  const date = Date.parse(retryAfterHeader)
                  if (!isNaN(date)) {
                    retryAfterMs = Math.max(1000, date - Date.now())
                  }
                }
              }
              const retryAfterSec = (retryAfterMs / 1000).toFixed(0)
              log.warn(`Rate limited (429), retrying in ${retryAfterSec}s (${rateLimitRetryCount}/${AI_RETRY.RATE_LIMIT_MAX_RETRIES})`)
              closeOpenReasoningBlock()
              if (!onRetry) {
                onChunk(`⚠️ ${t('error.rate_limited', { seconds: retryAfterSec, attempt: String(rateLimitRetryCount), max: String(AI_RETRY.RATE_LIMIT_MAX_RETRIES) })}\n`)
              }
              getAiDebugService().logResponseError(reqId, `429 Rate Limited - retry ${rateLimitRetryCount}/${AI_RETRY.RATE_LIMIT_MAX_RETRIES} in ${retryAfterSec}s`)
              pendingRetryInfo = { attempt: rateLimitRetryCount, max: AI_RETRY.RATE_LIMIT_MAX_RETRIES, delayMs: retryAfterMs, reason: 'rate_limit', statusCode: 429 }
              resetForRetry()
              scheduleRetry(doRequest, retryAfterMs)
            } else if (isContextLengthApiFailure(parsed.code, parsed.message)) {
              // 已经换过模型才继续换：避免大窗口切到小窗口后卡死。原模型对话太长不换。
              if (triedFailoverIds.size > 1 && tryModelFailover('retries_exhausted')) {
                return
              }
              complete(() => onError(t('error.context_length_exceeded')))
            } else if (res.statusCode && !streamOptions?.disableRetry && AI_RETRY.RETRYABLE_STATUS_CODES.includes(res.statusCode) && serverErrorRetryCount < AI_RETRY.SERVER_ERROR_MAX_RETRIES) {
              serverErrorRetryCount++
              const delay = calculateBackoff(AI_RETRY.SERVER_ERROR_BASE_DELAY, serverErrorRetryCount - 1)
              const delaySec = (delay / 1000).toFixed(0)
              log.warn(`Server error (${res.statusCode}), retrying in ${delaySec}s (${serverErrorRetryCount}/${AI_RETRY.SERVER_ERROR_MAX_RETRIES})`)
              closeOpenReasoningBlock()
              if (!onRetry) {
                onChunk(`⚠️ ${t('error.server_error_retry', { status: String(res.statusCode), seconds: delaySec, attempt: String(serverErrorRetryCount), max: String(AI_RETRY.SERVER_ERROR_MAX_RETRIES) })}\n`)
              }
              getAiDebugService().logResponseError(reqId, `${res.statusCode} Server Error - retry ${serverErrorRetryCount}/${AI_RETRY.SERVER_ERROR_MAX_RETRIES} in ${delaySec}s`)
              pendingRetryInfo = { attempt: serverErrorRetryCount, max: AI_RETRY.SERVER_ERROR_MAX_RETRIES, delayMs: delay, reason: 'server_error', statusCode: res.statusCode }
              resetForRetry()
              scheduleRetry(doRequest, delay)
            } else if (tryVisionFallback(parsed.message)) {
              // 已降级重试
            } else {
              const status = res.statusCode
              const exhaustedTransient =
                (status === 429 && rateLimitRetryCount >= AI_RETRY.RATE_LIMIT_MAX_RETRIES) ||
                (status !== undefined && AI_RETRY.RETRYABLE_STATUS_CODES.includes(status)
                  && serverErrorRetryCount >= AI_RETRY.SERVER_ERROR_MAX_RETRIES)
              if (tryModelFailover(classifyFailoverTrigger({
                statusCode: status,
                apiErrorCode: parsed.code,
                retriesExhausted: exhaustedTransient,
              }))) {
                return
              }
              const friendly = translateApiBusinessError(res.statusCode, parsed.code, profile.model)
              complete(() => onError(friendly || t('error.api_request_failed', { data: parsed.message })))
            }
          })
          return
        }

        let buffer = ''

        res.on('data', (chunk: Buffer) => {
          if (isStale()) return
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
                if (event.usage) {
                  if (!streamUsage) streamUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
                  if (event.usage.input_tokens) streamUsage.prompt_tokens = event.usage.input_tokens
                  if (event.usage.output_tokens) streamUsage.completion_tokens = event.usage.output_tokens
                  streamUsage.total_tokens = streamUsage.prompt_tokens + streamUsage.completion_tokens
                  if (event.usage.cache_hit_tokens !== undefined) streamUsage.cache_hit_tokens = event.usage.cache_hit_tokens
                  if (event.usage.cache_miss_tokens !== undefined) streamUsage.cache_miss_tokens = event.usage.cache_miss_tokens
                }
              } else {
                if (data === '[DONE]') {
                  isDone = true
                } else {
                  try {
                    const json = JSON.parse(data)
                    delta = json.choices?.[0]?.delta
                    reason = json.choices?.[0]?.finish_reason
                    if (json.usage) {
                      const cacheStats = extractCacheStats(json.usage)
                      streamUsage = {
                        prompt_tokens: json.usage.prompt_tokens ?? 0,
                        completion_tokens: json.usage.completion_tokens ?? 0,
                        total_tokens: json.usage.total_tokens ?? 0,
                        ...cacheStats
                      }
                      const extraKeys = Object.keys(json.usage).filter(k => !['prompt_tokens', 'completion_tokens', 'total_tokens'].includes(k))
                      if (extraKeys.length > 0) {
                        const extraData = Object.fromEntries(extraKeys.map(k => [k, json.usage[k]]))
                        log.info(`Stream usage details: ${JSON.stringify(extraData)}`)
                      }
                    }
                  } catch { continue }
                }
              }

              if (reason) finishReason = reason

              if (isDone) {
                if (hasReasoningOutput && !hasContentOutput) {
                  onChunk('\n\n</blockquote>\n</details>')
                }
                // 有 tool_calls 时不用 reasoning 兜底 content，避免 HTML 进入对话历史
                // reasoning 已通过 streaming onChunk 展示，且保存在 reasoning_content 字段中
                const hasToolCalls = toolCalls.length > 0
                const finalContent = content || (!hasToolCalls && reasoningContent ? `<details>\n<summary>🤔 <strong>${t('ai.thinking_process')}</strong></summary>\n\n<blockquote>\n\n${reasoningContent}\n\n</blockquote>\n</details>` : undefined)
                complete(() => onDone({
                  content: finalContent,
                  tool_calls: hasToolCalls ? toolCalls : undefined,
                  finish_reason: finishReason as ChatWithToolsResult['finish_reason'],
                  // 用 hasReasoningOutput 而非字符串非空作为"是否思考模式"标志：
                  // DeepSeek V3.2+ 要求带 tool_calls 的 assistant 在后续请求中回传此字段，
                  // 因此即使思考内容为空字符串也保留，避免被 || 转为 undefined 后丢失
                  reasoning_content: hasReasoningOutput ? reasoningContent : undefined,
                  usage: streamUsage,
                  ...(stripImages ? { imagesStripped: true } : {})
                }))
                return
              }

              if (delta?.reasoning_content) {
                if (!hasReasoningOutput) {
                  hasReasoningOutput = true
                  onChunk(`<details open>\n<summary>🤔 <strong>${t('ai.thinking_process')}</strong></summary>\n\n<blockquote>\n\n`)
                }
                reasoningContent += delta.reasoning_content
                onChunk(delta.reasoning_content)
                getAiDebugService().logResponseChunk(reqId, `[THINKING] ${delta.reasoning_content}`)
              }

              if (delta?.content) {
                if (hasReasoningOutput && !hasContentOutput) {
                  hasContentOutput = true
                  onChunk('\n\n</blockquote>\n</details>\n\n')
                }
                content += delta.content
                onChunk(delta.content)
                getAiDebugService().logResponseChunk(reqId, delta.content)
              }

              if (delta?.tool_calls) {
                if (hasReasoningOutput && !hasContentOutput) {
                  hasContentOutput = true
                  onChunk('\n\n</blockquote>\n</details>\n\n')
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
                    onToolCallProgress(
                      toolCalls[index].id,
                      toolCalls[index].function.name,
                      toolCalls[index].function.arguments
                    )
                  }
                  // 检测 tool_call 参数是否已完整（可解析为 JSON）
                  if (onToolCallReady && toolCalls[index] && !readyToolCallIndices.has(index)) {
                    const tc = toolCalls[index]
                    if (tc.id && tc.function.name && tc.function.arguments) {
                      try {
                        JSON.parse(tc.function.arguments)
                        readyToolCallIndices.add(index)
                        onToolCallReady(tc)
                      } catch {
                        // 参数尚不完整，继续等待
                      }
                    }
                  }
                }
              }
            }
          }
        })

        res.on('end', () => {
          if (isStale()) return
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

          if (!isCompleted && hasReasoningOutput && !hasContentOutput) {
            onChunk('\n\n</blockquote>\n</details>')
          }
          const hasToolCalls = toolCalls.length > 0
          const finalContent = content || (!hasToolCalls && reasoningContent ? `<details>\n<summary>🤔 <strong>${t('ai.thinking_process')}</strong></summary>\n\n<blockquote>\n\n${reasoningContent}\n\n</blockquote>\n</details>` : undefined)

          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
          const toolNames = toolCalls.map(tc => tc.function.name).join(', ')
          let usageStr = streamUsage ? `, tokens=${streamUsage.prompt_tokens}+${streamUsage.completion_tokens}=${streamUsage.total_tokens}` : ''
          if (streamUsage?.cache_hit_tokens !== undefined) {
            const hitRate = streamUsage.prompt_tokens > 0 ? Math.round(streamUsage.cache_hit_tokens / streamUsage.prompt_tokens * 100) : 0
            usageStr += `, cache=${streamUsage.cache_hit_tokens}/${streamUsage.cache_miss_tokens ?? '?'}(${hitRate}%hit)`
          }
          log.info(`Request done: model=${profile.model}, duration=${elapsed}s, finish=${finishReason || 'end'}, tools=[${toolNames}], contentLen=${(finalContent || '').length}${usageStr}`)

          // AI Debug: 记录响应完成（包含工具调用）
          getAiDebugService().logResponseDone(reqId, {
            response: finalContent,
            reasoningContent: hasReasoningOutput ? reasoningContent : undefined,
            finishReason,
            usage: streamUsage,
            toolCalls: hasToolCalls ? toolCalls.map(tc => ({
              id: tc.id,
              name: tc.function.name,
              arguments: tc.function.arguments
            })) : undefined
          })
          if (hasToolCalls) {
            onToolCall(toolCalls)
          }
          complete(() => onDone({
            content: finalContent,
            tool_calls: hasToolCalls ? toolCalls : undefined,
            finish_reason: finishReason as ChatWithToolsResult['finish_reason'],
            reasoning_content: hasReasoningOutput ? reasoningContent : undefined,
            usage: streamUsage,
            ...(stripImages ? { imagesStripped: true } : {})
          }))
        })

        res.on('error', (err) => {
          if (isStale()) return
          if (abortController.signal.aborted) {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
            log.debug(`Request aborted: model=${profile.model}, duration=${elapsed}s`)
            getAiDebugService().logResponseDone(reqId, { finishReason: 'aborted' })
            complete(() => onDone({
              content: undefined,
              tool_calls: undefined,
              finish_reason: 'stop',
              aborted: true
            }))
            return
          }
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
          log.error(`Request failed: model=${profile.model}, duration=${elapsed}s, error=${err.message}`)
          if (!tryRetry(err, doRequest)) {
            getAiDebugService().logResponseError(reqId, err.message)
            const friendly = tryFriendlyApiError(err, profile.model)
            if (!tryModelFailover(classifyFailoverTrigger({
              statusCode: (err as ApiRequestError).statusCode,
              apiErrorCode: (err as ApiRequestError).apiErrorCode,
              retriesExhausted: true,
            }))) {
              complete(() => onError(friendly || t('error.request_error', { message: translateNetworkError(err) })))
            }
          }
        })
      })

      // 连接超时处理
      req.on('timeout', () => {
        if (isStale()) return
        req?.destroy()
        if (!tryRetry('ETIMEDOUT', doRequest)) {
          const errorMsg = t('error.ai_connection_timeout')
          getAiDebugService().logResponseError(reqId, errorMsg)
          if (!tryModelFailover('retries_exhausted')) {
            complete(() => onError(errorMsg))
          }
        }
      })

      req.on('error', (err) => {
        if (isStale()) return
        // 只有用户主动中止时才静默处理（socket hang up 也可能是网络断开，不能一律吞掉）
        if (abortController.signal.aborted) {
          getAiDebugService().logResponseDone(reqId, { finishReason: 'aborted' })
          complete(() => onDone({
            content: undefined,
            tool_calls: undefined,
            finish_reason: 'stop',
            aborted: true
          }))
          return
        }
        if (tryVisionFallback(err.message)) return
        // 尝试重试网络错误（包括 socket hang up / TLS 握手中断）
        if (!tryRetry(err, doRequest)) {
          getAiDebugService().logResponseError(reqId, err.message)
          const friendly = tryFriendlyApiError(err, profile.model)
          if (!tryModelFailover('retries_exhausted')) {
            complete(() => onError(friendly || t('error.request_error', { message: translateNetworkError(err) })))
          }
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
        if (!isCompleted && hasReasoningOutput && !hasContentOutput) {
          onChunk('\n\n</blockquote>\n</details>')
        }
        const hasValidTools = validToolCalls.length > 0
        const finalContent = content || (!hasValidTools && reasoningContent ? `<details>\n<summary>🤔 <strong>${t('ai.thinking_process')}</strong></summary>\n\n<blockquote>\n\n${reasoningContent}\n\n</blockquote>\n</details>` : undefined)
        complete(() => onDone({
          content: finalContent,
          tool_calls: hasValidTools ? validToolCalls : undefined,
          finish_reason: 'stop',
          reasoning_content: hasReasoningOutput ? reasoningContent : undefined,
          aborted: true
        }))
      })

      const toolStreamBody = isAnthropic ? convertToAnthropicBody(requestBody as Record<string, unknown>) : requestBody
      req.write(JSON.stringify(sanitizeBodyStrings(toolStreamBody)))
      req.end()
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error'
      if (tryVisionFallback(errorMsg)) return
      const errorLike: NetworkErrorLike = error instanceof Error ? error : errorMsg
      // 尝试重试网络错误
      if (!tryRetry(errorLike, doRequest)) {
        getAiDebugService().logResponseError(reqId, `Exception: ${errorMsg}`)
        if (tryModelFailover('retries_exhausted')) return
        if (error instanceof Error) {
          const friendly = tryFriendlyApiError(error, profile.model)
          complete(() => onError(friendly || t('error.ai_request_failed', { message: translateNetworkError(error) })))
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

