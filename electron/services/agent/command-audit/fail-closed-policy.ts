/**
 * Fail-Closed / 策略档位解析（按 executionMode + 用户配置的 riskPolicy）
 *
 * - free 模式跟随 relaxed 配置
 * - AuditContext 不带 policy 时回退 DEFAULT_COMMAND_RISK_POLICY
 */
import type { RiskLevel, ExecutionMode, CommandRiskPolicy } from '@shared/types/agent'
import { DEFAULT_COMMAND_RISK_POLICY } from '@shared/types/agent'
import type { AuditContext } from './types'

export type FailClosedKind = 'parseFail' | 'unknownCmd' | 'indirection' | 'dynamicPath'

function effectiveMode(mode: ExecutionMode | undefined): 'strict' | 'relaxed' {
  const m = mode ?? 'relaxed'
  return m === 'free' ? 'relaxed' : m === 'strict' ? 'strict' : 'relaxed'
}

function policyOf(ctx?: AuditContext): CommandRiskPolicy {
  const p = ctx?.riskPolicy
  if (!p) return DEFAULT_COMMAND_RISK_POLICY
  return {
    ...DEFAULT_COMMAND_RISK_POLICY,
    ...p,
    extraFreeDirs: Array.isArray(p.extraFreeDirs) ? p.extraFreeDirs : DEFAULT_COMMAND_RISK_POLICY.extraFreeDirs,
  }
}

/**
 * 按 executionMode + riskPolicy 选 Fail-Closed 档位。
 */
export function resolveFailClosedLevel(
  kind: FailClosedKind,
  ctx?: AuditContext,
): RiskLevel {
  const mode = effectiveMode(ctx?.executionMode)
  const policy = policyOf(ctx)

  if (kind === 'parseFail') {
    return mode === 'strict' ? policy.strictParseFail : policy.relaxedParseFail
  }
  if (kind === 'unknownCmd') {
    return mode === 'strict' ? policy.strictUnknownCmd : policy.relaxedUnknownCmd
  }
  if (kind === 'indirection') {
    return mode === 'strict' ? policy.strictIndirection : policy.relaxedIndirection
  }
  return mode === 'strict' ? policy.strictDynamicPath : policy.relaxedDynamicPath
}

/** relaxed 是否也确认 moderate */
export function resolveRelaxedConfirmModerate(ctx?: AuditContext): boolean {
  return policyOf(ctx).relaxedConfirmModerate === true
}

/** 工作区外写是否升级 */
export function resolveOutsideWritesUpgrade(ctx?: AuditContext): boolean {
  return policyOf(ctx).outsideWritesUpgrade === true
}

/** 额外自由区目录 */
export function resolveExtraFreeDirs(ctx?: AuditContext): string[] {
  const dirs = policyOf(ctx).extraFreeDirs
  return Array.isArray(dirs) ? dirs.filter(d => typeof d === 'string' && d.trim()) : []
}

/** 是否额外禁止伙计做高风险。没写这一项时跟默认走（默认不禁止）。 */
export function resolveSubAgentBlockDangerous(policy?: CommandRiskPolicy | null): boolean {
  return (policy?.subAgentBlockDangerous ?? DEFAULT_COMMAND_RISK_POLICY.subAgentBlockDangerous) === true
}
