/**
 * 知识库数据备份 / 恢复
 *
 * 用途：dev 热重载频繁触发 LanceDB 损坏 → 全量重建太慢。改成「损坏前已有快照，
 * 启动检测到损坏时先从备份恢复，恢复后跑 repairIndex() 增量补差集」，
 * 把"几十分钟全量重 embed"压成"几秒拷贝 + 几分钟补缺失文档"。
 *
 * 备份范围：整个 `{userData}/knowledge/` 目录
 *   - lancedb/             向量与切词数据（最大头）
 *   - bm25-index.json(.tmp) 旧版整本词索引（升级后不再更新，闲置 7 天后清理）
 *   - documents.json       文档元数据（真相源）
 *   - .password            加密口令（如有）
 *
 * 备份时机（关键）：
 *   - 启动 initialize 开头、worker 尚未打开向量库时做文件级复制
 *     （磁盘是上次退出状态；已标损坏则禁止自动备份，避免把坏库存成最新）
 *   - 距上次自动备份 > MIN_BACKUP_INTERVAL_MS 才备份，避免 dev 频繁热重载
 *     时每次都复制几十 MB
 *   - 手动备份不受时间间隔限制
 *
 * 恢复时机：
 *   - 启动检测到损坏标记时从新到旧试备份；读得开才算成功
 *   - 都读不开也不清表、不全量重建
 *
 * 轮转：保留最近 MAX_BACKUPS 份，按 mtime 排序删旧
 */
import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import { createLogger } from '../../utils/logger'

const log = createLogger('KnowledgeBackup')

/** 自动备份的最小间隔（30 分钟）—— 防止 dev 热重载时每次都复制 */
export const MIN_BACKUP_INTERVAL_MS = 30 * 60 * 1000

/** 保留的自动备份数量 */
export const MAX_BACKUPS = 3

/**
 * 保留的损坏现场份数。
 *
 * 现场是留给排查的，不是存档：真要查，最近一份就够，更早的内容雷同。
 * 一份两三百兆，不设上限的话每次启动都往上堆（见 SPEC「救不回来的时候，别把磁盘吃掉」）。
 */
export const MAX_BROKEN_SNAPSHOTS = 2

/** 备份根目录 */
function getBackupsRoot(): string {
  return path.join(app.getPath('userData'), 'knowledge-backups')
}

/** 损坏现场根目录——集中一处，用户一眼能看出占了多少、能整个清掉 */
function getBrokenRoot(): string {
  return path.join(app.getPath('userData'), 'knowledge-broken')
}

/** 「这批备份都救不回来」的结论落盘处 */
function getRestoreExhaustedPath(): string {
  return path.join(getBackupsRoot(), '.restore-exhausted')
}

/** 知识库数据目录 */
function getKnowledgeDir(): string {
  return path.join(app.getPath('userData'), 'knowledge')
}

/** 向量库损坏标记（检索缺文件时写入，下次启动据此恢复） */
function getCorruptionMarkerPath(): string {
  return path.join(getKnowledgeDir(), 'lancedb', '.corrupted')
}

/** 当前知识库是否已标损坏——自动备份必须避开，否则会把坏库存成最新 */
export function hasCorruptionMarker(): boolean {
  return fs.existsSync(getCorruptionMarkerPath())
}

/**
 * 撤销损坏标记：坏的那张表已经被丢掉、正按源文档重新长出来，标记再留着就是说谎。
 *
 * 留着的后果不是多打几行日志：下次启动会据此认定「该再试一次备份」，把刚重建好的
 * 表改名存成现场、再拿那份读不开的旧备份盖上去，于是又得重建一遍。每轮还多吃几百兆。
 */
export function clearCorruptionMarker(): void {
  try {
    fs.unlinkSync(getCorruptionMarkerPath())
  } catch { /* 本来就没有 */ }
}

/** 上次自动备份时间戳文件 */
function getLastBackupMarkerPath(): string {
  return path.join(getBackupsRoot(), '.last-auto-backup')
}

