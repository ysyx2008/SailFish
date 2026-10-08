/**
 * Word / Excel 覆盖写入前的原文件备份。
 *
 * 由写入路径调用，不依赖提示词。同一场对话里：
 * - 本场新建的文件不备份
 * - 本场开始前已存在的文件，第一次覆盖前复制为旁边唯一的「原名.扩展名.bak」
 * - 同一场之后再覆盖，不再多留
 * 换一场对话再改，把这一份更新成这次动手前的内容。
 * 伙计跟主人这场对话记在一起。记录随对话落在数据目录，进程重启后同一场不会把原件盖掉。
 */

import { createHash } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'

interface ConversationBackupState {
  created: Set<string>
  snapshotted: Set<string>
}

interface ExecutorConversationSource {
  getDocumentConversationId?: () => string | undefined
  getSessionId?: () => string | undefined
}

const byConversation = new Map<string, ConversationBackupState>()

/** undefined：运行在桌面里时用数据目录；null：只放内存（测试） */
let stateDirOverride: string | null | undefined

function stateFor(conversationId: string): ConversationBackupState {
  let state = byConversation.get(conversationId)
  if (!state) {
    state = readPersisted(conversationId) ?? { created: new Set(), snapshotted: new Set() }
    byConversation.set(conversationId, state)
  }
  return state
}

function normalize(filePath: string): string {
  return path.resolve(filePath)
}

function resolveStateDir(): string | null {
  if (stateDirOverride !== undefined) return stateDirOverride
  if (!process.versions.electron) return null
  try {
    const { app } = require('electron') as { app?: { getPath?: (name: string) => string } }
    const root = app?.getPath?.('userData')
    if (!root) return null
    return path.join(root, 'office-file-backup')
  } catch {
    return null
  }
}

function stateFilePath(conversationId: string): string | null {
  const dir = resolveStateDir()
  if (!dir) return null
  const name = createHash('sha256').update(conversationId).digest('hex').slice(0, 32)
  return path.join(dir, `${name}.json`)
}

function readPersisted(conversationId: string): ConversationBackupState | null {
  const filePath = stateFilePath(conversationId)
  if (!filePath || !fs.existsSync(filePath)) return null
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as {
      created?: unknown
      snapshotted?: unknown
    }
    const created = Array.isArray(raw.created) ? raw.created.filter((p): p is string => typeof p === 'string') : []
    const snapshotted = Array.isArray(raw.snapshotted) ? raw.snapshotted.filter((p): p is string => typeof p === 'string') : []
    return { created: new Set(created), snapshotted: new Set(snapshotted) }
  } catch {
    return null
  }
}

function persist(conversationId: string, state: ConversationBackupState): void {
  const filePath = stateFilePath(conversationId)
  if (!filePath) return
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${filePath}.${process.pid}.tmp`
  const payload = JSON.stringify({
    created: [...state.created],
    snapshotted: [...state.snapshotted],
  })
  fs.writeFileSync(tmp, payload, 'utf-8')
  fs.renameSync(tmp, filePath)
}

/** 旁边那一份的路径：报告.xlsx → 报告.xlsx.bak */
export function officeBackupPath(filePath: string): string {
  const ext = path.extname(filePath)
  const base = ext ? filePath.slice(0, -ext.length) : filePath
  return `${base}${ext}.bak`
}

/** 这场用户对话的 id。伙计应传入主人那场，而不是自己的临时会话。 */
export function documentConversationId(executor: ExecutorConversationSource): string | undefined {
  const id = executor.getDocumentConversationId?.() ?? executor.getSessionId?.()
  const trimmed = id?.trim()
  return trimmed ? trimmed : undefined
}

/**
 * 这场对话里、文件还不存在时记下来的路径。
 * 之后再覆盖按低风险，与新建相同。对不上这场、或这场开始前就有的文件，返回 false。
 */
export function officeFileCreatedInConversation(
  filePath: string,
  conversationId: string | undefined
): boolean {
  const id = conversationId?.trim()
  if (!id) return false
  return stateFor(id).created.has(normalize(filePath))
}

/**
 * 在覆盖写入之前调用。
 * 文件还不存在时记为本场新建，调用方随后创建它。
 * 没有对话 id 时不改已有的 .bak，避免把别的对话留下的原件盖掉。
 */
export function snapshotOfficeFileBeforeOverwrite(
  filePath: string,
  conversationId: string | undefined
): void {
  const key = normalize(filePath)
  const id = conversationId?.trim()
  if (!id) {
    if (!fs.existsSync(key)) return
    const bak = officeBackupPath(key)
    if (fs.existsSync(bak)) return
    fs.copyFileSync(key, bak)
    return
  }

  const state = stateFor(id)

  if (!fs.existsSync(key)) {
    state.created.add(key)
    persist(id, state)
    return
  }
  if (state.created.has(key) || state.snapshotted.has(key)) return

  fs.copyFileSync(key, officeBackupPath(key))
  state.snapshotted.add(key)
  persist(id, state)
}

export function resetOfficeBackupStateForTest(): void {
  byConversation.clear()
  stateDirOverride = undefined
}

export function forgetOfficeBackupMemoryForTest(): void {
  byConversation.clear()
}

export function setOfficeBackupStateDirForTest(dir: string | null): void {
  stateDirOverride = dir
}
