/**
 * shell 通道命令审计（PTY exec / execute_command）
 *
 * 流程：
 * - Unix / Windows cmd：shell-ast（bash 方言）→ 拆子命令 → 白名单 + 路径分区
 * - Windows PowerShell（默认 shell）：官方 AST（pwsh-extract.ps1）→ 同上
 */
import { getDefaultShellKind } from '../../../utils/shell'
import type { RiskLevel } from '@shared/types/agent'
import { t } from '../i18n'
import { getScratchPath, getWorkspacePath } from '../tools/file'
import { assessAuditedCall, assessRedirectPaths, aggregateHasUnknown } from './assess-call'
import { extractAuditedCalls } from './extract-calls'
import { extractPwshAuditedCalls } from './extract-pwsh-calls'
import { isWindowsNativeShellCommand } from './platform-detect'
import { maxRisk, maxRiskAll } from './risk-level'
import { resolveFailClosedLevel } from './fail-closed-policy'
import type { AuditContext, AuditedCall, AuditedRedirect, CommandRiskAssessment } from './types'

/** bash/sh 语法特征：在 Windows 上优先走 shell-ast，避免 PS 解析语义差异 */
function looksLikeBashSyntax(command: string): boolean {
  if (isWindowsNativeShellCommand(command)) return false
  const c = command
  return /\s&&\s|\s\|\|\s/.test(c)
    || /\b(?:sudo|bash|sh)\s+-c\b/.test(c)
    || /\bsudo\s+/.test(c)
    || /\bfor\s+\w+\s+in\s+/.test(c)
    || /\b(?:do|done)\b/.test(c)
    || />\s*\/dev\//.test(c)
    || /\b2>\s*\/dev\//.test(c)
    || /\brm\s+-[rf]+\s+\/(?!\/)/.test(c)
    || /\bmount\s+\/dev\//.test(c)
    || /\bchmod\s+\d+\s+\/etc\//.test(c)
}

/** 构造默认审计上下文（assistant 模式） */
export function defaultAuditContext(cwd?: string): AuditContext {
  const kind = getDefaultShellKind()
  const shell: AuditContext['shell'] =
    kind === 'powershell' ? 'powershell'
      : kind === 'cmd' ? 'unknown'
        : 'bash'
  return {
    workspaceRoot: getWorkspacePath(),
    cwd: cwd ?? getScratchPath(),
    shell,
  }
}

/**
 * 远程主机的审计上下文：按 POSIX shell 解析，不带本机的工作区和当前目录。
 * 命令表只认内置的，路径分区不做（见 AuditContext.target）。
 */
export function remoteAuditContext(): AuditContext {
  return { shell: 'sh', target: 'remote' }
}

