/* eslint-env node */
/**
 * Electron API Shim for CLI Mode
 * 
 * Provides mock implementations of Electron APIs so that service code
 * can run in a pure Node.js environment without the Electron runtime.
 * 
 * This file is loaded via Module._resolveFilename override BEFORE any
 * service imports, so `import { app } from 'electron'` transparently
 * gets these stubs instead of the real Electron APIs.
 */
'use strict'

const path = require('path')
const os = require('os')

const fs = require('fs')
const { readOemIdentity } = require('./oem-identity.js')
const oemIdentity = readOemIdentity()

/**
 * Compute the *default* userData path that Electron would use.
 * 注意：此值仅作为“无自定义指针时的回退默认目录”，依赖应用名。
 * 指针文件不放在这里（见 {@link getPointerPath}），因为应用名在 dev/prod 下不同。
 * CLI shim 始终模拟 production 环境行为，应用名取安装身份里的产品名。
 */
function getDefaultUserDataPath() {
  const appName = oemIdentity.productName
  switch (process.platform) {
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', appName)
    case 'win32':
      return path.join(
        process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
        appName
      )
    default:
      return path.join(
        process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
        appName
      )
  }
}

/**
 * 平台级 appData 目录（如 ~/Library/Application Support），与 app.getName() 无关。
 */
function getAppDataPath() {
  switch (process.platform) {
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support')
    case 'win32':
      return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
    default:
      return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  }
}

/**
 * 指针文件固定位置：appData/<数据目录名>/data-location.json。
 * 与 electron/utils/bootstrap.ts 中的 POINTER_PATH 保持一致，确保 CLI 和 GUI
 * 读到同一个指针，无论 dev/prod。
 */
function getPointerPath() {
  return path.join(getAppDataPath(), oemIdentity.dataDirName, 'data-location.json')
}

/**
 * 一次性兼容迁移：把老版本遗留的指针搬到新固定位置。
 * 与 bootstrap.ts 的 migrateLegacyPointer 行为一致：只检查本进程默认目录下的
 * 老指针。dev 和 prod 各自迁移自己的遗留指针，互不干扰。
 */
function migrateLegacyPointerIfNeeded() {
  if (oemIdentity.dataDirName !== 'SailFish') return
  const pointerPath = getPointerPath()
  if (fs.existsSync(pointerPath)) return // 新位置已有指针
  const legacyPath = path.join(getDefaultUserDataPath(), 'data-location.json')
  if (!fs.existsSync(legacyPath)) return // 老位置也没有
  try {
    fs.mkdirSync(path.dirname(pointerPath), { recursive: true })
    fs.copyFileSync(legacyPath, pointerPath)
    console.info('[CLI] 已将旧版数据目录指针迁移到固定位置:', pointerPath)
  } catch (e) {
    console.error('[CLI] 迁移旧版指针文件失败:', e)
  }
}

/**
 * Resolve the effective userData path.
 * Priority: SFT_DATA_DIR env var > pointer file (data-location.json) > default.
 * 开发入口会先设 SFT_DATA_DIR 到沙箱；装机命令默认不设（与桌面共用）。
 */
function getUserDataPath() {
  if (process.env.SFT_DATA_DIR) return process.env.SFT_DATA_DIR

  migrateLegacyPointerIfNeeded()

  const defaultPath = getDefaultUserDataPath()
  try {
    const pointerPath = getPointerPath()
    if (fs.existsSync(pointerPath)) {
      const pointer = JSON.parse(fs.readFileSync(pointerPath, 'utf-8'))
      if (pointer && typeof pointer.dataDir === 'string' && pointer.dataDir) {
        return pointer.dataDir
      }
    }
  } catch {
    // 指针文件损坏或不可读时回退默认目录
  }
  return defaultPath
}

const userDataPath = getUserDataPath()

// ==================== app ====================

