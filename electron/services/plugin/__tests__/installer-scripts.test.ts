import { execFile } from 'child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { existsSync } from 'fs'
import os from 'os'
import path from 'path'
import { promisify } from 'util'
import { describe, expect, it } from 'vitest'
import { installPlugin, npmCliArgs } from '../installer'

const execFileAsync = promisify(execFile)

describe('npmCliArgs', () => {
  it('安装不跑脚本，包名放在 -- 之后', () => {
    expect(npmCliArgs('install', '  @scope/name  ')).toEqual([
      'install', '--ignore-scripts', '--save', '--', '@scope/name',
    ])
    expect(npmCliArgs('update', './my-plugin')).toEqual([
      'update', '--ignore-scripts', '--', './my-plugin',
    ])
    expect(npmCliArgs('uninstall', 'some-plugin')).toEqual([
      'uninstall', '--ignore-scripts', '--', 'some-plugin',
    ])
  })

  it('拒绝把选项当成包名', () => {
    expect(() => npmCliArgs('install', '--registry=http://evil')).toThrow(/不能以 - 开头/)
    expect(() => npmCliArgs('update', '  -D')).toThrow(/不能以 - 开头/)
    expect(() => npmCliArgs('uninstall', '   ')).toThrow(/缺少包名/)
  })
})

describe('installPlugin', () => {
  it('本地包的安装脚本不会执行，包本身会装上', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sf-plugin-install-'))
    const pkg = path.join(root, 'pkg')
    const userData = path.join(root, 'data')
    const marker = path.join(root, 'RAN')
    await mkdir(pkg)
    await writeFile(
      path.join(pkg, 'mark.js'),
      `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')\n`,
    )
    await writeFile(path.join(pkg, 'package.json'), JSON.stringify({
      name: 'evil-plugin',
      version: '1.0.0',
      scripts: { postinstall: 'node mark.js' },
    }))

    try {
      const result = await installPlugin(pkg, userData)
      expect(result.success).toBe(true)
      expect(result.error).toBeUndefined()
      expect(existsSync(marker)).toBe(false)
      expect(existsSync(path.join(userData, 'plugins', 'node_modules', 'evil-plugin', 'package.json'))).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  it('以 - 开头的 spec 不会去调用 npm', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sf-plugin-reject-'))
    try {
      const result = await installPlugin('--registry=http://127.0.0.1:9', root)
      expect(result.success).toBe(false)
      expect(result.error).toMatch(/不能以 - 开头/)
      expect(existsSync(path.join(root, 'plugins'))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('不带 --ignore-scripts 时，同一份包的脚本会执行', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sf-plugin-control-'))
    const pkg = path.join(root, 'pkg')
    const marker = path.join(root, 'RAN')
    await mkdir(pkg)
    await writeFile(
      path.join(pkg, 'mark.js'),
      `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')\n`,
    )
    await writeFile(path.join(pkg, 'package.json'), JSON.stringify({
      name: 'evil-plugin',
      version: '1.0.0',
      scripts: { postinstall: 'node mark.js' },
    }))
    const prefix = path.join(root, 'prefix')
    await mkdir(prefix)
    await writeFile(
      path.join(prefix, 'package.json'),
      JSON.stringify({ name: 'control', private: true }),
    )

    try {
      await execFileAsync('npm', ['install', '--ignore-scripts=false', '--save', pkg], { cwd: prefix, timeout: 60_000 })
      expect(existsSync(marker)).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)
})
