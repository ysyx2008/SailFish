import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { execFile, execFileSync } from 'child_process'
import { promisify } from 'util'
import {
  BROWSER_BRIDGE_CHROMIUM_EXTENSION_IDS,
  BROWSER_BRIDGE_FIREFOX_EXTENSION_ID,
  BROWSER_BRIDGE_NATIVE_HOST,
  type BrowserBridgeBrowser,
  type BrowserBridgeInstallStatus,
} from '@shared/types/browser-bridge'
import { createLogger } from '../../utils/logger'
import { oemResolved } from '@shared/oem-resolve'
import { oemConfig } from '@shared/oem-runtime'

const log = createLogger('BrowserBridgeInstaller')
const execFileAsync = promisify(execFile)

/** Native Host 进程无法访问 Electron，通过 $HOME 下指针文件定位当前 userData（可自定义数据目录） */
export const BRIDGE_POINTER_BASENAME = '.sailfish-browser-bridge.json'

export function getBridgeRoot(): string {
  return path.join(app.getPath('userData'), 'browser-bridge')
}

export function getBridgePointerPath(): string {
  return path.join(app.getPath('home'), BRIDGE_POINTER_BASENAME)
}

interface BridgePointerFile {
  bridgeRoot?: string
  gatewayFile?: string
  userData?: string
  updatedAt?: number
  pid?: number
  holderName?: string
  execPath?: string
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function readBridgePointer(): BridgePointerFile | null {
  try {
    const raw = fs.readFileSync(getBridgePointerPath(), 'utf8')
    const data = JSON.parse(raw) as BridgePointerFile
    return data && typeof data === 'object' ? data : null
  } catch {
    return null
  }
}

function holderName(): string {
  return oemConfig.brand.name.zh || oemResolved.identity.productName
}

function executableOf(pid: number): string | null {
  try {
    if (process.platform === 'linux') {
      return fs.readlinkSync(`/proc/${pid}/exe`)
    }
    if (process.platform === 'darwin') {
      const out = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim()
      if (!out) return null
      if (out.startsWith('"')) {
        const end = out.indexOf('"', 1)
        return end > 1 ? out.slice(1, end) : null
      }
      return out.split(' ')[0] || null
    }
    if (process.platform === 'win32') {
      const out = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-Command', `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).Path`],
        { encoding: 'utf8', windowsHide: true },
      ).trim()
      return out || null
    }
  } catch {
    return null
  }
  return null
}

/** 进程还在，且可执行文件仍是当初占住连接的那一个。对不上就当作已经不在。 */
function holderStillRunning(existing: BridgePointerFile): boolean {
  if (typeof existing.pid !== 'number' || existing.pid === process.pid) return false
  if (!isPidAlive(existing.pid)) return false
  if (!existing.execPath) return true
  const actual = executableOf(existing.pid)
  if (!actual) return true
  return path.normalize(actual) === path.normalize(existing.execPath)
}

function foreignHolder(): BridgePointerFile | null {
  const existing = readBridgePointer()
  if (!existing || !holderStillRunning(existing)) return null
  return existing
}

function pointerBody(): string {
  const root = getBridgeRoot()
  return `${JSON.stringify({
    bridgeRoot: root,
    gatewayFile: path.join(root, 'gateway.json'),
    userData: app.getPath('userData'),
    updatedAt: Date.now(),
    pid: process.pid,
    holderName: holderName(),
    execPath: process.execPath,
  }, null, 2)}\n`
}

/**
 * 先启动的占住。别人还活着时返回 false，不改指针。
 * 文件还不存在时用独占创建，同时启动时先创建成功的那一个留下。
 */