/**
 * 递归复制目录（跳过符号链接，避免环）
 *
 * 跳过 .corrupted 标记文件：避免备份时把损坏标记一起带进备份，
 * 否则恢复后下次启动会再次触发恢复逻辑（虽不死循环，但无意义）。
 */
function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue
    if (entry.name === '.corrupted') continue
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath)
    } else {
      fs.copyFileSync(srcPath, destPath)
    }
  }
}

/**
 * 递归删除目录（容错）
 */
function rmrfSync(target: string): void {
  try {
    fs.rmSync(target, { recursive: true, force: true })
  } catch (e) {
    log.warn(`rmrf 失败: ${target}`, e)
  }
}

export interface BackupEntry {
  /** 备份目录名（时间戳格式） */
  name: string
  /** 完整路径 */
  path: string
  /** 创建时间（ms） */
  createdAt: number
  /** 估算大小（字节） */
  sizeBytes: number
  /** 是否自动备份（带 auto- 前缀） */
  automatic: boolean
}

export interface CreateBackupResult {
  success: boolean
  backupPath?: string
  error?: string
}

export interface RestoreBackupResult {
  success: boolean
  backupPath?: string
  error?: string
}

/**
 * 列出所有备份，按时间倒序
 */
export function listBackups(): BackupEntry[] {
  const root = getBackupsRoot()
  if (!fs.existsSync(root)) return []

  const entries: BackupEntry[] = []
  for (const name of fs.readdirSync(root, { withFileTypes: true })) {
    if (!name.isDirectory()) continue
    if (name.name.startsWith('.')) continue
    const fullPath = path.join(root, name.name)
    try {
      const stat = fs.statSync(fullPath)
      entries.push({
        name: name.name,
        path: fullPath,
        createdAt: stat.mtimeMs,
        sizeBytes: computeDirSize(fullPath),
        automatic: name.name.startsWith('auto-'),
      })
    } catch (e) {
      log.warn(`跳过无法读取的备份目录: ${name.name}`, e)
    }
  }

  entries.sort((a, b) => b.createdAt - a.createdAt)
  return entries
}

function computeDirSize(dir: string): number {
  let total = 0
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        total += computeDirSize(p)
      } else if (entry.isFile()) {
        total += fs.statSync(p).size
      }
    }
  } catch { /* ignore */ }
  return total
}

/**
 * 创建一份备份
 *
 * @param automatic true=自动备份（受 MIN_BACKUP_INTERVAL_MS 限制，前缀 auto-）
 *                  false=手动备份（不受限制，前缀 manual-）
 */
export function createBackup(automatic: boolean = true): CreateBackupResult {
  const knowledgeDir = getKnowledgeDir()
  const root = getBackupsRoot()

  if (!fs.existsSync(knowledgeDir)) {
    return { success: false, error: '知识库目录不存在，无可备份内容' }
  }

  // 自动备份时间间隔检查
  if (automatic) {
    if (hasCorruptionMarker()) {
      log.warn('自动备份跳过：知识库已标记损坏，避免把坏库存成最新备份')
      return { success: true, backupPath: undefined }
    }
    if (fs.existsSync(getLastBackupMarkerPath())) {
      try {
        const last = parseInt(
          fs.readFileSync(getLastBackupMarkerPath(), 'utf-8').trim(),
          10
        )
        if (Date.now() - last < MIN_BACKUP_INTERVAL_MS) {
          log.info(`自动备份跳过：距上次备份 ${Math.round((Date.now() - last) / 1000)}s < ${MIN_BACKUP_INTERVAL_MS / 1000}s`)
          return { success: true, backupPath: undefined }
        }
      } catch { /* marker 损坏，继续备份 */ }
    }
  }

  fs.mkdirSync(root, { recursive: true })

  const prefix = automatic ? 'auto-' : 'manual-'
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupDir = path.join(root, `${prefix}${timestamp}`)

  try {
    fs.mkdirSync(backupDir, { recursive: true })
    copyDirSync(knowledgeDir, backupDir)

    if (automatic) {
      fs.writeFileSync(getLastBackupMarkerPath(), String(Date.now()), 'utf-8')
    }

    log.info(`备份完成: ${backupDir}`)
    pruneOldBackups()

    return { success: true, backupPath: backupDir }
  } catch (e) {
    log.error('备份失败:', e)
    // 备份失败时清理半成品目录
    rmrfSync(backupDir)
    return {
      success: false,
      error: e instanceof Error ? e.message : String(e),
    }
  }
}

