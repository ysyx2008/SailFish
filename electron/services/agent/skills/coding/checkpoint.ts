/**
 * 编程技能 - 检查点
 * 每个项目在旗鱼数据目录下有一个自己的影子仓库，工作区指向项目目录；从不读写项目自己的 .git。
 * 只记录项目 .gitignore 之外的文件；嵌套仓库只记一个指针，退回时不碰。
 */
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { GitCli, type GitRunResult } from './git'

export type CheckpointKind = 'open' | 'turn' | 'before_restore'

export interface Checkpoint {
  id: string
  tree: string
  createdAt: number
  kind: CheckpointKind
}

export type SnapshotResult =
  | { ok: true; checkpoint: Checkpoint }
  | { ok: false; reason: 'timeout' | 'failed'; detail: string }

export interface RestorePlan {
  target: Checkpoint
  /** 退回前给当时状态留的那一个 */
  saved: Checkpoint
  restored: string[]
  removed: string[]
  /** 嵌套仓库，没动 */
  skippedNested: string[]
}

export type RestoreOutcome =
  | { applied: true; plan: RestorePlan; failedRemovals: string[] }
  | { applied: false; plan: RestorePlan }

export type CheckpointErrorCode = 'snapshot_failed' | 'not_found' | 'no_target' | 'failed'

export class CheckpointError extends Error {
  /** saved：出错时已经给退回前的状态留好的检查点 */
  constructor(readonly code: CheckpointErrorCode, message: string, readonly saved?: Checkpoint) {
    super(message)
    this.name = 'CheckpointError'
  }
}

const SNAPSHOT_TIMEOUT_MS = 30_000
const SUBJECT_PREFIX = 'sailfish-checkpoint '
const GITLINK_MODE = '160000'
const PARTIAL_ADD_EXIT = 1
const KINDS: readonly CheckpointKind[] = ['open', 'turn', 'before_restore']
const COMMIT_ID = /^[0-9a-f]{4,40}$/i
const DEFAULT_TARGET_SCAN = 200
const LOCK_SETTLE_MS = 1000

export class CheckpointStore {
  /** 同一影子仓库的操作排队，免得两场对话同时拍快照抢索引锁 */
  private static readonly queues = new Map<string, Promise<unknown>>()

  static isAvailable(): Promise<boolean> {
    return GitCli.locate().then(Boolean)
  }

  static for(root: string, baseDir: string): CheckpointStore {
    const key = crypto.createHash('sha1').update(path.resolve(root)).digest('hex').slice(0, 16)
    return new CheckpointStore(root, path.join(baseDir, key))
  }

  private constructor(readonly root: string, readonly gitDir: string) {}

  snapshot(kind: CheckpointKind): Promise<SnapshotResult> {
    return this.exclusive(() => this.snapshotUnlocked(kind))
  }

  list(limit = 20): Promise<Checkpoint[]> {
    return this.exclusive(() => this.listUnlocked(limit))
  }

  /** a 之后到 b 为止改动的文件数（新增、删除、修改都算） */
  async changedFileCount(a: Checkpoint, b: Checkpoint): Promise<number> {
    if (a.tree === b.tree) return 0
    const res = await this.git(['diff', '--name-only', '-z', '--no-renames', a.id, b.id])
    return res.code === 0 ? res.stdout.split('\0').filter(Boolean).length : 0
  }

  /**
   * 退回第一步：给当前状态留一个检查点（留不住就不退），定下退到哪、会动哪些文件。
   * 不给 ref 就退到最近一个和当前内容不一样的轮次检查点。
   */
  prepareRestore(ref?: string): Promise<RestorePlan> {
    return this.exclusive(async () => {
      const snap = await this.snapshotUnlocked('before_restore')
      if (!snap.ok) throw new CheckpointError('snapshot_failed', snap.detail)
      const target = ref ? await this.resolve(ref) : await this.defaultTarget(snap.checkpoint)
      if (!target) throw new CheckpointError(ref ? 'not_found' : 'no_target', ref ?? '')
      return this.plan(target, snap.checkpoint)
    })
  }

  /**
   * 退回第二步。准备之后（比如确认框开着时用户自己改了文件）项目又变了就不动手：
   * 给新状态留一个检查点，交回按新状态重算的计划，由调用方重新确认。
   */
  applyRestore(plan: RestorePlan): Promise<RestoreOutcome> {
    return this.exclusive(async () => {
      const snap = await this.snapshotUnlocked('before_restore', plan.saved)
      if (!snap.ok) throw new CheckpointError('snapshot_failed', snap.detail)
      if (snap.checkpoint.id !== plan.saved.id) {
        return { applied: false, plan: await this.plan(plan.target, snap.checkpoint) }
      }
      const failedRemovals: string[] = []
      for (const rel of plan.removed) {
        if (!(await this.removeFile(rel))) failedRemovals.push(rel)
      }
      if (plan.restored.length > 0) await this.checkoutPaths(plan.target.id, plan.restored, plan.saved)
      return { applied: true, plan, failedRemovals }
    })
  }

