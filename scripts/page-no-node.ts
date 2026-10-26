/**
 * 页面（主窗口、文件管理，以及以后新加的页面）没有 Node。
 * 页面能引用到的代码一旦 import / require 了 Node 或 electron，打包插件会把它改写成 require()，
 * 窗口一打开整页空白，构建却是成功的。构建开始时走一遍，碰到就停下。
 * 只看各页面 html 里 type=module 且带 src 的脚本，顺着运行时的 import / export / require 走。
 * 只引用类型不算。内联脚本、import.meta.glob、Worker 不在这条链上。
 *
 * shared/oem-runtime.ts 源文件里有给命令行用的磁盘探测，打包时整文件换成不含 Node 的那一版。
 * 检查看的是换过之后的那一版，和打包插件用同一份，避免各看各的。
 */
import fs from 'node:fs'
import path from 'node:path'
import { isBuiltin } from 'node:module'
import ts from 'typescript'
import { parse as parseSfc } from '@vue/compiler-sfc'
import type { Plugin } from 'vite'

/** 和 vite.config.ts 的页面入口一致。打包时以实际 input 为准，这里是测试和缺省。 */
export const PAGE_HTML = ['index.html', 'file-manager.html', 'ai-debug.html', 'llm-bench.html']

const ASSET = /\.(css|scss|sass|less|svg|png|jpe?g|gif|webp|ico|woff2?|ttf|eot|mp3|wav|mp4|webm)([?#]|$)/
const CODE_EXT = ['.ts', '.tsx', '.vue', '.mts', '.mjs', '.js', '.cjs']
const OPAQUE_REQUIRE = '__dynamic_require__'

export interface PageNodeViolation {
  /** 页面 html，相对仓库根 */
  entry: string
  /** 从页面入口脚本到写出这条引用的文件，绝对路径 */
  chain: string[]
  specifier: string
}

interface Alias {
  kind: 'exact' | 'prefix'
  prefix: string
  target: string
}

export function pageOemRuntimeSource(root: string): { source: string; usingOverride: boolean } {
  const usingOverride = fs.existsSync(path.join(root, 'shared/oem.config.ts'))
  const from = usingOverride ? './oem.config' : './oem-defaults'
  const source = `
export type { OemConfig, OemFeatures, OemFeatureKey, OemBrand, OemSsoConfig, OemSsoGateMode, OemSsoVerifyIdToken } from './oem-types'
export { OEM_FEATURE_DEFAULTS } from './oem-types'
export { oemConfig } from '${from}'
`
  return { source, usingOverride }
}

export function findPageNodeImports(root: string, htmlFiles: string[] = PAGE_HTML): PageNodeViolation[] {
  const aliases = loadAliases(root)
  const replacements = new Map<string, string>([
    [path.resolve(root, 'shared/oem-runtime.ts'), pageOemRuntimeSource(root).source],
  ])
  const entries = moduleEntries(root, htmlFiles)
  const parent = new Map<string, string>()
  const entryOf = new Map<string, string>()
  const seen = new Set<string>()
  const queue: string[] = []
  const violations: PageNodeViolation[] = []

  for (const item of entries) {
    const file = path.resolve(item.file)
    if (!entryOf.has(file)) entryOf.set(file, item.entry)
    queue.push(file)
  }

  while (queue.length > 0) {
    const file = queue.shift()!
    if (seen.has(file)) continue
    seen.add(file)
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      violations.push(violation(root, file, entryOf, parent, '没找到这个文件'))
      continue
    }
    let specs: string[]
    try {
      specs = runtimeSpecifiers(file, readSource(file, replacements))
    } catch (err) {
      violations.push(violation(root, file, entryOf, parent, `解析失败: ${err instanceof Error ? err.message : String(err)}`))
      continue
    }
    for (const spec of specs) {
      if (isForbidden(spec)) {
        violations.push(violation(root, file, entryOf, parent, spec === OPAQUE_REQUIRE ? '动态 require' : spec))
        continue
      }
      if (ASSET.test(spec)) continue
      const next = resolveImport(root, file, spec, aliases)
      if (!next) {
        if (spec.startsWith('.')) {
          violations.push(violation(root, file, entryOf, parent, `没找到 ${spec}`))
        }
        continue
      }
      if (next.includes(`${path.sep}node_modules${path.sep}`)) continue
      if (!parent.has(next)) parent.set(next, file)
      if (!entryOf.has(next)) entryOf.set(next, entryOf.get(file) ?? path.relative(root, file))
      queue.push(next)
    }
  }

  return violations
}

export function formatPageNodeViolations(root: string, violations: PageNodeViolation[]): string {
  const nodeHits = violations.filter(v => !isLookupFailure(v.specifier))
  const lookupHits = violations.filter(v => isLookupFailure(v.specifier))
  const parts: string[] = []
  if (nodeHits.length > 0) {
    parts.push([
      '页面引用了 Node，构建停住。',
      '这些窗口没有 Node。页面脚本里一旦出现 require，打开就是空白。',
      '用到 Node 的代码留在主进程，页面通过预加载交出来的接口去问。',
      '',
      formatChains(root, nodeHits),
    ].join('\n'))
  }
  if (lookupHits.length > 0) {
    parts.push([
      '页面的入口或引用没对上，构建停住。',
      '',
      formatChains(root, lookupHits),
    ].join('\n'))
  }
  return parts.join('\n\n')
}

function isLookupFailure(specifier: string): boolean {
  return specifier.startsWith('没找到') || specifier.startsWith('解析失败')
}

function formatChains(root: string, violations: PageNodeViolation[]): string {
  return violations.map(v => {
    const lines = [v.entry, ...v.chain.map(file => path.relative(root, file)), v.specifier]
    return lines.join('\n  → ')
  }).join('\n\n')
}

export function pageNoNodePlugin(): Plugin {
  let root = process.cwd()
  let htmlFiles = PAGE_HTML
  return {
    name: 'page-no-node',
    configResolved(config) {
      root = config.root
      htmlFiles = htmlFilesFromInput(config.root, config.build.rollupOptions.input) ?? PAGE_HTML
    },
    buildStart() {
      const violations = findPageNodeImports(root, htmlFiles)
      if (violations.length === 0) return
      this.error(formatPageNodeViolations(root, violations))
    },
  }
}

function htmlFilesFromInput(root: string, input: unknown): string[] | null {
  if (!input) return null
  const files = typeof input === 'string'
    ? [input]
    : Array.isArray(input)
      ? input.filter((item): item is string => typeof item === 'string')
      : Object.values(input as Record<string, string>)
  const html = files
    .map(file => path.resolve(root, file))
    .filter(file => file.endsWith('.html'))
    .map(file => path.relative(root, file))
  return html.length > 0 ? html : null
}

function moduleEntries(root: string, htmlFiles: string[]): { entry: string; file: string }[] {
  const out: { entry: string; file: string }[] = []
  for (const html of htmlFiles) {
    const abs = path.resolve(root, html)
    if (!fs.existsSync(abs)) continue
    const entry = path.relative(root, abs)
    for (const src of moduleScriptSrcs(fs.readFileSync(abs, 'utf8'))) {
      const file = src.startsWith('/')
        ? path.join(root, src)
        : path.resolve(path.dirname(abs), src)
      out.push({ entry, file })
    }
  }
  return out
}

function moduleScriptSrcs(html: string): string[] {
  const out: string[] = []
  const tags = html.matchAll(/<script\b([^>]*)>/gi)
  for (const tag of tags) {
    const attrs = tag[1] ?? ''
    if (!/\btype\s*=\s*["']module["']/.test(attrs)) continue
    const src = attrs.match(/\bsrc\s*=\s*["']([^"']+)["']/)
    if (src) out.push(src[1])
  }
  return out
}

function violation(
  root: string,
  file: string,
  entryOf: Map<string, string>,
  parent: Map<string, string>,
  specifier: string,
): PageNodeViolation {
  return {
    entry: entryOf.get(file) ?? path.relative(root, file),
    chain: chainOf(file, parent),
    specifier,
  }
}

function chainOf(file: string, parent: Map<string, string>): string[] {
  const out: string[] = []
  const guard = new Set<string>()
  let cur: string | undefined = file
  while (cur && !guard.has(cur)) {
    guard.add(cur)
    out.push(cur)
    cur = parent.get(cur)
  }
  return out.reverse()
}

function isForbidden(spec: string): boolean {
  if (spec === OPAQUE_REQUIRE) return true
  const bare = spec.split('?')[0].split('#')[0]
  if (bare === 'electron' || bare.startsWith('electron/')) return true
  if (isBuiltin(bare)) return true
  const head = (bare.startsWith('node:') ? bare.slice(5) : bare).split('/')[0]
  return head.length > 0 && (isBuiltin(head) || isBuiltin(`node:${head}`))
}

function readSource(file: string, replacements: Map<string, string>): string {
  const replaced = replacements.get(path.resolve(file))
  if (replaced !== undefined) return replaced
  return fs.readFileSync(file, 'utf8')
}

function runtimeSpecifiers(file: string, source: string): string[] {
  const script = file.endsWith('.vue') ? vueScript(file, source) : { code: source, lang: langOf(file) }
  if (!script.code.trim()) return []
  const sf = ts.createSourceFile(file, script.code, ts.ScriptTarget.Latest, true, scriptKind(file, script.lang))
  const specs: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!isTypeOnlyImport(node)) specs.push(node.moduleSpecifier.text)
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!node.isTypeOnly && !isTypeOnlyNamedExport(node)) specs.push(node.moduleSpecifier.text)
    } else if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) {
      const expr = node.moduleReference.expression
      if (ts.isStringLiteral(expr)) specs.push(expr.text)
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      // 只跟字面量。import(变量) 是页面正常的分包；require(变量) 页面里不该出现，下面单独报。
      const arg = node.arguments[0]
      if (arg && ts.isStringLiteral(arg)) specs.push(arg.text)
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') {
      const arg = node.arguments[0]
      specs.push(arg && ts.isStringLiteral(arg) ? arg.text : OPAQUE_REQUIRE)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return specs
}

