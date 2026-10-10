import { describe, expect, it } from 'vitest'
import {
  conversationSessionRelation,
  conversationSessionTag,
  formatRecalledConversation,
  formatRecalledConversations,
  isConversationDocForSession,
  parseConversationContent,
  RECALLED_CONVERSATIONS_INTRO,
  toRecalledConversation,
} from '../conversation-index'

describe('conversationSessionRelation', () => {
  const current = { id: 'session_a', startedAt: 1_000 }
  const tagged = (id: string, createdAt = 2_000) => ({ tags: ['conversation', 'local', conversationSessionTag(id)], createdAt })
  const untagged = (createdAt: number) => ({ tags: ['conversation', 'local'], createdAt })

  it('tells this conversation apart from another one by session tag', () => {
    expect(conversationSessionRelation(tagged('session_a'), current)).toBe(true)
    expect(conversationSessionRelation(tagged('session_b'), current)).toBe(false)
  })

  it('untagged old entries from before this conversation started are another one', () => {
    expect(conversationSessionRelation(untagged(500), current)).toBe(false)
  })

  it('stays unknown when it cannot tell', () => {
    expect(conversationSessionRelation(untagged(1_500), current)).toBeUndefined()
    expect(conversationSessionRelation(tagged('session_b'), undefined)).toBeUndefined()
  })
})

describe('formatRecalledConversation', () => {
  const base = {
    userRequest: '深度测试你的子智能体能力',
    finalResult: '深度测试跑完了！5 个子智能体全部成功',
    status: 'success',
    timestamp: new Date(2026, 3, 25, 11, 37).getTime(),
    relevance: 0.02,
  }

  it('states when, which conversation, what the user said and how it ended', () => {
    expect(formatRecalledConversation({ ...base, sameSession: false })).toBe([
      '### 过往对话 · 2026-04-25 11:37 · 另一场对话',
      '当时用户说：深度测试你的子智能体能力',
      '当时的结果：深度测试跑完了！5 个子智能体全部成功',
    ].join('\n'))
  })

  it('omits what it does not know', () => {
    expect(formatRecalledConversation({ ...base, status: 'unknown', finalResult: '  ' })).toBe([
      '### 过往对话 · 2026-04-25 11:37',
      '当时用户说：深度测试你的子智能体能力',
    ].join('\n'))
  })

  it('labels aborted runs and earlier turns of this conversation', () => {
    expect(formatRecalledConversation({ ...base, status: 'aborted', sameSession: true }))
      .toContain('· 这场对话早些时候 · 中止')
  })

  it('leads the list with the intro, and is empty without items', () => {
    expect(formatRecalledConversations([base]).startsWith(RECALLED_CONVERSATIONS_INTRO)).toBe(true)
    expect(formatRecalledConversations([])).toBe('')
  })
})

describe('toRecalledConversation', () => {
  it('splits the entry, trims long results the same way for every entry point, and judges the conversation', () => {
    const doc = { tags: ['conversation', 'local'], createdAt: 500, source: 'aborted' }
    const conv = toRecalledConversation(doc, `问题\n${'长'.repeat(300)}`, 0.5, { id: 'session_a', startedAt: 1_000 })
    expect(conv.userRequest).toBe('问题')
    expect(conv.finalResult).toBe('长'.repeat(200) + '...')
    expect(conv).toMatchObject({ status: 'aborted', timestamp: 500, relevance: 0.5, sameSession: false })
  })
})

describe('parseConversationContent', () => {
  it('first line is what the user said, the rest is the result', () => {
    expect(parseConversationContent('问题\n第一行\n第二行')).toEqual({ userRequest: '问题', finalResult: '第一行\n第二行' })
    expect(parseConversationContent('只有问题')).toEqual({ userRequest: '只有问题', finalResult: '' })
  })
})

describe('isConversationDocForSession', () => {
  const sessionId = 'session_123'
  const sessionHash = 'hash-of-conv-session_123'
  const sessionTag = conversationSessionTag(sessionId)

  it('matches conversation docs tagged with the session', () => {
    expect(isConversationDocForSession({
      fileType: 'conversation',
      contentHash: 'hash-of-conv-run-xyz',
      tags: ['conversation', 'personal', sessionTag],
    }, sessionId, sessionHash)).toBe(true)
  })

  it('matches backfill-style docs keyed by session id', () => {
    expect(isConversationDocForSession({
      fileType: 'conversation',
      contentHash: sessionHash,
      tags: ['conversation', 'personal'],
    }, sessionId, sessionHash)).toBe(true)
  })

  it('does not match host memory or uploaded docs', () => {
    expect(isConversationDocForSession({
      fileType: 'host-memory',
      contentHash: sessionHash,
      tags: ['host-memory', sessionTag],
    }, sessionId, sessionHash)).toBe(false)
    expect(isConversationDocForSession({
      fileType: 'pdf',
      contentHash: sessionHash,
      tags: ['conversation', sessionTag],
    }, sessionId, sessionHash)).toBe(false)
  })

  it('does not match other conversations or untagged old entries', () => {
    expect(isConversationDocForSession({
      fileType: 'conversation',
      contentHash: 'hash-of-conv-other',
      tags: ['conversation', 'personal', conversationSessionTag('session_other')],
    }, sessionId, sessionHash)).toBe(false)
    expect(isConversationDocForSession({
      fileType: 'conversation',
      contentHash: 'hash-of-conv-run-old',
      tags: ['conversation', 'personal'],
    }, sessionId, sessionHash)).toBe(false)
  })
})
