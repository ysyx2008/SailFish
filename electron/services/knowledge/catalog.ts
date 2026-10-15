/**
 * 档案室目录与「目录印象」召回的纯逻辑。
 * 不碰向量库，也不改主机记忆 / 过往对话那条融合。
 */

import type { CardStatus } from './types'

export class FolderPathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FolderPathError'
  }
}

/** 每轮自动带到对话里的字数上限（印象 + 摘录一起算） */
export const RECALL_CHAR_BUDGET = 4000

/** 卡片向量命中的余弦下限。正文片段那条路的 0.6 不动，这是另一条路自己的数 */
export const CARD_SIMILARITY = 0.5

export const MAX_IMPRESSIONS = 30
export const MAX_KEYWORD_DOCS = 5
export const MIN_KEYWORD_SCORE = 1.2
export const MAX_EXCERPTS = 2
export const EXCERPT_CHARS = 800

const RRF_K = 60

export function isLibraryFileType(fileType: string | undefined): boolean {
  return fileType !== 'host-memory' && fileType !== 'conversation'
}

/** 人写的目录。空字符串表示放在根上。 */
export function normalizeFolder(raw: string): string {
  const parts = raw.split(/[/\\]+/).map(part => part.trim()).filter(Boolean)
  if (parts.some(part => part === '.' || part === '..')) {
    throw new FolderPathError('目录不能包含 . 或 ..')
  }
  if (parts.some(part => part.length > 80)) {
    throw new FolderPathError('每一级目录名不能超过 80 个字')
  }
  if (parts.length > 8) {
    throw new FolderPathError('目录最多 8 级')
  }
  return parts.join('/')
}

/** 老数据里写坏的目录当成根，不让加载失败 */
export function normalizeFolderSafe(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) return ''
  try {
    return normalizeFolder(raw)
  } catch {
    return ''
  }
}

export function inFolder(folder: string, prefix: string): boolean {
  if (!prefix) return true
  return folder === prefix || folder.startsWith(`${prefix}/`)
}

/**
 * 这场对话显式给了范围就用它（含空字符串 = 全库）；
 * 没给过，才用设置里的范围。
 */
export function resolveRecallFolder(explicit: string | undefined, configured: string | undefined): string {
  if (explicit !== undefined) return explicit
  return configured || ''
}

export function displayPath(folder: string, filename: string): string {
  return folder ? `${folder}/${filename}` : filename
}

export interface KeywordChunk {
  docId: string
  score: number
  excerpt: string
}

export function bestKeywordPerDoc(chunks: KeywordChunk[], minScore: number, limit: number): KeywordChunk[] {
  const best = new Map<string, KeywordChunk>()
  for (const chunk of chunks) {
    const prev = best.get(chunk.docId)
    if (!prev || chunk.score > prev.score) best.set(chunk.docId, chunk)
  }
  return [...best.values()]
    .filter(chunk => chunk.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

export interface FusedDoc {
  docId: string
  score: number
  fromCard: boolean
  fromKeyword: boolean
  excerpt?: string
}

/** 只在档案召回这条路上按文档合并。公共的片段融合不走这里。 */
export function fuseByDocument(cardDocIds: string[], keyword: KeywordChunk[]): FusedDoc[] {
  const map = new Map<string, FusedDoc>()
  cardDocIds.forEach((docId, rank) => {
    const row = map.get(docId) ?? { docId, score: 0, fromCard: false, fromKeyword: false }
    row.score += 1 / (RRF_K + rank + 1)
    row.fromCard = true
    map.set(docId, row)
  })
  keyword.forEach((hit, rank) => {
    const row = map.get(hit.docId) ?? { docId: hit.docId, score: 0, fromCard: false, fromKeyword: false }
    row.score += 1 / (RRF_K + rank + 1)
    row.fromKeyword = true
    if (!row.excerpt) row.excerpt = hit.excerpt
    map.set(hit.docId, row)
  })
  return [...map.values()].sort((a, b) => b.score - a.score)
}

export interface ImpressionDoc {
  id: string
  filename: string
  folder: string
  cardStatus?: CardStatus
  cardSummary?: string
}

export function renderLibraryRecall(args: {
  fused: FusedDoc[]
  docs: Map<string, ImpressionDoc>
  excerpts: { docId: string; text: string }[]
  charBudget?: number
}): string {
  const budget = args.charBudget ?? RECALL_CHAR_BUDGET
  const lines: string[] = [
    '按相关度从档案室翻到的线索。不是用户刚说的话。线索和下面的摘录不是全文。',
    '',
  ]
  let used = lines.join('\n').length
  let shown = 0

  for (const hit of args.fused) {
    if (shown >= MAX_IMPRESSIONS) break
    const doc = args.docs.get(hit.docId)
    if (!doc) continue
    const head = `- ${displayPath(doc.folder, doc.filename)}（doc_id: ${doc.id}）`
    const bits = [head]
    if (doc.cardSummary) bits.push(`  ${doc.cardSummary}`)
    if (doc.cardStatus === 'stale') bits.push('  （说明还停在旧版，原文已更新）')
    const block = bits.join('\n')
    if (used + block.length + 1 > budget) break
    lines.push(block)
    used += block.length + 1
    shown++
  }

  if (shown === 0) return ''

  const excerpts: string[] = []
  for (const excerpt of args.excerpts) {
    if (excerpts.length >= MAX_EXCERPTS) break
    const doc = args.docs.get(excerpt.docId)
    if (!doc) continue
    const room = budget - used
    if (room < 80) break
    const text = excerpt.text.length > EXCERPT_CHARS ? `${excerpt.text.slice(0, EXCERPT_CHARS)}…` : excerpt.text
    const block = `### ${displayPath(doc.folder, doc.filename)}（doc_id: ${doc.id}）\n${text}`
    if (block.length + 2 > room) {
      const sliced = block.slice(0, room)
      if (sliced.length < 80) break
      excerpts.push(sliced)
      used += sliced.length
      break
    }
    excerpts.push(block)
    used += block.length + 2
  }

  if (excerpts.length > 0) {
    lines.push('')
    lines.push('原文摘录：')
    lines.push(excerpts.join('\n\n'))
  }

  return lines.join('\n').trim()
}

export function formatCatalog(docs: ImpressionDoc[], prefix: string, limit = 200): string {
  const rows = docs
    .filter(doc => inFolder(doc.folder, prefix))
    .sort((a, b) => displayPath(a.folder, a.filename).localeCompare(displayPath(b.folder, b.filename), 'zh'))
  if (rows.length === 0) return prefix ? `「${prefix}」里没有文档。` : '档案室里还没有文档。'
  const visible = rows.slice(0, limit)
  const body = visible.map(doc => {
    const summary = doc.cardSummary ? `\n  ${doc.cardSummary}` : ''
    const stale = doc.cardStatus === 'stale' ? '\n  （说明还停在旧版）' : ''
    return `- ${displayPath(doc.folder, doc.filename)}（doc_id: ${doc.id}）${summary}${stale}`
  }).join('\n')
  if (rows.length > limit) return `${body}\n\n还有 ${rows.length - limit} 份没有列出。`
  return body
}

export function capChunkText(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}…`
}
