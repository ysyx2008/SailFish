import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const REPO = path.resolve(HERE, '../..')
export const NO_FOCUS = path.join(HERE, 'no-focus.cjs')

/**
 * 启动被测应用。
 * 默认不抢前台、不进 Dock、窗口完全透明、鼠标点不到，测试窗口静音。
 * 只有要亲眼看这一次时才传 `{ visible: true }`。
 *
 * @param {string} dataDir 隔离的用户数据目录
 * @param {string[] | { visible?: boolean, audio?: boolean, extraArgs?: string[], env?: NodeJS.ProcessEnv, executablePath?: string }} [extraArgsOrOpts]
 */
export function launchApp(dataDir, extraArgsOrOpts = []) {
  const opts = Array.isArray(extraArgsOrOpts)
    ? { extraArgs: extraArgsOrOpts }
    : (extraArgsOrOpts ?? {})
  const env = { ...process.env, ...opts.env }
  delete env.VITE_DEV_SERVER_URL
  delete env.ELECTRON_RUN_AS_NODE
  env.SFT_UI_TEST_DATA_DIR = path.resolve(dataDir)
  env.SFT_UI_TEST_AUDIO = opts.audio ? '1' : '0'
  const args = ['-r', path.join(HERE, 'isolate-data.cjs')]
  if (!opts.visible) args.push('-r', NO_FOCUS)
  args.push('.', `--user-data-dir=${dataDir}`, ...(opts.extraArgs ?? []))
  return electron.launch({
    args,
    cwd: REPO,
    env,
    ...(opts.executablePath ? { executablePath: opts.executablePath } : {}),
  })
}
