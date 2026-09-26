/**
 * 编程技能 - 检查点
 * 每个项目在旗鱼数据目录下有一个自己的影子仓库，工作区指向项目目录；从不改项目自己的 .git。
 * 项目是 git 仓库时借读它的对象库（alternates），只多存它没有的；借读来源没了就核对、作废重来。
 * 只记录项目 .gitignore 之外、不超过 20MB 的文件；嵌套仓库只记一个指针，退回时不碰。
 */
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { GitCli, type GitRunOptions, type GitRunResult } from './git'

export type CheckpointKind = 'open' | 'turn' | 'before_restore'

export interface Checkpoint {
  id: string
  tree: string
  createdAt: number
  kind: CheckpointKind
}

export interface SnapshotInfo {
  checkpoint: Checkpoint
  /** 借读的来源没了，旧检查点作废、从头留的 */
  restarted: boolean
  /** 超过上限没进检查点的文件（项目内相对路径） */
  largeFiles: string[]
  /** 其中这次新出现的 */
  newLargeFiles: string[]
}

type SnapshotFailure = { ok: false; reason: 'timeout' | 'failed'; detail: string }

export type SnapshotResult = ({ ok: true } & SnapshotInfo) | SnapshotFailure

/** 单次记录的结果；是否重来由外层补上 */
type RecordResult = ({ ok: true } & Omit<SnapshotInfo, 'restarted'>) | SnapshotFailure

export interface RestorePlan {
  target: Checkpoint
  /** 退回前给当时状态留的那一个 */
  saved: Checkpoint
  restored: string[]
  removed: string[]
  /** 嵌套仓库，没动 */
  skippedNested: string[]
  /** 太大没进检查点，退回不动 */
  largeFiles: string[]
}

export type RestoreOutcome =
  | { applied: true; plan: RestorePlan; failedRemovals: string[] }
  | { applied: false; plan: RestorePlan }

