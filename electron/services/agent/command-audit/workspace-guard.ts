/**
 * 工作区路径分区与系统路径守卫
 *
 * C 方案分区：
 * - free       scratch/、charts/、系统临时目录（os.tmpdir /tmp 等）— 读写删免确认
 * - protected  templates/、根目录人格配置 md — 写删需确认
 * - workspace  工作区内其他 — 写删需确认
 * - outside    工作区外 - safe 命令（如 cp）不升级；moderate/dangerous 保持原等级
 *
 * 系统路径分级（仅对写操作生效）：
 * - critical  /、/boot - 写 -> blocked（硬墙，不可逆系统灾难）
 * - hardened  /etc、/dev、/sys、/proc、/System 等 - 写 -> dangerous（弹确认放行）
 * - /dev/null、/dev/stdout、/dev/stderr 黑洞设备 -> 豁免，写它们等于丢弃输出
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { RiskLevel } from '@shared/types/agent'
import { t } from '../i18n'
import {
  getWorkspacePath,
  isInWorkspace,
} from '../tools/file'
import {
  DEV_NULL_EXEMPTIONS,
  PROTECTED_WORKSPACE_DIRS,
  PROTECTED_WORKSPACE_FILES,
  SYSTEM_PATH_PATTERNS,
  WORKSPACE_FREE_DIRS,
  type WorkspaceZone,
} from './types'
import { basenameCommand } from './whitelist'
import { isUserDataForbidden } from './userdata-guard'
import { unescapeShellWordLiteral } from './unescape-shell-literal'

/** 只改权限/属主：在 critical 路径上可恢复，不硬拒 */
const ATTR_CHANGE_COMMANDS = new Set(['chmod', 'chown', 'chgrp'])

function isAttrChangeCommand(cmd?: string): boolean {
  if (!cmd) return false
  return ATTR_CHANGE_COMMANDS.has(basenameCommand(cmd).toLowerCase())
}

/** 展开 ~ / ~/…（与 file 工具一致；不展开 ~user） */
function expandTilde(filePath: string): string {
  if (filePath === '~') return os.homedir()
  if (filePath.startsWith('~/') || filePath.startsWith('~\\')) {
    return path.join(os.homedir(), filePath.slice(2))
  }
  return filePath
}

/**
 * 路径是否「词法上绝对」——不依赖 cwd 即可定位：
 * `/…`、`~/…`、Windows 盘符 / UNC。
 *
 * 自由区降级（写/删 → safe）只认此类路径；相对路径无法静态证明
 * 执行时仍在 scratch（`cd && rm foo` 会骗过按审计 cwd 的解析）。
 */
export function isLexicallyAbsolutePath(rawPath: string): boolean {
  const cleaned = unescapeShellWordLiteral(rawPath.trim())
  if (!cleaned) return false
  if (cleaned === '~' || cleaned.startsWith('~/') || cleaned.startsWith('~\\')) return true
  return path.isAbsolute(cleaned)
}

/**
 * 解析命令参数路径（供分区 / userData 守卫）：
 * 1. 解开 shell 反斜杠转义（Application\ Support）
 * 2. 展开 ~（避免 ~/Desktop 被当成 scratch 下相对路径误入 free 区）
 * 3. 相对路径相对 cwd 解析（cwd 缺省时用 process.cwd()）
 */
export function resolveCommandPath(rawPath: string, cwd?: string): string {
  const cleaned = expandTilde(unescapeShellWordLiteral(rawPath))
  const base = cwd ? path.resolve(cwd) : process.cwd()
  return path.resolve(base, cleaned)
}

/** 规范化路径用于比较（统一斜杠、去掉尾部 /） */
function normalizePathForCompare(p: string): string {
  let n = p.replace(/\\/g, '/')
  if (n.length > 1 && n.endsWith('/')) n = n.slice(0, -1)
  return n
}

/** 尝试 realpath；文件不存在时沿父目录回退（与 file.ts 一致） */
function resolveRealPath(filePath: string): string {
  let resolved = path.resolve(filePath)
  try {
    return fs.realpathSync(resolved)
  } catch {
    let dir = path.dirname(resolved)
    while (dir !== path.dirname(dir)) {
      try {
        const realDir = fs.realpathSync(dir)
        resolved = path.join(realDir, path.relative(dir, resolved))
        break
      } catch {
        dir = path.dirname(dir)
      }
    }
    return resolved
  }
}

/** 路径字面量里有花括号：可能是要等 shell 展开的花括号展开（宁可多认，认错只是多问一次） */
function hasBraceExpansion(p: string): boolean {
  return /[{}]/.test(p)
}

