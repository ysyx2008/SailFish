/**
 * 风险等级 × 执行模式 确认策略
 *
 * 工具/技能只负责评估出 RiskLevel，是否弹窗统一走本模块：
 * - isHardBlocked：blocked → 硬拒绝（任何 mode 都不执行、不弹确认）
 * - riskNeedsConfirm：是否弹确认（对 blocked 恒为 false，调用方须先拦 blocked）
 * - commandNeedsConfirm：对 assessment 的薄封装
 *
 * strict：全部确认（含 safe）
 * relaxed：默认只确认 dangerous；
 *          若 riskPolicy.relaxedConfirmModerate=true，则 moderate 也确认。
 * free：不确认（用户自担）。
 *
 * blocked 是硬墙（见 CommandRiskPolicy 注释），任何 executionMode 下拒绝执行。
 */
import type { RiskLevel, ExecutionMode, CommandRiskPolicy } from '@shared/types/agent'
import type { CommandRiskAssessment } from './types'
import { resolveSubAgentBlockDangerous } from './fail-closed-policy'
import { t } from '../i18n'

/** blocked = 硬拒绝，不弹确认、不执行 */
export function isHardBlocked(level: RiskLevel): boolean {
  return level === 'blocked'
}

/** 硬拒时给秘书看的中性说明：事实 + 审计原因，不含行动指导 */
export function formatHardBlockedMessage(assessment: CommandRiskAssessment, command?: string): string {
  const seen = new Set<string>()
  const reasons: string[] = []
  for (const call of assessment.calls) {
    if (call.level !== 'blocked') continue
    for (const r of call.reasons) {
      if (!r || seen.has(r)) continue
      seen.add(r)
      reasons.push(r)
    }
  }
  const base = reasons.length === 0
    ? t('hint.security_blocked')
    : t('hint.security_blocked_with_reason', { reason: reasons.join('；') })
  if (!command) return base
  return `${base}\n${t('hint.original_command', { command })}`
}

/**
 * 通用确认策略：工具先评估 riskLevel，再据此 + executionMode 决定是否弹窗。
 *
 * - blocked：返回 false（须先用 isHardBlocked 拒绝，绝不能当「可确认」）
 * - strict：其余全部确认（含 safe）
 * - free：不确认
 * - relaxed：dangerous；可选 moderate；safe 不确认
 */
export function riskNeedsConfirm(
  level: RiskLevel,
  executionMode: ExecutionMode,
  policy?: CommandRiskPolicy | null,
): boolean {
  if (level === 'blocked') return false
  if (executionMode === 'strict') return true
  if (executionMode === 'free') return false
  if (level === 'dangerous') return true
  if (level === 'moderate' && policy?.relaxedConfirmModerate) return true
  return false
}

/** 命令执行确认策略（委托 riskNeedsConfirm）。调用前须已处理 blocked。 */
export function commandNeedsConfirm(
  assessment: CommandRiskAssessment,
  executionMode: ExecutionMode,
  policy?: CommandRiskPolicy | null,
): boolean {
  return riskNeedsConfirm(assessment.level, executionMode, policy)
}

/**
 * 伙计：硬墙一律拦。
 * 只有策略明确额外禁止高风险时，才把 dangerous 也拦住、不问人。
 * 否则 dangerous 交给主人这场的确认，跟主人同一档。
 */
export function isSubAgentBlocked(
  assessment: CommandRiskAssessment,
  policy?: CommandRiskPolicy | null,
): boolean {
  if (assessment.level === 'blocked') return true
  if (assessment.level === 'dangerous' && resolveSubAgentBlockDangerous(policy)) return true
  return false
}

/** 展示用风险等级 */
export function displayRiskLevel(assessment: CommandRiskAssessment): RiskLevel {
  return assessment.level
}