function isTypeOnlyNamedExport(node: ts.ExportDeclaration): boolean {
  const clause = node.exportClause
  if (!clause || !ts.isNamedExports(clause)) return false
  return clause.elements.length > 0 && clause.elements.every(el => el.isTypeOnly)
}

function isTypeOnlyImport(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause
  if (!clause) return false
  if (clause.isTypeOnly) return true
  if (clause.name) return false
  const named = clause.namedBindings
  if (!named || !ts.isNamedImports(named)) return false
  return named.elements.length > 0 && named.elements.every(el => el.isTypeOnly)
}

function langOf(file: string): string {
  if (file.endsWith('.tsx') || file.endsWith('.jsx')) return 'tsx'
  if (file.endsWith('.js') || file.endsWith('.mjs') || file.endsWith('.cjs')) return 'js'
  return 'ts'
}

function scriptKind(file: string, lang: string): ts.ScriptKind {
  if (lang === 'tsx' || lang === 'jsx' || file.endsWith('.tsx') || file.endsWith('.jsx')) return ts.ScriptKind.TSX
  if (lang === 'js' || file.endsWith('.js') || file.endsWith('.mjs') || file.endsWith('.cjs')) return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

function vueScript(file: string, source: string): { code: string; lang: string } {
  const { descriptor, errors } = parseSfc(source, { filename: file })
  if (errors.length > 0) {
    throw new Error(errors[0].message)
  }
  const blocks = [descriptor.script, descriptor.scriptSetup].filter((block): block is NonNullable<typeof block> => !!block)
  return {
    code: blocks.map(block => block.content).join('\n'),
    lang: blocks.find(block => block.lang)?.lang ?? 'ts',
  }
}

function loadAliases(root: string): Alias[] {
  const file = path.join(root, 'tsconfig.json')
  if (!fs.existsSync(file)) return []
  const read = ts.readConfigFile(file, ts.sys.readFile)
  if (read.error) return []
  const opts = (read.config?.compilerOptions ?? {}) as { baseUrl?: string; paths?: Record<string, string[]> }
  const base = path.resolve(root, opts.baseUrl ?? '.')
  const aliases: Alias[] = []
  for (const [key, targets] of Object.entries(opts.paths ?? {})) {
    const target = targets[0]
    if (!target) continue
    if (key.includes('*')) {
      const prefix = key.slice(0, key.indexOf('*'))
      const dir = target.slice(0, target.indexOf('*'))
      aliases.push({ kind: 'prefix', prefix, target: path.resolve(base, dir) })
    } else {
      aliases.push({ kind: 'exact', prefix: key, target: path.resolve(base, target) })
    }
  }
  aliases.sort((a, b) => b.prefix.length - a.prefix.length)
  return aliases
}

function resolveImport(root: string, fromFile: string, spec: string, aliases: Alias[]): string | null {
  const bare = spec.split('?')[0].split('#')[0]
  let candidate: string | null = null
  if (bare.startsWith('.')) {
    candidate = path.resolve(path.dirname(fromFile), bare)
  } else if (bare.startsWith('/')) {
    candidate = path.join(root, bare)
  } else {
    candidate = applyAlias(bare, aliases)
    if (!candidate) return null
  }
  return tryFile(candidate)
}

function applyAlias(spec: string, aliases: Alias[]): string | null {
  for (const alias of aliases) {
    if (alias.kind === 'exact') {
      if (spec === alias.prefix) return alias.target
      continue
    }
    if (spec.startsWith(alias.prefix)) return path.join(alias.target, spec.slice(alias.prefix.length))
  }
  return null
}

function tryFile(candidate: string): string | null {
  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
  for (const ext of CODE_EXT) {
    const withExt = candidate + ext
    if (fs.existsSync(withExt) && fs.statSync(withExt).isFile()) return withExt
  }
  for (const ext of CODE_EXT) {
    const index = path.join(candidate, `index${ext}`)
    if (fs.existsSync(index) && fs.statSync(index).isFile()) return index
  }
  return null
}