/** 用户选的文件夹是不是一份完整快照（本机备份或「存到别处」的那份） */
export function isKnowledgeSnapshot(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'documents.json'))
}

/**
 * 解析用户选的目录：自己是快照，或里面恰好只有一份快照（选到了外层文件夹）。
 * 认不出来返回 null。
 */
export function resolveKnowledgeSnapshot(dir: string): string | null {
  if (isKnowledgeSnapshot(dir)) return dir
  try {
    const kids = fs.readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => path.join(dir, entry.name))
      .filter(isKnowledgeSnapshot)
    if (kids.length === 1) return kids[0]
  } catch { /* 读不到就当认不出来 */ }
  return null
}

/**
 * 把当前知识库整包拷到用户选的目录里，另起一份快照。
 * 不进本机备份列表，也不参与自动轮转。
 */
export function saveBackupTo(destParent: string): CreateBackupResult {
  const knowledgeDir = getKnowledgeDir()
  if (!fs.existsSync(knowledgeDir)) {
    return { success: false, error: '知识库目录不存在，无可备份内容' }
  }
  if (!destParent || !fs.existsSync(destParent)) {
    return { success: false, error: '目标目录不存在' }
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupDir = path.join(destParent, `sailfish-knowledge-${timestamp}`)

  try {
    fs.mkdirSync(backupDir, { recursive: true })
    copyDirSync(knowledgeDir, backupDir)
    log.info(`已存到别处: ${backupDir}`)
    return { success: true, backupPath: backupDir }
  } catch (e) {
    log.error('存到别处失败:', e)
    rmrfSync(backupDir)
    return {
      success: false,
      error: e instanceof Error ? e.message : String(e),
    }
  }
}

/**
 * 轮转：保留最近 MAX_BACKUPS 份自动备份。
 * 手动备份不参与自动轮转（用户主动建的，不应被悄悄删）。
 */
function pruneOldBackups(): void {
  const backups = listBackups()
  const autoBackups = backups.filter(b => b.automatic)

  for (const old of autoBackups.slice(MAX_BACKUPS)) {
    rmrfSync(old.path)
    log.info(`已轮转删除旧自动备份: ${old.name}`)
  }
}

/**
 * 现有备份的指纹：哪几份、各自什么时候的。
 * 备份没变就没必要把「都救不回来」这个结论重新验证一遍。
 *
 * 这是身份代理，不是内容校验——备份目录建好后不再原地改写，所以「名字 + 时间」
 * 足以认出是不是同一批。它认不出「内容悄悄坏了但名字时间没变」，但那种情况下
 * 结论本来也没变；反方向（被外部工具碰过时间）只会让人多试一次，不会漏试。
 */
function computeBackupFingerprint(): string {
  return listBackups()
    .map(b => `${b.name}@${Math.round(b.createdAt)}`)
    .join(',')
}

/**
 * 记下「手上这批备份都救不回来」。
 * 下次启动据此跳过恢复——每重试一次都要复制几百兆，而结论是注定的。
 */
export function markRestoreExhausted(): void {
  try {
    fs.mkdirSync(getBackupsRoot(), { recursive: true })
    fs.writeFileSync(
      getRestoreExhaustedPath(),
      JSON.stringify({ fingerprint: computeBackupFingerprint(), at: Date.now() }),
      'utf-8'
    )
  } catch (e) {
    log.warn('记录「备份都救不回来」失败:', e)
  }
}

/** 手上这批备份是否已被判定救不回来（备份有增删或更新则重新算数） */
export function isRestoreExhausted(): boolean {
  try {
    const raw = fs.readFileSync(getRestoreExhaustedPath(), 'utf-8')
    return JSON.parse(raw)?.fingerprint === computeBackupFingerprint()
  } catch {
    return false
  }
}

/** 撤销上面的结论——用户手动发起恢复时必须重新给机会 */
export function clearRestoreExhausted(): void {
  try {
    fs.unlinkSync(getRestoreExhaustedPath())
  } catch { /* 本来就没有 */ }
}

/**
 * 分配一个没被占用的现场目录名。
 *
 * 光用毫秒会撞：同一次启动里连着换几份备份，快到落在同一毫秒时 rename 到已存在的
 * 非空目录会直接失败，把整个恢复带崩。
 */
function allocateBrokenDir(root: string, timestamp: number = Date.now()): string {
  for (let seq = 0; seq < 1000; seq++) {
    const candidate = path.join(root, `broken-${timestamp}-${String(seq).padStart(3, '0')}`)
    if (!fs.existsSync(candidate)) return candidate
  }
  return path.join(root, `broken-${timestamp}-${Math.random().toString(36).slice(2, 8)}`)
}

/** 现场目录名形如 `broken-<毫秒>-<序号>`；早先收编进来的可能没有序号 */
function parseSnapshotName(name: string): { ts: number; seq: number } | null {
  const m = /^broken-(\d+)(?:-(\d+))?$/.exec(name)
  if (!m) return null
  return { ts: Number(m[1]), seq: m[2] ? Number(m[2]) : 0 }
}

/** 现有的损坏现场，按时间倒序 */
export function listBrokenSnapshots(): Array<{ name: string; path: string; createdAt: number }> {
  const root = getBrokenRoot()
  if (!fs.existsSync(root)) return []
  const entries: Array<{ name: string; path: string; createdAt: number; order: [number, number] }> = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const full = path.join(root, entry.name)
    try {
      const mtime = fs.statSync(full).mtimeMs
      // 名字里的时间戳才是「这份现场是什么时候留的」；mtime 会被收编时的搬动等操作带偏
      const parsed = parseSnapshotName(entry.name)
      entries.push({
        name: entry.name,
        path: full,
        createdAt: parsed?.ts ?? mtime,
        order: parsed ? [parsed.ts, parsed.seq] : [mtime, 0],
      })
    } catch { /* 读不到就当它不存在 */ }
  }
  entries.sort((a, b) => b.order[0] - a.order[0] || b.order[1] - a.order[1])
  return entries.map(({ name, path: p, createdAt }) => ({ name, path: p, createdAt }))
}

