/** 供应商错误只按协议码分类；原文独立保留，不以文案猜权限或账务类别。 */
import type { ApiFailureDetail } from '@shared/types'
export type { ApiFailureDetail } from '@shared/types'

export class ModelUnavailableError extends Error {
  constructor(readonly detail: ApiFailureDetail) {
    super(formatApiFailure(detail))
    this.name = 'ModelUnavailableError'
  }
}

export function formatApiFailure(detail: ApiFailureDetail): string {
  const code = [detail.statusCode && `HTTP ${detail.statusCode}`, detail.code].filter(Boolean).join(' · ')
  return `${detail.model}${code ? ` (${code})` : ''}：${detail.message}`
}

/** Ark的QuotaExceeded在聊天接口表示套餐/试用额度；异步批处理接口的同名码不在此解释。 */
export function isModelQuotaError(code: string | undefined, apiUrl: string): boolean {
  const normalized = code?.toLowerCase()
  if (['insufficient_quota', 'accountquotaexceeded', 'modelaccounttpdratelimitexceeded', 'quotaexceeded.agentplanquotaexceeded'].includes(normalized ?? '')) return true
  if (normalized !== 'quotaexceeded') return false
  try {
    const url = new URL(apiUrl)
    return /(^|\.)volces\.com$/.test(url.hostname) && !url.pathname.includes('/batches')
  } catch { return false }
}

/** 协议文案中的明确重置时间只用作显示和熔断期限，不用于判断错误类别。 */
export function quotaResetAt(message: string): number | undefined {
  const match = message.match(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|\s*[+-]\d{2}:?\d{2})/)
  const at = match ? Date.parse(match[0]) : NaN
  return Number.isFinite(at) && at > Date.now() ? at : undefined
}
