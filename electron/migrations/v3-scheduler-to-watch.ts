/**
 * Migration v3: Scheduler Tasks → Watch Definitions
 *
 * 将旧版定时任务迁移到关切系统。
 * 原逻辑在 main.ts 中调用 watchService.migrateFromScheduler()。
 *
 * 幂等：migrateFromScheduler 内部通过 name 去重。
 * Phase: services（需要 WatchService 和 SchedulerStore）
 */

import { createLogger } from '../utils/logger'
import type { Migration } from './types'

const log = createLogger('Migration:v3')

export const migrationV3: Migration = {
  version: 3,
  name: 'scheduler-to-watch',
  phase: 'services',

  async migrate({ watchService, schedulerStore, schedulerService }) {
    if (!watchService) {
      log.warn('WatchService not available, deferring migration')
      throw new Error('WatchService not available for scheduler migration')
    }

    const result = watchService.migrateFromScheduler(schedulerStore)

    if (result.migrated > 0) {
      log.info(`Migrated ${result.migrated} scheduler task(s) to watch, ${result.skipped} skipped`)
    }
    if (result.errors.length > 0) {
      log.warn('Migration warnings:', result.errors)
    }

    // 迁移后如果 Scheduler 已无任务，停止 Scheduler 服务
    if (schedulerService && schedulerService.getTasks().length === 0) {
      schedulerService.stop()
      log.info('Scheduler has no remaining tasks, stopped')
    }
  },
}
