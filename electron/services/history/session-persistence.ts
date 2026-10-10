/**
 * 会话增量持久化 —— meta.json + steps/messages.jsonl
 *
 * 布局：
 *   history/{agent|watch}/<date>/<sessionId>/
 *     meta.json          # 小文件：身份、标题、状态、watermark
 *     steps.jsonl        # 追加写 AgentStepRecord
 *     messages.jsonl     # 追加写 messages
 *
 * 兼容：同目录下旧的 `<sessionId>.json` 单体文件仍可读；下次 save 转为目录格式。
 * 标题变更只改 meta.json；checkpoint 只追加增量行，避免整份 transcript 反复全量写。
 *
 * 崩溃安全：
 * - 先 append jsonl，再写 meta。若 crash 在中间，下次 save 用磁盘实际行数作 watermark，避免重复追加。
 * - 若磁盘行数 > 内存条数（异常回退）则全量重写。
 */
import * as fs from 'fs'
import * as path from 'path'
import type { AgentRecord, AgentStepRecord, ApprovalMode } from '@shared/types'
import { isApprovalMode } from '@shared/types'
import {
  forEachBoundedJsonlLineAsync,
  forEachBoundedJsonlLineSync,
  stubHugeJsonlLine,
  type BoundedJsonlLine,
} from './jsonl-bounded-read'
import { writeFileAtomic } from '../../utils/atomic-write'
import { normalizeAgentRecord } from '../../utils/normalize'
import { createLogger } from '../../utils/logger'
import {
  getAgentDateDir,
  getAgentRecordPath,
  sanitizeAgentFilename,
  isolateCorruptFile,
  readAgentRecordFile,
  readAgentRecordFileAsync,
} from './agent-storage'

const log = createLogger('SessionPersistence')

/** 读会话时的场景选择。默认完整读回；检索时丢掉产出物快照，避免把整篇文档拉进内存。 */
export interface ReadSessionOptions {
  omitCanvasData?: boolean
}

export interface SessionMeta {
  id: string
  timestamp: number
  terminalId: string
  agentKey?: string
  kind?: AgentRecord['kind']
  terminalType: AgentRecord['terminalType']
  sshHost?: string
  userTask: string
  title?: string
  titleLocked?: boolean
  approval?: AgentRecord['approval']
  finalResult?: string
  duration: number
  status: AgentRecord['status']
  tokenUsage?: AgentRecord['tokenUsage']
  artifacts?: AgentRecord['artifacts']
  loadedSkills?: AgentRecord['loadedSkills']
  userDismissedSkills?: AgentRecord['userDismissedSkills']
  workingContext?: AgentRecord['workingContext']
  compressedArchives?: AgentRecord['compressedArchives']
  /** 已持久化的 steps 条数（jsonl 行数） */
  stepCount: number
  /** 已持久化的 messages 条数 */
  messageCount: number
}

function sessionDir(agentDir: string, dateStr: string, recordId: string): string {
  return path.join(getAgentDateDir(agentDir, dateStr), sanitizeAgentFilename(recordId))
}

function metaPath(dir: string): string {
  return path.join(dir, 'meta.json')
}

function stepsPath(dir: string): string {
  return path.join(dir, 'steps.jsonl')
}

function messagesPath(dir: string): string {
  return path.join(dir, 'messages.jsonl')
}

/** 整份重写元数据时，不让不带这几项的记录把已记下的标题锁、审批方式抹掉 */
function mergeTitleLock(meta: SessionMeta, existing: SessionMeta | null): SessionMeta {
  if (existing?.titleLocked) meta.titleLocked = true
  if (!meta.approval && existing?.approval) meta.approval = existing.approval
  return meta
}

function recordToMeta(record: AgentRecord, stepCount: number, messageCount: number): SessionMeta {
  const meta: SessionMeta = {
    id: record.id,
    timestamp: record.timestamp,
    terminalId: record.terminalId,
    agentKey: record.agentKey,
    kind: record.kind,
    terminalType: record.terminalType,
    sshHost: record.sshHost,
    userTask: record.userTask,
    finalResult: record.finalResult,
    duration: record.duration,
    status: record.status,
    stepCount,
    messageCount,
  }
  if (record.title?.trim()) meta.title = record.title.trim()
  if (record.titleLocked) meta.titleLocked = true
  if (record.approval) meta.approval = record.approval
  if (record.tokenUsage) meta.tokenUsage = record.tokenUsage
  if (record.artifacts) meta.artifacts = record.artifacts
  if (Array.isArray(record.loadedSkills)) meta.loadedSkills = [...record.loadedSkills]
  if (Array.isArray(record.userDismissedSkills)) meta.userDismissedSkills = [...record.userDismissedSkills]
  if (Array.isArray(record.workingContext)) {
    meta.workingContext = record.workingContext.map(m => JSON.parse(JSON.stringify(m)))
  }
  if (Array.isArray(record.compressedArchives)) {
    meta.compressedArchives = record.compressedArchives.map(a => JSON.parse(JSON.stringify(a)))
  }
  return meta
}

