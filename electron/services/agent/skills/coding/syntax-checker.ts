/**
 * 编程技能 - 改后语法检查（tree-sitter）
 * 按扩展名选语法，改前改后各解析一次，只报改后多出来的错误。
 */
import * as fs from 'fs'
import * as path from 'path'
import { Parser, Language, type Node } from 'web-tree-sitter'
import { BUNDLED_WASM_DIR, GRAMMAR_BY_EXTENSION, grammarSourceDir } from './grammars'
import { appPath } from './app-path'

/** 超过这么大的文件不查（主线程解析，大文件会卡） */
/** 解析在主进程同步跑，改前改后各一遍；512KB 约 0.1 秒 */
const MAX_FILE_BYTES = 512 * 1024
const MAX_ISSUES_PER_PARSE = 50
const SNIPPET_MAX_CHARS = 120

export interface SyntaxIssue {
  line: number
  column: number
  /** 缺了什么（解析器补出来的缺失符号）；没有就是一段认不出的代码 */
  missing?: string
  /** 出错位置所在的那一行 */
  snippet: string
}

export class SyntaxChecker {
  private static sharedInstance?: SyntaxChecker
  private runtime?: Promise<void>
  private readonly languages = new Map<string, Promise<Language>>()

  static shared(): SyntaxChecker {
    if (!SyntaxChecker.sharedInstance) SyntaxChecker.sharedInstance = new SyntaxChecker()
    return SyntaxChecker.sharedInstance
  }

  constructor(private readonly locator: WasmLocator = new WasmLocator()) {}

  supports(filePath: string): boolean {
    return grammarFor(filePath) !== undefined
  }

  static isTooLarge(bytes: number): boolean {
    return bytes > MAX_FILE_BYTES
  }

  /** 认不出的语言返回 undefined */
  async findIssues(filePath: string, text: string): Promise<SyntaxIssue[] | undefined> {
    const grammar = grammarFor(filePath)
    if (!grammar) return undefined
    const language = await this.language(grammar)
    const parser = new Parser()
    try {
      parser.setLanguage(language)
      const tree = parser.parse(text)
      if (!tree) return undefined
      try {
        return collectIssues(tree.rootNode, text)
      } finally {
        tree.delete()
      }
    } finally {
      parser.delete()
    }
  }

  /** 改后比改前多出来的错误；按出错那一行的文字比对，不看行号（改动会让后面的行号整体偏移） */
  async newIssues(filePath: string, before: string, after: string): Promise<SyntaxIssue[] | undefined> {
    const afterIssues = await this.findIssues(filePath, after)
    if (!afterIssues || afterIssues.length === 0) return afterIssues
    const beforeIssues = before ? (await this.findIssues(filePath, before)) ?? [] : []
    const remaining = new Map<string, number>()
    for (const issue of beforeIssues) remaining.set(issueKey(issue), (remaining.get(issueKey(issue)) ?? 0) + 1)
    return afterIssues.filter(issue => {
      const key = issueKey(issue)
      const left = remaining.get(key) ?? 0
      if (left > 0) {
        remaining.set(key, left - 1)
        return false
      }
      return true
    })
  }

  private async ensureRuntime(): Promise<void> {
    if (!this.runtime) {
      this.runtime = (async () => {
        const wasmBinary = await fs.promises.readFile(this.locator.runtime())
        await Parser.init({ wasmBinary })
      })()
      this.runtime.catch(() => { this.runtime = undefined })
    }
    return this.runtime
  }

  private language(grammar: string): Promise<Language> {
    let pending = this.languages.get(grammar)
    if (!pending) {
      pending = (async () => {
        await this.ensureRuntime()
        const bytes = await fs.promises.readFile(this.locator.grammar(grammar))
        return Language.load(new Uint8Array(bytes))
      })()
      pending.catch(() => this.languages.delete(grammar))
      this.languages.set(grammar, pending)
    }
    return pending
  }
}

/**
 * 找 wasm：打包后在主进程产物目录（构建时拷过去，只带要用的几种语法）；
 * 开发态 / 命令行直接读仓库里的源位置。
 */
export class WasmLocator {
  runtime(): string {
    return this.find([
      path.join(BUNDLED_WASM_DIR, 'tree-sitter.wasm'),
      path.join('node_modules', 'web-tree-sitter', 'tree-sitter.wasm'),
    ])
  }

  grammar(name: string): string {
    const file = `tree-sitter-${name}.wasm`
    return this.find([
      path.join(BUNDLED_WASM_DIR, file),
      path.join(grammarSourceDir(name), file),
    ])
  }

  /** 只在应用自己的目录里找；不看当前目录——命令行下那是用户的项目 */
  private find(relatives: string[]): string {
    const roots = [...new Set([__dirname, appPath()].filter((p): p is string => Boolean(p)))]
    const candidates = relatives.flatMap(rel => roots.map(root => path.join(root, rel)))
    const found = candidates.find(candidate => fs.existsSync(candidate))
    if (found) return found
    throw new Error(`tree-sitter wasm not found, tried: ${candidates.join(', ')}`)
  }
}

function grammarFor(filePath: string): string | undefined {
  return GRAMMAR_BY_EXTENSION[path.extname(filePath).toLowerCase()]
}

function collectIssues(root: Node, text: string): SyntaxIssue[] {
  const issues: SyntaxIssue[] = []
  if (!root.hasError) return issues
  const lines = text.split(/\r?\n/)
  const visit = (node: Node): void => {
    if (issues.length >= MAX_ISSUES_PER_PARSE) return
    if (node.isMissing || node.isError) {
      const { row, column } = node.startPosition
      issues.push({
        line: row + 1,
        column: column + 1,
        ...(node.isMissing && { missing: node.type }),
        snippet: clip((lines[row] ?? '').trim(), SNIPPET_MAX_CHARS),
      })
      return
    }
    if (!node.hasError) return
    for (const child of node.children) {
      if (child) visit(child)
    }
  }
  visit(root)
  return issues
}

function issueKey(issue: SyntaxIssue): string {
  return `${issue.missing ?? ''}\u0000${issue.snippet}`
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}