export function writeBridgePointer(): boolean {
  const pointerPath = getBridgePointerPath()
  fs.mkdirSync(path.dirname(pointerPath), { recursive: true })
  const body = pointerBody()

  for (let attempt = 0; attempt < 2; attempt++) {
    const existing = readBridgePointer()
    if (existing?.pid === process.pid) {
      fs.writeFileSync(pointerPath, body)
    } else if (existing && holderStillRunning(existing)) {
      return false
    } else if (existing) {
      try { fs.unlinkSync(pointerPath) } catch { /* 下一轮再独占创建 */ }
      continue
    } else {
      try {
        fs.writeFileSync(pointerPath, body, { flag: 'wx' })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
        throw error
      }
    }
    if (readBridgePointer()?.pid === process.pid) return true
  }
  return readBridgePointer()?.pid === process.pid
}

function ownsBridgePointer(): boolean {
  const existing = readBridgePointer()
  return !!existing && existing.pid === process.pid
}

export function releaseBridgePointer(): void {
  if (!ownsBridgePointer()) return
  removeBridgePointer()
}

export function removeBridgePointer(): void {
  const pointerPath = getBridgePointerPath()
  if (!fs.existsSync(pointerPath)) return
  try {
    fs.unlinkSync(pointerPath)
  } catch (error) {
    log.warn('Failed to remove bridge pointer:', error)
  }
}

process.on('exit', () => {
  try { releaseBridgePointer() } catch { /* 退出时不再抛 */ }
})

export function getBundledBridgeRoot(): string {
  const base = app.isPackaged
    ? path.join(process.resourcesPath, 'browser-bridge')
    : path.join(app.getAppPath(), 'resources', 'browser-bridge')
  return base
}

/** 异步递归拷贝（启动 install 禁止用 sync 拷贝堵主进程） */
async function copyDirAsync(src: string, dest: string): Promise<void> {
  await fs.promises.cp(src, dest, { recursive: true, force: true })
}

/** 已安装组件齐全时跳过全量拷贝（仍刷新 env / registry） */
function shouldSkipBridgeCopy(root: string): boolean {
  const chromiumManifest = path.join(root, 'extension-chromium', 'manifest.json')
  const hostMjs = path.join(root, 'native-host', 'host.mjs')
  if (!fs.existsSync(chromiumManifest) || !fs.existsSync(hostMjs)) return false
  if (process.platform === 'win32') {
    return fs.existsSync(path.join(root, 'native-host', 'host.cmd'))
  }
  return (
    fs.existsSync(path.join(root, 'native-host', 'host.sh')) ||
    fs.existsSync(path.resolve(getMacAppBundleHelperPath()))
  )
}

function writeJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

function chmodExecutable(filePath: string): void {
  if (process.platform === 'win32') return
  try {
    fs.chmodSync(filePath, 0o755)
  } catch {
    // ignore
  }
}

function hostLauncherPath(hostDir: string): string {
  if (process.platform === 'win32') return path.join(hostDir, 'host.cmd')
  return path.join(hostDir, 'host.sh')
}

const MAC_NATIVE_HOST_HELPER_NAME = 'sailfish-browser-host'

function buildChromiumNativeHostManifest(hostPath: string, extensionIds: readonly string[]): Record<string, unknown> {
  return {
    name: BROWSER_BRIDGE_NATIVE_HOST,
    description: 'SailFish Browser Assistant Native Host',
    path: hostPath,
    type: 'stdio',
    allowed_origins: extensionIds.map((id) => `chrome-extension://${id}/`),
  }
}

/** Firefox 使用 allowed_extensions（扩展 ID 字符串），不是 allowed_origins */
function buildFirefoxNativeHostManifest(hostPath: string, extensionId: string): Record<string, unknown> {
  return {
    name: BROWSER_BRIDGE_NATIVE_HOST,
    description: 'SailFish Browser Assistant Native Host',
    path: hostPath,
    type: 'stdio',
    allowed_extensions: [extensionId],
  }
}

/** macOS：App 包 Contents/Helpers/ 下的 Mach-O（Claude / 智谱同款路径，Chrome 才能拉起） */
function getMacAppBundleHelperPath(): string {
  const execDir = path.dirname(process.execPath)
  return path.join(execDir, '..', 'Helpers', MAC_NATIVE_HOST_HELPER_NAME)
}

