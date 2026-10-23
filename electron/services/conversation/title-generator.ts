/**
 * 任务侧栏短标题 —— 首条消息异步生成；每完整三轮后复用刚结束的对话前缀再写一次。
 * 不阻塞 Agent run；用户手改过的不覆盖；失败静默回退到已有 title / userTask。
 */
import type { AiMessage, AiService, ToolDefinition } from '../ai.service'
import type { ConfigService } from '../config.service'
import type { HistoryService } from '../history.service'
import { createLogger } from '../../utils/logger'

const log = createLogger('ConversationTitle')

/** 同时进行中的 session，避免重复请求 */
const inflight = new Set<string>()

const TITLE_MAX_LEN = 40
const TITLE_REFRESH_EVERY = 3

export interface ConversationTitleWriter {
  setConversationTitleBySessionId(sessionId: string, title: string): boolean
}

export interface GenerateConversationTitleDeps {
  aiService: AiService
  configService: ConfigService
  historyService: HistoryService
  agentService: ConversationTitleWriter
}

export interface GenerateConversationTitleInput {
  sessionId: string
  /** 首条占位；refresh 可不传 */
  userMessage?: string
  profileId?: string
  /** 默认 initial：无标题才写。refresh：允许覆盖自动标题 */
  mode?: 'initial' | 'refresh'
  /** 刚结束的一轮前缀；refresh 时用来复用缓存，且不写进用户对话 */
  cachePrefix?: AiMessage[]
  /** 与上一轮相同的工具表，便于命中 provider 前缀缓存 */
  tools?: ToolDefinition[]
}

/**
 * 清洗模型输出为侧栏可用短标题。纯函数，供单测。
 */
