/**
 * 编程技能 - ripgrep 封装
 * 定位二进制（安装包 → 开发态 resources → 系统 PATH），跑搜索、解析 --json 输出。
 */
import { spawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { appPath } from './app-path'

const BINARY_NAME = process.platform === 'win32' ? 'rg.exe' : 'rg'
const BUILDER_OS: Partial<Record<NodeJS.Platform, string>> = { darwin: 'mac', win32: 'win', linux: 'linux' }
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_STDERR_CHARS = 4000
/** 按修改时间排序前最多收这么多条，防止超大仓库把 stat 拖成几十万次 */
const MAX_COLLECTED_PATHS = 20_000

export interface RipgrepLine {
  line: number
  text: string
  isMatch: boolean
}

export interface RipgrepFileMatches {
  path: string
  lines: RipgrepLine[]
}

export interface RipgrepFilters {
  cwd: string
  /** 相对 cwd 的搜索路径，默认整个 cwd */
  paths?: string[]
  globs?: string[]
  fileType?: string
}

export interface ContentSearchOptions extends RipgrepFilters {
  pattern: string
  fixedStrings?: boolean
  /** true 区分大小写、false 忽略；不给则全小写时忽略（smart case） */
  caseSensitive?: boolean
  multiline?: boolean
  contextLines?: number
  maxMatches: number
}

export interface ContentSearchResult {
  files: RipgrepFileMatches[]
  matchCount: number
  truncated: boolean
  timedOut: boolean
}

export interface PathListResult {
  /** 按修改时间倒序 */
  paths: string[]
  total: number
  truncated: boolean
  timedOut: boolean
}

export interface CountResult {
  counts: Array<{ path: string; count: number }>
  total: number
  truncated: boolean
  timedOut: boolean
}

export class RipgrepNotFoundError extends Error {
  constructor() {
    super('ripgrep not found')
    this.name = 'RipgrepNotFoundError'
  }
}

export class RipgrepError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RipgrepError'
  }
}

interface RunOutcome {
  stopped: boolean
  timedOut: boolean
}

type RgJsonText = { text?: string; bytes?: string }

interface RgJsonEvent {
  type: string
  data?: {
    path?: RgJsonText
    lines?: RgJsonText
    line_number?: number
  }
}

export class Ripgrep {
  private static cachedBinary?: string

  /** 找不到返回 undefined；找到一次后缓存 */
  static locate(): string | undefined {
    if (Ripgrep.cachedBinary) return Ripgrep.cachedBinary
    const found = Ripgrep.candidates().find(isFile) ?? findOnPath(BINARY_NAME)
    if (found) Ripgrep.cachedBinary = found
    return found
  }

  static create(): Ripgrep {
    const binary = Ripgrep.locate()
    if (!binary) throw new RipgrepNotFoundError()
    return new Ripgrep(binary)
  }

  private static candidates(): string[] {
    const list: string[] = []
    if (process.resourcesPath) list.push(path.join(process.resourcesPath, 'ripgrep', BINARY_NAME))
    const osDir = BUILDER_OS[process.platform]
    if (osDir) {
      const roots = new Set([appPath(), process.cwd()].filter((p): p is string => Boolean(p)))
      for (const root of roots) {
        list.push(path.join(root, 'resources', 'ripgrep', `${osDir}-${process.arch}`, BINARY_NAME))
      }
    }
    return list
  }

  constructor(private readonly binary: string, private readonly timeoutMs = DEFAULT_TIMEOUT_MS) {}