/** 只留最近 MAX_BROKEN_SNAPSHOTS 份现场 */
function pruneBrokenSnapshots(): void {
  for (const old of listBrokenSnapshots().slice(MAX_BROKEN_SNAPSHOTS)) {
    rmrfSync(old.path)
    log.info(`已清理旧的损坏现场: ${old.name}`)
  }
}

/**
 * 收编早先散落在数据目录根下的现场（`knowledge.broken-*`）。
 *
 * 那时每次恢复都留一份且从不清理，反复重启能堆到几十 G。收进统一位置后一并轮转，
 * 老用户升上来才有人替他把这笔占用收回去。
 */
export function adoptLegacyBrokenSnapshots(): void {
  const userData = app.getPath('userData')
  let adopted = 0
  try {
    for (const entry of fs.readdirSync(userData, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('knowledge.broken-')) continue
      const brokenRoot = getBrokenRoot()
      fs.mkdirSync(brokenRoot, { recursive: true })
      const ts = Number(entry.name.slice('knowledge.broken-'.length))
      try {
        fs.renameSync(
          path.join(userData, entry.name),
          allocateBrokenDir(brokenRoot, Number.isFinite(ts) ? ts : Date.now())
        )
        adopted++
      } catch (e) {
        log.warn(`收编旧现场失败: ${entry.name}`, e)
      }
    }
  } catch (e) {
    log.warn('扫描旧现场失败:', e)
    return
  }
  if (adopted > 0) {
    log.info(`已收编 ${adopted} 份散落的损坏现场，按上限轮转`)
    pruneBrokenSnapshots()
  }
}

