/**
 * 跟着会话走的附属数据目录：`<根>/<日期>/<会话号>/…`，日期是会话开始那天。
 *
 * 管三件事：会话删了跟着删；按天清理时跟会话记录一起过期；会话已经不在的清掉。
 * 里面放什么、怎么读写由使用方定（专家团群聊全文、伙计的对话记录）。
 */
import * as fs from 'fs'
import * as path from 'path'

/** 会话已不在的目录，最近这么久里还写过的先不删（正在跑的会话可能还没落盘） */
const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000

const SAFE_SEGMENT = /^[\p{L}\p{N}_-][\p{L}\p{N}._-]*$/u
const DATE_DIR = /^\d{4}-\d{2}-\d{2}$/

/** 会话号、名字这类要拼进路径的片段能不能直接用 */
export function isSafePathSegment(value: string): boolean {
  return typeof value === 'string' && SAFE_SEGMENT.test(value)
}

export class SessionDateTree {
  constructor(readonly root: string) {}

  /** 某天某会话的目录；会话号不能当路径用时返回 undefined */
  sessionDir(dateStr: string, sessionId: string): string | undefined {
    if (!DATE_DIR.test(dateStr) || !isSafePathSegment(sessionId)) return undefined
    return path.join(this.root, dateStr, sessionId)
  }

  /** 这个会话在任何一天下面的目录（会话开始那天只有一个，多天是写错位置留下的） */
  findSessionDirs(sessionId: string): string[] {
    if (!isSafePathSegment(sessionId)) return []
    const found: string[] = []
    for (const date of this.dateDirs()) {
      const dir = path.join(this.root, date, sessionId)
      if (fs.existsSync(dir)) found.push(dir)
    }
    return found
  }

  deleteSession(sessionId: string): void {
    if (!isSafePathSegment(sessionId)) return
    for (const date of this.dateDirs()) {
      const dir = path.join(this.root, date, sessionId)
      if (!fs.existsSync(dir)) continue
      fs.rmSync(dir, { recursive: true, force: true })
      removeIfEmpty(path.join(this.root, date))
    }
  }

  /** 删掉日期早于 cutoff（YYYY-MM-DD）的 */
  deleteBefore(cutoff: string): void {
    for (const date of this.dateDirs()) {
      if (date < cutoff) fs.rmSync(path.join(this.root, date), { recursive: true, force: true })
    }
  }

  /**
   * 删掉会话已经不在的目录。会话可能很早开、近几天才有附属数据，记录先按天清掉，这里要跟上。
   * 最近改过的不动：正在跑的会话可能还没落盘。
   */
  deleteOrphans(liveSessionIds: ReadonlySet<string>, now = Date.now()): void {
    for (const date of this.dateDirs()) {
      const dateDir = path.join(this.root, date)
      let sessions: string[]
      try {
        sessions = fs.readdirSync(dateDir)
      } catch {
        continue
      }
      for (const sessionId of sessions) {
        if (liveSessionIds.has(sessionId)) continue
        const dir = path.join(dateDir, sessionId)
        try {
          if (now - fs.statSync(dir).mtimeMs < ORPHAN_GRACE_MS) continue
          fs.rmSync(dir, { recursive: true, force: true })
        } catch {
          // 并发删掉了
        }
      }
      removeIfEmpty(dateDir)
    }
  }

  deleteAll(): void {
    fs.rmSync(this.root, { recursive: true, force: true })
  }

  dateDirs(): string[] {
    try {
      return fs.readdirSync(this.root, { withFileTypes: true })
        .filter(e => e.isDirectory() && DATE_DIR.test(e.name))
        .map(e => e.name)
    } catch {
      return []
    }
  }
}

function removeIfEmpty(dir: string): void {
  try {
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir)
  } catch {
    // 目录已经不在了
  }
}