  async searchContent(opts: ContentSearchOptions): Promise<ContentSearchResult> {
    const args = ['--json', ...this.patternArgs(opts)]
    if (opts.contextLines && opts.contextLines > 0) args.push('-C', String(opts.contextLines))
    args.push(...this.filterArgs(opts), '-e', opts.pattern, '--', ...this.searchPaths(opts))

    const files: RipgrepFileMatches[] = []
    const byPath = new Map<string, RipgrepFileMatches>()
    let matchCount = 0
    let truncated = false

    const outcome = await this.run(args, opts.cwd, line => {
      const event = parseEvent(line)
      if (!event || (event.type !== 'match' && event.type !== 'context')) return true
      const isMatch = event.type === 'match'
      if (isMatch && matchCount >= opts.maxMatches) {
        truncated = true
        return false
      }
      const filePath = normalizeOutputPath(decodeText(event.data?.path))
      let entry = byPath.get(filePath)
      if (!entry) {
        entry = { path: filePath, lines: [] }
        byPath.set(filePath, entry)
        files.push(entry)
      }
      const start = event.data?.line_number ?? 0
      const textLines = decodeText(event.data?.lines).replace(/\r?\n$/, '').split(/\r?\n/)
      textLines.forEach((text, i) => entry!.lines.push({ line: start + i, text, isMatch }))
      if (isMatch) matchCount++
      return true
    })

    return { files, matchCount, truncated, timedOut: outcome.timedOut }
  }

  /** 命中的文件，按修改时间倒序 */
  async filesWithMatches(opts: Omit<ContentSearchOptions, 'contextLines' | 'maxMatches'>, maxFiles: number): Promise<PathListResult> {
    const args = ['--files-with-matches', ...this.patternArgs(opts), ...this.filterArgs(opts), '-e', opts.pattern, '--', ...this.searchPaths(opts)]
    return this.collectPaths(args, opts.cwd, maxFiles)
  }

  /** 每个文件的命中数，多的在前 */
  async countMatches(opts: Omit<ContentSearchOptions, 'contextLines' | 'maxMatches'>, maxFiles: number): Promise<CountResult> {
    const args = ['--count-matches', '--with-filename', ...this.patternArgs(opts), ...this.filterArgs(opts), '-e', opts.pattern, '--', ...this.searchPaths(opts)]
    const counts: Array<{ path: string; count: number }> = []
    let truncated = false
    const outcome = await this.run(args, opts.cwd, line => {
      const sep = line.lastIndexOf(':')
      if (sep <= 0) return true
      const count = Number(line.slice(sep + 1))
      if (!Number.isFinite(count)) return true
      if (counts.length >= MAX_COLLECTED_PATHS) {
        truncated = true
        return false
      }
      counts.push({ path: normalizeOutputPath(line.slice(0, sep)), count })
      return true
    })
    counts.sort((a, b) => b.count - a.count || a.path.localeCompare(b.path))
    return {
      counts: counts.slice(0, maxFiles),
      total: counts.length,
      truncated: truncated || counts.length > maxFiles,
      timedOut: outcome.timedOut,
    }
  }

  /** 列文件（认忽略规则），按修改时间倒序 */
  async listFiles(filters: RipgrepFilters, maxFiles: number): Promise<PathListResult> {
    const args = ['--files', ...this.filterArgs(filters), '--', ...this.searchPaths(filters)]
    return this.collectPaths(args, filters.cwd, maxFiles)
  }

  /** 列文件（认忽略规则），不排序、不 stat，给目录骨架用 */
  async listFilesUnsorted(filters: RipgrepFilters, maxFiles: number): Promise<{ paths: string[]; truncated: boolean }> {
    const args = ['--files', ...this.filterArgs(filters), '--', ...this.searchPaths(filters)]
    const paths: string[] = []
    let truncated = false
    await this.run(args, filters.cwd, line => {
      if (!line) return true
      if (paths.length >= maxFiles) {
        truncated = true
        return false
      }
      paths.push(normalizeOutputPath(line))
      return true
    })
    return { paths, truncated }
  }

