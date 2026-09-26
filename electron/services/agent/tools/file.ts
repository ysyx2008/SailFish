/**
 * 文件操作工具
 * 包括：文件搜索、读取文件、编辑文件、写入本地文件、写入远程文件
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { t } from '../i18n'
import { getTerminalStateService } from '../../terminal-state.service'
import { getFileSearchService } from '../../file-search.service'
import { getDocumentParserService } from '../../document-parser.service'
import { getConfigService } from '../../config.service'
import iconv from 'iconv-lite'
import { decodeBuffer, detectEncoding } from '../../../utils/encoding'
import { createLogger } from '../../../utils/logger'
import { categorizeError, getErrorRecoverySuggestion, truncateFromEnd, truncateSandwichWithNotice, formatFileSize } from './utils'
import type { ToolExecutorConfig, AgentConfig, ToolResult } from './types'
import type { AgentContext } from '../types'
import type { ToolOutputBudget } from '../tool-output-budget'
import type { CanvasData } from '@shared/types'
import { VISION_IMAGE_EXTENSIONS, IMAGE_MIME_TYPES, CONVERTIBLE_IMAGE_EXTENSIONS } from './types'
import { isUserDataForbidden, type UserDataAccess } from '../command-audit/userdata-guard'
import { isHardBlocked, riskNeedsConfirm } from '../command-audit/confirm-policy'
import { getSystemPathSeverity, getWorkspaceZone } from '../command-audit/workspace-guard'
import type { RiskLevel } from '@shared/types/agent'
import { getWorkspacePath, getScratchPath } from '../workspace-paths'
import { isAbortError } from '../../../utils/abort'
import { externalizeToolOutput, externalizeFailedError } from '../tool-output-externalize'

// 兼容 re-export：既有调用方从 tools/file 取路径不变；唯一定义在 workspace-paths.ts
export { getWorkspacePath, getScratchPath }

const DEFAULT_READ_OUTPUT_BUDGET: ToolOutputBudget = {
  maxChars: 24_576,
  maxLines: 500,
  critical: false,
  usagePercent: 0,
}

function getReadOutputBudget(executor: ToolExecutorConfig): ToolOutputBudget {
  return executor.getToolOutputBudget?.() ?? DEFAULT_READ_OUTPUT_BUDGET
}

type ReadLineCapMode = 'head' | 'tail' | 'range'

function capReadLines(
  lines: string[],
  budget: ToolOutputBudget,
  mode: ReadLineCapMode
): { lines: string[]; capped: boolean } {
  if (lines.length <= budget.maxLines) {
    return { lines, capped: false }
  }
  if (mode === 'tail') {
    return { lines: lines.slice(-budget.maxLines), capped: true }
  }
  return { lines: lines.slice(0, budget.maxLines), capped: true }
}

/** 按上下文预算截断 read_file 返回给 AI 的正文（含行号） */
function applyReadFileOutputBudget(
  numberedContent: string,
  filePath: string,
  executor: ToolExecutorConfig
): string {
  const budget = getReadOutputBudget(executor)

  if (budget.maxChars <= 0) {
    return t('file.read_context_exhausted', {
      usagePercent: budget.usagePercent,
      path: filePath,
    })
  }

  if (numberedContent.length <= budget.maxChars) {
    if (budget.critical) {
      return `${numberedContent}\n\n${t('file.read_context_critical_hint', {
        usagePercent: budget.usagePercent,
      })}`
    }
    return numberedContent
  }

  return truncateSandwichWithNotice(
    numberedContent,
    budget.maxChars,
    (stats) => t('file.read_output_truncated', {
      path: filePath,
      total: String(stats.originalLength),
      head: String(stats.headChars),
      tail: String(stats.tailChars),
      omittedLines: String(stats.omittedLines),
      omittedChars: String(stats.omittedChars),
      usagePercent: budget.usagePercent,
    })
  )
}

/**
 * 文档解析结果（PDF/Word 提取文本）的预算处理：超预算时全文落盘 scratch 换指针，
 * 不做截断——解析文本不在磁盘上，截断即永久丢失，且 range 参数对解析内容不生效。
 * 落盘失败返回 error（明确报错 + 建议缩小范围），由调用方转成工具错误。
 */
async function applyDocumentOutputBudget(
  content: string,
  filePath: string,
  executor: ToolExecutorConfig
): Promise<{ text: string } | { error: string }> {
  const budget = getReadOutputBudget(executor)
  // 与普通文件读取路径一致：余量耗尽时先让 AI 压缩上下文，而不是落盘后只给无摘录的指针
  if (budget.maxChars <= 0) {
    return {
      error: t('file.read_context_exhausted', {
        usagePercent: budget.usagePercent,
        path: filePath,
      })
    }
  }
  try {
    const externalized = await externalizeToolOutput({ output: content, maxChars: budget.maxChars, toolName: 'read_file', excerpt: 'head' })
    if (externalized) return { text: externalized.text }
  } catch (err) {
    return { error: externalizeFailedError(content.length, err instanceof Error ? err.message : String(err)) }
  }
  // 预算内：保持原有高用量提示
  if (budget.critical) {
    return { text: `${content}\n\n${t('file.read_context_critical_hint', { usagePercent: budget.usagePercent })}` }
  }
  return { text: content }
}

/**
 * Agent 写入/编辑文本类文件后推送到独立助手 Canvas，供用户预览与本地保存。
 * - .md/.markdown → markdown 渲染器
 * - .html/.htm   → html 渲染器（iframe 直接预览页面）
 */
function previewCanvasDataForPath(filePath: string): CanvasData | undefined {
  let renderer: CanvasData['renderer'] | undefined
  if (/\.(md|markdown)$/i.test(filePath)) renderer = 'markdown'
  else if (/\.html?$/i.test(filePath)) renderer = 'html'
  if (!renderer) return undefined
  try {
    return {
      action: 'open',
      renderer,
      title: path.basename(filePath),
      content: fs.readFileSync(filePath, 'utf-8'),
      filePath,
      // content 即磁盘文件内容：历史持久化时剥离，恢复时按 filePath 读回（避免大文件撑爆历史）
      contentFromFile: true
    }
  } catch {
    return undefined
  }
}

/**
 * 人机双写：写入 .md/.html 成功后，若该文件在产出物面板有用户未保存修改，
 * 在工具输出追加提醒（不阻断）。非助手场景（CLI / 终端 tab）桥接查询快速失败，静默跳过。
 */
async function appendPanelDirtyNotice(
  output: string,
  filePath: string,
  previewCanvas: CanvasData | undefined,
  executor: ToolExecutorConfig
): Promise<string> {
  if (!previewCanvas || !executor.agentId) return output
  try {
    const { workbenchBridge } = await import('../../workbench-bridge.service')
    const result = await workbenchBridge.exec({ type: 'list_artifacts' }, executor.agentId)
    if (!result.ok) return output
    const snapshot = result.data as { artifacts?: Array<{ filePath: string | null; dirty?: boolean }> } | undefined
    const hit = snapshot?.artifacts?.find(a => a.filePath === filePath)
    if (!hit?.dirty) return output
    return `${output}\n\n${t('file.panel_dirty_notice')}`
  } catch {
    return output
  }
}

export function expandTilde(filePath: string): string {
  if (filePath === '~') return os.homedir()
  if (filePath.startsWith('~/') || filePath.startsWith('~\\')) {
    return path.join(os.homedir(), filePath.slice(2))
  }
  return filePath
}

/**
/**
 * 提示词里报给模型的当前目录（助手形态是默认执行目录，本地终端页是眼前那扇窗的目录），
 * 本机命令和本机文件工具都要兑现它。远程终端页报的是远端目录，不能当成本机目录。
 * 目录已不存在时不算数。
 */
export function announcedLocalCwd(context?: AgentContext): string | undefined {
  if (!context || context.terminalType === 'ssh' || !context.cwd) return undefined
  const cwd = expandTilde(context.cwd)
  if (!path.isAbsolute(cwd)) return undefined
  try {
    return fs.statSync(cwd).isDirectory() ? cwd : undefined
  } catch {
    return undefined
  }
}

/**
 * 本机文件工具的相对路径基准：技能给的工作目录（编程技能打开的项目）→ 本机终端的当前目录
 * → 助手宣称的默认目录 → 用户主目录。绝不拿远程 cwd 往本机上拼。
 */
export function resolveLocalFilePath(
  rawPath: string,
  terminal?: { type?: 'local' | 'ssh'; cwd?: string } | null,
  announcedCwd?: string,
  workingDirectory?: string,
): string {
  const expanded = expandTilde(rawPath.trim())
  if (!expanded || path.isAbsolute(expanded)) return expanded
  const base = workingDirectory ?? localFileCwd(terminal) ?? announcedCwd ?? os.homedir()
  return path.resolve(base, expanded)
}

function localFileCwd(terminal?: { type?: 'local' | 'ssh'; cwd?: string } | null): string | undefined {
  if (terminal?.type === 'local' && terminal.cwd) {
    const cwd = expandTilde(terminal.cwd)
    return path.isAbsolute(cwd) ? cwd : undefined
  }
  return undefined
}

/** 本机文件工具按这一次执行的上下文解析路径 */
export function resolveToolLocalPath(rawPath: unknown, ptyId: string, executor: ToolExecutorConfig): string {
  return resolveLocalFilePath(
    String(rawPath ?? ''),
    getTerminalStateService().getState(ptyId),
    announcedLocalCwd(executor.getAgentContext?.()),
    executor.skillSession?.getWorkingDirectory(),
  )
}

/**
 * 生成用于消息展示的简短路径：
 * - 在 home 之内：返回 ~/... 形式（保持可点击：前端 `isLocalFilePath` 识别 `~/`，主进程 IPC 展开 ~ 为绝对路径）
 * - 其它（含 cwd 之内）：返回原始绝对路径——避免 cwd 相对路径让 UI 失去点击打开能力
 *
 * 跨平台兼容：
 * - Windows 大小写不敏感 + AI 可能混用正/反斜杠：用 path.normalize 归一化分隔符，再 toLowerCase 比较
 * - 输出 home 简化路径时**统一使用正斜杠**：前端正则只识别 `~/`，且 macOS/Linux/Windows 显示 `~/foo/bar` 都自然
 * - 第二个参数 ptyId 已废弃但保留以避免破坏调用方签名（接近的将来可移除）
 */
function formatDisplayPath(filePath: string, _ptyId?: string): string {
  const isWin = process.platform === 'win32'
  const norm = (s: string): string => {
    const n = path.normalize(s)
    return isWin ? n.toLowerCase() : n
  }
  const isUnder = (p: string, dir: string): boolean => {
    const np = norm(p)
    const nd = norm(dir)
    if (np === nd) return true
    return np.startsWith(nd.endsWith(path.sep) ? nd : nd + path.sep)
  }

  const home = os.homedir()
  if (norm(filePath) === norm(home)) return '~'
  if (isUnder(filePath, home)) {
    // 用 path.relative 拿规范化后的相对部分；Windows 上反斜杠转为正斜杠以匹配 `~/` 形式
    const rel = path.relative(home, filePath)
    return '~/' + (isWin ? rel.replace(/\\/g, '/') : rel)
  }
  return filePath
}

