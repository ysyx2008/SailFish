/**
 * 插件生命周期撤销契约测试
 *
 * 对应 SPEC.md「生命周期与撤销契约」：
 * - disable 立即撤销注册物且不调用 onUnload；
 * - uninstall（运行时卸载）先撤销、再 onUnload、最多一次、幂等；
 * - 退出时所有已加载插件（含禁用）各调一次 onUnload；
 * - 外部服务同步：空快照同样同步、TTS 内置保护、IM adapter 按实例撤销。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../utils/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

// installer 经 require('fs') 修改对 import * as fs 不可见（vitest 模块隔离），
// 必须用 vi.mock 正式替换；其余 fs 能力保留真实实现
const { mockExistsSync, mockReadFileSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
  mockReadFileSync: vi.fn()
}))
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return { ...actual, existsSync: mockExistsSync, readFileSync: mockReadFileSync }
})
import { PluginRegistry } from '../registry'
import { PluginRuntimeSync } from '../runtime-sync'
import type { PluginRuntimeSyncDeps } from '../runtime-sync'
import type {
  ChannelRegistration,
  HttpRouteEntry,
  LoadedPlugin,
  PluginEntry,
  ProviderRegistration,
  TtsProviderRegistration
} from '../types'
import type { IMAdapter } from '../../im/types'

// ==================== 测试夹具 ====================

function makeEntry(id: string, onUnload?: () => void | Promise<void>): PluginEntry {
  return { id, register() {}, onUnload }
}

function makePlugin(
  id: string,
  opts: {
    enabled?: boolean
    providerId?: string
    ttsIds?: string[]
    channels?: Array<{
      channelId: string
      platform: string
      failCreate?: boolean
      startFailOnce?: boolean
      startSyncThrowOnce?: boolean
      startHangs?: boolean
      startImpl?: () => Promise<void>
    }>
    route?: string
    entry?: PluginEntry
  } = {}
): LoadedPlugin {
  const providers: ProviderRegistration[] = opts.providerId
    ? [{
        id: opts.providerId,
        name: opts.providerId,
        match: () => true,
        chatWithTools: async () => ({ content: 'ok', finish_reason: 'stop' })
      }]
    : []
  const ttsProviders = (opts.ttsIds ?? []).map(tid => ({ id: tid, name: tid } as unknown as TtsProviderRegistration))
  const channels: ChannelRegistration[] = (opts.channels ?? []).map(c => {
    let startAttempts = 0
    return {
      id: c.channelId,
      name: c.channelId,
      createAdapter(config: Record<string, unknown>) {
        if (c.failCreate) throw new Error(`create ${c.channelId} failed`)
        let startImpl: (() => Promise<void>) | undefined
        if (c.startImpl) {
          startImpl = c.startImpl
        } else if (c.startHangs) {
          startImpl = () => new Promise<void>(() => {})
        } else if (c.startFailOnce) {
          startImpl = async () => {
            if (startAttempts++ === 0) throw new Error('start boom')
          }
        } else if (c.startSyncThrowOnce) {
          // 非 async 的 start()：首次调用同步抛错（不返回 Promise）
          startImpl = () => {
            if (startAttempts++ === 0) throw new Error('sync start boom')
            return Promise.resolve()
          }
        }
        return makeAdapter(c.platform, config, startImpl)
      }
    }
  })
  const httpRoutes: HttpRouteEntry[] = opts.route
    ? [{ pluginId: id, method: 'GET', path: opts.route, handler: () => {} }]
    : []
  return {
    manifest: { id, configSchema: {} },
    rootDir: `/tmp/${id}`,
    tools: [],
    providers,
    channels,
    ttsProviders,
    hooks: new Map(),
    httpRoutes,
    enabled: opts.enabled ?? true,
    entry: opts.entry ?? makeEntry(id)
  }
}

const adapterStartSpies = new Map<IMAdapter, ReturnType<typeof vi.fn>>()
const adapterStopSpies = new Map<IMAdapter, ReturnType<typeof vi.fn>>()

beforeEach(() => {
  adapterStartSpies.clear()
  adapterStopSpies.clear()
})

function makeAdapter(
  platform: string,
  _config?: Record<string, unknown>,
  startImpl?: () => Promise<void>
): IMAdapter {
  const start = vi.fn(startImpl ?? (async () => {}))
  const stop = vi.fn()
  const adapter = {
    platform,
    start,
    stop,
    isConnected: () => false,
    sendText: async () => {},
    sendMarkdown: async () => {}
  } as unknown as IMAdapter
  adapterStartSpies.set(adapter, start)
  adapterStopSpies.set(adapter, stop)
  return adapter
}

function makeRegistry(...plugins: LoadedPlugin[]): PluginRegistry {
  const registry = new PluginRegistry({ enabled: true, userDataPath: '/tmp/test-plugins' })
  for (const plugin of plugins) {
    ;(registry as any).plugins.set(plugin.manifest.id, plugin)
    if (plugin.enabled) (registry as any).activatePlugin(plugin)
  }
  return registry
}

/** 记录所有外部服务调用的假依赖（registerImAdapter 的 platform 去重行为对齐真实 IMService） */
function makeSyncDeps(builtinIds: string[] = ['openai-compat', 'volcengine-tts', 'dashscope-tts']) {
  const calls = {
    setProviders: [] as string[][],
    setRoutes: [] as string[][],
    ttsRegistered: [] as string[],
    ttsRemoved: [] as string[],
    imRegistered: [] as string[],
    imUnregistered: [] as string[],
    imRejected: [] as string[],
    channelConfigs: [] as Array<string | Record<string, unknown>>
  }
  const registeredPlatforms = new Set<string>()
  const deps: PluginRuntimeSyncDeps = {
    setPluginProviders: (providers) => {
      calls.setProviders.push(providers.map(p => p.id))
    },
    registerPluginRoutes: (routes) => {
      calls.setRoutes.push(routes.map(r => `${r.method} ${r.path}`))
    },
    registerTtsProvider: (provider) => {
      calls.ttsRegistered.push(provider.id)
    },
    removeTtsProvider: (id) => {
      calls.ttsRemoved.push(id)
    },
    isBuiltinTtsProvider: (id) => builtinIds.includes(id),
    registerImAdapter: (adapter) => {
      if (registeredPlatforms.has(adapter.platform)) {
        calls.imRejected.push(adapter.platform)
        return false
      }
      registeredPlatforms.add(adapter.platform)
      calls.imRegistered.push(adapter.platform)
      return true
    },
    unregisterImAdapter: async (adapter) => {
      calls.imUnregistered.push(adapter.platform)
      registeredPlatforms.delete(adapter.platform)
      await adapter.stop()
    },
    getChannelConfig: (channelId) => {
      const config = { [`${channelId}-key`]: `${channelId}-value` }
      calls.channelConfigs.push(config)
      return config
    }
  }
  return { deps, calls }
}

