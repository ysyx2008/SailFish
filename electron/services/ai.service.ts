import { ConfigService } from './config.service'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'
import * as https from 'https'
import * as http from 'http'
import { t } from './agent/i18n'
import { aiDebugService } from './ai-debug.service'

// AI 请求超时配置（毫秒）
const AI_TIMEOUT = {
  CONNECT: 30 * 1000,        // 连接超时：30 秒
  SOCKET_IDLE: 120 * 1000,   // 空闲超时：120 秒（流式请求中数据流中断检测）
  TOTAL: 10 * 60 * 1000      // 总超时：10 分钟（长文本生成可能需要较长时间）
}

export interface AiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_call_id?: string  // 用于 tool 角色的消息
  tool_calls?: ToolCall[]  // 用于 assistant 角色的工具调用
  reasoning_content?: string  // 用于 think 模型的思考内容（DeepSeek-R1 等）
}

// Tool Calling 相关类型
export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, {
        type: string
        description: string
        enum?: string[]
        items?: { type: string }  // 数组类型的元素类型
      }>
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

export interface AiProfile {
  id: string
  name: string
  apiUrl: string
  apiKey: string
  model: string
  proxy?: string
  contextLength?: number  // 模型上下文长度（tokens），默认 8000
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
      throw new Error('未配置 AI 模型，请先在设置中添加 AI 配置')
    }

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
        // 检测上下文超限错误
        const errorMsg = data.error.message?.toLowerCase() || ''
        const errorCode = data.error.code?.toLowerCase() || ''
        
        if (errorMsg.includes('context_length') || 
            errorMsg.includes('maximum context') ||
            (errorMsg.includes('token') && errorMsg.includes('limit')) ||
            errorCode.includes('context_length')) {
          throw new Error(`上下文超出模型限制。请清除部分对话历史后重试。`)
        }
        
        throw new Error(`AI API 错误: ${data.error.message}`)
      }

      return data.choices?.[0]?.message?.content || ''
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes('上下文超出')) {
          throw error
        }
        const msg = error.message.toLowerCase()
        if (msg.includes('context_length') || 
            msg.includes('maximum context') ||
            (msg.includes('token') && msg.includes('limit'))) {
          throw new Error(`上下文超出模型限制。请清除部分对话历史后重试。`)
        }
        throw new Error(`AI 请求失败: ${error.message}`)
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
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${profile.apiKey}`
        },
        timeout: AI_TIMEOUT.CONNECT  // 连接超时
      }

      // 应用代理
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
          complete(() => reject(new Error('AI 请求超时（已等待 10 分钟），请检查网络连接后重试。[ETIMEDOUT]')))
        }
      }, AI_TIMEOUT.TOTAL)

      const req = httpModule.request(options, (res) => {
        let data = ''
        
        // 设置 socket 空闲超时
        res.socket?.setTimeout(AI_TIMEOUT.SOCKET_IDLE)
        res.socket?.on('timeout', () => {
          req.destroy()
          complete(() => reject(new Error('AI 服务响应中断（连接空闲超时），请稍后重试。[ETIMEDOUT]')))
        })

        res.on('data', (chunk) => {
          data += chunk
        })
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            complete(() => {
              try {
                resolve(JSON.parse(data))
              } catch {
                reject(new Error(`响应解析失败: ${data}`))
              }
            })
          } else {
            complete(() => reject(new Error(t('error.api_request_failed', { status: res.statusCode || 0, data }))))
          }
        })
      })

      // 连接超时处理
      req.on('timeout', () => {
        req.destroy()
        complete(() => reject(new Error('连接 AI 服务超时，请检查网络连接。[ETIMEDOUT]')))
      })

      req.on('error', (err) => {
        complete(() => reject(new Error(t('error.request_error', { message: err.message }))))
      })

      // 支持中止请求
      if (signal) {
        signal.addEventListener('abort', () => {
          req.destroy()
          complete(() => reject(new Error(t('error.request_aborted'))))
        })
      }

      req.write(JSON.stringify(body))
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
      onError('未配置 AI 模型，请先在设置中添加 AI 配置')
      return
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
          complete(() => onError('AI 服务响应中断（长时间未收到数据），请稍后重试。[ETIMEDOUT]'))
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
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${profile.apiKey}`
        },
        timeout: AI_TIMEOUT.CONNECT  // 连接超时
      }

      // 应用代理
      if (profile.proxy) {
        options.agent = this.getProxyAgent(profile.proxy)
      }

      // 启动总超时计时器
      totalTimeoutId = setTimeout(() => {
        if (!isCompleted) {
          req?.destroy()
          complete(() => onError('AI 请求超时（已等待 10 分钟），请检查网络连接后重试。[ETIMEDOUT]'))
        }
      }, AI_TIMEOUT.TOTAL)

      let hasReasoningOutput = false  // 标记是否已输出思考内容
      let hasContentOutput = false    // 标记是否已输出正常内容

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
            // 检测上下文超限错误
            const errorLower = errorData.toLowerCase()
            if (errorLower.includes('context_length') || 
                errorLower.includes('maximum context') ||
                (errorLower.includes('token') && errorLower.includes('limit')) ||
                errorLower.includes('too many tokens')) {
              complete(() => onError(`上下文超出模型限制。请清除部分对话历史后重试。`))
            } else {
              complete(() => onError(`AI API 请求失败: ${res.statusCode} - ${errorData}`))
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
              const data = trimmedLine.slice(6)
              if (data === '[DONE]') {
                // 如果只有思考内容没有回复，添加结束标记
                if (hasReasoningOutput && !hasContentOutput) {
                  onChunk('\n\n</details>\n')
                }
                complete(() => onDone())
                return
              }

              try {
                const parsed = JSON.parse(data) as {
                  choices?: { delta?: { content?: string; reasoning_content?: string } }[]
                }
                const delta = parsed.choices?.[0]?.delta
                
                // 处理 think 模型的 reasoning_content（思考过程）
                if (delta?.reasoning_content) {
                  if (!hasReasoningOutput) {
                    hasReasoningOutput = true
                    // 使用 details 标签创建可折叠的思考区域
                    onChunk('<details open>\n<summary>🤔 <strong>思考过程</strong>（点击折叠）</summary>\n\n<blockquote>\n\n')
                  }
                  onChunk(delta.reasoning_content)
                }
                
                // 处理正常的 content
                if (delta?.content) {
                  // 如果之前有思考过程，现在开始输出最终内容，添加分隔
                  if (hasReasoningOutput && !hasContentOutput) {
                    hasContentOutput = true
                    onChunk('\n\n</blockquote>\n</details>\n\n---\n\n### 💬 回复\n\n')
                  }
                  onChunk(delta.content)
                }
              } catch {
                // 忽略解析错误
              }
            }
          }
        })

        res.on('end', () => {
          complete(() => onDone())
        })

        res.on('error', (err) => {
          complete(() => onError(`响应错误: ${err.message}`))
        })
      })

      // 连接超时处理
      req.on('timeout', () => {
        req?.destroy()
        complete(() => onError('连接 AI 服务超时，请检查网络连接。[ETIMEDOUT]'))
      })

      req.on('error', (err) => {
        // 检查是否是中止错误（可能是原始消息或国际化后的消息）
        if (err.message === t('error.request_aborted') || err.message.includes('aborted')) {
          complete(() => onDone())
          return
        }
        complete(() => onError(t('error.request_error', { message: err.message })))
      })

      // 支持中止请求
      abortController.signal.addEventListener('abort', () => {
        req?.destroy()
        complete(() => onDone())
      })

      req.write(JSON.stringify(requestBody))
      req.end()
    } catch (error) {
      if (error instanceof Error) {
        complete(() => onError(`AI 请求失败: ${error.message}`))
      } else {
        complete(() => onError('AI 请求失败: 未知错误'))
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
      throw new Error('未配置 AI 模型，请先在设置中添加 AI 配置')
    }

    // 转换消息格式，处理 tool_calls 和 reasoning_content（支持 think 模型）
    const formattedMessages = messages.map(msg => {
      if (msg.role === 'tool') {
        return {
          role: 'tool' as const,
          content: msg.content,
          tool_call_id: msg.tool_call_id
        }
      }
      if (msg.role === 'assistant' && msg.tool_calls) {
        const assistantMsg: {
          role: 'assistant'
          content: string | null
          tool_calls: ToolCall[]
          reasoning_content?: string
        } = {
          role: 'assistant' as const,
          content: msg.content || null,
          tool_calls: msg.tool_calls
        }
        if (msg.reasoning_content) {
          assistantMsg.reasoning_content = msg.reasoning_content
        }
        return assistantMsg
      }
      return {
        role: msg.role,
        content: msg.content
      }
    })

    const requestBody = {
      model: profile.model,
      messages: formattedMessages,
      tools: tools.length > 0 ? tools : undefined,
      tool_choice: tools.length > 0 ? 'auto' : undefined,
      temperature: 0.7,
      max_tokens: 4096
    }

    try {
      const data = await this.makeRequest<{
        choices?: {
          message?: {
            content?: string | null
            tool_calls?: ToolCall[]
          }
          finish_reason?: string
        }[]
        error?: { message?: string; code?: string; type?: string }
      }>(profile, requestBody)

      if (data.error) {
        // 检测上下文超限错误
        const errorMsg = data.error.message?.toLowerCase() || ''
        const errorCode = data.error.code?.toLowerCase() || ''
        const errorType = data.error.type?.toLowerCase() || ''
        
        if (errorMsg.includes('context_length') || 
            errorMsg.includes('maximum context') ||
            errorMsg.includes('token') && errorMsg.includes('limit') ||
            errorMsg.includes('too many tokens') ||
            errorMsg.includes('too long') ||
            errorCode.includes('context_length') ||
            errorType.includes('context_length')) {
          throw new Error(`上下文超出模型限制。请清除部分对话历史后重试。\n原始错误: ${data.error.message}`)
        }
        
        throw new Error(`AI API 错误: ${data.error.message}`)
      }

      const choice = data.choices?.[0]
      if (!choice) {
        throw new Error('AI 返回结果为空')
      }

      return {
        content: choice.message?.content || undefined,
        tool_calls: choice.message?.tool_calls,
        finish_reason: choice.finish_reason as ChatWithToolsResult['finish_reason']
      }
    } catch (error) {
      if (error instanceof Error) {
        // 如果已经是格式化的错误，直接抛出
        if (error.message.includes('上下文超出')) {
          throw error
        }
        // 再次检测错误消息中的上下文超限
        const msg = error.message.toLowerCase()
        if (msg.includes('context_length') || 
            msg.includes('maximum context') ||
            (msg.includes('token') && msg.includes('limit'))) {
          throw new Error(`上下文超出模型限制。请清除部分对话历史后重试。`)
        }
        throw new Error(`AI 请求失败: ${error.message}`)
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
      onError('未配置 AI 模型，请先在设置中添加 AI 配置')
      return
    }

    // 创建 AbortController，使用 requestId 或生成一个唯一 ID
    const reqId = requestId || `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    const abortController = new AbortController()
    this.abortControllers.set(reqId, abortController)

    // AI Debug: 记录请求开始
    aiDebugService.logRequestStart(reqId, {
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

    const resetIdleTimeout = () => {
      clearTimeout(idleTimeoutId)
      idleTimeoutId = setTimeout(() => {
        if (!isCompleted) {
          req?.destroy()
          complete(() => onError('AI 服务响应中断（长时间未收到数据），请稍后重试。[ETIMEDOUT]'))
        }
      }, AI_TIMEOUT.SOCKET_IDLE)
    }

    // 转换消息格式，支持 think 模型的 reasoning_content
    const formattedMessages = messages.map(msg => {
      if (msg.role === 'tool') {
        return {
          role: 'tool' as const,
          content: msg.content,
          tool_call_id: msg.tool_call_id
        }
      }
      if (msg.role === 'assistant' && msg.tool_calls) {
        // DeepSeek think 模型要求包含 reasoning_content
        const assistantMsg: {
          role: 'assistant'
          content: string | null
          tool_calls: ToolCall[]
          reasoning_content?: string
        } = {
          role: 'assistant' as const,
          content: msg.content || null,
          tool_calls: msg.tool_calls
        }
        if (msg.reasoning_content) {
          assistantMsg.reasoning_content = msg.reasoning_content
        }
        return assistantMsg
      }
      return {
        role: msg.role,
        content: msg.content
      }
    })

    const requestBody = {
      model: profile.model,
      messages: formattedMessages,
      tools: tools.length > 0 ? tools : undefined,
      tool_choice: tools.length > 0 ? 'auto' : undefined,
      temperature: 0.7,
      max_tokens: 4096,
      stream: true
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
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${profile.apiKey}`
        },
        timeout: AI_TIMEOUT.CONNECT  // 连接超时
      }

      if (profile.proxy) {
        options.agent = this.getProxyAgent(profile.proxy)
      }

      // 启动总超时计时器
      totalTimeoutId = setTimeout(() => {
        if (!isCompleted) {
          req?.destroy()
          complete(() => onError('AI 请求超时（已等待 10 分钟），请检查网络连接后重试。[ETIMEDOUT]'))
        }
      }, AI_TIMEOUT.TOTAL)

      let hasReasoningOutput = false  // 标记是否已输出思考内容的开始标记
      let hasContentOutput = false    // 标记是否已开始输出正常内容

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
            complete(() => onError(`AI API 请求失败: ${res.statusCode} - ${errorData}`))
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
            // 再次检查，防止在循环中被 abort
            if (abortController.signal.aborted || isCompleted) {
              return
            }
            if (line.startsWith('data: ')) {
              const data = line.slice(6).trim()
              if (data === '[DONE]') {
                // 如果有思考内容但没有最终内容
                const finalContent = content || (reasoningContent ? `🤔 **思考过程**\n\n> ${reasoningContent.replace(/\n/g, '\n> ')}` : undefined)
                complete(() => onDone({
                  content: finalContent,
                  tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
                  finish_reason: finishReason as ChatWithToolsResult['finish_reason'],
                  reasoning_content: reasoningContent || undefined  // 返回原始思考内容，用于消息历史
                }))
                return
              }

              try {
                const json = JSON.parse(data)
                const delta = json.choices?.[0]?.delta
                const reason = json.choices?.[0]?.finish_reason

                if (reason) {
                  finishReason = reason
                }

                // 处理 think 模型的 reasoning_content（思考过程）
                // DeepSeek-R1 等模型会返回 reasoning_content 字段
                if (delta?.reasoning_content) {
                  // 第一次收到 reasoning_content 时，输出开始标记
                  if (!hasReasoningOutput) {
                    hasReasoningOutput = true
                    // Agent 模式：简单的思考指示，不使用 HTML
                    onChunk(t('ai.thinking_with_emoji'))
                  }
                  reasoningContent += delta.reasoning_content
                  // 输出思考内容，使用引用格式
                  onChunk(delta.reasoning_content.replace(/\n/g, '\n> '))
                  // AI Debug: 记录思考过程
                  aiDebugService.logResponseChunk(reqId, `[THINKING] ${delta.reasoning_content}`)
                }

                // 处理正常的 content（最终回复）
                if (delta?.content) {
                  // 如果之前有思考过程，现在开始输出最终内容，添加分隔
                  if (hasReasoningOutput && !hasContentOutput) {
                    hasContentOutput = true
                    onChunk('\n\n---\n\n**回复：** ')
                  }
                  content += delta.content
                  onChunk(delta.content)
                  // AI Debug: 记录响应流式片段
                  aiDebugService.logResponseChunk(reqId, delta.content)
                }

                // 处理 tool_calls 流式更新
                if (delta?.tool_calls) {
                  // 如果有思考过程还没关闭，先关闭
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
                      if (tc.id) {
                        toolCalls[index].id = tc.id
                      }
                      if (tc.function?.name) {
                        toolCalls[index].function.name = tc.function.name
                      }
                      if (tc.function?.arguments) {
                        toolCalls[index].function.arguments += tc.function.arguments
                      }
                    }
                    // 通知工具调用参数生成进度
                    if (onToolCallProgress && toolCalls[index]) {
                      const toolName = toolCalls[index].function.name
                      const argsLength = toolCalls[index].function.arguments.length
                      onToolCallProgress(toolName, argsLength)
                    }
                  }
                }
              } catch {
                // 忽略解析错误
              }
            }
          }
        })

        res.on('end', () => {
          // 如果有工具调用，通知一次，并记录到调试日志
          if (toolCalls.length > 0) {
            onToolCall(toolCalls)
            // AI Debug: 记录工具调用
            toolCalls.forEach(tc => {
              aiDebugService.logToolCall(reqId, {
                id: tc.id,
                name: tc.function.name,
                arguments: tc.function.arguments
              })
            })
          }
          // 如果有思考内容但没有最终内容，把思考内容作为最终内容
          const finalContent = content || (reasoningContent ? `🤔 **思考过程**\n\n> ${reasoningContent.replace(/\n/g, '\n> ')}` : undefined)
          // AI Debug: 记录响应完成
          aiDebugService.logResponseDone(reqId, {
            response: finalContent,
            finishReason
          })
          complete(() => onDone({
            content: finalContent,
            tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
            finish_reason: finishReason as ChatWithToolsResult['finish_reason'],
            reasoning_content: reasoningContent || undefined  // 返回原始思考内容，用于消息历史
          }))
        })

        res.on('error', (err) => {
          // AI Debug: 记录错误
          aiDebugService.logResponseError(reqId, err.message)
          complete(() => onError(t('error.request_error', { message: err.message })))
        })
      })

      // 连接超时处理
      req.on('timeout', () => {
        req?.destroy()
        // AI Debug: 记录超时错误
        aiDebugService.logResponseError(reqId, '连接 AI 服务超时，请检查网络连接。[ETIMEDOUT]')
        complete(() => onError('连接 AI 服务超时，请检查网络连接。[ETIMEDOUT]'))
      })

      req.on('error', (err) => {
        // 如果是中止导致的错误，不报错
        if (err.message === 'aborted' || err.message.includes('socket hang up')) {
          // AI Debug: 记录中止
          aiDebugService.logResponseDone(reqId, { finishReason: 'aborted' })
          complete(() => onDone({
            content: undefined,
            tool_calls: undefined,
            finish_reason: 'stop'
          }))
          return
        }
        // AI Debug: 记录请求错误
        aiDebugService.logResponseError(reqId, err.message)
        complete(() => onError(`请求失败: ${err.message}`))
      })

      // 支持中止请求
      abortController.signal.addEventListener('abort', () => {
        req?.destroy()
        complete(() => onDone({
          content: content || undefined,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
          finish_reason: 'stop'
        }))
      })

      req.write(JSON.stringify(requestBody))
      req.end()
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error'
      // AI Debug: 记录请求异常
      aiDebugService.logResponseError(reqId, `Exception: ${errorMsg}`)
      if (error instanceof Error) {
        complete(() => onError(`AI 请求失败: ${error.message}`))
      } else {
        complete(() => onError('AI 请求失败'))
      }
    }
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

