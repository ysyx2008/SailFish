import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFileSync } from 'child_process'

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-cp-ud-'))
vi.mock('electron', () => ({ app: { getAppPath: () => process.cwd(), getPath: () => userData } }))

import { CheckpointStore } from '../checkpoint'
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
