/**
 * 远程命令的留痕：完整输出一条一个文件，另有一份一行一条的操作记录。
 * 都放在这一轮伙计的落盘目录下，写盘一律异步，不挡主线程。
 */
import * as fs from 'fs'
import * as path from 'path'
import { createLogger } from '../../../utils/logger'

const log = createLogger('RemoteOps')

export interface RemoteOpEntry {
  /** 毫秒时间戳 */
  at: number
  worker: string
  hostId: string
  hostName: string
  command: string
  /** 正常结束的退出码；超时、连不上、被中止时为 null */
  exitCode: number | null
  /** 没有正常结束时的原因 */
  failure?: string
  durationMs: number
  /** 完整输出文件；没留下来就没有 */
  outputFile?: string
}

export const REMOTE_OPS_FILE = 'remote-ops.jsonl'

export class RemoteOpRecorder {
  /** 追加按先后串起来，避免两条同时写交错 */
  private tail: Promise<void> = Promise.resolve()

  constructor(private readonly dir: string) {}

  get opsPath(): string {
    return path.join(this.dir, REMOTE_OPS_FILE)
  }

  /** 存完整输出。写不进去返回 undefined，不影响命令本身 */
  async saveOutput(worker: string, seq: number, output: string): Promise<string | undefined> {
    const dir = path.join(this.dir, 'remote', safeSegment(worker))
    const file = path.join(dir, `${seq}.txt`)
    try {
      await fs.promises.mkdir(dir, { recursive: true })
      await fs.promises.writeFile(file, output, 'utf-8')
      return file
    } catch (err) {
      log.warn(`Remote output write failed (${file}): ${err}`)
      return undefined
    }
  }

  record(entry: RemoteOpEntry): Promise<void> {
    const line = JSON.stringify(entry) + '\n'
    this.tail = this.tail.then(async () => {
      try {
        await fs.promises.mkdir(this.dir, { recursive: true })
        await fs.promises.appendFile(this.opsPath, line, 'utf-8')
      } catch (err) {
        log.warn(`Remote ops log write failed: ${err}`)
      }
    })
    return this.tail
  }

  /** 等已经排上的写盘写完（测试和收尾用） */
  flush(): Promise<void> {
    return this.tail
  }
}

function safeSegment(name: string): string {
  return name.replace(/[^\p{L}\p{N}._-]+/gu, '-').slice(0, 64) || 'worker'
}