/**
 * `cd 绝对路径 &&` 定下的当前目录 → 真实目录（展开 ~、跟随符号链接）。
 * 后面的相对路径按这个真实目录解析：内核解析相对路径用的是进程所在的真实目录，
 * 不是 shell 里记的逻辑目录，所以符号链接必须先跟随。
 */
export function resolveAnchorDir(dir: string): string {
  // dir 已经由提取那一步去过转义，这里不能再去一次（目录名里的反斜杠会被吃掉，指到另一个目录）
  return resolveRealPath(path.resolve(expandTilde(dir)))
}

function getRelativeWorkspacePath(filePath: string): string | null {
  if (!isInWorkspace(filePath)) return null
  let workspace: string
  try {
    workspace = fs.realpathSync(getWorkspacePath())
  } catch {
    workspace = getWorkspacePath()
  }
  const rel = path.relative(workspace, resolveRealPath(filePath))
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null
  return rel.replace(/\\/g, '/')
}

/**
 * 工作区路径分区（优先于命令白名单）
 */
export function getWorkspaceZone(
  targetPath: string,
  cwd?: string,
  extraFreeDirs: string[] = [],
): WorkspaceZone {
  const resolved = resolveRealPath(resolveCommandPath(targetPath, cwd))
  if (isExtraFreeDir(resolved, extraFreeDirs)) return 'free'
  // 系统临时目录（/tmp、os.tmpdir 等）与 scratch 同级：读写删免确认
  if (isSystemTempPath(resolved)) return 'free'
  if (!isInWorkspace(resolved)) return 'outside'

  const rel = getRelativeWorkspacePath(resolved)
  if (!rel) return 'outside'

  const first = rel.split('/')[0]
  if ((WORKSPACE_FREE_DIRS as readonly string[]).includes(first)) return 'free'
  if (PROTECTED_WORKSPACE_DIRS.has(first)) return 'protected'
  if (PROTECTED_WORKSPACE_FILES.has(rel)) return 'protected'

  return 'workspace'
}

/** 内置临时目录根（realpath 后缓存；含 /tmp 与 os.tmpdir，macOS 上二者常不同） */
let cachedTempRoots: string[] | null = null

/** 供设置页只读展示 */
export function getBuiltinTempRoots(): string[] {
  return [...getTempRoots()]
}

/**
 * 内置自由区目录：工作区里的 scratch/charts/migrations + 系统临时目录。
 * 设置页展示和评审员的「事先放开的目录」共用这一份，与 getWorkspaceZone 的判定同源。
 */
export function getBuiltinFreeDirs(): string[] {
  const workspace = getWorkspacePath()
  return [
    ...[...WORKSPACE_FREE_DIRS].map(d => path.join(workspace, d)).sort(),
    ...getTempRoots(),
  ]
}

/** 免确认的全部目录：内置自由区 + 用户在设置里加的额外自由区（去重，原样保留用户写的路径） */
export function listFreeZoneDirs(extraFreeDirs: readonly string[] = []): string[] {
  const extra = extraFreeDirs.filter(d => typeof d === 'string' && d.trim()).map(d => d.trim())
  return [...new Set([...getBuiltinFreeDirs(), ...extra])]
}

function getTempRoots(): string[] {
  if (cachedTempRoots) return cachedTempRoots
  const roots = new Set<string>()
  const add = (raw: string | undefined) => {
    if (!raw || !String(raw).trim()) return
    try {
      roots.add(normalizePathForCompare(resolveRealPath(path.resolve(raw))))
    } catch {
      roots.add(normalizePathForCompare(path.resolve(raw)))
    }
  }
  add(os.tmpdir())
  add(process.env.TMPDIR)
  add(process.env.TMP)
  add(process.env.TEMP)
  if (process.platform !== 'win32') {
    add('/tmp')
    add('/private/tmp')
    add('/var/tmp')
  }
  cachedTempRoots = [...roots].filter(Boolean)
  return cachedTempRoots
}

function isSystemTempPath(resolvedPath: string): boolean {
  const normalized = normalizePathForCompare(resolvedPath)
  for (const root of getTempRoots()) {
    if (!root) continue
    if (normalized === root || normalized.startsWith(root + '/') || normalized.startsWith(root + '\\')) {
      return true
    }
  }
  return false
}

/** 测试用：清临时目录根缓存 */
export function resetBuiltinTempRootsCacheForTest(): void {
  cachedTempRoots = null
}

/** 用户配置的额外自由区（绝对路径前缀匹配） */
function isExtraFreeDir(resolvedPath: string, extraFreeDirs: string[]): boolean {
  if (!extraFreeDirs.length) return false
  const normalized = normalizePathForCompare(resolvedPath)
  for (const dir of extraFreeDirs) {
    let freeRoot: string
    try {
      freeRoot = normalizePathForCompare(resolveRealPath(dir))
    } catch {
      freeRoot = normalizePathForCompare(dir)
    }
    if (!freeRoot) continue
    if (normalized === freeRoot || normalized.startsWith(freeRoot.endsWith('/') ? freeRoot : freeRoot + '/')) {
      return true
    }
    // Windows 路径分隔
    if (normalized === freeRoot || normalized.startsWith(freeRoot + '\\')) {
      return true
    }
  }
  return false
}

