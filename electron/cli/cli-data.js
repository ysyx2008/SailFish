/* eslint-env node */
/**
 * CLI 数据目录
 *
 * 开发入口默认进沙箱（不写桌面真实历史）；装机后的正式命令默认与桌面共用。
 * 沙箱内每次启动从桌面借用 AI Profiles + credentials（省去重配 Key）。
 *
 * 环境变量：
 *   SFT_DATA_DIR            显式数据目录（视为沙箱；测试用）
 *   SFT_CLI_SANDBOX=1       使用 `{desktop}/cli-sandbox` 并借用桌面 Key/Profiles
 *   SFT_CLI_SHARE_DESKTOP=1 开发态显式改用桌面真实数据
 *   SFT_CLI_NO_BORROW=1     沙箱内不从桌面复制
 */
'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')
const { readOemIdentity } = require('./oem-identity.js')
const oemIdentity = readOemIdentity()

const CONFIG_FILE = 'qiyu-terminal-config.json'
const CREDENTIAL_FILES = ['credentials.json', 'master.key']
const BORROW_CONFIG_KEYS = ['aiProfiles', 'activeAiProfile', 'autoVisionModel', 'autoFailoverModel', 'aiRules']

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

function getPointerPath() {
  return path.join(getAppDataPath(), oemIdentity.dataDirName, 'data-location.json')
}

function resolveDesktopUserData() {
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
    // ignore
  }
  return defaultPath
}

function copyFileIfExists(src, dst) {
  if (!fs.existsSync(src)) return false
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  fs.copyFileSync(src, dst)
  try {
    fs.chmodSync(dst, 0o600)
  } catch {
    // ignore
  }
  return true
}

function borrowDesktopData(desktopDir, sandboxDir) {
  const result = { borrowedCredentials: false, borrowedAiProfiles: false }
  if (!desktopDir || !sandboxDir || path.resolve(desktopDir) === path.resolve(sandboxDir)) {
    return result
  }

  fs.mkdirSync(sandboxDir, { recursive: true })

  for (const name of CREDENTIAL_FILES) {
    if (copyFileIfExists(path.join(desktopDir, name), path.join(sandboxDir, name))) {
      result.borrowedCredentials = true
    }
  }

  const desktopConfigPath = path.join(desktopDir, CONFIG_FILE)
  if (!fs.existsSync(desktopConfigPath)) return result

  let desktopConfig
  try {
    desktopConfig = JSON.parse(fs.readFileSync(desktopConfigPath, 'utf-8'))
  } catch (err) {
    console.warn('[CLI] 无法读取桌面配置，跳过借用 AI Profiles:', err.message || err)
    return result
  }
  if (!desktopConfig || typeof desktopConfig !== 'object') return result

  const sandboxConfigPath = path.join(sandboxDir, CONFIG_FILE)
  let sandboxConfig = {}
  if (fs.existsSync(sandboxConfigPath)) {
    try {
      sandboxConfig = JSON.parse(fs.readFileSync(sandboxConfigPath, 'utf-8')) || {}
    } catch {
      sandboxConfig = {}
    }
  }
  if (typeof sandboxConfig !== 'object' || Array.isArray(sandboxConfig)) {
    sandboxConfig = {}
  }

  let changed = false
  for (const key of BORROW_CONFIG_KEYS) {
    if (desktopConfig[key] !== undefined) {
      sandboxConfig[key] = desktopConfig[key]
      changed = true
      if (key === 'aiProfiles') result.borrowedAiProfiles = true
    }
  }

  if (changed) {
    fs.writeFileSync(sandboxConfigPath, JSON.stringify(sandboxConfig, null, '\t'), 'utf-8')
  }

  return result
}

function applySandbox(desktopDir, sandboxDir) {
  process.env.SFT_DATA_DIR = sandboxDir
  // 打包态 / ELECTRON_RUN_AS_NODE：真实 electron 需 setPath，shim 则读 SFT_DATA_DIR
  try {
    const electron = require('electron')
    const app = electron && electron.app
    if (app && typeof app.setPath === 'function') {
      app.setPath('userData', sandboxDir)
    }
  } catch {
    // shim 或不可用时忽略
  }

  if (process.env.SFT_CLI_NO_BORROW === '1') {
    console.info(`[CLI] 沙箱: ${sandboxDir}（未借用桌面数据）`)
    return { desktopDir, sandboxDir, shared: false }
  }
  const borrowed = borrowDesktopData(desktopDir, sandboxDir)
  const parts = []
  if (borrowed.borrowedAiProfiles) parts.push('AI Profiles')
  if (borrowed.borrowedCredentials) parts.push('credentials')
  if (parts.length > 0) {
    console.info(`[CLI] 沙箱: ${sandboxDir}`)
    console.info(`[CLI] 已从桌面借用: ${parts.join(', ')}`)
  } else {
    console.info(`[CLI] 沙箱: ${sandboxDir}（桌面无可借用的 AI/凭据）`)
  }
  return { desktopDir, sandboxDir, shared: false }
}

/**
 * 决定 CLI 写哪份数据。纯函数，便于单测。
 *
 * 优先级：显式目录 > 显式沙箱 > 显式共用桌面 > 入口默认。
 *
 * @param {{
 *   explicitDir?: string
 *   sandboxFlag?: boolean
 *   shareDesktopFlag?: boolean
 *   defaultSandbox?: boolean
 * }} flags
 * @returns {{ mode: 'sandbox' | 'shared', explicitDir?: string }}
 */
function resolveCliDataMode(flags) {
  if (flags.explicitDir) return { mode: 'sandbox', explicitDir: flags.explicitDir }
  if (flags.sandboxFlag) return { mode: 'sandbox' }
  if (flags.shareDesktopFlag) return { mode: 'shared' }
  if (flags.defaultSandbox) return { mode: 'sandbox' }
  return { mode: 'shared' }
}

/**
 * 在加载 Electron shim / 服务之前调用。
 * @param {{ defaultSandbox?: boolean }} [opts] 开发入口传 true：默认进沙箱
 * @returns {{ desktopDir: string, sandboxDir: string, shared: boolean }}
 */
function setupCliDataDir(opts) {
  const desktopDir = resolveDesktopUserData()
  const decision = resolveCliDataMode({
    explicitDir: process.env.SFT_DATA_DIR,
    sandboxFlag: process.env.SFT_CLI_SANDBOX === '1',
    shareDesktopFlag: process.env.SFT_CLI_SHARE_DESKTOP === '1',
    defaultSandbox: opts && opts.defaultSandbox === true,
  })

  if (decision.mode === 'sandbox') {
    const sandboxDir = decision.explicitDir || path.join(desktopDir, 'cli-sandbox')
    return applySandbox(desktopDir, sandboxDir)
  }

  return { desktopDir, sandboxDir: desktopDir, shared: true }
}

module.exports = {
  resolveDesktopUserData,
  borrowDesktopData,
  resolveCliDataMode,
  setupCliDataDir,
  BORROW_CONFIG_KEYS,
}
