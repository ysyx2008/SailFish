/**
 * MCP (Model Context Protocol) 客户端服务
 * 管理与外部 MCP 服务器的连接，聚合工具、资源和提示模板
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { ToolDefinition } from './ai.service'
import type { ToolDefinitionWithMeta } from './agent/tools'
import { formatMcpToolCallContent, resolveMcpToolDisplayLabel } from './mcp-tool-display'
import { toMcpSkillId, parseMcpSkillId } from './mcp-progressive-constants'
import { classifyMcpConnectError, type McpConnectErrorKind } from './mcp-connect-error'
import { ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import { app } from 'electron'
import { createLogger } from '../utils/logger'

const log = createLogger('MCP')

/**
 * 构造 SSE/Streamable-HTTP transport 的初始化选项
 *
 * SDK 内部的 `_commonHeaders()` 会从 `requestInit.headers` 提取自定义请求头，
 * 自动合并到所有 GET (SSE)、POST、DELETE 请求中，因此只需把 headers 放进
 * `requestInit` 即可同时覆盖两种传输方式（SSE 和 Streamable HTTP）。
 */
function buildHttpTransportOptions(headers?: Record<string, string>): { requestInit?: RequestInit } | undefined {
  if (!headers || Object.keys(headers).length === 0) return undefined
  return { requestInit: { headers } }
}

// MCP 服务器配置
import type { McpServerConfig } from '@shared/types'
export type { McpServerConfig }

// MCP 工具信息
export interface McpTool {
  serverId: string
  serverName: string
  name: string
  /** MCP 规范可选字段，人类可读标题（常为中文） */
  title?: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
}

/** @deprecated 检索已改为按 server 整包 load；保留类型以免外部引用断裂 */
export interface McpToolSearchHit {
  tool: McpTool
  fullName: string
  score: number
}

// MCP 资源信息
export interface McpResource {
  serverId: string
  serverName: string
  uri: string
  name: string
  description?: string
  mimeType?: string
}

// MCP 提示模板信息
export interface McpPrompt {
  serverId: string
  serverName: string
  name: string
  description?: string
  arguments?: Array<{
    name: string
    description?: string
    required?: boolean
  }>
}

// 服务器连接状态
export interface McpServerStatus {
  id: string
  name: string
  connected: boolean
  error?: string
  errorKind?: McpConnectErrorKind
  toolCount: number
  resourceCount: number
  promptCount: number
}

// 内部连接管理
interface McpConnection {
  config: McpServerConfig
  client: Client
  transport: Transport
  process?: ChildProcess
  tools: McpTool[]
  resources: McpResource[]
  prompts: McpPrompt[]
}

export class McpService extends EventEmitter {
  private connections: Map<string, McpConnection> = new Map()
  // 存储工具名称映射：生成的名称 -> { serverId, toolName }
  private toolNameMap: Map<string, { serverId: string; toolName: string }> = new Map()
  /** ensureConnected 进行中的 Promise，按 serverId 去重 */
  private connecting: Map<string, Promise<void>> = new Map()
  /** 最近一次连接失败（已连接成功或主动断开后清除） */
  private lastErrors: Map<string, { name: string; error: string; errorKind?: McpConnectErrorKind }> = new Map()

  constructor() {
    super()
  }

