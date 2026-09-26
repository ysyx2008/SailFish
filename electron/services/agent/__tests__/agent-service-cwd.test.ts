/**
 * 终端页开工时的当前目录：要问眼前那扇窗，不是拿页面标识（agentKey）去问。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/mock/user/data'),
    getName: vi.fn().mockReturnValue('SailFish'),
    getVersion: vi.fn().mockReturnValue('1.0.0')
  },
  BrowserWindow: vi.fn(),
  ipcMain: { on: vi.fn(), handle: vi.fn() }
}))

vi.mock('../../im/im.service', () => ({
  getIMService: vi.fn().mockReturnValue(null)
}))

const refreshCwd = vi.fn()
vi.mock('../../terminal-state.service', () => ({
  getTerminalStateService: () => ({ refreshCwd })
}))

import os from 'os'
import { AgentService } from '../index'
import type { AgentContext, RunOptions } from '../types'

function serviceCapturingResolver() {
  const ai = { chatWithToolsStream: vi.fn(), abort: vi.fn() } as never
  const pty = { onData: vi.fn().mockReturnValue(() => {}), write: vi.fn() } as never
  const service = new AgentService(ai, pty)
  let resolver: RunOptions['cwdResolver']
  vi.spyOn(service, 'getOrCreateAgent').mockReturnValue({
    updateConfig: vi.fn(),
    run: vi.fn(async (_msg: string, _ctx: AgentContext, options?: RunOptions) => {
      resolver = options?.cwdResolver
      return 'ok'
    }),
  } as never)
  return { service, getResolver: () => resolver! }
}

const context = (ptyId?: string): AgentContext => ({
  ptyId,
  terminalOutput: [],
  systemInfo: { os: 'macos', shell: 'zsh' },
  terminalType: 'local',
})

describe('AgentService.run 的当前目录', () => {
  beforeEach(() => refreshCwd.mockReset())

  it('问的是眼前那扇窗，不是页面标识', async () => {
    refreshCwd.mockResolvedValue('/Users/me/project')
    const { service, getResolver } = serviceCapturingResolver()
    await service.run('tab-1', '干活', context('pty-9'))
    expect(await getResolver()()).toBe('/Users/me/project')
    expect(refreshCwd).toHaveBeenCalledWith('pty-9', 'initial')
  })

  it('没有窗格信息时仍按第一个参数问', async () => {
    refreshCwd.mockResolvedValue('/srv/app')
    const { service, getResolver } = serviceCapturingResolver()
    await service.run('pty-legacy', '干活', context(undefined))
    await getResolver()()
    expect(refreshCwd).toHaveBeenCalledWith('pty-legacy', 'initial')
  })

  it('窗格信息是空串（分屏里没有可用窗格）时也按第一个参数问', async () => {
    refreshCwd.mockResolvedValue('/srv/app')
    const { service, getResolver } = serviceCapturingResolver()
    await service.run('pty-legacy', '干活', context(''))
    await getResolver()()
    expect(refreshCwd).toHaveBeenCalledWith('pty-legacy', 'initial')
  })

  it('本地窗问不到时落到本机主目录', async () => {
    refreshCwd.mockResolvedValue('~')
    const { service, getResolver } = serviceCapturingResolver()
    await service.run('tab-1', '干活', context('pty-9'))
    expect(await getResolver()()).toBe(os.homedir())
  })

  it('远程窗在家目录就报 ~，不换成本机主目录', async () => {
    refreshCwd.mockResolvedValue('~')
    const { service, getResolver } = serviceCapturingResolver()
    await service.run('tab-1', '干活', { ...context('pty-ssh'), terminalType: 'ssh' })
    expect(await getResolver()()).toBe('~')
  })
})
