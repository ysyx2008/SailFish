import { describe, expect, it } from 'vitest'
import { buildBrowserBridgePromptSection, patchBrowserBridgeSectionInSystemPrompt } from '../prompt-section'
import type { BrowserBridgeStatus } from '@shared/types/browser-bridge'

function baseStatus(overrides: Partial<BrowserBridgeStatus> = {}): BrowserBridgeStatus {
  return {
    gatewayRunning: true,
    port: 12345,
    connections: [],
    install: null,
    extensionIds: {
      chromium: 'dgmhdapfpihhkboikpgfanpgnijbpdhd',
      chromiumDev: 'ocdljfppijcjpgaaamgeailkgajgjdml',
      firefox: 'sailfish-browser-bridge@yushen.dev',
    },
    ...overrides,
  }
}

describe('buildBrowserBridgePromptSection', () => {
  it('returns empty when components not installed and not connected', () => {
    expect(buildBrowserBridgePromptSection(baseStatus())).toBe('')
  })

  it('includes attach rules when chromium connected', () => {
    const section = buildBrowserBridgePromptSection(
      baseStatus({
        connections: [{ browser: 'chrome', origin: 'chrome-extension://abc/', state: 'ready' }],
      }),
    )
    expect(section).toContain('# 浏览器助手')
    expect(section).toContain('Chromium')
    expect(section).toContain('已连接')
    expect(section).toContain('无需')
    expect(section).toContain('browser_list_tabs')
    expect(section).toContain('两档能力')
    expect(section).toContain('mode": "launch"')
    expect(section).toContain('完整 JS')
    expect(section).not.toContain('两个浏览器都在线')
  })

  it('warns when both browsers connected', () => {
    const section = buildBrowserBridgePromptSection(
      baseStatus({
        connections: [
          { browser: 'chrome', origin: 'chrome-extension://abc/', state: 'ready' },
          { browser: 'firefox', origin: 'moz-extension://xyz/', state: 'ready' },
        ],
      }),
    )
    expect(section).toContain('两个浏览器都在线')
  })

  it('shows install hint when components installed but not connected', () => {
    const section = buildBrowserBridgePromptSection(
      baseStatus({
        install: {
          chromiumExtensionPath: '/tmp/ext',
          firefoxExtensionPath: '/tmp/ff',
          nativeHostManifestPath: '/tmp/host.json',
          registeredBrowsers: ['chrome'],
          errors: [],
        },
      }),
    )
    expect(section).toContain('扩展未连接')
    expect(section).toContain('browser_launch')
  })
})

describe('patchBrowserBridgeSectionInSystemPrompt', () => {
  const connectedStatus = baseStatus({
    connections: [{ browser: 'chrome', origin: 'chrome-extension://abc/', state: 'ready' }],
  })
  const disconnectedStatus = baseStatus({
    install: {
      chromiumExtensionPath: '/tmp/ext',
      firefoxExtensionPath: '/tmp/ff',
      nativeHostManifestPath: '/tmp/host.json',
      registeredBrowsers: ['chrome'],
      errors: [],
    },
  })

  it('replaces existing browser section when connection state changes', () => {
    const oldSection = buildBrowserBridgePromptSection(disconnectedStatus)
    const systemPrompt = `# 运行环境\n\nOS: darwin\n\n${oldSection}\n\n# 核心规则\n\nrules`
    const patched = patchBrowserBridgeSectionInSystemPrompt(systemPrompt, connectedStatus)
    expect(patched).toContain('Chromium')
    expect(patched).toContain('已连接')
    expect(patched).not.toContain('扩展未连接')
    expect(patched).toContain('# 核心规则')
  })

  it('inserts browser section after host environment when missing', () => {
    const systemPrompt = '# 运行环境\n\nOS: darwin\n\n# 核心规则\n\nrules'
    const patched = patchBrowserBridgeSectionInSystemPrompt(systemPrompt, connectedStatus)
    expect(patched.indexOf('# 运行环境')).toBeLessThan(patched.indexOf('# 浏览器助手'))
    expect(patched.indexOf('# 浏览器助手')).toBeLessThan(patched.indexOf('# 核心规则'))
    expect(patched).toContain('browser_list_tabs')
  })

  it('removes browser section when extension uninstalled and disconnected', () => {
    const oldSection = buildBrowserBridgePromptSection(connectedStatus)
    const systemPrompt = `# 运行环境\n\nOS: darwin\n\n${oldSection}\n\n# 核心规则\n\nrules`
    const patched = patchBrowserBridgeSectionInSystemPrompt(systemPrompt, baseStatus())
    expect(patched).not.toContain('# 浏览器助手')
    expect(patched).toContain('# 核心规则')
  })
})
