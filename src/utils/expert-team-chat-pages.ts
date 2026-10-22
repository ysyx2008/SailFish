import type { ExpertTeamChatCursor, ExpertTeamChatPage, ExpertTeamMessageView } from '@shared/types'

export type ExpertTeamChatReader = (file: string, cursor: ExpertTeamChatCursor) => Promise<ExpertTeamChatPage | null>

/**
 * 群聊全文已经读进来的那一段：先读末尾一页，往上翻再往前读，有新消息往后补。
 * 读取一次只跑一个，按调用先后排队。
 */
export class ExpertTeamChatPages {
  messages: ExpertTeamMessageView[] = []
  hasEarlier = false
  /** 文件的完整路径 */
  path = ''
  loaded = false
  /** 打开时读不到（文件坏了、通信出错），界面改用派出那一步里的那一小段 */
  failed = false
  loadingEarlier = false
  private start = 0
  private end = 0
  private queue: Promise<unknown> = Promise.resolve()

  constructor(readonly file: string, private readonly reader: ExpertTeamChatReader) {}

  get lastSeq(): number {
    return this.messages[this.messages.length - 1]?.seq ?? 0
  }

  loadLatest(): Promise<void> {
    return this.serial(async () => {
      const page = await this.fetch({})
      this.failed = !page
      if (!page) return
      this.messages = page.messages
      this.start = page.start
      this.end = page.end
      this.hasEarlier = page.hasEarlier
      this.path = page.path
      this.loaded = true
    })
  }

  /** 往前读一页，返回补进来几条；已经在读就不再排一次 */
  loadEarlier(): Promise<number> {
    if (this.loadingEarlier) return Promise.resolve(0)
    this.loadingEarlier = true
    return this.serial(async () => {
      try {
        if (!this.loaded || !this.hasEarlier) return 0
        const page = await this.fetch({ before: this.start })
        if (!page) return 0
        const first = this.messages[0]?.seq ?? Number.POSITIVE_INFINITY
        const older = page.messages.filter(m => m.seq < first)
        this.messages = [...older, ...this.messages]
        this.start = page.start
        this.hasEarlier = page.hasEarlier
        return older.length
      } finally {
        this.loadingEarlier = false
      }
    })
  }

  /** 把文件里新写进来的补到末尾，返回补了几条 */
  loadNewer(): Promise<number> {
    return this.serial(async () => {
      if (!this.loaded) return 0
      let added = 0
      for (;;) {
        const page = await this.fetch({ after: this.end })
        if (!page || page.end <= this.end) break
        const last = this.lastSeq
        const newer = page.messages.filter(m => m.seq > last)
        if (newer.length) {
          this.messages = [...this.messages, ...newer]
          added += newer.length
        }
        this.end = page.end
        if (!page.hasLater) break
      }
      return added
    })
  }

  private async fetch(cursor: ExpertTeamChatCursor): Promise<ExpertTeamChatPage | null> {
    try {
      return await this.reader(this.file, cursor)
    } catch {
      return null
    }
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task)
    this.queue = run.catch(() => undefined)
    return run
  }
}
