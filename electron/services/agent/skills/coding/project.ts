/**
 * 编程技能 - 项目
 * 根目录校验；打开时的概况：目录骨架、git 状态、项目类型与命令、项目开发约定。
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { Ripgrep } from './ripgrep'
import { GitCli } from './git'

const TREE_MAX_FILES = 5000
const TREE_MAX_TOP_ENTRIES = 60
const TREE_MAX_CHILD_DIRS = 15
/** 子目录里直接放的文件多于这个数就只报个数 */
const TREE_MAX_CHILD_FILES = 5
const GIT_TIMEOUT_MS = 10_000
const GIT_MAX_CHANGES_SHOWN = 20
const SCRIPT_MAX_SHOWN = 30
const SCRIPT_COMMAND_MAX_CHARS = 120
const MAKE_TARGET_MAX_SHOWN = 20
const CONVENTION_PER_FILE_CHARS = 4000
const CONVENTION_TOTAL_CHARS = 12_000

export type ProjectOpenErrorCode = 'not_found' | 'not_directory' | 'too_broad'

export class ProjectOpenError extends Error {
  constructor(readonly code: ProjectOpenErrorCode, readonly target: string) {
    super(`${code}: ${target}`)
    this.name = 'ProjectOpenError'
  }
}

export interface TreeEntry {
  name: string
  isDir: boolean
  /** 目录下（认忽略规则后）的文件数 */
  fileCount?: number
  children?: TreeEntry[]
  hiddenDirs?: number
  /** 直接放在这个目录里、没逐个列出的文件数 */
  hiddenFiles?: number
}

export interface ProjectTree {
  entries: TreeEntry[]
  hiddenEntries: number
  fileCount: number
  /** 文件太多只数了前一部分 */
  partial: boolean
  /** 没有搜索程序时退化成只列顶层、不认忽略规则 */
  ignoreAware: boolean
}

export type GitOverview =
  | { kind: 'unavailable' }
  | { kind: 'not_repo' }
  | { kind: 'timeout' }
  | { kind: 'repo'; topLevel: string; branchLine: string; changes: string[]; changeCount: number }

export interface ProjectCommand {
  name?: string
  command: string
}

export interface Toolchain {
  manifest: string
  label: string
  commands: ProjectCommand[]
  hiddenCommands: number
}

export interface ConventionFile {
  path: string
  content: string
  totalChars: number
  truncated: boolean
}

export interface ProjectOverview {
  root: string
  tree: ProjectTree
  git: GitOverview
  toolchains: Toolchain[]
  conventions: ConventionFile[]
}

interface ManifestRule {
  file: string
  label: string
  commands?: string[]
  describe?: (project: CodingProject, file: string) => Promise<Pick<Toolchain, 'commands' | 'hiddenCommands'>>
}

const MANIFEST_RULES: ManifestRule[] = [
  { file: 'package.json', label: 'Node.js', describe: (p, f) => p.describePackageJson(f) },
  { file: 'tsconfig.json', label: 'TypeScript', commands: ['npx tsc --noEmit'] },
  { file: 'Cargo.toml', label: 'Rust', commands: ['cargo check', 'cargo test'] },
  { file: 'go.mod', label: 'Go', commands: ['go build ./...', 'go vet ./...', 'go test ./...'] },
  { file: 'pyproject.toml', label: 'Python' },
  { file: 'requirements.txt', label: 'Python' },
  { file: 'setup.py', label: 'Python' },
  { file: 'pom.xml', label: 'Java (Maven)' },
  { file: 'build.gradle', label: 'JVM (Gradle)' },
  { file: 'build.gradle.kts', label: 'JVM (Gradle)' },
  { file: 'CMakeLists.txt', label: 'C/C++ (CMake)' },
  { file: 'Makefile', label: 'Make', describe: (p, f) => p.describeMakefile(f) },
  { file: 'composer.json', label: 'PHP' },
  { file: 'Gemfile', label: 'Ruby' },
]

const DOTNET_EXTENSIONS = ['.sln', '.csproj', '.fsproj']

/** 锁文件 → 包管理器；都没有按 npm */
const LOCKFILE_MANAGERS: Array<[string, string]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
  ['package-lock.json', 'npm'],
]

/** 给 AI 看的项目约定文件，按这个顺序占预算 */
const CONVENTION_FILES = ['AGENTS.md', 'CLAUDE.md', '.github/copilot-instructions.md', '.cursorrules']
const CURSOR_RULES_DIR = '.cursor/rules'

export class CodingProject {
  private constructor(readonly root: string) {}

  /** 校验并规范化根目录（解析符号链接）。整个主目录、磁盘根目录不算项目 */
  static async open(absolutePath: string): Promise<CodingProject> {
    let real: string
    try {
      real = await fs.promises.realpath(absolutePath)
    } catch {
      throw new ProjectOpenError('not_found', absolutePath)
    }
    const stat = await fs.promises.stat(real)
    if (!stat.isDirectory()) throw new ProjectOpenError('not_directory', real)
    if (path.parse(real).root === real || real === (await safeRealpath(os.homedir()))) {
      throw new ProjectOpenError('too_broad', real)
    }
    return new CodingProject(real)
  }