function metaToRecord(meta: SessionMeta, steps: AgentStepRecord[], messages: AgentRecord['messages']): AgentRecord {
  return normalizeAgentRecord({
    id: meta.id,
    timestamp: meta.timestamp,
    terminalId: meta.terminalId,
    agentKey: meta.agentKey,
    kind: meta.kind,
    terminalType: meta.terminalType,
    sshHost: meta.sshHost,
    userTask: meta.userTask,
    title: meta.title,
    titleLocked: meta.titleLocked,
    ...(isApprovalMode(meta.approval) ? { approval: meta.approval } : {}),
    steps,
    messages,
    finalResult: meta.finalResult,
    duration: meta.duration,
    status: meta.status,
    tokenUsage: meta.tokenUsage,
    artifacts: meta.artifacts,
    loadedSkills: meta.loadedSkills,
    userDismissedSkills: meta.userDismissedSkills,
    workingContext: meta.workingContext,
    compressedArchives: meta.compressedArchives,
  })
}

function applyReadOptions<T>(value: T, options?: ReadSessionOptions): T {
  if (!options?.omitCanvasData || !value || typeof value !== 'object') return value
  if (!('canvasData' in value) || (value as { canvasData?: unknown }).canvasData == null) {
    return value
  }
  delete (value as { canvasData?: unknown }).canvasData
  return value
}

function parseJsonlLine<T>(
  filePath: string,
  line: BoundedJsonlLine,
  lineIndex: number,
  options?: ReadSessionOptions,
): T | undefined {
  if (line.kind === 'huge') {
    log.warn(`Skip huge jsonl line in ${filePath}: ${line.bytes} bytes`)
    return applyReadOptions(stubHugeJsonlLine(line, filePath, lineIndex) as T, options)
  }
  const trimmed = line.text.trim()
  if (!trimmed) return undefined
  try {
    return applyReadOptions(JSON.parse(trimmed) as T, options)
  } catch (e) {
    log.warn(`Skip corrupt jsonl line in ${filePath}:`, e)
    return undefined
  }
}

/**
 * 非空行数（用作 watermark；含可能损坏的行，防止 crash 后重复 append）。
 * 超大行只计数，不把整行装进字符串。
 */
export function countJsonlLines(filePath: string): number {
  try {
    let n = 0
    forEachBoundedJsonlLineSync(filePath, (line) => {
      if (line.kind === 'huge') n++
      else if (line.text.trim()) n++
    })
    return n
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return 0
    throw e
  }
}

function readJsonl<T>(filePath: string, options?: ReadSessionOptions): T[] {
  if (!fs.existsSync(filePath)) return []
  const out: T[] = []
  forEachBoundedJsonlLineSync(filePath, (line, lineIndex) => {
    const parsed = parseJsonlLine<T>(filePath, line, lineIndex, options)
    if (parsed !== undefined) out.push(parsed)
  })
  return out
}

async function readJsonlAsync<T>(filePath: string, options?: ReadSessionOptions): Promise<T[]> {
  const out: T[] = []
  try {
    await forEachBoundedJsonlLineAsync(filePath, (line, lineIndex) => {
      const parsed = parseJsonlLine<T>(filePath, line, lineIndex, options)
      if (parsed !== undefined) out.push(parsed)
    })
    return out
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return []
    throw e
  }
}

function appendJsonl(filePath: string, items: unknown[]): void {
  if (items.length === 0) return
  const chunk = items.map(i => JSON.stringify(i)).join('\n') + '\n'
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.appendFileSync(filePath, chunk, 'utf-8')
}

function writeJsonl(filePath: string, items: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  if (items.length === 0) {
    writeFileAtomic(filePath, '')
    return
  }
  writeFileAtomic(filePath, items.map(i => JSON.stringify(i)).join('\n') + '\n')
}

function readMeta(dir: string): SessionMeta | null {
  const p = metaPath(dir)
  try {
    if (!fs.existsSync(p)) return null
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as SessionMeta
  } catch (e) {
    isolateCorruptFile(p)
    log.error(`Corrupt session meta: ${p}`, e)
    return null
  }
}