  private async collectPaths(args: string[], cwd: string, maxFiles: number): Promise<PathListResult> {
    const collected: string[] = []
    let truncated = false
    const outcome = await this.run(args, cwd, line => {
      if (!line) return true
      if (collected.length >= MAX_COLLECTED_PATHS) {
        truncated = true
        return false
      }
      collected.push(normalizeOutputPath(line))
      return true
    })
    const withTime = await Promise.all(collected.map(async p => ({ p, t: await mtimeOf(path.resolve(cwd, p)) })))
    withTime.sort((a, b) => b.t - a.t || a.p.localeCompare(b.p))
    return {
      paths: withTime.slice(0, maxFiles).map(x => x.p),
      total: collected.length,
      truncated: truncated || collected.length > maxFiles,
      timedOut: outcome.timedOut,
    }
  }

  private patternArgs(opts: Pick<ContentSearchOptions, 'fixedStrings' | 'caseSensitive' | 'multiline'>): string[] {
    const args: string[] = []
    if (opts.fixedStrings) args.push('--fixed-strings')
    if (opts.caseSensitive === true) args.push('--case-sensitive')
    else if (opts.caseSensitive === false) args.push('--ignore-case')
    else args.push('--smart-case')
    if (opts.multiline) args.push('--multiline', '--multiline-dotall')
    return args
  }

  /** 搜隐藏文件（.github 之类常有代码），但不进 .git；项目自己的忽略规则照常生效 */
  private filterArgs(filters: RipgrepFilters): string[] {
    const args = ['--no-config', '--hidden', '--glob', '!.git']
    for (const glob of filters.globs ?? []) args.push('--glob', glob)
    if (filters.fileType) args.push('--type', filters.fileType)
    return args
  }

  private searchPaths(filters: RipgrepFilters): string[] {
    return filters.paths && filters.paths.length > 0 ? filters.paths : ['.']
  }

  /**
   * 逐行把 stdout 交给 onLine；onLine 返回 false 就提前结束进程。
   * 退出码 1 = 没命中；2 = 出错（有输出时是部分文件读不了，照常返回；没输出时抛出 stderr）
   */
  private run(args: string[], cwd: string, onLine: (line: string) => boolean): Promise<RunOutcome> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      let buffer = ''
      let stderr = ''
      let stopped = false
      let timedOut = false
      let sawOutput = false

      const stop = () => {
        if (stopped) return
        stopped = true
        child.kill()
      }
      const timer = setTimeout(() => {
        timedOut = true
        stop()
      }, this.timeoutMs)

      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        if (stopped) return
        sawOutput = true
        buffer += chunk
        let newline = buffer.indexOf('\n')
        while (newline >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, '')
          buffer = buffer.slice(newline + 1)
          if (!onLine(line)) {
            stop()
            return
          }
          newline = buffer.indexOf('\n')
        }
      })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        if (stderr.length < MAX_STDERR_CHARS) stderr += chunk
      })
      child.on('error', err => {
        clearTimeout(timer)
        reject(err)
      })
      child.on('close', code => {
        clearTimeout(timer)
        if (!stopped && buffer) onLine(buffer.replace(/\r$/, ''))
        if (!stopped && code === 2 && !sawOutput) {
          reject(new RipgrepError(stderr.trim().slice(0, MAX_STDERR_CHARS) || 'ripgrep failed'))
          return
        }
        resolve({ stopped, timedOut })
      })
    })
  }
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

function findOnPath(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, name)
    if (isFile(candidate)) return candidate
  }
  return undefined
}

async function mtimeOf(p: string): Promise<number> {
  try {
    return (await fs.promises.stat(p)).mtimeMs
  } catch {
    return 0
  }
}

function parseEvent(line: string): RgJsonEvent | undefined {
  if (!line) return undefined
  try {
    return JSON.parse(line) as RgJsonEvent
  } catch {
    return undefined
  }
}

function decodeText(value: RgJsonText | undefined): string {
  if (!value) return ''
  if (typeof value.text === 'string') return value.text
  if (typeof value.bytes === 'string') return Buffer.from(value.bytes, 'base64').toString('utf8')
  return ''
}

/** 去掉搜 '.' 时 rg 带出的 './' 前缀 */
function normalizeOutputPath(p: string): string {
  if (p.startsWith('./') || p.startsWith('.\\')) return p.slice(2)
  return p
}
