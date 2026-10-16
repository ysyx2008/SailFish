/**
 * 微信 IM 过程消息合并缓冲：累积工具进度 / 中间正文，定时或任务结束时
 * 合并为一条 digest 发出，降低个人号出站频率、缓解 errcode=-2 风控。
 *
 * 不缓冲：最终结果、提问、确认、投递失败、任务级错误（由 IMService 直发）。
 * 一开始等用户回复，节流就停：后面不会再有新消息可以合并，已经攒下的马上发出，
 * 等待期间新来的也不再定时攒。等用户回完再恢复节流。
 *
 * 首条正文即时发出：本会话（一次 beginOutboundSession）内第一条 body
 * 立刻 flush，让用户在发消息后尽快看到 AI 在工作；后续 body / 工具进度仍走节流。
 *
 * 正文边界感知（防腰斩）：
 * - body 入队时先 flush 已积攒的工具进度（让 🔧/❌ 先走），再把 body 单独入队
 * - body 不参与 maxLines 计数，避免长正文被工具通知顶出去
 * - 非首条 body 入队后 scheduleFlush，行为是"合并优先、定时兜底"：
 *   ① 若 25s 内来了工具通知 push（'all' 模式）且 timer 未 fire，body 与工具通知并入同一 digest
 *   ② 若 25s 内没来工具通知（'messages' 模式或多轮间隔长），timer fire 把 body 切出
 *   ③ 任务结束，或开始等用户回复时，马上 flush。等回复期间不再定时攒
 */

/** 距首条入队后多久自动 flush（毫秒） */
export const WECHAT_PROGRESS_FLUSH_INTERVAL_MS = 25_000

/** 单条 digest 最多保留的工具进度行数，超出则立即 flush 并继续累积 */
export const WECHAT_PROGRESS_MAX_LINES = 12

export type WechatProgressBufferOptions = {
  flushIntervalMs?: number
  maxLines?: number
}

type Entry =
  | { kind: 'tool'; text: string }
  | { kind: 'body'; text: string }

export function formatWechatProgressDigest(entries: readonly Entry[]): string {
  if (entries.length === 0) return ''
  return entries
    .map((entry) => (entry.kind === 'body' ? entry.text : `· ${entry.text}`))
    .join('\n')
}

export class WechatProgressBuffer {
  private readonly flushIntervalMs: number
  private readonly maxLines: number

  private entries: Entry[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private disposed = false
  private flushChain: Promise<void> = Promise.resolve()
  /** 本会话是否已发出过至少一条正文（首条即时，后续节流） */
  private firstBodySent = false
  /** 正在等用户回复：不会再有后续消息可合并，不再定时攒 */
  private waitingForUser = false

  constructor(
    private readonly send: (text: string) => Promise<void>,
    options: WechatProgressBufferOptions,
  ) {
    this.flushIntervalMs = options.flushIntervalMs ?? WECHAT_PROGRESS_FLUSH_INTERVAL_MS
    this.maxLines = options.maxLines ?? WECHAT_PROGRESS_MAX_LINES
  }

  /**
   * 入队一行工具进度文本；去重与上一条完全相同的连续行。
   * 若 buffer 末尾已是 body，则该 body 会并入本条 digest（不先 flush），
   * 让"正文 → 工具通知"自然合并成一条发出。
   */
  push(line: string): void {
    if (this.disposed) return
    const trimmed = line.trim()
    if (!trimmed) return
    const last = this.entries[this.entries.length - 1]
    if (last?.kind === 'tool' && last.text === trimmed) return

    this.entries.push({ kind: 'tool', text: trimmed })
    if (this.waitingForUser || this.countTools() >= this.maxLines) {
      void this.flush().catch(() => undefined)
      return
    }
    this.scheduleFlush()
  }

  /**
   * 入队一段正文（AI 写给用户的消息内容）。
   * 先 flush 当前 buffer 里已积攒的工具进度（让它们先走），再把 body 单独入队。
   * 本会话首条 body 立即 flush，缩短用户等待；后续 body 走 scheduleFlush：
   * - 若 25s 内来了工具通知 push（'all' 模式），且 timer 尚未 fire，body 与工具通知并入同一 digest
   * - 若 25s 内没来工具通知（'messages' 模式或多轮间隔长），timer fire 把 body 切出，避免长任务正文堆积
   * body 不参与 maxLines 计数，避免长正文被工具通知顶出去。
   */
  pushBody(text: string): void {
    if (this.disposed) return
    const trimmed = text.trim()
    if (!trimmed) return
    // 先把已积攒的工具进度 flush 出去，避免 body 与旧工具进度混在一条 digest 里。
    // flush() 的同步部分（取 entries、算 text、清空 entries）立即完成，异步发送在 Promise 链里；
    // 因此 body 的 push 发生在 entries 已清空之后，不会混入工具进度那条 digest。
    if (this.entries.some((e) => e.kind === 'tool')) {
      void this.flush().catch(() => undefined)
    }
    this.entries.push({ kind: 'body', text: trimmed })
    if (this.waitingForUser || !this.firstBodySent) {
      this.firstBodySent = true
      void this.flush().catch(() => undefined)
      return
    }
    this.scheduleFlush()
  }

  private countTools(): number {
    let n = 0
    for (const e of this.entries) if (e.kind === 'tool') n++
    return n
  }

  private scheduleFlush(): void {
    if (this.disposed || this.timer != null) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush().catch(() => undefined)
    }, this.flushIntervalMs)
  }

  private clearTimer(): void {
    if (this.timer != null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  /** 开始等用户回复：后面不会再来新消息，攒着的马上发，之后也不再定时攒。 */
  beginUserWait(): void {
    this.waitingForUser = true
    void this.flush().catch(() => undefined)
  }

  /** 用户已经回复，过程消息恢复节流。 */
  endUserWait(): void {
    this.waitingForUser = false
  }

  /** 立即发送当前缓冲（若无内容则 no-op）。entries 清空是同步的，可 fire-and-forget。 */
  flush(): Promise<void> {
    this.clearTimer()
    if (this.disposed || this.entries.length === 0) {
      return this.flushChain
    }

    const text = formatWechatProgressDigest(this.entries)
    this.entries = []

    // 立刻开始发送，让紧跟着的提问排在这条后面，而不是再等一轮定时器。
    let started: Promise<void>
    try {
      started = this.send(text)
    } catch {
      started = Promise.resolve()
    }
    const sendPromise = Promise.resolve(started).catch(() => {
      // 出站失败由 send 路径自己上报；缓冲必须继续排空，不能把链卡成拒绝。
    })
    this.flushChain = this.flushChain.then(() => sendPromise, () => sendPromise)
    return this.flushChain
  }

  /** 任务结束：取消定时器并 flush 剩余内容 */
  async dispose(): Promise<void> {
    this.clearTimer()
    await this.flush()
    this.disposed = true
    await this.flushChain
  }
}
