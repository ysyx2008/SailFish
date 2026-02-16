/**
 * memory-utils.ts 单元测试
 * 测试观察日志模型的核心纯函数：余弦相似度计算和 embedding 聚类去重
 */
import { describe, it, expect } from 'vitest'
import {
  cosineSimilarity,
  deduplicateByEmbeddingCluster,
  parseObservationsFromLLMResponse,
  type MemoryItem
} from '../memory-utils'

// ==================== 辅助函数 ====================

/** 创建一条测试用记忆项 */
function createMemory(
  id: string,
  createdAt: number,
  vector: number[] | null = null
): MemoryItem {
  return {
    docId: id,
    content: `Memory ${id}`,
    createdAt,
    vector
  }
}

/**
 * 生成一个归一化的随机向量
 * 通过设置主方向 + 微小扰动来控制相似度
 */
function makeVector(base: number[], noise: number = 0): number[] {
  const v = base.map(val => val + (Math.random() - 0.5) * noise)
  const norm = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0))
  return norm > 0 ? v.map(x => x / norm) : v
}

// ==================== cosineSimilarity 测试 ====================

describe('cosineSimilarity', () => {
  it('should return 1 for identical vectors', () => {
    const v = [1, 0, 0]
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5)
  })

  it('should return 0 for orthogonal vectors', () => {
    const a = [1, 0, 0]
    const b = [0, 1, 0]
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 5)
  })

  it('should return -1 for opposite vectors', () => {
    const a = [1, 0, 0]
    const b = [-1, 0, 0]
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1, 5)
  })

  it('should handle high-dimensional vectors', () => {
    const dim = 384  // 常见 embedding 维度
    const a = Array(dim).fill(0).map(() => Math.random())
    // 完全相同的向量
    const result = cosineSimilarity(a, a)
    expect(result).toBeCloseTo(1, 5)
  })

  it('should return 0 for zero vectors', () => {
    const a = [0, 0, 0]
    const b = [1, 2, 3]
    expect(cosineSimilarity(a, b)).toBe(0)
  })

  it('should throw for mismatched dimensions', () => {
    expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow('向量维度不匹配')
  })

  it('should be independent of vector magnitude', () => {
    const a = [1, 2, 3]
    const b = [2, 4, 6]  // 同方向，不同长度
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 5)
  })

  it('should handle negative values correctly', () => {
    const a = [1, -1, 0]
    const b = [1, 1, 0]
    // cos(90°) = 0 since a·b = 1*1 + (-1)*1 = 0
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 5)
  })
})

// ==================== deduplicateByEmbeddingCluster 测试 ====================

