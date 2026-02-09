/**
 * MCP (Model Context Protocol) 客户端服务
 * 管理与外部 MCP 服务器的连接，聚合工具、资源和提示模板
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { ToolDefinition } from './ai.service'
import { ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import { app } from 'electron'

// MCP 服务器配置
export interface McpServerConfig {
  id: string
  name: string
  enabled: boolean
  transport: 'stdio' | 'sse'
  // stdio 模式
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  // sse 模式
  url?: string
  headers?: Record<string, string>
}

// MCP 工具信息
export interface McpTool {
  serverId: string
  serverName: string
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
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

    console.log(`[MCP] Connecting to server: ${config.name} (${config.id})`)

    try {
      let transport: Transport
      let childProcess: ChildProcess | undefined

      if (config.transport === 'stdio') {
        if (!config.command) {
          throw new Error('stdio 模式需要指定 command')
        }

        // 合并环境变量
        const mergedEnv = { ...process.env, ...config.env }
        
        console.log(`[MCP] Starting ${config.name} with command: ${config.command}`)
        console.log(`[MCP] Args: ${JSON.stringify(config.args)}`)
        console.log(`[MCP] Custom env keys: ${Object.keys(config.env || {}).join(', ') || 'none'}`)

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

        transport = new SSEClientTransport(new URL(config.url))
      } else {
        throw new Error(`不支持的传输类型: ${config.transport}`)
      }

      // 创建 MCP 客户端
      const client = new Client({
        name: app.getName(),
        version: app.getVersion()
      }, {
        capabilities: {
          tools: {},
          resources: {},
          prompts: {}
        }
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
        process: childProcess,
        tools,
        resources,
        prompts
      }
      this.connections.set(config.id, connection)

      console.log(`[MCP] Connected to ${config.name}: ${tools.length} tools, ${resources.length} resources, ${prompts.length} prompts`)
      
      this.emit('connected', config.id)
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : '连接失败'
      console.error(`[MCP] Failed to connect to ${config.name}:`, error)
      throw new Error(`连接 MCP 服务器 ${config.name} 失败: ${errorMsg}`)
    }
  }

  /**
   * 断开 MCP 服务器连接
   */
  async disconnect(serverId: string): Promise<void> {
    const connection = this.connections.get(serverId)
    if (!connection) return

    console.log(`[MCP] Disconnecting from server: ${connection.config.name}`)

    try {
      await connection.client.close()
    } catch (error) {
      console.error(`[MCP] Error closing client:`, error)
    }

    // 终止子进程
    if (connection.process) {
      connection.process.kill()
    }

    this.connections.delete(serverId)
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
      this.emit('error', { serverId, error })
    }
  }

  /**
   * 获取工具列表
   */
  private async fetchTools(client: Client, config: McpServerConfig): Promise<McpTool[]> {
    try {
      const result = await client.listTools()
      return (result.tools || []).map(tool => ({
        serverId: config.id,
        serverName: config.name,
        name: tool.name,
        description: tool.description || '',
        inputSchema: tool.inputSchema as McpTool['inputSchema']
      }))
    } catch (error) {
      console.error(`[MCP] Failed to fetch tools from ${config.name}:`, error)
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
        console.log(`[MCP] ${config.name} 不支持 resources/list 方法`)
      } else {
        console.warn(`[MCP] 从 ${config.name} 获取资源列表失败:`, error instanceof Error ? error.message : error)
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
        console.log(`[MCP] ${config.name} 不支持 prompts/list 方法`)
      } else {
        console.warn(`[MCP] 从 ${config.name} 获取提示模板失败:`, error instanceof Error ? error.message : error)
      }
      return []
    }
  }

  /**
   * 获取所有已连接服务器的状态
   */
  getServerStatuses(): McpServerStatus[] {
    return Array.from(this.connections.values()).map(conn => ({
      id: conn.config.id,
      name: conn.config.name,
      connected: true,
      toolCount: conn.tools.length,
      resourceCount: conn.resources.length,
      promptCount: conn.prompts.length
    }))
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
      console.warn(`[MCP] 工具名称截断: ${result.length} -> ${MAX_LENGTH}`)
      return result.substring(0, MAX_LENGTH)
    }
    
    return result
  }

  /**
   * 将 MCP 工具转换为 AI 工具定义格式
   */
  getToolDefinitions(): ToolDefinition[] {
    // 清空并重建映射表
    this.toolNameMap.clear()
    
    return this.getAllTools().map(tool => {
      const generatedName = this.generateToolName(tool.serverId, tool.name)
      
      // 保存映射关系，以便后续解析
      this.toolNameMap.set(generatedName, {
        serverId: tool.serverId,
        toolName: tool.name
      })
      
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
        }
      }
    })
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
      console.log(`[MCP] Calling tool ${toolName} on ${connection.config.name}`)
      const result = await connection.client.callTool({
        name: toolName,
        arguments: args
      })

      // 提取文本内容
      let content = ''
      if (result.content) {
        for (const item of result.content) {
          if (item.type === 'text') {
            content += item.text
          }
        }
      }

      return { success: true, content }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : '工具调用失败'
      console.error(`[MCP] Tool call failed:`, error)
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
      console.log(`[MCP] Reading resource ${uri} from ${connection.config.name}`)
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
      console.error(`[MCP] Resource read failed:`, error)
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
      console.log(`[MCP] Getting prompt ${promptName} from ${connection.config.name}`)
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
      console.error(`[MCP] Get prompt failed:`, error)
      return { success: false, error: errorMsg }
    }
  }

  /**
   * 测试服务器连接
   */
  async testConnection(config: McpServerConfig): Promise<{
    success: boolean
    toolCount?: number
    resourceCount?: number
    promptCount?: number
    error?: string
  }> {
    try {
      await this.connect(config)
      const connection = this.connections.get(config.id)
      
      if (connection) {
        const result = {
          success: true,
          toolCount: connection.tools.length,
          resourceCount: connection.resources.length,
          promptCount: connection.prompts.length
        }
        
        // 测试完成后断开
        await this.disconnect(config.id)
        
        return result
      }
      
      return { success: false, error: '连接建立但无法获取信息' }
    } catch (error) {
      return { 
        success: false, 
        error: error instanceof Error ? error.message : '测试连接失败'
      }
    }
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

    console.log(`[MCP] Refreshed ${connection.config.name}: ${connection.tools.length} tools, ${connection.resources.length} resources, ${connection.prompts.length} prompts`)
    
    this.emit('refreshed', serverId)
  }

  /**
   * 检查服务器是否已连接
   */
  isConnected(serverId: string): boolean {
    return this.connections.has(serverId)
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