  private async plan(target: Checkpoint, saved: Checkpoint): Promise<RestorePlan> {
    const plan: RestorePlan = { target, saved, restored: [], removed: [], skippedNested: [] }
    if (target.tree === saved.tree) return plan
    const diff = await this.git(['diff', '--raw', '-z', '--no-renames', '--no-ext-diff', target.id, saved.id])
    if (diff.code !== 0) throw new CheckpointError('failed', diff.stderr.trim())
    for (const entry of parseRawDiff(diff.stdout)) {
      if (isProjectGitPath(entry.path)) continue
      if (entry.oldMode === GITLINK_MODE || entry.newMode === GITLINK_MODE) plan.skippedNested.push(entry.path)
      else if (entry.status === 'A') plan.removed.push(entry.path)
      else plan.restored.push(entry.path)
    }
    return plan
  }

  /** unchangedFrom：内容和它一样就不另留，直接返回它 */
  private async snapshotUnlocked(kind: CheckpointKind, unchangedFrom?: Checkpoint): Promise<SnapshotResult> {
    const deadline = Date.now() + SNAPSHOT_TIMEOUT_MS
    const init = await this.ensureInit()
    if (init) return init

    const add = await this.git(['add', '-A', '--ignore-errors', '--', '.'], remaining(deadline))
    if (add.timedOut) return this.abandon()
    if (add.code !== 0 && add.code !== PARTIAL_ADD_EXIT) return { ok: false, reason: 'failed', detail: add.stderr.trim() }

    if (unchangedFrom) {
      const tree = await this.git(['write-tree'], remaining(deadline))
      if (tree.code === 0 && tree.stdout.trim() === unchangedFrom.tree) return { ok: true, checkpoint: unchangedFrom }
    }

    const commit = await this.git(
      ['commit', '-q', '--allow-empty', '--no-verify', '-m', `${SUBJECT_PREFIX}${kind}`],
      remaining(deadline),
    )
    if (commit.timedOut) return this.abandon()
    if (commit.code !== 0) return { ok: false, reason: 'failed', detail: commit.stderr.trim() }

    const head = await this.resolve('HEAD')
    return head ? { ok: true, checkpoint: head } : { ok: false, reason: 'failed', detail: 'HEAD missing after commit' }
  }

  private async listUnlocked(limit: number): Promise<Checkpoint[]> {
    if (!fs.existsSync(path.join(this.gitDir, 'HEAD'))) return []
    const res = await this.git(['log', `-n${limit}`, `--format=${LOG_FORMAT}`, 'HEAD'])
    if (res.code !== 0) return []
    return parseLog(res.stdout)
  }

  private async resolve(ref: string): Promise<Checkpoint | undefined> {
    if (ref !== 'HEAD' && !COMMIT_ID.test(ref)) return undefined
    if (!fs.existsSync(path.join(this.gitDir, 'HEAD'))) return undefined
    const res = await this.git(['log', '-n1', `--format=${LOG_FORMAT}`, `${ref}^{commit}`, '--'])
    return res.code === 0 ? parseLog(res.stdout)[0] : undefined
  }

  /**
   * 从新往旧找第一个和现在内容不一样的轮次检查点。
   * 被后来的退回撤掉的内容不算（否则连撤两次会把刚撤掉的又恢复回来），要回去得显式指定。
   */
  private async defaultTarget(current: Checkpoint): Promise<Checkpoint | undefined> {
    const rewoundAway = new Set<string>()
    for (const c of await this.listUnlocked(DEFAULT_TARGET_SCAN)) {
      if (c.kind === 'before_restore') {
        rewoundAway.add(c.tree)
        continue
      }
      if (c.tree !== current.tree && !rewoundAway.has(c.tree)) return c
    }
    return undefined
  }

  private async ensureInit(): Promise<SnapshotResult | undefined> {
    if (fs.existsSync(path.join(this.gitDir, 'HEAD'))) return undefined
    await fs.promises.mkdir(this.gitDir, { recursive: true })
    const res = await this.git(['init', '-q'])
    if (res.code !== 0) return { ok: false, reason: 'failed', detail: res.stderr.trim() }
    await fs.promises.writeFile(path.join(this.gitDir, 'sailfish-project'), `${this.root}\n`)
    return undefined
  }