/**
 * 生成 readFile 的"行号范围"短描述，用于 tool_call 卡片标题（如「读取文件: SPEC.md (第 10-80 行)」）。
 * info_only 走早期分支不读取内容，优先级最高；其余参数与 readFile 实际读取逻辑一致：start/end > max > tail > full。
 * 完整读取时返回空字符串，调用方应省略括号。
 */
function describeReadRange(opts: {
  infoOnly?: boolean
  startLine?: number
  endLine?: number
  maxLines?: number
  tailLines?: number
}): string {
  const { infoOnly, startLine, endLine, maxLines, tailLines } = opts
  if (infoOnly) return t('file.range_info_only')
  if (startLine !== undefined || endLine !== undefined) {
    // start clamp 到 1：与 readFile 内部 `Math.max(1, startLine) - 1` 行为一致，
    // 避免 AI 传 start_line=0 时显示「第 0 行」造成误导。
    return t('file.range_lines', {
      start: Math.max(1, startLine ?? 1),
      end: endLine ?? t('file.end_of_file')
    })
  }
  if (maxLines !== undefined) return t('file.range_first_n', { count: maxLines })
  if (tailLines !== undefined) return t('file.range_last_n', { count: tailLines })
  return ''
}

/**
 * 计算 [startOffset, endOffset) 字符切片在文本中的起止行号（从 1 开始）。
 * - startLine：startOffset 之前的换行数 + 1
 * - endLine：切片内换行数加到 startLine；若切片末尾恰好是 \n，行号不再 +1（避免把仅含整行末换行的片段算成 +1 行）
 * 用于 editFile 显示「编辑了第 X-Y 行」。
 */
function computeLineRange(content: string, startOffset: number, endOffset: number): { start: number, end: number } {
  const safeStart = Math.max(0, Math.min(startOffset, content.length))
  const safeEnd = Math.max(safeStart, Math.min(endOffset, content.length))
  let start = 1
  for (let i = 0; i < safeStart; i++) if (content.charCodeAt(i) === 10) start++
  let lineCount = 0
  for (let i = safeStart; i < safeEnd; i++) if (content.charCodeAt(i) === 10) lineCount++
  // 切片以 \n 结尾时，最后那个换行只是结束符不开新行：
  //   eg. "foo\nbar\n" 横跨第 N 与 N+1 两行，lineCount=2 → end=start+1，正确表达「第 N - N+1 行」。
  //   `lineCount > 0` 防止仅含单个 \n 的切片把行数减为负数。
  if (safeEnd > safeStart && content.charCodeAt(safeEnd - 1) === 10 && lineCount > 0) {
    lineCount--
  }
  return { start, end: start + lineCount }
}

/**
 * 读取文本文件，自动检测编码（UTF-8 / GBK / GB18030 / UTF-16 等）
 */
function readTextFileSync(filePath: string): string {
  return decodeBuffer(fs.readFileSync(filePath)).content
}

/**
 * 读取文本文件并返回编码信息，用于编辑后以原编码写回
 */
function readTextFileWithEncoding(filePath: string): { content: string, encoding: string } {
  return decodeBuffer(fs.readFileSync(filePath))
}

/**
 * 以指定编码写入文件。UTF-8 用 Node 原生，其他编码用 iconv-lite
 */
function writeTextFileSync(filePath: string, content: string, encoding: string): void {
  if (encoding === 'utf-8') {
    fs.writeFileSync(filePath, content, 'utf-8')
  } else {
    fs.writeFileSync(filePath, iconv.encode(content, encoding))
  }
}

/** workspace 根目录数据文件 — Agent 可维护，免确认 */
const AUTO_APPROVE_ROOT_FILENAMES = new Set([
  'CONTACTS.md', 'USER.md', 'HEARTBEAT.md', 'IDENTITY.md', 'SOUL.md',
])

/** 启动时确保 workspace 目录结构存在 */
export function ensureAgentWorkspaceDirs(): void {
  fs.mkdirSync(getWorkspacePath(), { recursive: true })
  fs.mkdirSync(getScratchPath(), { recursive: true })
  fs.mkdirSync(path.join(getWorkspacePath(), 'migrations'), { recursive: true })
}

/**
 * 清理 scratch/ 临时区：删除 mtime 超过 maxAgeDays 天的文件和空目录。
 *
 * - maxAgeDays <= 0 时跳过（用户可在设置里关闭自动清理）
 * - 只清 scratch/，不动 charts/、templates/ 等其他 workspace 子目录
 * - 保留 .gitkeep 等占位文件
 * - 启动时调用，确保没有 Agent 正在使用 scratch
 *
 * @returns 清理统计 { deletedFiles, deletedDirs, bytesFreed }
 */
export function cleanupScratch(maxAgeDays: number): {
  deletedFiles: number
  deletedDirs: number
  bytesFreed: number
} {
  if (maxAgeDays <= 0) return { deletedFiles: 0, deletedDirs: 0, bytesFreed: 0 }

  const scratch = getScratchPath()
  const cutoff = Date.now() - maxAgeDays * 86400_000
  let deletedFiles = 0
  let deletedDirs = 0
  let bytesFreed = 0

  /** 递归遍历，先处理子目录再处理文件，自底向上删空目录 */
  function walk(dir: string): { files: number; dirs: number; bytes: number } {
    let files = 0
    let dirs = 0
    let bytes = 0
    let entries: string[]
    try {
      entries = fs.readdirSync(dir)
    } catch {
      return { files, dirs, bytes }
    }

    for (const name of entries) {
      const fullPath = path.join(dir, name)
      let stat: fs.Stats
      try {
        stat = fs.statSync(fullPath)
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        const sub = walk(fullPath)
        files += sub.files
        dirs += sub.dirs
        bytes += sub.bytes
        // 子目录清空后，若自身也为空则删除
        try {
          if (fs.readdirSync(fullPath).length === 0) {
            fs.rmdirSync(fullPath)
            dirs++
          }
        } catch {
          /* ignore */
        }
      } else if (stat.isFile()) {
        // 保留占位文件
        if (name === '.gitkeep' || name === '.keep') continue
        if (stat.mtimeMs < cutoff) {
          try {
            fs.unlinkSync(fullPath)
            files++
            bytes += stat.size
          } catch {
            /* ignore */
          }
        }
      }
    }
    return { files, dirs, bytes }
  }

  const result = walk(scratch)
  deletedFiles = result.files
  deletedDirs = result.dirs
  bytesFreed = result.bytes

  if (deletedFiles > 0) {
    // 静态 import：打包后动态 require('../../../utils/logger') 相对 dist-electron 会解析失败
    const log = createLogger('scratch-cleanup')
    log.info(`cleaned ${deletedFiles} files (${Math.round(bytesFreed / 1024)}KB) older than ${maxAgeDays}d`)
  }

  return { deletedFiles, deletedDirs, bytesFreed }
}

/** 解析路径用于 workspace 边界检查（含符号链接；文件不存在时沿父目录链回退） */
function resolvePathForWorkspaceCheck(filePath: string): string {
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

function isUnderDirectory(filePath: string, directory: string): boolean {
  const resolved = resolvePathForWorkspaceCheck(filePath)
  let normDir: string
  try {
    normDir = fs.realpathSync(directory).replace(/\\/g, '/')
  } catch {
    normDir = directory.replace(/\\/g, '/')
  }
  const normResolved = resolved.replace(/\\/g, '/')
  return normResolved.startsWith(normDir + '/') || normResolved === normDir
}

function getRelativeWorkspacePath(filePath: string): string | null {
  if (!isInWorkspace(filePath)) return null
  let workspace: string
  try {
    workspace = fs.realpathSync(getWorkspacePath())
  } catch {
    workspace = getWorkspacePath()
  }
  const rel = path.relative(workspace, resolvePathForWorkspaceCheck(filePath))
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null
  return rel.replace(/\\/g, '/')
}

/**
 * 判断文件路径是否在 Agent workspace 内
 * 使用 realpath 解析符号链接，防止通过 symlink 绕过
 */
export function isInWorkspace(filePath: string): boolean {
  return isUnderDirectory(filePath, getWorkspacePath())
}

/** 路径是否在 scratch/ 子目录内 */
export function isScratchPath(filePath: string): boolean {
  return isUnderDirectory(filePath, getScratchPath())
}

/**
 * workspace 内免确认路径：scratch/、charts/、migrations/、根目录人格 md
 * 其余 workspace 路径（含 templates/、根目录杂项如 TODO.json）仍需确认
 */
export function isAutoApproveWorkspacePath(filePath: string): boolean {
  if (!isInWorkspace(filePath)) return false
  if (isScratchPath(filePath)) return true
  const rel = getRelativeWorkspacePath(filePath)
  if (!rel) return false
  if (AUTO_APPROVE_ROOT_FILENAMES.has(rel)) return true
  if (rel === 'charts' || rel.startsWith('charts/')) return true
  if (rel === 'migrations' || rel.startsWith('migrations/')) return true
  return false
}

export type FileWriteMode =
  | 'create'
  | 'overwrite'
  | 'append'
  | 'insert'
  | 'replace_lines'
  | 'regex_replace'

/**
 * 文件写入/修改风险（对齐 command-audit 路径分区：/tmp 等自由区 → safe）。
 */
export function assessFileWriteRisk(
  filePath: string,
  mode: FileWriteMode,
  opts?: { fileExists?: boolean; cwd?: string; extraFreeDirs?: string[] },
): RiskLevel {
  const { fileExists = false, cwd, extraFreeDirs = [] } = opts ?? {}

  const severity = getSystemPathSeverity(filePath, cwd)
  if (severity === 'critical') return 'blocked'
  if (severity === 'hardened') return 'dangerous'

  const zone = getWorkspaceZone(filePath, cwd, extraFreeDirs)
  if (zone === 'free') return 'safe'
  if (isAutoApproveWorkspacePath(filePath)) return 'safe'

  const isSafeWrite = mode === 'create' || mode === 'append' || mode === 'insert'
  if (isSafeWrite) return 'safe'

  if (mode === 'overwrite' && fileExists && zone === 'outside') return 'dangerous'

  return 'moderate'
}

/** 新建撞上已有文件时按覆盖处理（确认规则与覆盖相同）。 */
export function resolveWriteModeIfTargetExists(
  mode: FileWriteMode,
  fileExists: boolean,
): FileWriteMode {
  return mode === 'create' && fileExists ? 'overwrite' : mode
}

function isExistingRegularFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile()
  } catch {
    return false
  }
}

function forbiddenUserDataToolResult(
  filePath: string,
  toolName: string,
  executor: ToolExecutorConfig,
  _cwd?: string,
): ToolResult {
  executor.addStep({
    type: 'tool_call',
    content: `🚫 ${t('file.forbidden_path')}: ${filePath}`,
    toolName,
    toolArgs: { path: filePath },
    riskLevel: 'blocked',
  })
  return { success: false, output: '', error: t('file.forbidden_path_error') }
}