/** macOS：编译 Mach-O 启动器；失败则回退 $HOME wrapper */
function buildMacNativeHostBinary(hostDir: string, hostShPath: string, binaryPath: string): boolean {
  const bundledC = path.join(getBundledBridgeRoot(), 'native-host', 'host-launcher.c')
  if (!fs.existsSync(bundledC)) return false

  const copiedC = path.join(hostDir, 'host-launcher.c')
  fs.copyFileSync(bundledC, copiedC)
  fs.mkdirSync(path.dirname(binaryPath), { recursive: true })

  try {
    execFileSync(
      'clang',
      ['-o', binaryPath, copiedC, `-DHOST_SH_PATH=${JSON.stringify(hostShPath)}`],
      { stdio: 'pipe' },
    )
    chmodExecutable(binaryPath)
    try {
      execFileSync('xattr', ['-cr', binaryPath], { stdio: 'ignore' })
      execFileSync('codesign', ['-s', '-', '--force', binaryPath], { stdio: 'ignore' })
    } catch {
      // ignore
    }
    return true
  } catch (error) {
    log.warn('Failed to compile native host binary (is Xcode CLT installed?):', error)
    return false
  }
}

function resolveManifestHostPath(hostDir: string): string {
  const launcher = hostLauncherPath(hostDir)
  if (process.platform !== 'darwin') return launcher

  removeLegacyNativeHostAliases()

  const helperPath = path.resolve(getMacAppBundleHelperPath())
  if (buildMacNativeHostBinary(hostDir, launcher, helperPath)) {
    log.info(`Native host binary: ${helperPath} -> ${launcher}`)
    return helperPath
  }

  const aliasPath = path.join(app.getPath('home'), '.sailfish-browser-host')
  const wrapper = `#!/bin/bash\nexec "${launcher}" "$@"\n`
  try {
    fs.writeFileSync(aliasPath, wrapper, 'utf8')
    chmodExecutable(aliasPath)
    try {
      execFileSync('xattr', ['-cr', aliasPath], { stdio: 'ignore' })
      execFileSync('xattr', ['-cr', hostDir], { stdio: 'ignore' })
    } catch {
      // ignore
    }
    log.warn(`Native host fallback wrapper: ${aliasPath} -> ${launcher}`)
    return aliasPath
  } catch (error) {
    log.warn('Failed to create native host wrapper, using direct launcher path:', error)
    return launcher
  }
}

function removeLegacyNativeHostAliases(): void {
  if (process.platform !== 'darwin') return
  const homeAlias = path.join(app.getPath('home'), '.sailfish-browser-host')
  if (fs.existsSync(homeAlias)) {
    try {
      fs.unlinkSync(homeAlias)
    } catch {
      // ignore
    }
  }
}

function removeNativeHostHelper(): void {
  if (process.platform !== 'darwin') return
  removeLegacyNativeHostAliases()
  const helperPath = path.resolve(getMacAppBundleHelperPath())
  if (!fs.existsSync(helperPath)) return
  try {
    fs.unlinkSync(helperPath)
  } catch (error) {
    log.warn('Failed to remove native host helper:', error)
  }
}

async function registerWindowsNativeHost(
  manifestPath: string,
  browsers: BrowserBridgeBrowser[],
): Promise<void> {
  for (const key of nativeHostRegistryTargets(browsers)) {
    try {
      await execFileAsync('reg', ['add', `HKCU\\${key}`, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'], {
        windowsHide: true,
      })
    } catch (error) {
      log.warn(`Failed to register ${key}:`, error)
      throw error
    }
  }
}

function writeNativeHostManifestFile(manifest: Record<string, unknown>, dir: string): void {
  const manifestName = nativeHostManifestName()
  fs.mkdirSync(dir, { recursive: true })
  const dest = path.join(dir, manifestName)
  writeJson(dest, manifest)
  if (process.platform !== 'win32') fs.chmodSync(dest, 0o644)
  log.info(`Registered native host: ${dest}`)
}

