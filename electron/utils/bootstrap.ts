/**
 * 数据目录引导（bootstrap）
 *
 * 必须作为 main.ts 的**第一个 import**，以便在任何 service 实例化之前完成
 * `app.setPath('userData', ...)` 的重定向。
 *
 * 设计：
 * - 在**平台级 appData 目录**下的固定子目录 `SailFish/` 里放一个极小的指针文件
 *   `data-location.json`，记录用户自定义的数据目录。指针文件位置**不依赖
 *   `app.getName()`**——因为该值在 dev（取 package.json name）和 prod（取
 *   productName）下不同，若指针放在默认 userData 下，dev/prod 切换或应用改名
 *   后指针就会“失踪”，导致迁移状态丢失（即“改过一次又变回来”的 bug）。
 *   指针文件本身永远留在固定位置，体积极小，不随数据迁移移动，避免“先有鸡还是
 *   先有鸡”的问题。
 * - 模块被 import 时（require 期，早于服务构造）立即执行 {@link applyDataDirRedirect}：
 *   先迁移老版本遗留在默认 userData 下的指针（一次性兼容），再处理上一轮迁移遗留
 *   的旧目录清理，再检测是否处于“应用改名后的首次启动”（历史默认目录 SFTerm 有
 *   数据而当前默认目录为空），若是则挂一个 pendingMigration 让
 *   {@link runStartupMigrationIfNeeded} 自动迁移老数据，最后按指针把 userData
 *   重定向到自定义目录。
 * - 真正的数据迁移采用“重启时迁移”：在干净的启动早期（没有任何 agent/watch/sensor
 *   在运行、源目录无写入）复制数据并展示进度窗，复制完成后重启。详见
 *   {@link runStartupMigrationIfNeeded}。
 */
import { app, BrowserWindow } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { copyDirectoryWithProgress, CopyCanceledError } from './dir-copy'
import {
  RESTORE_OLD_DIRNAME,
  RESTORE_STAGING_DIRNAME,
  extractBackupToStaging,
  recoverInterruptedRestore,
  replaceUserDataFromStaging,
  validateBackupArchive,
} from './data-backup'
import { CrashRecorder, DEV_STATE_FILE, PACKAGED_STATE_FILE, markCleanExitInDir } from '../services/diagnostics/crash-recorder'

/** 指针文件名 */
const POINTER_FILENAME = 'data-location.json'

/** 默认 userData 目录：必须在任何 setPath 之前捕获，依赖 app.getName()（dev/prod 不同） */
const DEFAULT_USERDATA = app.getPath('userData')

/** 指针文件所在固定目录：平台级 appData 下的 `SailFish` 子目录。 */
const POINTER_DIR = path.join(app.getPath('appData'), 'SailFish')

/** 指针文件绝对路径（恒定在固定目录，与 app.getName() 无关） */
const POINTER_PATH = path.join(POINTER_DIR, POINTER_FILENAME)

/**
 * 历史应用名：v11.1 前 `package.json#name` 为 `SFTerm`，导致 dev 环境默认 userData
 * 落在 `appData/SFTerm`。改名后 dev 默认目录变为 `appData/SailFish`（与 prod 一致），
 * 老用户的 dev 数据仍留在旧目录，需一次性自动迁移。prod 从未使用过该目录名。
 */
const LEGACY_APP_NAME = 'SFTerm'
const LEGACY_DEFAULT_USERDATA = path.join(app.getPath('appData'), LEGACY_APP_NAME)

