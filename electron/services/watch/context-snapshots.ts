/** 关切上下文快照：内容寻址复用，容量有界，执行期间固定引用不被回收。 */
import * as fs from 'fs'
import * as path from 'path'
import { createHash, randomUUID } from 'crypto'
import { getScratchPath } from '../agent/workspace-paths'

interface SnapshotOptions {
  directory?: () => string
  maxBytes?: number
  maxFiles?: number
  maxPending?: number
}

export class WatchContextSnapshots {
  private readonly directory: () => string
  private readonly maxBytes: number
  private readonly maxFiles: number
  private readonly maxPending: number
  private pending = 0
  private readonly pins = new Map<string, number>()
  private queue: Promise<unknown> = Promise.resolve()

  constructor(options: SnapshotOptions = {}) {
    this.directory = options.directory ?? (() => path.join(getScratchPath(), 'watch-context'))
    this.maxBytes = options.maxBytes ?? 128 * 1024 * 1024
    this.maxFiles = options.maxFiles ?? 256
    this.maxPending = options.maxPending ?? 16
  }

  open(): WatchContextLease { return new WatchContextLease(this) }

  async hold(text: string, kind: string, lease: WatchContextLease): Promise<string> {
    if (this.pending >= this.maxPending) throw new Error('关切快照存储繁忙或无响应，本次执行失败')
    this.pending++
    const operation = this.queue.then(async () => {
      if (lease.closed) throw new Error('关切执行已结束，不再准备上下文快照')
      const directory = this.directory()
      await fs.promises.mkdir(directory, { recursive: true })
      const hash = createHash('sha256').update(text).digest('hex')
      const filename = `${kind}-${hash}.txt`
      const filePath = path.join(directory, filename)
      const names = (await fs.promises.readdir(directory)).filter(name => /^watch-(state|events?)-[a-f0-9]{64}\.txt(?:\.[a-f0-9-]{36}\.tmp)?$/.test(name))
      const entries = await Promise.all(names.map(async name => {
        const entryPath = path.join(directory, name)
        const stat = await fs.promises.stat(entryPath)
        return { path: entryPath, size: stat.size, mtime: stat.mtimeMs }
      }))
      const existing = entries.find(entry => entry.path === filePath)
      const intact = existing && createHash('sha256').update(await fs.promises.readFile(filePath)).digest('hex') === hash
      if (!intact) {
        const bytes = Buffer.byteLength(text)
        if (bytes > this.maxBytes) throw new Error('关切上下文快照超出缓存容量，本次执行失败')
        let total = entries.reduce((sum, entry) => sum + entry.size, 0) - (existing?.size ?? 0)
        let count = entries.length - (existing ? 1 : 0)
        for (const entry of entries.sort((a, b) => a.mtime - b.mtime)) {
          if (total + bytes <= this.maxBytes && count < this.maxFiles) break
          if (entry.path === filePath || this.pins.has(entry.path)) continue
          await fs.promises.unlink(entry.path)
          total -= entry.size
          count--
        }
        if (total + bytes > this.maxBytes || count >= this.maxFiles) {
          throw new Error('关切上下文缓存已满，正在执行的快照不能回收；本次执行失败')
        }
        const temporary = `${filePath}.${randomUUID()}.tmp`
        try {
          await fs.promises.writeFile(temporary, text, 'utf8')
          await fs.promises.rename(temporary, filePath)
        } finally {
          await fs.promises.unlink(temporary).catch(() => {})
        }
      }
      if (lease.closed) throw new Error('关切执行已结束，不再交接上下文快照')
      if (!lease.files.has(filePath)) {
        lease.files.add(filePath)
        this.pins.set(filePath, (this.pins.get(filePath) ?? 0) + 1)
      }
      await fs.promises.utimes(filePath, new Date(), new Date())
      return filePath
    }).finally(() => { this.pending-- })
    this.queue = operation.catch(() => {})
    return operation
  }

  release(lease: WatchContextLease): void {
    for (const file of lease.files) {
      const count = this.pins.get(file) ?? 0
      if (count <= 1) this.pins.delete(file)
      else this.pins.set(file, count - 1)
    }
    lease.files.clear()
  }
}

export class WatchContextLease {
  readonly files = new Set<string>()
  closed = false
  constructor(private readonly snapshots: WatchContextSnapshots) {}

  async format(text: string, kind: 'watch-state' | 'watch-event' | 'watch-events'): Promise<string> {
    if (this.closed) throw new Error('关切执行已结束')
    if (text.length <= 4000) return text
    const file = await this.snapshots.hold(text, kind, this)
    return `[完整内容共 ${text.length} 字符，已保存到: ${file}\n当前仅提供读取路径，完整内容可用 read_file 分段读取。快照仅保证本次执行期间可读，跨轮基线应保存到状态或持久文件。]`
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.snapshots.release(this)
  }
}

export const watchContextSnapshots = new WatchContextSnapshots()
