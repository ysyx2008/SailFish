/**
 * 从 shell-ast 解析结果提取 AuditedCall 列表
 */
import type { CallExprNode, Redirect, ShellFile, Stmt } from '@questi0nm4rk/shell-ast'
import type { UnwrappedCall } from '@questi0nm4rk/shell-ast'
import { parseShellCommand, getShellAstModule } from './parser'
import type { AuditedCall, AuditedRedirect, AuditContext } from './types'
import { basenameCommand } from './whitelist'
import { unescapeShellWordLiteral } from './unescape-shell-literal'
import { isLexicallyAbsolutePath } from './workspace-guard'

function shellDialect(ctx: AuditContext): 'bash' | 'posix' | 'mksh' {
  if (ctx.shell === 'sh') return 'posix'
  return 'bash'
}

function mapRedirectOp(op: string): AuditedRedirect['op'] {
  switch (op) {
    case '>':
    case '>>':
    case '<':
    case '2>':
    case '2>>':
    case '&>':
    case '2>&1':
      return op
    case '>|':
      return '>'
    case '&>>':
      return '>>'
    default:
      return '>'
  }
}

function isWriteRedirectOp(op: string): boolean {
  return ['>', '>>', '>|', '&>', '&>>', '<>'].includes(op)
}

function redirectNodeToAudited(
  r: Redirect,
  wordToLit: (word: import('@questi0nm4rk/shell-ast').Word) => string | null,
): AuditedRedirect | null {
  const target = wordToLit(r.word)
  if (!target) return null
  return {
    op: mapRedirectOp(r.op),
    target: unescapeShellWordLiteral(target),
    isWrite: isWriteRedirectOp(r.op),
  }
}

interface CallsAndAllRedirs {
  callsWithRedirs: { callNode: CallExprNode; redirs: AuditedRedirect[] }[]
  /** 所有 Stmt 的写重定向（含 Subshell/Block 上的，用于 orphan 兜底评估） */
  allWriteRedirects: AuditedRedirect[]
}

/**
 * 遍历 AST 所有 Stmt，收集「Stmt.cmd 为 CallExpr」的 (callNode, stmtRedirs) 对，
 * 以及所有 Stmt 的写重定向（含 Subshell/Block 上的 orphan redirect）。
 *
 * shell 语义里 redirect 挂在 Stmt 上，不是 CallExpr 上（CallExprNode 无 redirs 字段）。
 * 一个 Stmt 的 redirs 属于该 Stmt 的 cmd：
 *   - cmd 是 CallExpr：redirect 归属这个 call（如 `echo x > file`）
 *   - cmd 是 Subshell/Block：redirect 属于整个块，不归给内部任何 call（如 `(a; b) > file`）
 *   - cmd 是 BinaryCmd：redirect 在各分支的 Stmt 上（管道 `a | b > file` 里 >file 在 b 的 Stmt）
 */
async function collectCallsWithRedirs(ast: ShellFile): Promise<CallsAndAllRedirs> {
  const { walk, wordToLit } = await getShellAstModule()
  const callsWithRedirs: { callNode: CallExprNode; redirs: AuditedRedirect[] }[] = []
  const allWriteRedirects: AuditedRedirect[] = []
  walk(ast as unknown as import('@questi0nm4rk/shell-ast').ShellNode, {
    Stmt: (stmt: Stmt) => {
      const redirs = stmt.redirs
        .map(r => redirectNodeToAudited(r, wordToLit))
        .filter((r): r is AuditedRedirect => r !== null)
      for (const r of redirs) {
        if (r.isWrite) allWriteRedirects.push(r)
      }
      if (stmt.cmd?.type === 'CallExpr') {
        callsWithRedirs.push({ callNode: stmt.cmd, redirs })
      }
      // Subshell/Block 上的 redirect 不归给任何 call，但已在 allWriteRedirects 中，
      // 供 assess-shell.ts 的 orphan 兜底评估。
    },
  })
  return { callsWithRedirs, allWriteRedirects }
}