  /**
   * 连接到 MCP 服务器
   */
  async connect(config: McpServerConfig): Promise<void> {
    // 如果已连接，先断开
    if (this.connections.has(config.id)) {
      await this.disconnect(config.id)
    }

    log.info(`Connecting to server: ${config.name} (${config.id})`)

    let transport: Transport | undefined
    try {
      if (config.transport === 'stdio') {
        if (!config.command) {
          throw new Error('stdio 模式需要指定 command')
        }

        // 合并环境变量
        const mergedEnv: Record<string, string> = {}
        for (const [key, value] of Object.entries({ ...process.env, ...config.env })) {
          if (typeof value === 'string') mergedEnv[key] = value
        }
        
        log.info(`Starting ${config.name} with command: ${config.command}`)
        log.info(`Args: ${JSON.stringify(config.args)}`)
        log.info(`Custom env keys: ${Object.keys(config.env || {}).join(', ') || 'none'}`)

        // StdioClientTransport 会自动创建和管理子进程
        transport = new StdioClientTransport({
          command: config.command,
          args: config.args,
          env: mergedEnv,
          cwd: config.cwd
        })
      } else if (config.transport === 'sse') {
        if (!config.url) {
          throw new Error('sse 模式需要指定 url')
        }

        log.info(`Connecting ${config.name} via SSE: ${config.url} (custom headers: ${Object.keys(config.headers || {}).join(', ') || 'none'})`)
        transport = new SSEClientTransport(new URL(config.url), buildHttpTransportOptions(config.headers))
      } else if (config.transport === 'http') {
        if (!config.url) {
          throw new Error('http 模式需要指定 url')
        }

        log.info(`Connecting ${config.name} via Streamable HTTP: ${config.url} (custom headers: ${Object.keys(config.headers || {}).join(', ') || 'none'})`)
        transport = new StreamableHTTPClientTransport(new URL(config.url), buildHttpTransportOptions(config.headers))
      } else {
        throw new Error(`不支持的传输类型: ${config.transport}`)
      }

      // 创建 MCP 客户端
      const client = new Client({
        name: app.getName(),
        version: app.getVersion()
      })

      // 连接到服务器
      await client.connect(transport)

      // 获取服务器能力
      const tools = await this.fetchTools(client, config)
      const resources = await this.fetchResources(client, config)
      const prompts = await this.fetchPrompts(client, config)

      // 保存连接
      const connection: McpConnection = {
        config,
        client,
        transport,
        tools,
        resources,
        prompts
      }
      this.connections.set(config.id, connection)
      this.lastErrors.delete(config.id)

      log.info(`Connected to ${config.name}: ${tools.length} tools, ${resources.length} resources, ${prompts.length} prompts`)
      
      this.emit('connected', config.id)
    } catch (error) {
      if (transport) {
        try { await transport.close() } catch { /* 连接失败时尽力关掉已拉起的 transport */ }
      }
      const classified = classifyMcpConnectError(error)
      this.lastErrors.set(config.id, {
        name: config.name,
        error: classified.message,
        errorKind: classified.kind
      })
      this.emit('error', { serverId: config.id, error: classified.message })
      log.error(`Failed to connect to ${config.name}:`, error)
      const wrapped = new Error(`连接 MCP 连接器 ${config.name} 失败: ${classified.message}`)
      ;(wrapped as Error & { cause?: unknown }).cause = error
      throw wrapped
    }
  }

  /**
   * 断开 MCP 服务器连接
   */
  async disconnect(serverId: string): Promise<void> {
    const connection = this.connections.get(serverId)
    if (!connection) return

    log.info(`Disconnecting from server: ${connection.config.name}`)

    try {
      await connection.client.close()
    } catch (error) {
      log.error(`Error closing client:`, error)
    }

    // 终止子进程
    if (connection.process) {
      connection.process.kill()
    }

    this.connections.delete(serverId)
    this.lastErrors.delete(serverId)
    this.emit('disconnected', serverId)
  }

  /**
   * 断开所有连接
   */
  async disconnectAll(): Promise<void> {
    const serverIds = Array.from(this.connections.keys())
    for (const serverId of serverIds) {
      await this.disconnect(serverId)
    }
  }

  /**
   * 处理意外断开
   */
  private handleDisconnect(serverId: string, error?: string): void {
    const connection = this.connections.get(serverId)
    if (connection) {
      this.connections.delete(serverId)
      if (error) {
        this.lastErrors.set(serverId, { name: connection.config.name, error })
      }
      this.emit('error', { serverId, error })
    }
  }

  /**
   * 获取工具列表
   */
  private async fetchTools(client: Client, config: McpServerConfig): Promise<McpTool[]> {
    try {
      const result = await client.listTools()
      return (result.tools || []).map(tool => {
        const raw = tool as { title?: string; description?: string; name: string; inputSchema: unknown }
        return {
          serverId: config.id,
          serverName: config.name,
          name: raw.name,
          title: typeof raw.title === 'string' ? raw.title : undefined,
          description: raw.description || '',
          inputSchema: raw.inputSchema as McpTool['inputSchema']
        }
      })
    } catch (error) {
      log.error(`Failed to fetch tools from ${config.name}:`, error)
      return []
    }
  }

