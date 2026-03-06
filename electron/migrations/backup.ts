/**
 * Pre-migration / Pre-update Backup
 *
 * 在执行数据迁移或安装更新前，自动备份关键用户数据。
 * 备份目录：{userData}/backups/{label}/
 * 保留最近 5 份备份，自动清理旧备份。
 */

import * as fs from 'fs'
import * as path from 'path'
import { createLogger } from '../utils/logger'

const log = createLogger('Backup')

const MAX_BACKUPS = 5

const BACKUP_TARGETS = [
  { src: 'qiyu-terminal-config.json', type: 'file' as const },
  { src: 'qiyu-terminal-watches.json', type: 'file' as const },
  { src: 'qiyu-terminal-scheduler.json', type: 'file' as const },
  { src: 'host-profiles', type: 'dir' as const },
  { src: 'knowledge/documents.json', type: 'file' as const },
  { src: 'knowledge/bm25-index.json', type: 'file' as const },
  { src: 'knowledge/context-docs', type: 'dir' as const },
]

function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath)
    } else {
      fs.copyFileSync(srcPath, destPath)
    }
  }
}

export function createBackup(userDataPath: string, label: string): string | null {
  const backupsDir = path.join(userDataPath, 'backups')
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupDir = path.join(backupsDir, `${label}-${timestamp}`)

  try {
    fs.mkdirSync(backupDir, { recursive: true })

    let backedUp = 0
    for (const target of BACKUP_TARGETS) {
      const srcPath = path.join(userDataPath, target.src)
      const destPath = path.join(backupDir, target.src)

      if (!fs.existsSync(srcPath)) continue

      if (target.type === 'file') {
        fs.mkdirSync(path.dirname(destPath), { recursive: true })
        fs.copyFileSync(srcPath, destPath)
        backedUp++
      } else {
        copyDirSync(srcPath, destPath)
        backedUp++
      }
    }

    if (backedUp === 0) {
      fs.rmSync(backupDir, { recursive: true, force: true })
      log.info(`No data to backup for: ${label}`)
      return null
    }

    log.info(`Backup created: ${backupDir} (${backedUp} items)`)

    pruneOldBackups(backupsDir)

    return backupDir
  } catch (err) {
    log.error(`Backup failed for ${label}:`, err)
    return null
  }
}

function pruneOldBackups(backupsDir: string): void {
  try {
    if (!fs.existsSync(backupsDir)) return

    const entries = fs.readdirSync(backupsDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => ({
        name: e.name,
        path: path.join(backupsDir, e.name),
        mtime: fs.statSync(path.join(backupsDir, e.name)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime)

    for (const old of entries.slice(MAX_BACKUPS)) {
      fs.rmSync(old.path, { recursive: true, force: true })
      log.info(`Pruned old backup: ${old.name}`)
    }
  } catch (err) {
    log.warn('Failed to prune old backups:', err)
  }
}
