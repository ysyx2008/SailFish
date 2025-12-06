/**
 * 重排序服务
 * 使用 LLM 对搜索结果进行重新排序，提高相关性
 */
import type { AiService } from '../ai.service'
import type { SearchResult } from './types'

export class Reranker {
  private aiService: AiService

  constructor(aiService: AiService) {
    this.aiService = aiService
  }

  /**
   * 对搜索结果进行重排序
   * @param query 用户查询
   * @param candidates 候选结果
   * @param topK 返回前 K 个结果
   */
  async rerank(
    query: string, 
    candidates: SearchResult[], 
    topK: number = 5
  ): Promise<SearchResult[]> {
    if (candidates.length === 0) {
      return []
    }

    if (candidates.length <= topK) {
      // 候选数量不足，直接返回
      return candidates
    }

    try {
      // 构建提示词
      const prompt = this.buildRerankPrompt(query, candidates, topK)
      
      // 调用 AI 进行排序
      const response = await this.aiService.chat([
        { role: 'user', content: prompt }
      ])

      // 解析排序结果
      const orderedIndices = this.parseRerankResponse(response, candidates.length)
      
      // 按排序重新组织结果
      const reranked = orderedIndices
        .slice(0, topK)
        .map(index => candidates[index])
        .filter(Boolean)

      // 如果解析失败或结果不足，用原始结果补充
      if (reranked.length < topK) {
        const existing = new Set(reranked.map(r => r.id))
        for (const candidate of candidates) {
          if (!existing.has(candidate.id)) {
            reranked.push(candidate)
            if (reranked.length >= topK) break
          }
        }
      }

      return reranked
    } catch (error) {
      console.error('[Reranker] Failed to rerank:', error)
      // 重排序失败时返回原始结果
      return candidates.slice(0, topK)
    }
  }

  /**
   * 构建重排序提示词
   */
  private buildRerankPrompt(
    query: string, 
    candidates: SearchResult[], 
    topK: number
  ): string {
    const candidateList = candidates
      .map((c, i) => {
        // 截断过长的内容
        const content = c.content.length > 300 
          ? c.content.slice(0, 300) + '...' 
          : c.content
        return `[${i}] ${content}`
      })
      .join('\n\n')

    return `请根据用户问题，对以下文档片段按相关性排序。

用户问题: ${query}

文档片段:
${candidateList}

请按相关性从高到低排序，返回最相关的 ${topK} 个文档的序号。
只需返回序号，用逗号分隔，例如: 2,5,1,3,7
不要包含任何其他内容。`
  }

  /**
   * 解析重排序响应
   */
  private parseRerankResponse(response: string, maxIndex: number): number[] {
    try {
      // 提取数字
      const numbers = response.match(/\d+/g)
      
      if (!numbers) {
        return []
      }

      // 转换为数字并过滤有效索引
      const indices = numbers
        .map(n => parseInt(n, 10))
        .filter(n => !isNaN(n) && n >= 0 && n < maxIndex)

      // 去重
      const unique = [...new Set(indices)]
      
      return unique
    } catch {
      return []
    }
  }

  /**
   * 批量重排序（分组处理大量结果）
   */
  async rerankBatch(
    query: string, 
    candidates: SearchResult[], 
    topK: number = 5,
    batchSize: number = 20
  ): Promise<SearchResult[]> {
    if (candidates.length <= batchSize) {
      return this.rerank(query, candidates, topK)
    }

    // 分批处理
    const batches: SearchResult[][] = []
    for (let i = 0; i < candidates.length; i += batchSize) {
      batches.push(candidates.slice(i, i + batchSize))
    }

    // 对每批进行重排序，取每批前几个
    const batchTopK = Math.ceil(topK * 1.5 / batches.length) + 1
    const batchResults: SearchResult[] = []

    for (const batch of batches) {
      const reranked = await this.rerank(query, batch, batchTopK)
      batchResults.push(...reranked)
    }

    // 对所有批次的结果进行最终排序
    if (batchResults.length > topK) {
      return this.rerank(query, batchResults, topK)
    }

    return batchResults.slice(0, topK)
  }
}

// 导出工厂函数
export function createReranker(aiService: AiService): Reranker {
  return new Reranker(aiService)
}

