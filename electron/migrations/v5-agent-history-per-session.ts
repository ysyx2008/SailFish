/**
 * Migration v5: Agent 历史从「按日 JSON 数组」迁移为「按会话单文件」。
 *
 * - 旧：history/agent/YYYY-MM-DD.json（数组）
 * - 新：history/agent/YYYY-MM-DD/{sessionId}.json（单条记录）
 * - 迁移成功后旧文件改名为 YYYY-MM-DD.json.migrated，保留 30 天
 * - 需要迁移时一律展示进度窗（startup phase，app.whenReady 后、主窗口前）
 */

import * as fs from 'fs'
import * as path from 'path'
import type { BrowserWindow } from 'electron'
import { createLogger } from '../utils/logger'
import {
  createMigrationProgressWindow,
  setMigrationProgress,
} from '../utils/migration-progress'
import {
  AGENT_MIGRATED_SUFFIX,
  cleanupExpiredMigratedBackups,
  listLegacyAgentDayFiles,
  readLegacyAgentDayRecords,
  writeAgentRecordFile,
} from '../services/history/agent-storage'
import type { Migration } from './types'

const log = createLogger('Migration:v5')

const PROGRESS_OPTS = {
  titleZh: '正在升级历史记录格式…',
  titleEn: 'Upgrading conversation history…',
  subtitleZh: '请勿关闭应用',
  subtitleEn: 'Please do not close the app',
}

export async function migrateLegacyAgentDayFiles(
  userDataPath: string,
  onProgress?: (pct: number, label: string) => Promise<void>
): Promise<{ migratedDays: number; migratedRecords: number; errors: string[] }> {
  const agentDir = path.join(userDataPath, 'history', 'agent')
  fs.mkdirSync(agentDir, { recursive: true })

  cleanupExpiredMigratedBackups(agentDir)

  const legacyFiles = listLegacyAgentDayFiles(agentDir)
  if (legacyFiles.length === 0) {
    return { migratedDays: 0, migratedRecords: 0, errors: [] }
  }

  let migratedDays = 0
  let migratedRecords = 0
  const errors: string[] = []

  for (let i = 0; i < legacyFiles.length; i++) {
    const fileName = legacyFiles[i]
    const dateStr = fileName.replace('.json', '')
    const legacyPath = path.join(agentDir, fileName)

    const records = readLegacyAgentDayRecords(legacyPath, (corruptPath, err) => {
      const msg = `解析失败 ${fileName}: ${err instanceof Error ? err.message : String(err)}`
      errors.push(msg)
      log.error(msg, corruptPath ? `已隔离: ${corruptPath}` : '')
    })

    if (records.length === 0 && errors.some(e => e.includes(fileName))) {
      if (onProgress) {
        const pct = Math.min(100, Math.floor(((i + 1) / legacyFiles.length) * 100))
        await onProgress(pct, fileName)
      }
      continue
    }

    try {
      for (const record of records) {
        writeAgentRecordFile(agentDir, record)
        migratedRecords++
      }

      const migratedPath = path.join(agentDir, `${dateStr}${AGENT_MIGRATED_SUFFIX}`)
      if (fs.existsSync(legacyPath)) {
        fs.renameSync(legacyPath, migratedPath)
      }
      migratedDays++
    } catch (e) {
      const msg = `写出失败 ${fileName}: ${e instanceof Error ? e.message : String(e)}`
      errors.push(msg)
      log.error(msg, e)
    }

    if (onProgress) {
      const pct = Math.min(100, Math.floor(((i + 1) / legacyFiles.length) * 100))
      await onProgress(pct, fileName)
      await new Promise<void>(resolve => setImmediate(resolve))
    }
  }

  return { migratedDays, migratedRecords, errors }
}

export const migrationV5: Migration = {
  version: 5,
  name: 'agent-history-per-session',
  phase: 'startup',

  async migrate({ userDataPath }) {
    const agentDir = path.join(userDataPath, 'history', 'agent')
    cleanupExpiredMigratedBackups(agentDir)

    const legacyFiles = listLegacyAgentDayFiles(agentDir)
    if (legacyFiles.length === 0) {
      log.info('无旧格式 Agent 日文件，跳过拆分迁移')
      return
    }

    log.info(`发现 ${legacyFiles.length} 个旧格式 Agent 日文件，开始拆分迁移`)
    let progressWin: BrowserWindow | null = await createMigrationProgressWindow(PROGRESS_OPTS)

    try {
      const result = await migrateLegacyAgentDayFiles(userDataPath, async (pct, label) => {
        await setMigrationProgress(progressWin, pct, label)
      })

      await setMigrationProgress(progressWin, 100, '')
      log.info(
        `Agent 历史格式迁移完成: ${result.migratedDays} 天, ${result.migratedRecords} 条` +
        (result.errors.length ? `, ${result.errors.length} 个错误` : '')
      )

      if (result.errors.length > 0) {
        log.warn('迁移部分失败:', result.errors.join('; '))
      }
    } finally {
      if (progressWin && !progressWin.isDestroyed()) {
        progressWin.destroy()
        progressWin = null
      }
    }

    // 索引重建由 main.ts 在 startup migration 完成后对全局 historyService 执行
  },
}
