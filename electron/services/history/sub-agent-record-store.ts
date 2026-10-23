/**
 * 伙计和专家的对话记录：存在各自主会话的下面，供被打断后接着干。
 *
 * 布局 `<根>/<日期>/<主会话号>/<伙计目录>/`，日期是主会话开始那天：
 *   state.json      名册里这位的样子（状态、结果、错误、没记录结果的调用）
 *   meta.json / steps.jsonl / messages.jsonl   对话记录，写法同主历史树（追加写、崩溃安全）
 * 另有 `<根>/<日期>/<主会话号>/_openings/<指纹>.json`：开局带的主人对话，内容相同的只存一份。
 *
 * 不进任何索引：不出现在最近对话和历史搜索里，用量统计也不扫这里。跟着主会话删、按天过期。
 */
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import type { AgentRecord, SubAgentResult } from '@shared/types'
import type { AiMessage } from '../ai.service'
import { writeFileAtomic } from '../../utils/atomic-write'
import { createLogger } from '../../utils/logger'
import { getDateString } from './date-util'
import { SessionDateTree, isSafePathSegment } from './session-date-tree'
import { readSessionDir, saveSessionRecordToDir } from './session-persistence'

const log = createLogger('SubAgentRecords')

const STATE_FILE = 'state.json'
const OPENINGS_DIR = '_openings'
/** 目录名里留名字的前几个字，方便人眼认；唯一性靠后面的指纹 */
const DIR_SLUG_CHARS = 24

export type ChildStatus = SubAgentResult['status']

/** 中断时没有记录结果的一次调用：哪个工具、动手的对象 */
export interface UnansweredCall {
  tool: string
  target?: string
}

/** 名册里这位的样子，不含对话 */
export interface ChildState {
  name: string
  /** 派的时候指定的名字没用上时，当时指定的那个 */
  askedName?: string
  description: string
  prompt: string
  shownPrompt?: string
  role?: string
  status: ChildStatus
  result?: string
  error?: string
  blockedReason?: string
  /** 开局带的主人对话的指纹；没带对话就没有 */
  opening?: string
  /** 上一段中断或失败时，没有记录结果的调用 */
  interruptedCalls?: UnansweredCall[]
  updatedAt: number
}

/** 名册交给存储的那部分（对话和开局由存储自己记） */
export type ChildStateInput = Pick<ChildState,
  'name' | 'askedName' | 'description' | 'prompt' | 'shownPrompt' | 'role' | 'status' | 'result' | 'error' | 'blockedReason'>

export interface PersistedChild {
  state: ChildState
  /** 存放位置，续做时凭它取对话 */
  dir: string
}

export interface ChildLocation {
  sessionId: string
  /** 主会话开始的时间，日期目录按它算 */
  startedAt: number
  name: string
}

/** 一位伙计的存盘人：这位的所有文件只由它写 */
export class ChildRecorder {
  private opening?: string
  private interruptedCalls?: UnansweredCall[]
  private lastInput?: ChildStateInput
  /** 自己在这个进程里已经写到第几条 */
  private written?: { steps: number; messages: number }
  private superseded = false

  constructor(
    private readonly store: SubAgentRecordStore,
    readonly dir: string,
    private readonly openingsDir: string,
    readonly name: string,
    seed?: { opening?: string; interruptedCalls?: UnansweredCall[] },
  ) {
    this.opening = seed?.opening
    this.interruptedCalls = seed?.interruptedCalls
  }

  /** 同一位后来又有了新的存盘人（重新叫起来的）：这个不再写，免得两边写进同一个目录 */
  retire(): void {
    this.superseded = true
  }

  /** 开局带的主人对话；内容相同的只存一份。没带对话就什么也不记 */
  noteOpening(seed: readonly AiMessage[]): void {
    if (this.superseded) return
    if (seed.length === 0) {
      this.opening = undefined
      return
    }
    const body = JSON.stringify(seed)
    const key = crypto.createHash('sha1').update(body).digest('hex').slice(0, 16)
    this.opening = key
    const file = path.join(this.openingsDir, `${key}.json`)
    try {
      if (fs.existsSync(file)) return
      fs.mkdirSync(this.openingsDir, { recursive: true })
      writeFileAtomic(file, body)
    } catch (err) {
      log.warn(`Opening save failed (${file}): ${err}`)
    }
  }

  /** 对话记录（每轮工具调用后的检查点、一段结束时的完整记录） */
  saveRecord(record: AgentRecord): void {
    if (this.superseded) return
    try {
      saveSessionRecordToDir(this.dir, record, this.written ? { knownCounts: this.written } : undefined)
      this.written = { steps: record.steps?.length ?? 0, messages: record.messages?.length ?? 0 }
    } catch (err) {
      this.written = undefined
      log.warn(`Sub-agent record save failed (${this.dir}): ${err}`)
    }
  }

  /** 这一段被打断或失败时没有记录结果的调用 */
  noteInterruptedCalls(calls: readonly UnansweredCall[]): void {
    if (this.superseded) return
    this.interruptedCalls = calls.length > 0 ? calls.map(c => ({ ...c })) : undefined
    if (this.lastInput) this.writeState(this.lastInput)
  }

  /** 名册里这位的样子变了。再次在干时，上一段留下的没记录结果的调用不再带着 */
  saveState(input: ChildStateInput): void {
    if (this.superseded) return
    this.lastInput = input
    if (input.status === 'pending' || input.status === 'running') this.interruptedCalls = undefined
    this.writeState(input)
  }

