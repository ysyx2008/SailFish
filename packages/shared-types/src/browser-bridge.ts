/** SailFish 浏览器助手（扩展 + Native Host）共享类型 */

export const BROWSER_BRIDGE_NATIVE_HOST = 'com.sailfish.browser' as const

/** 扩展 ↔ 桌面端协议版本（业务逻辑迭代在桌面端，扩展尽量 frozen） */
export const BROWSER_BRIDGE_PROTOCOL_VERSION = 1 as const

/** 冻结的 action 名单 — 新能力优先扩展 payload，而非新增 action */
export const BROWSER_BRIDGE_ACTIONS = [
  'ping',
  'tabs',
  'list_tabs',
  'switch_tab',
  'goto',
  'close_tab',
  'reload',
  'evaluate',
  'snapshot',
  'get_content',
  'click',
  'type',
  'scroll',
] as const

export type BrowserBridgeAction = (typeof BROWSER_BRIDGE_ACTIONS)[number]

/** Chromium 开发版扩展 ID（manifest key，临时加载 / 解压安装） */
export const BROWSER_BRIDGE_CHROMIUM_DEV_EXTENSION_ID = 'ocdljfppijcjpgaaamgeailkgajgjdml' as const

/** Chromium Chrome Web Store 正式版扩展 ID */
export const BROWSER_BRIDGE_CHROMIUM_CWS_EXTENSION_ID = 'dgmhdapfpihhkboikpgfanpgnijbpdhd' as const

/** Native Host allowed_origins 须同时包含开发与商店 ID */
export const BROWSER_BRIDGE_CHROMIUM_EXTENSION_IDS = [
  BROWSER_BRIDGE_CHROMIUM_DEV_EXTENSION_ID,
  BROWSER_BRIDGE_CHROMIUM_CWS_EXTENSION_ID,
] as const

/** 设置页/故障排查展示的 Chromium 扩展 ID（商店正式版） */
export const BROWSER_BRIDGE_CHROMIUM_EXTENSION_ID = BROWSER_BRIDGE_CHROMIUM_CWS_EXTENSION_ID

/** Chrome Web Store 列表页（设置页「从商店安装」按钮，审核通过后可访问） */
export const BROWSER_BRIDGE_CHROMIUM_CWS_LISTING_URL =
  `https://chromewebstore.google.com/detail/${BROWSER_BRIDGE_CHROMIUM_CWS_EXTENSION_ID}` as const

/** Firefox 扩展 ID（manifest gecko.id） */
export const BROWSER_BRIDGE_FIREFOX_EXTENSION_ID = 'sailfish-browser-bridge@yushen.dev' as const

/** Firefox AMO 商店列表页（设置页「从商店安装」按钮） */
export const BROWSER_BRIDGE_FIREFOX_AMO_LISTING_URL =
  'https://addons.mozilla.org/firefox/addon/sailfish-browser-assistant/' as const

export type BrowserBridgeBrowser = 'chrome' | 'edge' | 'firefox' | 'unknown'

/** attach 路由目标：Chromium 系（Chrome/Edge/Arc 等）与 Firefox 两路 */
export type BrowserBridgeAttachTarget = 'firefox' | 'chromium'

/** browser_launch 的 browser 参数（chrome/edge 归并为 chromium） */
export type BrowserBridgeAttachTargetInput =
  | BrowserBridgeAttachTarget
  | 'auto'
  | 'chrome'
  | 'edge'

export type BrowserBridgeConnectionState = 'disconnected' | 'connected' | 'ready'

export interface BrowserBridgeTabInfo {
  index: number
  id?: number
  url: string
  title: string
  active: boolean
}

export interface BrowserBridgeRefInfo {
  selector: string
  role: string
  name?: string
  nth?: number
  required?: boolean
}

export type BrowserBridgeRefMap = Record<string, BrowserBridgeRefInfo>

export interface BrowserBridgeSnapshotResult {
  tree: string
  refs: BrowserBridgeRefMap
  title: string
  url: string
}