export interface RestoreOptions {
  /**
   * 是否把被换下来的当前目录留档为现场。默认 true。
   *
   * 同一轮里试第二份、第三份备份时传 false：那时被换下来的是上一次刚从备份
   * 复制进去的副本，内容和备份本身一模一样，留着只是白占几百兆。
   */
  keepSnapshot?: boolean
}

/**
 * 从指定备份恢复。
 * 恢复策略：先把当前 knowledge/ 挪进 knowledge-broken/（保留现场便于排查），
 * 再把备份复制回去。这样即便恢复失败，原数据也还在。
 *
 * @param backupPath 备份目录完整路径；不传则用最近一份
 */
export function restoreBackup(backupPath?: string, options?: RestoreOptions): RestoreBackupResult {
  const knowledgeDir = getKnowledgeDir()
  const keepSnapshot = options?.keepSnapshot !== false

  let sourcePath = backupPath
  if (!sourcePath) {
    const backups = listBackups()
    if (backups.length === 0) {
      return { success: false, error: '没有可用的备份' }
    }
    sourcePath = backups[0].path
  }

  if (!fs.existsSync(sourcePath)) {
    return { success: false, error: `备份目录不存在: ${sourcePath}` }
  }

  // 验证备份内容至少有 documents.json 或 lancedb/
  const hasDocs = fs.existsSync(path.join(sourcePath, 'documents.json'))
  const hasLancedb = fs.existsSync(path.join(sourcePath, 'lancedb'))
  if (!hasDocs && !hasLancedb) {
    return { success: false, error: '备份内容不完整（无 documents.json 也无 lancedb/）' }
  }

  try {
    // 把当前的 knowledge/ 挪走腾位置。
    // rename 失败说明文件被占用（worker 未退出 / LanceDB 句柄未释放），
    // 此时不应 rmrf（可能数据丢失），直接抛出让调用方处理
    if (fs.existsSync(knowledgeDir)) {
      const brokenRoot = getBrokenRoot()
      fs.mkdirSync(brokenRoot, { recursive: true })
      const brokenDir = allocateBrokenDir(brokenRoot)
      try {
        fs.renameSync(knowledgeDir, brokenDir)
      } catch (e) {
        throw new Error(
          `无法重命名当前 knowledge 目录（文件可能被占用）: ` +
          `${e instanceof Error ? e.message : String(e)}。` +
          `请确保知识库已停止运行后重试。`
        )
      }
      if (keepSnapshot) {
        log.info(`已保留损坏现场: ${brokenDir}`)
        pruneBrokenSnapshots()
      } else {
        // 这一份是上次刚从备份复制进去的副本，不是现场
        rmrfSync(brokenDir)
      }
    }

    fs.mkdirSync(knowledgeDir, { recursive: true })
    copyDirSync(sourcePath, knowledgeDir)

    log.info(`从备份恢复完成: ${sourcePath}`)
    return { success: true, backupPath: sourcePath }
  } catch (e) {
    log.error('从备份恢复失败:', e)
    return {
      success: false,
      error: e instanceof Error ? e.message : String(e),
    }
  }
}

/**
 * 获取距离上次自动备份的时间（ms）；从未备份返回 Infinity
 */
export function msSinceLastAutoBackup(): number {
  try {
    const marker = getLastBackupMarkerPath()
    if (!fs.existsSync(marker)) return Infinity
    const last = parseInt(fs.readFileSync(marker, 'utf-8').trim(), 10)
    return Date.now() - last
  } catch {
    return Infinity
  }
}

/**
 * 删除指定备份
 */
export function deleteBackup(backupPath: string): boolean {
  const root = getBackupsRoot()
  // 安全检查：只允许删除 backups 目录下的内容
  // 必须用 path.sep 分隔，防止 knowledge-backups2/ 等前缀同名目录绕过
  const rootResolved = path.resolve(root)
  const targetResolved = path.resolve(backupPath)
  const isUnderRoot = targetResolved === rootResolved ||
    targetResolved.startsWith(rootResolved + path.sep)
  if (!isUnderRoot) {
    log.warn(`拒绝删除 backups 目录外的路径: ${backupPath}`)
    return false
  }
  rmrfSync(targetResolved)
  log.info(`已删除备份: ${backupPath}`)
  return true
}
