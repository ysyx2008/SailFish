/**
 * 编程技能 - 检查点清理
 * 挨个过所有项目的影子仓库：30 天没用、或项目找不到且 7 天没用的整份删，其余回收 7 天前的检查点。一天最多跑一次。
 */
import * as fs from 'fs'
import * as path from 'path'
import { createLogger } from '../../../../utils/logger'
import { CheckpointStore } from './checkpoint'

const log = createLogger('CodingCheckpoint')

const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000
const STAMP_FILE = '.last-cleanup'

export class CheckpointJanitor {
  constructor(private readonly baseDir: string, private readonly now: () => number = Date.now) {}

  /** 距上次清理不到一天就不跑；跑了返回 true */
  async runIfDue(): Promise<boolean> {
    const last = await this.lastRunAt()
    if (last !== undefined && this.now() - last < CLEANUP_INTERVAL_MS) return false
    await this.run()
    // 跑完再记：中途崩了下次还会再清
    await fs.promises.mkdir(this.baseDir, { recursive: true })
    await fs.promises.writeFile(path.join(this.baseDir, STAMP_FILE), String(this.now()))
    return true
  }

  async run(): Promise<void> {
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(this.baseDir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const store = await CheckpointStore.existing(path.join(this.baseDir, entry.name))
      if (!store) continue
      try {
        const outcome = await store.cleanup(this.now())
        if (outcome !== 'kept') log.info(`checkpoints ${outcome} for ${store.root}`)
      } catch (error) {
        log.warn(`checkpoint cleanup skipped for ${store.root}:`, error)
      }
    }
  }

  private async lastRunAt(): Promise<number | undefined> {
    try {
      const value = Number((await fs.promises.readFile(path.join(this.baseDir, STAMP_FILE), 'utf8')).trim())
      return Number.isFinite(value) && value > 0 ? value : undefined
    } catch {
      return undefined
    }
  }
}
