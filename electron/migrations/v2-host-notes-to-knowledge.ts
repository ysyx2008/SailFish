/**
 * Migration v2: Host Profile Notes → Knowledge Base
 *
 * 将 HostProfile.notes 迁移到知识库。
 * 原逻辑在 main.ts 的 migrateHostNotesToKnowledge() 函数中。
 *
 * 幂等：通过 host-notes-migrated.flag 文件标记，已迁移则跳过。
 * Phase: services（需要 KnowledgeService 和 HostProfileService）
 */

import * as fs from 'fs'
import * as path from 'path'
import { createLogger } from '../utils/logger'
import type { Migration } from './types'

const log = createLogger('Migration:v2')

export const migrationV2: Migration = {
  version: 2,
  name: 'host-notes-to-knowledge',
  phase: 'services',

  async migrate({ userDataPath, hostProfileService, knowledgeService }) {
    // 兼容旧版：如果 flag 文件已存在，说明之前的 ad-hoc 逻辑已完成过
    // 兼容旧版 ad-hoc 迁移标记：flag 存在说明已完成，清理后直接返回
    const flagPath = path.join(userDataPath, 'host-notes-migrated.flag')
    if (fs.existsSync(flagPath)) {
      log.info('Host notes already migrated (legacy flag file found), cleaning up')
      fs.rmSync(flagPath, { force: true })
      return
    }

    if (!knowledgeService || !hostProfileService) {
      log.warn('KnowledgeService or HostProfileService not available, deferring migration')
      throw new Error('Required services not available for host notes migration')
    }

    const profiles = hostProfileService.getAllProfiles()
    let totalMigrated = 0

    for (const profile of profiles) {
      if (profile.notes && profile.notes.length > 0) {
        const migrated = await knowledgeService.migrateNotesToKnowledge(
          profile.hostId,
          profile.notes
        )
        if (migrated > 0) {
          hostProfileService.updateProfile(profile.hostId, { notes: [] })
          totalMigrated += migrated
        }
      }
    }

    fs.writeFileSync(flagPath, new Date().toISOString(), 'utf-8')
    log.info(`Migrated ${totalMigrated} host note(s) to knowledge base`)
  },
}