/** 整串命令级 blocked 模式（AST 前后都跑，防 fork bomb 等） */
function assessFullStringBlocked(command: string): RiskLevel | null {
  const cmd = command.toLowerCase().trim()
  const blocked = [
    /rm\s+(-[rf]+\s+)*\/(?:\s|$)/,
    /rm\s+(-[rf]+\s+)*\/\*/,
    /:\(\)\{.*:\|:.*\}/,
    /mkfs\S*\s+\/(?:\s|$)/,
    /mkfs\S*\s+\/boot(?:\/|\s|$)/,
    /dd\s+.*of=\/(?:\s|$)/,
    /dd\s+.*of=\/boot(?:\/|\s|$)/,
    /\bformat\b(?=.*\bc:\\?(?:\s|$))/,
    /\bformat-volume\b(?=.*-driveletter\s+c\b)/,
    />\s*\/etc\/(passwd|shadow|sudoers)/,
    /\b(rd|rmdir)\b(?=.*\/s\b)(?=.*\b[a-z]:\\["']?(?:\s|$))/,
    /\bdel\b(?=.*\/s\b)(?=.*\b[a-z]:\\\*)/,
    /\bremove-item\b(?=.*-recurse)(?=.*\b[a-z]:\\["']?(?:\s|$))/,
  ]
  if (blocked.some(p => p.test(cmd))) return 'blocked'
  return null
}

/** 远程代码执行管道（整串兜底） */
function assessRemoteExecPipe(command: string): RiskLevel | null {
  const cmd = command.toLowerCase()
  if (/\bcurl\s+.*\|\s*(ba)?sh\b/.test(cmd)) return 'dangerous'
  if (/\bwget\s+.*-O\s*-?\s*\|\s*(ba)?sh\b/.test(cmd)) return 'dangerous'
  return null
}

export interface AssessShellOptions {
  /** 解析失败时的回退评估（Windows regex 等） */
  legacyAssess?: (command: string) => RiskLevel
}

async function assessExtractedCalls(
  command: string,
  ctx: AuditContext,
  extracted: { calls: AuditedCall[]; writeRedirects: AuditedRedirect[] },
): Promise<CommandRiskAssessment> {
  const { calls, writeRedirects } = extracted

  if (calls.length === 0) {
    const emptyLevel = resolveFailClosedLevel('parseFail', ctx)
    return {
      level: emptyLevel,
      parsed: true,
      calls: [{ level: emptyLevel, commandLevel: emptyLevel, reasons: [t('risk.reason.no_auditable_call')] }],
    }
  }

  const callAssessments = calls.map(c => assessAuditedCall(c, ctx))

  const assignedRedirectTargets = new Set(
    calls.flatMap(c => c.redirects.filter(r => r.target).map(r => r.target!)),
  )
  const orphanRedirects = writeRedirects.filter(r => r.target && !assignedRedirectTargets.has(r.target))
  if (orphanRedirects.length > 0) {
    const orphanAssessment = assessRedirectPaths(orphanRedirects, ctx)
    if (orphanAssessment) {
      callAssessments.push(orphanAssessment)
    }
  }

  return {
    level: maxRiskAll(callAssessments.map(a => a.level)),
    parsed: true,
    hasUnknown: aggregateHasUnknown(callAssessments),
    calls: callAssessments,
  }
}

function legacyRegexAssessment(
  command: string,
  opts: AssessShellOptions,
): CommandRiskAssessment {
  const legacy = opts.legacyAssess ?? (() => 'dangerous' as RiskLevel)
  const level = legacy(command)
  return {
    level,
    parsed: false,
    calls: [{ level, commandLevel: level, reasons: [t('risk.reason.windows_native_shell')] }],
  }
}

/**
 * 评估 shell 字符串命令风险
 */
export async function assessShellRisk(
  command: string,
  ctx: AuditContext = defaultAuditContext(),
  opts: AssessShellOptions = {},
): Promise<CommandRiskAssessment> {
  const blocked = assessFullStringBlocked(command)
  if (blocked) {
    return {
      level: blocked,
      parsed: false,
      calls: [{ level: blocked, commandLevel: blocked, reasons: [t('risk.reason.blocked_whole')] }],
    }
  }

  const pipeRisk = assessRemoteExecPipe(command)
  if (pipeRisk) {
    return {
      level: pipeRisk,
      parsed: false,
      calls: [{ level: pipeRisk, commandLevel: pipeRisk, reasons: [t('risk.reason.remote_download_pipe')] }],
    }
  }

  // 远程命令跑在远程的 shell 里，不看本机是不是 Windows
  const onLocalWindows = process.platform === 'win32' && ctx.target !== 'remote'
  const usePwshAst = onLocalWindows && getDefaultShellKind() === 'powershell'
  const useCmdLegacy = onLocalWindows
    && getDefaultShellKind() === 'cmd'
    && isWindowsNativeShellCommand(command)

  if (useCmdLegacy) {
    return legacyRegexAssessment(command, opts)
  }

  if (usePwshAst) {
    const extractors = looksLikeBashSyntax(command)
      ? [
          () => extractAuditedCalls(command, ctx),
          () => extractPwshAuditedCalls(command, ctx),
        ]
      : [
          () => extractPwshAuditedCalls(command, ctx),
          () => extractAuditedCalls(command, ctx),
        ]
    for (const extract of extractors) {
      try {
        const extracted = await extract()
        return await assessExtractedCalls(command, ctx, extracted)
      } catch {
        // 尝试下一通道
      }
    }
    const msg = 'PowerShell / shell-ast parse both failed'
    if (opts.legacyAssess) {
      const legacy = opts.legacyAssess(command)
      const policyLevel = resolveFailClosedLevel('parseFail', ctx)
      const level = maxRisk(policyLevel, legacy)
      return {
        level,
        parsed: false,
        parseError: msg,
        calls: [{
          level,
          commandLevel: level,
          reasons: [t('risk.reason.parse_fail_closed', { msg })],
        }],
      }
    }
    const policyLevel = resolveFailClosedLevel('parseFail', ctx)
    return {
      level: policyLevel,
      parsed: false,
      parseError: msg,
      calls: [{
        level: policyLevel,
        commandLevel: policyLevel,
        reasons: [t('risk.reason.parse_fail_closed', { msg })],
      }],
    }
  }

  try {
    const extracted = await extractAuditedCalls(command, ctx)
    return await assessExtractedCalls(command, ctx, extracted)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (opts.legacyAssess) {
      const legacy = opts.legacyAssess(command)
      const policyLevel = resolveFailClosedLevel('parseFail', ctx)
      const level = maxRisk(policyLevel, legacy)
      return {
        level,
        parsed: false,
        parseError: msg,
        calls: [{
          level,
          commandLevel: level,
          reasons: [t('risk.reason.parse_fail_closed', { msg })],
        }],
      }
    }
    const policyLevel = resolveFailClosedLevel('parseFail', ctx)
    return {
      level: policyLevel,
      parsed: false,
      parseError: msg,
      calls: [{
        level: policyLevel,
        commandLevel: policyLevel,
        reasons: [t('risk.reason.parse_fail_closed', { msg })],
      }],
    }
  }
}

/** @deprecated 请用 commandNeedsConfirm(assessment, mode) */
export function shellNeedsConfirm(
  level: RiskLevel,
  executionMode: 'strict' | 'relaxed' | 'free',
): boolean {
  if (executionMode === 'strict') return true
  if (executionMode === 'free') return false
  return level === 'dangerous' || level === 'blocked'
}
