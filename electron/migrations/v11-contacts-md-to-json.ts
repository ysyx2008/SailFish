/**
 * Migration v11: 旧版 CONTACTS.md → 结构化联系人迁移的确定性半程。
 *
 * - 若存在 agent-workspace/CONTACTS.md 且 CONTACTS.json 尚无有效条目：备份为 CONTACTS.md.bak，并写入 pending 标记
 * - 真正读懂 md、调用 contact_add 由启动后的 deferred Agent 任务完成（不在这里解析 Markdown）
 *
 * 幂等：标记已是 pending / done 时安全重入。通讯录非空不等于旧笔记迁完，只认标记。
 */
import * as fs from 'fs'
import * as path from 'path'
import { createLogger } from '../utils/logger'
import type { Migration } from './types'
import {
  getContactMigrationMarkerPath,
  LEGACY_CONTACTS_MD,
  readContactMigrationMarker,
  writeContactMigrationMarker,
} from '../services/agent/skills/contact/migration-marker'

const log = createLogger('Migration:v11')

export function prepareContactsMdMigration(userDataPath: string): {
  status: 'skipped' | 'pending' | 'already_pending' | 'already_done'
  reason?: string
} {
  const workspace = path.join(userDataPath, 'agent-workspace')
  const mdPath = path.join(workspace, LEGACY_CONTACTS_MD)
  const bakPath = path.join(workspace, `${LEGACY_CONTACTS_MD}.bak`)
  const markerPath = getContactMigrationMarkerPath(userDataPath)

  if (!fs.existsSync(mdPath)) {
    return { status: 'skipped', reason: 'no CONTACTS.md' }
  }

  let mdContent = ''
  try {
    mdContent = fs.readFileSync(mdPath, 'utf-8').trim()
  } catch (e) {
    log.warn('Failed to read CONTACTS.md:', e)
    return { status: 'skipped', reason: 'unreadable CONTACTS.md' }
  }
  if (!mdContent) {
    return { status: 'skipped', reason: 'empty CONTACTS.md' }
  }

  const existing = readContactMigrationMarker(markerPath)
  if (existing?.status === 'done') {
    return { status: 'already_done' }
  }
  if (existing?.status === 'pending') {
    ensureBackup(mdPath, bakPath)
    return { status: 'already_pending' }
  }

  fs.mkdirSync(workspace, { recursive: true })
  ensureBackup(mdPath, bakPath)
  writeContactMigrationMarker(markerPath, {
    version: 1,
    status: 'pending',
    createdAt: Date.now(),
    bakPath: path.basename(bakPath),
  })

  log.info('CONTACTS.md migration prepared (pending Agent migrate); bak=%s', bakPath)
  return { status: 'pending' }
}

function ensureBackup(mdPath: string, bakPath: string): void {
  if (fs.existsSync(bakPath)) return
  fs.copyFileSync(mdPath, bakPath)
}

export const migrationV11: Migration = {
  version: 11,
  name: 'contacts-md-to-json-prepare',
  phase: 'startup',
  migrate: async (context) => {
    const result = prepareContactsMdMigration(context.userDataPath)
    log.info('v11 contacts-md prepare: %s%s', result.status, result.reason ? ` (${result.reason})` : '')
  },
}