export function sanitizeConversationTitle(raw: string): string | null {
  let text = raw.trim()
  if (!text) return null

  text = text.split(/\r?\n/)[0]?.trim() ?? ''
  text = text.replace(/^["'「『【[]+|["'」』】\]]+$/g, '').trim()
  text = text.replace(/\s+/g, ' ')
  if (!text) return null

  if (text.length > TITLE_MAX_LEN) {
    text = text.slice(0, TITLE_MAX_LEN).trim()
  }
  return text || null
}

/** 同一条会话里，用户完整说完的轮次是否该重写标题（3 / 6 / 9 …） */
export function shouldRefreshConversationTitle(userTaskCount: number): boolean {
  return userTaskCount >= TITLE_REFRESH_EVERY && userTaskCount % TITLE_REFRESH_EVERY === 0
}

/** 新旧标题是否实质相同（忽略空白、大小写、包裹标点） */
export function titlesEquivalent(a: string, b: string): boolean {
  const norm = (s: string) =>
    s.toLowerCase().replace(/\s+/g, '').replace(/[^\p{L}\p{N}]+/gu, '')
  const na = norm(a)
  const nb = norm(b)
  if (!na || !nb) return false
  if (na === nb) return true
  const [shorter, longer] = na.length <= nb.length ? [na, nb] : [nb, na]
  return longer.includes(shorter) && shorter.length >= 3
}

function buildTitlePrompt(userMessage: string, language: string): string {
  const isEn = language.startsWith('en')
  const message = userMessage.length > 500 ? `${userMessage.slice(0, 500)}…` : userMessage

  if (isEn) {
    return [
      'Generate a short sidebar title for this chat (about 8–10 words, under 40 characters).',
      'Reply with ONLY the title — no quotes, no punctuation wrapping, no explanation.',
      '',
      'User message:',
      message,
    ].join('\n')
  }

  return [
    '根据用户的第一条消息，生成侧栏会话短标题（不超过 20 个汉字或等价长度）。',
    '只输出标题本身，不要引号、不要标点包裹、不要解释。',
    '',
    '用户消息：',
    message,
  ].join('\n')
}

function buildRefreshTitlePrompt(language: string): string {
  if (language.startsWith('en')) {
    return [
      'Based on the conversation so far, generate a short sidebar title (about 8–10 words, under 40 characters).',
      'Name what this chat is actually about now, not just the first message.',
      'Reply with ONLY the title — no quotes, no punctuation wrapping, no explanation, no tool calls.',
    ].join('\n')
  }

  return [
    '根据到目前为止的整段对话，生成侧栏会话短标题（不超过 20 个汉字或等价长度）。',
    '写现在实际在做的事，不要只重复第一句话。',
    '只输出标题本身，不要引号、不要标点包裹、不要解释、不要调用工具。',
  ].join('\n')
}

function isPlaceholderUserMessage(userMessage: string): boolean {
  return userMessage.startsWith('__') && userMessage.endsWith('__')
}

export function broadcastConversationTitle(sessionId: string, title: string): void {
  try {
    // CLI / 单测没有真实窗口时静默
    const electron = require('electron') as { BrowserWindow?: { getAllWindows: () => Array<{ isDestroyed: () => boolean; webContents: { send: (ch: string, data: unknown) => void } }> } }
    const windows = electron.BrowserWindow?.getAllWindows?.() ?? []
    for (const win of windows) {
      if (!win.isDestroyed()) {
        win.webContents.send('history:conversationTitle', { sessionId, title })
      }
    }
  } catch {
    // ignore
  }
}

async function requestTitle(
  deps: GenerateConversationTitleDeps,
  input: GenerateConversationTitleInput,
  language: string
): Promise<string> {
  if (input.mode === 'refresh') {
    const prefix = input.cachePrefix
    if (!prefix?.length) return ''
    const messages: AiMessage[] = [
      ...prefix,
      { role: 'user', content: buildRefreshTitlePrompt(language) },
    ]
    const tools = input.tools
    if (tools && tools.length > 0 && typeof deps.aiService.chatWithTools === 'function') {
      const result = await deps.aiService.chatWithTools(messages, tools, input.profileId)
      return result.content || ''
    }
    return deps.aiService.chat(messages, input.profileId)
  }

  const userMessage = input.userMessage?.trim() ?? ''
  return deps.aiService.chat(
    [{ role: 'user', content: buildTitlePrompt(userMessage, language) }],
    input.profileId
  )
}

/**
 * 为任务会话异步生成短标题并写入会话（内存 + 落盘/pending）。
 * @returns 成功写入的标题；跳过或失败返回 null
 */
export async function generateConversationTitle(
  deps: GenerateConversationTitleDeps,
  input: GenerateConversationTitleInput
): Promise<string | null> {
  const sessionId = input.sessionId?.trim()
  if (!sessionId) return null

  const mode = input.mode ?? 'initial'
  const userMessage = input.userMessage?.trim() ?? ''
  if (mode === 'initial') {
    if (!userMessage) return null
    if (isPlaceholderUserMessage(userMessage)) return null
  } else if (!input.cachePrefix?.length) {
    return null
  }

  if (inflight.has(sessionId)) return null

  const existing = deps.historyService.getAgentRecordById(sessionId)
  if (existing?.titleLocked) return null
  if (mode === 'initial' && existing?.title?.trim()) return null

  inflight.add(sessionId)
  try {
    const language = deps.configService.getLanguage() || 'zh-CN'
    const response = await requestTitle(deps, input, language)
    const title = sanitizeConversationTitle(response)
    if (!title) {
      log.warn(`Empty title for ${sessionId}`)
      return null
    }

    const after = deps.historyService.getAgentRecordById(sessionId)
    if (after?.titleLocked) {
      log.info(`Skip auto-title for ${sessionId}: user locked title`)
      return null
    }
    if (mode === 'initial' && after?.title?.trim()) {
      log.info(`Skip auto-title for ${sessionId}: title already set`)
      return null
    }
    if (mode === 'refresh' && after?.title?.trim() && titlesEquivalent(after.title, title)) {
      log.info(`Skip auto-title for ${sessionId}: equivalent to existing`)
      return null
    }

    const written = deps.agentService.setConversationTitleBySessionId(sessionId, title)
    if (!written) {
      log.info(`Skip auto-title for ${sessionId}: write rejected`)
      return null
    }
    broadcastConversationTitle(sessionId, title)
    log.info(`${mode === 'refresh' ? 'Refreshed' : 'Auto-titled'} ${sessionId}: "${title}"`)
    return title
  } catch (err) {
    log.warn(`Auto-title failed for ${sessionId}:`, err)
    return null
  } finally {
    inflight.delete(sessionId)
  }
}

/** 测试用：清空 in-flight 集合 */
export function resetTitleGeneratorInflightForTest(): void {
  inflight.clear()
}
