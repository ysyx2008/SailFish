import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFileSync } from 'child_process'

vi.mock('electron', () => ({ app: { getAppPath: () => process.cwd(), getPath: () => os.tmpdir() } }))

import { CodingProject, ProjectOpenError } from '../project'
import { Ripgrep } from '../ripgrep'
import { executeCodingTool } from '../executor'
import { createSkillSession } from '../../skill-loader'
import { resolveToolLocalPath } from '../../../tools/file'
import type { ToolExecutorConfig } from '../../../tools/types'
import '../index'

let root: string

function write(rel: string, content: string): void {
  const p = path.join(root, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
}

function git(...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root, stdio: 'ignore' })
}

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coding-project-')))
  write('.gitignore', 'node_modules/\ndist/\n')
  write('package.json', JSON.stringify({ scripts: { test: 'vitest run', lint: 'eslint .' } }))
  write('pnpm-lock.yaml', '')
  write('tsconfig.json', '{}')
  write('Makefile', '.PHONY: build\nbuild:\n\tgo build\nVAR := 1\ntest: build\n\tgo test\n')
  write('src/main.ts', 'export {}\n')
  write('src/lib/util.ts', 'export {}\n')
  write('node_modules/x/index.js', '')
  for (let i = 1; i <= 6; i++) write(`docs/note${i}.md`, '')
  write('AGENTS.md', 'A'.repeat(5000))
  write('.cursor/rules/always.mdc', '---\ndescription: x\nalwaysApply: true\n---\n\n# 总是生效\n')
  write('.cursor/rules/sometimes.mdc', '---\nalwaysApply: false\n---\n\n# 按需\n')
  git('init', '-q', '-b', 'main')
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
  write('src/new.ts', 'export {}\n')
})

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('CodingProject', () => {
  it('主目录和磁盘根不能当项目；不存在、不是目录要说清', async () => {
    await expect(CodingProject.open(os.homedir())).rejects.toMatchObject({ code: 'too_broad' })
    await expect(CodingProject.open(path.parse(root).root)).rejects.toMatchObject({ code: 'too_broad' })
    await expect(CodingProject.open(path.join(root, 'nope'))).rejects.toBeInstanceOf(ProjectOpenError)
    await expect(CodingProject.open(path.join(root, 'package.json'))).rejects.toMatchObject({ code: 'not_directory' })
  })

  it.skipIf(!Ripgrep.locate())('目录骨架跳过忽略的文件，目录带文件数', async () => {
    const project = await CodingProject.open(root)
    const tree = await project.buildTree(Ripgrep.create())
    const names = tree.entries.map(e => e.name)
    expect(names).not.toContain('node_modules')
    expect(names).toContain('.cursor')
    const src = tree.entries.find(e => e.name === 'src')!
    expect(src.isDir).toBe(true)
    expect(src.fileCount).toBe(3)
    expect(src.children?.map(c => c.name)).toEqual(['lib', 'main.ts', 'new.ts'])
    const docs = tree.entries.find(e => e.name === 'docs')!
    expect(docs.children).toEqual([])
    expect(docs.hiddenFiles).toBe(6)
    expect(tree.ignoreAware).toBe(true)
  })

  it('认出项目类型：scripts 按锁文件的包管理器列、Makefile 列目标', async () => {
    const project = await CodingProject.open(root)
    const toolchains = await project.detectToolchains()
    const node = toolchains.find(t => t.manifest === 'package.json')!
    expect(node.commands).toEqual([
      { name: 'pnpm run test', command: 'vitest run' },
      { name: 'pnpm run lint', command: 'eslint .' },
    ])
    expect(toolchains.find(t => t.manifest === 'tsconfig.json')?.commands).toEqual([{ command: 'npx tsc --noEmit' }])
    expect(toolchains.find(t => t.manifest === 'Makefile')?.commands.map(c => c.command)).toEqual(['make build', 'make test'])
  })

  it('项目约定：只收总是生效的规则，去掉头部元数据，超长截断', async () => {
    const project = await CodingProject.open(root)
    const conventions = await project.readConventions()
    expect(conventions.map(c => c.path)).toEqual(['AGENTS.md', '.cursor/rules/always.mdc'])
    expect(conventions[0].truncated).toBe(true)
    expect(conventions[0].totalChars).toBe(5000)
    expect(conventions[1].content).toBe('# 总是生效')
  })

  it('git 概况：分支和未提交改动', async () => {
    const project = await CodingProject.open(root)
    const overview = await project.gitOverview()
    expect(overview.kind).toBe('repo')
    if (overview.kind !== 'repo') return
    expect(overview.branchLine).toBe('main')
    expect(overview.changes).toEqual(['?? src/new.ts'])
    expect(path.normalize(overview.topLevel)).toBe(root)
  })
})

describe('code_open_project', () => {
  function makeExecutor() {
    const session = createSkillSession([])
    const steps: unknown[] = []
    const executor = {
      skillSession: session,
      addStep: vi.fn((s: unknown) => { steps.push(s); return s }),
    } as unknown as ToolExecutorConfig
    return { executor, session, steps }
  }

  it('没打开项目时搜索会提示先打开', async () => {
    const { executor, session } = makeExecutor()
    await session.loadSkill('coding')
    const result = await executeCodingTool('code_search', '', { pattern: 'x' }, 'c1', {} as never, executor)
    expect(result.success).toBe(false)
    expect(result.error).toContain('code_open_project')
  })

  it('打开后相对路径与默认工作目录落到项目根', async () => {
    const { executor, session } = makeExecutor()
    await session.loadSkill('coding')
    const result = await executeCodingTool('code_open_project', '', { path: root }, 'c1', {} as never, executor)
    expect(result.success).toBe(true)
    expect(result.output).toContain(root)
    expect(result.output).toContain('pnpm run test')
    expect(result.output).toContain('# 总是生效')
    expect(session.getWorkingDirectory()).toBe(root)
    expect(resolveToolLocalPath('src/main.ts', '', executor)).toBe(path.join(root, 'src/main.ts'))
  })

  it.skipIf(!Ripgrep.locate())('打开后能在项目里搜', async () => {
    const { executor, session } = makeExecutor()
    await session.loadSkill('coding')
    await executeCodingTool('code_open_project', '', { path: root }, 'c1', {} as never, executor)
    const found = await executeCodingTool('code_search', '', { pattern: 'export', output: 'files' }, 'c2', {} as never, executor)
    expect(found.success).toBe(true)
    expect(found.output).toContain(path.join('src', 'lib', 'util.ts'))
    expect(found.output).not.toContain('node_modules')
    const files = await executeCodingTool('code_find_files', '', { pattern: '*.ts', path: 'src/lib' }, 'c3', {} as never, executor)
    expect(files.output).toContain(path.join('src', 'lib', 'util.ts'))
    expect(files.output).not.toContain('main.ts')
  })
})