function blockIfUserDataForbidden(
  filePath: string,
  toolName: string,
  executor: ToolExecutorConfig,
  access: UserDataAccess = 'write',
  cwd?: string,
): ToolResult | null {
  if (!isUserDataForbidden(filePath, cwd, access)) return null
  return forbiddenUserDataToolResult(filePath, toolName, executor, cwd)
}

function blockIfHardBlockedWrite(
  filePath: string,
  toolName: string,
  riskLevel: RiskLevel,
  executor: ToolExecutorConfig,
): ToolResult | null {
  if (!isHardBlocked(riskLevel)) return null
  executor.addStep({
    type: 'tool_call',
    content: `🚫 ${t('file.forbidden_path')}: ${filePath}`,
    toolName,
    toolArgs: { path: filePath },
    riskLevel: 'blocked',
  })
  return { success: false, output: '', error: t('file.forbidden_path_error') }
}

function extraFreeDirsFromConfig(config: AgentConfig): string[] {
  return Array.isArray(config.commandRiskPolicy?.extraFreeDirs)
    ? config.commandRiskPolicy!.extraFreeDirs!
    : []
}

/**
 * 文件搜索
 */
export async function fileSearch(
  ptyId: string,
  args: Record<string, unknown>,
  config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const query = args.query as string
  const searchPath = args.path
    ? resolveToolLocalPath(args.path, ptyId, executor)
    : undefined
  const type = args.type as 'file' | 'dir' | 'all' | undefined
  const limit = args.limit as number | undefined

  if (!query) {
    return { success: false, output: '', error: t('error.query_required') }
  }

  if (searchPath) {
    const blocked = blockIfUserDataForbidden(searchPath, 'file_search', executor, 'read')
    if (blocked) return blocked
  }

  executor.addStep({
    type: 'tool_call',
    content: `🔍 ${t('file.searching')}: "${query}"${searchPath ? ` in ${searchPath}` : ''}`,
    toolName: 'file_search',
    toolArgs: { query, path: searchPath, type, limit },
    riskLevel: 'safe'
  })

  try {
    const fileSearchService = getFileSearchService()
    const results = await fileSearchService.search({
      query,
      searchPath,
      type,
      limit: limit || 50,
      signal: executor.getAbortSignal?.()
    })

    if (results.length === 0) {
      executor.addStep({
        type: 'tool_result',
        content: t('file.search_no_results'),
        toolName: 'file_search',
        toolResult: t('file.search_no_results_detail', { query })
      })
      return { success: true, output: t('file.search_no_results_detail', { query }) }
    }

    const formattedResults = results.map((r, i) => {
      const icon = r.isDirectory ? '📁' : '📄'
      const sizeStr = r.size !== undefined ? ` (${formatFileSize(r.size)})` : ''
      const modTime = r.modifiedTime 
        ? ` [${t('file.modified')}: ${new Date(r.modifiedTime).toLocaleString()}]` 
        : ''
      const createTime = r.createdTime 
        ? ` [${t('file.created')}: ${new Date(r.createdTime).toLocaleString()}]` 
        : ''
      return `${i + 1}. ${icon} ${r.path}${sizeStr}${modTime}${createTime}`
    }).join('\n')

    const output = `${t('file.search_found', { count: results.length })}:\n\n${formattedResults}`

    executor.addStep({
      type: 'tool_result',
      content: t('file.search_found', { count: results.length }),
      toolName: 'file_search',
      toolResult: results.length > 10 
        ? formattedResults.split('\n').slice(0, 10).join('\n') + `\n... ${t('file.search_more', { count: results.length - 10 })}`
        : formattedResults
    })

    return { success: true, output }
  } catch (error) {
    if (isAbortError(error) || executor.isAborted()) {
      executor.addStep({
        type: 'tool_result',
        content: `❌ ${t('error.operation_aborted')}`,
        toolName: 'file_search'
      })
      return { success: false, output: '', error: t('error.operation_aborted') }
    }
    const errorMsg = error instanceof Error ? error.message : t('file.search_failed')
    executor.addStep({
      type: 'tool_result',
      content: `${t('file.search_failed')}: ${errorMsg}`,
      toolName: 'file_search',
      toolResult: errorMsg
    })
    return { success: false, output: '', error: errorMsg }
  }
}

/**
 * 为文本内容添加行号前缀，帮助 AI 精确定位和引用
 * 格式: "   1|line content"（行号右对齐，宽度根据总行数自适应）
 */
function addLineNumbers(content: string, startLine: number = 1): string {
  const lines = content.split('\n')
  const maxLineNum = startLine + lines.length - 1
  const width = Math.max(4, String(maxLineNum).length)
  return lines.map((line, i) => {
    const num = String(startLine + i).padStart(width)
    return `${num}|${line}`
  }).join('\n')
}

export const CLOSEST_MATCH_THRESHOLD = 0.3
export const MAX_CLOSEST_SEARCH_LINES = 2000

export interface EditMatchResult {
  found: boolean
  count: number
  /** 是否通过规范化容错匹配到的 */
  normalized?: boolean
  /** 容错匹配时的原始文件位置 */
  originalStart?: number
  originalEnd?: number
  /** 未找到时，最接近的上下文片段（帮助 AI 重试） */
  closestContext?: string
}

/**
 * 多层容错匹配，逐层放宽条件：
 * Tier 1: 精确匹配
 * Tier 2: 换行符规范化（CRLF → LF）
 * Tier 3: 尾部空白容错（每行 trimEnd）
 */
export function findEditMatch(fileContent: string, oldText: string): EditMatchResult {
  if (oldText.length === 0) {
    return { found: false, count: 0 }
  }

  // Tier 1: 精确匹配
  const count = fileContent.split(oldText).length - 1
  if (count > 0) {
    return { found: true, count }
  }

  // Tier 2: 换行符规范化
  const normalizedFile = fileContent.replace(/\r\n/g, '\n')
  const normalizedOld = oldText.replace(/\r\n/g, '\n')
  if (normalizedFile !== fileContent || normalizedOld !== oldText) {
    const idx = normalizedFile.indexOf(normalizedOld)
    if (idx !== -1) {
      const normalizedCount = normalizedFile.split(normalizedOld).length - 1
      const posMap = buildPositionMap(fileContent)
      const originalStart = posMap[idx]
      const originalEnd = idx + normalizedOld.length < posMap.length
        ? posMap[idx + normalizedOld.length]
        : fileContent.length
      return { found: true, count: normalizedCount, normalized: true, originalStart, originalEnd }
    }
  }

  // Tier 3: 尾部空白容错
  const trimTrailing = (s: string) => s.split('\n').map(l => l.trimEnd()).join('\n')
  const fileTrimmed = trimTrailing(normalizedFile)
  const oldTrimmed = trimTrailing(normalizedOld)
  if (fileTrimmed !== normalizedFile || oldTrimmed !== normalizedOld) {
    const idx = fileTrimmed.indexOf(oldTrimmed)
    if (idx !== -1) {
      const trimmedCount = fileTrimmed.split(oldTrimmed).length - 1
      const posMap = buildPositionMap(fileContent)
      const trimToNormMap = buildTrimToNormMap(normalizedFile, fileTrimmed)
      const normStart = trimToNormMap[idx]
      const normEnd = idx + oldTrimmed.length < trimToNormMap.length
        ? trimToNormMap[idx + oldTrimmed.length]
        : normalizedFile.length
      const originalStart = posMap[normStart]
      const originalEnd = normEnd < posMap.length ? posMap[normEnd] : fileContent.length
      return { found: true, count: trimmedCount, normalized: true, originalStart, originalEnd }
    }
  }

  const closestContext = findClosestContext(fileContent, oldText)
  return { found: false, count: 0, closestContext }
}

/**
 * 构建 normalized→original 位置映射表。
 * posMap[ni] = 对应的 original 字符索引。
 * 规范化操作：CRLF → LF（\r\n 变 \n，original 多消耗 1 字符）
 */
function buildPositionMap(original: string): number[] {
  const map: number[] = []
  let oi = 0
  for (let i = 0; oi <= original.length; i++) {
    map.push(oi)
    if (oi < original.length && original[oi] === '\r' && original[oi + 1] === '\n') {
      oi += 2
    } else {
      oi++
    }
  }
  return map
}

/**
 * 构建 trimmed→normalized 位置映射表。
 * 尾部空白被移除时，trimmed 索引可能对应到 normalized 的不同位置。
 */
function buildTrimToNormMap(normalized: string, trimmed: string): number[] {
  const map: number[] = []
  let ni = 0
  for (let ti = 0; ti < trimmed.length; ti++) {
    // 跳过 normalized 中被 trim 掉的尾部空白（\n 之前的空白）
    while (ni < normalized.length && normalized[ni] !== trimmed[ti]) {
      ni++
    }
    map.push(ni)
    ni++
  }
  map.push(ni)
  return map
}

/**
 * 保持原文件换行符风格：如果原文使用 CRLF，将 newText 中的 LF 转为 CRLF
 */
export function preserveNewlineStyle(newText: string, fileContent: string): string {
  if (!fileContent.includes('\r\n')) return newText
  return newText.replace(/(?<!\r)\n/g, '\r\n')
}

/**
 * replaceAll 的规范化版本：逐个找到并替换所有匹配
 */
export function replaceAllNormalized(fileContent: string, oldText: string, newText: string): string {
  // 先尝试精确匹配 replaceAll
  if (fileContent.includes(oldText)) {
    return fileContent.split(oldText).join(newText)
  }

  const normalizedOld = oldText.replace(/\r\n/g, '\n')
  const trimTrailing = (s: string) => s.split('\n').map(l => l.trimEnd()).join('\n')
  const oldTrimmed = trimTrailing(normalizedOld)
  const normalizedFile = fileContent.replace(/\r\n/g, '\n')
  const fileTrimmed = trimTrailing(normalizedFile)

  const posMap = buildPositionMap(fileContent)
  const trimToNormMap = buildTrimToNormMap(normalizedFile, fileTrimmed)

  const styledNewText = preserveNewlineStyle(newText, fileContent)
  const parts: string[] = []
  let lastEnd = 0

  let searchFrom = 0
  for (;;) {
    const idx = fileTrimmed.indexOf(oldTrimmed, searchFrom)
    if (idx === -1) break
    const normStart = trimToNormMap[idx]
    const normEnd = idx + oldTrimmed.length < trimToNormMap.length
      ? trimToNormMap[idx + oldTrimmed.length]
      : normalizedFile.length
    const origStart = posMap[normStart]
    const origEnd = normEnd < posMap.length ? posMap[normEnd] : fileContent.length
    parts.push(fileContent.substring(lastEnd, origStart))
    parts.push(styledNewText)
    lastEnd = origEnd
    searchFrom = idx + oldTrimmed.length
  }
  parts.push(fileContent.substring(lastEnd))
  return parts.join('')
}

export type TextEditOutcome =
  | {
    ok: true
    content: string
    /** 替换了几处 */
    count: number
    /** 单处替换时在原文里的行号范围；replace_all 多处时不给 */
    lines?: { start: number; end: number }
  }
  | { ok: false; reason: 'not_found'; closestContext?: string }
  | { ok: false; reason: 'multiple'; count: number }