async function readMetaAsync(dir: string): Promise<SessionMeta | null> {
  const p = metaPath(dir)
  try {
    const content = await fs.promises.readFile(p, 'utf-8')
    return JSON.parse(content) as SessionMeta
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return null
    isolateCorruptFile(p)
    log.error(`Corrupt session meta: ${p}`, e)
    return null
  }
}

function writeMeta(dir: string, meta: SessionMeta): void {
  fs.mkdirSync(dir, { recursive: true })
  writeFileAtomic(metaPath(dir), JSON.stringify(meta, null, 2))
}

/** 从目录组装完整 AgentRecord */
export function readSessionDir(
  dir: string,
  onCorrupt?: (corruptPath: string | null, error: unknown) => void,
  options?: ReadSessionOptions
): AgentRecord | null {
  try {
    const meta = readMeta(dir)
    if (!meta) return null
    const steps = readJsonl<AgentStepRecord>(stepsPath(dir), options)
    const messages = readJsonl<NonNullable<AgentRecord['messages']>[number]>(messagesPath(dir), options)
    return metaToRecord(meta, steps, messages)
  } catch (e) {
    onCorrupt?.(dir, e)
    return null
  }
}

async function readSessionDirAsync(
  dir: string,
  onCorrupt?: (corruptPath: string | null, error: unknown) => void,
  options?: ReadSessionOptions
): Promise<AgentRecord | null> {
  try {
    const meta = await readMetaAsync(dir)
    if (!meta) return null
    const [steps, messages] = await Promise.all([
      readJsonlAsync<AgentStepRecord>(stepsPath(dir), options),
      readJsonlAsync<NonNullable<AgentRecord['messages']>[number]>(messagesPath(dir), options),
    ])
    return metaToRecord(meta, steps, messages)
  } catch (e) {
    onCorrupt?.(dir, e)
    return null
  }
}

/**
 * 读取会话：优先目录格式，其次旧单体 .json。
 */
export function readSessionRecord(
  agentDir: string,
  dateStr: string,
  recordId: string,
  onCorrupt?: (corruptPath: string | null, error: unknown) => void,
  options?: ReadSessionOptions
): AgentRecord | null {
  const dir = sessionDir(agentDir, dateStr, recordId)
  if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
    const fromDir = readSessionDir(dir, onCorrupt, options)
    if (fromDir) return fromDir
    // 目录损坏时回退旧单体文件（若仍存在）
  }
  return applyRecordReadOptions(
    readAgentRecordFile(getAgentRecordPath(agentDir, dateStr, recordId), onCorrupt),
    options
  )
}

export async function readSessionRecordAsync(
  agentDir: string,
  dateStr: string,
  recordId: string,
  onCorrupt?: (corruptPath: string | null, error: unknown) => void,
  options?: ReadSessionOptions
): Promise<AgentRecord | null> {
  const dir = sessionDir(agentDir, dateStr, recordId)
  try {
    const st = await fs.promises.stat(dir)
    if (st.isDirectory()) {
      const fromDir = await readSessionDirAsync(dir, onCorrupt, options)
      if (fromDir) return fromDir
    }
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      onCorrupt?.(dir, e)
    }
  }
  return applyRecordReadOptions(
    await readAgentRecordFileAsync(getAgentRecordPath(agentDir, dateStr, recordId), onCorrupt),
    options
  )
}

export function applyRecordReadOptions(
  record: AgentRecord | null,
  options?: ReadSessionOptions
): AgentRecord | null {
  if (!record || !options?.omitCanvasData || !record.steps?.length) return record
  for (const step of record.steps) {
    if (step.canvasData) delete step.canvasData
  }
  return record
}

/** 会话目录绝对路径（不含 .json） */
export function getSessionDirPath(agentDir: string, dateStr: string, recordId: string): string {
  return sessionDir(agentDir, dateStr, recordId)
}

export interface SaveSessionOptions {
  /** 强制全量重写 jsonl（图片外化等原地改写步骤内容时使用） */
  forceRewrite?: boolean
}

/**
 * 增量保存：只追加新增 steps/messages，meta 始终小文件覆盖。
 * 步数未变时只写 meta（标题/状态/token 等）；首次或无法增量时全量写目录格式。
 * 若存在旧 .json 则删除。
 */
