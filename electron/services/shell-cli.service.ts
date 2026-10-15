/**
 * Shell CLI 安装（macOS）：往 PATH 写入 `sailfish` 薄壳，转发到已安装 App。
 *
 * 工业形态对齐 VS Code `code`：
 *   sailfish → ELECTRON_RUN_AS_NODE=1 "$APP/Contents/MacOS/SailFish" "$APP/.../cli.js" "$@"
 *
 * 开发态：薄壳指向仓库 `electron/cli/main.js`（Node + tsx）。
 *
 * @see electron/cli/SPEC.md
 */
import { app } from 'electron'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createLogger } from '../utils/logger'
import { oemResolved } from '@shared/oem-resolve'

const log = createLogger('ShellCli')

const COMMAND_NAME = oemResolved.identity.cliName
const BUNDLE_ID = oemResolved.identity.appId
const PRODUCT_NAME = oemResolved.identity.productName

export interface ShellCliStatus {
  installed: boolean
  /** 薄壳路径（若已安装） */
  shimPath: string | null
  /** 解析到的 App 路径（打包态）或仓库 CLI 入口（开发态） */
  target: string | null
  /** 建议用户把该目录加入 PATH（通常 ~/.local/bin） */
  binDir: string
  mode: 'packaged' | 'development'
}

function getBinDir(): string {
  return path.join(os.homedir(), '.local', 'bin')
}

function getShimPath(): string {
  return path.join(getBinDir(), COMMAND_NAME)
}

/** 打包态：SailFish.app 根路径 */
export function resolvePackagedAppPath(): string | null {
  if (!app.isPackaged) return null
  // .../SailFish.app/Contents/MacOS/SailFish → 上两级为 .app
  const exe = app.getPath('exe')
  const contents = path.dirname(path.dirname(exe))
  if (contents.endsWith('.app') || contents.endsWith('.app/')) {
    return contents.endsWith('.app') ? contents : contents.slice(0, -1)
  }
  const fallback = `/Applications/${PRODUCT_NAME}.app`
  return fs.existsSync(fallback) ? fallback : null
}

function findAppViaMdfind(): string | null {
  try {
    const { execSync } = require('child_process') as typeof import('child_process')
    const out = execSync(
      `mdfind "kMDItemCFBundleIdentifier==${BUNDLE_ID}" 2>/dev/null | head -1`,
      { encoding: 'utf-8' }
    ).trim()
    return out && fs.existsSync(out) ? out : null
  } catch {
    return null
  }
}

function getPackagedCliJs(appPath: string): string {
  // electron-builder: Resources/app.asar/dist-electron/cli.js
  return path.join(appPath, 'Contents', 'Resources', 'app.asar', 'dist-electron', 'cli.js')
}

function getPackagedElectronBin(appPath: string): string {
  return path.join(appPath, 'Contents', 'MacOS', PRODUCT_NAME)
}

function buildPackagedShim(appPath: string): string {
  const electronBin = getPackagedElectronBin(appPath)
  const cliJs = getPackagedCliJs(appPath)
  return `#!/bin/bash
# SailFish CLI shim (packaged) — do not edit; reinstall from App Settings
set -euo pipefail
APP=${JSON.stringify(appPath)}
ELECTRON=${JSON.stringify(electronBin)}
CLI=${JSON.stringify(cliJs)}
if [[ ! -x "$ELECTRON" ]]; then
  echo "${COMMAND_NAME}: Electron binary not found: $ELECTRON" >&2
  exit 127
fi
export ELECTRON_RUN_AS_NODE=1
export SFT_CLI_MODE=1
export SFT_CLI_NAME=${COMMAND_NAME}
exec "$ELECTRON" "$CLI" "$@"
`
}

function buildDevelopmentShim(repoRoot: string): string {
  const mainJs = path.join(repoRoot, 'electron', 'cli', 'main.js')
  return `#!/bin/bash
# SailFish CLI shim (development) — points at repo checkout
set -euo pipefail
NODE="\${NODE_BINARY:-node}"
MAIN=${JSON.stringify(mainJs)}
if [[ ! -f "$MAIN" ]]; then
  echo "${COMMAND_NAME}: CLI entry not found: $MAIN" >&2
  echo "Re-run Install Shell Command from a valid SailFish checkout." >&2
  exit 127
fi
export SFT_CLI_MODE=1
export SFT_CLI_NAME=${COMMAND_NAME}
cd ${JSON.stringify(repoRoot)}
exec "$NODE" "$MAIN" "$@"
`
}

export function getShellCliStatus(): ShellCliStatus {
  const binDir = getBinDir()
  const shimPath = getShimPath()
  const installed = fs.existsSync(shimPath)
  const mode = app.isPackaged ? 'packaged' : 'development'

  let target: string | null = null
  if (app.isPackaged) {
    target = resolvePackagedAppPath() || findAppViaMdfind()
  } else {
    target = path.resolve(app.getAppPath(), '..') // often project root in vite-electron
    // vite-plugin-electron: getAppPath may be dist-electron; prefer process.cwd() if package.json exists
    const cwd = process.cwd()
    if (fs.existsSync(path.join(cwd, 'package.json')) && fs.existsSync(path.join(cwd, 'electron', 'cli', 'main.js'))) {
      target = cwd
    }
  }

  return {
    installed,
    shimPath: installed ? shimPath : null,
    target,
    binDir,
    mode
  }
}

export function installShellCli(): { ok: boolean; shimPath?: string; binDir?: string; command?: string; error?: string; pathHint?: boolean } {
  if (process.platform !== 'darwin') {
    return { ok: false, error: 'Shell CLI install is currently supported on macOS only' }
  }

  const binDir = getBinDir()
  const shimPath = getShimPath()

  try {
    fs.mkdirSync(binDir, { recursive: true })

    let body: string
    if (app.isPackaged) {
      const appPath = resolvePackagedAppPath() || findAppViaMdfind()
      if (!appPath) {
        return { ok: false, error: `Could not locate ${PRODUCT_NAME}.app` }
      }
      const cliJs = getPackagedCliJs(appPath)
      // asar 内文件 existsSync 对 asar 路径通常为 true
      body = buildPackagedShim(appPath)
      log.info(`Installing packaged sailfish shim → ${shimPath} (app=${appPath}, cli=${cliJs})`)
    } else {
      const status = getShellCliStatus()
      const repoRoot = status.target
      if (!repoRoot || !fs.existsSync(path.join(repoRoot, 'electron', 'cli', 'main.js'))) {
        return { ok: false, error: 'Could not locate development CLI entry (electron/cli/main.js)' }
      }
      body = buildDevelopmentShim(repoRoot)
      log.info(`Installing development sailfish shim → ${shimPath} (repo=${repoRoot})`)
    }

    fs.writeFileSync(shimPath, body, { mode: 0o755 })
    try {
      fs.chmodSync(shimPath, 0o755)
    } catch {
      // ignore
    }

    const pathEnv = process.env.PATH || ''
    const pathHint = !pathEnv.split(path.delimiter).some(p => path.resolve(p) === path.resolve(binDir))

    return { ok: true, shimPath, binDir, command: COMMAND_NAME, pathHint }
  } catch (err: any) {
    log.error('installShellCli failed:', err)
    return { ok: false, error: err?.message || String(err) }
  }
}

export function uninstallShellCli(): { ok: boolean; error?: string } {
  const shimPath = getShimPath()
  try {
    if (fs.existsSync(shimPath)) {
      fs.unlinkSync(shimPath)
      log.info(`Removed sailfish shim: ${shimPath}`)
    }
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) }
  }
}