// ==================== Registry 生命周期契约 ====================

describe('Registry 生命周期契约', () => {
  it('disable 撤销工具与聚合快照，但不调用 onUnload', async () => {
    const onUnload = vi.fn()
    const registry = makeRegistry(makePlugin('p1', { entry: makeEntry('p1', onUnload) }))

    expect(registry.disablePlugin('p1')).toBe(true)
    expect(registry.getToolDefinitions()).toHaveLength(0)
    expect(registry.getAllProviders()).toHaveLength(0)
    expect(registry.getAllHttpRoutes()).toHaveLength(0)
    expect(onUnload).not.toHaveBeenCalled()
  })

  it('unloadPlugin 调用 onUnload 一次并移除插件，之后工具不可达', async () => {
    const onUnload = vi.fn()
    const plugin = makePlugin('p1', {
      entry: makeEntry('p1', onUnload),
      route: '/api/plugins/p1/x'
    })
    plugin.tools.push({
      name: 'action',
      description: 'test',
      parameters: {},
      execute: async () => ({ content: [{ type: 'text', text: 'ok' }] })
    })
    const registry = makeRegistry(plugin)

    const result = await registry.unloadPlugin('p1')
    expect(result.success).toBe(true)
    expect(onUnload).toHaveBeenCalledTimes(1)

    expect(registry.get('p1')).toBeUndefined()
    expect(registry.listAll().find(p => p.id === 'p1')).toBeUndefined()
    expect(await registry.executeTool('plugin_p1_action', {}, 'call-1')).toBeNull()
    expect(registry.getAllHttpRoutes()).toHaveLength(0)
  })

  it('重复 unloadPlugin 返回失败且不重复调用 onUnload', async () => {
    const onUnload = vi.fn()
    const registry = makeRegistry(makePlugin('p1', { entry: makeEntry('p1', onUnload) }))

    await registry.unloadPlugin('p1')
    const second = await registry.unloadPlugin('p1')

    expect(second.success).toBe(false)
    expect(second.error).toContain('not loaded')
    expect(onUnload).toHaveBeenCalledTimes(1)
  })

  it('卸载后重新加载（同一 entry 对象、新加载实例）：onUnload 再次调用', async () => {
    const onUnload = vi.fn()
    // 模拟不重启重装：require/import 模块缓存让新生命周期拿到同一 entry 对象
    const entry = makeEntry('p1', onUnload)
    const registry = makeRegistry(makePlugin('p1', { entry }))

    await registry.unloadPlugin('p1')
    expect(onUnload).toHaveBeenCalledTimes(1)

    const reloaded = makePlugin('p1', { entry })
    ;(registry as any).plugins.set('p1', reloaded)

    const result = await registry.unloadPlugin('p1')
    expect(result.success).toBe(true)
    expect(onUnload).toHaveBeenCalledTimes(2)
  })

  it('卸载后重新加载，退出时 shutdown 对新加载实例调用 onUnload', async () => {
    const onUnload = vi.fn()
    const entry = makeEntry('p1', onUnload)
    const registry = makeRegistry(makePlugin('p1', { entry }))

    await registry.unloadPlugin('p1')
    ;(registry as any).plugins.set('p1', makePlugin('p1', { entry }))

    await registry.shutdown()
    expect(onUnload).toHaveBeenCalledTimes(2)
  })

  it('unload 已禁用的插件仍调用 onUnload（register 时的资源需要对称释放）', async () => {
    const onUnload = vi.fn()
    const registry = makeRegistry(makePlugin('p1', { enabled: false, entry: makeEntry('p1', onUnload) }))

    const result = await registry.unloadPlugin('p1')
    expect(result.success).toBe(true)
    expect(onUnload).toHaveBeenCalledTimes(1)
  })

  it('onUnload 抛错时结果携带错误、插件仍被移除、其他插件不受影响', async () => {
    const goodUnload = vi.fn()
    const registry = makeRegistry(
      makePlugin('bad', { entry: makeEntry('bad', () => { throw new Error('cleanup boom') }) }),
      makePlugin('good', { entry: makeEntry('good', goodUnload) })
    )

    const bad = await registry.unloadPlugin('bad')
    expect(bad.success).toBe(false)
    expect(bad.error).toContain('cleanup boom')
    expect(registry.get('bad')).toBeUndefined()

    const good = await registry.unloadPlugin('good')
    expect(good.success).toBe(true)
    expect(goodUnload).toHaveBeenCalledTimes(1)
  })

  it('onUnload 挂起时按清理预算放行：卸载返回失败但插件仍被移除、流程不被阻塞', async () => {
    vi.useFakeTimers()
    try {
      const never = new Promise<void>(() => {})
      const registry = makeRegistry(makePlugin('hang', { entry: makeEntry('hang', () => never) }))

      const done = registry.unloadPlugin('hang')
      await vi.advanceTimersByTimeAsync(3000)
      const result = await done

      expect(result.success).toBe(false)
      expect(result.error).toContain('timed out')
      expect(registry.get('hang')).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('uninstall 流程顺序：disable 撤销（不调 onUnload）→ unload 调用一次', async () => {
    const onUnload = vi.fn()
    const registry = makeRegistry(makePlugin('p1', { entry: makeEntry('p1', onUnload) }))

    registry.disablePlugin('p1')
    expect(onUnload).not.toHaveBeenCalled()

    await registry.unloadPlugin('p1')
    expect(onUnload).toHaveBeenCalledTimes(1)
  })

  it('shutdown 对 enabled 与 disabled 插件各调用一次 onUnload，单个失败不影响其他', async () => {
    const okUnload = vi.fn()
    const disabledUnload = vi.fn()
    const registry = makeRegistry(
      makePlugin('ok', { entry: makeEntry('ok', okUnload) }),
      makePlugin('off', { enabled: false, entry: makeEntry('off', disabledUnload) }),
      makePlugin('boom', { entry: makeEntry('boom', () => { throw new Error('boom') }) })
    )

    await registry.shutdown()

    expect(okUnload).toHaveBeenCalledTimes(1)
    expect(disabledUnload).toHaveBeenCalledTimes(1)
    // shutdown 后再卸载不会重复调用
    await registry.unloadPlugin('ok')
    expect(okUnload).toHaveBeenCalledTimes(1)
  })

  it('shutdown 中 onUnload 挂起时按预算放行，不阻塞退出', async () => {
    vi.useFakeTimers()
    try {
      const never = new Promise<void>(() => {})
      const afterHang = vi.fn()
      const registry = makeRegistry(
        makePlugin('hang', { entry: makeEntry('hang', () => never) }),
        makePlugin('after', { entry: makeEntry('after', afterHang) })
      )

      const done = registry.shutdown()
      await vi.advanceTimersByTimeAsync(3000)
      await done

      // 挂起者超时放行后，后续插件继续被处理
      expect(afterHang).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

// ==================== RuntimeSync 撤销契约 ====================

describe('RuntimeSync 撤销契约', () => {
  it('首次同步装配全部注册物，channel 配置正确传入', async () => {
    const registry = makeRegistry(makePlugin('p1', {
      providerId: 'prov-1',
      ttsIds: ['tts-1'],
      channels: [{ channelId: 'ch-1', platform: 'plat-1' }],
      route: '/api/plugins/p1/x'
    }))
    const { deps, calls } = makeSyncDeps()
    const sync = new PluginRuntimeSync(deps)

    const failures = await sync.sync(registry)

    expect(failures).toEqual([])
    expect(calls.setProviders).toEqual([['prov-1']])
    expect(calls.setRoutes).toEqual([['GET /api/plugins/p1/x']])
    expect(calls.ttsRegistered).toEqual(['tts-1'])
    expect(calls.imRegistered).toEqual(['plat-1'])
    // adapter 收到的 config 来自 getChannelConfig(channelId)
    expect(calls.channelConfigs).toHaveLength(1)
  })

  it('装配成功后调用 adapter.start() 建立连接', async () => {
    const registry = makeRegistry(makePlugin('p1', {
      channels: [{ channelId: 'ch-1', platform: 'plat-1' }]
    }))
    const { deps } = makeSyncDeps()
    const sync = new PluginRuntimeSync(deps)

    await sync.sync(registry)

    for (const start of adapterStartSpies.values()) {
      expect(start).toHaveBeenCalledTimes(1)
    }
  })

  it('start 失败：回滚注册计入失败段，下次同步自动重试装配', async () => {
    const registry = makeRegistry(makePlugin('p1', {
      channels: [{ channelId: 'ch-1', platform: 'plat-1', startFailOnce: true }]
    }))
    const { deps, calls } = makeSyncDeps()
    const sync = new PluginRuntimeSync(deps)

    // 首次 start 失败：计入失败段，注册被回滚，不入跟踪表
    const failures1 = await sync.sync(registry)
    expect(failures1).toEqual(['im-adapters'])
    expect(calls.imRegistered).toEqual(['plat-1'])
    expect(calls.imUnregistered).toEqual(['plat-1'])

    // 下次同步重试：start 成功，装配完成
    const failures2 = await sync.sync(registry)
    expect(failures2).toEqual([])
    expect(calls.imRegistered).toEqual(['plat-1', 'plat-1'])

    // 禁用后正常撤销的是重试成功的实例
    registry.disablePlugin('p1')
    await sync.sync(registry)
    expect(calls.imUnregistered).toEqual(['plat-1', 'plat-1'])
  })

  it('start() 同步抛错（非 async 实现）：同样回滚注册并在下次同步重试', async () => {
    const registry = makeRegistry(makePlugin('p1', {
      channels: [{ channelId: 'ch-1', platform: 'plat-1', startSyncThrowOnce: true }]
    }))
    const { deps, calls } = makeSyncDeps()
    const sync = new PluginRuntimeSync(deps)

    // 同步抛错不能逸出到 per-channel catch 造成"已注册但不回滚"的泄漏
    const failures1 = await sync.sync(registry)
    expect(failures1).toEqual(['im-adapters'])
    expect(calls.imRegistered).toEqual(['plat-1'])
    expect(calls.imUnregistered).toEqual(['plat-1'])

    // 下次同步重试：start 成功，装配完成
    const failures2 = await sync.sync(registry)
    expect(failures2).toEqual([])
    expect(calls.imRegistered).toEqual(['plat-1', 'plat-1'])

    // 禁用后撤销的是重试成功的实例
    registry.disablePlugin('p1')
    await sync.sync(registry)
    expect(calls.imUnregistered).toEqual(['plat-1', 'plat-1'])
  })

  it('start 挂起按预算放行并回滚注册', async () => {
    vi.useFakeTimers()
    try {
      const registry = makeRegistry(makePlugin('p1', {
        channels: [{ channelId: 'ch-1', platform: 'plat-1', startHangs: true }]
      }))
      const { deps, calls } = makeSyncDeps()
      const sync = new PluginRuntimeSync(deps)

      const done = sync.sync(registry)
      await vi.advanceTimersByTimeAsync(3000)
      const failures = await done

      expect(failures).toEqual(['im-adapters'])
      expect(calls.imRegistered).toEqual(['plat-1'])
      expect(calls.imUnregistered).toEqual(['plat-1'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('start 超时后晚到完成：监护立即 stop 孤儿实例，不留失去引用的活动连接', async () => {
    vi.useFakeTimers()
    try {
      let resolveStart!: () => void
      const slowStart = new Promise<void>(r => { resolveStart = r })
      const registry = makeRegistry(makePlugin('p1', {
        channels: [{ channelId: 'ch-1', platform: 'plat-1', startImpl: () => slowStart }]
      }))
      const { deps, calls } = makeSyncDeps()
      const sync = new PluginRuntimeSync(deps)

      const done = sync.sync(registry)
      await vi.advanceTimersByTimeAsync(3000)
      const failures = await done

      // 超时：计入失败段，注册被回滚（第一次 stop 来自回滚）
      expect(failures).toEqual(['im-adapters'])
      expect(calls.imRegistered).toEqual(['plat-1'])
      expect(calls.imUnregistered).toEqual(['plat-1'])
      const stopSpy = Array.from(adapterStopSpies.values())[0]
      expect(stopSpy).toHaveBeenCalledTimes(1)

      // start 在预算之后晚到完成：监护立即 stop（第二次调用拆除晚建立的连接）
      resolveStart()
      await vi.advanceTimersByTimeAsync(0)
      expect(stopSpy).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('禁用唯一插件后同步：provider/route 空快照同样下发，TTS 撤销，IM adapter 停止', async () => {
    const registry = makeRegistry(makePlugin('p1', {
      providerId: 'prov-1',
      ttsIds: ['tts-1'],
      channels: [{ channelId: 'ch-1', platform: 'plat-1' }],
      route: '/api/plugins/p1/x'
    }))
    const { deps, calls } = makeSyncDeps()
    const sync = new PluginRuntimeSync(deps)

    await sync.sync(registry)
    registry.disablePlugin('p1')
    await sync.sync(registry)

    // 空快照必须显式下发，否则服务中的旧快照残留
    expect(calls.setProviders[1]).toEqual([])
    expect(calls.setRoutes[1]).toEqual([])
    expect(calls.ttsRemoved).toEqual(['tts-1'])
    expect(calls.imUnregistered).toEqual(['plat-1'])
    // adapter 停止被调用（unregister 含 stop）
    for (const stop of adapterStopSpies.values()) {
      expect(stop).toHaveBeenCalledTimes(1)
    }
  })

  it('禁用一个插件不影响其他插件的注册物', async () => {
    const registry = makeRegistry(
      makePlugin('p1', { providerId: 'prov-1', ttsIds: ['tts-1'], channels: [{ channelId: 'ch-1', platform: 'plat-1' }] }),
      makePlugin('p2', { providerId: 'prov-2', ttsIds: ['tts-2'], channels: [{ channelId: 'ch-2', platform: 'plat-2' }] })
    )
    const { deps, calls } = makeSyncDeps()
    const sync = new PluginRuntimeSync(deps)

    await sync.sync(registry)
    registry.disablePlugin('p1')
    await sync.sync(registry)

    expect(calls.setProviders[1]).toEqual(['prov-2'])
    expect(calls.ttsRemoved).toEqual(['tts-1'])
    expect(calls.imUnregistered).toEqual(['plat-1'])
    expect(calls.imRegistered).toEqual(['plat-1', 'plat-2'])
  })

  it('禁用后重新启用：注册物重新装配（幂等往返）', async () => {
    const registry = makeRegistry(makePlugin('p1', {
      providerId: 'prov-1',
      ttsIds: ['tts-1'],
      channels: [{ channelId: 'ch-1', platform: 'plat-1' }]
    }))
    const { deps, calls } = makeSyncDeps()
    const sync = new PluginRuntimeSync(deps)

    await sync.sync(registry)
    registry.disablePlugin('p1')
    await sync.sync(registry)
    registry.enablePlugin('p1')
    await sync.sync(registry)

    expect(calls.setProviders[2]).toEqual(['prov-1'])
    // 删除一次后重新注册
    expect(calls.ttsRemoved).toEqual(['tts-1'])
    expect(calls.ttsRegistered).toEqual(['tts-1', 'tts-1'])
    // adapter 重新装配（新实例）
    expect(calls.imRegistered).toEqual(['plat-1', 'plat-1'])
    expect(calls.imUnregistered).toEqual(['plat-1'])
  })

  it('连续两次无变化同步不产生重复注册', async () => {
    const registry = makeRegistry(makePlugin('p1', { providerId: 'prov-1', ttsIds: ['tts-1'] }))
    const { deps, calls } = makeSyncDeps()
    const sync = new PluginRuntimeSync(deps)

    await sync.sync(registry)
    await sync.sync(registry)

    expect(calls.ttsRegistered).toEqual(['tts-1'])
  })

  it('并发 sync 串行执行：任务不丢不重，执行时读取最新 registry 状态', async () => {
    const registry = makeRegistry(makePlugin('p1', { providerId: 'prov-1', ttsIds: ['tts-1'] }))
    const { deps, calls } = makeSyncDeps()
    const sync = new PluginRuntimeSync(deps)

    const queued = [
      sync.sync(registry),
      sync.sync(registry)
    ]
    // 排队后才发生的禁用：链执行时读到的已是禁用后的状态（快照在执行时读取）
    registry.disablePlugin('p1')
    queued.push(sync.sync(registry))
    await Promise.all(queued)

    // 三个任务各执行一次（串行链不丢任务、不重复执行）
    expect(calls.setProviders).toHaveLength(3)
    // 终态与禁用状态一致：无注册、无残留
    expect(calls.setProviders[2]).toEqual([])
    expect(calls.ttsRegistered).toEqual([])
    expect(calls.ttsRemoved).toEqual([])
  })

  it('插件占用内置 TTS id 被跳过：不注册、禁用后也不删除', async () => {
    const registry = makeRegistry(makePlugin('p1', { ttsIds: ['openai-compat'] }))
    const { deps, calls } = makeSyncDeps()
    const sync = new PluginRuntimeSync(deps)

    await sync.sync(registry)
    registry.disablePlugin('p1')
    await sync.sync(registry)

    expect(calls.ttsRegistered).toEqual([])
    expect(calls.ttsRemoved).toEqual([])
  })

  it('两个插件注册同一 TTS id：先到先得，禁用 owner 后由后者接管', async () => {
    const registry = makeRegistry(
      makePlugin('p1', { ttsIds: ['shared-tts'] }),
      makePlugin('p2', { ttsIds: ['shared-tts'] })
    )
    const { deps, calls } = makeSyncDeps()
    const sync = new PluginRuntimeSync(deps)

    await sync.sync(registry)
    expect(calls.ttsRegistered).toEqual(['shared-tts'])

    registry.disablePlugin('p1')
    await sync.sync(registry)
    // owner 变化：先删后注册（p2 实例接管）
    expect(calls.ttsRemoved).toEqual(['shared-tts'])
    expect(calls.ttsRegistered).toEqual(['shared-tts', 'shared-tts'])

    registry.disablePlugin('p2')
    await sync.sync(registry)
    expect(calls.ttsRemoved).toEqual(['shared-tts', 'shared-tts'])
    expect(calls.ttsRegistered).toEqual(['shared-tts', 'shared-tts'])
  })

  it('unloadPlugin 后同步：注册物全部撤销', async () => {
    const registry = makeRegistry(makePlugin('p1', {
      providerId: 'prov-1',
      ttsIds: ['tts-1'],
      channels: [{ channelId: 'ch-1', platform: 'plat-1' }],
      route: '/api/plugins/p1/x'
    }))
    const { deps, calls } = makeSyncDeps()
    const sync = new PluginRuntimeSync(deps)

    await sync.sync(registry)
    await registry.unloadPlugin('p1')
    await sync.sync(registry)

    expect(calls.setProviders[1]).toEqual([])
    expect(calls.setRoutes[1]).toEqual([])
    expect(calls.ttsRemoved).toEqual(['tts-1'])
    expect(calls.imUnregistered).toEqual(['plat-1'])
  })

  it('单个 channel 的 createAdapter 抛错不影响其他 channel，且计入失败段', async () => {
    const registry = makeRegistry(makePlugin('p1', {
      channels: [
        { channelId: 'ch-bad', platform: 'plat-bad', failCreate: true },
        { channelId: 'ch-good', platform: 'plat-good' }
      ]
    }))
    const { deps, calls } = makeSyncDeps()
    const sync = new PluginRuntimeSync(deps)

    const failures = await sync.sync(registry)

    expect(failures).toEqual(['im-adapters'])
    expect(calls.imRegistered).toEqual(['plat-good'])

    // 禁用后只撤销真正注册过的 adapter
    registry.disablePlugin('p1')
    await sync.sync(registry)
    expect(calls.imUnregistered).toEqual(['plat-good'])
  })

  it('段落独立容错：providers setter 抛错不影响 route/tts 段，失败段返回给调用方', async () => {
    const registry = makeRegistry(makePlugin('p1', {
      providerId: 'prov-1',
      ttsIds: ['tts-1'],
      route: '/api/plugins/p1/x'
    }))
    const { deps, calls } = makeSyncDeps()
    deps.setPluginProviders = () => { throw new Error('ai boom') }
    const sync = new PluginRuntimeSync(deps)

    const failures = await sync.sync(registry)

    expect(failures).toEqual(['providers'])
    // 其他段照常执行
    expect(calls.setRoutes).toEqual([['GET /api/plugins/p1/x']])
    expect(calls.ttsRegistered).toEqual(['tts-1'])
  })

  it('同一 IM platform 冲突：后来者被拒并自动重试，platform 释放后自动接管', async () => {
    const registry = makeRegistry(
      makePlugin('p1', { channels: [{ channelId: 'ch-a', platform: 'shared-plat' }] }),
      makePlugin('p2', { channels: [{ channelId: 'ch-b', platform: 'shared-plat' }] })
    )
    const { deps, calls } = makeSyncDeps()
    const sync = new PluginRuntimeSync(deps)

    // 首次同步：先注册者保留，后来者拒绝（冲突属既定争用状态，不计入失败段）
    const failures1 = await sync.sync(registry)
    expect(failures1).toEqual([])
    expect(calls.imRegistered).toEqual(['shared-plat'])
    expect(calls.imRejected).toEqual(['shared-plat'])

    // 冲突未解除时的后续同步：被拒 channel 自动重试（仍被拒，不停留在静默 inactive）
    const failures2 = await sync.sync(registry)
    expect(failures2).toEqual([])
    expect(calls.imRejected).toEqual(['shared-plat', 'shared-plat'])
    expect(calls.imRegistered).toEqual(['shared-plat'])

    // p1 释放 platform：仍在启用的 p2 自动接管，消除「启用但未运行」
    registry.disablePlugin('p1')
    const failures3 = await sync.sync(registry)
    expect(failures3).toEqual([])
    expect(calls.imUnregistered).toEqual(['shared-plat'])
    expect(calls.imRegistered).toEqual(['shared-plat', 'shared-plat'])

    // p2 也禁用后 platform 完全释放
    registry.disablePlugin('p2')
    await sync.sync(registry)
    expect(calls.imUnregistered).toEqual(['shared-plat', 'shared-plat'])
  })

  it('禁用路径上 adapter stop 挂起按预算放行：sync 不被卡死、串行链可继续', async () => {
    vi.useFakeTimers()
    try {
      const registry = makeRegistry(makePlugin('p1', {
        channels: [{ channelId: 'ch-1', platform: 'plat-1' }],
        providerId: 'prov-1'
      }))
      const { deps, calls } = makeSyncDeps()
      // 模拟插件 stop() 永不返回
      deps.unregisterImAdapter = () => new Promise<void>(() => {})
      const sync = new PluginRuntimeSync(deps)

      await sync.sync(registry)
      registry.disablePlugin('p1')

      const done = sync.sync(registry)
      await vi.advanceTimersByTimeAsync(3000)
      const failures = await done

      // 预算放行后 sync 完成：provider 空快照已下发；
      // stop 类清理失败（逻辑撤销已完成）不计入失败段
      expect(failures).toEqual([])
      expect(calls.setProviders[1]).toEqual([])

      // 串行链未被卡死：后续 sync 可继续排队执行
      const followUp = sync.sync(registry)
      await followUp
      expect(calls.setProviders).toHaveLength(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('dispose 停止全部已装配的 IM adapter（退出收尾）', async () => {
    const registry = makeRegistry(
      makePlugin('p1', { channels: [{ channelId: 'ch-1', platform: 'plat-1' }] }),
      makePlugin('p2', { channels: [{ channelId: 'ch-2', platform: 'plat-2' }] })
    )
    const { deps, calls } = makeSyncDeps()
    const sync = new PluginRuntimeSync(deps)

    await sync.sync(registry)
    await sync.dispose()

    expect(calls.imUnregistered.sort()).toEqual(['plat-1', 'plat-2'])
  })
})

// ==================== uninstall 目标解析契约 ====================

describe('resolveInstalledPluginDir 契约', () => {
  beforeEach(() => {
    mockExistsSync.mockReset()
    mockReadFileSync.mockReset()
  })

  it('按包名精确定位插件目录，拒绝路径穿越', async () => {
    mockExistsSync.mockImplementation((p: unknown) => String(p).includes('openclaw.plugin.json'))
    const { resolveInstalledPluginDir } = await import('../installer')
    const path = require('path')

    expect(resolveInstalledPluginDir('my-plugin', '/userData')).toBe(
      path.join('/userData', 'plugins', 'node_modules', 'my-plugin')
    )
    expect(resolveInstalledPluginDir('@scope/my-plugin', '/userData')).toBe(
      path.join('/userData', 'plugins', 'node_modules', '@scope', 'my-plugin')
    )
    // 穿越与非法输入：正斜杠、反斜杠（win32 下 path.join 会归一化）都不允许逃出 node_modules
    expect(resolveInstalledPluginDir('../escape', '/userData')).toBeNull()
    expect(resolveInstalledPluginDir('..\\my-plugin', '/userData')).toBeNull()
    expect(resolveInstalledPluginDir('good/../../escape', '/userData')).toBeNull()
    expect(resolveInstalledPluginDir('..\\..\\evil', '/userData')).toBeNull()
    expect(resolveInstalledPluginDir('', '/userData')).toBeNull()
  })

  it('无 manifest 的目录返回 null', async () => {
    mockExistsSync.mockReturnValue(false)
    const { resolveInstalledPluginDir } = await import('../installer')
    expect(resolveInstalledPluginDir('not-a-plugin', '/userData')).toBeNull()
  })
})

describe('readPackageNameFromDir / isNpmInstalledPluginDir 契约', () => {
  beforeEach(() => {
    mockExistsSync.mockReset()
    mockReadFileSync.mockReset()
  })

  it('readPackageNameFromDir 返回 package.json 的 name，缺失/非法/无 name 返回 null', async () => {
    const { readPackageNameFromDir } = await import('../installer')

    mockExistsSync.mockImplementation((p: unknown) => String(p).includes('package.json'))
    mockReadFileSync.mockImplementation(() => JSON.stringify({ name: '@scope/my-plugin', version: '1.0.0' }))
    expect(readPackageNameFromDir('/dir')).toBe('@scope/my-plugin')

    // 无 name 字段
    mockReadFileSync.mockImplementation(() => JSON.stringify({ version: '1.0.0' }))
    expect(readPackageNameFromDir('/dir')).toBeNull()

    // 非法 JSON
    mockReadFileSync.mockImplementation(() => '{invalid json')
    expect(readPackageNameFromDir('/dir')).toBeNull()

    // 无 package.json
    mockExistsSync.mockReturnValue(false)
    expect(readPackageNameFromDir('/dir')).toBeNull()
  })

  it('isNpmInstalledPluginDir 区分 npm 安装区与手动目录', async () => {
    const { isNpmInstalledPluginDir } = await import('../installer')
    const path = require('path')
    const nm = path.join('/userData', 'plugins', 'node_modules')

    expect(isNpmInstalledPluginDir(path.join(nm, 'my-plugin'), '/userData')).toBe(true)
    expect(isNpmInstalledPluginDir(path.join(nm, '@scope', 'my-plugin'), '/userData')).toBe(true)
    // 手动放置在 plugins/ 根目录
    expect(isNpmInstalledPluginDir(path.join('/userData', 'plugins', 'my-plugin'), '/userData')).toBe(false)
    // 完全无关路径 / node_modules 本身
    expect(isNpmInstalledPluginDir('/other/place', '/userData')).toBe(false)
    expect(isNpmInstalledPluginDir(nm, '/userData')).toBe(false)
  })

  it('packageNameMatchesDir 回环校验包名与目录一致性', async () => {
    mockExistsSync.mockImplementation((p: unknown) => String(p).includes('openclaw.plugin.json'))
    const { packageNameMatchesDir } = await import('../installer')
    const path = require('path')
    const nm = path.join('/userData', 'plugins', 'node_modules')

    // 包名回环解析到同一目录
    expect(packageNameMatchesDir('@scope/my-plugin', path.join(nm, '@scope', 'my-plugin'), '/userData')).toBe(true)
    // win32 大小写不敏感；POSIX 严格
    const caseDir = path.join(nm, '@scope', 'My-Plugin')
    if (process.platform === 'win32') {
      expect(packageNameMatchesDir('@scope/my-plugin', caseDir, '/userData')).toBe(true)
    } else {
      expect(packageNameMatchesDir('@scope/my-plugin', caseDir, '/userData')).toBe(false)
    }
    // 解析到其他目录 / 解析失败（穿越被拒）
    expect(packageNameMatchesDir('other-package', path.join(nm, '@scope', 'my-plugin'), '/userData')).toBe(false)
    expect(packageNameMatchesDir('../evil', path.join(nm, 'my-plugin'), '/userData')).toBe(false)
  })
})