function registerMacNativeHost(
  chromiumManifest: Record<string, unknown>,
  firefoxManifest: Record<string, unknown>,
  browsers: BrowserBridgeBrowser[],
): void {
  if (browsers.includes('chrome') || browsers.includes('edge')) {
    for (const dir of getChromiumNativeHostDirs()) {
      try {
        writeNativeHostManifestFile(chromiumManifest, dir)
      } catch (error) {
        log.warn(`Failed to register native host at ${dir}:`, error)
      }
    }
  }
  if (browsers.includes('firefox')) {
    for (const dir of getFirefoxNativeHostDirs()) {
      try {
        writeNativeHostManifestFile(firefoxManifest, dir)
      } catch (error) {
        log.warn(`Failed to register native host at ${dir}:`, error)
      }
    }
  }
}

function registerLinuxNativeHost(
  chromiumManifest: Record<string, unknown>,
  firefoxManifest: Record<string, unknown>,
  browsers: BrowserBridgeBrowser[],
): void {
  registerMacNativeHost(chromiumManifest, firefoxManifest, browsers)
}

function writeHostEnvScripts(hostDir: string, electronExe: string, gatewayFile: string): void {
  const envContent = [
    `SAILFISH_ELECTRON_EXE=${electronExe}`,
    `SAILFISH_BROWSER_BRIDGE_GATEWAY=${gatewayFile}`,
    '',
  ].join('\n')
  writeJson(path.join(hostDir, 'host-env.json'), {
    SAILFISH_ELECTRON_EXE: electronExe,
    SAILFISH_BROWSER_BRIDGE_GATEWAY: gatewayFile,
  })

  if (process.platform === 'win32') {
    const cmdPath = path.join(hostDir, 'host.cmd')
    fs.writeFileSync(
      cmdPath,
      `@echo off\r\nset "SAILFISH_ELECTRON_EXE=${electronExe}"\r\nset "SAILFISH_BROWSER_BRIDGE_GATEWAY=${gatewayFile}"\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"${electronExe}" "${path.join(hostDir, 'host.mjs')}" %*\r\n`,
      'utf8',
    )
  } else {
    const shPath = path.join(hostDir, 'host.sh')
    fs.writeFileSync(
      shPath,
      `#!/bin/bash\nexport SAILFISH_ELECTRON_EXE="${electronExe}"\nexport SAILFISH_BROWSER_BRIDGE_GATEWAY="${gatewayFile}"\nexport ELECTRON_RUN_AS_NODE=1\nexec "${electronExe}" "${path.join(hostDir, 'host.mjs')}" "$@"\n`,
      'utf8',
    )
    chmodExecutable(shPath)
  }

  fs.writeFileSync(path.join(hostDir, 'host-env.txt'), envContent, 'utf8')
}

function nativeHostManifestName(): string {
  return `${BROWSER_BRIDGE_NATIVE_HOST}.json`
}

/** 历史版本误写的 Firefox 注册表路径（多了 \Firefox 子级），装/卸载时一并清除 */
const LEGACY_FIREFOX_REGISTRY_KEY = `Software\\Mozilla\\Firefox\\NativeMessagingHosts\\${BROWSER_BRIDGE_NATIVE_HOST}`

function nativeHostRegistryTargets(browsers: BrowserBridgeBrowser[]): string[] {
  const keySuffix = `Software\\${'%BROWSER%'}\\NativeMessagingHosts\\${BROWSER_BRIDGE_NATIVE_HOST}`
  const targets: string[] = []
  if (browsers.includes('chrome')) targets.push(keySuffix.replace('%BROWSER%', 'Google\\Chrome'))
  if (browsers.includes('edge')) targets.push(keySuffix.replace('%BROWSER%', 'Microsoft\\Edge'))
  // Firefox 注册表路径为 Software\Mozilla\NativeMessagingHosts（无 \Firefox 子级），
  // 与 Chrome/Edge 结构不同；写成 Mozilla\Firefox 会导致 Firefox 找不到 Native Host。
  if (browsers.includes('firefox')) {
    targets.push(`Software\\Mozilla\\NativeMessagingHosts\\${BROWSER_BRIDGE_NATIVE_HOST}`)
  }
  return targets
}