  async overview(rg: Ripgrep | undefined): Promise<ProjectOverview> {
    const [tree, git, toolchains, conventions] = await Promise.all([
      this.buildTree(rg),
      this.gitOverview(),
      this.detectToolchains(),
      this.readConventions(),
    ])
    return { root: this.root, tree, git, toolchains, conventions }
  }

  async buildTree(rg: Ripgrep | undefined): Promise<ProjectTree> {
    if (!rg) return this.buildShallowTree()
    const { paths, truncated } = await rg.listFilesUnsorted({ cwd: this.root }, TREE_MAX_FILES)
    const top = new Map<string, { isDir: boolean; count: number; children: Map<string, { isDir: boolean; count: number }> }>()
    for (const p of paths) {
      const parts = p.split(/[\\/]/)
      const head = parts[0]
      let entry = top.get(head)
      if (!entry) {
        entry = { isDir: parts.length > 1, count: 0, children: new Map() }
        top.set(head, entry)
      }
      entry.count++
      if (parts.length > 1) {
        const childName = parts[1]
        const child = entry.children.get(childName) ?? { isDir: parts.length > 2, count: 0 }
        child.count++
        entry.children.set(childName, child)
      }
    }
    const all = sortEntries([...top].map(([name, e]): TreeEntry => {
      if (!e.isDir) return { name, isDir: false }
      const children = sortEntries([...e.children].map(([childName, c]): TreeEntry =>
        c.isDir ? { name: childName, isDir: true, fileCount: c.count } : { name: childName, isDir: false }))
      const dirs = children.filter(c => c.isDir)
      const files = children.filter(c => !c.isDir)
      const showFiles = files.length <= TREE_MAX_CHILD_FILES
      return {
        name,
        isDir: true,
        fileCount: e.count,
        children: [...dirs.slice(0, TREE_MAX_CHILD_DIRS), ...(showFiles ? files : [])],
        hiddenDirs: Math.max(0, dirs.length - TREE_MAX_CHILD_DIRS),
        hiddenFiles: showFiles ? 0 : files.length,
      }
    }))
    return {
      entries: all.slice(0, TREE_MAX_TOP_ENTRIES),
      hiddenEntries: Math.max(0, all.length - TREE_MAX_TOP_ENTRIES),
      fileCount: paths.length,
      partial: truncated,
      ignoreAware: true,
    }
  }

  private async buildShallowTree(): Promise<ProjectTree> {
    const dirents = await fs.promises.readdir(this.root, { withFileTypes: true })
    const all = sortEntries(dirents
      .filter(d => d.name !== '.git')
      .map(d => ({ name: d.name, isDir: d.isDirectory() })))
    return {
      entries: all.slice(0, TREE_MAX_TOP_ENTRIES),
      hiddenEntries: Math.max(0, all.length - TREE_MAX_TOP_ENTRIES),
      fileCount: 0,
      partial: false,
      ignoreAware: false,
    }
  }

  async gitOverview(): Promise<GitOverview> {
    if (!(await GitCli.locate())) return { kind: 'unavailable' }
    const top = await GitCli.run(['rev-parse', '--show-toplevel'], { cwd: this.root, timeoutMs: GIT_TIMEOUT_MS })
    if (top.timedOut) return { kind: 'timeout' }
    if (top.code !== 0) return { kind: 'not_repo' }
    const status = await GitCli.run(
      ['-c', 'core.quotepath=false', 'status', '--porcelain=v1', '--branch', '--', '.'],
      { cwd: this.root, timeoutMs: GIT_TIMEOUT_MS },
    )
    if (status.timedOut) return { kind: 'timeout' }
    const lines = status.stdout.split('\n').filter(Boolean)
    const branchLine = lines[0]?.startsWith('## ') ? lines.shift()!.slice(3) : ''
    return {
      kind: 'repo',
      topLevel: path.normalize(top.stdout.trim()),
      branchLine,
      changes: lines.slice(0, GIT_MAX_CHANGES_SHOWN),
      changeCount: lines.length,
    }
  }

  async detectToolchains(): Promise<Toolchain[]> {
    const names = new Set(await fs.promises.readdir(this.root))
    const result: Toolchain[] = []
    for (const rule of MANIFEST_RULES) {
      if (!names.has(rule.file)) continue
      const described = rule.describe
        ? await rule.describe(this, rule.file)
        : { commands: (rule.commands ?? []).map(command => ({ command })), hiddenCommands: 0 }
      result.push({ manifest: rule.file, label: rule.label, ...described })
    }
    const dotnet = [...names].find(n => DOTNET_EXTENSIONS.includes(path.extname(n)))
    if (dotnet) {
      result.push({
        manifest: dotnet,
        label: '.NET',
        commands: [{ command: 'dotnet build' }, { command: 'dotnet test' }],
        hiddenCommands: 0,
      })
    }
    return result
  }

