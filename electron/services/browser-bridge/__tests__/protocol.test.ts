import { describe, expect, it } from 'vitest'
import {
  attachTargetLabel,
  inferBrowserFromOrigin,
  isCommand,
  isCommandResult,
  normalizeAttachTargetInput,
  parseGatewayLines,
  parsePingResult,
  serializeGatewayLine,
  supportsProtocolV1,
} from '../protocol'
import { BROWSER_BRIDGE_PROTOCOL_VERSION } from '@shared/types/browser-bridge'

describe('browser-bridge protocol', () => {
  it('parseGatewayLines splits newline-delimited JSON', () => {
    const input = '{"a":1}\n{"b":2}\npartial'
    const { messages, rest } = parseGatewayLines(input)
    expect(messages).toEqual([{ a: 1 }, { b: 2 }])
    expect(rest).toBe('partial')
  })

  it('serializeGatewayLine appends newline', () => {
    expect(serializeGatewayLine({ x: 1 })).toBe('{"x":1}\n')
  })

  it('isCommand detects command envelope', () => {
    expect(isCommand({ id: '1', action: 'ping' })).toBe(true)
    expect(isCommand({ id: '1' })).toBe(false)
  })

  it('isCommandResult detects result envelope', () => {
    expect(isCommandResult({ id: '1', success: true })).toBe(true)
    expect(isCommandResult({ id: '1', success: false, error: 'x' })).toBe(true)
  })

  it('inferBrowserFromOrigin detects firefox', () => {
    expect(inferBrowserFromOrigin('moz-extension://abc/')).toBe('firefox')
    expect(inferBrowserFromOrigin('chrome-extension://abc/')).toBe('chrome')
    expect(
      inferBrowserFromOrigin(
        '/Users/me/Library/Application Support/Mozilla/NativeMessagingHosts/com.sailfish.browser.json',
      ),
    ).toBe('firefox')
  })

  it('normalizeAttachTargetInput maps browser aliases', () => {
    expect(normalizeAttachTargetInput(undefined)).toBe('auto')
    expect(normalizeAttachTargetInput('auto')).toBe('auto')
    expect(normalizeAttachTargetInput('firefox')).toBe('firefox')
    expect(normalizeAttachTargetInput('chrome')).toBe('chromium')
    expect(normalizeAttachTargetInput('edge')).toBe('chromium')
    expect(normalizeAttachTargetInput('chromium')).toBe('chromium')
  })

  it('attachTargetLabel returns user-facing names', () => {
    expect(attachTargetLabel('firefox')).toContain('Firefox')
    expect(attachTargetLabel('chromium')).toContain('Chromium')
  })

  it('parsePingResult reads extension ping envelope', () => {
    expect(parsePingResult({ extension: 'sailfish-browser-bridge', version: '1.1.0', protocol: 1 })).toEqual({
      extension: 'sailfish-browser-bridge',
      version: '1.1.0',
      protocol: 1,
    })
    expect(
      parsePingResult({
        extension: 'sailfish-browser-bridge',
        version: '1.2.2',
        protocol: 1,
        hostPermissionsGranted: false,
      }),
    ).toEqual({
      extension: 'sailfish-browser-bridge',
      version: '1.2.2',
      protocol: 1,
      hostPermissionsGranted: false,
    })
    expect(parsePingResult({ extension: 'x', version: '1.0.0' })).toEqual({
      extension: 'x',
      version: '1.0.0',
      protocol: undefined,
    })
    expect(parsePingResult(null)).toBeNull()
  })

  it('supportsProtocolV1 checks protocol field', () => {
    expect(supportsProtocolV1({ version: '1.1.0', protocol: BROWSER_BRIDGE_PROTOCOL_VERSION })).toBe(true)
    expect(supportsProtocolV1({ version: '1.0.6' })).toBe(false)
  })

  it('extensionSupportsGotoNewTab checks capabilities or version', async () => {
    const { extensionSupportsGotoNewTab, extensionSupportsTabsManage } = await import('../protocol')
    expect(
      extensionSupportsGotoNewTab({ version: '1.1.0', capabilities: ['goto_new_tab'] }),
    ).toBe(true)
    expect(extensionSupportsGotoNewTab({ version: '1.1.2' })).toBe(true)
    expect(extensionSupportsGotoNewTab({ version: '1.1.1' })).toBe(false)
    expect(extensionSupportsTabsManage({ version: '1.2.0' })).toBe(true)
    expect(extensionSupportsTabsManage({ version: '1.1.2', capabilities: ['tabs_manage'] })).toBe(true)
  })
})