export function saveSessionRecord(
  agentDir: string,
  record: AgentRecord,
  options?: SaveSessionOptions
): void {
  const dateStr = new Date(record.timestamp).toISOString().split('T')[0]
  const dir = sessionDir(agentDir, dateStr, record.id)
  const legacyPath = getAgentRecordPath(agentDir, dateStr, record.id)

  const steps = record.steps || []
  const messages = record.messages || []

  let existingMeta: SessionMeta | null = null
  if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
    existingMeta = readMeta(dir)
  }

  // 磁盘实际行数可能 > meta（append 成功但 meta 未写完的 crash）；取 max 作 watermark 防重复
  const diskStepLines = existingMeta ? countJsonlLines(stepsPath(dir)) : 0
  const diskMessageLines = existingMeta ? countJsonlLines(messagesPath(dir)) : 0
  const baseSteps = existingMeta ? Math.max(existingMeta.stepCount, diskStepLines) : 0
  const baseMessages = existingMeta ? Math.max(existingMeta.messageCount, diskMessageLines) : 0

  const forceRewrite = options?.forceRewrite === true
  // 内存比磁盘短 → 异常回退或损坏行导致不一致，走全量重写
  const canAppend =
    !forceRewrite &&
    !!existingMeta &&
    steps.length >= baseSteps &&
    messages.length >= baseMessages

  if (canAppend && existingMeta) {
    const newSteps = steps.slice(baseSteps)
    const newMessages = messages.slice(baseMessages)
    appendJsonl(stepsPath(dir), newSteps)
    appendJsonl(messagesPath(dir), newMessages)
    writeMeta(dir, mergeTitleLock(recordToMeta(record, steps.length, messages.length), existingMeta))
  } else {
    // 全量重写目录（首次 / forceRewrite / 回退 / 从 legacy 迁入）
    fs.mkdirSync(dir, { recursive: true })
    writeJsonl(stepsPath(dir), steps)
    writeJsonl(messagesPath(dir), messages)
    writeMeta(dir, mergeTitleLock(recordToMeta(record, steps.length, messages.length), existingMeta))
  }

  // 清理旧单体文件
  if (fs.existsSync(legacyPath) && fs.statSync(legacyPath).isFile()) {
    try {
      fs.unlinkSync(legacyPath)
    } catch (e) {
      log.warn(`Failed to remove legacy session file ${legacyPath}:`, e)
    }
  }
}

/**
 * 仅更新标题（及索引侧需要的 meta 字段）。目录不存在则返回 false。
 */
export function updateSessionTitle(
  agentDir: string,
  dateStr: string,
  recordId: string,
  title: string,
  titleLocked?: boolean
): boolean {
  const trimmed = title.trim()
  if (!trimmed) return false
  const dir = sessionDir(agentDir, dateStr, recordId)
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return false
  const meta = readMeta(dir)
  if (!meta) return false
  const lock = titleLocked === true
  if (meta.title === trimmed && (!lock || meta.titleLocked)) return true
  meta.title = trimmed
  if (lock) meta.titleLocked = true
  writeMeta(dir, meta)
  return true
}

/** 仅更新审批方式（只改 meta.json）。目录不存在则返回 false。 */
export function updateSessionApproval(
  agentDir: string,
  dateStr: string,
  recordId: string,
  approval: ApprovalMode
): boolean {
  const dir = sessionDir(agentDir, dateStr, recordId)
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return false
  const meta = readMeta(dir)
  if (!meta) return false
  if (meta.approval === approval) return true
  meta.approval = approval
  writeMeta(dir, meta)
  return true
}

/** 删除会话目录（若存在）。删除失败返回 false，便于调用方回退删旧 .json。 */
export function deleteSessionDir(agentDir: string, dateStr: string, recordId: string): boolean {
  const dir = sessionDir(agentDir, dateStr, recordId)
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return false
  try {
    fs.rmSync(dir, { recursive: true, force: true })
    return !fs.existsSync(dir)
  } catch (e) {
    log.warn(`Failed to delete session dir ${dir}:`, e)
    return false
  }
}

/**
 * 列出某日下的会话 id（兼容 .json 文件与会话目录）。
 * 返回值不含扩展名，供调用方拼路径。
 */
export function listSessionIdsInDateDir(agentDir: string, dateStr: string): string[] {
  const dateDir = getAgentDateDir(agentDir, dateStr)
  if (!fs.existsSync(dateDir)) return []
  const ids = new Set<string>()
  for (const name of fs.readdirSync(dateDir)) {
    if (name.includes('.corrupt.')) continue
    const full = path.join(dateDir, name)
    if (name.endsWith('.json') && fs.statSync(full).isFile()) {
      ids.add(name.replace(/\.json$/, ''))
      continue
    }
    if (fs.statSync(full).isDirectory() && fs.existsSync(metaPath(full))) {
      ids.add(name)
    }
  }
  return Array.from(ids).sort()
}
