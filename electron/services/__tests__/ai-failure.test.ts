import { describe, it, expect } from 'vitest'
import { formatApiFailure, isModelQuotaError, quotaResetAt } from '../ai-failure'
import { ModelSelection } from '../model-selection'

describe('供应商额度与真实原因', () => {
  it('按协议码和接口上下文分类，不按任意错误句子猜测', () => {
    expect(isModelQuotaError('QuotaExceeded', 'https://ark.cn-beijing.volces.com/api/coding/v3')).toBe(true)
    expect(isModelQuotaError('QuotaExceeded', 'https://ark.cn-beijing.volces.com/api/v3/batches')).toBe(false)
    expect(isModelQuotaError('QuotaExceeded', 'https://other.example/v1')).toBe(false)
    expect(isModelQuotaError('AccountRateLimitExceeded', 'https://ark.cn-beijing.volces.com/api/v3')).toBe(false)
    expect(isModelQuotaError('insufficient_quota', 'https://example.test')).toBe(true)
    expect(isModelQuotaError(undefined, 'https://example.test')).toBe(false)
  })
  it('保留原文与状态/错误码，解析明确的重置时间', () => {
    const text = 'weekly quota; reset at 2099-11-02 00:00:00 +0800 CST'
    expect(formatApiFailure({ model: 'm', statusCode: 429, code: 'QuotaExceeded', message: text })).toContain(text)
    expect(quotaResetAt(text)).toBe(Date.parse('2099-11-02T00:00:00+08:00'))
    expect(quotaResetAt('No reset specified')).toBeUndefined()
  })
  it('错误优先使用配置名称，旧记录或空名称回退模型ID', () => {
    expect(formatApiFailure({ profileName: '火山dsV4.1flash', model: 'deepseek-model-id', message: 'failed' })).toBe('火山dsV4.1flash：failed')
    expect(formatApiFailure({ model: 'legacy-id', message: 'failed' })).toBe('legacy-id：failed')
    expect(formatApiFailure({ profileName: '  ', model: 'legacy-id', message: 'failed' })).toBe('legacy-id：failed')
  })
  it('共享选择只在真实切换时唤醒等待，重复选择不打断请求', () => {
    const selection = new ModelSelection()
    selection.select('a')
    const previous = selection.signal
    selection.select('a')
    expect(previous.aborted).toBe(false)
    selection.select('b')
    expect(previous.aborted).toBe(true)
    expect(selection.signal.aborted).toBe(false)
    expect(selection.profileId).toBe('b')
  })
})
