/**
 * 说明生成的每日额度。重启之后同一天继续算，不重新发一份。
 */

import * as fs from 'fs'
import * as path from 'path'
import { dayKey } from './card-policy'

interface QuotaFile {
  day: string
  used: number
}

export class CardQuota {
  constructor(private readonly filePath: string) {}

  usedToday(now: Date): number {
    const saved = this.read()
    if (!saved || saved.day !== dayKey(now)) return 0
    return saved.used
  }

  /** 占掉一个名额。额度用完返回 false，不写入。 */
  take(now: Date, dailyLimit: number): boolean {
    const day = dayKey(now)
    const saved = this.read()
    const used = saved && saved.day === day ? saved.used : 0
    if (used >= dailyLimit) return false
    this.write({ day, used: used + 1 })
    return true
  }

  private read(): QuotaFile | null {
    try {
      if (!fs.existsSync(this.filePath)) return null
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as QuotaFile
      if (!raw || typeof raw.day !== 'string' || typeof raw.used !== 'number') return null
      return raw
    } catch {
      return null
    }
  }

  private write(data: QuotaFile): void {
    const dir = path.dirname(this.filePath)
    fs.mkdirSync(dir, { recursive: true })
    const temp = `${this.filePath}.tmp`
    fs.writeFileSync(temp, JSON.stringify(data), 'utf-8')
    fs.renameSync(temp, this.filePath)
  }
}
