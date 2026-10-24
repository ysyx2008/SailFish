/** keyword-index.js 的类型（该文件是 worker 与进程内模式共用的原样 JS，见其头部说明） */

/** 按字面（关键词）检索命中的一个片段 */
export interface KeywordHit {
  id: string
  docId: string
  content: string
  score: number
  filename: string
  hostId: string
  /** 逗号分隔 */
  tags: string
}

export interface KeywordPrepareResult {
  addedColumn: boolean
  backfilled: number
  indexed: boolean
}

export interface KeywordSearchRequest {
  query: string
  limit: number
  hostId?: string
  tags?: string[]
}

export class KeywordIndex {
  constructor(options: { lancedb: unknown; log?: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void } })
  reset(): void
  tokenize(text: string): string[]
  tokensText(text: string): string
  withTokens<T extends { content: string; tokens?: string }>(records: T[]): T[]
  prepare(table: any): Promise<KeywordPrepareResult>
  backfill(table: any): Promise<number>
  ensureIndex(table: any): Promise<boolean>
  needsOptimize(table: any): Promise<boolean>
  search(table: any, request: KeywordSearchRequest): Promise<KeywordHit[]>
}

export const TOKEN_COLUMN: string
export const INDEX_NAME: string