  /**
   * 超时被杀时 git 一般会自己清掉索引锁；万一没清掉，下一轮就全失败。
   * 先等它退干净再清，免得和还没退出的进程抢着写索引。
   */
  private async abandon(): Promise<SnapshotResult> {
    await new Promise(resolve => setTimeout(resolve, LOCK_SETTLE_MS))
    await fs.promises.rm(path.join(this.gitDir, 'index.lock'), { force: true })
    return { ok: false, reason: 'timeout', detail: `${SNAPSHOT_TIMEOUT_MS / 1000}s` }
  }

  private async checkoutPaths(commit: string, paths: string[], saved: Checkpoint): Promise<void> {
    const listFile = path.join(this.gitDir, 'sailfish-restore-paths')
    await fs.promises.writeFile(listFile, paths.join('\0'))
    try {
      const res = await this.git(['checkout', commit, `--pathspec-from-file=${listFile}`, '--pathspec-file-nul'])
      if (res.code !== 0) throw new CheckpointError('failed', res.stderr.trim(), saved)
    } finally {
      await fs.promises.rm(listFile, { force: true })
    }
  }

  /** 删不掉返回 false。按真实路径判断，不顺着符号链接删到项目外面去 */
  private async removeFile(rel: string): Promise<boolean> {
    const abs = path.resolve(this.root, rel)
    try {
      const realRoot = await fs.promises.realpath(this.root)
      const realParent = await fs.promises.realpath(path.dirname(abs))
      if (realParent !== realRoot && !isInside(realRoot, realParent)) return false
      await fs.promises.rm(abs, { force: true })
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'ENOENT'
    }
    let dir = path.dirname(abs)
    while (dir !== this.root && isInside(this.root, dir)) {
      try {
        await fs.promises.rmdir(dir)
      } catch {
        break
      }
      dir = path.dirname(dir)
    }
    return true
  }

  private git(args: string[], timeoutMs = SNAPSHOT_TIMEOUT_MS): Promise<GitRunResult> {
    return GitCli.run(
      [
        '--git-dir', this.gitDir,
        '--work-tree', this.root,
        '--literal-pathspecs',
        '-c', `core.hooksPath=${path.join(this.gitDir, 'no-hooks')}`,
        '-c', 'commit.gpgsign=false',
        '-c', 'user.name=SailFish',
        '-c', 'user.email=checkpoint@sailfish.invalid',
        '-c', 'core.autocrlf=false',
        '-c', 'core.safecrlf=false',
        '-c', 'core.quotepath=false',
        '-c', 'core.longpaths=true',
        '-c', 'core.fsmonitor=false',
        '-c', 'advice.addEmbeddedRepo=false',
        ...args,
      ],
      { cwd: this.root, timeoutMs, env: { GIT_CONFIG_NOSYSTEM: '1' } },
    )
  }

  private exclusive<T>(job: () => Promise<T>): Promise<T> {
    const prev = CheckpointStore.queues.get(this.gitDir) ?? Promise.resolve()
    const next = prev.catch(() => undefined).then(job)
    CheckpointStore.queues.set(this.gitDir, next)
    const clear = () => {
      if (CheckpointStore.queues.get(this.gitDir) === next) CheckpointStore.queues.delete(this.gitDir)
    }
    next.then(clear, clear)
    return next
  }
}

const LOG_FORMAT = '%H%x1f%T%x1f%ct%x1f%s%x1e'

function parseLog(stdout: string): Checkpoint[] {
  const out: Checkpoint[] = []
  for (const record of stdout.split('\x1e')) {
    const [id, tree, ct, subject] = record.trim().split('\x1f')
    if (!id || !tree || !subject?.startsWith(SUBJECT_PREFIX)) continue
    const kind = subject.slice(SUBJECT_PREFIX.length) as CheckpointKind
    if (!KINDS.includes(kind)) continue
    out.push({ id, tree, createdAt: Number(ct) * 1000, kind })
  }
  return out
}

interface RawDiffEntry {
  oldMode: string
  newMode: string
  status: string
  path: string
}

/** `git diff --raw -z --no-renames`：每条是「:旧模式 新模式 旧id 新id 状态」后跟路径，用 NUL 分隔 */
function parseRawDiff(stdout: string): RawDiffEntry[] {
  const parts = stdout.split('\0')
  const out: RawDiffEntry[] = []
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = parts[i].replace(/^:/, '').split(' ')
    if (meta.length < 5) continue
    out.push({ oldMode: meta[0], newMode: meta[1], status: meta[4].charAt(0), path: parts[i + 1] })
  }
  return out
}

/** git 不会把项目自己的 .git 收进快照；这里再挡一道，退回时绝不碰它 */
function isProjectGitPath(rel: string): boolean {
  return rel.split('/')[0].toLowerCase() === '.git'
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

function remaining(deadline: number): number {
  return Math.max(1000, deadline - Date.now())
}
