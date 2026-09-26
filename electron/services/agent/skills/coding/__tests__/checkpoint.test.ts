import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFileSync } from 'child_process'

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-cp-ud-'))
vi.mock('electron', () => ({ app: { getAppPath: () => process.cwd(), getPath: () => userData } }))

import { CheckpointStore, LARGE_FILE_BYTES, RETENTION_MS, UNUSED_DISCARD_MS } from '../checkpoint'
import { CheckpointJanitor } from '../checkpoint-janitor'
import { GitCli } from '../git'
import { executeCodingTool } from '../executor'
import { createSkillSession } from '../../skill-loader'
import type { AgentConfig, ToolExecutorConfig, ToolResult } from '../../../tools/types'
import '../index'

const hasGit = await GitCli.locate().then(Boolean)

let root: string

function write(rel: string, content: string): void {
  const p = path.join(root, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
}

function read(rel: string): string | undefined {
  const p = path.join(root, rel)
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : undefined
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'ignore' })
}

/** 用户 .git 里所有文件的内容指纹，用来证明检查点没碰它 */
function userGitFingerprint(): string {
  const hash = crypto.createHash('sha1')
  const walk = (dir: string) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, name)
      if (fs.statSync(p).isDirectory()) walk(p)
      else hash.update(p).update(fs.readFileSync(p))
    }
  }
  walk(path.join(root, '.git'))
  return hash.digest('hex')
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coding-cp-')))
  write('.gitignore', 'build/\n')
  write('src/a.ts', 'export const a = 1\n')
  write('src/keep.ts', 'export const keep = 1\n')
  write('docs/old.md', '# old\n')
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'init')
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

afterAll(() => {
  fs.rmSync(userData, { recursive: true, force: true })
})