describe('deduplicateByEmbeddingCluster', () => {
  describe('edge cases', () => {
    it('should return empty array for empty input', () => {
      const result = deduplicateByEmbeddingCluster([])
      expect(result).toEqual([])
    })

    it('should return single item unchanged', () => {
      const item = createMemory('1', 1000, [1, 0, 0])
      const result = deduplicateByEmbeddingCluster([item])
      expect(result).toHaveLength(1)
      expect(result[0].docId).toBe('1')
    })

    it('should return single item without vector unchanged', () => {
      const item = createMemory('1', 1000, null)
      const result = deduplicateByEmbeddingCluster([item])
      expect(result).toHaveLength(1)
    })
  })

  describe('deduplication logic - latest wins', () => {
    it('should keep only the newest when two memories are identical', () => {
      const v = [1, 0, 0]
      const items: MemoryItem[] = [
        createMemory('old', 1000, v),
        createMemory('new', 2000, v)
      ]
      const result = deduplicateByEmbeddingCluster(items)
      expect(result).toHaveLength(1)
      expect(result[0].docId).toBe('new')  // 最新的赢
    })

    it('should keep only the newest among 3+ similar memories', () => {
      const v = [1, 0, 0]
      const items: MemoryItem[] = [
        createMemory('oldest', 1000, v),
        createMemory('middle', 2000, v),
        createMemory('newest', 3000, v)
      ]
      const result = deduplicateByEmbeddingCluster(items)
      expect(result).toHaveLength(1)
      expect(result[0].docId).toBe('newest')
    })

    it('should keep both when memories are dissimilar', () => {
      const items: MemoryItem[] = [
        createMemory('mysql', 1000, [1, 0, 0]),  // 完全不同方向
        createMemory('nginx', 2000, [0, 1, 0])
      ]
      const result = deduplicateByEmbeddingCluster(items)
      expect(result).toHaveLength(2)
    })

    it('should correctly deduplicate mixed similar/dissimilar memories', () => {
      // 场景：MySQL 端口有两条（旧+新），Nginx 端口有一条
      const mysqlVector = makeVector([1, 0, 0, 0])  // MySQL 主题
      const nginxVector = makeVector([0, 1, 0, 0])  // Nginx 主题（正交方向）
      
      const items: MemoryItem[] = [
        createMemory('mysql-old', 1000, mysqlVector),
        createMemory('mysql-new', 3000, mysqlVector),  // 同主题更新
        createMemory('nginx', 2000, nginxVector)        // 不同主题
      ]
      
      const result = deduplicateByEmbeddingCluster(items)
      expect(result).toHaveLength(2)
      
      const docIds = result.map(r => r.docId)
      expect(docIds).toContain('mysql-new')   // MySQL 保留最新
      expect(docIds).toContain('nginx')       // Nginx 独立保留
      expect(docIds).not.toContain('mysql-old')  // MySQL 旧的被去重
    })

    it('should handle multiple clusters correctly', () => {
      // 3 个独立主题，每个有 2 条（旧+新）
      const items: MemoryItem[] = [
        createMemory('a-old', 1000, makeVector([1, 0, 0])),
        createMemory('a-new', 4000, makeVector([1, 0, 0])),
        createMemory('b-old', 2000, makeVector([0, 1, 0])),
        createMemory('b-new', 5000, makeVector([0, 1, 0])),
        createMemory('c-old', 3000, makeVector([0, 0, 1])),
        createMemory('c-new', 6000, makeVector([0, 0, 1]))
      ]
      
      const result = deduplicateByEmbeddingCluster(items)
      expect(result).toHaveLength(3)
      
      const docIds = result.map(r => r.docId)
      expect(docIds).toContain('a-new')
      expect(docIds).toContain('b-new')
      expect(docIds).toContain('c-new')
    })
  })

  describe('vector-less memories', () => {
    it('should preserve all memories without vectors', () => {
      const items: MemoryItem[] = [
        createMemory('no-vec-1', 1000, null),
        createMemory('no-vec-2', 2000, null),
        createMemory('no-vec-3', 3000, null)
      ]
      const result = deduplicateByEmbeddingCluster(items)
      expect(result).toHaveLength(3)
    })

    it('should preserve empty-array vectors as vector-less', () => {
      const items: MemoryItem[] = [
        createMemory('empty-vec', 1000, []),
        createMemory('with-vec', 2000, [1, 0, 0])
      ]
      const result = deduplicateByEmbeddingCluster(items)
      expect(result).toHaveLength(2)
    })

    it('should mix clustered and vector-less memories correctly', () => {
      const v = [1, 0, 0]
      const items: MemoryItem[] = [
        createMemory('sim-old', 1000, v),
        createMemory('sim-new', 3000, v),
        createMemory('no-vec', 2000, null)
      ]
      const result = deduplicateByEmbeddingCluster(items)
      expect(result).toHaveLength(2)
      
      const docIds = result.map(r => r.docId)
      expect(docIds).toContain('sim-new')  // 聚类代表
      expect(docIds).toContain('no-vec')   // 无向量独立保留
    })
  })

  describe('threshold behavior', () => {
    it('should use custom threshold', () => {
      // 两个相似但不完全相同的向量
      const a = [1, 0, 0]
      const b = [0.95, 0.31, 0]  // cos similarity ≈ 0.95
      
      // 高阈值（0.99）：不应合并
      const resultHigh = deduplicateByEmbeddingCluster(
        [createMemory('1', 1000, a), createMemory('2', 2000, b)],
        0.99
      )
      expect(resultHigh).toHaveLength(2)
      
      // 低阈值（0.90）：应合并
      const resultLow = deduplicateByEmbeddingCluster(
        [createMemory('1', 1000, a), createMemory('2', 2000, b)],
        0.90
      )
      expect(resultLow).toHaveLength(1)
    })

    it('should accept custom similarity function', () => {
      // 使用始终返回 1 的相似度函数（所有记忆都"相同"）
      const alwaysSimilar = () => 1.0
      const items: MemoryItem[] = [
        createMemory('1', 1000, [1, 0]),
        createMemory('2', 2000, [0, 1]),
        createMemory('3', 3000, [1, 1])
      ]
      const result = deduplicateByEmbeddingCluster(items, 0.80, alwaysSimilar)
      expect(result).toHaveLength(1)
      expect(result[0].docId).toBe('3')  // 最新的
    })

    it('should accept custom similarity function that never matches', () => {
      const neverSimilar = () => 0.0
      const v = [1, 0, 0]
      const items: MemoryItem[] = [
        createMemory('1', 1000, v),
        createMemory('2', 2000, v),
        createMemory('3', 3000, v)
      ]
      const result = deduplicateByEmbeddingCluster(items, 0.80, neverSimilar)
      expect(result).toHaveLength(3)  // 全部保留
    })
  })

  describe('input immutability', () => {
    it('should not mutate original input array', () => {
      const items: MemoryItem[] = [
        createMemory('2', 2000, [1, 0, 0]),
        createMemory('1', 1000, [1, 0, 0])
      ]
      const originalLength = items.length
      const originalFirst = items[0].docId
      
      deduplicateByEmbeddingCluster(items)
      
      // 原始数组不应被修改
      expect(items).toHaveLength(originalLength)
      expect(items[0].docId).toBe(originalFirst)
    })
  })

  describe('time ordering', () => {
    it('should always prefer newer memories regardless of input order', () => {
      const v = [1, 0, 0]
      // 故意乱序输入
      const items: MemoryItem[] = [
        createMemory('middle', 2000, v),
        createMemory('newest', 3000, v),
        createMemory('oldest', 1000, v)
      ]
      const result = deduplicateByEmbeddingCluster(items)
      expect(result).toHaveLength(1)
      expect(result[0].docId).toBe('newest')
    })
  })
})

