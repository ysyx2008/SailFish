/**
 * 唤醒失败风暴防护：profile 预检 + 自激环过滤 + circuit 退避表
 */
import { describe, it, expect } from 'vitest'
import { translateNetworkError, validateProfileForRequest } from '../ai.service'
import { t } from '../agent/i18n'
import type { AiProfile } from '@shared/types'

function makeProfile(partial: Partial<AiProfile> = {}): AiProfile {
  return {
    id: 'p1',
    name: 'test',
    apiUrl: 'https://api.example.com/v1',
    apiKey: 'k',
    model: 'm',
    contextLength: 128000,
    maxOutputTokens: 4096,
    ...partial,
  }
}

/** 与 WatchService.findMatchingWatches 同逻辑的纯函数（测自激环过滤） */
function filterWakeupOnSelfFailure(
  eventType: string,
  failedWatchId: string | undefined,
  candidates: Array<{ id: string }>,
): Array<{ id: string }> {
  if (eventType !== 'watch_failure') return candidates
  if (failedWatchId === '__wakeup__') {
    return candidates.filter(w => w.id !== '__wakeup__')
  }
  return candidates
}

/** 与 WatchService.recordCircuitFailure 同退避表 */
const CIRCUIT_CONFIG_BACKOFF_SEC = [5 * 60, 15 * 60, 30 * 60, 60 * 60] as const
const CIRCUIT_TRANSIENT_BACKOFF_SEC = [60, 2 * 60, 4 * 60, 8 * 60] as const

function backoffSec(failureClass: 'config' | 'transient', consecutiveFailures: number): number {
  const table = failureClass === 'config' ? CIRCUIT_CONFIG_BACKOFF_SEC : CIRCUIT_TRANSIENT_BACKOFF_SEC
  const idx = Math.min(Math.max(consecutiveFailures, 1) - 1, table.length - 1)
  return table[idx]
}

describe('validateProfileForRequest', () => {
  it('accepts a valid profile', () => {
    const r = validateProfileForRequest(makeProfile())
    expect(r.ok).toBe(true)
  })

  it('rejects null profile', () => {
    const r = validateProfileForRequest(null)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('NO_PROFILE')
  })

  it('rejects empty apiUrl', () => {
    const r = validateProfileForRequest(makeProfile({ apiUrl: '  ' }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('MISSING_API_URL')
  })

  it('rejects invalid apiUrl without keyword matching on messages', () => {
    const r = validateProfileForRequest(makeProfile({ apiUrl: 'not-a-url' }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('INVALID_API_URL')
  })

  it('rejects missing model', () => {
    const r = validateProfileForRequest(makeProfile({ model: '' }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('MISSING_MODEL')
  })

  it('writes profile failures in the interface language', () => {
    const r = validateProfileForRequest(null)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toBe(t('error.watch_no_profile'))
  })
})

describe('certificate errors use the interface language', () => {
  it('translates UNABLE_TO_VERIFY_LEAF_SIGNATURE by error code', () => {
    const message = translateNetworkError({
      code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      message: 'unable to verify the first certificate',
    })
    expect(message).toBe(t('error.net_cert_untrusted'))
  })
})

describe('wakeup self-failure must not rematch wakeup', () => {
  const candidates = [{ id: '__wakeup__' }, { id: 'watch-other' }]

  it('excludes wakeup when payload.watchId is __wakeup__', () => {
    const matched = filterWakeupOnSelfFailure('watch_failure', '__wakeup__', candidates)
    expect(matched.map(w => w.id)).toEqual(['watch-other'])
  })

  it('keeps wakeup when another watch failed', () => {
    const matched = filterWakeupOnSelfFailure('watch_failure', 'watch-other', candidates)
    expect(matched.map(w => w.id)).toEqual(['__wakeup__', 'watch-other'])
  })

  it('does not filter non-watch_failure events', () => {
    const matched = filterWakeupOnSelfFailure('heartbeat', '__wakeup__', candidates)
    expect(matched).toEqual(candidates)
  })
})

describe('circuit breaker backoff', () => {
  it('uses longer backoff for config failures', () => {
    expect(backoffSec('config', 1)).toBe(5 * 60)
    expect(backoffSec('config', 4)).toBe(60 * 60)
    expect(backoffSec('config', 99)).toBe(60 * 60)
  })

  it('uses shorter backoff for transient failures', () => {
    expect(backoffSec('transient', 1)).toBe(60)
    expect(backoffSec('transient', 4)).toBe(8 * 60)
  })
})
