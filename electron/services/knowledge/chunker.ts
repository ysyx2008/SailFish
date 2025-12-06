/**
 * 智能分块服务
 * 将长文档切分成适合向量化的小块
 */
import type { ChunkOptions, ChunkStrategy, DocumentChunk, ChunkMetadata } from './types'

// 默认分块选项
const DEFAULT_CHUNK_OPTIONS: ChunkOptions = {
  maxChunkSize: 512,      // tokens（约 1500 字符）
  overlapSize: 50,        // tokens 重叠
  strategy: 'paragraph'
}

// 句子结束标记
const SENTENCE_ENDINGS = /[。！？.!?]/

// 段落分隔标记
const PARAGRAPH_SEPARATOR = /\n\s*\n/

/**
 * 估算 token 数量（粗略估计）
 * 中文约 1.5 token/字符，英文约 0.25 token/字符
 */
function estimateTokens(text: string): number {
  const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length
  const otherChars = text.length - chineseChars
  return Math.ceil(chineseChars * 1.5 + otherChars * 0.25)
}

/**
 * 估算字符数（根据 token 数反推）
 */
function estimateCharsFromTokens(tokens: number): number {
  // 假设平均 0.75 token/字符
  return Math.floor(tokens / 0.75)
}

/**
 * 分块服务类
 */
export class Chunker {
  private options: ChunkOptions

  constructor(options?: Partial<ChunkOptions>) {
    this.options = { ...DEFAULT_CHUNK_OPTIONS, ...options }
  }

  /**
   * 对文本进行分块
   */
  chunk(
    text: string, 
    docId: string, 
    metadata: Omit<ChunkMetadata, 'startOffset' | 'endOffset'>
  ): DocumentChunk[] {
    const cleanText = this.preprocessText(text)
    
    switch (this.options.strategy) {
      case 'paragraph':
        return this.chunkByParagraph(cleanText, docId, metadata)
      case 'semantic':
        return this.chunkBySemantic(cleanText, docId, metadata)
      case 'fixed':
      default:
        return this.chunkByFixed(cleanText, docId, metadata)
    }
  }

  /**
   * 预处理文本
   */
  private preprocessText(text: string): string {
    return text
      // 规范化换行
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      // 移除过多的空行
      .replace(/\n{4,}/g, '\n\n\n')
      // 移除首尾空白
      .trim()
  }

  /**
   * 按段落分块
   */
  private chunkByParagraph(
    text: string, 
    docId: string,
    metadata: Omit<ChunkMetadata, 'startOffset' | 'endOffset'>
  ): DocumentChunk[] {
    const chunks: DocumentChunk[] = []
    const paragraphs = text.split(PARAGRAPH_SEPARATOR)
    const maxChars = estimateCharsFromTokens(this.options.maxChunkSize)
    
    let currentChunk = ''
    let currentStart = 0
    let chunkIndex = 0
    let offset = 0

    for (const para of paragraphs) {
      const trimmedPara = para.trim()
      if (!trimmedPara) {
        offset += para.length + 2  // +2 for paragraph separator
        continue
      }

      // 如果当前段落加上已有内容超过限制
      if (currentChunk && estimateTokens(currentChunk + '\n\n' + trimmedPara) > this.options.maxChunkSize) {
        // 保存当前块
        if (currentChunk.trim()) {
          chunks.push(this.createChunk(
            currentChunk.trim(),
            docId,
            chunkIndex++,
            currentStart,
            offset - 2,
            metadata
          ))
        }
        
        // 开始新块
        currentChunk = trimmedPara
        currentStart = offset
      } else {
        // 添加到当前块
        if (currentChunk) {
          currentChunk += '\n\n' + trimmedPara
        } else {
          currentChunk = trimmedPara
          currentStart = offset
        }
      }

      offset += para.length + 2
    }

    // 处理最后一个块
    if (currentChunk.trim()) {
      chunks.push(this.createChunk(
        currentChunk.trim(),
        docId,
        chunkIndex++,
        currentStart,
        text.length,
        metadata
      ))
    }

    // 如果有超大段落，需要进一步切分
    return this.splitOversizedChunks(chunks, docId, metadata)
  }

  /**
   * 按语义边界分块（句子级别）
   */
  private chunkBySemantic(
    text: string, 
    docId: string,
    metadata: Omit<ChunkMetadata, 'startOffset' | 'endOffset'>
  ): DocumentChunk[] {
    const chunks: DocumentChunk[] = []
    const sentences = this.splitIntoSentences(text)
    const maxTokens = this.options.maxChunkSize
    const overlapTokens = this.options.overlapSize
    
    let currentChunk = ''
    let currentStart = 0
    let chunkIndex = 0
    let offset = 0
    let overlapBuffer: string[] = []

    for (const sentence of sentences) {
      const sentenceTokens = estimateTokens(sentence)
      const currentTokens = estimateTokens(currentChunk)

      // 如果添加这个句子会超过限制
      if (currentChunk && currentTokens + sentenceTokens > maxTokens) {
        // 保存当前块
        if (currentChunk.trim()) {
          chunks.push(this.createChunk(
            currentChunk.trim(),
            docId,
            chunkIndex++,
            currentStart,
            offset,
            metadata
          ))
        }

        // 使用重叠内容开始新块
        if (overlapTokens > 0 && overlapBuffer.length > 0) {
          currentChunk = overlapBuffer.join('') + sentence
        } else {
          currentChunk = sentence
        }
        currentStart = offset - (overlapBuffer.join('').length)
        overlapBuffer = []
      } else {
        currentChunk += sentence
      }

      // 更新重叠缓冲区
      overlapBuffer.push(sentence)
      let overlapTotal = overlapBuffer.reduce((sum, s) => sum + estimateTokens(s), 0)
      while (overlapTotal > overlapTokens && overlapBuffer.length > 1) {
        overlapBuffer.shift()
        overlapTotal = overlapBuffer.reduce((sum, s) => sum + estimateTokens(s), 0)
      }

      offset += sentence.length
    }

    // 处理最后一个块
    if (currentChunk.trim()) {
      chunks.push(this.createChunk(
        currentChunk.trim(),
        docId,
        chunkIndex++,
        currentStart,
        text.length,
        metadata
      ))
    }

    return chunks
  }

