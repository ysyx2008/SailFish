/**
 * Migration Framework Types
 *
 * 版本化迁移系统：每个 migration 有唯一递增的 version number，
 * 按 phase 分组以适配不同服务的初始化时机。
 */

import type { ConfigService } from '../services/config.service'
import type { HostProfileService } from '../services/host-profile.service'

export type MigrationPhase = 'early' | 'services'

export interface MigrationContext {
  configService: ConfigService
  userDataPath: string

  // services phase 才可用
  hostProfileService?: HostProfileService
  knowledgeService?: { migrateNotesToKnowledge(hostId: string, notes: string[]): Promise<number> } | null
  watchService?: { migrateFromScheduler(store: any): { migrated: number; skipped: number; errors: string[] } }
  schedulerStore?: { getTasks(): any[]; deleteTask(id: string): boolean } | null
  schedulerService?: { getTasks(): any[]; stop(): void }
}

export interface Migration {
  version: number
  name: string
  phase: MigrationPhase
  migrate: (context: MigrationContext) => Promise<void>
}