  private writeState(input: ChildStateInput): void {
    const state: ChildState = {
      name: input.name,
      ...(input.askedName ? { askedName: input.askedName } : {}),
      description: input.description,
      prompt: input.prompt,
      ...(input.shownPrompt ? { shownPrompt: input.shownPrompt } : {}),
      ...(input.role ? { role: input.role } : {}),
      status: input.status,
      ...(input.result !== undefined ? { result: input.result } : {}),
      ...(input.error ? { error: input.error } : {}),
      ...(input.blockedReason ? { blockedReason: input.blockedReason } : {}),
      ...(this.opening ? { opening: this.opening } : {}),
      ...(this.interruptedCalls ? { interruptedCalls: this.interruptedCalls } : {}),
      updatedAt: Date.now(),
    }
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      writeFileAtomic(path.join(this.dir, STATE_FILE), JSON.stringify(state))
    } catch (err) {
      log.warn(`Sub-agent state save failed (${this.dir}): ${err}`)
    }
  }
}

export class SubAgentRecordStore {
  private readonly tree: SessionDateTree
  /** 每位现在的存盘人，新建同一位的存盘人时让旧的退下 */
  private readonly recorders = new Map<string, ChildRecorder>()

  constructor(root: string) {
    this.tree = new SessionDateTree(root)
  }

  /** 为这位建存盘人；会话号或名字不能当路径用时返回 undefined（这位就不存盘） */
  recorderFor(location: ChildLocation): ChildRecorder | undefined {
    const dir = this.childDir(location)
    const openingsDir = this.openingsDir(location)
    if (!dir || !openingsDir) return undefined
    return this.register(dir, new ChildRecorder(this, dir, openingsDir, location.name))
  }

  /** 接着已存下来的这位建存盘人：沿用开局指纹，写入从磁盘实际条数对齐 */
  recorderForRestored(location: ChildLocation, state: ChildState): ChildRecorder | undefined {
    const dir = this.childDir(location)
    const openingsDir = this.openingsDir(location)
    if (!dir || !openingsDir) return undefined
    return this.register(dir, new ChildRecorder(this, dir, openingsDir, location.name, { opening: state.opening }))
  }

  /** 这场会话存下来的伙计。读不出的目录跳过 */
  list(sessionId: string): PersistedChild[] {
    const found: PersistedChild[] = []
    for (const sessionDir of this.tree.findSessionDirs(sessionId)) {
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(sessionDir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name === OPENINGS_DIR) continue
        const dir = path.join(sessionDir, entry.name)
        const state = readState(dir)
        if (state) found.push({ state, dir })
      }
    }
    return found.sort((a, b) => a.state.updatedAt - b.state.updatedAt)
  }

  /** 这位的对话记录；没存过对话返回 null */
  readRecord(child: PersistedChild): AgentRecord | null {
    return readSessionDir(child.dir)
  }

  /** 开局带的主人对话；指纹对应的文件不在就读不到 */
  readOpening(sessionId: string, key: string | undefined): AiMessage[] {
    if (!key || !/^[0-9a-f]+$/.test(key)) return []
    for (const sessionDir of this.tree.findSessionDirs(sessionId)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(sessionDir, OPENINGS_DIR, `${key}.json`), 'utf-8'))
        if (Array.isArray(parsed)) return parsed as AiMessage[]
      } catch {
        // 换下一天的目录找
      }
    }
    return []
  }

  deleteSession(sessionId: string): void {
    this.tree.deleteSession(sessionId)
    for (const key of [...this.recorders.keys()]) {
      if (key.includes(`${path.sep}${sessionId}${path.sep}`)) this.recorders.delete(key)
    }
  }

  deleteBefore(cutoff: string): void {
    this.tree.deleteBefore(cutoff)
  }

  deleteOrphans(liveSessionIds: ReadonlySet<string>, now = Date.now()): void {
    this.tree.deleteOrphans(liveSessionIds, now)
  }

  deleteAll(): void {
    this.tree.deleteAll()
    this.recorders.clear()
  }

  private register(dir: string, recorder: ChildRecorder): ChildRecorder {
    this.recorders.get(dir)?.retire()
    this.recorders.set(dir, recorder)
    return recorder
  }

  private sessionDirOf(location: ChildLocation): string | undefined {
    return this.tree.sessionDir(getDateString(location.startedAt), location.sessionId)
  }

  private childDir(location: ChildLocation): string | undefined {
    const sessionDir = this.sessionDirOf(location)
    if (!sessionDir || !location.name.trim()) return undefined
    return path.join(sessionDir, childDirName(location.name))
  }

  private openingsDir(location: ChildLocation): string | undefined {
    const sessionDir = this.sessionDirOf(location)
    return sessionDir ? path.join(sessionDir, OPENINGS_DIR) : undefined
  }
}

/**
 * 伙计的目录名：名字的前几个字加名字的指纹。名字只在名册里分大小写，文件系统可能不分；
 * 指纹跟着整个名字走，「Alice」和「alice」不会落进同一个目录。
 */
export function childDirName(name: string): string {
  const slug = [...name].filter(ch => isSafePathSegment(ch) && ch !== '.').slice(0, DIR_SLUG_CHARS).join('') || 'worker'
  const digest = crypto.createHash('sha1').update(name).digest('hex').slice(0, 8)
  return `${slug}-${digest}`
}

function readState(dir: string): ChildState | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, STATE_FILE), 'utf-8')) as Partial<ChildState>
    if (typeof parsed?.name !== 'string' || typeof parsed.description !== 'string' || typeof parsed.prompt !== 'string') return undefined
    if (!isChildStatus(parsed.status)) return undefined
    return { ...parsed, updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0 } as ChildState
  } catch {
    return undefined
  }
}

function isChildStatus(value: unknown): value is ChildStatus {
  return value === 'pending' || value === 'running' || value === 'completed' || value === 'failed' || value === 'interrupted'
}
