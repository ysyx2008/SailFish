/**
 * 单条 AuditedCall 风险评估（shell 通道 AST 解析后归一化调用）
 */
import type { RiskLevel } from '@shared/types/agent'
import { t } from '../i18n'
import { getScratchPath } from '../tools/file'
import type { AuditContext, AuditedCall, AuditedRedirect, CallRiskAssessment } from './types'
import { assessCommandFlags } from './whitelist'
import { getArgvCommandRule } from './resolve-argv-rule'
import { adjustRiskByPathZones } from './workspace-guard'
import { maxRisk } from './risk-level'
import { checkIndirectionGuard } from './indirection-guard'
import { assessSubcommandRisk } from './subcommand-risk'
import { resolveFailClosedLevel, resolveOutsideWritesUpgrade, resolveExtraFreeDirs } from './fail-closed-policy'

function collectWritePaths(call: AuditedCall, extraPaths: string[]): string[] {
  const fromRedirects = call.redirects
    .filter(r => r.isWrite && r.target)
    .map(r => r.target!)
  return [...call.paths, ...fromRedirects, ...extraPaths]
}

function assessUnknownCall(
  call: AuditedCall,
  ctx: AuditContext,
  extraWritePaths: string[],
): CallRiskAssessment {
  const cwd = ctx.cwd ?? getScratchPath()
  const allPaths = collectWritePaths(call, extraWritePaths)
  const hasWriteRedirect = call.redirects.some(r => r.isWrite) || extraWritePaths.length > 0

  // 未识别命令的 base level 由用户策略决定（默认 strict->dangerous、relaxed->moderate）。
  // 写路径仍由路径守卫升级 dangerous/blocked（hardened/critical 系统路径）。
  const baseLevel = resolveFailClosedLevel('unknownCmd', ctx)

  if (hasWriteRedirect && allPaths.length > 0) {
    // 未识别命令默认按写命令处理（cmdWritesTo=true 语义）
    const pathAdjust = adjustRiskByPathZones(baseLevel, allPaths, allPaths, true, cwd, {
      outsideWritesUpgrade: resolveOutsideWritesUpgrade(ctx),
      extraFreeDirs: resolveExtraFreeDirs(ctx),
    })
    return {
      level: pathAdjust.level,
      commandLevel: baseLevel,
      unknown: true,
      cmd: call.cmd,
      inferredWritesTo: true,
      reasons: [
        t('risk.reason.unknown_cmd', { cmd: call.cmd }),
        ...pathAdjust.reasons,
      ],
      pathZones: pathAdjust.zones,
    }
  }

  if (call.dynamicPaths) {
    // 含动态参数但无静态路径可审计，无法静态审计，回退策略 level。
    return {
      level: baseLevel,
      commandLevel: baseLevel,
      unknown: true,
      cmd: call.cmd,
      inferredWritesTo: false,
      reasons: [t('risk.reason.unknown_dynamic')],
    }
  }

  return {
    level: baseLevel,
    commandLevel: baseLevel,
    unknown: true,
    cmd: call.cmd,
    inferredWritesTo: false,
    reasons: [t('risk.reason.unknown_cmd_relaxed', { cmd: call.cmd })],
  }
}

/**
 * 评估单条已归一化的命令调用
 */
