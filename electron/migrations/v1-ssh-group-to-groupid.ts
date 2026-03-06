/**
 * Migration v1: SSH Group String → SessionGroup Entity
 *
 * 将旧的 SshSession.group 字符串字段迁移为 SessionGroup 实体 + groupId 引用。
 * 原逻辑在前端 src/stores/config.ts 中，现移至后端统一管理。
 *
 * 幂等：只处理 group 有值但 groupId 为空的会话。
 */

import { createLogger } from '../utils/logger'
import type { Migration } from './types'

const log = createLogger('Migration:v1')

function generateId(): string {
  const timestamp = Date.now().toString(36)
  const random = Math.random().toString(36).substring(2, 10)
  return `${timestamp}-${random}`
}

export const migrationV1: Migration = {
  version: 1,
  name: 'ssh-group-to-groupid',
  phase: 'early',

  async migrate({ configService }) {
    const sessions = configService.get('sshSessions') || []
    const groups = configService.get('sessionGroups') || []

    const toMigrate = sessions.filter(
      (s: any) => s.group && !s.groupId
    )
    if (toMigrate.length === 0) {
      log.info('No SSH sessions need group migration, skipping')
      return
    }

    const groupNames = new Set(toMigrate.map((s: any) => s.group as string))
    let groupsChanged = false

    for (const name of groupNames) {
      if (!groups.find((g: any) => g.name === name)) {
        groups.push({ id: generateId(), name })
        groupsChanged = true
      }
    }

    let sessionsChanged = false
    for (const session of toMigrate) {
      const group = groups.find((g: any) => g.name === (session as any).group)
      if (group) {
        ;(session as any).groupId = group.id
        sessionsChanged = true
      }
    }

    if (groupsChanged) {
      configService.set('sessionGroups', groups)
    }
    if (sessionsChanged) {
      configService.set('sshSessions', sessions)
    }

    log.info(`Migrated ${toMigrate.length} SSH session(s) from group string to groupId`)
  },
}
