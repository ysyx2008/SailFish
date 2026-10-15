import type { BrowserWindow } from 'electron'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as net from 'net'
import * as path from 'path'
import {
  BROWSER_BRIDGE_CHROMIUM_CWS_EXTENSION_ID,
  BROWSER_BRIDGE_CHROMIUM_DEV_EXTENSION_ID,
  BROWSER_BRIDGE_FIREFOX_EXTENSION_ID,
  type BrowserBridgeAttachTarget,
  type BrowserBridgeBrowser,
  type BrowserBridgeCapability,
  type BrowserBridgeCommandResult,
  type BrowserBridgeInstallStatus,
  type BrowserBridgeStatus,
} from '@shared/types/browser-bridge'
import { createLogger } from '../../utils/logger'
import { getBridgeRoot, getExtensionGuideUrls, installBrowserBridge, detectInstallStatus, uninstallBrowserBridge, writeBridgePointer, releaseBridgePointer } from './installer'
import { openBrowserInternalUrl } from './browser-launcher'
import {
  inferBrowserFromOrigin,
  isChromiumOrigin,
  isCommandResult,
  isFirefoxHostOrigin,
  normalizeAttachTargetInput,
  parseGatewayLines,
  parsePingResult,
  extensionSupportsTabsManage,
  serializeGatewayLine,
} from './protocol'

const log = createLogger('BrowserBridgeService')

interface HostConnection {
  origin: string
  browser: BrowserBridgeBrowser
  socket: net.Socket
  buffer: string
  version?: string
  capabilities?: BrowserBridgeCapability[]
  hostPermissionsGranted?: boolean
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  timer: NodeJS.Timeout
}

export class BrowserBridgeService {
  private server: net.Server | null = null
  private port: number | null = null
  private token = ''
  private hosts = new Map<net.Socket, HostConnection>()
  private pending = new Map<string, PendingRequest>()
  private lastInstall: BrowserBridgeInstallStatus | null = null
  private started = false
  /** 防止 init 与 installIfNeeded 并发双重 listen */
  private startPromise: Promise<void> | null = null
  private mainWindow: BrowserWindow | null = null

  setMainWindow(win: BrowserWindow | null): void {
    this.mainWindow = win
  }

  async start(): Promise<void> {
    if (this.started) return
    if (this.startPromise) return this.startPromise

    this.startPromise = (async () => {
      this.token = crypto.randomBytes(16).toString('hex')
      await new Promise<void>((resolve, reject) => {
        this.server = net.createServer((socket) => this.handleConnection(socket))
        this.server.on('error', reject)
        this.server.listen(0, '127.0.0.1', () => {
          const address = this.server?.address()
          if (!address || typeof address === 'string') {
            reject(new Error('Failed to bind browser bridge gateway'))
            return
          }
          this.port = address.port
          this.persistGateway()
          this.started = true
          log.info(`Gateway listening on 127.0.0.1:${this.port}`)
          resolve()
        })
      })
    })()

    try {
      await this.startPromise
    } finally {
      this.startPromise = null
    }
  }

