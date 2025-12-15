/**
 * 知识库类型定义
 */

// ==================== Embedding 模型相关 ====================

/** 模型级别 */
export type ModelTier = 'lite' | 'standard' | 'large'

/** 模型信息 */
export interface ModelInfo {
  id: ModelTier
  name: string
  huggingfaceId: string
  size: number           // 字节
  dimensions: number
  maxTokens: number      // 模型支持的最大 token 数
  bundled: boolean       // 是否随软件打包
  downloadUrl?: string
  sha256?: string
}

/** 模型状态 */
export interface ModelStatus {
  id: ModelTier
  available: boolean
  downloading: boolean
  progress?: number      // 下载进度 0-100
  error?: string
}

/** 下载进度回调 */
export type DownloadProgressCallback = (
  percent: number, 
  downloaded: number, 
  total: number
) => void

// ==================== 文档和分块相关 ====================

/** 知识库文档 */
export interface KnowledgeDocument {
  id: string
  filename: string
  content: string
  fileSize: number
  fileType: string
  contentHash?: string   // 内容哈希，用于去重
  hostId?: string        // 关联的主机
  tags: string[]
  createdAt: number
  updatedAt: number
  chunkCount: number     // 分块数量
}

/** 文档分块 */
export interface DocumentChunk {
  id: string
  docId: string
  content: string
  embedding?: number[]
  chunkIndex: number
  totalChunks: number
  metadata: ChunkMetadata
}

/** 分块元数据 */
export interface ChunkMetadata {
  filename: string
  hostId?: string
  tags: string[]
  startOffset: number
  endOffset: number
}

/** 分块策略 */
export type ChunkStrategy = 'fixed' | 'semantic' | 'paragraph'

/** 分块选项 */
export interface ChunkOptions {
  maxChunkSize: number      // 默认 512 tokens
  overlapSize: number       // 默认 50 tokens
  strategy: ChunkStrategy
}

// ==================== 搜索相关 ====================

/** 搜索选项 */
export interface SearchOptions {
  query: string
  limit?: number           // 默认 10
  hostId?: string          // 按主机过滤
  tags?: string[]          // 按标签过滤
  similarity?: number      // 相似度阈值，默认 0.7
  enableRerank?: boolean   // 是否启用重排序
  hybridWeight?: number    // 向量搜索权重 0-1，默认 0.7
}

/** 搜索结果 */
export interface SearchResult {
  id: string
  docId: string
  content: string
  score: number
  metadata: ChunkMetadata
  source: 'local' | 'mcp'  // 结果来源
}

// ==================== 添加文档选项 ====================

/** 添加文档选项 */
export interface AddDocumentOptions {
  hostId?: string
  tags?: string[]
  chunkOptions?: Partial<ChunkOptions>
}

// ==================== 配置相关 ====================

/** 知识库设置 */
export interface KnowledgeSettings {
  enabled: boolean
  // Embedding 配置
  embeddingMode: 'local' | 'mcp'
  localModel: 'auto' | ModelTier
  embeddingMcpServerId?: string
  // 搜索配置
  autoSaveUploads: boolean
  chunkStrategy: ChunkStrategy
  searchTopK: number
  enableRerank: boolean
  // MCP 知识库
  mcpKnowledgeServerId?: string
}

/** 默认配置 */
export const DEFAULT_KNOWLEDGE_SETTINGS: KnowledgeSettings = {
  enabled: false,
  embeddingMode: 'local',
  localModel: 'auto',
  autoSaveUploads: true,
  chunkStrategy: 'paragraph',
  searchTopK: 10,
  enableRerank: true
}

// ==================== 知识库统计 ====================

/** 知识库统计信息 */
export interface KnowledgeStats {
  documentCount: number
  chunkCount: number
  totalSize: number        // 总大小（字节）
  lastUpdated?: number
}

// VectorRecord 类型定义在 storage.ts 中