const app = {
  getPath(name) {
    switch (name) {
      case 'userData': return userDataPath
      case 'home': return os.homedir()
      case 'temp': return os.tmpdir()
      case 'desktop': return path.join(os.homedir(), 'Desktop')
      case 'documents': return path.join(os.homedir(), 'Documents')
      case 'downloads': return path.join(os.homedir(), 'Downloads')
      case 'appData': return getAppDataPath()
      default: return userDataPath
    }
  },
  isPackaged: false,
  getName() { return oemIdentity.productName },
  getAppPath() { return path.resolve(__dirname, '../..') },
  getVersion() {
    try { return require('../../package.json').version } catch { return '0.0.0' }
  },
  quit() { process.exit(0) },
  exit(code) { process.exit(code || 0) },
  disableHardwareAcceleration() {},
  whenReady() { return Promise.resolve() },
  isReady() { return true },
  requestSingleInstanceLock() { return true },
  on() { return this },
  once() { return this },
  removeListener() { return this },
  removeAllListeners() { return this },
  setPath() {}
}

// ==================== safeStorage ====================

let _safeStorageWarned = false
function warnSafeStorage() {
  if (!_safeStorageWarned) {
    _safeStorageWarned = true
    console.warn('[CLI] safeStorage 在 CLI 模式下不可用，敏感数据未加密存储')
  }
}

const safeStorage = {
  isEncryptionAvailable() { return false },
  encryptString(data) { warnSafeStorage(); return Buffer.from(data || '') },
  decryptString(buf) { warnSafeStorage(); return buf ? buf.toString() : '' }
}

// ==================== BrowserWindow ====================

class BrowserWindow {
  constructor() {
    this.webContents = {
      send() {},
      on() {},
      once() {},
      openDevTools() {},
      setWindowOpenHandler() {},
      isDestroyed() { return true },
      removeAllListeners() {}
    }
    this.id = 0
  }
  isDestroyed() { return true }
  loadURL() { return Promise.resolve() }
  loadFile() { return Promise.resolve() }
  show() {}
  hide() {}
  close() {}
  focus() {}
  setTitle() {}
  on() { return this }
  once() { return this }
  removeListener() { return this }
  static getAllWindows() { return [] }
  static getFocusedWindow() { return null }
}

// ==================== ipcMain ====================

const ipcMain = {
  handle() {},
  on() {},
  once() {},
  removeHandler() {},
  removeAllListeners() {},
  removeListener() {}
}

// ==================== dialog ====================

const dialog = {
  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  showSaveDialog: async () => ({ canceled: true }),
  showMessageBox: async () => ({ response: 0 }),
  showErrorBox() {}
}

// ==================== shell ====================

const shell = {
  openExternal: async () => {},
  openPath: async () => '',
  showItemInFolder() {},
  beep() {}
}

// ==================== Notification ====================

class Notification {
  constructor() {}
  show() {}
  close() {}
  on() { return this }
  once() { return this }
  static isSupported() { return false }
}

// ==================== Menu ====================

const Menu = {
  buildFromTemplate() { return {} },
  setApplicationMenu() {},
  getApplicationMenu() { return null }
}

// ==================== Other stubs ====================

const utilityProcess = {
  fork() { return null }
}

const session = {
  defaultSession: {
    webRequest: {
      onHeadersReceived() {}
    },
    clearCache: async () => {}
  }
}

const nativeTheme = {
  shouldUseDarkColors: true,
  themeSource: 'dark',
  on() { return this },
  removeListener() { return this }
}

const clipboard = {
  readText() { return '' },
  writeText() {}
}

const screen = {
  // CLI 模式无 GUI，返回常见分辨率作为占位值
  getPrimaryDisplay() {
    return { workAreaSize: { width: 1920, height: 1080 } }
  }
}

const globalShortcut = {
  register() { return false },
  unregister() {},
  unregisterAll() {}
}

const powerMonitor = {
  on() {},
  removeListener() {}
}

// ==================== Module exports ====================

module.exports = {
  app,
  safeStorage,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  Notification,
  Menu,
  utilityProcess,
  session,
  nativeTheme,
  clipboard,
  screen,
  globalShortcut,
  powerMonitor,
  // Also export as default for ESM-style imports
  default: {
    app,
    safeStorage,
    BrowserWindow,
    ipcMain,
    dialog,
    shell,
    Notification,
    Menu,
    utilityProcess,
    session,
    nativeTheme,
    clipboard,
    screen,
    globalShortcut,
    powerMonitor
  }
}
