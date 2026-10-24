/**
 * 未启用的插件只登记清单，不执行入口。打开之后才加载。
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return {
    ...actual,
    homedir: () => path.join(actual.tmpdir(), 'sailfish-plugin-test-no-home'),
  }
})

vi.mock('../../../utils/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

import { PluginRegistry } from '../registry'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function writePlugin(base: string, id: string, enabledByDefault = false): string {
  const dir = path.join(base, id)
  mkdirSync(dir, { recursive: true })
  const manifest: Record<string, unknown> = { id, configSchema: {} }
  if (enabledByDefault) manifest.enabledByDefault = true
  writeFileSync(path.join(dir, 'openclaw.plugin.json'), JSON.stringify(manifest))
  writeFileSync(path.join(dir, 'index.js'), `
    const fs = require('fs')
    const path = require('path')
    fs.writeFileSync(path.join(__dirname, 'ran.txt'), 'ran')
    module.exports = {
      id: ${JSON.stringify(id)},
      register(api) {
        fs.writeFileSync(path.join(__dirname, 'registered.txt'), 'reg')
        api.registerTool({
          name: 'ping',
          description: 'ping',
          parameters: { type: 'object', properties: {} },
          async execute() {
            return { content: [{ type: 'text', text: 'ok' }] }
          },
        })
      },
    }
  `)
  return dir
}

describe('未启用的插件不执行入口', () => {
  it('关掉的和被配置关掉的不跑代码，默认开着的会跑，打开之后才跑', async () => {
    const base = mkdtempSync(path.join(tmpdir(), 'sft-plugin-defer-'))
    const userData = mkdtempSync(path.join(tmpdir(), 'sft-plugin-userdata-'))
    roots.push(base, userData)

    const offDir = writePlugin(base, 'off-plugin')
    const onDir = writePlugin(base, 'on-plugin', true)
    const forcedDir = writePlugin(base, 'forced-off', true)
    const deniedDir = writePlugin(base, 'denied-plugin', true)

    const registry = new PluginRegistry({
      enabled: true,
      userDataPath: userData,
      loadPaths: [base],
      deny: ['denied-plugin'],
      entries: { 'forced-off': { enabled: false } },
    })

    await registry.loadAll()

    expect(existsSync(path.join(offDir, 'ran.txt'))).toBe(false)
    expect(existsSync(path.join(forcedDir, 'ran.txt'))).toBe(false)
    expect(existsSync(path.join(deniedDir, 'ran.txt'))).toBe(false)
    expect(existsSync(path.join(onDir, 'ran.txt'))).toBe(true)
    expect(existsSync(path.join(onDir, 'registered.txt'))).toBe(true)

    const list = registry.listAll()
    expect(list.find(p => p.id === 'off-plugin')).toMatchObject({ enabled: false, toolCount: 0 })
    expect(list.find(p => p.id === 'forced-off')).toMatchObject({ enabled: false })
    expect(list.find(p => p.id === 'on-plugin')!.enabled).toBe(true)
    expect(list.find(p => p.id === 'denied-plugin')).toBeUndefined()
    expect(registry.getToolDefinitions().some(t => t.function.name.includes('on_plugin'))).toBe(true)

    const enabled = await registry.enablePlugin('off-plugin')
    expect(enabled).toBe(true)
    expect(existsSync(path.join(offDir, 'ran.txt'))).toBe(true)
    expect(existsSync(path.join(offDir, 'registered.txt'))).toBe(true)
    expect(registry.get('off-plugin')!.enabled).toBe(true)
    expect(registry.getToolDefinitions().some(t => t.function.name.includes('off_plugin'))).toBe(true)
  })
})