  /**
   * 获取资源列表
   */
  private async fetchResources(client: Client, config: McpServerConfig): Promise<McpResource[]> {
    try {
      const result = await client.listResources()
      return (result.resources || []).map(resource => ({
        serverId: config.id,
        serverName: config.name,
        uri: resource.uri,
        name: resource.name,
        description: resource.description,
        mimeType: resource.mimeType
      }))
    } catch (error: unknown) {
      // MCP error -32601 表示服务器不支持此方法，静默处理
      if (error && typeof error === 'object' && 'code' in error && error.code === -32601) {
        log.info(`${config.name} 不支持 resources/list 方法`)
      } else {
        log.warn(`从 ${config.name} 获取资源列表失败:`, error instanceof Error ? error.message : error)
      }
      return []
    }
  }

  /**
   * 获取提示模板列表
   */
  private async fetchPrompts(client: Client, config: McpServerConfig): Promise<McpPrompt[]> {
    try {
      const result = await client.listPrompts()
      return (result.prompts || []).map(prompt => ({
        serverId: config.id,
        serverName: config.name,
        name: prompt.name,
        description: prompt.description,
        arguments: prompt.arguments
      }))
    } catch (error: unknown) {
      // MCP error -32601 表示服务器不支持此方法，静默处理
      if (error && typeof error === 'object' && 'code' in error && error.code === -32601) {
        log.info(`${config.name} 不支持 prompts/list 方法`)
      } else {
        log.warn(`从 ${config.name} 获取提示模板失败:`, error instanceof Error ? error.message : error)
      }
      return []
    }
  }

  /**
   * 已连接 + 最近连接失败的健康状态（失败项 connected=false 且带 error）。
   */
  getServerStatuses(): McpServerStatus[] {
    const live = Array.from(this.connections.values()).map(conn => ({
      id: conn.config.id,
      name: conn.config.name,
      connected: true,
      toolCount: conn.tools.length,
      resourceCount: conn.resources.length,
      promptCount: conn.prompts.length
    }))
    const failed: McpServerStatus[] = []
    for (const [id, rec] of this.lastErrors) {
      if (this.connections.has(id)) continue
      failed.push({
        id,
        name: rec.name,
        connected: false,
        error: rec.error,
        errorKind: rec.errorKind,
        toolCount: 0,
        resourceCount: 0,
        promptCount: 0
      })
    }
    return [...live, ...failed]
  }

  /**
   * 获取所有可用工具（聚合所有服务器）
   */
  getAllTools(): McpTool[] {
    const tools: McpTool[] = []
    for (const connection of this.connections.values()) {
      tools.push(...connection.tools)
    }
    return tools
  }

  /** 已连接 MCP 工具总数 */
  getConnectedToolCount(): number {
    return this.getAllTools().length
  }

  /** 有已连接 MCP → 渐进披露（不把全量 schema 注入上下文；经 skill load mcp:…） */
  shouldDeferTools(): boolean {
    return this.connections.size > 0
  }

  /**
   * server 目录（defer 时注入 system prompt / skill 纠错）。
   * 优先 whenToUse；否则 name + 工具名清单（title 优先）。行首 skill_id = mcp:<id>。
   */
  getServerCatalogText(): string {
    const connections = Array.from(this.connections.values())
    if (connections.length === 0) return '（当前无已连接 MCP 连接器）'
    return connections
      .map(conn => {
        const { id, name, whenToUse } = conn.config
        const skillId = toMcpSkillId(id)
        const when = typeof whenToUse === 'string' ? whenToUse.trim() : ''
        if (when) {
          return `- ${skillId}（${name}）：${when}`
        }
        const toolNames = conn.tools.map(t => t.title || t.name)
        if (toolNames.length === 0) {
          return `- ${skillId}（${name}）：（无工具）`
        }
        return `- ${skillId}（${name}）：${toolNames.join('、')}`
      })
      .join('\n')
  }

