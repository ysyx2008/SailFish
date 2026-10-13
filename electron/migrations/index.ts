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
import { migrationV4 } from './v4-ui-theme-mode'
import { migrationV5 } from './v5-agent-history-per-session'
import { migrationV6 } from './v6-watch-history-split'
import { migrationV7 } from './v7-im-bastion-and-e1-to-g1'
import { migrationV8 } from './v8-conversation-titles-to-records'
import { migrationV9 } from './v9-todo-md-to-json'
import { migrationV10 } from './v10-mcp-when-to-use-notice'
import { migrationV11 } from './v11-contacts-md-to-json'

const allMigrations = [
  migrationV1,
  migrationV2,
  migrationV3,
  migrationV4,
  migrationV5,
  migrationV6,
  migrationV7,
  migrationV8,
  migrationV9,
  migrationV10,
  migrationV11,
]

let _runner: MigrationRunner | null = null

export function getMigrationRunner(): MigrationRunner {
  if (!_runner) {
    _runner = new MigrationRunner()
    _runner.registerAll(allMigrations)
  }
  return _runner
}
