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

/**
 * Compute the same userData path that Electron would use.
 * Respects SFT_DATA_DIR env var for custom locations.
 */
function getUserDataPath() {
  if (process.env.SFT_DATA_DIR) return process.env.SFT_DATA_DIR

  const appName = 'SailFish'
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
      case 'appData':
        if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support')
        if (process.platform === 'win32') return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
        return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
      default: return userDataPath
    }
  },
  isPackaged: false,
  getName() { return 'SailFish' },
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