// ==================== cd 锚点 ====================
//
// 唯一认得的形状：整条命令里有且只有一个 `cd 绝对路径`，它是最前面那串 `&&` 的一环，
// 排在它后面的命令执行时的当前目录就确定了（cd 失败则后面不会跑）。
// 其余一切（`;`/`||` 连接、子 shell、函数、管道、第二个 cd、变量或通配符……）都不认，
// 照旧当作「不知道在哪个目录」。不去逐个堵 shell 的花样，只认这一种写得死的形状。

/** 目录写法里不许出现的：变量、命令替换、通配符、花括号 */
const UNSTABLE_DIR_CHARS = /[$`*?[\]{}]/
/** 出现这些字样的命令，不论位置，整条命令都不认 cd */
const CWD_WORDS = new Set(['cd', 'pushd', 'popd'])
/** 会改当前 shell 的目录，或在当前 shell 里执行不明内容的命令 */
const IN_SHELL_CMDS = new Set(['pushd', 'popd', 'source', '.', 'eval', 'alias', 'shopt'])

/**
 * 把一条语句展开成「纯 && 串」里按执行顺序排列的各环；不是纯 && 串（含后台、取反）返回 null。
 * 每一环只能是普通命令，或普通命令组成的管道。
 */
function flattenAndChain(stmt: Stmt): Stmt[] | null {
  if (stmt.negated || stmt.background || stmt.coprocess) return null
  const cmd = stmt.cmd
  if (!cmd) return null
  if (cmd.type === 'BinaryCmd' && cmd.op === '&&') {
    if (stmt.redirs.length > 0) return null
    const left = flattenAndChain(cmd.x)
    const right = flattenAndChain(cmd.y)
    return left && right ? [...left, ...right] : null
  }
  return isPlainCallOrPipeline(stmt) ? [stmt] : null
}

function isPlainCallOrPipeline(stmt: Stmt): boolean {
  if (stmt.negated || stmt.background || stmt.coprocess) return false
  const cmd = stmt.cmd
  if (!cmd) return false
  if (cmd.type === 'CallExpr') return true
  if (cmd.type === 'BinaryCmd' && (cmd.op === '|' || cmd.op === '|&')) {
    return isPlainCallOrPipeline(cmd.x) && isPlainCallOrPipeline(cmd.y)
  }
  return false
}

function callsOfPipeline(stmt: Stmt): CallExprNode[] {
  const cmd = stmt.cmd
  if (!cmd) return []
  if (cmd.type === 'CallExpr') return [cmd]
  if (cmd.type === 'BinaryCmd') return [...callsOfPipeline(cmd.x), ...callsOfPipeline(cmd.y)]
  return []
}

/** 找出能确定当前目录的命令：CallExpr → 它执行时所在的目录（词法绝对路径，已去转义） */
async function findCdAnchors(ast: ShellFile): Promise<Map<CallExprNode, string>> {
  const anchors = new Map<CallExprNode, string>()
  const { walk, wordToLit } = await getShellAstModule()

  let unsafe = false
  const cdCalls: { call: CallExprNode; words: (string | null)[] }[] = []
  walk(ast as unknown as import('@questi0nm4rk/shell-ast').ShellNode, {
    FuncDecl: () => { unsafe = true },
    CallExpr: (call: CallExprNode) => {
      if (call.args.length === 0) { unsafe = true; return } // 纯赋值（HOME=… 之类）
      const words = call.args.map(w => wordToLit(w))
      const name = words[0]
      if (name === null) { unsafe = true; return } // 命令名运行时才知道
      if (IN_SHELL_CMDS.has(name)) unsafe = true
      if ((name === 'builtin' || name === 'command') && words.length > 1 && words[1] === null) unsafe = true
      if (words.some(w => w !== null && CWD_WORDS.has(w))) cdCalls.push({ call, words })
    },
  })
  if (unsafe || cdCalls.length !== 1) return anchors

  const { call: cdCall, words } = cdCalls[0]
  if (words.length !== 2 || words[0] !== 'cd' || words[1] === null) return anchors
  // 单引号里的反斜杠在 shell 里是字面字符，不加引号的才是转义：从字面量分不清是哪种，
  // 所以原文和去转义之后的两种读法都得过关。anchorCwd 存的是去转义之后的，解析时不再去一次。
  const raw = words[1]
  const dir = unescapeShellWordLiteral(raw)
  for (const reading of [raw, dir]) {
    if (UNSTABLE_DIR_CHARS.test(reading)) return anchors
    if (reading.split(/[\\/]/).includes('..')) return anchors
  }
  if (!isLexicallyAbsolutePath(dir)) return anchors

  for (const stmt of ast.stmts) {
    const links = flattenAndChain(stmt)
    if (!links) continue
    const at = links.findIndex(link => link.cmd === cdCall)
    if (at < 0) continue
    for (const link of links.slice(at + 1)) {
      for (const call of callsOfPipeline(link)) anchors.set(call, dir)
    }
    break
  }
  return anchors
}

async function resolvedArgs(args: UnwrappedCall['args']): Promise<{ strings: string[]; hasDynamic: boolean }> {
  const { isDynamic, isResolved } = await getShellAstModule()
  const strings: string[] = []
  let hasDynamic = false
  for (const a of args) {
    if (isDynamic(a)) hasDynamic = true
    else if (isResolved(a)) strings.push(unescapeShellWordLiteral(a))
  }
  return { strings, hasDynamic }
}

/** 解析时 `--` 被吃掉、不进 flags / args，只能回原始词里看 */
async function hasEndOfOptions(node: CallExprNode): Promise<boolean> {
  const { wordToLit } = await getShellAstModule()
  return node.args.slice(1).some(word => wordToLit(word) === '--')
}

/** 可执行 -c 内联脚本的解释器（bash -c / sudo bash -c 等） */
const SCRIPT_SHELL_CMDS = new Set([
  'bash', 'sh', 'zsh', 'dash', 'ksh', 'mksh', 'fish',
])

function isScriptShellCmd(name: string): boolean {
  return SCRIPT_SHELL_CMDS.has(basenameCommand(name))
}

/** 从 flags 含 -c 的 wrapped 调用中提取内联脚本 */
async function scriptFromCFlag(flags: string[], args: UnwrappedCall['args']): Promise<string | null> {
  if (!flags.includes('-c')) return null
  const { strings, hasDynamic } = await resolvedArgs(args)
  if (hasDynamic || strings.length === 0) return null
  return strings[0]
}

/** sudo/env 等外层 wrapper 下的 bash -c "script" */
async function tryExtractWrappedInlineScript(
  u: Extract<UnwrappedCall, { kind: 'wrapped' }>,
  source: AuditedCall['source'],
  ctx: AuditContext,
  out: AuditedCall[],
): Promise<boolean> {
  if (!u.cmd || !isScriptShellCmd(u.cmd)) return false
  const script = await scriptFromCFlag(u.flags, u.args)
  if (!script?.trim()) return false

  const inner = await extractAuditedCalls(script, { ...ctx, shell: source })
  if (inner.calls.length === 0) return false
  out.push(...inner.calls)
  return true
}

function unwrappedToAuditedCall(
  u: UnwrappedCall,
  raw: string,
  source: AuditedCall['source'],
  redirects: AuditedRedirect[],
  resolved: { strings: string[]; hasDynamic: boolean },
  endOfOptions = false,
): AuditedCall {
  if (u.kind === 'wrapped-opaque') {
    return {
      cmd: u.wrapper,
      flags: u.flags,
      args: [],
      paths: [],
      redirects,
      wrapper: { name: u.wrapper },
      raw,
      source,
      dynamicPaths: true,
    }
  }

  if (u.kind === 'wrapped-script') {
    return {
      cmd: u.wrapper,
      flags: u.flags,
      args: resolved.strings,
      paths: [],
      redirects,
      wrapper: { name: u.wrapper, script: u.script },
      raw,
      source,
    }
  }

  const { strings, hasDynamic } = resolved
  const cmd = basenameCommand(u.cmd)

  return {
    cmd,
    flags: u.flags,
    args: [],
    paths: strings,
    redirects,
    wrapper: u.kind === 'wrapped'
      ? { name: u.wrapper }
      : undefined,
    raw,
    source,
    dynamicPaths: hasDynamic || undefined,
    endOfOptions: endOfOptions || undefined,
  }
}

async function collectFromCallExpr(
  node: CallExprNode,
  raw: string,
  source: AuditedCall['source'],
  ctx: AuditContext,
  out: AuditedCall[],
  redirects: AuditedRedirect[],
  anchorCwd?: string,
): Promise<void> {
  const { unwrapCallParsed } = await getShellAstModule()
  const u = await unwrapCallParsed(node)
  if (!u) {
    out.push({
      cmd: 'unknown',
      flags: [],
      args: [],
      paths: [],
      redirects,
      raw,
      source,
      dynamicPaths: true,
    })
    return
  }

  if (u.kind === 'wrapped-script') {
    let innerProcessed = false
    if (u.innerAst) {
      // 用 Stmt 遍历保证内层 redirect 正确归属（与顶层一致）
      const innerResult = await collectCallsWithRedirs(u.innerAst)
      if (innerResult.callsWithRedirs.length > 0) {
        innerProcessed = true
        for (const { callNode, redirs } of innerResult.callsWithRedirs) {
          await collectFromCallExpr(callNode, u.script, source, ctx, out, redirs)
        }
      }
    }
    if (!innerProcessed && u.script.trim()) {
      const inner = await extractAuditedCalls(u.script, { ...ctx, shell: source })
      if (inner.calls.length > 0) {
        innerProcessed = true
        out.push(...inner.calls)
      }
    }
    if (!innerProcessed) {
      const resolved = await resolvedArgs(u.args)
      out.push(unwrappedToAuditedCall(u, raw, source, redirects, resolved))
    }
    return
  }

  if (u.kind === 'wrapped') {
    const innerProcessed = await tryExtractWrappedInlineScript(u, source, ctx, out)
    if (innerProcessed) return
  }

  const resolved = await resolvedArgs(u.args)
  const endOfOptions = await hasEndOfOptions(u.kind === 'wrapped' ? u.innerRaw : u.raw)
  const call = unwrappedToAuditedCall(u, raw, source, redirects, resolved, endOfOptions)
  // 只有直接运行的命令才认 cd 定下的目录：sudo -D、env -C 这类包装器自己会换目录
  if (anchorCwd && u.kind === 'plain') call.anchorCwd = anchorCwd
  out.push(call)
}

/** 从 shell 字符串提取全部可审计子命令（unwrap wrapper + 递归 -c 脚本） */
export async function extractAuditedCalls(
  command: string,
  ctx: AuditContext = {},
): Promise<{ calls: AuditedCall[]; writeRedirects: AuditedRedirect[] }> {
  const source = ctx.shell === 'sh' ? 'sh' : ctx.shell === 'zsh' ? 'zsh' : 'bash'
  const dialect = shellDialect(ctx)
  const ast = await parseShellCommand(command, dialect)
  const { callsWithRedirs, allWriteRedirects } = await collectCallsWithRedirs(ast)
  const anchors = await findCdAnchors(ast)
  const calls: AuditedCall[] = []
  for (const { callNode, redirs } of callsWithRedirs) {
    await collectFromCallExpr(callNode, command, source, ctx, calls, redirs, anchors.get(callNode))
  }
  return { calls, writeRedirects: allWriteRedirects }
}
