/**
 * Migration Runner
 *
 * 按 version 顺序执行待运行的数据迁移。
 * 每个 migration 成功后立即更新 schemaVersion，
 * 确保中途失败时下次启动能从断点继续。
 */

import { createLogger } from '../utils/logger'
import { createBackup } from './backup'
import type { Migration, MigrationContext, MigrationPhase } from './types'

const log = createLogger('Migration')

export class MigrationRunner {
  private migrations: Migration[] = []

  register(migration: Migration): void {
    this.migrations.push(migration)
    this.migrations.sort((a, b) => a.version - b.version)
  }

  registerAll(migrations: Migration[]): void {
    for (const m of migrations) {
      this.register(m)
    }
  }

  /**
   * 执行指定 phase 中所有待运行的 migration。
   * @returns 成功执行的 migration 数量
   */
  async run(phase: MigrationPhase, context: MigrationContext): Promise<number> {
    const currentVersion = context.configService.getSchemaVersion()
    const pending = this.migrations.filter(
      m => m.phase === phase && m.version > currentVersion
    )

    if (pending.length === 0) return 0

    log.info(
      `[${phase}] ${pending.length} pending migration(s): ` +
      pending.map(m => `v${m.version}-${m.name}`).join(', ')
    )

    // 有待执行的 migration 时先备份
    createBackup(context.userDataPath, `pre-migration-v${pending[0].version}`)

    let executed = 0
    for (const migration of pending) {
      try {
        log.info(`Running migration v${migration.version}: ${migration.name}`)
        await migration.migrate(context)
        context.configService.setSchemaVersion(migration.version)
        executed++
        log.info(`Migration v${migration.version} completed`)
      } catch (err) {
        log.error(`Migration v${migration.version} (${migration.name}) failed:`, err)
        // 停止执行后续 migration，下次启动会重试
        break
      }
    }

    return executed
  }

  getPendingCount(phase: MigrationPhase, currentVersion: number): number {
    return this.migrations.filter(
      m => m.phase === phase && m.version > currentVersion
    ).length
  }

  getLatestVersion(): number {
    return this.migrations.length > 0
      ? this.migrations[this.migrations.length - 1].version
      : 0
  }
}
