/**
 * Migration Registry
 *
 * 所有 migration 在此注册，按 version 顺序执行。
 * 新增 migration 只需：
 *   1. 创建 vN-xxx.ts 文件实现 Migration 接口
 *   2. 在此文件 allMigrations 数组中追加
 */

export { MigrationRunner } from './runner'
export { createBackup } from './backup'
export type { Migration, MigrationContext, MigrationPhase } from './types'

import { MigrationRunner } from './runner'
import { migrationV1 } from './v1-ssh-group-to-groupid'
import { migrationV2 } from './v2-host-notes-to-knowledge'
import { migrationV3 } from './v3-scheduler-to-watch'

const allMigrations = [
  migrationV1,
  migrationV2,
  migrationV3,
]

let _runner: MigrationRunner | null = null

export function getMigrationRunner(): MigrationRunner {
  if (!_runner) {
    _runner = new MigrationRunner()
    _runner.registerAll(allMigrations)
  }
  return _runner
}
