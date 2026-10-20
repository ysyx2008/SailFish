/**
 * 自己开着的终端里，把同一屏支起来：底下输入，上面是这场对话。
 */

import path from 'path'
import { StringDecoder } from 'string_decoder'
import { composeLine, pathExists } from './compose'
import {
  ENTER_SCREEN,
  LEAVE_SCREEN,
  emptyComposer,
  feedComposer,
  flattenTerminalText,
  renderFrame,
  type Composer,
} from './tui-screen'

export interface TuiSessionOptions {
  cwd: string
  title: string
  stdin?: NodeJS.ReadStream
  stdout?: NodeJS.WriteStream
}

export interface TuiReadOptions {
  hidden?: boolean
  timeoutMs?: number
  /** 底部那一行平常的输入。提问和确认不是这个。 */
  composer?: boolean
}

interface Waiter {
  resolve: (value: string | null) => void
  composer: boolean
  restore: Composer | null
}

export class TuiSession {
  private readonly cwd: string
  private readonly title: string
  private readonly stdin: NodeJS.ReadStream
  private readonly stdout: NodeJS.WriteStream
  private readonly decoder = new StringDecoder('utf8')

  private raw = ''
  private composer: Composer = emptyComposer()
  private prompt = '› '
  private hidden = false
  private busy = false
  private aside = ''
  private scroll = 0
  private waiter: Waiter | null = null
  private timer: NodeJS.Timeout | undefined
  private leaveCode: number | null = null
  private left = false
  private onData: ((chunk: Buffer | string) => void) | null = null
  private onResize: (() => void) | null = null

  private bareSubmit: ((text: string) => void) | null = null
  private onInterrupt: (() => void) | null = null

  constructor(options: TuiSessionOptions) {
    this.cwd = options.cwd
    this.title = options.title
    this.stdin = options.stdin ?? process.stdin
    this.stdout = options.stdout ?? process.stdout
  }

  get exitCode(): number {
    return this.leaveCode ?? 0
  }

  get leaving(): boolean {
    return this.leaveCode !== null
  }

  write(chunk: string): void {
    if (!chunk) return
    this.raw += chunk
    this.paint()
  }

  note(line: string): void {
    this.raw += (line.endsWith('\n') ? line : line + '\n')
    this.paint()
  }

  setBusy(busy: boolean): void {
    this.busy = busy
    this.paint()
  }

  setAside(text: string): void {
    this.aside = text
    this.paint()
  }

  setOnBareSubmit(fn: (text: string) => void): void {
    this.bareSubmit = fn
  }

  setOnInterrupt(fn: () => void): void {
    this.onInterrupt = fn
  }

  readLine(prompt: string, opts: TuiReadOptions = {}): Promise<string | null> {
    if (this.leaving) return Promise.resolve(null)
    this.prompt = prompt
    this.hidden = opts.hidden === true
    const restore = opts.composer ? null : { ...this.composer }
    if (!opts.composer) this.composer = emptyComposer()
    this.paint()
    return new Promise(resolve => {
      this.waiter = { resolve, composer: opts.composer === true, restore }
      if (opts.timeoutMs && opts.timeoutMs > 0) {
        this.timer = setTimeout(() => {
          if (this.waiter) this.finishWait(null)
        }, opts.timeoutMs)
      }
    })
  }

  cancelRead(): void {
    if (this.waiter) this.finishWait(null)
  }

  requestLeave(code: number): void {
    if (this.leaveCode === null) this.leaveCode = code
    if (this.waiter) this.finishWait(null)
  }

  handleInterrupt(): void {
    if (this.waiter && !this.waiter.composer) {
      this.finishWait(null)
      this.onInterrupt?.()
      return
    }
    if (this.busy) {
      this.onInterrupt?.()
      return
    }
    this.requestLeave(130)
  }

  async run<T>(body: () => Promise<T>): Promise<T> {
    this.enter()
    this.paint()
    this.onData = (chunk) => {
      const text = typeof chunk === 'string' ? chunk : this.decoder.write(chunk)
      if (text) this.feed(text)
    }
    this.stdin.on('data', this.onData)
    this.stdin.resume?.()
    this.onResize = () => this.paint()
    this.stdout.on?.('resize', this.onResize)
    try {
      return await body()
    } finally {
      if (this.onData) this.stdin.removeListener('data', this.onData)
      if (this.onResize) this.stdout.removeListener?.('resize', this.onResize)
      this.onData = null
      this.onResize = null
      const raw = this.stdin as NodeJS.ReadStream & { setRawMode?: (mode: boolean) => void }
      if (raw.isTTY && raw.setRawMode) raw.setRawMode(false)
      this.leave()
    }
  }

  private feed(text: string): void {
    const fed = feedComposer(this.composer, text)
    this.composer = fed.state
    for (const event of fed.events) {
      if (event.type === 'submit') this.onSubmit(event.text)
      else if (event.type === 'interrupt') this.handleInterrupt()
      else if (event.type === 'exit') this.onEof()
      else if (event.type === 'page') this.page(event.dir)
      else this.paint()
    }
  }

  private onSubmit(text: string): void {
    if (this.waiter) {
      this.scroll = 0
      this.finishWait(text)
      return
    }
    const trimmed = text.trim()
    if (!trimmed) {
      this.paint()
      return
    }
    this.scroll = 0
    this.bareSubmit?.(trimmed)
  }

  private onEof(): void {
    if (this.waiter && !this.waiter.composer) {
      this.finishWait(null)
      return
    }
    if (this.composer.value.length === 0 && !this.busy) this.requestLeave(0)
  }

  private page(dir: -1 | 1): void {
    const rows = Math.max(4, this.stdout.rows || 24)
    const step = Math.max(1, rows - 4)
    this.scroll = dir > 0 ? this.scroll + step : Math.max(0, this.scroll - step)
    this.paint()
  }

  private finishWait(value: string | null): void {
    const waiter = this.waiter
    if (!waiter) return
    this.waiter = null
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    this.hidden = false
    this.prompt = '› '
    if (waiter.restore) this.composer = waiter.restore
    waiter.resolve(value)
    this.paint()
  }

  private enter(): void {
    this.stdout.write(ENTER_SCREEN)
    const raw = this.stdin as NodeJS.ReadStream & { setRawMode?: (mode: boolean) => void }
    if (raw.isTTY && raw.setRawMode) raw.setRawMode(true)
  }

  private leave(): void {
    if (this.left) return
    this.left = true
    this.stdout.write(LEAVE_SCREEN)
    const text = flattenTerminalText(this.raw).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    if (text.trim()) this.stdout.write(text.endsWith('\n') ? text : text + '\n')
  }

  private paint(): void {
    const columns = this.stdout.columns || 80
    const rows = this.stdout.rows || 24
    const body = flattenTerminalText(this.raw)
    const status = this.statusLine()
    this.stdout.write(renderFrame({
      columns,
      rows,
      title: `${this.title}  ${this.cwd}`,
      body,
      status,
      prompt: this.prompt,
      input: this.composer.value,
      cursor: this.composer.cursor,
      scroll: this.scroll,
      hidden: this.hidden,
    }))
  }

  private statusLine(): string {
    const names = this.hidden
      ? []
      : composeLine(this.composer.value, this.cwd, pathExists).paths.map(file => path.basename(file))
    const parts: string[] = []
    if (names.length > 0) parts.push(`附件 ${names.join('、')}`)
    if (this.busy) parts.push('进行中')
    if (this.aside) parts.push(this.aside)
    return parts.join('  ·  ')
  }
}

export function createTuiSession(options: TuiSessionOptions): TuiSession {
  return new TuiSession(options)
}