/** 删除历史误写的 Firefox 注册表 key（HKCU\Software\Mozilla\Firefox\...） */
async function removeLegacyWindowsNativeHostKeys(): Promise<void> {
  if (process.platform !== 'win32') return
  try {
    await execFileAsync('reg', ['delete', `HKCU\\${LEGACY_FIREFOX_REGISTRY_KEY}`, '/f'], {
      windowsHide: true,
    })
  } catch {
    // key 可能不存在，忽略
  }
}

function getChromiumNativeHostDirs(): string[] {
  const home = app.getPath('home')
  const configHome = process.env.XDG_CONFIG_HOME || path.join(home, '.config')

  if (process.platform === 'darwin') {
    const base = path.join(home, 'Library/Application Support')
    return [
      path.join(base, 'Google/Chrome/NativeMessagingHosts'),
      path.join(base, 'Google/Chrome Canary/NativeMessagingHosts'),
      path.join(base, 'Google/Chrome Beta/NativeMessagingHosts'),
      path.join(base, 'Chromium/NativeMessagingHosts'),
      path.join(base, 'Arc/User Data/NativeMessagingHosts'),
      path.join(base, 'BraveSoftware/Brave-Browser/NativeMessagingHosts'),
      path.join(base, 'Microsoft Edge/NativeMessagingHosts'),
      path.join(base, 'Vivaldi/NativeMessagingHosts'),
      path.join(base, 'com.operasoftware.Opera/NativeMessagingHosts'),
    ]
  }

  if (process.platform === 'linux') {
    return [
      path.join(configHome, 'google-chrome/NativeMessagingHosts'),
      path.join(configHome, 'google-chrome-beta/NativeMessagingHosts'),
      path.join(configHome, 'chromium/NativeMessagingHosts'),
      path.join(configHome, 'BraveSoftware/Brave-Browser/NativeMessagingHosts'),
      path.join(configHome, 'microsoft-edge/NativeMessagingHosts'),
      path.join(configHome, 'vivaldi/NativeMessagingHosts'),
    ]
  }

  return []
}

function getFirefoxNativeHostDirs(): string[] {
  const home = app.getPath('home')
  const configHome = process.env.XDG_CONFIG_HOME || path.join(home, '.config')

  if (process.platform === 'darwin') {
    return [path.join(home, 'Library/Application Support/Mozilla/NativeMessagingHosts')]
  }
  if (process.platform === 'linux') {
    return [path.join(configHome, 'mozilla/native-messaging-hosts')]
  }
  return []
}

function getAllNativeHostManifestDirs(browsers: BrowserBridgeBrowser[]): string[] {
  const dirs: string[] = []
  if (browsers.includes('chrome') || browsers.includes('edge')) {
    dirs.push(...getChromiumNativeHostDirs())
  }
  if (browsers.includes('firefox')) {
    dirs.push(...getFirefoxNativeHostDirs())
  }
  return [...new Set(dirs)]
}

function nativeHostManifestDirs(browsers: BrowserBridgeBrowser[]): Array<{ browser: BrowserBridgeBrowser; dir: string }> {
  return getAllNativeHostManifestDirs(browsers).map((dir) => ({ browser: 'chrome' as BrowserBridgeBrowser, dir }))
}

function isWindowsNativeHostRegistered(browser: BrowserBridgeBrowser): boolean {
  if (process.platform !== 'win32' || browser === 'unknown') return false
  const key = nativeHostRegistryTargets([browser])[0]
  if (!key) return false
  try {
    execFileSync('reg', ['query', `HKCU\\${key}`], { stdio: 'ignore', windowsHide: true })
    return true
  } catch {
    return false
  }
}