  /**
   * 用 id、`mcp:id` 或显示名解析已连接 server（精确匹配 id / name，忽略大小写）。
   */
  resolveServerRef(ref: string): { serverId: string; name: string; toolCount: number } | null {
    let key = ref.trim()
    if (!key) return null
    const fromSkill = parseMcpSkillId(key)
    if (fromSkill) key = fromSkill
    const statuses = this.getServerStatuses().filter(s => s.connected)
    const byId = statuses.find(s => s.id === key)
    if (byId) {
      return { serverId: byId.id, name: byId.name, toolCount: byId.toolCount }
    }
    const lower = key.toLowerCase()
    const byName = statuses.find(s => s.name.toLowerCase() === lower)
    if (byName) {
      return { serverId: byName.id, name: byName.name, toolCount: byName.toolCount }
    }
    return null
  }

  /**
   * 从已保存的配置里解析连接器（不要求已连接）。
   * 匹配规则与 resolveServerRef 相同：id、`mcp:id`、显示名（忽略大小写）。
   */
  findConfiguredServer(ref: string, configs: McpServerConfig[]): McpServerConfig | null {
    let key = ref.trim()
    if (!key) return null
    const fromSkill = parseMcpSkillId(key)
    if (fromSkill) key = fromSkill
    const byId = configs.find(s => s.id === key)
    if (byId) return byId
    const lower = key.toLowerCase()
    return configs.find(s => s.name.toLowerCase() === lower) ?? null
  }

  /**
   * 已连接则直接返回；否则按配置连接。
   * 同一 id 的并发 ensureConnected 共用一次 connect，避免 stdio 双开再互杀。
   */
  async ensureConnected(config: McpServerConfig): Promise<void> {
    if (this.isConnected(config.id)) return
    let inflight = this.connecting.get(config.id)
    if (!inflight) {
      inflight = this.connect(config).finally(() => {
        this.connecting.delete(config.id)
      })
      this.connecting.set(config.id, inflight)
    }
    await inflight
  }

  /** 公开：生成 LLM 可见的完整工具名 */
  getFullToolName(tool: Pick<McpTool, 'serverId' | 'name'>): string {
    return this.generateToolName(tool.serverId, tool.name)
  }

  /**
   * 重建全量名称映射。defer 模式下未注入上下文的工具仍须可 parse/call。
   */
  rebuildToolNameMap(): void {
    this.toolNameMap.clear()
    for (const tool of this.getAllTools()) {
      const generatedName = this.getFullToolName(tool)
      this.toolNameMap.set(generatedName, {
        serverId: tool.serverId,
        toolName: tool.name
      })
    }
  }

  private toolToDefinition(tool: McpTool): ToolDefinitionWithMeta {
    const generatedName = this.getFullToolName(tool)
    const displayLabel = resolveMcpToolDisplayLabel(tool)

    return {
      type: 'function' as const,
      function: {
        name: generatedName,
        description: `[MCP: ${tool.serverName}] ${tool.description}`,
        parameters: {
          type: 'object' as const,
          properties: Object.fromEntries(
            Object.entries(tool.inputSchema.properties || {}).map(([key, value]) => [
              key,
              {
                type: (value as { type?: string }).type || 'string',
                description: (value as { description?: string }).description || ''
              }
            ])
          ),
          required: tool.inputSchema.required
        }
      },
      _meta: {
        streamDisplay: {
          customRender: () => formatMcpToolCallContent(displayLabel)
        }
      }
    }
  }

  /**
   * 获取所有可用资源（聚合所有服务器）
   */
  getAllResources(): McpResource[] {
    const resources: McpResource[] = []
    for (const connection of this.connections.values()) {
      resources.push(...connection.resources)
    }
    return resources
  }

  /**
   * 获取所有可用提示模板（聚合所有服务器）
   */
  getAllPrompts(): McpPrompt[] {
    const prompts: McpPrompt[] = []
    for (const connection of this.connections.values()) {
      prompts.push(...connection.prompts)
    }
    return prompts
  }

