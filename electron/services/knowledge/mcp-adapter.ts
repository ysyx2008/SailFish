/**
 * MCP 知识库适配器
 * 复用现有 MCP 服务，提供知识库搜索和 embedding 功能
 */
import type { McpService } from '../mcp.service'
import type { SearchOptions, SearchResult } from './types'

// MCP 知识库工具名称（标准化）
const MCP_TOOLS = {
  SEARCH: 'knowledge_search',
  ADD: 'knowledge_add',
  EMBED: 'knowledge_embed',
  DELETE: 'knowledge_delete'
}

export class McpKnowledgeAdapter {
  private mcpService: McpService
  private serverId: string

  constructor(mcpService: McpService, serverId: string) {
    this.mcpService = mcpService
    this.serverId = serverId
  }

  /**
   * 检查 MCP 服务器是否提供知识库工具
   */
  hasKnowledgeTools(): boolean {
    const tools = this.mcpService.getAllTools()
    return tools.some(t => 
      t.serverId === this.serverId && 
      (t.name === MCP_TOOLS.SEARCH || t.name.includes('knowledge'))
    )
  }

  /**
   * 检查是否支持 embedding
   */
  hasEmbeddingTool(): boolean {
    const tools = this.mcpService.getAllTools()
    return tools.some(t => 
      t.serverId === this.serverId && 
      (t.name === MCP_TOOLS.EMBED || t.name.includes('embed'))
    )
  }

  /**
   * 获取支持的工具列表
   */
  getAvailableTools(): string[] {
    const tools = this.mcpService.getAllTools()
    return tools
      .filter(t => t.serverId === this.serverId)
      .map(t => t.name)
  }

  /**
   * 搜索知识库
   */
  async search(query: string, options?: Partial<SearchOptions>): Promise<SearchResult[]> {
    if (!this.mcpService.isConnected(this.serverId)) {
      throw new Error(`MCP 服务器 ${this.serverId} 未连接`)
    }

    const result = await this.mcpService.callTool(
      this.serverId,
      MCP_TOOLS.SEARCH,
      { 
        query, 
        limit: options?.limit || 10,
        filters: {
          hostId: options?.hostId,
          tags: options?.tags
        }
      }
    )

    if (!result.success) {
      throw new Error(result.error || '知识库搜索失败')
    }

    return this.parseSearchResult(result.content || '')
  }

  /**
   * 使用 MCP 服务生成 embedding
   */
  async embed(texts: string[]): Promise<number[][]> {
    if (!this.hasEmbeddingTool()) {
      throw new Error('MCP 服务器不支持 embedding')
    }

    const result = await this.mcpService.callTool(
      this.serverId,
      MCP_TOOLS.EMBED,
      { texts }
    )

    if (!result.success) {
      throw new Error(result.error || 'Embedding 生成失败')
    }

    return this.parseEmbeddingResult(result.content || '')
  }

  /**
   * 添加文档到 MCP 知识库
   */
  async addDocument(content: string, metadata?: Record<string, unknown>): Promise<string> {
    const result = await this.mcpService.callTool(
      this.serverId,
      MCP_TOOLS.ADD,
      { content, metadata }
    )

    if (!result.success) {
      throw new Error(result.error || '添加文档失败')
    }

    // 解析返回的文档 ID
    try {
      const parsed = JSON.parse(result.content || '{}')
      return parsed.id || parsed.docId || 'unknown'
    } catch {
      return 'unknown'
    }
  }

  /**
   * 从 MCP 知识库删除文档
   */
  async deleteDocument(docId: string): Promise<boolean> {
    const result = await this.mcpService.callTool(
      this.serverId,
      MCP_TOOLS.DELETE,
      { docId }
    )

    return result.success
  }

  /**
   * 解析搜索结果
   */
  private parseSearchResult(content: string): SearchResult[] {
    try {
      const parsed = JSON.parse(content)
      
      // 处理不同格式的返回值
      const results = Array.isArray(parsed) ? parsed : parsed.results || parsed.hits || []
      
      return results.map((item: any, index: number) => ({
        id: item.id || `mcp_${index}`,
        docId: item.docId || item.document_id || '',
        content: item.content || item.text || '',
        score: item.score || item.similarity || 1,
        metadata: {
          filename: item.filename || item.title || '',
          hostId: item.hostId || item.host_id || '',
          tags: item.tags || [],
          startOffset: 0,
          endOffset: (item.content || item.text || '').length
        },
        source: 'mcp' as const
      }))
    } catch (error) {
      console.error('[McpKnowledgeAdapter] Failed to parse search result:', error)
      return []
    }
  }

  /**
   * 解析 embedding 结果
   */
  private parseEmbeddingResult(content: string): number[][] {
    try {
      const parsed = JSON.parse(content)
      
      // 处理不同格式的返回值
      if (Array.isArray(parsed)) {
        if (Array.isArray(parsed[0])) {
          return parsed
        }
        // 单个 embedding
        return [parsed]
      }
      
      if (parsed.embeddings) {
        return parsed.embeddings
      }
      
      if (parsed.data) {
        return parsed.data.map((item: any) => item.embedding || item)
      }
      
      throw new Error('无法解析 embedding 结果')
    } catch (error) {
      console.error('[McpKnowledgeAdapter] Failed to parse embedding result:', error)
      throw error
    }
  }

  /**
   * 更新关联的 MCP 服务器
   */
  setServerId(serverId: string): void {
    this.serverId = serverId
  }

  /**
   * 获取当前服务器 ID
   */
  getServerId(): string {
    return this.serverId
  }

  /**
   * 检查连接状态
   */
  isConnected(): boolean {
    return this.mcpService.isConnected(this.serverId)
  }
}