/**
 * 系统路径严重程度（写操作判定用）。
 * - critical：写 -> blocked（硬墙）
 * - hardened：写 -> dangerous（弹确认放行）
 * - null：非系统路径
 */
export function getSystemPathSeverity(targetPath: string, cwd?: string): 'critical' | 'hardened' | null {
  const abs = resolveCommandPath(targetPath, cwd)
  const resolved = normalizePathForCompare(resolveRealPath(abs))
  const unresolved = normalizePathForCompare(abs)
  for (const p of SYSTEM_PATH_PATTERNS) {
    if (p.pattern.test(resolved) || p.pattern.test(unresolved)) {
      return p.severity
    }
  }
  return null
}

/**
 * 系统关键路径（写操作 hard block）
 *
 * @deprecated 语义混淆：把「系统路径」和「userData 禁区」两件事揉在一起。
 * 调用方需要 severity 时应直接用 getSystemPathSeverity；需要 userData 检查时用 isUserDataForbidden。
 * 保留仅为向后兼容（测试用）。
 */
export function isSystemPath(targetPath: string, cwd?: string): boolean {
  if (getSystemPathSeverity(targetPath, cwd) !== null) return true
  return isUserDataForbidden(targetPath, cwd)
}

/**
 * 是否为黑洞/标准流设备（写它等于丢弃或重定向输出，完全无害）。
 * 仅对写重定向目标有意义，不判定命令参数。
 */
function isDevNullPath(targetPath: string, cwd?: string): boolean {
  const abs = resolveCommandPath(targetPath, cwd)
  const resolved = normalizePathForCompare(resolveRealPath(abs))
  const unresolved = normalizePathForCompare(abs)
  return DEV_NULL_EXEMPTIONS.some(p => p === resolved || p === unresolved)
}

/**
 * 写/删类命令：根据路径分区调整风险
 *
 * userData 禁区：凭据等读+写都 blocked；日志/会话历史只拦写。
 * 只读命令（writesTo=false）不走系统路径/工作区分区判定，保持 commandLevel。
 *
 * 写路径分级（取最严）：
 * 1. userData 禁区 -> blocked（写一律拦；读仅拦非只读白名单）
 * 2. 黑洞设备（/dev/null 等）-> 从写路径判定中豁免（写它们无害）
 * 3. critical 系统路径（/、/boot）：删/覆写 -> blocked；改权限或属主 -> dangerous
 * 4. hardened 系统路径（/etc、/dev、/sys 等）-> dangerous（弹确认放行）
 * 5. 工作区 free -> safe（仅词法绝对路径）；protected/workspace -> moderate；
 *    outside 不升级 safe 命令。相对路径即使按 cwd 落在 free，也按 outside 处理（不降级）。
 *
 * @param commandLevel 命令本身的风险等级（白名单 + flag 判定后）
 * @param allPaths 命令参数路径 + 写重定向路径（用于 userData 检查）
 * @param writePaths 真正的写路径（命令写时含参数路径 + 写重定向；只读时仅写重定向）
 * @param writesTo 是否涉及写操作（命令写 或 有写重定向）
 * @param cwd 工作目录
 * @param opts 用户策略：outside 升级、额外自由区；cmd 区分改权限/属主与删覆写；
 *   redirectWritePaths 为写重定向目标（命中 critical 一律硬拒，不因 chmod 降级）
 */