  /**
   * 固定大小分块（带重叠）
   */
  private chunkByFixed(
    text: string, 
    docId: string,
    metadata: Omit<ChunkMetadata, 'startOffset' | 'endOffset'>
  ): DocumentChunk[] {
    const chunks: DocumentChunk[] = []
    const maxChars = estimateCharsFromTokens(this.options.maxChunkSize)
    const overlapChars = estimateCharsFromTokens(this.options.overlapSize)
    
    let chunkIndex = 0
    let start = 0

    while (start < text.length) {
      let end = Math.min(start + maxChars, text.length)
      
      // 尝试在句子边界结束
      if (end < text.length) {
        const lastPeriod = text.lastIndexOf('。', end)
        const lastQuestion = text.lastIndexOf('？', end)
        const lastExclaim = text.lastIndexOf('！', end)
        const lastDot = text.lastIndexOf('.', end)
        
        const candidates = [lastPeriod, lastQuestion, lastExclaim, lastDot]
          .filter(pos => pos > start + maxChars / 2)
        
        if (candidates.length > 0) {
          end = Math.max(...candidates) + 1
        }
      }

      const chunkText = text.slice(start, end).trim()
      
      if (chunkText) {
        chunks.push(this.createChunk(
          chunkText,
          docId,
          chunkIndex++,
          start,
          end,
          metadata
        ))
      }

      // 下一个块的起始位置（考虑重叠）
      start = end - overlapChars
      if (start <= chunks[chunks.length - 1]?.metadata.startOffset) {
        start = end
      }
    }

    return chunks
  }

  /**
   * 将文本分割成句子
   */
  private splitIntoSentences(text: string): string[] {
    const sentences: string[] = []
    let current = ''

    for (let i = 0; i < text.length; i++) {
      current += text[i]
      
      // 检查是否是句子结束
      if (SENTENCE_ENDINGS.test(text[i])) {
        // 排除小数点、省略号等情况
        const nextChar = text[i + 1]
        if (!nextChar || /[\s\n]/.test(nextChar) || /[\u4e00-\u9fa5A-Za-z]/.test(nextChar)) {
          if (current.trim()) {
            sentences.push(current)
          }
          current = ''
        }
      }
    }

    // 处理最后一个句子
    if (current.trim()) {
      sentences.push(current)
    }

    return sentences
  }

  /**
   * 切分超大块
   */
  private splitOversizedChunks(
    chunks: DocumentChunk[], 
    docId: string,
    metadata: Omit<ChunkMetadata, 'startOffset' | 'endOffset'>
  ): DocumentChunk[] {
    const result: DocumentChunk[] = []
    const maxTokens = this.options.maxChunkSize

    for (const chunk of chunks) {
      if (estimateTokens(chunk.content) <= maxTokens * 1.2) {
        result.push(chunk)
      } else {
        // 需要进一步切分
        const subChunks = this.chunkByFixed(chunk.content, docId, metadata)
        
        // 重新计算索引和偏移
        for (let i = 0; i < subChunks.length; i++) {
          const sub = subChunks[i]
          sub.chunkIndex = result.length
          sub.metadata.startOffset = chunk.metadata.startOffset + sub.metadata.startOffset
          sub.metadata.endOffset = chunk.metadata.startOffset + sub.metadata.endOffset
          result.push(sub)
        }
      }
    }

    // 更新总块数
    for (const chunk of result) {
      chunk.totalChunks = result.length
    }

    return result
  }

  /**
   * 创建分块对象
   */
  private createChunk(
    content: string,
    docId: string,
    chunkIndex: number,
    startOffset: number,
    endOffset: number,
    metadata: Omit<ChunkMetadata, 'startOffset' | 'endOffset'>
  ): DocumentChunk {
    return {
      id: `${docId}_chunk_${chunkIndex}`,
      docId,
      content,
      chunkIndex,
      totalChunks: 0,  // 后续更新
      metadata: {
        ...metadata,
        startOffset,
        endOffset
      }
    }
  }

  /**
   * 更新分块选项
   */
  setOptions(options: Partial<ChunkOptions>): void {
    this.options = { ...this.options, ...options }
  }

  /**
   * 获取当前选项
   */
  getOptions(): ChunkOptions {
    return { ...this.options }
  }
}

// 导出工厂函数
export function createChunker(options?: Partial<ChunkOptions>): Chunker {
  return new Chunker(options)
}

// 导出默认实例
let defaultChunker: Chunker | null = null

export function getChunker(): Chunker {
  if (!defaultChunker) {
    defaultChunker = new Chunker()
  }
  return defaultChunker
}