function detectRegisteredBrowsers(_expectedManifestPath: string): BrowserBridgeBrowser[] {
  const browsers: BrowserBridgeBrowser[] = ['chrome', 'edge', 'firefox']
  const registered: BrowserBridgeBrowser[] = []
  const manifestName = nativeHostManifestName()

  if (process.platform === 'win32') {
    for (const browser of browsers) {
      if (isWindowsNativeHostRegistered(browser)) registered.push(browser)
    }
    return registered
  }

  for (const { browser, dir } of nativeHostManifestDirs(browsers)) {
    if (fs.existsSync(path.join(dir, manifestName))) registered.push(browser)
  }
  return registered
}

export function detectInstallStatus(): BrowserBridgeInstallStatus | null {
  const root = getBridgeRoot()
  const chromiumDest = path.join(root, 'extension-chromium')
  const firefoxDest = path.join(root, 'extension-firefox')
  const hostDest = path.join(root, 'native-host')
  const manifestPath = path.join(hostDest, nativeHostManifestName())

  const hasChromium = fs.existsSync(path.join(chromiumDest, 'manifest.json'))
  const hasHost = fs.existsSync(manifestPath)
  if (!hasChromium || !hasHost) return null

  const registeredBrowsers = detectRegisteredBrowsers(manifestPath)
  return {
    chromiumExtensionPath: chromiumDest,
    firefoxExtensionPath: firefoxDest,
    nativeHostManifestPath: manifestPath,
    registeredBrowsers,
    errors: [],
  }
}

async function unregisterWindowsNativeHost(browsers: BrowserBridgeBrowser[]): Promise<void> {
  for (const key of nativeHostRegistryTargets(browsers)) {
    try {
      await execFileAsync('reg', ['delete', `HKCU\\${key}`, '/f'], { windowsHide: true })
    } catch {
      // key may not exist
    }
  }
  await removeLegacyWindowsNativeHostKeys()
}

function unregisterMacLinuxNativeHost(browsers: BrowserBridgeBrowser[]): void {
  const manifestName = nativeHostManifestName()
  for (const dir of getAllNativeHostManifestDirs(browsers)) {
    const filePath = path.join(dir, manifestName)
    if (!fs.existsSync(filePath)) continue
    try {
      fs.unlinkSync(filePath)
    } catch (error) {
      log.warn(`Failed to remove native host manifest ${filePath}:`, error)
    }
  }
}