/** 在内存里做一次查找替换（容错匹配、保留换行风格）；不碰磁盘 */
export function applyTextEdit(content: string, oldText: string, newText: string, replaceAll: boolean): TextEditOutcome {
  const match = findEditMatch(content, oldText)
  if (!match.found) return { ok: false, reason: 'not_found', closestContext: match.closestContext }
  if (match.count > 1 && !replaceAll) return { ok: false, reason: 'multiple', count: match.count }

  if (replaceAll) {
    const replaced = match.normalized
      ? replaceAllNormalized(content, oldText, newText)
      : content.split(oldText).join(newText)
    if (match.count > 1) return { ok: true, content: replaced, count: match.count }
  }

  // normalized=true 时 Tier 2/3 必填 originalStart/End；防御性兜底以应对未来新 Tier 漏赋值
  const hasOriginalRange = match.normalized
    && typeof match.originalStart === 'number'
    && typeof match.originalEnd === 'number'
  const start = hasOriginalRange ? match.originalStart! : content.indexOf(oldText)
  if (start < 0) return { ok: false, reason: 'not_found', closestContext: match.closestContext }
  const end = hasOriginalRange ? match.originalEnd! : start + oldText.length
  const replacement = match.normalized ? preserveNewlineStyle(newText, content) : newText
  return {
    ok: true,
    content: content.substring(0, start) + replacement + content.substring(end),
    count: 1,
    lines: computeLineRange(content, start, end),
  }
}

/**
 * 找到文件中与 oldText 最相似的片段，返回上下文帮助 AI 重试。
 * 使用逐行滑动窗口 + 行级 Jaccard 相似度。
 */
function findClosestContext(fileContent: string, oldText: string): string | undefined {
  const oldLines = oldText.split('\n').map(l => l.trim()).filter(Boolean)
  if (oldLines.length === 0) return undefined

  const fileLines = fileContent.split('\n')
  if (fileLines.length === 0) return undefined

  const windowSize = Math.min(oldLines.length, fileLines.length)
  const searchLimit = Math.min(fileLines.length, MAX_CLOSEST_SEARCH_LINES)
  const oldSet = new Set(oldLines)

  let bestScore = 0
  let bestStart = 0

  for (let i = 0; i <= searchLimit - windowSize; i++) {
    const windowLines = fileLines.slice(i, i + windowSize).map(l => l.trim()).filter(Boolean)
    const windowSet = new Set(windowLines)

    let intersection = 0
    for (const l of oldSet) {
      if (windowSet.has(l)) intersection++
    }
    const union = oldSet.size + windowSet.size - intersection
    const score = union > 0 ? intersection / union : 0

    if (score > bestScore) {
      bestScore = score
      bestStart = i
    }
  }

  if (bestScore < CLOSEST_MATCH_THRESHOLD) return undefined

  const contextStart = Math.max(0, bestStart - 1)
  const contextEnd = Math.min(fileLines.length, bestStart + windowSize + 1)
  const contextLines = fileLines.slice(contextStart, contextEnd)
  const maxNum = contextEnd
  const numWidth = Math.max(4, String(maxNum).length)
  const numbered = contextLines.map((line, i) => {
    const lineNum = String(contextStart + i + 1).padStart(numWidth)
    return `${lineNum}|${line}`
  }).join('\n')

  return numbered
}

/**
 * 检测是否为文档类型
 */
function isDocumentType(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase()
  return ['.pdf', '.docx', '.doc', '.xlsx', '.xls', '.wps', '.wpt', '.et', '.ett'].includes(ext)
}

/**
 * 检测是否为 AI Vision 可处理的图片类型
 */
function isVisionImageType(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase()
  return VISION_IMAGE_EXTENSIONS.has(ext)
}

const MAX_IMAGE_SIZE = 10 * 1024 * 1024 // 10MB

/**
 * 读取图片文件为 base64 data URL，返回给 AI 进行视觉分析
 */