export function adjustRiskByPathZones(
  commandLevel: RiskLevel,
  allPaths: string[],
  writePaths: string[],
  writesTo: boolean,
  cwd?: string,
  opts?: {
    outsideWritesUpgrade?: boolean
    extraFreeDirs?: string[]
    cmd?: string
    redirectWritePaths?: string[]
    /** cwd 是 `cd 绝对路径 &&` 定下的真实目录：相对路径的位置也能静态确定，视同绝对路径 */
    cwdAnchored?: boolean
  },
): { level: RiskLevel; zones: WorkspaceZone[]; reasons: string[] } {
  const reasons: string[] = []
  const extraFreeDirs = opts?.extraFreeDirs ?? []

  // userData 禁区：写走写权限，读走读权限（日志/历史可读、不可改）
  const userdataHit =
    writePaths.some(p => isUserDataForbidden(p, cwd, 'write'))
    || allPaths.some(p => isUserDataForbidden(p, cwd, 'read'))
  if (userdataHit) {
    return {
      level: 'blocked',
      zones: allPaths.map(p => getWorkspaceZone(p, cwd, extraFreeDirs)),
      reasons: [t('risk.reason.userdata_protected')],
    }
  }

  if (!writesTo || writePaths.length === 0) {
    return { level: commandLevel, zones: [], reasons }
  }

  // 黑洞设备豁免：写 /dev/null 等无害，单独剔除不参与系统路径判定
  const nonDevNullPaths = writePaths.filter(p => !isDevNullPath(p, cwd))
  const zones = writePaths.map(p => getWorkspaceZone(p, cwd, extraFreeDirs))

  // 所有写路径都是黑洞设备 -> 直接 safe（写 /dev/null 等于丢弃输出）
  if (nonDevNullPaths.length === 0) {
    return { level: 'safe', zones, reasons: [t('risk.reason.devnull_safe')] }
  }

  // 写重定向覆写 critical：一律硬拒（chmod … > /boot/foo 不是改权限）
  const redirectWrites = opts?.redirectWritePaths ?? []
  const criticalRedirect = redirectWrites.find(
    p => !isDevNullPath(p, cwd) && getSystemPathSeverity(p, cwd) === 'critical',
  )
  if (criticalRedirect) {
    return {
      level: 'blocked',
      zones,
      reasons: [t('risk.reason.system_critical_blocked')],
    }
  }

  // critical 系统路径：删/覆写硬拒；改权限或属主先确认
  const criticalHit = nonDevNullPaths.find(p => getSystemPathSeverity(p, cwd) === 'critical')
  if (criticalHit) {
    if (isAttrChangeCommand(opts?.cmd)) {
      return {
        level: 'dangerous',
        zones,
        reasons: [t('risk.reason.system_critical_attr')],
      }
    }
    return {
      level: 'blocked',
      zones,
      reasons: [t('risk.reason.system_critical_blocked')],
    }
  }

  // hardened 系统路径 -> dangerous（弹确认放行）
  const hardenedHit = nonDevNullPaths.find(p => getSystemPathSeverity(p, cwd) === 'hardened')
  if (hardenedHit) {
    return {
      level: 'dangerous',
      zones,
      reasons: [t('risk.reason.system_hardened')],
    }
  }

  const effectiveZones = nonDevNullPaths.map(p => getWorkspaceZone(p, cwd, extraFreeDirs))
  // 相对路径无法静态证明执行时 cwd：即便按审计 cwd 落在 free，也不允许降级为 safe。
  // pathZones 返回 policyZones（与 level 决策一致），避免「显示 free、实际按 outside」误导调试。
  // 花括号展开（`{a,b}`、`{x,../../y}`）要等 shell 展开才知道真正的目标，字面上的路径不可信：
  // `rm -rf /tmp/{x,../../Users/me/Desktop/foo}` 按字面落在 /tmp，实际会删到桌面。
  const locationKnown = (p: string) =>
    !hasBraceExpansion(p) && (opts?.cwdAnchored === true || isLexicallyAbsolutePath(p))
  const relativeBlocksFree = nonDevNullPaths.some(
    (p, i) => effectiveZones[i] === 'free' && !locationKnown(p),
  )
  const policyZones: WorkspaceZone[] = nonDevNullPaths.map((p, i) => {
    const z = effectiveZones[i]!
    if (z === 'free' && !locationKnown(p)) return 'outside'
    return z
  })

  if (policyZones.every(z => z === 'free')) {
    reasons.push(t('risk.reason.workspace_free'))
    return { level: 'safe', zones: policyZones, reasons }
  }
  // outside：默认不升级 safe 命令（如 cp）；开启 outsideWritesUpgrade 时升为 moderate
  if (policyZones.some(z => z === 'outside')) {
    if (relativeBlocksFree) {
      const braces = nonDevNullPaths.some((p, i) => effectiveZones[i] === 'free' && hasBraceExpansion(p))
      reasons.push(t(braces ? 'risk.reason.brace_write_path' : 'risk.reason.relative_write_path'))
    }
    if (commandLevel === 'safe' && opts?.outsideWritesUpgrade) {
      reasons.push(t('risk.reason.workspace_outside_upgrade'))
      return { level: 'moderate', zones: policyZones, reasons }
    }
    // 命令本身已是 moderate/dangerous 时，不附「工作区外需确认」文案（确认主因是命令基线）
    return { level: commandLevel, zones: policyZones, reasons }
  }
  if (policyZones.some(z => z === 'protected')) {
    reasons.push(t('risk.reason.workspace_protected'))
    return { level: 'moderate', zones: policyZones, reasons }
  }
  if (policyZones.some(z => z === 'workspace')) {
    reasons.push(t('risk.reason.workspace_inside'))
    return { level: 'moderate', zones: policyZones, reasons }
  }

  return { level: commandLevel, zones: policyZones, reasons }
}