  /**
   * 生成符合长度限制的工具名称（OpenAI 限制 64 字符）
   * 工具名称只能包含字母、数字、下划线和连字符
   */
  private generateToolName(serverId: string, toolName: string): string {
    const MAX_LENGTH = 64
    const prefix = 'mcp_'
    const separator = '_'
    
    // 清理 serverId 和 toolName，只保留合法字符（字母、数字、下划线、连字符）
    const cleanServerId = serverId.replace(/[^a-zA-Z0-9_-]/g, '').substring(0, 12)
    const cleanToolName = toolName.replace(/[^a-zA-Z0-9_-]/g, '')
    
    // 计算可用长度
    const availableForToolName = MAX_LENGTH - prefix.length - cleanServerId.length - separator.length
    const truncatedToolName = cleanToolName.substring(0, availableForToolName)
    
    const result = `${prefix}${cleanServerId}${separator}${truncatedToolName}`
    
    // 最终安全检查
    if (result.length > MAX_LENGTH) {
      log.warn(`工具名称截断: ${result.length} -> ${MAX_LENGTH}`)
      return result.substring(0, MAX_LENGTH)
    }
    
    return result
  }

  /**
   * 将 MCP 工具转换为 AI 工具定义格式（全量）
   */
  getToolDefinitions(): ToolDefinition[] {
    this.rebuildToolNameMap()
    return this.getAllTools().map(tool => this.toolToDefinition(tool))
  }

  /**
   * 按已 load 的 serverId 列表取该服全部工具 schema（defer sticky）。
   */
  getToolDefinitionsByServerIds(serverIds: string[]): ToolDefinition[] {
    this.rebuildToolNameMap()
    if (serverIds.length === 0) return []
    const wanted = new Set(serverIds)
    const result: ToolDefinition[] = []
    for (const tool of this.getAllTools()) {
      if (wanted.has(tool.serverId)) {
        result.push(this.toolToDefinition(tool))
      }
    }
    return result
  }

  /**
   * 按完整工具名取 schema。
   */
  getToolDefinitionsByNames(names: string[]): ToolDefinition[] {
    this.rebuildToolNameMap()
    if (names.length === 0) return []

    const byName = new Map<string, McpTool>()
    for (const tool of this.getAllTools()) {
      byName.set(this.getFullToolName(tool), tool)
    }

    const result: ToolDefinition[] = []
    for (const name of new Set(names)) {
      const tool = byName.get(name)
      if (tool) result.push(this.toolToDefinition(tool))
    }
    return result
  }

  /**
   * 调用 MCP 工具
   */
  async callTool(serverId: string, toolName: string, args: Record<string, unknown>): Promise<{
    success: boolean
    content?: string
    error?: string
  }> {
    const connection = this.connections.get(serverId)
    if (!connection) {
      return { success: false, error: `服务器 ${serverId} 未连接` }
    }

    try {
      log.info(`Calling tool ${toolName} on ${connection.config.name}`)
      const result = await connection.client.callTool({
        name: toolName,
        arguments: args
      })

      // 提取文本内容
      let content = ''
      const blocks = Array.isArray(result.content) ? result.content : []
      for (const item of blocks) {
        if (item && typeof item === 'object' && 'type' in item && item.type === 'text' && 'text' in item && typeof item.text === 'string') {
          content += item.text
        }
      }

      return { success: true, content }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : '工具调用失败'
      log.error(`Tool call failed:`, error)
      return { success: false, error: errorMsg }
    }
  }

  /**
   * 读取 MCP 资源
   */
  async readResource(serverId: string, uri: string): Promise<{
    success: boolean
    content?: string
    mimeType?: string
    error?: string
  }> {
    const connection = this.connections.get(serverId)
    if (!connection) {
      return { success: false, error: `服务器 ${serverId} 未连接` }
    }

    try {
      log.info(`Reading resource ${uri} from ${connection.config.name}`)
      const result = await connection.client.readResource({ uri })

      // 提取内容
      let content = ''
      let mimeType: string | undefined
      if (result.contents && result.contents.length > 0) {
        const firstContent = result.contents[0]
        if ('text' in firstContent) {
          content = firstContent.text
        } else if ('blob' in firstContent) {
          content = firstContent.blob
        }
        mimeType = firstContent.mimeType
      }

      return { success: true, content, mimeType }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : '资源读取失败'
      log.error(`Resource read failed:`, error)
      return { success: false, error: errorMsg }
    }
  }

