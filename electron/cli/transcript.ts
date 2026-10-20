/**
 * 命令行上给人看的一轮对话。
 * 正文是秘书说的话；做事留一行；思考用的网页标记不出现。
 */

export interface TranscriptStep {
  id: string
  type: string
  content?: string
  isStreaming?: boolean
  toolName?: string
  toolArgs?: Record<string, unknown>
  toolResult?: string
  success?: boolean
}

export interface ConfirmationViewInput {
  toolName: string
  toolArgs?: Record<string, unknown>
  displayName?: string
  riskLabel?: string
  reasons?: string[]
  reviewerNote?: string
}

export interface CliTranscriptOptions {
  verbose?: boolean
  /** 能用回车覆盖当前行。管道里关掉。 */
  tty?: boolean
  color?: boolean
  write?: (chunk: string) => void
  columns?: number
}

const ACTION_FIELDS = ['command', 'cmd', 'path', 'file', 'url', 'query', 'message'] as const

/** 去掉包住思考过程的 details 块。流式过程中块还没闭合时，正文视为还没开始。 */
export function visibleReply(raw: string): string {
  if (!raw) return ''
  let text = raw.replace(/<details\b[^>]*>[\s\S]*?<\/details>/gi, '')
  text = text.replace(/^\s*<details\b[^>]*>[\s\S]*$/i, '')
  return text.replace(/^\s+/, '')
}

/** 确认时给人看的几行：做哪件事、为什么要问，不倒参数原文。 */
export function confirmationLines(input: ConfirmationViewInput): string[] {
  const risk = input.riskLabel?.trim()
  const headline = risk ? `要你点头才能继续（${risk}）` : '要你点头才能继续'
  const title = (input.displayName || input.toolName || '这一步').trim()
  const lines = [headline, `  ${title}`]
  const body = actionBody(input.toolArgs)
  if (body && body !== title) {
    for (const line of body.split('\n')) lines.push(`  ${line}`)
  }
  if (input.reasons?.length) lines.push(`  ${input.reasons.join('；')}`)
  if (input.reviewerNote) lines.push(`  替你看过：${input.reviewerNote}`)
  return lines
}