describe.skipIf(!hasGit)('CheckpointStore', () => {
  const store = () => CheckpointStore.for(root, path.join(userData, 'store'))

  it('退回：改过的改回、删掉的恢复、新建的删掉；忽略的文件和项目自己的 .git 不动', async () => {
    const cp = store()
    expect((await cp.snapshot('turn')).ok).toBe(true)
    const before = userGitFingerprint()

    write('src/a.ts', 'export const a = 2\n')
    fs.rmSync(path.join(root, 'docs/old.md'))
    write('src/new/deep/b.ts', 'export const b = 1\n')
    write('build/out.js', 'built')
    expect((await cp.snapshot('turn')).ok).toBe(true)

    const plan = await cp.prepareRestore()
    expect(plan.restored.sort()).toEqual(['docs/old.md', 'src/a.ts'])
    expect(plan.removed).toEqual(['src/new/deep/b.ts'])
    await cp.applyRestore(plan)

    expect(read('src/a.ts')).toBe('export const a = 1\n')
    expect(read('docs/old.md')).toBe('# old\n')
    expect(fs.existsSync(path.join(root, 'src/new'))).toBe(false)
    expect(read('src/keep.ts')).toBe('export const keep = 1\n')
    expect(read('build/out.js')).toBe('built')
    expect(userGitFingerprint()).toBe(before)
  })

  it('连撤几次一步步往前退，不会把刚撤掉的又恢复回来', async () => {
    const cp = store()
    await cp.snapshot('open')
    write('src/a.ts', 'v1\n')
    await cp.snapshot('turn')
    write('src/a.ts', 'v2\n')
    await cp.snapshot('turn')

    await cp.applyRestore(await cp.prepareRestore())
    expect(read('src/a.ts')).toBe('v1\n')
    await cp.snapshot('turn')

    await cp.applyRestore(await cp.prepareRestore())
    expect(read('src/a.ts')).toBe('export const a = 1\n')

    await expect(cp.prepareRestore()).rejects.toMatchObject({ code: 'no_target' })
  })

  it('退回本身也能撤：指定退回前留下的那个就回到退回之前', async () => {
    const cp = store()
    await cp.snapshot('turn')
    write('src/a.ts', 'changed\n')
    await cp.snapshot('turn')
    const done = await cp.applyRestore(await cp.prepareRestore())
    expect(read('src/a.ts')).toBe('export const a = 1\n')

    await cp.applyRestore(await cp.prepareRestore(done.plan.saved.id.slice(0, 10)))
    expect(read('src/a.ts')).toBe('changed\n')
  })

  it('准备好之后项目又变了：先不动手，交回按新状态重算的计划', async () => {
    const cp = store()
    await cp.snapshot('turn')
    write('src/a.ts', 'agent edit\n')
    await cp.snapshot('turn')
    const plan = await cp.prepareRestore()
    expect(plan.removed).toEqual([])

    write('src/user.ts', 'user wrote this while the dialog was open\n')
    const first = await cp.applyRestore(plan)
    expect(first.applied).toBe(false)
    expect(first.plan.saved.id).not.toBe(plan.saved.id)
    expect(first.plan.removed).toEqual(['src/user.ts'])
    expect(read('src/a.ts')).toBe('agent edit\n')
    expect(read('src/user.ts')).toBeDefined()

    const second = await cp.applyRestore(first.plan)
    expect(second.applied).toBe(true)
    expect(read('src/a.ts')).toBe('export const a = 1\n')
    expect(read('src/user.ts')).toBeUndefined()
  })

  it('两次检查点之间用户自己提交过：退回只动工作区文件，项目的 .git 一字不动', async () => {
    const cp = store()
    await cp.snapshot('turn')
    write('src/a.ts', 'committed by user\n')
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'user commit')
    await cp.snapshot('turn')
    const before = userGitFingerprint()

    const plan = await cp.prepareRestore()
    expect([...plan.restored, ...plan.removed].some(p => p.split('/')[0] === '.git')).toBe(false)
    expect(plan.restored).toEqual(['src/a.ts'])
    await cp.applyRestore(plan)
    expect(read('src/a.ts')).toBe('export const a = 1\n')
    expect(userGitFingerprint()).toBe(before)
  })

  it('嵌套仓库不深入也不删', async () => {
    const cp = store()
    await cp.snapshot('turn')
    const nested = path.join(root, 'vendor/lib')
    fs.mkdirSync(nested, { recursive: true })
    fs.writeFileSync(path.join(nested, 'x.txt'), 'x')
    git(nested, 'init', '-q')
    git(nested, 'add', '-A')
    git(nested, 'commit', '-q', '-m', 'n')
    await cp.snapshot('turn')

    const plan = await cp.prepareRestore()
    expect(plan.skippedNested).toEqual(['vendor/lib'])
    await cp.applyRestore(plan)
    expect(fs.readFileSync(path.join(nested, 'x.txt'), 'utf8')).toBe('x')
  })

  it('不像检查点编号的输入一律当找不到', async () => {
    const cp = store()
    await cp.snapshot('turn')
    await expect(cp.prepareRestore('--all')).rejects.toMatchObject({ code: 'not_found' })
    await expect(cp.prepareRestore('main')).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe.skipIf(!hasGit)('检查点瘦身', () => {
  const base = () => path.join(userData, 'slim')
  const store = () => CheckpointStore.for(root, base())
  const shadow = (cp: CheckpointStore, ...args: string[]) =>
    execFileSync('git', ['--git-dir', cp.gitDir, ...args], { encoding: 'utf8' })
  const looseObjects = (cp: CheckpointStore) => Number(/^count: (\d+)/m.exec(shadow(cp, 'count-objects', '-v'))![1])
  const snapTree = (cp: CheckpointStore) => shadow(cp, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n').filter(Boolean)
  const makeLarge = (rel: string) => {
    write(rel, '')
    fs.truncateSync(path.join(root, rel), LARGE_FILE_BYTES + 1)
  }

  it('项目是 git 仓库：借读它已有的内容，自己几乎不存；退回照样对，项目的 .git 内容不变', async () => {
    const cp = store()
    const before = userGitFingerprint()
    const first = await cp.snapshot('open')
    expect(first.ok).toBe(true)
    expect(looseObjects(cp)).toBeLessThanOrEqual(1)
    expect(fs.readFileSync(path.join(cp.gitDir, 'objects/info/alternates'), 'utf8').trim())
      .toBe(path.join(root, '.git', 'objects'))

    write('src/a.ts', 'export const a = 2\n')
    const plan = await cp.prepareRestore()
    await cp.applyRestore(plan)
    expect(read('src/a.ts')).toBe('export const a = 1\n')
    expect(userGitFingerprint()).toBe(before)
  })

  it('项目的 .git 没了：旧检查点作废、从头再留，并说明重来了', async () => {
    const cp = store()
    await cp.snapshot('turn')
    const moved = `${root}-moved-git`
    fs.renameSync(path.join(root, '.git'), moved)
    try {
      write('src/a.ts', 'export const a = 2\n')
      const again = await cp.snapshot('turn')
      expect(again).toMatchObject({ ok: true, restarted: true })
      expect(await cp.list()).toHaveLength(1)
      const next = await cp.snapshot('turn')
      expect(next).toMatchObject({ ok: true, restarted: false })
    } finally {
      fs.rmSync(moved, { recursive: true, force: true })
    }
  })

  it('检查点依赖的内容被项目清理掉了：退回前发现、明说撤不了，项目不动', async () => {
    const cp = store()
    const first = await cp.snapshot('turn')
    if (!first.ok) throw new Error('snapshot failed')
    const blob = execFileSync('git', ['hash-object', 'src/a.ts'], { cwd: root, encoding: 'utf8' }).trim()
    write('src/a.ts', 'export const a = 2\n')
    fs.rmSync(path.join(root, '.git', 'objects', blob.slice(0, 2), blob.slice(2)), { force: true })

    await expect(cp.prepareRestore(first.checkpoint.id)).rejects.toMatchObject({ code: 'incomplete' })
    expect(read('src/a.ts')).toBe('export const a = 2\n')
  })

  it('超过 20MB 的文件不进检查点：撤回不删也不盖它、结果里列出；变小后重新纳入', async () => {
    const cp = store()
    const first = await cp.snapshot('turn')
    if (!first.ok) throw new Error('snapshot failed')

    makeLarge('data/big.bin')
    makeLarge('src/keep.ts')
    write('src/a.ts', 'export const a = 2\n')
    const second = await cp.snapshot('turn')
    expect(second).toMatchObject({ ok: true, largeFiles: ['data/big.bin', 'src/keep.ts'], newLargeFiles: ['data/big.bin', 'src/keep.ts'] })
    expect(snapTree(cp)).not.toContain('data/big.bin')
    expect(snapTree(cp)).not.toContain('src/keep.ts')

    const plan = await cp.prepareRestore(first.checkpoint.id)
    expect(plan.removed).not.toContain('data/big.bin')
    expect(plan.restored).not.toContain('src/keep.ts')
    expect(plan.largeFiles).toEqual(['data/big.bin', 'src/keep.ts'])
    await cp.applyRestore(plan)
    expect(read('src/a.ts')).toBe('export const a = 1\n')
    expect(fs.statSync(path.join(root, 'data/big.bin')).size).toBe(LARGE_FILE_BYTES + 1)
    expect(fs.statSync(path.join(root, 'src/keep.ts')).size).toBe(LARGE_FILE_BYTES + 1)

    fs.truncateSync(path.join(root, 'data/big.bin'), 10)
    const third = await cp.snapshot('turn')
    expect(third).toMatchObject({ ok: true, largeFiles: ['src/keep.ts'], newLargeFiles: [] })
    expect(snapTree(cp)).toContain('data/big.bin')
  })

  it('回收 7 天前的检查点：保留下来的编号不变；全都过期就只留最新一个；没过期不动', async () => {
    const cp = store()
    const ids: string[] = []
    for (const n of [2, 3, 4]) {
      write('src/a.ts', `export const a = ${n}\n`)
      const snap = await cp.snapshot('turn')
      if (!snap.ok) throw new Error('snapshot failed')
      ids.push(snap.checkpoint.id)
    }
    expect(await cp.cleanup(Date.now())).toBe('kept')

    expect(await cp.cleanup(Date.now() + RETENTION_MS + 60_000)).toBe('pruned')
    expect((await cp.list()).map(c => c.id)).toEqual([ids[2]])
    await expect(cp.prepareRestore(ids[0])).rejects.toMatchObject({ code: 'not_found' })
    expect(shadow(cp, 'fsck', '--no-progress', '--no-dangling')).toBe('')

    write('src/a.ts', 'export const a = 9\n')
    const plan = await cp.prepareRestore(ids[2])
    await cp.applyRestore(plan)
    expect(read('src/a.ts')).toBe('export const a = 4\n')
  })

  it('清理：30 天没用的、项目找不到且 7 天没用的整份删；刚找不到的（盘没插）留着；一天最多跑一次', async () => {
    const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coding-cp-gone-')))
    const unplugged = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coding-cp-unplugged-')))
    const stale = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coding-cp-stale-')))
    try {
      for (const dir of [other, unplugged, stale]) fs.writeFileSync(path.join(dir, 'x.txt'), 'x')
      const alive = store()
      const gone = CheckpointStore.for(other, base())
      const away = CheckpointStore.for(unplugged, base())
      const old = CheckpointStore.for(stale, base())
      for (const cp of [alive, gone, away, old]) expect((await cp.snapshot('turn')).ok).toBe(true)
      fs.rmSync(other, { recursive: true, force: true })
      fs.rmSync(unplugged, { recursive: true, force: true })
      const now = Date.now()
      fs.writeFileSync(path.join(gone.gitDir, 'sailfish-last-used'), String(now - RETENTION_MS - 60_000))
      fs.writeFileSync(path.join(old.gitDir, 'sailfish-last-used'), String(now - UNUSED_DISCARD_MS - 60_000))

      const janitor = new CheckpointJanitor(base(), () => now)
      expect(await janitor.runIfDue()).toBe(true)
      expect(fs.existsSync(alive.gitDir)).toBe(true)
      expect(fs.existsSync(away.gitDir)).toBe(true)
      expect(fs.existsSync(gone.gitDir)).toBe(false)
      expect(fs.existsSync(old.gitDir)).toBe(false)
      expect(await janitor.runIfDue()).toBe(false)
    } finally {
      for (const dir of [other, unplugged, stale]) fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('当时太大没收进去、后来变小的文件：撤回到那时不当成新建的删掉', async () => {
    const cp = store()
    makeLarge('data/big.bin')
    const target = await cp.snapshot('turn')
    if (!target.ok) throw new Error('snapshot failed')
    fs.truncateSync(path.join(root, 'data/big.bin'), 10)
    write('src/a.ts', 'export const a = 2\n')
    expect(await cp.snapshot('turn')).toMatchObject({ ok: true, largeFiles: [] })
    expect(snapTree(cp)).toContain('data/big.bin')

    const plan = await cp.prepareRestore(target.checkpoint.id)
    expect(plan.removed).not.toContain('data/big.bin')
    expect(plan.largeFiles).toEqual(['data/big.bin'])
    await cp.applyRestore(plan)
    expect(read('src/a.ts')).toBe('export const a = 1\n')
    expect(fs.statSync(path.join(root, 'data/big.bin')).size).toBe(10)
  })

  it('项目 git 一时读不到（不是没了）：不作废检查点', async () => {
    const cp = store()
    const first = await cp.snapshot('turn')
    if (!first.ok) throw new Error('snapshot failed')
    const gitDir = path.join(root, '.git')
    fs.chmodSync(gitDir, 0o000)
    try {
      // 这一轮可能留得住（文件刚写过、git 重读了内容），也可能如实失败；都不许作废旧的
      const again = await cp.snapshot('open')
      expect(again).not.toMatchObject({ restarted: true })
    } finally {
      fs.chmodSync(gitDir, 0o755)
    }
    expect((await cp.list()).map(c => c.id)).toContain(first.checkpoint.id)
    expect(fs.readFileSync(path.join(cp.gitDir, 'objects/info/alternates'), 'utf8').trim()).toBe(gitDir + '/objects')
  })

  it('借读的路径没变、内容却被项目清掉了：打开项目时发现、作废重来并说明', async () => {
    const cp = store()
    expect((await cp.snapshot('turn')).ok).toBe(true)
    const blob = execFileSync('git', ['hash-object', 'src/a.ts'], { cwd: root, encoding: 'utf8' }).trim()
    write('src/a.ts', 'export const a = 2\n')
    fs.rmSync(path.join(root, '.git', 'objects', blob.slice(0, 2), blob.slice(2)), { force: true })

    expect(await cp.snapshot('turn')).toMatchObject({ ok: true, restarted: false })
    expect(await cp.snapshot('open')).toMatchObject({ ok: true, restarted: true })
    expect(await cp.list()).toHaveLength(1)
  })

  it('退回时正好发现检查点作废：明说撤不了，不说「没有检查点」', async () => {
    const cp = store()
    await cp.snapshot('turn')
    const moved = `${root}-moved-git`
    fs.renameSync(path.join(root, '.git'), moved)
    try {
      await expect(cp.prepareRestore()).rejects.toMatchObject({ code: 'restarted' })
    } finally {
      fs.rmSync(moved, { recursive: true, force: true })
    }
  })

  it('影子仓库自己最新的提交丢了：不卡死，重来后照常留', async () => {
    const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coding-cp-plain-')))
    try {
      fs.writeFileSync(path.join(other, 'x.txt'), 'x')
      const cp = CheckpointStore.for(other, base())
      const first = await cp.snapshot('turn')
      if (!first.ok) throw new Error('snapshot failed')
      const id = first.checkpoint.id
      fs.rmSync(path.join(cp.gitDir, 'objects', id.slice(0, 2), id.slice(2)), { force: true })
      fs.writeFileSync(path.join(other, 'x.txt'), 'y')
      expect(await cp.snapshot('turn')).toMatchObject({ ok: true, restarted: true })
      expect(await cp.snapshot('turn')).toMatchObject({ ok: true, restarted: false })
    } finally {
      fs.rmSync(other, { recursive: true, force: true })
    }
  })
})

describe.skipIf(!hasGit)('code_rewind 端到端', () => {
  function setup(mode: AgentConfig['executionMode'], approve = true) {
    const session = createSkillSession([])
    const waitForConfirmation = vi.fn(async (..._args: unknown[]) => approve)
    const executor = {
      skillSession: session,
      addStep: vi.fn((s: object) => ({ ...s, id: 's', timestamp: 0 })),
      updateStep: vi.fn(),
      waitForConfirmation,
    } as unknown as ToolExecutorConfig
    const config = { executionMode: mode } as AgentConfig
    const call = (name: string, args: Record<string, unknown>): Promise<ToolResult> =>
      session.runToolCall(
        { name, args },
        () => executeCodingTool(name, '', args, 'c', config, executor),
        raw => path.resolve(root, raw),
      )
    return { session, call, waitForConfirmation }
  }

  it('模型改了文件、用命令新建了文件，下一轮说撤掉：项目回到改之前，项目的 .git 没变', async () => {
    const { session, call, waitForConfirmation } = setup('relaxed')
    await session.loadSkill('coding')
    const opened = await call('code_open_project', { path: root })
    expect(opened.output).toContain('code_rewind')
    const before = userGitFingerprint()

    await session.notifyRunStart({ isSubAgent: false })
    const edited = await call('code_multi_edit', {
      path: 'src/a.ts',
      edits: [{ old_text: 'export const a = 1', new_text: 'export const a = 42' }],
    })
    expect(edited.success).toBe(true)
    write('scripts/gen.sh', 'echo generated\n')

    await session.notifyRunStart({ isSubAgent: false })
    const listed = await call('code_rewind', { action: 'list' })
    expect(listed.output).toContain('（这场对话）')
    expect(listed.output).toContain('之后改了 2 个文件')

    const rewound = await call('code_rewind', { action: 'restore' })
    expect(rewound.success).toBe(true)
    expect(waitForConfirmation).toHaveBeenCalledTimes(1)
    expect(waitForConfirmation.mock.calls[0][3]).toBe('dangerous')
    expect(read('src/a.ts')).toBe('export const a = 1\n')
    expect(read('scripts/gen.sh')).toBeUndefined()
    expect(userGitFingerprint()).toBe(before)
  })

  it('确认框开着时项目又变了：按新清单再问一次，不拿旧的同意删新文件', async () => {
    const { session, call, waitForConfirmation } = setup('relaxed')
    await session.loadSkill('coding')
    await call('code_open_project', { path: root })
    write('src/a.ts', 'changed\n')
    await session.notifyRunStart({ isSubAgent: false })
    waitForConfirmation.mockImplementationOnce(async () => {
      write('src/late.ts', 'written while the dialog was open\n')
      return true
    })
    const result = await call('code_rewind', { action: 'restore' })
    expect(result.success).toBe(true)
    expect(waitForConfirmation).toHaveBeenCalledTimes(2)
    expect((waitForConfirmation.mock.calls[0][2] as { delete_files: string[] }).delete_files).toEqual([])
    expect((waitForConfirmation.mock.calls[1][2] as { delete_files: string[] }).delete_files).toEqual(['src/late.ts'])
    expect(read('src/late.ts')).toBeUndefined()
  })

  it('搜索不能越出项目', async () => {
    const { session, call } = setup('free')
    await session.loadSkill('coding')
    await call('code_open_project', { path: root })
    const result = await call('code_search', { pattern: 'x', path: '../..' })
    expect(result.success).toBe(false)
    expect(result.error).toContain('不在项目里')
  })

  it('用户不同意就不退', async () => {
    const { session, call } = setup('strict', false)
    await session.loadSkill('coding')
    await call('code_open_project', { path: root })
    write('src/a.ts', 'changed\n')
    await session.notifyRunStart({ isSubAgent: false })
    const result = await call('code_rewind', { action: 'restore' })
    expect(result.success).toBe(false)
    expect(read('src/a.ts')).toBe('changed\n')
  })

  it('全自动模式不问', async () => {
    const { session, call, waitForConfirmation } = setup('free')
    await session.loadSkill('coding')
    await call('code_open_project', { path: root })
    write('src/a.ts', 'changed\n')
    await session.notifyRunStart({ isSubAgent: false })
    expect((await call('code_rewind', { action: 'restore' })).success).toBe(true)
    expect(waitForConfirmation).not.toHaveBeenCalled()
    expect(read('src/a.ts')).toBe('export const a = 1\n')
  })

  it('伙计的一轮不留检查点', async () => {
    const { session, call } = setup('free')
    await session.loadSkill('coding')
    await call('code_open_project', { path: root })
    await session.notifyRunStart({ isSubAgent: true })
    const listed = await call('code_rewind', { action: 'list' })
    expect(listed.output.match(/^- /gm)).toHaveLength(1)
  })
})