  async stop(): Promise<void> {
    for (const { socket } of this.hosts.values()) {
      socket.destroy()
    }
    this.hosts.clear()
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Browser bridge stopped'))
    }
    this.pending.clear()
    await new Promise<void>((resolve) => {
      if (!this.server) {
        resolve()
        return
      }
      this.server.close(() => resolve())
    })
    this.server = null
    this.started = false
    this.startPromise = null
    this.port = null
    releaseBridgePointer()
  }

  private persistGateway(): void {
    const root = getBridgeRoot()
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(
      path.join(root, 'gateway.json'),
      `${JSON.stringify({ port: this.port, token: this.token, updatedAt: Date.now() }, null, 2)}\n`,
      'utf8',
    )
    try {
      writeBridgePointer()
    } catch (error) {
      log.warn('Failed to update bridge pointer:', error)
    }
  }

  async install(options?: { forceCopy?: boolean }): Promise<BrowserBridgeInstallStatus> {
    if (!this.started) {
      throw new Error('Browser bridge gateway is not running')
    }
    this.persistGateway()
    this.lastInstall = await installBrowserBridge(options)
    if (this.lastInstall.errors.length) {
      log.warn('Browser bridge install completed with errors:', this.lastInstall.errors)
    } else {
      log.info('Browser bridge installed')
      // 重载旧版扩展，使其重新连接并获得新 Tab API 能力
      void this.reloadOutdatedExtensions().catch(err =>
        log.debug('Post-install extension reload failed:', err),
      )
    }
    this.notifyConnectionsChanged()
    return this.lastInstall
  }

  /** 首屏后再调用：已安装则 skip 全量拷贝 */
  async installIfNeeded(): Promise<BrowserBridgeInstallStatus | null> {
    if (!this.started) {
      try {
        await this.start()
      } catch (error) {
        log.warn('Browser bridge start failed before installIfNeeded:', error)
        return null
      }
    }
    try {
      return await this.install({ forceCopy: false })
    } catch (error) {
      log.warn('Browser bridge installIfNeeded failed:', error)
      return null
    }
  }

  /**
   * 返回指定 origin 的实时连接能力（从 hosts 读取，无磁盘 I/O）。
   * 供 bridge-session / tabs-bridge 校验时优先读此值，避免 BridgeSession.extensionPing 过期。
   */
  getConnectionCapabilities(
    origin: string,
  ): { version?: string; capabilities?: BrowserBridgeCapability[] } | null {
    for (const host of this.hosts.values()) {
      if (host.origin === origin) {
        return { version: host.version, capabilities: host.capabilities }
      }
    }
    return null
  }

  /** 已连接但缺少 tabs_manage 的扩展；仅 install 时可选调用，不在 host_register 时自动 reload（Firefox 临时加载会被 reload 卸掉） */
  async reloadOutdatedExtensions(): Promise<void> {
    for (const host of [...this.hosts.values()]) {
      try {
        const pingRaw = await this.sendCommand('ping', {}, { origin: host.origin, timeoutMs: 5000 })
        const ping = parsePingResult(pingRaw)
        if (extensionSupportsTabsManage(ping)) continue
        log.info(`Reloading outdated browser extension (${ping?.version ?? 'unknown'}) at ${host.origin}`)
        await this.sendCommand('reload', {}, { origin: host.origin, timeoutMs: 5000 })
      } catch (error) {
        log.debug('Extension reload skipped:', error)
      }
    }
  }

  async uninstall(): Promise<{ errors: string[] }> {
    const result = await uninstallBrowserBridge()
    this.lastInstall = null
    if (result.errors.length) {
      log.warn('Browser bridge uninstall completed with errors:', result.errors)
    } else {
      log.info('Browser bridge uninstalled')
    }
    this.notifyConnectionsChanged()
    return result
  }

  getStatus(): BrowserBridgeStatus {
    if (this.started) {
      this.persistGateway()
    }
    const detected = detectInstallStatus()
    if (detected) this.lastInstall = detected
    return this.buildStatus()
  }

  /** 对已连接扩展发 ping，刷新版本号等元数据 */
  async refreshConnectionMetadata(): Promise<BrowserBridgeStatus> {
    await this.probeAllHosts()
    return this.getStatus()
  }

  private buildStatus(): BrowserBridgeStatus {
    const install = this.lastInstall
    const connections = [...this.hosts.values()].map((host) => ({
      browser: host.browser,
      origin: host.origin,
      state: 'ready' as const,
      version: host.version,
      capabilities: host.capabilities,
      hostPermissionsGranted: host.hostPermissionsGranted,
    }))
    return {
      gatewayRunning: this.started,
      port: this.port,
      connections,
      install,
      extensionIds: {
        chromium: BROWSER_BRIDGE_CHROMIUM_CWS_EXTENSION_ID,
        chromiumDev: BROWSER_BRIDGE_CHROMIUM_DEV_EXTENSION_ID,
        firefox: BROWSER_BRIDGE_FIREFOX_EXTENSION_ID,
      },
    }
  }

  private async probeAllHosts(): Promise<void> {
    await Promise.all(
      [...this.hosts.entries()].map(([socket]) => this.probeHost(socket)),
    )
  }

  private async probeHost(socket: net.Socket): Promise<void> {
    const host = this.hosts.get(socket)
    if (!host) return
    try {
      const pingRaw = await this.sendCommand('ping', {}, { origin: host.origin, timeoutMs: 5000 })
      const ping = parsePingResult(pingRaw)
      if (!ping || !this.hosts.has(socket)) return
      host.version = ping.version
      host.capabilities = ping.capabilities
      host.hostPermissionsGranted = ping.hostPermissionsGranted
    } catch (error) {
      log.debug(`Extension ping failed (${host.origin}):`, error)
    }
  }

  async openExtensionGuide(browser: BrowserBridgeBrowser): Promise<void> {
    const urls = getExtensionGuideUrls()
    const url = urls[browser]
    if (!url) throw new Error(`Unsupported browser: ${browser}`)
    openBrowserInternalUrl(browser, url)
  }

  resolveConnection(browserInput: unknown = 'auto'): {
    origin: string
    browserTarget: BrowserBridgeAttachTarget
  } {
    const requested = normalizeAttachTargetInput(browserInput)
    const all = [...this.hosts.values()]
    const firefoxHosts = all.filter((h) => isFirefoxHostOrigin(h.origin))
    const chromiumHosts = all.filter((h) => isChromiumOrigin(h.origin))

    if (!firefoxHosts.length && !chromiumHosts.length) {
      throw new Error(
        '浏览器扩展未连接。请在 SailFish 设置 → 浏览器助手中安装组件，并在 Chrome/Edge/Firefox 中加载扩展。',
      )
    }

    if (requested === 'auto') {
      if (firefoxHosts.length && chromiumHosts.length) {
        throw new Error(
          'Chromium 与 Firefox 均已连接。请在 browser_launch 中指定 browser: "firefox" 或 "chromium"（用户说火狐/Firefox 用 firefox，Chrome/谷歌浏览器用 chromium）。',
        )
      }
      if (firefoxHosts.length) {
        return { origin: firefoxHosts[0].origin, browserTarget: 'firefox' }
      }
      return { origin: chromiumHosts[0].origin, browserTarget: 'chromium' }
    }

    if (requested === 'firefox') {
      if (!firefoxHosts.length) {
        throw new Error('Firefox 扩展未连接。请在 Firefox about:debugging 中加载 SailFish 浏览器助手扩展。')
      }
      return { origin: firefoxHosts[0].origin, browserTarget: 'firefox' }
    }

    if (!chromiumHosts.length) {
      throw new Error(
        'Chromium 浏览器扩展未连接。请在 Chrome/Edge 等 Chromium 浏览器的扩展页加载 SailFish 浏览器助手。',
      )
    }
    if (chromiumHosts.length > 1) {
      log.warn(`Multiple Chromium connections (${chromiumHosts.length}); using first`)
    }
    return { origin: chromiumHosts[0].origin, browserTarget: 'chromium' }
  }

  async sendCommand(
    action: string,
    payload: Record<string, unknown> = {},
    options: { origin?: string; target?: BrowserBridgeAttachTarget; timeoutMs?: number } = {},
  ): Promise<unknown> {
    const host = this.pickHost(options)
    if (!host) {
      throw new Error(
        'Browser extension not connected. Enable Browser Assistant in SailFish Settings and load the extension in Chrome/Edge/Firefox.',
      )
    }

    const id = `sf-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
    const timeoutMs = options.timeoutMs ?? 60000

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Browser bridge timeout: ${action}`))
      }, timeoutMs)

      this.pending.set(id, {
        resolve,
        reject,
        timer,
      })

      host.socket.write(
        serializeGatewayLine({
          type: 'extension_message',
          origin: host.origin,
          message: { id, action, payload },
        }),
      )
    })
  }

  private pickHost(options: {
    origin?: string
    target?: BrowserBridgeAttachTarget
  } = {}): HostConnection | undefined {
    const all = [...this.hosts.values()]
    if (!all.length) return undefined
    if (options.origin) {
      const match = all.find((h) => h.origin === options.origin)
      if (match) return match
    }
    if (options.target === 'firefox') {
      return all.find((h) => isFirefoxHostOrigin(h.origin))
    }
    if (options.target === 'chromium') {
      return all.find((h) => isChromiumOrigin(h.origin))
    }
    return all[0]
  }

  private handleConnection(socket: net.Socket): void {
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      const parsed = parseGatewayLines(buffer)
      buffer = parsed.rest
      for (const message of parsed.messages) {
        this.handleGatewayMessage(socket, message)
      }
    })
    socket.on('close', () => {
      const hadHost = this.hosts.has(socket)
      this.hosts.delete(socket)
      if (hadHost) this.notifyConnectionsChanged()
    })
    socket.on('error', (error) => {
      log.warn('Host socket error:', error.message)
    })
  }

  private handleGatewayMessage(socket: net.Socket, raw: unknown): void {
    if (!raw || typeof raw !== 'object') return
    const message = raw as Record<string, unknown>

    if (message.type === 'host_register') {
      if (message.token !== this.token) {
        socket.destroy()
        return
      }
      const origin = String(message.origin || 'unknown')
      this.hosts.set(socket, {
        origin,
        browser: inferBrowserFromOrigin(origin),
        socket,
        buffer: '',
      })
      log.info(`Host registered: ${origin}`)
      this.notifyConnectionsChanged()
      void this.probeHost(socket).then(() => this.notifyConnectionsChanged())
      return
    }

    if (message.type === 'extension_message') {
      const inner = message.message
      if (isCommandResult(inner)) {
        this.resolvePending(inner)
      }
    }
  }

  private resolvePending(result: BrowserBridgeCommandResult): void {
    const pending = this.pending.get(result.id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(result.id)
    if (result.success) pending.resolve(result.data)
    else pending.reject(new Error(result.error || 'Browser bridge command failed'))
  }

  private notifyConnectionsChanged(): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return
    this.mainWindow.webContents.send('browserBridge:connectionsChanged', this.buildStatus())
  }
}

let instance: BrowserBridgeService | null = null

export function getBrowserBridgeService(): BrowserBridgeService {
  if (!instance) instance = new BrowserBridgeService()
  return instance
}

/** 仅启动 gateway；install 由主进程首屏后再调度（见 installIfNeeded） */
export async function initBrowserBridgeService(): Promise<BrowserBridgeService> {
  const service = getBrowserBridgeService()
  await service.start()
  return service
}