// ==================== parseObservationsFromLLMResponse 测试 ====================

describe('parseObservationsFromLLMResponse', () => {
  describe('valid JSON parsing', () => {
    it('should parse a clean JSON array', () => {
      const response = '[{"content": "MySQL 运行在端口 3306", "volatility": "moderate", "source": "mysql --version"}]'
      const result = parseObservationsFromLLMResponse(response)
      expect(result).toHaveLength(1)
      expect(result[0].content).toBe('MySQL 运行在端口 3306')
      expect(result[0].volatility).toBe('moderate')
      expect(result[0].source).toBe('mysql --version')
    })

    it('should parse JSON embedded in markdown code block', () => {
      const response = '```json\n[{"content": "Nginx 版本 1.24.0", "volatility": "moderate"}]\n```'
      const result = parseObservationsFromLLMResponse(response)
      expect(result).toHaveLength(1)
      expect(result[0].content).toBe('Nginx 版本 1.24.0')
    })

    it('should parse JSON with surrounding text', () => {
      const response = '以下是提取的观察：\n[{"content": "操作系统为 Ubuntu 22.04", "volatility": "stable"}]\n以上就是结果。'
      const result = parseObservationsFromLLMResponse(response)
      expect(result).toHaveLength(1)
      expect(result[0].volatility).toBe('stable')
    })

    it('should parse multiple observations', () => {
      const response = JSON.stringify([
        { content: 'MySQL 3306', volatility: 'moderate', source: 'ss -tlnp' },
        { content: 'Redis 6379', volatility: 'moderate', source: 'ss -tlnp' },
        { content: 'OS: Ubuntu 22.04', volatility: 'stable', source: 'cat /etc/os-release' }
      ])
      const result = parseObservationsFromLLMResponse(response)
      expect(result).toHaveLength(3)
    })
  })

  describe('invalid/edge case inputs', () => {
    it('should return empty array for empty string', () => {
      expect(parseObservationsFromLLMResponse('')).toEqual([])
    })

    it('should return empty array for null/undefined', () => {
      expect(parseObservationsFromLLMResponse(null as any)).toEqual([])
      expect(parseObservationsFromLLMResponse(undefined as any)).toEqual([])
    })

    it('should return empty array for non-JSON text', () => {
      expect(parseObservationsFromLLMResponse('没有可提取的信息')).toEqual([])
    })

    it('should return empty array for invalid JSON', () => {
      expect(parseObservationsFromLLMResponse('[{"content": invalid}]')).toEqual([])
    })

    it('should return empty array when JSON is an object instead of array', () => {
      expect(parseObservationsFromLLMResponse('{"content": "test"}')).toEqual([])
    })

    it('should return empty array for empty JSON array', () => {
      expect(parseObservationsFromLLMResponse('[]')).toEqual([])
    })
  })

  describe('content validation', () => {
    it('should filter out entries without content', () => {
      const response = JSON.stringify([
        { volatility: 'stable' },
        { content: 'Valid content here', volatility: 'stable' }
      ])
      const result = parseObservationsFromLLMResponse(response)
      expect(result).toHaveLength(1)
      expect(result[0].content).toBe('Valid content here')
    })

    it('should filter out entries with non-string content', () => {
      const response = JSON.stringify([
        { content: 123, volatility: 'stable' },
        { content: true, volatility: 'stable' },
        { content: 'Valid content here', volatility: 'stable' }
      ])
      const result = parseObservationsFromLLMResponse(response)
      expect(result).toHaveLength(1)
    })

    it('should filter out content that is too short (<=5 chars)', () => {
      const response = JSON.stringify([
        { content: 'Hi', volatility: 'stable' },       // 2 chars
        { content: 'Hello', volatility: 'stable' },     // 5 chars
        { content: 'Hello!', volatility: 'stable' }     // 6 chars - valid
      ])
      const result = parseObservationsFromLLMResponse(response)
      expect(result).toHaveLength(1)
      expect(result[0].content).toBe('Hello!')
    })

    it('should filter out content that is too long', () => {
      const longContent = 'A'.repeat(501)
      const response = JSON.stringify([
        { content: longContent, volatility: 'stable' },
        { content: 'Normal content here', volatility: 'stable' }
      ])
      const result = parseObservationsFromLLMResponse(response)
      expect(result).toHaveLength(1)
      expect(result[0].content).toBe('Normal content here')
    })

    it('should respect custom maxContentLength', () => {
      const response = JSON.stringify([
        { content: 'This is exactly twenty', volatility: 'stable' }  // 22 chars
      ])
      const result = parseObservationsFromLLMResponse(response, 10, 20)
      expect(result).toHaveLength(0)
      
      const result2 = parseObservationsFromLLMResponse(response, 10, 25)
      expect(result2).toHaveLength(1)
    })
  })

  describe('observation count limits', () => {
    it('should limit to maxObservations', () => {
      const observations = Array(20).fill(null).map((_, i) => ({
        content: `Observation number ${i + 1} is here`,
        volatility: 'moderate'
      }))
      const response = JSON.stringify(observations)
      
      const result = parseObservationsFromLLMResponse(response, 5)
      expect(result).toHaveLength(5)
    })

    it('should default to 10 max observations', () => {
      const observations = Array(15).fill(null).map((_, i) => ({
        content: `Observation number ${i + 1} is here`,
        volatility: 'moderate'
      }))
      const response = JSON.stringify(observations)
      
      const result = parseObservationsFromLLMResponse(response)
      expect(result).toHaveLength(10)
    })
  })

  describe('volatility validation', () => {
    it('should accept valid volatility values', () => {
      const response = JSON.stringify([
        { content: 'Stable fact here', volatility: 'stable' },
        { content: 'Moderate fact here', volatility: 'moderate' },
        { content: 'Volatile fact here', volatility: 'volatile' }
      ])
      const result = parseObservationsFromLLMResponse(response)
      expect(result[0].volatility).toBe('stable')
      expect(result[1].volatility).toBe('moderate')
      expect(result[2].volatility).toBe('volatile')
    })

    it('should set undefined for invalid volatility values', () => {
      const response = JSON.stringify([
        { content: 'Invalid volatility test', volatility: 'high' },
        { content: 'Another invalid test here', volatility: 'low' },
        { content: 'Number volatility test', volatility: 42 }
      ])
      const result = parseObservationsFromLLMResponse(response)
      expect(result).toHaveLength(3)
      expect(result[0].volatility).toBeUndefined()
      expect(result[1].volatility).toBeUndefined()
      expect(result[2].volatility).toBeUndefined()
    })

    it('should handle missing volatility', () => {
      const response = JSON.stringify([
        { content: 'No volatility field' }
      ])
      const result = parseObservationsFromLLMResponse(response)
      expect(result[0].volatility).toBeUndefined()
    })
  })

  describe('source validation and sanitization', () => {
    it('should accept valid source strings', () => {
      const response = JSON.stringify([
        { content: 'MySQL is version 8.0', source: 'mysql --version' }
      ])
      const result = parseObservationsFromLLMResponse(response)
      expect(result[0].source).toBe('mysql --version')
    })

    it('should set undefined for non-string source', () => {
      const response = JSON.stringify([
        { content: 'Non string source test', source: 123 }
      ])
      const result = parseObservationsFromLLMResponse(response)
      expect(result[0].source).toBeUndefined()
    })

    it('should strip newlines and tabs from source', () => {
      const response = JSON.stringify([
        { content: 'Source with newlines test', source: 'cmd\n--flag\t--opt' }
      ])
      const result = parseObservationsFromLLMResponse(response)
      expect(result[0].source).toBe('cmd --flag --opt')
    })

    it('should truncate long source strings', () => {
      const longSource = 'x'.repeat(300)
      const response = JSON.stringify([
        { content: 'Long source field test', source: longSource }
      ])
      const result = parseObservationsFromLLMResponse(response, 10, 500, 100)
      expect(result[0].source!.length).toBeLessThanOrEqual(100)
    })

    it('should handle missing source', () => {
      const response = JSON.stringify([
        { content: 'No source field here' }
      ])
      const result = parseObservationsFromLLMResponse(response)
      expect(result[0].source).toBeUndefined()
    })
  })
})
