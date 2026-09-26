/**
 * 评审结论：解析模型的两个分，再对固定的表。
 *
 * 放行必须两边都同意——模型自己说放、表也允许。任何一边不同意、或者输出看不懂，
 * 都交给人。模型不能靠在 outcome 里写 allow 绕过表。
 */

import {
  AUTO_REVIEW_AUTHORIZATION_SCORES as AUTHORIZATION_SCORES,
  AUTO_REVIEW_RISK_SCORES as RISK_SCORES,
  type AutoReviewAuthorizationScore as AuthorizationScore,
  type AutoReviewRiskScore as RiskScore,
  type RiskLevel,
} from '@shared/types'

export type { RiskScore, AuthorizationScore }

export const MODEL_OUTCOMES = ['allow', 'ask_user'] as const
export type ModelOutcome = (typeof MODEL_OUTCOMES)[number]

export interface ReviewAssessment {
  risk: RiskScore
  authorization: AuthorizationScore
  outcome: ModelOutcome
  rationale: string
}

const MAX_RATIONALE_CHARS = 300

function isOneOf<T extends string>(values: readonly T[], v: unknown): v is T {
  return typeof v === 'string' && (values as readonly string[]).includes(v)
}

function extractJsonObject(text: string): unknown {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return undefined
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return undefined
  }
}

/** 字段缺一个、取值不在枚举里、理由为空，都算看不懂。 */
export function parseAssessment(text: string | undefined): ReviewAssessment | null {
  if (!text) return null
  const raw = extractJsonObject(text)
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  if (!isOneOf(RISK_SCORES, obj.risk_level)) return null
  if (!isOneOf(AUTHORIZATION_SCORES, obj.user_authorization)) return null
  if (!isOneOf(MODEL_OUTCOMES, obj.outcome)) return null
  const rationale = typeof obj.rationale === 'string' ? obj.rationale.trim() : ''
  if (!rationale) return null
  return {
    risk: obj.risk_level,
    authorization: obj.user_authorization,
    outcome: obj.outcome,
    rationale: rationale.length > MAX_RATIONALE_CHARS ? `${rationale.slice(0, MAX_RATIONALE_CHARS)}…` : rationale,
  }
}

/**
 * 固定的表：
 * - 致命：永不
 * - 高危：授权至少到「实质上授权」
 * - 中危：看得出授权
 * - 低危：不看授权
 */
export function tableAllows(risk: RiskScore, authorization: AuthorizationScore): boolean {
  switch (risk) {
    case 'critical':
      return false
    case 'high':
      return authorization === 'high' || authorization === 'medium'
    case 'medium':
      return authorization !== 'unknown'
    case 'low':
      return true
  }
}

/** 旗鱼自己的命令定级 → 评审用的风险分。评审员不能低于这一档。 */
export function auditRiskFloor(level: RiskLevel): RiskScore {
  switch (level) {
    case 'blocked': return 'critical'
    case 'dangerous': return 'high'
    case 'moderate': return 'medium'
    case 'safe': return 'low'
  }
}

export function higherRisk(a: RiskScore, b: RiskScore): RiskScore {
  return RISK_SCORES.indexOf(a) >= RISK_SCORES.indexOf(b) ? a : b
}

/** 用审计下限抬过之后的风险分再对表。 */
export function assessmentApproves(a: ReviewAssessment, auditLevel?: RiskLevel): boolean {
  const risk = auditLevel ? higherRisk(a.risk, auditRiskFloor(auditLevel)) : a.risk
  return a.outcome === 'allow' && tableAllows(risk, a.authorization)
}

export function effectiveAssessment(a: ReviewAssessment, auditLevel: RiskLevel): ReviewAssessment {
  return { ...a, risk: higherRisk(a.risk, auditRiskFloor(auditLevel)) }
}
