/**
 * 从 shell-ast 解析结果提取 AuditedCall 列表
 */
import type { CallExprNode, Redirect, ShellFile, Stmt } from '@questi0nm4rk/shell-ast'
import type { UnwrappedCall } from '@questi0nm4rk/shell-ast'
import { parseShellCommand, getShellAstModule } from './parser'
import type { AuditedCall, AuditedRedirect, AuditContext } from './types'
import { basenameCommand } from './whitelist'
import { unescapeShellWordLiteral } from './unescape-shell-literal'

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
  out.push(unwrappedToAuditedCall(u, raw, source, redirects, resolved, endOfOptions))
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
  const calls: AuditedCall[] = []
  for (const { callNode, redirs } of callsWithRedirs) {
    await collectFromCallExpr(callNode, command, source, ctx, calls, redirs)
  }
  return { calls, writeRedirects: allWriteRedirects }
}
