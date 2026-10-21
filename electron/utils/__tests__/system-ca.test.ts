import { describe, expect, it } from 'vitest'
import { mergeCertificatePems } from '../system-ca'

describe('mergeCertificatePems', () => {
  it('keeps bundled certificates and appends system ones that are not already there', () => {
    const bundled = ['-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----\n']
    const system = [
      '-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----\n',
      '-----BEGIN CERTIFICATE-----\nBBB\n-----END CERTIFICATE-----\n',
    ]
    expect(mergeCertificatePems(bundled, system)).toEqual([
      bundled[0],
      system[1],
    ])
  })

  it('treats the same certificate with different line breaks as one', () => {
    const bundled = ['-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----']
    const system = ['-----BEGIN CERTIFICATE-----\r\nAAA\r\n-----END CERTIFICATE-----']
    expect(mergeCertificatePems(bundled, system)).toEqual([bundled[0]])
  })

  it('drops empty entries', () => {
    expect(mergeCertificatePems(['  '], ['\n'])).toEqual([])
  })
})