/** 扩展 ↔ Host ↔ Electron 统一命令信封 */
export interface BrowserBridgeCommand {
  id: string
  action: string
  payload?: Record<string, unknown>
}

export interface BrowserBridgeCommandResult {
  id: string
  success: boolean
  data?: unknown
  error?: string
}

/** 扩展 ping 上报的可选能力（新扩展通过 capabilities 声明，旧版靠版本号推断） */
export const BROWSER_BRIDGE_CAPABILITY_GOTO_NEW_TAB = 'goto_new_tab' as const
/** 通用 tabs 原语（create/update/query/activate/remove），桌面端组合策略，扩展不再为 Tab 行为发版 */
export const BROWSER_BRIDGE_CAPABILITY_TABS_MANAGE = 'tabs_manage' as const

export type BrowserBridgeCapability =
  | typeof BROWSER_BRIDGE_CAPABILITY_GOTO_NEW_TAB
  | typeof BROWSER_BRIDGE_CAPABILITY_TABS_MANAGE

/** tabs 原语 + goto 默认新开标签所需最低扩展版本（与 manifest 同步，1.2.0 为 Tab 层最终版） */
export const BROWSER_BRIDGE_TABS_MANAGE_MIN_VERSION = '1.2.0' as const

/** @deprecated 用 BROWSER_BRIDGE_TABS_MANAGE_MIN_VERSION；1.1.2 仅兼容推断 */
export const BROWSER_BRIDGE_GOTO_NEW_TAB_MIN_VERSION = '1.1.2' as const

/** 扩展 ping 响应 */
export interface BrowserBridgePingResult {
  extension: string
  version: string
  protocol?: number
  capabilities?: BrowserBridgeCapability[]
  /** Firefox MV3：host_permissions 为可选权限，扩展上报是否已授予 <all_urls> */
  hostPermissionsGranted?: boolean
}

/** 浏览器连接被另一个还开着的程序占着时，给人看的说明。 */
export interface BrowserBridgeHeldNotice {
  title: string
  message: string
}

export interface BrowserBridgeInstallStatus {
  chromiumExtensionPath: string
  firefoxExtensionPath: string
  nativeHostManifestPath: string
  registeredBrowsers: BrowserBridgeBrowser[]
  errors: string[]
  /** 没被占着时不带。 */
  heldNotice?: BrowserBridgeHeldNotice
}

export interface BrowserBridgeConnection {
  browser: BrowserBridgeBrowser
  origin: string
  state: BrowserBridgeConnectionState
  /** 扩展 ping 上报的版本（连接后异步探测） */
  version?: string
  capabilities?: BrowserBridgeCapability[]
  /** Firefox MV3：是否已授予「访问所有网站数据」；旧版扩展未上报时为 undefined */
  hostPermissionsGranted?: boolean
}

export interface BrowserBridgeStatus {
  gatewayRunning: boolean
  port: number | null
  connections: BrowserBridgeConnection[]
  install: BrowserBridgeInstallStatus | null
  extensionIds: {
    chromium: string
    chromiumDev: string
    firefox: string
  }
}

export function isBrowserBridgeComponentsInstalled(
  install: BrowserBridgeInstallStatus | null | undefined,
): boolean {
  if (!install) return false
  return Boolean(install.chromiumExtensionPath) && install.registeredBrowsers.length > 0
}

export function isChromiumBridgeConnection(conn: BrowserBridgeConnection): boolean {
  return (
    conn.browser === 'chrome'
    || conn.browser === 'edge'
    || conn.origin.startsWith('chrome-extension://')
  )
}

export function isFirefoxBridgeConnection(conn: BrowserBridgeConnection): boolean {
  return (
    conn.browser === 'firefox'
    || conn.origin.startsWith('moz-extension://')
    || (conn.origin.endsWith('.json') && /Mozilla\/NativeMessagingHosts/i.test(conn.origin))
  )
}