  /** package.json 的 scripts 原样列出，用哪个由模型判断 */
  async describePackageJson(file: string): Promise<Pick<Toolchain, 'commands' | 'hiddenCommands'>> {
    const pkg = await readJson(path.join(this.root, file))
    const scripts = pkg && typeof pkg.scripts === 'object' && pkg.scripts ? pkg.scripts as Record<string, unknown> : {}
    const names = new Set(await fs.promises.readdir(this.root))
    const manager = LOCKFILE_MANAGERS.find(([lock]) => names.has(lock))?.[1] ?? 'npm'
    const entries = Object.entries(scripts).filter((e): e is [string, string] => typeof e[1] === 'string')
    return {
      commands: entries.slice(0, SCRIPT_MAX_SHOWN).map(([name, cmd]) => ({
        name: `${manager} run ${name}`,
        command: truncate(cmd, SCRIPT_COMMAND_MAX_CHARS),
      })),
      hiddenCommands: Math.max(0, entries.length - SCRIPT_MAX_SHOWN),
    }
  }

  async describeMakefile(file: string): Promise<Pick<Toolchain, 'commands' | 'hiddenCommands'>> {
    const text = await fs.promises.readFile(path.join(this.root, file), 'utf8').catch(() => '')
    const targets: string[] = []
    for (const line of text.split(/\r?\n/)) {
      const m = /^([A-Za-z0-9][\w.-]*)\s*:(?!=)/.exec(line)
      if (m && !targets.includes(m[1])) targets.push(m[1])
    }
    return {
      commands: targets.slice(0, MAKE_TARGET_MAX_SHOWN).map(t => ({ command: `make ${t}` })),
      hiddenCommands: Math.max(0, targets.length - MAKE_TARGET_MAX_SHOWN),
    }
  }

  async readConventions(): Promise<ConventionFile[]> {
    const candidates = [...CONVENTION_FILES, ...(await this.alwaysApplyCursorRules())]
    const result: ConventionFile[] = []
    let remaining = CONVENTION_TOTAL_CHARS
    for (const rel of candidates) {
      const raw = await fs.promises.readFile(path.join(this.root, rel), 'utf8').catch(() => undefined)
      if (raw === undefined) continue
      const text = stripFrontmatter(raw).trim()
      if (!text) continue
      const allowance = Math.min(CONVENTION_PER_FILE_CHARS, remaining)
      const content = text.slice(0, allowance)
      remaining -= content.length
      result.push({ path: rel, content, totalChars: text.length, truncated: content.length < text.length })
    }
    return result
  }

  /** .cursor/rules 下声明总是生效的规则（alwaysApply: true） */
  private async alwaysApplyCursorRules(): Promise<string[]> {
    const dir = path.join(this.root, CURSOR_RULES_DIR)
    const files = await listFilesRecursive(dir).catch(() => [] as string[])
    const picked: string[] = []
    for (const abs of files.filter(f => f.endsWith('.mdc')).sort()) {
      const raw = await fs.promises.readFile(abs, 'utf8').catch(() => '')
      if (frontmatterValue(raw, 'alwaysApply') === 'true') {
        picked.push(path.relative(this.root, abs).split(path.sep).join('/'))
      }
    }
    return picked
  }
}

function sortEntries(entries: TreeEntry[]): TreeEntry[] {
  return entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
}

async function safeRealpath(p: string): Promise<string> {
  return fs.promises.realpath(p).catch(() => p)
}

async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await fs.promises.readFile(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

async function listFilesRecursive(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const d of await fs.promises.readdir(dir, { withFileTypes: true })) {
    const abs = path.join(dir, d.name)
    if (d.isDirectory()) out.push(...(await listFilesRecursive(abs)))
    else if (d.isFile()) out.push(abs)
  }
  return out
}

function splitFrontmatter(raw: string): { header: string; body: string } | undefined {
  const text = raw.replace(/^\uFEFF/, '')
  if (!/^---\r?\n/.test(text)) return undefined
  const end = text.search(/\r?\n---\s*(\r?\n|$)/)
  if (end < 0) return undefined
  const header = text.slice(text.indexOf('\n') + 1, end)
  const after = text.slice(end).replace(/^\r?\n---\s*(\r?\n)?/, '')
  return { header, body: after }
}

function stripFrontmatter(raw: string): string {
  return splitFrontmatter(raw)?.body ?? raw
}

function frontmatterValue(raw: string, key: string): string | undefined {
  const fm = splitFrontmatter(raw)
  if (!fm) return undefined
  for (const line of fm.header.split(/\r?\n/)) {
    const idx = line.indexOf(':')
    if (idx > 0 && line.slice(0, idx).trim() === key) return line.slice(idx + 1).trim()
  }
  return undefined
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}