function actionBody(args?: Record<string, unknown>): string {
  if (!args) return ''
  for (const key of ACTION_FIELDS) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) return clip(value.trim(), 500)
  }
  for (const value of Object.values(args)) {
    if (typeof value === 'string' && value.trim()) return clip(value.trim(), 500)
  }
  return ''
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max).trimEnd() + '…'
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export class CliTranscript {
  private readonly verbose: boolean
  private readonly tty: boolean
  private readonly color: boolean
  private readonly writeChunk: (chunk: string) => void
  private readonly columns: number

  private activity = false
  private replyText = ''
  /** 刚用「联络说」打过的正文，紧跟着的同一句不再打第二遍 */
  private lastSpoken = ''
  private lastKind: 'none' | 'text' | 'tool' = 'none'
  private skipResult = false
  private readonly committed = new Map<string, string>()
  private readonly settled = new Set<string>()
  private readonly failed = new Set<string>()

  constructor(options: CliTranscriptOptions = {}) {
    this.verbose = options.verbose === true
    this.tty = options.tty !== false
    this.color = options.color === true
    this.writeChunk = options.write ?? ((chunk) => process.stdout.write(chunk))
    this.columns = options.columns && options.columns > 20 ? options.columns : 80
  }

  push(step: TranscriptStep): void {
    if (!step?.id) return
    if (step.type === 'final_result' || step.type === 'user_task' || step.type === 'proactive_notice') return

    if (step.type === 'message' || step.type === 'thinking') {
      this.onMessage(step)
      return
    }
    if (step.type === 'asking') {
      this.onAsking(step)
      return
    }
    if (step.type === 'task_receipt') {
      this.block('任务回来了', step.content || '')
      return
    }
    if (step.type === 'error') {
      this.fail(step.content || '出错了')
      return
    }
    if (step.type === 'tool_call') {
      this.onToolCall(step)
      return
    }
    if (step.type === 'tool_result') {
      this.onToolResult(step)
      return
    }
    if (step.type === 'auto_review') {
      const line = oneLine(step.content || '替你看过这一步')
      if (line) this.commitLine(this.dim(line))
      return
    }
    const line = oneLine(step.content || '')
    if (line && !this.settled.has(step.id)) {
      this.settled.add(step.id)
      this.commitLine(this.dim(`· ${this.fit(line)}`))
    }
  }

  /** 这一轮被打断。紧跟着的结束语不再重复打。 */
  interrupted(): void {
    if (this.skipResult) return
    this.skipResult = true
    this.clearActivity()
    this.writeChunk('已停下。\n')
  }

  finish(result: string): void {
    this.lastSpoken = ''
    if (this.skipResult) {
      this.skipResult = false
      this.clearActivity()
      return
    }
    this.clearActivity()
    const visible = visibleReply(result || '')
    const soFar = this.replyText.trim()
    if (!visible) return
    if (!soFar) {
      this.writeChunk(visible.endsWith('\n') ? visible : visible + '\n')
      this.replyText += visible
      this.lastKind = 'text'
      return
    }
    if (visible === soFar || soFar.endsWith(visible)) return
    if (visible.startsWith(soFar)) {
      const rest = visible.slice(soFar.length).replace(/^\s+/, '')
      if (!rest) return
      if (!this.replyText.endsWith('\n')) this.writeChunk('\n')
      this.writeChunk(rest.endsWith('\n') ? rest : rest + '\n')
      this.replyText += rest
      return
    }
    if (!this.replyText.endsWith('\n')) this.writeChunk('\n')
    this.writeChunk(visible.endsWith('\n') ? visible : visible + '\n')
    this.replyText += visible
  }

  fail(message: string): void {
    this.clearActivity()
    const text = oneLine(message) || '出错了'
    this.writeChunk(`出了问题：${text}\n`)
  }

  hint(text: string): void {
    this.clearActivity()
    this.writeChunk(this.dim(text) + '\n')
  }

  clearActivity(): void {
    if (!this.activity) return
    this.writeChunk('\r\x1b[K')
    this.activity = false
  }

  private onMessage(step: TranscriptStep): void {
    if (this.settled.has(step.id)) return
    if (step.type === 'thinking') {
      if (step.isStreaming) this.showActivity('思考中…')
      else this.clearActivity()
      return
    }
    const visible = visibleReply(step.content || '')
    if (this.lastSpoken && (visible === this.lastSpoken || (visible !== '' && this.lastSpoken.startsWith(visible)))) {
      if (!step.isStreaming) {
        this.settled.add(step.id)
        this.lastSpoken = ''
      }
      this.clearActivity()
      return
    }
    const prev = this.committed.get(step.id) ?? ''
    if (step.isStreaming && !visible) {
      this.showActivity('思考中…')
      return
    }
    if (visible.startsWith(prev)) {
      const delta = visible.slice(prev.length)
      if (delta) {
        if (!prev && this.lastKind === 'tool') this.writeChunk('\n')
        else this.clearActivity()
        this.writeChunk(delta)
        this.committed.set(step.id, visible)
        this.replyText += delta
        this.lastKind = 'text'
      } else if (!step.isStreaming) {
        this.clearActivity()
      }
    } else if (visible) {
      this.clearActivity()
      this.writeChunk('\n' + visible)
      this.committed.set(step.id, visible)
      this.replyText += '\n' + visible
      this.lastKind = 'text'
    }
    if (!step.isStreaming) {
      if (visible && !this.replyText.endsWith('\n')) {
        this.writeChunk('\n')
        this.replyText += '\n'
      }
      this.settled.add(step.id)
      this.clearActivity()
    }
  }

  private onAsking(step: TranscriptStep): void {
    if (this.settled.has(step.id)) return
    this.settled.add(step.id)
    const question = (step.content || '').trim()
    if (question && !this.replyText.includes(question)) {
      if (this.lastKind === 'text' && !this.replyText.endsWith('\n')) this.writeChunk('\n')
      this.commitLine(question)
    } else {
      this.clearActivity()
    }
    const options = step.toolArgs?.options
    if (Array.isArray(options)) {
      options.forEach((opt, i) => {
        if (typeof opt === 'string' && opt.trim()) this.commitLine(`  ${i + 1}. ${opt.trim()}`)
      })
    }
  }

  private onToolCall(step: TranscriptStep): void {
    if (step.toolName === 'talk_to_user') {
      if (this.settled.has(step.id)) return
      this.settled.add(step.id)
      const message = stringArg(step.toolArgs, 'message') || step.content || ''
      this.block('联络说', message)
      return
    }
    if (step.toolName === 'manage_tasks' && step.toolArgs?.action === 'await') {
      if (this.settled.has(step.id)) return
      this.settled.add(step.id)
      this.commitLine(this.dim('· 在等派出的任务回来'))
      return
    }
    const label = this.fit(oneLine(step.content || step.toolName || '进行中'))
    if (step.isStreaming) {
      this.showActivity(label)
      return
    }
    if (!this.settled.has(step.id)) {
      this.settled.add(step.id)
      this.commitLine(this.dim(`· ${label}`))
      this.lastKind = 'tool'
    }
    if (step.success === false && !this.failed.has(step.id)) {
      this.failed.add(step.id)
      this.commitLine(this.dim('  没有做成'))
      if (this.verbose) this.writeVerbose(step.toolResult || step.content || '')
    }
  }

  private onToolResult(step: TranscriptStep): void {
    if (!this.verbose || this.settled.has(step.id + ':result')) return
    this.settled.add(step.id + ':result')
    this.writeVerbose(step.toolResult || step.content || '')
  }

  private block(title: string, body: string): void {
    this.clearActivity()
    const text = body.trim()
    if (!text) return
    if (this.replyText.trim().endsWith(text)) {
      this.lastSpoken = text
      return
    }
    if (this.lastKind !== 'none') this.writeChunk('\n')
    this.writeChunk(`${title}\n${text}\n`)
    this.replyText += text + '\n'
    this.lastSpoken = text
    this.lastKind = 'text'
  }

  private writeVerbose(text: string): void {
    const clipped = clip(text.trim(), 800)
    if (!clipped) return
    for (const line of clipped.split('\n').slice(0, 20)) {
      this.commitLine(this.dim(`  ${line}`))
    }
  }

  private showActivity(text: string): void {
    if (!this.tty) return
    const line = this.dim(`· ${this.fit(oneLine(text))}`)
    this.writeChunk('\r\x1b[K' + line)
    this.activity = true
  }

  private commitLine(text: string): void {
    this.clearActivity()
    this.writeChunk(text + '\n')
  }

  private fit(text: string): string {
    const max = Math.max(20, this.columns - 4)
    let width = 0
    let end = 0
    for (const ch of text) {
      const w = (ch.codePointAt(0) ?? 0) >= 0x1100 ? 2 : 1
      if (width + w > max) return text.slice(0, end) + '…'
      width += w
      end += ch.length
    }
    return text
  }

  private dim(text: string): string {
    if (!this.color) return text
    return `\x1b[2m${text}\x1b[0m`
  }
}

function stringArg(args: Record<string, unknown> | undefined, key: string): string {
  const value = args?.[key]
  return typeof value === 'string' ? value.trim() : ''
}
