/**
 * 观察日志模型（Observation Ledger）工具函数
 * 
 * 从 KnowledgeService 中提取的纯函数，便于单元测试。
 * 这些函数不依赖任何 Electron 或数据库模块。
 */

/** 记忆项的最小接口 */
export interface MemoryItem {
  docId: string
  content: string
  createdAt: number
  vector: number[] | null
}

/** 提取的观察条目 */
export interface ExtractedObservation {
  content: string
  volatility?: 'stable' | 'moderate' | 'volatile'
  source?: string
}

/** 余弦相似度函数类型 */
export type SimilarityFn = (a: number[], b: number[]) => number

/**
 * 计算两个向量的余弦相似度
 * 
 * 从 EmbeddingService.cosineSimilarity 提取的纯函数版本。
 * 返回值范围 [-1, 1]，1 表示完全相同，0 表示正交，-1 表示完全相反。
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error('向量维度不匹配')
  }

  let dotProduct = 0
  let normA = 0
  let normB = 0

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }

  normA = Math.sqrt(normA)
  normB = Math.sqrt(normB)

  if (normA === 0 || normB === 0) {
    return 0
  }

  return dotProduct / (normA * normB)
}

/**
 * 读时去重：通过 embedding 聚类去除语义重复的记忆
 * 
 * 算法：
 * 1. 按时间从新到旧排序
 * 2. 遍历每条记忆，与已有聚类中心计算余弦相似度
 *    - 如果 >= 阈值，归入已有聚类（跳过，因为更新的记忆已经是聚类代表）
 *    - 如果 < 阈值，开辟新聚类
 * 3. 每个聚类只保留最新的一条
 * 4. 无向量的记忆独立保留（无法参与聚类）
 * 
 * @param items 待去重的记忆列表
 * @param similarityThreshold 相似度阈值（默认 0.80）
 * @param similarityFn 相似度计算函数（默认余弦相似度，可注入用于测试）
 * @returns 去重后的记忆列表
 */
export function deduplicateByEmbeddingCluster(
  items: MemoryItem[],
  similarityThreshold: number = 0.80,
  similarityFn: SimilarityFn = cosineSimilarity
): MemoryItem[] {
  if (items.length === 0) return []

  // 按时间从新到旧排序
  const sorted = [...items].sort((a, b) => b.createdAt - a.createdAt)

  // 分离有向量和无向量的记忆
  const withVector: MemoryItem[] = []
  const withoutVector: MemoryItem[] = []
  for (const item of sorted) {
    if (item.vector && item.vector.length > 0) {
      withVector.push(item)
    } else {
      withoutVector.push(item)
    }
  }

  // 聚类中心列表（每个中心代表一个独立主题，取最新的那条）
  const clusters: Array<{
    representative: MemoryItem
    vector: number[]
  }> = []

  for (const item of withVector) {
    let bestSimilarity = 0

    for (const cluster of clusters) {
      const similarity = similarityFn(item.vector!, cluster.vector)
      if (similarity > bestSimilarity) {
        bestSimilarity = similarity
      }
    }

    if (bestSimilarity >= similarityThreshold) {
      // 跳过：这条旧记忆被更新的同主题记忆覆盖了
      continue
    }

    // 开辟新聚类
    clusters.push({ representative: item, vector: item.vector! })
  }

  // 合并：聚类后的代表 + 无向量的独立记忆
  return [...clusters.map(c => c.representative), ...withoutVector]
}

/**
 * 从 LLM 返回的原始文本中解析并净化观察列表
 * 
 * 处理逻辑：
 * 1. 从文本中提取 JSON 数组
 * 2. 校验每条观察的结构和内容长度
 * 3. 净化 volatility 枚举值和 source 字段
 * 4. 限制最大数量
 * 
 * @param rawResponse LLM 返回的原始文本
 * @param maxObservations 最大观察数（默认 10）
 * @param maxContentLength 单条观察最大长度（默认 500）
 * @param maxSourceLength source 字段最大长度（默认 200）
 * @returns 净化后的观察列表
 */
export function parseObservationsFromLLMResponse(
  rawResponse: string,
  maxObservations: number = 10,
  maxContentLength: number = 500,
  maxSourceLength: number = 200
): ExtractedObservation[] {
  if (!rawResponse || typeof rawResponse !== 'string') return []

  const content = rawResponse.trim()
  const jsonMatch = content.match(/\[[\s\S]*\]/)
  if (!jsonMatch) return []

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonMatch[0])
  } catch {
    return []
  }

  if (!Array.isArray(parsed)) return []

  const VALID_VOLATILITIES = ['stable', 'moderate', 'volatile']

  return (parsed as Array<Record<string, unknown>>)
    .filter(o =>
      o.content
      && typeof o.content === 'string'
      && (o.content as string).length > 5
      && (o.content as string).length <= maxContentLength
    )
    .slice(0, maxObservations)
    .map(o => ({
      content: o.content as string,
      volatility: typeof o.volatility === 'string' && VALID_VOLATILITIES.includes(o.volatility)
        ? o.volatility as 'stable' | 'moderate' | 'volatile'
        : undefined,
      source: typeof o.source === 'string'
        ? o.source.replace(/[\n\r\t]/g, ' ').substring(0, maxSourceLength).trim()
        : undefined
    }))
}