export type CheckpointErrorCode =
  | 'snapshot_failed' | 'not_found' | 'no_target' | 'incomplete' | 'unverifiable' | 'restarted' | 'failed'

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
/** `cat-file -e`：对象不存在 */
const OBJECT_MISSING_EXIT = 1
const KINDS: readonly CheckpointKind[] = ['open', 'turn', 'before_restore']
const COMMIT_ID = /^[0-9a-f]{4,40}$/i
const DEFAULT_TARGET_SCAN = 200
const LOCK_SETTLE_MS = 1000
export const LARGE_FILE_BYTES = 20 * 1024 * 1024
const DAY_MS = 24 * 60 * 60 * 1000
export const RETENTION_MS = 7 * DAY_MS
export const UNUSED_DISCARD_MS = 30 * DAY_MS
/** 回收时放过最近一小时写的对象：另一个进程（桌面和命令行共用数据目录时）可能刚写、还没挂上 */
const PRUNE_GRACE = '1.hour.ago'
const STAT_BATCH = 64
const PROJECT_MARKER = 'sailfish-project'
const LAST_USED_MARKER = 'sailfish-last-used'
const LARGE_FILES_LIST = 'sailfish-large-files'
const PRUNE_SCAN = 100_000
const GC_TIMEOUT_MS = 120_000

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

  /** 按已有的影子仓库目录打开（清理时用）；不是检查点仓库返回 undefined */
  static async existing(gitDir: string): Promise<CheckpointStore | undefined> {
    try {
      const root = (await fs.promises.readFile(path.join(gitDir, PROJECT_MARKER), 'utf8')).trim()
      return root ? new CheckpointStore(root, gitDir) : undefined
    } catch {
      return undefined
    }
  }

  private constructor(readonly root: string, readonly gitDir: string) {}

  snapshot(kind: CheckpointKind): Promise<SnapshotResult> {
    return this.exclusive(() => this.snapshotUnlocked(kind))
  }

  /** 上次留检查点的时间；早先的仓库没有这个记录，退到索引文件的修改时间 */
  async lastUsedAt(): Promise<number | undefined> {
    try {
      const value = Number((await fs.promises.readFile(path.join(this.gitDir, LAST_USED_MARKER), 'utf8')).trim())
      if (Number.isFinite(value) && value > 0) return value
    } catch {
      // 退到索引
    }
    try {
      return (await fs.promises.stat(path.join(this.gitDir, 'index'))).mtimeMs
    } catch {
      return undefined
    }
  }

  /**
   * 清理：太久没用、或项目找不到且过了保留期，就整份删掉；否则回收保留期之前的检查点。
   * 找不到不立刻删：外置盘没插、网络盘断了也是找不到。
   * 判断和执行都在排队里做，免得和正在留的检查点交错（刚打开一个久没用的项目时不会被误删）。
   */
  cleanup(now = Date.now()): Promise<'discarded' | 'pruned' | 'kept'> {
    return this.exclusive(async () => {
      const lastUsed = await this.lastUsedAt() ?? 0
      if (lastUsed < now - UNUSED_DISCARD_MS || (lastUsed < now - RETENTION_MS && !(await isDirectory(this.root)))) {
        await fs.promises.rm(this.gitDir, { recursive: true, force: true })
        return 'discarded'
      }
      return (await this.pruneUnlocked(now)) ? 'pruned' : 'kept'
    })
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
      if (snap.restarted) throw new CheckpointError('restarted', '')
      const target = ref ? await this.resolve(ref) : await this.defaultTarget(snap.checkpoint)
      if (!target) throw new CheckpointError(ref ? 'not_found' : 'no_target', ref ?? '')
      return this.plan(target, snap.checkpoint, snap.largeFiles)
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
      if (snap.restarted) throw new CheckpointError('restarted', '')
      if (snap.checkpoint.id !== plan.saved.id) {
        return { applied: false, plan: await this.plan(plan.target, snap.checkpoint, snap.largeFiles) }
      }
      const failedRemovals: string[] = []
      for (const rel of plan.removed) {
        if (!(await this.removeFile(rel))) failedRemovals.push(rel)
      }
      if (plan.restored.length > 0) await this.checkoutPaths(plan.target.id, plan.restored, plan.saved)
      return { applied: true, plan, failedRemovals }
    })
  }

  private async plan(target: Checkpoint, saved: Checkpoint, largeFiles: string[]): Promise<RestorePlan> {
    const plan: RestorePlan = { target, saved, restored: [], removed: [], skippedNested: [], largeFiles }
    if (target.tree === saved.tree) return plan
    const completeness = await this.objectsCompleteness(target.id, false)
    if (completeness === 'missing') throw new CheckpointError('incomplete', target.id)
    if (completeness === 'unknown') throw new CheckpointError('unverifiable', target.id)
    const diff = await this.git(['diff', '--raw', '-z', '--no-renames', '--no-ext-diff', target.id, saved.id])
    if (diff.code !== 0) throw new CheckpointError('failed', diff.stderr.trim())
    // 现在太大的不在快照里，看起来像「被删了」；当时太大的不在目标里，现在变小了看起来像「新建的」。说好撤回不动它们
    const large = new Set(largeFiles)
    const largeThen = new Set(await this.largeFilesAt(target))
    // 只列和这次退回有关的：那时之后才变大 / 出现的，和这次因为太大跳过的
    const skippedLarge = new Set(largeFiles.filter(rel => !largeThen.has(rel)))
    for (const entry of parseRawDiff(diff.stdout)) {
      if (isProjectGitPath(entry.path)) continue
      if (large.has(entry.path) || largeThen.has(entry.path)) {
        skippedLarge.add(entry.path)
        continue
      }
      if (entry.oldMode === GITLINK_MODE || entry.newMode === GITLINK_MODE) plan.skippedNested.push(entry.path)
      else if (entry.status === 'A') plan.removed.push(entry.path)
      else plan.restored.push(entry.path)
    }
    plan.largeFiles = [...skippedLarge].sort()
    return plan
  }

  /** 留这个检查点时因为太大没收进去的文件；早先的检查点没记，当作没有 */
  private async largeFilesAt(checkpoint: Checkpoint): Promise<string[]> {
    const res = await this.git(['log', '-n1', '--format=%b', checkpoint.id, '--'])
    if (res.code !== 0 || !res.stdout.trim()) return []
    try {
      const parsed = JSON.parse(res.stdout.trim()) as { largeFiles?: unknown }
      return Array.isArray(parsed.largeFiles) ? parsed.largeFiles.filter((p): p is string => typeof p === 'string') : []
    } catch {
      return []
    }
  }

  /** unchangedFrom：内容和它一样就不另留，直接返回它 */
  private async snapshotUnlocked(kind: CheckpointKind, unchangedFrom?: Checkpoint): Promise<SnapshotResult> {
    const deadline = Date.now() + SNAPSHOT_TIMEOUT_MS
    const init = await this.ensureInit()
    if (init) return init

    // 打开项目时整体核对一次：借读的来源路径没变、内容却被清掉了（改写历史后 git 自己回收），只有这样才发现得了
    const intact = await this.ensureIntact(kind === 'open')
    let restarted = intact.restarted
    // 重来之后旧检查点都不在了，不能再拿它当「没变」的依据
    let result = await this.record(kind, deadline, restarted ? undefined : unchangedFrom)
    if (!result.ok && result.reason === 'failed' && !restarted && intact.verifiable
      && (await this.objectsCompleteness('HEAD', true)) === 'missing') {
      const failed = await this.restart()
      if (failed) return failed
      restarted = true
      result = await this.record(kind, deadline)
    }
    if (!result.ok) return result
    await fs.promises.writeFile(path.join(this.gitDir, LAST_USED_MARKER), String(Date.now()))
    return { ...result, restarted }
  }

  private async record(
    kind: CheckpointKind,
    deadline: number,
    unchangedFrom?: Checkpoint,
  ): Promise<RecordResult> {
    const large = await this.excludeLargeFiles(deadline)
    if ('ok' in large) return large
    const add = await this.git(['add', '-A', '--ignore-errors', '--', '.'], remaining(deadline))
    if (add.timedOut) return this.abandon()
    if (add.code !== 0 && add.code !== PARTIAL_ADD_EXIT) return { ok: false, reason: 'failed', detail: add.stderr.trim() }
    const info = { largeFiles: large.all, newLargeFiles: large.added }

    if (unchangedFrom) {
      const tree = await this.git(['write-tree'], remaining(deadline))
      if (tree.code === 0 && tree.stdout.trim() === unchangedFrom.tree) {
        return { ok: true, checkpoint: unchangedFrom, ...info }
      }
    }

    const messageFile = path.join(this.gitDir, 'sailfish-commit-message')
    const body = large.all.length > 0 ? `\n\n${JSON.stringify({ largeFiles: large.all })}\n` : '\n'
    await fs.promises.writeFile(messageFile, `${SUBJECT_PREFIX}${kind}${body}`)
    const commit = await this.git(
      ['commit', '-q', '--allow-empty', '--no-verify', '--cleanup=verbatim', '-F', messageFile],
      remaining(deadline),
    ).finally(() => fs.promises.rm(messageFile, { force: true }))
    if (commit.timedOut) return this.abandon()
    if (commit.code !== 0) return { ok: false, reason: 'failed', detail: commit.stderr.trim() }

    const head = await this.resolve('HEAD')
    return head
      ? { ok: true, checkpoint: head, ...info }
      : { ok: false, reason: 'failed', detail: 'HEAD missing after commit' }
  }

  /**
   * 对齐借读来源（项目自己的对象库）；来源变了或要求整体核对时，旧检查点缺内容就作废重来。
   * verifiable：借读来源这次确认过（查到了，或确定没有）。没确认时借读的内容看起来也像缺了，不能据此重来。
   */
  private async ensureIntact(fullCheck: boolean): Promise<{ restarted: boolean; verifiable: boolean }> {
    const have = await fs.promises.readFile(this.alternatesFile(), 'utf8').then(s => s.trim(), () => '')
    const source = await this.borrowSource(have)
    const kept = { restarted: false, verifiable: source.confirmed }
    if (!source.confirmed) return kept
    if (source.dir !== have) await this.writeAlternates(source.dir)
    else if (!fullCheck) return kept
    if (!(await this.hasCommits()) || (await this.objectsCompleteness('HEAD', true)) !== 'missing') return kept
    return { restarted: !(await this.restart()), verifiable: true }
  }

  /**
   * 该借读哪里。一时没查到（超时、权限、盘抖了一下）不等于没了：
   * 只有项目还在、原来借读的目录确实不存在了，才算来源没了；否则照旧、记为没确认。
   */
  private async borrowSource(have: string): Promise<{ dir: string; confirmed: boolean }> {
    const found = await this.projectObjectsDir()
    if (found) return { dir: found, confirmed: true }
    if (!have) return { dir: '', confirmed: true }
    const gone = (await isDirectory(this.root)) && (await isMissing(have))
    return gone ? { dir: '', confirmed: true } : { dir: have, confirmed: false }
  }

  /** 项目所在 git 仓库的对象库；不是 git 仓库、读不了返回 undefined。只读，不改项目的 git */
  private async projectObjectsDir(): Promise<string | undefined> {
    const res = await GitCli.run(['rev-parse', '--git-common-dir'], {
      cwd: this.root,
      timeoutMs: 5000,
      env: { GIT_CONFIG_NOSYSTEM: '1' },
    })
    if (res.code !== 0 || !res.stdout.trim()) return undefined
    const objects = path.join(path.resolve(this.root, res.stdout.trim()), 'objects')
    try {
      return (await fs.promises.stat(objects)).isDirectory() ? objects : undefined
    } catch {
      return undefined
    }
  }

  private alternatesFile(): string {
    return path.join(this.gitDir, 'objects', 'info', 'alternates')
  }

  private async writeAlternates(objectsDir: string): Promise<void> {
    if (!objectsDir) {
      await fs.promises.rm(this.alternatesFile(), { force: true })
      return
    }
    await fs.promises.mkdir(path.dirname(this.alternatesFile()), { recursive: true })
    await fs.promises.writeFile(this.alternatesFile(), `${objectsDir}\n`)
  }

  /** 丢掉整个影子仓库从头来（旧检查点缺内容时）；借读来源和大文件表留着。失败返回失败结果 */
  private async restart(): Promise<SnapshotFailure | undefined> {
    const borrowed = await fs.promises.readFile(this.alternatesFile(), 'utf8').then(s => s.trim(), () => '')
    const large = await this.readLargeList()
    await fs.promises.rm(this.gitDir, { recursive: true, force: true })
    const init = await this.ensureInit()
    if (init) return init
    await this.writeAlternates(borrowed)
    if (large.length > 0) await this.writeLargeList(large)
    return undefined
  }

  /** 留过检查点（只看引用；提交本身丢了也算留过，好让核对发现并重来） */
  private async hasCommits(): Promise<boolean> {
    if (!fs.existsSync(path.join(this.gitDir, 'HEAD'))) return false
    return (await this.git(['rev-parse', '-q', '--verify', 'HEAD'])).code === 0
  }

  /**
   * 这个提交（walk：连同它之前的全部）用到的对象是否都在（自己的库或借读的库里）；查不了算 unknown。
   * 提交本身丢了 git 列不出来，先单独看它在不在。
   */
  private async objectsCompleteness(rev: string, walk: boolean): Promise<'complete' | 'missing' | 'unknown'> {
    const tip = await this.git(['rev-parse', '-q', '--verify', rev])
    if (tip.code !== 0) return 'unknown'
    const exists = await this.git(['cat-file', '-e', tip.stdout.trim()])
    if (exists.code === OBJECT_MISSING_EXIT) return 'missing'
    if (exists.code !== 0) return 'unknown'
    const scan = await GitCli.findLine(
      this.gitArgs(['rev-list', '--objects', '--no-object-names', '--missing=print', ...(walk ? [] : ['--no-walk']), tip.stdout.trim()]),
      line => line.startsWith('?'),
      this.gitOptions(GC_TIMEOUT_MS),
    )
    if (scan.found) return 'missing'
    return scan.code === 0 ? 'complete' : 'unknown'
  }

  /**
   * 超过上限的文件记进排除表、移出索引，不进检查点。
   * 只看这次新出现 / 变过的文件和上次的大文件表，没变的文件不重复查。
   */
  private async excludeLargeFiles(deadline: number): Promise<{ all: string[]; added: string[] } | SnapshotFailure> {
    const previous = await this.readLargeList()
    const [untracked, modified] = await Promise.all([
      this.git(['ls-files', '-z', '-o', '--exclude-standard'], remaining(deadline)),
      this.git(['ls-files', '-z', '-m'], remaining(deadline)),
    ])
    const candidates = new Set(previous)
    for (const res of [untracked, modified]) {
      if (res.code !== 0) continue
      for (const rel of res.stdout.split('\0')) if (rel) candidates.add(rel)
    }
    const all = (await this.filterLarge([...candidates])).sort()
    const before = new Set(previous)
    const added = all.filter(rel => !before.has(rel))
    // 先移出索引再记表：移出失败这一轮就不留（否则会被整个存进去），表没更新，下一轮还会再移
    if (added.length > 0) {
      const res = await this.untrack(added, deadline)
      if (res.timedOut) return this.abandon()
      if (res.code !== 0) return { ok: false, reason: 'failed', detail: res.stderr.trim() }
    }
    if (all.join('\0') !== [...previous].sort().join('\0')) await this.writeLargeList(all)
    return { all, added }
  }

  private async filterLarge(paths: string[]): Promise<string[]> {
    const large: string[] = []
    for (let i = 0; i < paths.length; i += STAT_BATCH) {
      const batch = paths.slice(i, i + STAT_BATCH)
      const stats = await Promise.all(batch.map(rel => fs.promises.lstat(path.join(this.root, rel)).catch(() => undefined)))
      stats.forEach((stat, j) => {
        if (stat?.isFile() && stat.size > LARGE_FILE_BYTES) large.push(batch[j])
      })
    }
    return large
  }

  private async readLargeList(): Promise<string[]> {
    try {
      return (await fs.promises.readFile(path.join(this.gitDir, LARGE_FILES_LIST), 'utf8')).split('\0').filter(Boolean)
    } catch {
      return []
    }
  }

  /** 表存原样路径；另生成影子仓库自己的排除规则（不是项目的） */
  private async writeLargeList(paths: string[]): Promise<void> {
    await fs.promises.writeFile(path.join(this.gitDir, LARGE_FILES_LIST), paths.join('\0'))
    const infoDir = path.join(this.gitDir, 'info')
    await fs.promises.mkdir(infoDir, { recursive: true })
    const patterns = paths.filter(rel => !/[\r\n]/.test(rel)).map(excludePattern)
    await fs.promises.writeFile(path.join(infoDir, 'exclude'), patterns.length ? `${patterns.join('\n')}\n` : '')
  }

  private async untrack(paths: string[], deadline: number): Promise<GitRunResult> {
    const listFile = path.join(this.gitDir, 'sailfish-untrack-paths')
    await fs.promises.writeFile(listFile, paths.join('\0'))
    try {
      return await this.git(
        ['rm', '--cached', '-q', '--ignore-unmatch', `--pathspec-from-file=${listFile}`, '--pathspec-file-nul'],
        remaining(deadline),
      )
    } finally {
      await fs.promises.rm(listFile, { force: true })
    }
  }

  private async pruneUnlocked(now: number): Promise<boolean> {
    if (!(await this.hasCommits())) return false
    const all = await this.listUnlocked(PRUNE_SCAN)
    const kept = all.filter(c => c.createdAt >= now - RETENTION_MS)
    const boundary = kept.length > 0 ? kept[kept.length - 1] : all[0]
    if (!boundary || boundary.id === all[all.length - 1].id) return false
    // 把保留的最旧一个标成「没有更早的历史」：之前的提交没人引用了，gc 就能回收，保留的编号不变
    await fs.promises.writeFile(path.join(this.gitDir, 'shallow'), `${boundary.id}\n`)
    await this.git(['reflog', 'expire', '--expire=now', '--all'])
    return (await this.git(['gc', '--quiet', `--prune=${PRUNE_GRACE}`], GC_TIMEOUT_MS)).code === 0
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
    const found = res.code === 0 ? parseLog(res.stdout)[0] : undefined
    if (!found || ref === 'HEAD') return found
    // 只认还在检查点历史里的：回收掉的、宽限期内对象还没删的，都不算
    const inHistory = await this.git(['merge-base', '--is-ancestor', found.id, 'HEAD'])
    return inHistory.code === 0 ? found : undefined
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

  private async ensureInit(): Promise<SnapshotFailure | undefined> {
    if (fs.existsSync(path.join(this.gitDir, 'HEAD'))) return undefined
    await fs.promises.mkdir(this.gitDir, { recursive: true })
    const res = await this.git(['init', '-q'])
    if (res.code !== 0) return { ok: false, reason: 'failed', detail: res.stderr.trim() }
    await fs.promises.writeFile(path.join(this.gitDir, PROJECT_MARKER), `${this.root}\n`)
    return undefined
  }

  /**
   * 超时被杀时 git 一般会自己清掉索引锁；万一没清掉，下一轮就全失败。
   * 先等它退干净再清，免得和还没退出的进程抢着写索引。
   */
  private async abandon(): Promise<SnapshotFailure> {
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
    return GitCli.run(this.gitArgs(args), this.gitOptions(timeoutMs))
  }

  private gitOptions(timeoutMs: number): GitRunOptions {
    return { cwd: this.root, timeoutMs, env: { GIT_CONFIG_NOSYSTEM: '1' } }
  }

  private gitArgs(args: string[]): string[] {
    return [
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
      '-c', 'core.logAllRefUpdates=false',
      ...args,
    ]
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

/** 确实不存在（不是读不了） */
async function isMissing(p: string): Promise<boolean> {
  try {
    await fs.promises.stat(p)
    return false
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT'
  }
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(p)).isDirectory()
  } catch {
    return false
  }
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

function remaining(deadline: number): number {
  return Math.max(1000, deadline - Date.now())
}

/** 影子仓库排除规则里的一条：从项目根锚定、按原样匹配 */
function excludePattern(rel: string): string {
  const escaped = rel.replace(/[\\*?[\]!#]/g, '\\$&').replace(/ +$/, spaces => spaces.replace(/ /g, '\\ '))
  return `/${escaped}`
}