function readImageFile(
  filePath: string,
  fileSize: number,
  executor: ToolExecutorConfig
): ToolResult {
  const ext = path.extname(filePath).toLowerCase()
  const fileName = path.basename(filePath)
  const mime = IMAGE_MIME_TYPES[ext]
  if (!mime) {
    return { success: false, output: '', error: t('file.unsupported_format') }
  }

  if (fileSize > MAX_IMAGE_SIZE) {
    const sizeMB = (fileSize / (1024 * 1024)).toFixed(1)
    const errorMsg = t('file.image_too_large', { size: sizeMB })
    executor.addStep({
      type: 'tool_result',
      content: `${t('file.read_failed')}: ${errorMsg}`,
      toolName: 'read_file',
      toolResult: errorMsg
    })
    return { success: false, output: '', error: errorMsg }
  }

  try {
    const buffer = fs.readFileSync(filePath)
    const base64 = buffer.toString('base64')
    const dataUrl = `data:${mime};base64,${base64}`

    const sizeDisplay = formatFileSize(fileSize)

    executor.addStep({
      type: 'tool_result',
      content: t('file.image_read_success', { name: fileName, size: sizeDisplay }),
      toolName: 'read_file',
      toolResult: `${fileName} (${sizeDisplay})`,
      images: [dataUrl]
    })

    return {
      success: true,
      output: t('file.image_read_output', { name: fileName, size: sizeDisplay, path: filePath }),
      images: [dataUrl]
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : t('file.read_error')
    executor.addStep({
      type: 'tool_result',
      content: `${t('file.read_failed')}: ${errorMsg}`,
      toolName: 'read_file',
      toolResult: errorMsg
    })
    return { success: false, output: '', error: errorMsg }
  }
}

function hasVisionCapability(): boolean {
  try {
    return getConfigService().hasVisionCapability()
  } catch {
    return false
  }
}

/**
 * 从 ICO 文件中提取最大尺寸的 PNG 图片
 * ICO 格式: 6 字节头(reserved + type + count) + N * 16 字节目录项 + 图片数据
 */
function extractIcoLargestPng(filePath: string): { png: Buffer; width: number; height: number } | null {
  const buf = fs.readFileSync(filePath)
  if (buf.length < 6) return null

  const type = buf.readUInt16LE(2)
  if (type !== 1 && type !== 2) return null // 1=ICO, 2=CUR
  const count = buf.readUInt16LE(4)
  if (count === 0 || count > 256) return null

  let bestIdx = -1
  let bestPixels = 0
  let bestDataSize = 0

  for (let i = 0; i < count; i++) {
    const off = 6 + i * 16
    if (off + 16 > buf.length) break
    const w = buf[off] || 256 // 0 means 256
    const h = buf[off + 1] || 256
    const dataSize = buf.readUInt32LE(off + 8)
    const pixels = w * h
    if (pixels > bestPixels || (pixels === bestPixels && dataSize > bestDataSize)) {
      bestIdx = i
      bestPixels = pixels
      bestDataSize = dataSize
    }
  }

  if (bestIdx < 0) return null

  const entry = 6 + bestIdx * 16
  const w = buf[entry] || 256
  const h = buf[entry + 1] || 256
  const dataSize = buf.readUInt32LE(entry + 8)
  const dataOffset = buf.readUInt32LE(entry + 12)
  if (dataSize === 0 || dataOffset + dataSize > buf.length) return null

  const imageData = buf.subarray(dataOffset, dataOffset + dataSize)

  const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
  if (imageData.length >= 8 && imageData.subarray(0, 8).equals(PNG_MAGIC)) {
    return { png: Buffer.from(imageData), width: w, height: h }
  }

  // BMP data — 目前不转换，返回 null
  return null
}

/**
 * 获取 ICO 文件中所有图标的尺寸信息（用于描述无法提取 PNG 的情况）
 */
function describeIcoEntries(filePath: string): string | null {
  try {
    const buf = fs.readFileSync(filePath)
    if (buf.length < 6) return null
    const type = buf.readUInt16LE(2)
    if (type !== 1 && type !== 2) return null
    const count = buf.readUInt16LE(4)
    if (count === 0 || count > 256) return null

    const sizes: string[] = []
    for (let i = 0; i < count; i++) {
      const off = 6 + i * 16
      if (off + 16 > buf.length) break
      const w = buf[off] || 256
      const h = buf[off + 1] || 256
      sizes.push(`${w}x${h}`)
    }
    return sizes.join(', ')
  } catch {
    return null
  }
}

/**
 * 读取需要转换的图片格式（如 ICO），提取为 PNG 后走视觉通道
 */
function readConvertibleImage(
  filePath: string,
  fileSize: number,
  executor: ToolExecutorConfig
): ToolResult {
  const ext = path.extname(filePath).toLowerCase()
  const fileName = path.basename(filePath)

  if (fileSize > MAX_IMAGE_SIZE) {
    const sizeMB = (fileSize / (1024 * 1024)).toFixed(1)
    const errorMsg = t('file.image_too_large', { size: sizeMB })
    executor.addStep({
      type: 'tool_result',
      content: `${t('file.read_failed')}: ${errorMsg}`,
      toolName: 'read_file',
      toolResult: errorMsg
    })
    return { success: false, output: '', error: errorMsg }
  }

  try {
    if (ext === '.ico') {
      const result = extractIcoLargestPng(filePath)
      if (result) {
        const base64 = result.png.toString('base64')
        const dataUrl = `data:image/png;base64,${base64}`
        const sizeDisplay = formatFileSize(fileSize)

        executor.addStep({
          type: 'tool_result',
          content: t('file.image_read_success', { name: fileName, size: sizeDisplay }),
          toolName: 'read_file',
          toolResult: `${fileName} (${sizeDisplay}, ${result.width}x${result.height})`,
          images: [dataUrl]
        })

        return {
          success: true,
          output: t('file.image_converted_output', {
            name: fileName, size: sizeDisplay, path: filePath,
            format: 'ICO', width: result.width, height: result.height
          }),
          images: [dataUrl]
        }
      }

      // PNG 提取失败（BMP 格式），返回描述信息
      const sizes = describeIcoEntries(filePath)
      const sizeDisplay = formatFileSize(fileSize)
      const desc = t('file.ico_bmp_only', { name: fileName, size: sizeDisplay, sizes: sizes || 'unknown' })
      executor.addStep({
        type: 'tool_result',
        content: desc,
        toolName: 'read_file',
        toolResult: desc
      })
      return { success: true, output: desc }
    }

    return { success: false, output: '', error: t('file.unsupported_format') }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : t('file.read_error')
    executor.addStep({
      type: 'tool_result',
      content: `${t('file.read_failed')}: ${errorMsg}`,
      toolName: 'read_file',
      toolResult: errorMsg
    })
    return { success: false, output: '', error: errorMsg }
  }
}

/**
 * 通过头部 null byte 检测判断是否为二进制文件（与 git 同一策略）
 * 额外识别 UTF-16/UTF-32 BOM 避免误判 Unicode 文本为二进制
 */
function isLikelyBinary(filePath: string): boolean {
  try {
    const fd = fs.openSync(filePath, 'r')
    try {
      const stats = fs.fstatSync(fd)
      if (stats.size < 4) return false
      const buf = Buffer.alloc(Math.min(8000, stats.size))
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0)
      if (bytesRead >= 2) {
        // UTF-16 LE BOM: FF FE / UTF-16 BE BOM: FE FF / UTF-8 BOM: EF BB BF
        if ((buf[0] === 0xFF && buf[1] === 0xFE) ||
            (buf[0] === 0xFE && buf[1] === 0xFF) ||
            (bytesRead >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF)) {
          return false
        }
      }
      for (let i = 0; i < bytesRead; i++) {
        if (buf[i] === 0) return true
      }
      return false
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return true
  }
}

async function readDocumentFile(
  filePath: string,
  fileSize: number,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const ext = path.extname(filePath).toLowerCase()
  const fileName = path.basename(filePath)
  
  try {
    const documentParser = getDocumentParserService()
    const extractImages = hasVisionCapability()
    
    const result = await documentParser.parseDocument({
      name: fileName,
      path: filePath,
      size: fileSize
    }, {
      maxFileSize: 10 * 1024 * 1024,
      maxTextLength: 100000,
      extractImages
    })

    if (result.skipped) {
      const skipMsg = result.content || t('file.file_too_large')
      executor.addStep({
        type: 'tool_result',
        content: `${t('file.read_failed')}: ${skipMsg}`,
        toolName: 'read_file',
        toolResult: skipMsg
      })
      return { success: false, output: '', error: skipMsg }
    }

    const hasContent = result.content && result.content.length > 0
    const hasImages = result.images && result.images.length > 0
    const pdfType = result.metadata?.pdfType
    const isVisualPdf = ext === '.pdf' && (
      pdfType === 'Scanned' || pdfType === 'ImageBased' || pdfType === 'Mixed'
    )

    // 1) 扫描件 PDF：无文本，仅图片
    if (!hasContent && hasImages) {
      if (ext === '.pdf' && executor.skillSession) {
        try {
          await executor.skillSession.loadSkill('pdf')
        } catch (_) { /* skill already loaded or unavailable */ }
      }

      const totalPages = result.totalPages || result.pageCount || 0
      const output = t('pdf.scanned_pdf_detected', {
        name: fileName,
        totalPages,
        path: filePath
      })

      executor.addStep({
        type: 'tool_result',
        content: output,
        toolName: 'read_file',
        toolResult: output,
        images: result.images
      })

      return { success: true, output, images: result.images }
    }

    // 2) 解析失败
    if (result.error) {
      executor.addStep({
        type: 'tool_result',
        content: `${t('file.read_failed')}: ${result.error}`,
        toolName: 'read_file',
        toolResult: result.error
      })
      return { success: false, output: '', error: result.error }
    }

    // 3) 有文本（可能也有图片：图文混排 PDF / Word 含图）
    const docInfo: string[] = []
    docInfo.push(`📄 ${fileName}`)
    docInfo.push(`${ext.toUpperCase().slice(1)} ${t('file.document_parsed')}`)
    if (result.pageCount) {
      docInfo.push(`${t('file.page_count')}: ${result.pageCount}`)
    }
    docInfo.push(`${t('file.content_length')}: ${result.content.length.toLocaleString()} ${t('file.chars')}`)
    if (hasImages) {
      docInfo.push(`${t('file.images_extracted')}: ${result.images!.length}`)
    }

    // 扫描 / 混合 PDF：加载 pdf 技能以支持查看更多页
    if ((hasImages || isVisualPdf) && ext === '.pdf' && executor.skillSession) {
      try {
        await executor.skillSession.loadSkill('pdf')
      } catch (_) { /* skill already loaded or unavailable */ }
    }

    const budgeted = await applyDocumentOutputBudget(result.content, filePath, executor)
    if ('error' in budgeted) {
      executor.addStep({
        type: 'tool_result',
        content: `${t('file.read_failed')}: ${budgeted.error}`,
        toolName: 'read_file',
        toolResult: budgeted.error
      })
      return { success: false, output: '', error: budgeted.error }
    }

    const output = isVisualPdf
      ? `${t('pdf.mixed_pdf_detected', {
          name: fileName,
          totalPages: result.totalPages || result.pageCount || 0,
          rendered: result.images?.length ?? 0,
          path: filePath
        })}\n\n${budgeted.text}`
      : budgeted.text

    executor.addStep({
      type: 'tool_result',
      content: `${t('file.read_success')}: ${docInfo.join(', ')}`,
      toolName: 'read_file',
      toolResult: truncateFromEnd(output, 500),
      images: hasImages ? result.images : undefined
    })

    return { success: true, output, images: hasImages ? result.images : undefined }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : t('file.parse_failed')
    executor.addStep({
      type: 'tool_result',
      content: `${t('file.read_failed')}: ${errorMsg}`,
      toolName: 'read_file',
      toolResult: errorMsg
    })
    return { success: false, output: '', error: errorMsg }
  }
}

/**
 * 读取文件
 */
export async function readFile(
  ptyId: string,
  args: Record<string, unknown>,
  config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const filePath = resolveToolLocalPath(args.path, ptyId, executor)
  if (!filePath) {
    return { success: false, output: '', error: t('error.file_path_required') }
  }

  {
    const blocked = blockIfUserDataForbidden(filePath, 'read_file', executor, 'read')
    if (blocked) return blocked
  }

  const infoOnly = args.info_only === true
  const startLine = args.start_line as number | undefined
  const endLine = args.end_line as number | undefined
  const maxLines = args.max_lines as number | undefined
  const tailLines = args.tail_lines as number | undefined

  const callDisplayPath = formatDisplayPath(filePath, ptyId)
  const rangeLabel = describeReadRange({ infoOnly, startLine, endLine, maxLines, tailLines })
  // 范围片段贴在动作词后面（「读取文件 (前 5 行): path」），让路径始终落在末尾，
  // 前端正则更容易识别可点击的文件路径。
  const callContent = rangeLabel
    ? `${t('file.reading')} (${rangeLabel}): ${callDisplayPath}`
    : `${t('file.reading')}: ${callDisplayPath}`

  executor.addStep({
    type: 'tool_call',
    content: callContent,
    toolName: 'read_file',
    toolArgs: args,
    riskLevel: 'safe'
  })

  try {
    const stats = fs.statSync(filePath)
    const fileSize = stats.size
    const sizeMB = (fileSize / (1024 * 1024)).toFixed(2)

    if (isDocumentType(filePath) && !infoOnly) {
      return await readDocumentFile(filePath, fileSize, executor)
    }

    if (isVisionImageType(filePath)) {
      if (infoOnly) {
        const ext = path.extname(filePath).toLowerCase()
        const maxMB = MAX_IMAGE_SIZE / 1024 / 1024
        const canRead = fileSize <= MAX_IMAGE_SIZE
        const info = `## ${t('file.info_header')}
- **${t('file.info_path')}**: ${filePath}
- **${t('file.info_size')}**: ${t('file.info_size_value', { sizeMB, sizeBytes: fileSize.toLocaleString() })}
- **${t('file.image_type')}**: ${ext.slice(1).toUpperCase()}
- **${t('file.image_readable')}**: ${canRead ? t('file.image_readable_yes') : t('file.image_readable_no', { max: maxMB })}`

        executor.addStep({
          type: 'tool_result',
          content: `${t('file.file_info')}: ${sizeMB} MB, ${t('file.image_type_short')}`,
          toolName: 'read_file',
          toolResult: info
        })
        return { success: true, output: info }
      }
      return readImageFile(filePath, fileSize, executor)
    }

    // 需要转换的图片格式（如 ICO），提取内嵌 PNG 后走视觉通道
    {
      const ext = path.extname(filePath).toLowerCase()
      if (CONVERTIBLE_IMAGE_EXTENSIONS.has(ext)) {
        if (infoOnly) {
          const sizes = ext === '.ico' ? describeIcoEntries(filePath) : null
          const info = `## ${t('file.info_header')}
- **${t('file.info_path')}**: ${filePath}
- **${t('file.info_size')}**: ${t('file.info_size_value', { sizeMB, sizeBytes: fileSize.toLocaleString() })}
- **${t('file.image_type')}**: ${ext.slice(1).toUpperCase()}${sizes ? `\n- **${t('file.ico_sizes')}**: ${sizes}` : ''}
- **${t('file.image_readable')}**: ${t('file.image_readable_yes')}`

          executor.addStep({
            type: 'tool_result',
            content: `${t('file.file_info')}: ${sizeMB} MB, ${t('file.image_type_short')}`,
            toolName: 'read_file',
            toolResult: info
          })
          return { success: true, output: info }
        }
        return readConvertibleImage(filePath, fileSize, executor)
      }
    }

    // 提前检测二进制，供 infoOnly 和文本读取路径共用
    const detectedBinary = isLikelyBinary(filePath)

    if (infoOnly) {
      if (detectedBinary) {
        const ext = path.extname(filePath).toLowerCase()
        const isDoc = isDocumentType(filePath)
        const isPdf = ext === '.pdf'
        const hint = isDoc
          ? t(isPdf && hasVisionCapability() ? 'file.doc_info_only_hint_pdf' : 'file.doc_info_only_hint', { path: filePath })
          : `- **${t('file.is_binary')}**`
        const info = `## ${t('file.info_header')}
- **${t('file.info_path')}**: ${filePath}
- **${t('file.info_size')}**: ${t('file.info_size_value', { sizeMB, sizeBytes: fileSize.toLocaleString() })}
- **${t('file.image_type')}**: ${ext.slice(1).toUpperCase() || 'unknown'}
${hint}`

        executor.addStep({
          type: 'tool_result',
          content: `${t('file.file_info')}: ${sizeMB} MB, ${isDoc ? ext.slice(1).toUpperCase() : t('file.is_binary')}`,
          toolName: 'read_file',
          toolResult: info
        })
        return { success: true, output: info }
      }

      let totalLines = 0
      let sampleContent = ''
      let estimated = false
      
      try {
        if (fileSize <= 10 * 1024 * 1024) {
          const fullContent = readTextFileSync(filePath)
          const lines = fullContent.split('\n')
          totalLines = lines.length
          sampleContent = lines.slice(0, 10).join('\n')
        } else {
          const sampleSize = Math.min(100 * 1024, fileSize)
          const buffer = Buffer.alloc(sampleSize)
          const fd = fs.openSync(filePath, 'r')
          fs.readSync(fd, buffer, 0, sampleSize, 0)
          fs.closeSync(fd)
          
          const sample = decodeBuffer(buffer, true).content
          const sampleLines = sample.split('\n')
          const avgLineLength = sample.length / sampleLines.length
          totalLines = Math.floor(fileSize / avgLineLength)
          estimated = true
          sampleContent = sampleLines.slice(0, 10).join('\n')
        }
      } catch {
        totalLines = Math.floor(fileSize / 80)
        estimated = true
      }

      const info = `## ${t('file.info_header')}
- **${t('file.info_path')}**: ${filePath}
- **${t('file.info_size')}**: ${t('file.info_size_value', { sizeMB, sizeBytes: fileSize.toLocaleString() })}
- **${t('file.info_lines')}**: ${t('file.info_lines_value', { count: totalLines.toLocaleString() })}${estimated ? ` ${t('file.info_estimated')}` : ''}
- **${t('file.info_suggestion')}**: ${fileSize > 500 * 1024 ? t('file.info_suggestion_large') : t('file.info_suggestion_small')}

${sampleContent ? `### ${t('file.info_preview')}\n\`\`\`\n${sampleContent}\n\`\`\`` : ''}`

      executor.addStep({
        type: 'tool_result',
        content: `${t('file.file_info')}: ${sizeMB} MB, ${totalLines.toLocaleString()}`,
        toolName: 'read_file',
        toolResult: info
      })
      return { success: true, output: info }
    }

    // 二进制文件检测：防止把二进制数据当文本读给 AI
    if (detectedBinary) {
      const ext = path.extname(filePath).toLowerCase()
      const sizeDisplay = formatFileSize(fileSize)
      const fileName = path.basename(filePath)
      const errorMsg = t('file.binary_file_detected', { name: fileName, size: sizeDisplay, ext: ext || 'unknown' })
      executor.addStep({
        type: 'tool_result',
        content: `${t('file.read_failed')}: ${t('file.is_binary')}`,
        toolName: 'read_file',
        toolResult: errorMsg
      })
      return { success: false, output: '', error: errorMsg }
    }

    let content = ''
    let actualLines: string[] = []
    let totalLines: number | undefined
    let isPartialRead = false
    let linesCapped = false
    const readBudget = getReadOutputBudget(executor)
    let readLineCapMode: ReadLineCapMode = 'head'

    const formatBytes = (bytes: number): string => {
      if (bytes < 1024) return `${bytes} B`
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
      return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
    }

    if (startLine !== undefined || endLine !== undefined) {
      const fullContent = readTextFileSync(filePath)
      const allLines = fullContent.split('\n')
      totalLines = allLines.length
      const start = startLine !== undefined ? Math.max(1, startLine) - 1 : 0
      const end = endLine !== undefined ? Math.min(allLines.length, endLine) : allLines.length
      readLineCapMode = 'range'
      const sliced = allLines.slice(start, end)
      const capped = capReadLines(sliced, readBudget, readLineCapMode)
      actualLines = capped.lines
      linesCapped = capped.capped
      content = actualLines.join('\n')
      isPartialRead = actualLines.length < allLines.length || linesCapped
    } else if (maxLines !== undefined) {
      const fullContent = readTextFileSync(filePath)
      const allLines = fullContent.split('\n')
      totalLines = allLines.length
      readLineCapMode = 'head'
      const sliced = allLines.slice(0, maxLines)
      const capped = capReadLines(sliced, readBudget, readLineCapMode)
      actualLines = capped.lines
      linesCapped = capped.capped
      content = actualLines.join('\n')
      isPartialRead = actualLines.length < allLines.length || linesCapped
    } else if (tailLines !== undefined) {
      const fullContent = readTextFileSync(filePath)
      const allLines = fullContent.split('\n')
      totalLines = allLines.length
      readLineCapMode = 'tail'
      const sliced = allLines.slice(-tailLines)
      const capped = capReadLines(sliced, readBudget, readLineCapMode)
      actualLines = capped.lines
      linesCapped = capped.capped
      content = actualLines.join('\n')
      isPartialRead = actualLines.length < allLines.length || linesCapped
    } else {
      const maxFileSize = 500 * 1024
      if (fileSize > maxFileSize) {
        const errorMsg = t('file.too_large_error', { size: sizeMB })
        executor.addStep({
          type: 'tool_result',
          content: `${t('file.read_failed')}: ${t('file.file_too_large')}`,
          toolName: 'read_file',
          toolResult: errorMsg
        })
        return { success: false, output: '', error: errorMsg }
      }
      content = readTextFileSync(filePath)
      actualLines = content.split('\n')
      totalLines = actualLines.length
      readLineCapMode = 'head'
      const capped = capReadLines(actualLines, readBudget, readLineCapMode)
      if (capped.capped) {
        actualLines = capped.lines
        content = actualLines.join('\n')
        isPartialRead = true
        linesCapped = true
      }
    }

    const displayPath = formatDisplayPath(filePath, ptyId)
    // readMeta 只放范围 / 统计信息，路径单独放末尾——前端路径识别正则字符类含中文/空格/逗号，
    // 路径若不在末尾会贪婪吞掉后面文本，导致 shell.openPath 找不到文件
    const readMeta: string[] = []
    if (startLine !== undefined || endLine !== undefined) {
      readMeta.push(t('file.read_line_range', { start: startLine || 1, end: endLine || t('file.end_of_file') }))
    } else if (maxLines !== undefined) {
      readMeta.push(t('file.read_first_n', { count: maxLines }))
    } else if (tailLines !== undefined) {
      readMeta.push(t('file.read_last_n', { count: tailLines }))
    } else {
      readMeta.push(t('file.full_read'))
    }

    if (linesCapped) {
      readMeta.push(t('file.read_lines_capped', { cap: readBudget.maxLines }))
    }

    if (isPartialRead && totalLines !== undefined) {
      readMeta.push(t('file.partial_read_stats', {
        totalLines,
        totalBytes: formatBytes(fileSize),
        lines: actualLines.length,
        chars: formatBytes(content.length)
      }))
    } else {
      readMeta.push(t('file.actual_read', { lines: actualLines.length, chars: content.length.toLocaleString() }))
    }

    const lineOffset = startLine !== undefined ? Math.max(1, startLine)
      : tailLines !== undefined && totalLines !== undefined ? totalLines - actualLines.length + 1
      : 1
    const numberedContent = addLineNumbers(content, lineOffset)
    const outputForAi = applyReadFileOutputBudget(numberedContent, filePath, executor)

    executor.addStep({
      type: 'tool_result',
      content: `${t('file.read_success')} (${readMeta.join(', ')}): ${displayPath}`,
      toolName: 'read_file',
      toolResult: truncateFromEnd(outputForAi, 500)
    })
    
    return { success: true, output: outputForAi }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : '读取失败'
    const errorCategory = categorizeError(errorMsg)
    const suggestion = getErrorRecoverySuggestion(errorMsg, errorCategory)
    
    executor.addStep({
      type: 'tool_result',
      content: `${t('file.read_failed')}: ${errorMsg}`,
      toolName: 'read_file',
      toolResult: `${errorMsg}\n\n💡 ${suggestion}`
    })
    return { success: false, output: '', error: t('error.recovery_hint', { error: errorMsg, suggestion }) }
  }
}

/**
 * 精确编辑本地文件
 */
export async function editFile(
  ptyId: string,
  args: Record<string, unknown>,
  toolCallId: string,
  config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const filePath = resolveToolLocalPath(args.path, ptyId, executor)
  const oldText = args.old_text as string
  const newText = args.new_text as string
  const replaceAll = args.replace_all === true

  if (!filePath) {
    return { success: false, output: '', error: t('error.file_path_required') }
  }

  if (oldText === undefined || oldText === null) {
    return { success: false, output: '', error: t('error.old_text_required') }
  }

  if (newText === undefined || newText === null) {
    return { success: false, output: '', error: t('error.new_text_required') }
  }

  {
    const blocked = blockIfUserDataForbidden(filePath, 'edit_file', executor)
    if (blocked) return blocked
  }

  if (!fs.existsSync(filePath)) {
    return { success: false, output: '', error: t('error.file_not_exists', { path: filePath }) }
  }

  const oldTextPreview = oldText.length > 50 ? oldText.substring(0, 50) + '...' : oldText
  const newTextPreview = newText.length > 50 ? newText.substring(0, 50) + '...' : newText
  
  const editDisplayPath = formatDisplayPath(filePath, ptyId)

  // tool_call 卡先发出占位标题（无行号）：此时还没读文件，不知道 oldText 在哪
  // 等下面 try 块定位 match 后会通过 updateStep 更新成「编辑文件: path (第 X-Y 行)」
  const riskLevel = assessFileWriteRisk(filePath, 'replace_lines', {
    fileExists: true,
    extraFreeDirs: extraFreeDirsFromConfig(config),
  })
  {
    const blocked = blockIfHardBlockedWrite(filePath, 'edit_file', riskLevel, executor)
    if (blocked) return blocked
  }
  const callStep = executor.addStep({
    type: 'tool_call',
    content: `${t('file.edit')}: ${editDisplayPath}`,
    toolName: 'edit_file',
    toolArgs: { 
      path: filePath, 
      old_text: oldTextPreview,
      new_text: newTextPreview,
      ...(replaceAll && { replace_all: true })
    },
    riskLevel
  })

  if (riskNeedsConfirm(riskLevel, config.executionMode, config.commandRiskPolicy)) {
    const approved = await executor.waitForConfirmation(
      toolCallId, 
      'edit_file', 
      args, 
      riskLevel
    )
    if (!approved) {
      return { success: false, output: '', error: t('file.user_rejected_write') }
    }
  }

  try {
    const { content: fileContent, encoding: fileEncoding } = readTextFileWithEncoding(filePath)

    const edit = applyTextEdit(fileContent, oldText, newText, replaceAll)

    if (!edit.ok && edit.reason === 'not_found') {
      const errorMsg = t('error.old_text_not_found')
      const hint = edit.closestContext
        ? `${t('hint.old_text_not_found')}\n\n${t('hint.closest_match')}:\n${edit.closestContext}`
        : t('hint.old_text_not_found')
      executor.addStep({
        type: 'tool_result',
        content: `${t('file.edit_failed')}: ${errorMsg}`,
        toolName: 'edit_file',
        toolResult: `${errorMsg}\n\n${hint}`
      })
      return { success: false, output: '', error: `${errorMsg}\n\n${hint}` }
    }

    if (!edit.ok) {
      const errorMsg = t('error.old_text_multiple_matches', { count: edit.count })
      executor.addStep({
        type: 'tool_result',
        content: `${t('file.edit_failed')}: ${errorMsg}`,
        toolName: 'edit_file',
        toolResult: `${errorMsg}\n\n${t('hint.old_text_multiple_matches')}`
      })
      return { success: false, output: '', error: errorMsg }
    }

    // 卡片标题：单点替换标行号；replace_all 多处只标「替换 N 处」
    const editRangeLabel = edit.lines
      ? t('file.range_lines', { start: edit.lines.start, end: edit.lines.end })
      : t('file.range_replace_count', { count: edit.count })
    // 范围标签放在动作词后，路径始终在末尾——前端文件路径正则才能干净地识别 path 并使其可点击
    executor.updateStep(callStep.id, {
      content: `${t('file.edit')} (${editRangeLabel}): ${editDisplayPath}`
    })

    writeTextFileSync(filePath, edit.content, fileEncoding)

    // tool_result 文案：路径必须放最末尾以保证前端路径识别正则可点击；UI 用短路径，output 给 AI 用绝对路径。
    // 单次替换才追加行号；多处替换的 _all_short 文案已含 count，不再追加范围标签。
    const isMultiReplace = replaceAll && edit.count > 1
    const buildContent = (p: string): string => {
      const head = isMultiReplace
        ? t('file.edit_success_all_short', { count: edit.count })
        : t('file.edit_success_short')
      const headWithRange = !isMultiReplace && editRangeLabel ? `${head} (${editRangeLabel})` : head
      return `${headWithRange}: ${p}`
    }
    const previewCanvas = previewCanvasDataForPath(filePath)
    executor.addStep({
      type: 'tool_result',
      content: buildContent(editDisplayPath),
      toolName: 'edit_file',
      ...(previewCanvas && { canvasData: previewCanvas })
    })

    // output 给 AI 看：保留含路径的旧文案，路径用绝对路径（避免 cwd 漂移时定位失败）
    const outputForAi = isMultiReplace
      ? t('file.edit_success_all', { path: filePath, count: edit.count })
      : t('file.edit_success', { path: filePath })
    return { success: true, output: await appendPanelDirtyNotice(outputForAi, filePath, previewCanvas, executor) }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : t('file.edit_failed')
    const errorCategory = categorizeError(errorMsg)
    const suggestion = getErrorRecoverySuggestion(errorMsg, errorCategory)
    
    executor.addStep({
      type: 'tool_result',
      content: `${t('file.edit_failed')}: ${errorMsg}`,
      toolName: 'edit_file',
      toolResult: `${errorMsg}\n\n💡 ${suggestion}`
    })
    return { success: false, output: '', error: t('error.recovery_hint', { error: errorMsg, suggestion }) }
  }
}

interface MultiEditItem {
  oldText: string
  newText: string
  replaceAll: boolean
}

function parseMultiEditItems(raw: unknown): MultiEditItem[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  const items: MultiEditItem[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') return undefined
    const { old_text: oldText, new_text: newText, replace_all: replaceAll } = item as Record<string, unknown>
    if (typeof oldText !== 'string' || typeof newText !== 'string') return undefined
    items.push({ oldText, newText, replaceAll: replaceAll === true })
  }
  return items
}

/**
 * 同一个本地文件里按顺序做多处查找替换：全部对得上才落盘，任何一处对不上整次不改。
 * 拦截、确认、界面显示与 edit_file 同一套。
 */
export async function multiEditFile(
  ptyId: string,
  args: Record<string, unknown>,
  toolCallId: string,
  config: AgentConfig,
  executor: ToolExecutorConfig,
  toolName: string,
): Promise<ToolResult> {
  const filePath = resolveToolLocalPath(String(args.path ?? ''), ptyId, executor)
  if (!filePath) {
    return { success: false, output: '', error: t('error.file_path_required') }
  }
  const items = parseMultiEditItems(args.edits)
  if (!items) {
    return { success: false, output: '', error: t('error.edits_required') }
  }
  {
    const blocked = blockIfUserDataForbidden(filePath, toolName, executor)
    if (blocked) return blocked
  }
  if (!fs.existsSync(filePath)) {
    return { success: false, output: '', error: t('error.file_not_exists', { path: filePath }) }
  }

  const displayPath = formatDisplayPath(filePath, ptyId)
  const riskLevel = assessFileWriteRisk(filePath, 'replace_lines', {
    fileExists: true,
    extraFreeDirs: extraFreeDirsFromConfig(config),
  })
  {
    const blocked = blockIfHardBlockedWrite(filePath, toolName, riskLevel, executor)
    if (blocked) return blocked
  }
  executor.addStep({
    type: 'tool_call',
    content: `${t('file.multi_edit', { count: items.length })}: ${displayPath}`,
    toolName,
    toolArgs: { path: filePath, edits: items.length },
    riskLevel
  })

  if (riskNeedsConfirm(riskLevel, config.executionMode, config.commandRiskPolicy)) {
    const approved = await executor.waitForConfirmation(toolCallId, toolName, args, riskLevel)
    if (!approved) {
      return { success: false, output: '', error: t('file.user_rejected_write') }
    }
  }

  const failStep = (message: string): ToolResult => {
    executor.addStep({
      type: 'tool_result',
      content: `${t('file.edit_failed')}: ${message.split('\n')[0]}`,
      toolName,
      toolResult: message
    })
    return { success: false, output: '', error: message }
  }

  try {
    const { content: original, encoding } = readTextFileWithEncoding(filePath)
    let content = original
    for (const [i, item] of items.entries()) {
      const edit = applyTextEdit(content, item.oldText, item.newText, item.replaceAll)
      if (!edit.ok && edit.reason === 'not_found') {
        const closest = edit.closestContext ? `\n\n${t('hint.closest_match')}:\n${edit.closestContext}` : ''
        return failStep(`${t('file.multi_edit_item_not_found', { index: i + 1 })}${closest}`)
      }
      if (!edit.ok) {
        return failStep(t('file.multi_edit_item_multiple', { index: i + 1, count: edit.count }))
      }
      content = edit.content
    }

    writeTextFileSync(filePath, content, encoding)

    const previewCanvas = previewCanvasDataForPath(filePath)
    executor.addStep({
      type: 'tool_result',
      content: `${t('file.multi_edit_success_short', { count: items.length })}: ${displayPath}`,
      toolName,
      ...(previewCanvas && { canvasData: previewCanvas })
    })
    const outputForAi = t('file.multi_edit_success', { count: items.length, path: filePath })
    return { success: true, output: await appendPanelDirtyNotice(outputForAi, filePath, previewCanvas, executor) }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : t('file.edit_failed')
    const suggestion = getErrorRecoverySuggestion(errorMsg, categorizeError(errorMsg))
    failStep(`${errorMsg}\n\n💡 ${suggestion}`)
    return { success: false, output: '', error: t('error.recovery_hint', { error: errorMsg, suggestion }) }
  }
}

/**
 * 写入本地文件
 */
export async function writeTextFile(
  ptyId: string,
  args: Record<string, unknown>,
  toolCallId: string,
  config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  let filePath = resolveToolLocalPath(args.path, ptyId, executor)
  const content = args.content as string | undefined
  const mode = args.mode as string | undefined
  const insertAtLine = args.insert_at_line as number | undefined
  const startLine = args.start_line as number | undefined
  const endLine = args.end_line as number | undefined
  const pattern = args.pattern as string | undefined
  const replacement = args.replacement as string | undefined
  const replaceAll = args.replace_all !== false

  if (!filePath) {
    return { success: false, output: '', error: t('error.file_path_required') }
  }

  const validModes = ['overwrite', 'create', 'append', 'insert', 'replace_lines', 'regex_replace']
  if (!mode) {
    return { success: false, output: '', error: t('error.write_mode_required', { modes: validModes.join(', ') }) }
  }
  if (!validModes.includes(mode)) {
    return { success: false, output: '', error: t('error.invalid_write_mode', { mode, modes: validModes.join(', ') }) }
  }

  // 验证各模式的必要参数
  if (mode === 'overwrite' || mode === 'create' || mode === 'append') {
    if (content === undefined) {
      return { success: false, output: '', error: t('error.content_required_for_mode', { mode }) }
    }
  } else if (mode === 'insert') {
    if (content === undefined) {
      return { success: false, output: '', error: t('error.insert_content_required') }
    }
    if (insertAtLine === undefined || insertAtLine < 1) {
      return { success: false, output: '', error: t('error.insert_line_required') }
    }
  } else if (mode === 'replace_lines') {
    if (content === undefined) {
      return { success: false, output: '', error: t('error.replace_content_required') }
    }
    if (startLine === undefined || startLine < 1) {
      return { success: false, output: '', error: t('error.replace_start_line_required') }
    }
    if (endLine === undefined || endLine < startLine) {
      return { success: false, output: '', error: t('error.replace_end_line_required') }
    }
  } else if (mode === 'regex_replace') {
    if (pattern === undefined) {
      return { success: false, output: '', error: t('error.regex_pattern_required') }
    }
    if (replacement === undefined) {
      return { success: false, output: '', error: t('error.regex_replacement_required') }
    }
  }

  {
    const blocked = blockIfUserDataForbidden(filePath, 'write_text_file', executor)
    if (blocked) return blocked
  }

  // Office 扩展名自动转为 .md（无法生成真正的 Office 文档）
  const officeExt = ['.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt']
  if (officeExt.includes(path.extname(filePath).toLowerCase())) {
    const original = path.basename(filePath)
    filePath = filePath.replace(/\.(docx?|xlsx?|pptx?)$/i, '.md')
    executor.addStep({
      type: 'tool_result',
      content: `⚠️ ${t('file.office_extension_converted', { original, converted: path.basename(filePath) })}`,
      toolName: 'write_text_file'
    })
  }

  const fileExists = isExistingRegularFile(filePath)
  const writeMode = resolveWriteModeIfTargetExists(mode as FileWriteMode, fileExists)

  let operationDesc = ''
  switch (writeMode) {
    case 'overwrite':
      operationDesc = `${t('file.overwrite')}: ${filePath}`
      break
    case 'create':
      operationDesc = `${t('file.create')}: ${filePath}`
      break
    case 'append':
      operationDesc = `${t('file.append')}: ${filePath}`
      break
    case 'insert':
      operationDesc = `${t('file.insert_at_line', { line: insertAtLine! })}: ${filePath}`
      break
    case 'replace_lines':
      operationDesc = `${t('file.replace_lines', { start: startLine!, end: endLine! })}: ${filePath}`
      break
    case 'regex_replace':
      operationDesc = `${t('file.regex_replace', { scope: replaceAll ? t('file.regex_scope_all') : t('file.regex_scope_first') })}: ${filePath}`
      break
  }

  const riskLevel = assessFileWriteRisk(filePath, writeMode, {
    fileExists,
    extraFreeDirs: extraFreeDirsFromConfig(config),
  })
  {
    const blocked = blockIfHardBlockedWrite(filePath, 'write_text_file', riskLevel, executor)
    if (blocked) return blocked
  }
  executor.addStep({
    type: 'tool_call',
    content: operationDesc,
    toolName: 'write_text_file',
    toolArgs: { 
      path: filePath, 
      mode: writeMode,
      ...(content !== undefined && { content: content.length > 100 ? content.substring(0, 100) + '...' : content }),
      ...(insertAtLine !== undefined && { insert_at_line: insertAtLine }),
      ...(startLine !== undefined && { start_line: startLine }),
      ...(endLine !== undefined && { end_line: endLine }),
      ...(pattern !== undefined && { pattern }),
      ...(replacement !== undefined && { replacement })
    },
    riskLevel
  })

  if (riskNeedsConfirm(riskLevel, config.executionMode, config.commandRiskPolicy)) {
    const approved = await executor.waitForConfirmation(
      toolCallId, 
      'write_text_file', 
      { ...args, path: filePath, mode: writeMode }, 
      riskLevel
    )
    if (!approved) {
      return { success: false, output: '', error: t('file.user_rejected_write') }
    }
  }

  const contentLength = content?.length || 0
  const contentSizeKB = (contentLength / 1024).toFixed(1)
  const isLargeContent = contentLength > 10000

  let progressStepId: string | undefined
  if (isLargeContent) {
    const progressStep = executor.addStep({
      type: 'tool_result',
      content: `⏳ ${t('file.writing_progress')}（${contentSizeKB} KB）`,
      toolName: 'write_text_file',
      isStreaming: true
    })
    progressStepId = progressStep.id
    await new Promise(resolve => setTimeout(resolve, 50))
  }

  try {
    const dir = path.dirname(filePath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    let resultMsg = ''
    const fileExistsNow = fs.existsSync(filePath)

    switch (writeMode) {
      case 'overwrite':
      case 'create': {
        fs.writeFileSync(filePath, content!, 'utf-8')
        resultMsg = `${fileExistsNow ? t('file.result_overwritten') : t('file.result_created')}: ${filePath}`
        break
      }
      case 'append': {
        if (fileExistsNow) {
          const appendEncoding = detectEncoding(fs.readFileSync(filePath))
          if (appendEncoding === 'utf-8') {
            fs.appendFileSync(filePath, content!, 'utf-8')
          } else {
            fs.appendFileSync(filePath, iconv.encode(content!, appendEncoding))
          }
        } else {
          fs.writeFileSync(filePath, content!, 'utf-8')
        }
        resultMsg = `${t('file.result_appended')}: ${filePath}`
        break
      }
      case 'insert': {
        if (!fileExistsNow) {
          const errorMsg = t('error.file_not_exists_for_insert')
          executor.addStep({
            type: 'tool_result',
            content: `❌ ${errorMsg}`,
            toolName: 'write_text_file'
          })
          return { success: false, output: '', error: errorMsg }
        }
        const { content: insertFileContent, encoding: insertEncoding } = readTextFileWithEncoding(filePath)
        const lines = insertFileContent.split('\n')
        const insertIndex = Math.min(insertAtLine! - 1, lines.length)
        const contentLines = content!.split('\n')
        lines.splice(insertIndex, 0, ...contentLines)
        writeTextFileSync(filePath, lines.join('\n'), insertEncoding)
        resultMsg = `${t('file.result_inserted', { line: insertAtLine!, count: contentLines.length })}: ${filePath}`
        break
      }
      case 'replace_lines': {
        if (!fileExistsNow) {
          const errorMsg = t('error.file_not_exists_for_replace')
          executor.addStep({
            type: 'tool_result',
            content: `❌ ${errorMsg}`,
            toolName: 'write_text_file'
          })
          return { success: false, output: '', error: errorMsg }
        }
        const { content: replaceFileContent, encoding: replaceEncoding } = readTextFileWithEncoding(filePath)
        const rlLines = replaceFileContent.split('\n')
        const totalLines = rlLines.length
        if (startLine! > totalLines) {
          const errorMsg = t('error.start_line_exceeds_total', { start: startLine!, total: totalLines })
          executor.addStep({
            type: 'tool_result',
            content: `❌ ${errorMsg}`,
            toolName: 'write_text_file'
          })
          return { success: false, output: '', error: errorMsg }
        }
        const actualEndLine = Math.min(endLine!, totalLines)
        const deleteCount = actualEndLine - startLine! + 1
        const contentLines = content!.split('\n')
        rlLines.splice(startLine! - 1, deleteCount, ...contentLines)
        writeTextFileSync(filePath, rlLines.join('\n'), replaceEncoding)
        resultMsg = `${t('file.result_replaced_lines', { start: startLine!, end: actualEndLine, deleteCount, newCount: contentLines.length })}: ${filePath}`
        break
      }
      case 'regex_replace': {
        if (!fileExistsNow) {
          const errorMsg = t('error.file_not_exists_for_regex')
          executor.addStep({
            type: 'tool_result',
            content: `❌ ${errorMsg}`,
            toolName: 'write_text_file'
          })
          return { success: false, output: '', error: errorMsg }
        }
        const { content: regexFileContent, encoding: regexEncoding } = readTextFileWithEncoding(filePath)
        let regex: RegExp
        try {
          regex = new RegExp(pattern!, replaceAll ? 'g' : '')
        } catch {
          return { success: false, output: '', error: t('error.invalid_regex_pattern', { pattern: pattern! }) }
        }
        const matches = regexFileContent.match(regex)
        if (!matches || matches.length === 0) {
          return { success: false, output: '', error: t('error.regex_no_match', { pattern: pattern! }) }
        }
        const newContent = regexFileContent.replace(regex, replacement!)
        writeTextFileSync(filePath, newContent, regexEncoding)
        resultMsg = `${t('file.result_regex_replaced', { count: matches.length })}: ${filePath}`
        break
      }
    }

    const previewCanvas = previewCanvasDataForPath(filePath)
    if (progressStepId) {
      executor.updateStep(progressStepId, {
        type: 'tool_result',
        content: `✅ ${resultMsg}`,
        toolName: 'write_text_file',
        isStreaming: false,
        ...(previewCanvas && { canvasData: previewCanvas })
      })
    } else {
      executor.addStep({
        type: 'tool_result',
        content: resultMsg,
        toolName: 'write_text_file',
        ...(previewCanvas && { canvasData: previewCanvas })
      })
    }
    return { success: true, output: await appendPanelDirtyNotice(resultMsg, filePath, previewCanvas, executor) }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : t('file.write_failed')
    const errorCategory = categorizeError(errorMsg)
    const suggestion = getErrorRecoverySuggestion(errorMsg, errorCategory)
    
    if (progressStepId) {
      executor.updateStep(progressStepId, {
        type: 'tool_result',
        content: `❌ ${t('file.write_failed')}: ${errorMsg}`,
        toolName: 'write_text_file',
        toolResult: `${errorMsg}\n\n💡 ${suggestion}`,
        isStreaming: false
      })
    } else {
      executor.addStep({
        type: 'tool_result',
        content: `${t('file.write_failed')}: ${errorMsg}`,
        toolName: 'write_text_file',
        toolResult: `${errorMsg}\n\n💡 ${suggestion}`
      })
    }
    return { success: false, output: '', error: t('error.recovery_hint', { error: errorMsg, suggestion }) }
  }
}

/**
 * 写入远程文件（通过 SFTP）
 */
export async function writeRemoteTextFile(
  ptyId: string,
  args: Record<string, unknown>,
  toolCallId: string,
  config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const filePath = args.path as string
  const content = args.content as string
  const mode = args.mode as string | undefined

  if (!filePath) {
    return { success: false, output: '', error: t('error.file_path_required') }
  }

  const validModes = ['create', 'overwrite', 'append']
  if (!mode) {
    return { success: false, output: '', error: t('error.write_mode_required', { modes: validModes.join(', ') }) }
  }
  if (!validModes.includes(mode)) {
    return { success: false, output: '', error: t('error.invalid_write_mode', { mode, modes: validModes.join(', ') }) }
  }

  if (content === undefined) {
    return { success: false, output: '', error: t('error.content_required_for_mode', { mode }) }
  }

  {
    const blocked = blockIfUserDataForbidden(filePath, 'write_remote_text_file', executor)
    if (blocked) return blocked
  }

  return writeFileViaSftp(ptyId, filePath, content, mode as 'create' | 'overwrite' | 'append', toolCallId, config, executor)
}

/**
 * 通过 SFTP 写入远程文件
 */
async function writeFileViaSftp(
  ptyId: string,
  filePath: string,
  content: string,
  mode: 'overwrite' | 'create' | 'append',
  toolCallId: string,
  config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const sftpService = executor.getSftpService?.()
  const sshConfig = executor.getSshConfig?.(ptyId)

  if (!sftpService) {
    return { 
      success: false, 
      output: '', 
      error: t('error.sftp_not_initialized') 
    }
  }

  if (!sshConfig) {
    return { 
      success: false, 
      output: '', 
      error: t('error.ssh_config_unavailable') 
    }
  }

  const contentLength = content.length
  const contentSizeKB = (contentLength / 1024).toFixed(1)

  try {
    if (!sftpService.hasSession(ptyId)) {
      executor.addStep({
        type: 'tool_result',
        content: t('file.establishing_sftp'),
        toolName: 'write_remote_text_file',
        isStreaming: true
      })

      const sftpConfig = {
        host: sshConfig.host,
        port: sshConfig.port,
        username: sshConfig.username,
        password: sshConfig.password,
        privateKey: sshConfig.privateKey,
        privateKeyPath: sshConfig.privateKeyPath,
        passphrase: sshConfig.passphrase
      }

      await sftpService.connect(ptyId, sftpConfig)
    }

    let fileExists = false
    try {
      const kind = await sftpService.exists(ptyId, filePath)
      fileExists = kind === '-' || kind === 'l'
    } catch {
      fileExists = false
    }
    const writeMode = resolveWriteModeIfTargetExists(mode, fileExists)

    let operationDesc = ''
    switch (writeMode) {
      case 'overwrite':
        operationDesc = `${t('file.overwrite')}: ${filePath}`
        break
      case 'create':
        operationDesc = `${t('file.create')}: ${filePath}`
        break
      case 'append':
        operationDesc = `${t('file.append')}: ${filePath}`
        break
    }

    const riskLevel = assessFileWriteRisk(filePath, writeMode, {
      fileExists,
      extraFreeDirs: extraFreeDirsFromConfig(config),
    })
    {
      const blocked = blockIfHardBlockedWrite(filePath, 'write_remote_text_file', riskLevel, executor)
      if (blocked) return blocked
    }
    executor.addStep({
      type: 'tool_call',
      content: operationDesc,
      toolName: 'write_remote_text_file',
      toolArgs: {
        path: filePath,
        mode: writeMode,
        content: content.length > 100 ? content.substring(0, 100) + '...' : content
      },
      riskLevel
    })

    if (riskNeedsConfirm(riskLevel, config.executionMode, config.commandRiskPolicy)) {
      const approved = await executor.waitForConfirmation(
        toolCallId,
        'write_remote_text_file',
        { path: filePath, mode: writeMode, content },
        riskLevel
      )
      if (!approved) {
        return { success: false, output: '', error: t('file.user_rejected_write') }
      }
    }

    executor.terminalService.write(ptyId, `echo "📝 ${t('file.writing_remote', { path: filePath, size: contentSizeKB })}"\r`)

    await new Promise(resolve => setTimeout(resolve, 300))

    let resultMsg: string
    if (writeMode === 'create' || writeMode === 'overwrite') {
      await sftpService.writeFile(ptyId, filePath, content)
      resultMsg = `${fileExists ? t('file.result_remote_written') : t('file.result_remote_created')}: ${filePath}`
    } else {
      let existingContent = ''
      try {
        existingContent = await sftpService.readFile(ptyId, filePath)
      } catch {
        // 文件不存在
      }
      await sftpService.writeFile(ptyId, filePath, existingContent + content)
      resultMsg = `${t('file.result_remote_appended')}: ${filePath}`
    }

    executor.terminalService.write(ptyId, `echo "✅ ${t('file.write_success')}: ${filePath}"\r`)
    
    await new Promise(resolve => setTimeout(resolve, 300))

    executor.addStep({
      type: 'tool_result',
      content: resultMsg,
      toolName: 'write_remote_text_file'
    })

    return { success: true, output: resultMsg }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : t('file.remote_write_failed')
    
    executor.terminalService.write(ptyId, `echo "❌ ${t('file.write_failed')}: ${errorMsg}"\r`)
    
    executor.addStep({
      type: 'tool_result',
      content: `${t('file.remote_write_failed')}: ${errorMsg}`,
      toolName: 'write_remote_text_file',
      toolResult: errorMsg
    })

    return { success: false, output: '', error: `${t('file.remote_write_failed')}: ${errorMsg}` }
  }
}