interface DataLocationPointer {
  /** 当前生效的自定义数据目录；缺省表示使用默认目录 */
  dataDir?: string
  /** 待执行的迁移目标目录（下次启动早期执行复制） */
  pendingMigration?: { target: string }
  /** 待执行的完整恢复：从备份目录覆盖当前 userData（启动早期 staging 后替换） */
  pendingRestore?: { backupPath: string }
  /** 待清理的旧目录（迁移成功后延迟到下次启动删除，规避文件锁） */
  cleanupDir?: string
  /** 上一次迁移失败的错误信息（供前端读取后展示并清除） */
  lastError?: string
  /**
   * 应用改名后的历史默认目录迁移是否已完成。
   *
   * 单独标记的原因：Electron 首次启动即会在 userData 下创建 Chromium 缓存与
   * 初始化 config（如 qiyu-terminal-config.json），因此无法用"目录是否空"或
   * "config 是否存在"判断目录是否被真实使用过。改用这个显式标记：迁移完成后
   * 置 true，之后即使旧目录被清理、新目录已写入数据，也不会重复触发。
   */
  legacyMigrationDone?: boolean
}

function readPointer(): DataLocationPointer {
  try {
    if (!fs.existsSync(POINTER_PATH)) return {}
    const raw = fs.readFileSync(POINTER_PATH, 'utf-8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writePointer(pointer: DataLocationPointer): void {
  try {
    fs.mkdirSync(POINTER_DIR, { recursive: true })
    // 去掉空字段，保持文件干净
    const clean: DataLocationPointer = {}
    if (pointer.dataDir) clean.dataDir = pointer.dataDir
    if (pointer.pendingMigration) clean.pendingMigration = pointer.pendingMigration
    if (pointer.pendingRestore) clean.pendingRestore = pointer.pendingRestore
    if (pointer.cleanupDir) clean.cleanupDir = pointer.cleanupDir
    if (pointer.lastError) clean.lastError = pointer.lastError
    if (pointer.legacyMigrationDone) clean.legacyMigrationDone = pointer.legacyMigrationDone
    fs.writeFileSync(POINTER_PATH, JSON.stringify(clean, null, 2), 'utf-8')
  } catch (e) {
    console.error('[bootstrap] 写入数据目录指针失败:', e)
  }
}

/**
 * 一次性兼容迁移：把老版本遗留的指针文件迁到新固定位置。
 *
 * 老版本把指针放在 `DEFAULT_USERDATA/data-location.json`，该位置依赖
 * `app.getName()`，dev（`.../SFTerm`）和 prod（`.../SailFish`）不同。新版本改用
 * `appData/SailFish/` 固定位置后，需把本进程默认目录下的遗留指针搬到新位置。
 *
 * 检查两个候选位置：
 * 1. 当前默认目录 `DEFAULT_USERDATA/data-location.json`（同环境上次启动遗留）；
 * 2. 改名前的历史默认目录 `appData/SFTerm/data-location.json`（dev 环境从 v11.1
 *    name 改名后遗留）。若该指针里有 dataDir，迁移过来后能让后续逻辑正确识别
 *    "用户已自定义目录"，避免误触发 migrateLegacyDefaultDataDir 全量数据迁移。
 *
 * 旧文件保留不删，避免破坏老版本回退能力。
 * 只在 {@link applyDataDirRedirect} 最前面调用一次，新位置一旦有指针就不再迁移。
 */
function migrateLegacyPointer(): void {
  if (fs.existsSync(POINTER_PATH)) return // 新位置已有指针，无需迁移
  const candidates = [
    path.join(DEFAULT_USERDATA, POINTER_FILENAME),
    path.join(LEGACY_DEFAULT_USERDATA, POINTER_FILENAME),
  ]
  const legacyPath = candidates.find((p) => fs.existsSync(p))
  if (!legacyPath) return // 两个位置都没有，全新安装
  try {
    fs.mkdirSync(POINTER_DIR, { recursive: true })
    fs.copyFileSync(legacyPath, POINTER_PATH)
    console.info('[bootstrap] 已将旧版数据目录指针迁移到固定位置:', POINTER_PATH)
  } catch (e) {
    console.error('[bootstrap] 迁移旧版指针文件失败:', e)
  }
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b)
}

/** 判断 child 是否在 parent 目录内部（含相等以外的嵌套） */
function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/**
 * 删除旧目录数据。若旧目录就是默认目录，则逐项删除内容、保留指针文件。
 *
 * 指针文件必须保留的两个原因：
 * 1. dev 环境下，默认目录里可能还有老版本遗留的 data-location.json（已迁到新位置，
 *    但旧文件保留不删）；
 * 2. prod 环境下，新指针位置 appData/SailFish 恰好就是默认目录本身，跳过它才能
 *    保证迁移清理后指针不丢失。
 */
function cleanupOldDir(dir: string): void {
  try {
    if (!fs.existsSync(dir)) return
    if (samePath(dir, DEFAULT_USERDATA)) {
      for (const entry of fs.readdirSync(dir)) {
        if (entry === POINTER_FILENAME) continue
        fs.rmSync(path.join(dir, entry), { recursive: true, force: true })
      }
    } else {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  } catch (e) {
    console.error('[bootstrap] 清理旧数据目录失败:', e)
  }
}

/**
 * 一次性数据迁移：从历史默认目录 `appData/SFTerm` 迁到当前默认目录。
 *
 * 背景：v11.1 起 `package.json#name` 由 `SFTerm` 改为 `SailFish`，dev 环境默认
 * userData 随之从 `appData/SFTerm` 变为 `appData/SailFish`。老 dev 用户的数据仍
 * 留在旧目录，直接启动会"看起来数据全没了"。本函数检测这一场景，复用既有的
 * pendingMigration + 进度窗 + 重启清理流程完成自动迁移。
 *
 * 仅 dev 环境受影响（prod 的 productName 一直是 SailFish，从未存在 SFTerm 目录）。
 * 仅在以下条件全部满足时触发：
 * 1. 指针未标记 legacyMigrationDone（尚未迁移过）；
 * 2. 没有自定义 dataDir（用户没把数据迁到别处）；
 * 3. 没有正在进行的用户触发迁移（pendingMigration）；
 * 4. 没有上次迁移失败的 lastError（防无限重试，待用户确认后才重试）；
 * 5. 旧默认目录 `appData/SFTerm` 存在且有数据。
 *
 * 不依赖"当前默认目录是否空"判断--Electron 首次启动即会创建 Chromium 缓存与
 * 初始化 config（如 qiyu-terminal-config.json），目录非空是常态，无法据此区分
 * "全新空目录"与"已被使用的目录"。改用显式的 legacyMigrationDone 标记。
 *
 * 触发后：把 userData 临时重定向到旧目录（作为迁移 source），写入
 * pendingMigration.target = 当前默认目录，交由 {@link runStartupMigrationIfNeeded}
 * 完成复制 + 重启 + 旧目录清理。迁移成功后由该函数标记 legacyMigrationDone。
 */
function migrateLegacyDefaultDataDir(): void {
  const p = readPointer()
  // 已迁移过 / 有自定义目录 / 正在迁移 / 上次失败待确认 -> 跳过
  if (p.legacyMigrationDone || p.dataDir || p.pendingMigration || p.lastError) return

  const currentDefault = DEFAULT_USERDATA
  const legacyDir = LEGACY_DEFAULT_USERDATA
  if (samePath(currentDefault, legacyDir)) return // 同名（理论上不会发生）

  // 旧目录是否有数据
  if (!fs.existsSync(legacyDir)) return
  try {
    if (fs.readdirSync(legacyDir).length === 0) return
  } catch {
    return
  }

  // 触发迁移：把 userData 临时指向旧目录，挂一个 pendingMigration 指向新默认目录
  try {
    fs.mkdirSync(legacyDir, { recursive: true })
    app.setPath('userData', legacyDir)
    writePointer({ pendingMigration: { target: path.resolve(currentDefault) } })
    console.info(
      `[bootstrap] 检测到历史数据目录 ${legacyDir}，将自动迁移到 ${currentDefault}`
    )
  } catch (e) {
    console.error('[bootstrap] 设置历史数据目录迁移失败:', e)
  }
}

/**
 * require 期立即执行：迁移老指针 + 处理旧目录清理 + 应用 userData 重定向。
 * 注意：pendingMigration 不在此处理（需等 app ready 才能建进度窗），
 * 仅在此确保 source（当前生效目录）已正确指向。
 */
function applyDataDirRedirect(): void {
  // 0. 一次性兼容迁移：把老版本遗留指针搬到新固定位置
  migrateLegacyPointer()

  let pointer = readPointer()

  // 1. 处理上一轮迁移遗留的旧目录清理（此时尚无 service 打开旧文件）
  if (pointer.cleanupDir) {
    const toClean = pointer.cleanupDir
    // 安全检查：不清理当前生效目录
    const active = pointer.dataDir || DEFAULT_USERDATA
    if (!samePath(toClean, active)) {
      cleanupOldDir(toClean)
    }
    pointer = { ...pointer, cleanupDir: undefined }
    writePointer(pointer)
  }

  // 2. 一次性数据迁移：若检测到历史默认目录 SFTerm 有数据、且当前默认目录为空，
  //    复用 pendingMigration 流程自动迁移（仅 dev 环境改名后首次启动会命中）。
  //    迁移完成后会写 pendingMigration 并把 userData 临时指向旧目录，后续由
  //    runStartupMigrationIfNeeded 完成复制 + 重启。
  migrateLegacyDefaultDataDir()
  pointer = readPointer()
  if (pointer.pendingMigration) return // 等待 runStartupMigrationIfNeeded 接管

  // 3. 应用自定义目录重定向（pending 时也要指向当前生效目录，作为迁移源）
  if (pointer.dataDir && !samePath(pointer.dataDir, DEFAULT_USERDATA)) {
    try {
      fs.mkdirSync(pointer.dataDir, { recursive: true })
      app.setPath('userData', pointer.dataDir)
    } catch (e) {
      console.error('[bootstrap] 重定向 userData 失败，回退默认目录:', e)
    }
  }
}

// ==================== 立即执行（模块副作用） ====================
applyDataDirRedirect()

// ==================== 对外查询/操作 API ====================

export interface DataDirInfo {
  /** 当前生效的数据目录 */
  current: string
  /** 默认数据目录 */
  default: string
  /** 是否使用了自定义目录 */
  isCustom: boolean
  /** 上一次迁移失败信息（读取后即清除） */
  lastError?: string
}

/** 获取数据目录信息，并清除残留的 lastError */
export function getDataDirInfo(): DataDirInfo {
  const pointer = readPointer()
  const current = app.getPath('userData')
  const info: DataDirInfo = {
    current,
    default: DEFAULT_USERDATA,
    isCustom: !samePath(current, DEFAULT_USERDATA),
    lastError: pointer.lastError
  }
  if (pointer.lastError) {
    writePointer({ ...pointer, lastError: undefined })
  }
  return info
}

export interface MigrationRequestResult {
  ok: boolean
  error?: string
}

/**
 * 校验目标目录是否可作为迁移目的地。
 */
function validateTarget(target: string): MigrationRequestResult {
  if (!target || !path.isAbsolute(target)) {
    return { ok: false, error: 'invalid_path' }
  }
  const source = app.getPath('userData')
  if (samePath(target, source)) {
    return { ok: false, error: 'same_as_current' }
  }
  // 目标不能在源内部，源也不能在目标内部（否则复制/清理会自我吞噬）
  if (isInside(source, target) || isInside(target, source)) {
    return { ok: false, error: 'nested' }
  }
  // 可写性检查：尝试创建目录并写入探针
  try {
    fs.mkdirSync(target, { recursive: true })
    const probe = path.join(target, '.sft-write-probe')
    fs.writeFileSync(probe, '')
    fs.rmSync(probe, { force: true })
  } catch {
    return { ok: false, error: 'not_writable' }
  }
  return { ok: true }
}

/** 目标目录是否非空（用于前端提示混入风险） */
export function isTargetNonEmpty(target: string): boolean {
  try {
    return fs.existsSync(target) && fs.readdirSync(target).length > 0
  } catch {
    return false
  }
}

/**
 * 请求迁移到目标目录：仅校验并写入 pending 标记，由调用方触发重启。
 */
export function requestDataDirMigration(target: string): MigrationRequestResult {
  const result = validateTarget(target)
  if (!result.ok) return result
  const pointer = readPointer()
  writePointer({ ...pointer, pendingMigration: { target: path.resolve(target) } })
  return { ok: true }
}

/**
 * 请求恢复到默认数据目录。若当前已是默认目录则无需操作。
 */
export function requestDataDirReset(): MigrationRequestResult {
  const current = app.getPath('userData')
  if (samePath(current, DEFAULT_USERDATA)) {
    return { ok: false, error: 'already_default' }
  }
  const pointer = readPointer()
  writePointer({ ...pointer, pendingMigration: { target: DEFAULT_USERDATA } })
  return { ok: true }
}

/** 是否存在待执行的迁移 */
export function hasPendingMigration(): boolean {
  return !!readPointer().pendingMigration
}

// ==================== 迁移 / 恢复执行（进度窗 + 复制） ====================

type ProgressWindowKind = 'migrate' | 'restore'

function progressWindowHtml(kind: ProgressWindowKind): string {
  const zh = app.getLocale().toLowerCase().startsWith('zh')
  const title = kind === 'restore'
    ? (zh ? '正在恢复数据…' : 'Restoring data…')
    : (zh ? '正在迁移数据…' : 'Migrating data…')
  const sub = kind === 'restore'
    ? (zh ? '可取消；取消后保留原有数据' : 'You can cancel; original data is kept')
    : (zh ? '请勿关闭应用' : 'Please do not close the app')
  const cancelLabel = zh ? '取消' : 'Cancel'
  const cancelBtn = kind === 'restore'
    ? `<button id="cancel" type="button" style="margin-top:14px;align-self:flex-start;padding:6px 14px;border:1px solid #4a4a55;border-radius:6px;background:#2a2a32;color:#e6e6ea;cursor:pointer;font-size:12px">${cancelLabel}</button>`
    : ''
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;height:100%;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
      background:#1e1e24;color:#e6e6ea;user-select:none;-webkit-user-select:none;overflow:hidden}
    .wrap{height:100%;display:flex;flex-direction:column;justify-content:center;padding:0 28px;box-sizing:border-box}
    .title{font-size:15px;font-weight:600;margin-bottom:4px}
    .sub{font-size:12px;color:#9a9aa5;margin-bottom:18px}
    .bar{height:8px;background:#34343c;border-radius:6px;overflow:hidden}
    .fill{height:100%;width:0;background:linear-gradient(90deg,#4f8cff,#a855f7);border-radius:6px;transition:width .15s ease}
    .meta{display:flex;justify-content:space-between;margin-top:10px;font-size:11px;color:#9a9aa5}
    .file{max-width:70%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left}
  </style></head><body><div class="wrap">
    <div class="title">${title}</div>
    <div class="sub">${sub}</div>
    <div class="bar"><div class="fill" id="fill"></div></div>
    <div class="meta"><span class="file" id="file"></span><span id="pct">0%</span></div>
    ${cancelBtn}
  </div><script>
    window.__cancelRequested=false;
    window.__setProgress=function(pct,name){
      document.getElementById('fill').style.width=pct+'%';
      document.getElementById('pct').textContent=pct+'%';
      if(name!=null)document.getElementById('file').textContent=name;
    };
    var btn=document.getElementById('cancel');
    if(btn)btn.onclick=function(){window.__cancelRequested=true;btn.disabled=true;};
  </script></body></html>`
}

function createProgressWindow(kind: ProgressWindowKind = 'migrate'): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 460,
    height: kind === 'restore' ? 240 : 200,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    center: true,
    show: true,
    backgroundColor: '#1e1e24',
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  })
  const html = progressWindowHtml(kind)
  return new Promise((resolve) => {
    win.webContents.once('did-finish-load', () => resolve(win))
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  })
}

function setProgress(win: BrowserWindow | null, pct: number, name: string): Promise<unknown> {
  if (!win || win.isDestroyed()) return Promise.resolve()
  const safeName = JSON.stringify(name)
  return win.webContents.executeJavaScript(`window.__setProgress(${pct}, ${safeName})`).catch(() => {})
}

async function isProgressCanceled(win: BrowserWindow | null): Promise<boolean> {
  if (!win || win.isDestroyed()) return false
  try {
    return !!(await win.webContents.executeJavaScript('window.__cancelRequested===true'))
  } catch {
    return false
  }
}

async function copyWithProgress(
  source: string,
  target: string,
  win: BrowserWindow | null,
  options?: { allowCancel?: boolean; skipNames?: string[] },
): Promise<void> {
  const cancelFlag = { current: false }
  await copyDirectoryWithProgress({
    source,
    target,
    skipNames: options?.skipNames ?? [POINTER_FILENAME],
    shouldCancel: options?.allowCancel ? () => cancelFlag.current : undefined,
    onProgress: async (p) => {
      if (options?.allowCancel && win) {
        cancelFlag.current = await isProgressCanceled(win)
        if (cancelFlag.current) throw new CopyCanceledError()
      }
      await setProgress(win, p.pct, p.file)
    },
  })
}

function relaunchApp(copiedUserDataDir?: string): void {
  // app.exit 走不到 quit，必须先留下正常退出标记，否则下次启动会当成崩溃。
  // 只写当前这一边的标记，避免开发态和正式版同时开着时把另一边抹成「正常退出」。
  const stateFile = app.isPackaged ? PACKAGED_STATE_FILE : DEV_STATE_FILE
  new CrashRecorder(
    path.join(app.getPath('userData'), 'diagnostics'),
    app.getVersion(),
    process.platform,
    stateFile,
  ).markCleanExit()
  if (copiedUserDataDir) {
    markCleanExitInDir(path.join(copiedUserDataDir, 'diagnostics'), app.getVersion())
  }
  app.relaunch()
  app.exit(0)
}

/**
 * 请求完整恢复：校验备份压缩包并写入 pendingRestore，由调用方 relaunch。
 */
export async function requestFullRestore(backupPath: string): Promise<MigrationRequestResult> {
  const validated = await validateBackupArchive(backupPath)
  if (!validated.ok) {
    return { ok: false, error: validated.error }
  }
  const resolved = path.resolve(backupPath)
  const userData = app.getPath('userData')
  // 压缩包不能位于当前 userData 内（恢复时会搬移/替换该目录）
  if (samePath(resolved, userData) || isInside(userData, resolved)) {
    return { ok: false, error: 'nested' }
  }
  const pointer = readPointer()
  // 与迁移互斥
  if (pointer.pendingMigration) {
    return { ok: false, error: 'migration_pending' }
  }
  writePointer({
    ...pointer,
    pendingRestore: { backupPath: resolved },
    lastError: undefined,
  })
  return { ok: true }
}

/**
 * 启动早期执行完整恢复（若有 pendingRestore）。
 *
 * 流程：压缩包 → staging（可取消）→ 成功则替换 userData 并 relaunch；
 * 取消/失败则删 staging、清 pending，**原 userData 不动**，继续启动。
 *
 * @returns 若触发了 relaunch 返回 true
 */
export async function runStartupRestoreIfNeeded(): Promise<boolean> {
  const userData = app.getPath('userData')
  // 无论是否有 pending：先处理上次崩溃残留
  if (recoverInterruptedRestore(userData)) {
    console.warn('[bootstrap] 检测到中断的恢复，已从 .restore-old 回滚')
  }

  const pointer = readPointer()
  if (!pointer.pendingRestore) return false
  // 与迁移互斥：若同时有 pendingMigration，优先迁移，本轮跳过 restore
  if (pointer.pendingMigration) return false

  const backupPath = pointer.pendingRestore.backupPath
  const staging = path.join(userData, RESTORE_STAGING_DIRNAME)
  let win: BrowserWindow | null = null

  const clearPending = (lastError?: string) => {
    const prev = readPointer()
    writePointer({
      dataDir: prev.dataDir,
      cleanupDir: prev.cleanupDir,
      legacyMigrationDone: prev.legacyMigrationDone,
      lastError,
    })
  }

  try {
    const validated = await validateBackupArchive(backupPath)
    if (!validated.ok) {
      clearPending(validated.error)
      return false
    }

    if (fs.existsSync(staging)) {
      fs.rmSync(staging, { recursive: true, force: true })
    }

    win = await createProgressWindow('restore')
    const cancelFlag = { current: false }
    await extractBackupToStaging({
      archive: backupPath,
      staging,
      shouldCancel: () => cancelFlag.current,
      onProgress: async (p) => {
        if (win) {
          cancelFlag.current = await isProgressCanceled(win)
          if (cancelFlag.current) throw new CopyCanceledError()
        }
        await setProgress(win, p.pct, p.file)
      },
    })

    replaceUserDataFromStaging(userData, staging, {
      keepNames: [POINTER_FILENAME, RESTORE_STAGING_DIRNAME, RESTORE_OLD_DIRNAME],
    })
    clearPending()
    if (win && !win.isDestroyed()) win.destroy()
    relaunchApp()
    return true
  } catch (e) {
    const canceled = e instanceof CopyCanceledError
    console.error('[bootstrap] 数据恢复失败:', e)
    // 取消/失败：原数据应仍在（或已由 replace 内部回滚）；清理半成品 staging
    try {
      if (fs.existsSync(staging)) {
        fs.rmSync(staging, { recursive: true, force: true })
      }
    } catch { /* ignore */ }
    recoverInterruptedRestore(userData)
    clearPending(canceled ? 'restore_canceled' : String((e as Error)?.message ?? e))
    if (win && !win.isDestroyed()) win.destroy()
    return false
  }
}

/**
 * 在启动早期执行待迁移任务（若有）。
 *
 * 必须在 `app.whenReady()` 之后、且在创建主窗口 / 初始化 sensor / watch / agent
 * 等一切重活之前调用。期间源目录无任何运行时写入，保证复制数据一致。
 *
 * @returns 若执行了迁移并触发了重启，返回 true（调用方应立即 return，停止后续初始化）
 */
export async function runStartupMigrationIfNeeded(): Promise<boolean> {
  const pointer = readPointer()
  if (!pointer.pendingMigration) return false

  const source = app.getPath('userData') // 已在 require 期重定向到当前生效目录
  const target = pointer.pendingMigration.target
  // 记录复制前目标是否已有内容：失败回滚时不能删用户原有的文件
  const targetPreexisted = isTargetNonEmpty(target)
  let win: BrowserWindow | null = null

  try {
    win = await createProgressWindow()
    await copyWithProgress(source, target, win)

    // 复制成功：更新指针，记录旧目录待清理，清除 pending
    const isDefaultTarget = samePath(target, DEFAULT_USERDATA)
    // 若目标是默认目录且源是 legacy 目录，标记 legacy 迁移已完成，
    // 避免下次启动因目录非空而误判（legacyMigrationDone 是显式标记，不依赖目录状态）
    const isLegacyMigration = isDefaultTarget && samePath(source, LEGACY_DEFAULT_USERDATA)
    writePointer({
      dataDir: isDefaultTarget ? undefined : path.resolve(target),
      cleanupDir: samePath(source, target) ? undefined : source,
      legacyMigrationDone: isLegacyMigration || undefined
    })

    if (win && !win.isDestroyed()) win.destroy()
    relaunchApp(target)
    return true
  } catch (e) {
    console.error('[bootstrap] 数据迁移失败:', e)
    // 失败回滚：仅当目标是“我们新建的空目录”时才删除残留，
    // 否则（默认目录 / 用户原本就非空的目录）保留，避免误删用户文件。
    try {
      if (!samePath(target, DEFAULT_USERDATA) && !targetPreexisted) {
        fs.rmSync(target, { recursive: true, force: true })
      }
    } catch { /* ignore */ }
    const prev = readPointer()
    writePointer({ dataDir: prev.dataDir, lastError: String((e as Error)?.message ?? e) })
    if (win && !win.isDestroyed()) win.destroy()
    return false // 在原目录上继续正常启动
  }
}
