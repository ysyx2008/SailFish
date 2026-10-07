/**
 * 插件安装器
 * 
 * 通过 npm install 安装/卸载/更新插件包。
 * 安装目标目录为 {userData}/plugins/，使用 --prefix 隔离。
 */

import { execFile } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { loadManifest } from './loader'
import { createLogger } from '../../utils/logger'

const log = createLogger('PluginInstaller')

export interface InstallResult {
  success: boolean
  pluginId?: string
  error?: string
}

/**
 * 获取插件安装根目录
 */
function getPluginsDir(userDataPath: string): string {
  const dir = path.join(userDataPath, 'plugins')
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  // 确保 package.json 存在（npm install --prefix 需要）
  const pkgPath = path.join(dir, 'package.json')
  if (!fs.existsSync(pkgPath)) {
    fs.writeFileSync(pkgPath, JSON.stringify({ name: 'sailfish-plugins', private: true }, null, 2))
  }
  return dir
}

/**
 * 安装插件
 * @param spec npm 包名/路径/tarball（如 "@openclaw/voice-call", "./my-plugin", "./my-plugin.tgz"）
 */
export async function installPlugin(spec: string, userDataPath: string): Promise<InstallResult> {
  const pluginsDir = getPluginsDir(userDataPath)

  log.info(`Installing plugin: ${spec}`)

  try {
    await npmExec(['install', '--save', spec], pluginsDir)

    // 查找新安装的插件 manifest
    const nodeModules = path.join(pluginsDir, 'node_modules')
    const pluginId = findInstalledPluginId(nodeModules, spec)
    if (pluginId) {
      log.info(`Plugin installed: ${pluginId}`)
      return { success: true, pluginId }
    }

    return { success: true }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    log.error(`Failed to install plugin "${spec}":`, err)
    return { success: false, error: errorMsg }
  }
}

/**
 * 精确定位某个包名对应的已安装插件目录（含 manifest 才算插件目录）。
 * 支持普通包名和 scoped 包名（"@scope/name"）。
 * 找不到（未安装或不是插件包）返回 null。
 */
export function resolveInstalledPluginDir(packageName: string, userDataPath: string): string | null {
  if (!packageName || typeof packageName !== 'string') return null
  // win32 下 path.join 会把反斜杠当分隔符归一化，穿越检测必须同时按两种分隔符切分
  const segments = packageName.split(/[\\/]/).filter(s => s.length > 0 && s !== '.')
  if (segments.some(s => s === '..')) return null

  const pluginDir = path.join(userDataPath, 'plugins', 'node_modules', ...segments)
  if (fs.existsSync(path.join(pluginDir, 'openclaw.plugin.json'))) {
    return pluginDir
  }
  return null
}

/**
 * 读取插件目录 package.json 的 name 字段（npm uninstall 的真实包名）。
 * manifest id 与 npm 包名没有相等契约（scoped 包、改名包），卸载时必须以这里解析的为准。
 * 目录无 package.json 或解析失败返回 null。
 */
export function readPackageNameFromDir(pluginDir: string): string | null {
  try {
    const pkgPath = path.join(pluginDir, 'package.json')
    if (!fs.existsSync(pkgPath)) return null
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { name?: unknown }
    if (typeof pkg.name === 'string' && pkg.name.length > 0) return pkg.name
    return null
  } catch {
    return null
  }
}

/**
 * 判断插件目录是否位于 npm 安装区（{userData}/plugins/node_modules 之下）。
 * 手动放置在 plugins/ 根目录的插件不归 npm 管，不能通过 npm uninstall 卸载。
 */
export function isNpmInstalledPluginDir(pluginDir: string, userDataPath: string): boolean {
  const nodeModulesDir = path.join(userDataPath, 'plugins', 'node_modules')
  const rel = path.relative(nodeModulesDir, pluginDir)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/**
 * 校验 package.json 读出的包名确实对应给定插件目录（回环解析）。
 * 防止被篡改/不规范的 package.json 把 npm uninstall 指向同一 plugins 项目中的其他包。
 * win32 路径大小写不敏感比较，POSIX 严格比较。
 */
export function packageNameMatchesDir(packageName: string, pluginDir: string, userDataPath: string): boolean {
  const resolved = resolveInstalledPluginDir(packageName, userDataPath)
  if (!resolved) return false
  if (process.platform === 'win32') {
    return resolved.toLowerCase() === pluginDir.toLowerCase()
  }
  return resolved === pluginDir
}

/**
 * 卸载插件
 */
export async function uninstallPlugin(packageName: string, userDataPath: string): Promise<InstallResult> {
  const pluginsDir = getPluginsDir(userDataPath)

  log.info(`Uninstalling plugin: ${packageName}`)

  try {
    await npmExec(['uninstall', packageName], pluginsDir)
    log.info(`Plugin uninstalled: ${packageName}`)
    return { success: true }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    log.error(`Failed to uninstall plugin "${packageName}":`, err)
    return { success: false, error: errorMsg }
  }
}

/**
 * 更新插件
 */
export async function updatePlugin(packageName: string, userDataPath: string): Promise<InstallResult> {
  const pluginsDir = getPluginsDir(userDataPath)

  log.info(`Updating plugin: ${packageName}`)

  try {
    await npmExec(['update', packageName], pluginsDir)
    log.info(`Plugin updated: ${packageName}`)
    return { success: true }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    log.error(`Failed to update plugin "${packageName}":`, err)
    return { success: false, error: errorMsg }
  }
}

function npmExec(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    execFile(npmCmd, args, { cwd, timeout: 120_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`npm ${args[0]} failed: ${stderr || error.message}`))
      } else {
        resolve(stdout)
      }
    })
  })
}

/**
 * 在 node_modules 中查找刚安装的插件 ID
 */
function findInstalledPluginId(nodeModules: string, _spec: string): string | undefined {
  if (!fs.existsSync(nodeModules)) return undefined

  try {
    const entries = fs.readdirSync(nodeModules, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      // scoped packages
      if (entry.name.startsWith('@')) {
        const scopedDir = path.join(nodeModules, entry.name)
        const subEntries = fs.readdirSync(scopedDir, { withFileTypes: true })
        for (const subEntry of subEntries) {
          if (!subEntry.isDirectory()) continue
          const manifest = loadManifest(path.join(scopedDir, subEntry.name))
          if (manifest) return manifest.id
        }
        continue
      }

      const manifest = loadManifest(path.join(nodeModules, entry.name))
      if (manifest) return manifest.id
    }
  } catch { /* ignore */ }

  return undefined
}