export function assessAuditedCall(
  call: AuditedCall,
  ctx: AuditContext = {},
  extraWritePaths: string[] = [],
): CallRiskAssessment {
  // 间接执行守卫：解释器内联 / 包装器 / 调度器 / 结构性 flag 规则
  // 命中后等级由用户策略决定（默认 strict→dangerous、relaxed→moderate）。
  // 若命令本身为 dangerous，保底 dangerous；用户升成硬拒则保底 blocked。
  const guardHit = checkIndirectionGuard(call)
  if (guardHit) {
    const policyLevel = resolveFailClosedLevel('indirection', ctx)
    const argvRule = getArgvCommandRule(call.cmd)
    if (argvRule?.baseLevel === 'blocked') {
      return {
        level: 'blocked',
        commandLevel: 'blocked',
        cmd: call.cmd,
        reasons: [t('risk.reason.user_blocked_cmd', { cmd: call.cmd })],
      }
    }
    const level =
      argvRule?.baseLevel === 'dangerous'
        ? maxRisk(policyLevel, 'dangerous')
        : maxRisk(policyLevel, guardHit.level)
    return {
      level,
      commandLevel: level,
      cmd: call.cmd,
      reasons: [guardHit.reason],
    }
  }

  const cwd = ctx.cwd ?? getScratchPath()
  const rule = getArgvCommandRule(call.cmd)

  if (!rule) {
    return assessUnknownCall(call, ctx, extraWritePaths)
  }

  if (call.dynamicPaths && rule.writesTo) {
    // 动态路径无法静态审计：等级由用户策略决定。
    // 高危命令保底 dangerous；用户升成硬拒则保底 blocked。
    if (rule.baseLevel === 'blocked') {
      return {
        level: 'blocked',
        commandLevel: 'blocked',
        cmd: call.cmd,
        reasons: [t('risk.reason.user_blocked_cmd', { cmd: call.cmd })],
      }
    }
    const policyLevel = resolveFailClosedLevel('dynamicPath', ctx)
    const dynamicLevel = rule.baseLevel === 'dangerous'
      ? maxRisk(policyLevel, 'dangerous')
      : policyLevel
    return {
      level: dynamicLevel,
      commandLevel: dynamicLevel,
      cmd: call.cmd,
      reasons: [t('risk.reason.dynamic_path')],
    }
  }

  const hasWriteRedirect = call.redirects.some(r => r.isWrite)
  const writes = rule.writesTo || hasWriteRedirect
  // allPaths：命令参数 + 写重定向（用于 userData 检查，读+写都查）
  const allPaths = collectWritePaths(call, extraWritePaths)
  // writePaths：真正的写路径（命令写时含参数路径；只读时仅写重定向目标）
  const redirectPaths = call.redirects
    .filter(r => r.isWrite && r.target)
    .map(r => r.target!)
  const writePaths = rule.writesTo
    ? [...call.paths, ...redirectPaths, ...extraWritePaths]
    : [...redirectPaths, ...extraWritePaths]
  const flagLevel = assessCommandFlags(rule, call.flags)
  const subcommandRisk = assessSubcommandRisk(call)
  const commandLevel = subcommandRisk ? maxRisk(flagLevel, subcommandRisk.level) : flagLevel
  const reasons: string[] = []

  if (rule.baseLevel === 'blocked') {
    reasons.push(t('risk.reason.user_blocked_cmd', { cmd: call.cmd }))
  } else if (rule.baseLevel === 'dangerous') {
    reasons.push(t('risk.reason.dangerous_cmd', { cmd: call.cmd }))
  }

  if (subcommandRisk) {
    reasons.push(subcommandRisk.reason)
  } else if (commandLevel === 'moderate' && rule.baseLevel === 'safe') {
    reasons.push(t('risk.reason.unknown_flag'))
  }

  const pathAdjust = adjustRiskByPathZones(
    commandLevel,
    allPaths,
    writePaths,
    writes,
    cwd,
    {
      outsideWritesUpgrade: resolveOutsideWritesUpgrade(ctx),
      extraFreeDirs: resolveExtraFreeDirs(ctx),
      cmd: call.cmd,
      redirectWritePaths: redirectPaths,
    },
  )
  reasons.push(...pathAdjust.reasons)

  let level: RiskLevel
  if (commandLevel === 'blocked' || pathAdjust.level === 'blocked') {
    level = 'blocked'
  } else if (writes && writePaths.length > 0) {
    // free 区可降级为 safe；outside 等 moderate 不覆盖 rm 等命令级 dangerous。
    // 高危命令只把输出重定向进 free 区（`> /dev/null`）不降级：危险在命令本身，不在写的那个文件
    const keepCommandRisk = !rule.writesTo && commandLevel === 'dangerous'
    level = pathAdjust.level === 'safe' && !keepCommandRisk
      ? 'safe'
      : maxRisk(commandLevel, pathAdjust.level)
  } else {
    level = commandLevel
  }

  return {
    level,
    commandLevel,
    cmd: call.cmd,
    reasons: reasons.length ? reasons : [t('risk.reason.audit_pass', { source: call.source, cmd: call.cmd })],
    pathZones: pathAdjust.zones,
  }
}

/** 写重定向路径的全局风险（与具体命令解耦） */
export function assessRedirectPaths(
  redirects: AuditedRedirect[],
  ctx: AuditContext = {},
): CallRiskAssessment | null {
  const writePaths = redirects.filter(r => r.isWrite && r.target).map(r => r.target!)
  if (writePaths.length === 0) return null

  const cwd = ctx.cwd ?? getScratchPath()
  const pathAdjust = adjustRiskByPathZones('moderate', writePaths, writePaths, true, cwd, {
    outsideWritesUpgrade: resolveOutsideWritesUpgrade(ctx),
    extraFreeDirs: resolveExtraFreeDirs(ctx),
  })
  return {
    level: pathAdjust.level,
    commandLevel: 'moderate',
    reasons: pathAdjust.reasons.length
      ? pathAdjust.reasons
      : [t('risk.reason.shell_redirect_audit')],
    pathZones: pathAdjust.zones,
  }
}

/** 从多条子命令评估聚合 hasUnknown */
export function aggregateHasUnknown(calls: CallRiskAssessment[]): boolean {
  return calls.some(c => c.unknown === true)
}
