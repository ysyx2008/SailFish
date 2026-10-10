import type { KnowledgeDocument } from './types'

const SESSION_TAG_PREFIX = 'session:'

export function conversationSessionTag(sessionId: string): string {
  return `${SESSION_TAG_PREFIX}${sessionId}`
}

/** 一条知识库文档是否属于指定会话的对话检索条目（对不上的旧条目不会命中） */
export function isConversationDocForSession(
  doc: Pick<KnowledgeDocument, 'fileType' | 'contentHash' | 'tags'>,
  sessionId: string,
  sessionContentHash: string
): boolean {
  if (doc.fileType !== 'conversation') return false
  if (sessionContentHash && doc.contentHash === sessionContentHash) return true
  return doc.tags.includes(conversationSessionTag(sessionId))
}

/** 自动召回的一条过往对话 */
export interface RecalledConversation {
  userRequest: string
  finalResult: string
  status: string
  timestamp: number
  relevance: number
  /** 是否就是当前这场对话早些时候的一轮；旧条目没记所属会话时为 undefined */
  sameSession?: boolean
}

/** 对话检索条目的正文：首行是当时用户的话，其余是当时的结果 */
export function parseConversationContent(content: string): { userRequest: string; finalResult: string } {
  const lines = content.split('\n')
  return { userRequest: lines[0] || '', finalResult: lines.slice(1).join('\n') }
}

/** 召回时所在的那场对话 */
export interface RecallingConversation {
  id: string
  startedAt: number
}

/**
 * 这条对话检索条目是不是当前这场对话的。
 * 旧条目没记所属会话：早于这场开始的必是另一场，其余说不准（undefined）。
 */
export function conversationSessionRelation(
  doc: Pick<KnowledgeDocument, 'tags' | 'createdAt'>,
  current?: RecallingConversation
): boolean | undefined {
  if (!current) return undefined
  if (doc.tags.includes(conversationSessionTag(current.id))) return true
  if (doc.tags.some(tag => tag.startsWith(SESSION_TAG_PREFIX))) return false
  return doc.createdAt < current.startedAt ? false : undefined
}

const RECALLED_RESULT_MAX_CHARS = 200

/** 对话检索条目 → 召回的一条过往对话；所有召回入口都经这里，结果截断一致 */
export function toRecalledConversation(
  doc: Pick<KnowledgeDocument, 'tags' | 'createdAt' | 'source'>,
  content: string,
  relevance: number,
  current?: RecallingConversation
): RecalledConversation {
  const { userRequest, finalResult } = parseConversationContent(content)
  return {
    userRequest,
    finalResult: finalResult.length > RECALLED_RESULT_MAX_CHARS
      ? finalResult.substring(0, RECALLED_RESULT_MAX_CHARS) + '...'
      : finalResult,
    status: doc.source || 'unknown',
    timestamp: doc.createdAt,
    relevance,
    sameSession: conversationSessionRelation(doc, current),
  }
}

export const RECALLED_CONVERSATIONS_INTRO = '以下过往对话是系统按相似度自动检索出来的，不是用户提起的。'

/** 旧条目回填时几乎一律记成成功（中止的也是），所以「成功」不标，收场看结果原文 */
const STATUS_LABEL: Record<string, string> = {
  failed: '失败',
  aborted: '中止',
}

function formatLocalTime(timestamp: number): string {
  const d = new Date(timestamp)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function formatRecalledConversation(conv: RecalledConversation): string {
  const heading = ['### 过往对话', formatLocalTime(conv.timestamp)]
  if (conv.sameSession === true) heading.push('这场对话早些时候')
  else if (conv.sameSession === false) heading.push('另一场对话')
  const status = STATUS_LABEL[conv.status]
  if (status) heading.push(status)

  const lines = [heading.join(' · '), `当时用户说：${conv.userRequest.trim()}`]
  const result = conv.finalResult.trim()
  if (result) lines.push(`当时的结果：${result}`)
  return lines.join('\n')
}

/** 引导语 + 逐条过往对话；没有就返回空串 */
export function formatRecalledConversations(convs: RecalledConversation[]): string {
  if (convs.length === 0) return ''
  return [RECALLED_CONVERSATIONS_INTRO, ...convs.map(formatRecalledConversation)].join('\n\n')
}
