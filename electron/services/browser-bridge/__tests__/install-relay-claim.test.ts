import { spawn, type ChildProcess } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-install-'))
const home = path.join(root, 'home')
const userData = path.join(root, 'userData')
const appPath = path.join(root, 'app')

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => appPath,
    getPath: (name: string) => {
      if (name === 'home') return home
      if (name === 'userData') return userData
      return path.join(root, String(name))
    },
  },
}))

import { installBrowserBridge } from '../installer'

const hostDir = path.join(userData, 'browser-bridge', 'native-host')
const launcherName = process.platform === 'win32' ? 'host.cmd' : 'host.sh'
const relayFiles = [launcherName, 'host-env.txt', 'host-env.json']
const sentinel = 'KEEP-INSTALLED-RELAY\n'
const holders: ChildProcess[] = []

function wipe(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
}

/** 组件已经在，启动时会跳过整包拷贝，只可能靠写中转脚本改那三个文件。 */
function seedInstalledRelay(): void {
  fs.mkdirSync(path.join(userData, 'browser-bridge', 'extension-chromium'), { recursive: true })
  fs.writeFileSync(path.join(userData, 'browser-bridge', 'extension-chromium', 'manifest.json'), '{}\n')
  fs.mkdirSync(hostDir, { recursive: true })
  fs.writeFileSync(path.join(hostDir, 'host.mjs'), '// installed\n')
  for (const name of relayFiles) {
    fs.writeFileSync(path.join(hostDir, name), sentinel)
  }
}

function relaySnapshot(): Record<string, { text: string; mtimeMs: number }> {
  const snap: Record<string, { text: string; mtimeMs: number }> = {}
  for (const name of relayFiles) {
    const file = path.join(hostDir, name)
    const stat = fs.statSync(file)
    snap[name] = { text: fs.readFileSync(file, 'utf8'), mtimeMs: stat.mtimeMs }
  }
  return snap
}

function holdConnection(): number {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  if (!child.pid) throw new Error('failed to spawn holder')
  holders.push(child)
  const pointer = {
    bridgeRoot: path.join(userData, 'browser-bridge'),
    gatewayFile: path.join(userData, 'browser-bridge', 'gateway.json'),
    userData,
    updatedAt: 1,
    pid: child.pid,
    holderName: '装好的旗鱼',
  }
  fs.writeFileSync(path.join(home, '.sailfish-browser-bridge.json'), `${JSON.stringify(pointer, null, 2)}\n`)
  return child.pid
}

beforeEach(() => {
  wipe(home)
  wipe(userData)
  wipe(appPath)
})

afterAll(() => {
  for (const child of holders) child.kill()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('installBrowserBridge relay scripts', () => {
  it('does not rewrite relay scripts when another live instance holds the connection', async () => {
    seedInstalledRelay()
    const before = relaySnapshot()
    const holderPid = holdConnection()

    const status = await installBrowserBridge()

    expect(status.errors.some((error) => error.includes('装好的旗鱼'))).toBe(true)
    expect(relaySnapshot()).toEqual(before)
    const pointer = JSON.parse(fs.readFileSync(path.join(home, '.sailfish-browser-bridge.json'), 'utf8')) as { pid?: number }
    expect(pointer.pid).toBe(holderPid)
  })

  it('writes relay scripts after this instance claims the connection', async () => {
    seedInstalledRelay()

    const status = await installBrowserBridge()

    expect(status.errors).toEqual([])
    for (const name of relayFiles) {
      const text = fs.readFileSync(path.join(hostDir, name), 'utf8')
      expect(text).toContain(process.execPath)
      expect(text).not.toBe(sentinel)
    }
    const pointer = JSON.parse(fs.readFileSync(path.join(home, '.sailfish-browser-bridge.json'), 'utf8')) as { pid?: number }
    expect(pointer.pid).toBe(process.pid)
  })
})
