import type {
  BrowserBridgeAttachTarget,
  BrowserBridgeCommand,
  BrowserBridgeCommandResult,
  BrowserBridgePingResult,
  BrowserBridgeCapability,
} from '@shared/types/browser-bridge'
import {
  BROWSER_BRIDGE_CAPABILITY_GOTO_NEW_TAB,
  BROWSER_BRIDGE_CAPABILITY_TABS_MANAGE,
  BROWSER_BRIDGE_GOTO_NEW_TAB_MIN_VERSION,
  BROWSER_BRIDGE_TABS_MANAGE_MIN_VERSION,
  BROWSER_BRIDGE_PROTOCOL_VERSION,
} from '@shared/types/browser-bridge'

export function parseGatewayLines(buffer: string): { messages: unknown[]; rest: string } {
  const messages: unknown[] = []
  let rest = buffer
  let idx = rest.indexOf('\n')
  while (idx >= 0) {
    const line = rest.slice(0, idx).trim()
    rest = rest.slice(idx + 1)
    if (line) {
      try {
        messages.push(JSON.parse(line))
      } catch {
        // skip malformed
      }
    }
    idx = rest.indexOf('\n')
  }
  return { messages, rest }
}

export function serializeGatewayLine(message: unknown): string {
  return `${JSON.stringify(message)}\n`
}

export function isCommandResult(value: unknown): value is BrowserBridgeCommandResult {
  if (!value || typeof value !== 'object') return false
  const obj = value as Record<string, unknown>
  return typeof obj.id === 'string' && typeof obj.success === 'boolean'
}

export function isCommand(value: unknown): value is BrowserBridgeCommand {
  if (!value || typeof value !== 'object') return false
  const obj = value as Record<string, unknown>
  return typeof obj.id === 'string' && typeof obj.action === 'string'
}

export function isLegacyFirefoxManifestOrigin(origin: string): boolean {
  return origin.endsWith('.json') && /Mozilla\/NativeMessagingHosts/i.test(origin)
}

export function isFirefoxHostOrigin(origin: string): boolean {
  return isFirefoxOrigin(origin) || isLegacyFirefoxManifestOrigin(origin)
}

export function inferBrowserFromOrigin(origin: string): 'chrome' | 'edge' | 'firefox' | 'unknown' {
  if (isFirefoxHostOrigin(origin)) return 'firefox'
  if (origin.includes('chrome-extension://')) return 'chrome'
  return 'unknown'
}

export function isFirefoxOrigin(origin: string): boolean {
  return origin.startsWith('moz-extension://')
}

export function isChromiumOrigin(origin: string): boolean {
  return origin.startsWith('chrome-extension://')
}

export function normalizeAttachTargetInput(input: unknown): BrowserBridgeAttachTarget | 'auto' {
  if (input === undefined || input === null || input === '') return 'auto'
  const value = String(input).toLowerCase()
  if (value === 'auto') return 'auto'
  if (value === 'firefox' || value === 'ff') return 'firefox'
  if (value === 'chromium' || value === 'chrome' || value === 'edge') return 'chromium'
  return 'auto'
}

export function attachTargetLabel(target: BrowserBridgeAttachTarget): string {
  return target === 'firefox' ? 'Firefox' : 'Chromium（Chrome/Edge 等）'
}

export function attachTargetFromOrigin(origin: string): BrowserBridgeAttachTarget | null {
  if (isFirefoxOrigin(origin)) return 'firefox'
  if (isChromiumOrigin(origin)) return 'chromium'
  return null
}

export function parsePingResult(value: unknown): BrowserBridgePingResult | null {
  if (!value || typeof value !== 'object') return null
  const obj = value as Record<string, unknown>
  if (typeof obj.extension !== 'string' || typeof obj.version !== 'string') return null
  const protocol = typeof obj.protocol === 'number' ? obj.protocol : undefined
  const capabilities = Array.isArray(obj.capabilities)
    ? (obj.capabilities.filter(
        (c) => c === BROWSER_BRIDGE_CAPABILITY_GOTO_NEW_TAB || c === BROWSER_BRIDGE_CAPABILITY_TABS_MANAGE,
      ) as BrowserBridgeCapability[])
    : undefined
  const hostPermissionsGranted =
    typeof obj.hostPermissionsGranted === 'boolean' ? obj.hostPermissionsGranted : undefined
  return { extension: obj.extension, version: obj.version, protocol, capabilities, hostPermissionsGranted }
}

function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/**
 * 能力探测用的 ping 子集。
 *
 * `BrowserBridgePingResult` 是扩展 ping 响应的完整结构（含 `extension` 标识等），
 * 但能力判断只关心 `version` / `capabilities` / `protocol` 字段。
 * `BrowserBridgeService.getConnectionCapabilities()` 返回的就是这个子集，
 * 让判断函数接受更宽的类型，避免要求调用方凑出完整的 ping 对象。
 */
export type BrowserBridgeCapabilityProbe = {
  version?: string
  capabilities?: BrowserBridgeCapability[]
  protocol?: number
} | null | undefined

/** 扩展是否支持通用 tabs 原语（1.2.0+ 或 capabilities） */
export function extensionSupportsTabsManage(ping: BrowserBridgeCapabilityProbe): boolean {
  if (!ping) return false
  if (ping.capabilities?.includes(BROWSER_BRIDGE_CAPABILITY_TABS_MANAGE)) return true
  return compareSemver(ping.version ?? '0.0.0', BROWSER_BRIDGE_TABS_MANAGE_MIN_VERSION) >= 0
}

/** 扩展是否支持 goto 默认新开标签页（tabs_manage 已包含；旧版 1.1.2 单独推断） */
export function extensionSupportsGotoNewTab(ping: BrowserBridgeCapabilityProbe): boolean {
  if (extensionSupportsTabsManage(ping)) return true
  if (!ping) return false
  if (ping.capabilities?.includes(BROWSER_BRIDGE_CAPABILITY_GOTO_NEW_TAB)) return true
  return compareSemver(ping.version ?? '0.0.0', BROWSER_BRIDGE_GOTO_NEW_TAB_MIN_VERSION) >= 0
}

/** protocol v1：扩展只传 HTML 原语，正文提取在桌面端 */
export function supportsProtocolV1(ping: BrowserBridgeCapabilityProbe): boolean {
  if (!ping) return false
  return (ping.protocol ?? 0) >= BROWSER_BRIDGE_PROTOCOL_VERSION
}