export async function uninstallBrowserBridge(): Promise<{ errors: string[] }> {
  const errors: string[] = []
  const browsers: BrowserBridgeBrowser[] = ['chrome', 'edge', 'firefox']

  try {
    if (ownsBridgePointer()) {
      if (process.platform === 'win32') await unregisterWindowsNativeHost(browsers)
      else unregisterMacLinuxNativeHost(browsers)
      removeNativeHostHelper()
      releaseBridgePointer()
    }
  } catch (error) {
    errors.push(`Native host unregister failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  const root = getBridgeRoot()
  for (const sub of ['extension-chromium', 'extension-firefox', 'native-host']) {
    const target = path.join(root, sub)
    if (!fs.existsSync(target)) continue
    try {
      await fs.promises.rm(target, { recursive: true, force: true })
    } catch (error) {
      errors.push(`Remove ${sub} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return { errors }
}

export async function installBrowserBridge(options?: {
  forceCopy?: boolean
}): Promise<BrowserBridgeInstallStatus> {
  const bundled = getBundledBridgeRoot()
  const root = getBridgeRoot()
  const errors: string[] = []
  const registeredBrowsers: BrowserBridgeBrowser[] = []

  const chromiumSrc = path.join(bundled, 'chromium')
  const firefoxSrc = path.join(bundled, 'firefox')
  const sharedSrc = path.join(bundled, 'shared')
  const hostSrc = path.join(bundled, 'native-host')
  const chromiumDest = path.join(root, 'extension-chromium')
  const firefoxDest = path.join(root, 'extension-firefox')
  const hostDest = path.join(root, 'native-host')

  const skipCopy = !options?.forceCopy && shouldSkipBridgeCopy(root)
  try {
    if (skipCopy) {
      log.info('Browser bridge components already present, skipping full copy')
    } else {
      if (fs.existsSync(chromiumSrc)) await copyDirAsync(chromiumSrc, chromiumDest)
      if (fs.existsSync(firefoxSrc)) await copyDirAsync(firefoxSrc, firefoxDest)
      if (fs.existsSync(sharedSrc)) {
        await copyDirAsync(sharedSrc, path.join(chromiumDest, 'shared'))
        await copyDirAsync(sharedSrc, path.join(firefoxDest, 'shared'))
      }
      if (fs.existsSync(hostSrc)) await copyDirAsync(hostSrc, hostDest)
    }
  } catch (error) {
    errors.push(`Copy failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  await fs.promises.mkdir(hostDest, { recursive: true })

  const manifestPath = path.join(hostDest, `${BROWSER_BRIDGE_NATIVE_HOST}.json`)
  const browsers: BrowserBridgeBrowser[] = ['chrome', 'edge', 'firefox']
  if (!writeBridgePointer()) {
    const name = foreignHolder()?.holderName?.trim()
    errors.push(name
      ? `浏览器连接正由「${name}」占用，本程序不会抢占。`
      : '浏览器连接已被其他正在运行的程序占用，本程序不会抢占。')
    return {
      chromiumExtensionPath: chromiumDest,
      firefoxExtensionPath: firefoxDest,
      nativeHostManifestPath: manifestPath,
      registeredBrowsers,
      errors,
    }
  }

  // 占到连接之后才改中转脚本。先写的话，没占上也会把还在用的那份指到本实例。
  const electronExe = process.execPath
  const gatewayFile = path.join(root, 'gateway.json')
  writeHostEnvScripts(hostDest, electronExe, gatewayFile)

  const hostPath = resolveManifestHostPath(hostDest)
  const chromiumManifest = buildChromiumNativeHostManifest(hostPath, BROWSER_BRIDGE_CHROMIUM_EXTENSION_IDS)
  const firefoxManifest = buildFirefoxNativeHostManifest(hostPath, BROWSER_BRIDGE_FIREFOX_EXTENSION_ID)
  writeJson(manifestPath, { ...chromiumManifest, path: hostPath })

  try {
    if (process.platform === 'win32') {
      const winChromium = path.join(hostDest, `${BROWSER_BRIDGE_NATIVE_HOST}-chrome.json`)
      const winFirefox = path.join(hostDest, `${BROWSER_BRIDGE_NATIVE_HOST}-firefox.json`)
      writeJson(winChromium, { ...chromiumManifest, path: hostPath })
      writeJson(winFirefox, { ...firefoxManifest, path: hostPath })
      await registerWindowsNativeHost(winChromium, ['chrome', 'edge'])
      await registerWindowsNativeHost(winFirefox, ['firefox'])
      await removeLegacyWindowsNativeHostKeys()
    } else if (process.platform === 'darwin') {
      registerMacNativeHost(chromiumManifest, firefoxManifest, browsers)
    } else {
      registerLinuxNativeHost(chromiumManifest, firefoxManifest, browsers)
    }
    registeredBrowsers.push(...browsers)
  } catch (error) {
    errors.push(`Native host registration failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  try {
    writeBridgePointer()
  } catch (error) {
    errors.push(`Bridge pointer write failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  return {
    chromiumExtensionPath: chromiumDest,
    firefoxExtensionPath: firefoxDest,
    nativeHostManifestPath: manifestPath,
    registeredBrowsers,
    errors,
  }
}

export function getExtensionGuideUrls(): Record<BrowserBridgeBrowser, string> {
  return {
    chrome: 'chrome://extensions',
    edge: 'edge://extensions',
    firefox: 'about:debugging#/runtime/this-firefox',
    unknown: '',
  }
}
