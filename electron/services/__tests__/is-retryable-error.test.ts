import { describe, expect, it, vi } from 'vitest'

vi.mock('../config.service', () => ({
  getConfigService: () => ({
    get: () => undefined,
    set: () => {}
  }),
  ConfigService: class {}
}))

vi.mock('../ai-debug.service', () => ({
  getAiDebugService: () => ({
    logRequestStart: () => {},
    logResponseChunk: () => {},
    logResponseDone: () => {},
    logResponseError: () => {}
  })
}))

vi.mock('../agent/i18n', () => ({
  t: (key: string) => key
}))

vi.mock('../../utils/logger', () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {}
  })
}))

import { isRetryableError, translateNetworkError } from '../ai.service'

describe('isRetryableError', () => {
  it('matches Node system error codes via err.code', () => {
    expect(isRetryableError({ code: 'ECONNRESET', message: 'read ECONNRESET' })).toBe(true)
    expect(isRetryableError({ code: 'ETIMEDOUT', message: 'connect ETIMEDOUT' })).toBe(true)
    expect(isRetryableError({ code: 'EPROTO', message: 'write EPROTO' })).toBe(true)
  })

  it('retries TLS handshake disconnect when only err.code is ECONNRESET', () => {
    // VPN/代理切换时 Node 常见形态：message 不含错误码字样
    expect(isRetryableError({
      code: 'ECONNRESET',
      message: 'Client network socket disconnected before secure TLS connection was established',
    })).toBe(true)
  })

  it('does not retry TLS disconnect message without a retryable code', () => {
    expect(isRetryableError({
      message: 'Client network socket disconnected before secure TLS connection was established',
    })).toBe(false)
  })

  it('still matches codes embedded in message strings', () => {
    expect(isRetryableError('getaddrinfo ENOTFOUND api.example.com')).toBe(true)
    expect(isRetryableError('ETIMEDOUT')).toBe(true)
    expect(isRetryableError('socket hang up')).toBe(true)
  })

  it('does not retry permanent client errors', () => {
    expect(isRetryableError({ code: 'ERR_INVALID_URL', message: 'Invalid URL' })).toBe(false)
    expect(isRetryableError('invalid api key')).toBe(false)
  })

  it('does not retry certificate verification failures', () => {
    expect(isRetryableError({
      code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      message: 'unable to verify the first certificate',
    })).toBe(false)
    expect(isRetryableError({
      code: 'EPROTO',
      message: 'write EPROTO',
      cause: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' },
    })).toBe(false)
  })
})

describe('translateNetworkError', () => {
  it('explains a certificate the trust store cannot verify', () => {
    expect(translateNetworkError({
      code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      message: 'unable to verify the first certificate',
    })).toBe('error.net_cert_untrusted')
  })

  it('reads the certificate code from the cause when the outer error is wrapped', () => {
    expect(translateNetworkError({
      message: 'write EPROTO',
      code: 'EPROTO',
      cause: { code: 'SELF_SIGNED_CERT_IN_CHAIN' },
    })).toBe('error.net_cert_untrusted')
  })

  it('keeps expiry and hostname mismatch distinct', () => {
    expect(translateNetworkError({ code: 'CERT_HAS_EXPIRED', message: 'certificate has expired' }))
      .toBe('error.net_cert_expired')
    expect(translateNetworkError({ code: 'ERR_TLS_CERT_ALTNAME_INVALID', message: 'Hostname mismatch' }))
      .toBe('error.net_cert_name')
  })

  it('leaves an unrecognized message unchanged', () => {
    expect(translateNetworkError({ message: 'unable to verify the first certificate' }))
      .toBe('unable to verify the first certificate')
  })
})
