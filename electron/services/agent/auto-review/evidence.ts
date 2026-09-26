/**
 * 评审员看到的材料。
 *
 * 分三块，信任度不同：
 * - 原话：只取用户亲手输入的——发起任务、中途补充、对提问的回答。取自界面步骤而不是
 *   发给模型的用户消息：后者会拼进上传文档、选区、系统提示等不是用户说的东西。
 * - 过程：干活那边最近的对话、工具调用与结果，只算线索。
 * - 这一条动作：要批准的是什么、在哪台机器上、旗鱼自己的命令审计怎么说。
 */
import type { AgentStep, RiskLevel, TerminalType } from '@shared/types'
import type { AiMessage } from '../../ai.service'

export interface UserWord {
  id: string
  kind: 'task' | 'supplement' | 'answer'
  text: string
  /** 仅 answer：助手问的那句（线索，不算授权） */
  question?: string
  attachments?: string[]
}

const PROACTIVE_TASK_MARKER = '__proactive__'

export function collectUserWords(steps: readonly AgentStep[]): UserWord[] {
  const seen = new Set<string>()
  const words: UserWord[] = []
  for (const s of steps) {
    if (seen.has(s.id)) continue
    const attachments = s.attachments?.map(a => a.filename).filter(Boolean)
    if (s.type === 'user_task') {
      if (!s.content || s.content === PROACTIVE_TASK_MARKER) continue
      seen.add(s.id)
      words.push({ id: s.id, kind: 'task', text: s.content, attachments: attachments?.length ? attachments : undefined })
    } else if (s.type === 'user_supplement') {
      if (!s.content) continue
      seen.add(s.id)
      words.push({ id: s.id, kind: 'supplement', text: s.content, attachments: attachments?.length ? attachments : undefined })
    } else if (s.type === 'asking' && s.askingStatus === 'received' && typeof s.askingAnswer === 'string') {
      seen.add(s.id)
      words.push({ id: s.id, kind: 'answer', text: s.askingAnswer, question: s.content })
    }
  }
  return words
}

export function userWordsChars(words: readonly UserWord[]): number {
  return words.reduce((n, w) => n + w.text.length + (w.question?.length ?? 0), 0)
}

export function formatUserWords(words: readonly UserWord[]): string {
  return words
    .map(w => {
      const attach = w.attachments?.length ? `\n（附件，仅文件名，内容不在此：${w.attachments.join('、')}）` : ''
      switch (w.kind) {
        case 'task':
          return `- 用户发起任务：${w.text}${attach}`
        case 'supplement':
          return `- 用户中途补充：${w.text}${attach}`
        case 'answer':
          return `- 助手提问（线索）：${w.question ?? ''}\n  用户回答：${w.text}`
      }
    })
    .join('\n')
}

// ==================== 过程（线索） ====================

export interface ProcessCursor {
  count: number
  fingerprint: string
}

export function messageFingerprint(msg: AiMessage | undefined): string {
  if (!msg) return ''
  const calls = msg.tool_calls?.map(c => c.id).join(',') ?? ''
  return `${msg.role}|${msg.tool_call_id ?? ''}|${calls}|${(msg.content ?? '').slice(0, 200)}`
}

export function cursorAt(messages: readonly AiMessage[]): ProcessCursor {
  return { count: messages.length, fingerprint: messageFingerprint(messages[messages.length - 1]) }
}

/** 干活那边的对话被压缩或改写过，游标就不再指向同一个位置。 */
export function cursorStillValid(messages: readonly AiMessage[], cursor: ProcessCursor): boolean {
  if (messages.length < cursor.count) return false
  if (cursor.count === 0) return true
  return messageFingerprint(messages[cursor.count - 1]) === cursor.fingerprint
}

const ASSISTANT_TEXT_LIMIT = 800
const TOOL_ENTRY_LIMIT = 1500

function clip(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}…（已截断，原长 ${text.length} 字）`
}

function renderMessage(msg: AiMessage): string[] {
  if (msg.role === 'assistant') {
    const lines: string[] = []
    if (msg.content?.trim()) lines.push(`助手：${clip(msg.content.trim(), ASSISTANT_TEXT_LIMIT)}`)
    for (const call of msg.tool_calls ?? []) {
      lines.push(`助手调用 ${call.function.name}：${clip(call.function.arguments, TOOL_ENTRY_LIMIT)}`)
    }
    return lines
  }
  if (msg.role === 'tool') {
    return [`工具返回：${clip(msg.content ?? '', TOOL_ENTRY_LIMIT)}`]
  }
  return []
}

/**
 * 从 fromIndex 起渲染过程；超出预算时保留最近的，并注明更早的省略了。
 * 用户消息不进过程：用户的话由原话一块单独给，且那里只有用户亲手输入的部分。
 */
export function formatProcess(
  messages: readonly AiMessage[],
  fromIndex: number,
  budgetChars: number,
): string {
  const entries: string[] = []
  for (let i = Math.max(0, fromIndex); i < messages.length; i++) {
    entries.push(...renderMessage(messages[i]))
  }
  const kept: string[] = []
  let used = 0
  for (let i = entries.length - 1; i >= 0; i--) {
    const len = entries[i].length + 1
    if (used + len > budgetChars) break
    kept.unshift(entries[i])
    used += len
  }
  if (kept.length === 0) return entries.length === 0 ? '（无）' : '（过程太长，已省略）'
  const omitted = kept.length < entries.length ? '（更早的过程已省略）\n' : ''
  return omitted + kept.join('\n')
}

// ==================== 这一条动作 ====================

export interface ReviewEnvironment {
  terminalType: TerminalType
  sshHost?: string
  cwd?: string
  os?: string
}

export interface PlannedAction {
  toolName: string
  displayName?: string
  riskLevel: RiskLevel
  reasons?: string[]
  args: Record<string, unknown>
  environment: ReviewEnvironment
}

const TERMINAL_LABEL: Record<TerminalType, string> = {
  local: '本机终端',
  ssh: '远程服务器（SSH）',
  assistant: '本机助手（无终端）',
}

export function serializeActionArgs(args: Record<string, unknown>): string {
  return JSON.stringify(args, null, 2)
}

export function formatAction(action: PlannedAction, argsJson: string): string {
  const env = action.environment
  const envLines = [
    `所在环境：${TERMINAL_LABEL[env.terminalType] ?? env.terminalType}`,
    env.sshHost ? `远程主机：${env.sshHost}` : '',
    env.cwd ? `当前目录：${env.cwd}` : '',
    env.os ? `本机系统：${env.os}` : '',
  ].filter(Boolean)
  const reasons = action.reasons?.length ? `\n旗鱼命令审计给出的原因：${action.reasons.join('；')}` : ''
  return [
    `工具：${action.toolName}${action.displayName ? `（${action.displayName}）` : ''}`,
    ...envLines,
    `旗鱼命令审计定级：${action.riskLevel}${reasons}`,
    `参数：\n${argsJson}`,
  ].join('\n')
}