  /**
   * 获取 MCP 提示模板
   */
  async getPrompt(serverId: string, promptName: string, args?: Record<string, string>): Promise<{
    success: boolean
    messages?: Array<{ role: string; content: string }>
    error?: string
  }> {
    const connection = this.connections.get(serverId)
    if (!connection) {
      return { success: false, error: `服务器 ${serverId} 未连接` }
    }

    try {
      log.info(`Getting prompt ${promptName} from ${connection.config.name}`)
      const result = await connection.client.getPrompt({
        name: promptName,
        arguments: args
      })

      const messages = result.messages?.map(msg => ({
        role: msg.role,
        content: typeof msg.content === 'string' 
          ? msg.content 
          : msg.content.type === 'text' 
            ? msg.content.text 
            : ''
      }))

      return { success: true, messages }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : '获取提示模板失败'
      log.error(`Get prompt failed:`, error)
      return { success: false, error: errorMsg }
    }
  }

  /**
   * 测试服务器连接（返回工具摘要供 whenToUse 草稿生成）
   */
  async testConnection(config: McpServerConfig): Promise<{
    success: boolean
    toolCount?: number
    resourceCount?: number
    promptCount?: number
    tools?: Array<{ name: string; title?: string; description: string }>
    error?: string
    errorKind?: McpConnectErrorKind
  }> {
    try {
      await this.connect(config)
      const connection = this.connections.get(config.id)
      
      if (connection) {
        const tools = connection.tools.map(t => ({
          name: t.name,
          title: t.title,
          description: (t.description || '').slice(0, 120)
        }))
        const result = {
          success: true as const,
          toolCount: connection.tools.length,
          resourceCount: connection.resources.length,
          promptCount: connection.prompts.length,
          tools
        }
        
        // 测试完成后断开
        await this.disconnect(config.id)
        
        return result
      }
      
      return { success: false, error: '连接建立但无法获取信息' }
    } catch (error) {
      const classified = classifyMcpConnectError(error)
      return {
        success: false,
        error: classified.message,
        errorKind: classified.kind
      }
    }
  }

  /** 已连接时同步配置字段（如 whenToUse），供目录即时生效 */
  patchConnectedConfig(config: McpServerConfig): void {
    const connection = this.connections.get(config.id)
    if (!connection) return
    connection.config = { ...connection.config, ...config }
  }

  /**
   * 刷新服务器的工具/资源/提示列表
   */
  async refreshServer(serverId: string): Promise<void> {
    const connection = this.connections.get(serverId)
    if (!connection) {
      throw new Error(`服务器 ${serverId} 未连接`)
    }

    connection.tools = await this.fetchTools(connection.client, connection.config)
    connection.resources = await this.fetchResources(connection.client, connection.config)
    connection.prompts = await this.fetchPrompts(connection.client, connection.config)

    log.info(`Refreshed ${connection.config.name}: ${connection.tools.length} tools, ${connection.resources.length} resources, ${connection.prompts.length} prompts`)
    
    this.emit('refreshed', serverId)
  }

  /**
   * 检查服务器是否已连接
   */
  isConnected(serverId: string): boolean {
    return this.connections.has(serverId)
  }

  /**
   * 解析 MCP 工具的人类可读展示名（用于步骤卡片、确认框等）
   */
  getToolDisplayLabel(fullName: string): string | null {
    const parsed = this.parseToolCallName(fullName)
    if (!parsed) return null

    for (const connection of this.connections.values()) {
      const tool = connection.tools.find(
        t => t.serverId === parsed.serverId && t.name === parsed.toolName
      )
      if (tool) return resolveMcpToolDisplayLabel(tool)
    }
    return resolveMcpToolDisplayLabel({ name: parsed.toolName })
  }

  /**
   * 解析 MCP 工具调用名称
   * 优先从映射表查找，支持截断后的名称
   */
  parseToolCallName(fullName: string): { serverId: string; toolName: string } | null {
    if (!fullName.startsWith('mcp_')) {
      return null
    }

    // 优先从映射表查找（支持截断后的名称）
    const mapped = this.toolNameMap.get(fullName)
    if (mapped) {
      return mapped
    }

    // 回退到原有的解析逻辑（兼容未截断的情况）
    const parts = fullName.substring(4).split('_')
    if (parts.length < 2) {
      return null
    }

    const serverId = parts[0]
    const toolName = parts.slice(1).join('_')

    return { serverId, toolName }
  }
}
