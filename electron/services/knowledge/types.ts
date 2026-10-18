/**
 * 知识库类型定义
 */

// ==================== Embedding 模型相关 ====================

/** 模型级别 */
export type ModelTier = 'lite' | 'standard' | 'large'

/** 嵌入推理设备（Transformers.js v4） */
export type EmbeddingDevice =
  | 'auto'
  | 'cpu'
  | 'gpu'
  | 'coreml'
  | 'cuda'
  | 'dml'
  | 'webgpu'

/** 模型信息 */
export interface ModelInfo {
  id: ModelTier
  name: string
  huggingfaceId: string
  /** 本地目录名；与 huggingfaceId 末段不同时指定（兼容旧版打包路径） */
  localDirName?: string
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

/** 记忆易变性等级 */
export type MemoryVolatility = 'stable' | 'moderate' | 'volatile'

/** 谁把这份资料放进知识库的。和观察来源 `source` 不是一回事。 */
export type LibraryAddedBy = 'user' | 'agent'

/** 检索说明的状态。pending 的集合就是待写队列。 */
export type CardStatus = 'pending' | 'generating' | 'ready' | 'failed' | 'stale'

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
  // 观察日志模型（Observation Ledger）字段
  volatility?: MemoryVolatility  // 易变性：stable(几乎不变) / moderate(偶尔变) / volatile(经常变)
  source?: string                // 观察来源（如 "nginx -T 输出"、"用户告知"）
  /** 档案目录，空字符串表示根。主机记忆和过往对话没有这个位置 */
  folder?: string
  addedBy?: LibraryAddedBy
  cardStatus?: CardStatus
  cardSummary?: string
  /** 写说明时原文的内容哈希。和现在的哈希不同，说明就和原文脱节了 */
  cardSourceHash?: string
  cardHumanEdited?: boolean
  /** 被翻到过、但说明还没好。队列优先写这些 */
  cardTouchedAt?: number
  cardError?: string
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
  /** 放进哪个目录。空或不传表示根 */
  folder?: string
  addedBy?: LibraryAddedBy
}

// ==================== 配置相关 ====================

/** 知识库设置 */
export interface KnowledgeSettings {
  enabled: boolean
  // Embedding 配置
  embeddingMode: 'local' | 'mcp'
  localModel: 'auto' | ModelTier
  /** 本地嵌入推理设备，默认 auto（macOS→CoreML，Linux→CUDA，Windows→DirectML） */
  embeddingDevice?: EmbeddingDevice
  embeddingMcpServerId?: string
  // 搜索配置
  autoSaveUploads: boolean
  chunkStrategy: ChunkStrategy
  searchTopK: number
  enableRerank: boolean
  // 主机记忆
  enableHostMemory: boolean
  // MCP 知识库
  mcpKnowledgeServerId?: string
  /** 写检索说明用的模型。空着就不自动写 */
  cardProfileId?: string
  /** 没在对话里另行指定时，自动翻档案的目录。空着就是全库 */
  recallFolder?: string
}

/** 默认配置 */
export const DEFAULT_KNOWLEDGE_SETTINGS: KnowledgeSettings = {
  enabled: true,
  embeddingMode: 'local',
  localModel: 'auto',
  embeddingDevice: 'auto',
  autoSaveUploads: true,
  chunkStrategy: 'paragraph',
  searchTopK: 10,
  enableRerank: true,
  enableHostMemory: true
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

